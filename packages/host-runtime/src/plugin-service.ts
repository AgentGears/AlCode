import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  buildPackageTreeManifest,
  inspectPluginPackage,
  stagePluginGeneration,
  type PluginDiagnostic,
  type PluginInspection,
  type PluginScope,
  type StagedPluginGeneration,
} from "@alcode/plugins";

export type HostPluginStatus = "registered" | "enabled" | "changed" | "disabled" | "invalid";

export interface HostPluginRegistration {
  registrationId: string;
  dataOwnerId: string;
  name: string;
  sourceRoot: string;
  scope: PluginScope;
  workspaceId?: string;
  sourceDigest: string;
  activeDigest?: string;
  status: HostPluginStatus;
  diagnostics: PluginDiagnostic[];
  components: {
    skills: string[];
    mcpServers: string[];
    hooks: string[];
  };
}

export interface PluginRuntimeActivation {
  registrationId: string;
  dataOwnerId: string;
  name: string;
  digest: string;
  pluginRoot: string;
  pluginData: string;
  inspection: PluginInspection;
}

export interface HostPluginLifecycle {
  activate(activation: PluginRuntimeActivation): Promise<void>;
  withdraw(registrationId: string, digest: string, reason: "changed" | "disabled" | "unregistered" | "replaced" | "invalid"): Promise<void>;
}

export interface HostPluginServiceOptions {
  alcodeHome?: string;
  lifecycle?: HostPluginLifecycle;
}

interface PersistedRegistry {
  version: 1;
  registrations: HostPluginRegistration[];
}

const NOOP_LIFECYCLE: HostPluginLifecycle = {
  async activate() {},
  async withdraw() {},
};

function cloneRegistration(registration: HostPluginRegistration): HostPluginRegistration {
  return structuredClone(registration);
}

function componentsOf(inspection: PluginInspection): HostPluginRegistration["components"] {
  return {
    skills: inspection.skills.map((skill) => skill.name).sort(),
    mcpServers: Object.keys(inspection.mcpServers).sort(),
    hooks: inspection.hooks.map((hook) => hook.id).sort(),
  };
}

function defaultAlcodeHome(): string {
  return process.env.ALCODE_HOME ? path.resolve(process.env.ALCODE_HOME) : path.join(homedir(), ".alcode");
}

export class HostPluginService {
  private readonly alcodeHome: string;
  private readonly pluginHome: string;
  private readonly registryPath: string;
  private readonly generationRoot: string;
  private readonly dataRoot: string;
  private readonly lifecycle: HostPluginLifecycle;
  private readonly registrations = new Map<string, HostPluginRegistration>();
  private mutationChain: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(options: HostPluginServiceOptions = {}) {
    this.alcodeHome = path.resolve(options.alcodeHome ?? defaultAlcodeHome());
    this.pluginHome = path.join(this.alcodeHome, "plugins");
    this.registryPath = path.join(this.pluginHome, "registry.json");
    this.generationRoot = path.join(this.pluginHome, "generations");
    this.dataRoot = path.join(this.pluginHome, "data");
    this.lifecycle = options.lifecycle ?? NOOP_LIFECYCLE;
  }

  async initialize(): Promise<void> {
    await mkdir(this.generationRoot, { recursive: true });
    await mkdir(this.dataRoot, { recursive: true });
    let persisted: PersistedRegistry | undefined;
    try {
      persisted = JSON.parse(await readFile(this.registryPath, "utf8")) as PersistedRegistry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (persisted !== undefined) {
      if (persisted.version !== 1 || !Array.isArray(persisted.registrations)) throw new Error("unsupported Host plugin registry format");
      this.registrations.clear();
      for (const registration of persisted.registrations) {
        if (this.registrations.has(registration.registrationId)) throw new Error(`duplicate plugin registration id: ${registration.registrationId}`);
        this.registrations.set(registration.registrationId, registration);
      }
    }
    this.initialized = true;
  }

  list(): HostPluginRegistration[] {
    this.assertInitialized();
    return [...this.registrations.values()].map(cloneRegistration).sort((a, b) => a.name.localeCompare(b.name, "en"));
  }

  get(registrationId: string): HostPluginRegistration | undefined {
    this.assertInitialized();
    const registration = this.registrations.get(registrationId);
    return registration ? cloneRegistration(registration) : undefined;
  }

  effectiveRegistry(workspaceId?: string): HostPluginRegistration[] {
    this.assertInitialized();
    const selected = [...this.registrations.values()].filter((registration) =>
      registration.scope === "user" || (registration.scope === "workspace" && registration.workspaceId === workspaceId));
    const byName = new Map<string, HostPluginRegistration>();
    for (const registration of selected) {
      const previous = byName.get(registration.name);
      if (previous) throw new Error(`duplicate effective plugin name: ${registration.name} (${previous.registrationId}, ${registration.registrationId})`);
      byName.set(registration.name, registration);
    }
    return [...byName.values()].map(cloneRegistration).sort((a, b) => a.name.localeCompare(b.name, "en"));
  }

  registerLocal(input: { sourceRoot: string; scope: PluginScope; workspaceId?: string }): Promise<HostPluginRegistration> {
    return this.mutate(async () => {
      if (input.scope === "workspace" && !input.workspaceId) throw new Error("workspace plugin registration requires workspaceId");
      if (input.scope === "user" && input.workspaceId !== undefined) throw new Error("user plugin registration must not carry workspaceId");
      const sourceRoot = path.resolve(input.sourceRoot);
      const manifest = await buildPackageTreeManifest(sourceRoot);
      const inspection = await inspectPluginPackage(sourceRoot);
      if (inspection.status !== "valid" || !inspection.manifest) throw new Error(`plugin package is invalid: ${inspection.diagnostics.map((item) => item.message).join("; ")}`);
      const registration: HostPluginRegistration = {
        registrationId: randomUUID(),
        dataOwnerId: randomUUID(),
        name: inspection.manifest.name,
        sourceRoot,
        scope: input.scope,
        ...(input.scope === "workspace" ? { workspaceId: input.workspaceId! } : {}),
        sourceDigest: manifest.digest,
        status: "registered",
        diagnostics: structuredClone(inspection.diagnostics),
        components: componentsOf(inspection),
      };
      this.registrations.set(registration.registrationId, registration);
      try {
        // Reject collisions in the execution world affected by this registration.
        if (registration.scope === "workspace") this.effectiveRegistry(registration.workspaceId);
        else {
          const workspaceIds = new Set([...this.registrations.values()].filter((item) => item.scope === "workspace" && item.workspaceId).map((item) => item.workspaceId!));
          if (workspaceIds.size === 0) this.effectiveRegistry();
          for (const workspaceId of workspaceIds) this.effectiveRegistry(workspaceId);
        }
      } catch (error) {
        this.registrations.delete(registration.registrationId);
        throw error;
      }
      await this.persist();
      return cloneRegistration(registration);
    });
  }

  enable(registrationId: string): Promise<HostPluginRegistration> {
    return this.mutate(async () => {
      const registration = this.requireRegistration(registrationId);
      const staged = await stagePluginGeneration(registration.sourceRoot, { installBase: this.generationRoot });
      await mkdir(this.pluginDataPath(registration.dataOwnerId), { recursive: true });
      if (registration.activeDigest !== undefined && registration.activeDigest !== staged.digest) {
        await this.lifecycle.withdraw(registration.registrationId, registration.activeDigest, "replaced");
        delete registration.activeDigest;
      }
      const activation = this.activationOf(registration, staged);
      try {
        await this.lifecycle.activate(activation);
      } catch (error) {
        registration.sourceDigest = staged.digest;
        registration.status = "disabled";
        registration.diagnostics = [{ code: "runtime.activation_failed", severity: "error", message: error instanceof Error ? error.message : String(error) }];
        delete registration.activeDigest;
        await this.persist();
        throw error;
      }
      registration.sourceDigest = staged.digest;
      registration.activeDigest = staged.digest;
      registration.status = "enabled";
      registration.diagnostics = structuredClone(staged.inspection.diagnostics);
      registration.components = componentsOf(staged.inspection);
      await this.persist();
      return cloneRegistration(registration);
    });
  }

  refresh(registrationId: string): Promise<HostPluginRegistration> {
    return this.mutate(async () => {
      const registration = this.requireRegistration(registrationId);
      let manifest;
      let inspection;
      try {
        manifest = await buildPackageTreeManifest(registration.sourceRoot);
        inspection = await inspectPluginPackage(registration.sourceRoot);
      } catch (error) {
        await this.withdrawIfActive(registration, "invalid");
        registration.status = "invalid";
        registration.diagnostics = [{ code: "package.refresh_failed", severity: "error", message: error instanceof Error ? error.message : String(error) }];
        await this.persist();
        return cloneRegistration(registration);
      }
      registration.sourceDigest = manifest.digest;
      registration.diagnostics = structuredClone(inspection.diagnostics);
      registration.components = componentsOf(inspection);
      if (inspection.status !== "valid") {
        await this.withdrawIfActive(registration, "invalid");
        registration.status = "invalid";
      } else if (registration.activeDigest !== undefined && registration.activeDigest !== manifest.digest) {
        await this.withdrawIfActive(registration, "changed");
        registration.status = "changed";
      } else if (registration.activeDigest !== undefined) {
        registration.status = "enabled";
      } else if (registration.status !== "disabled") {
        registration.status = "registered";
      }
      await this.persist();
      return cloneRegistration(registration);
    });
  }

  disable(registrationId: string): Promise<HostPluginRegistration> {
    return this.mutate(async () => {
      const registration = this.requireRegistration(registrationId);
      await this.withdrawIfActive(registration, "disabled");
      registration.status = "disabled";
      await this.persist();
      return cloneRegistration(registration);
    });
  }

  unregister(registrationId: string): Promise<void> {
    return this.mutate(async () => {
      const registration = this.requireRegistration(registrationId);
      await this.withdrawIfActive(registration, "unregistered");
      this.registrations.delete(registrationId);
      await this.persist();
      // PLUGIN_DATA is intentionally retained.
    });
  }

  /**
   * Revalidates exact-generation process-start trust immediately before an
   * adapter starts/restarts an external process. Mutable source watcher timing
   * is not a security boundary.
   */
  authorizeProcessStart(registrationId: string, expectedDigest: string): Promise<PluginRuntimeActivation> {
    return this.mutate(async () => {
      const registration = this.requireRegistration(registrationId);
      if (registration.status !== "enabled" || registration.activeDigest !== expectedDigest) {
        throw new Error("plugin generation is not enabled for process start");
      }
      const source = await buildPackageTreeManifest(registration.sourceRoot);
      if (source.digest !== expectedDigest) {
        registration.sourceDigest = source.digest;
        await this.withdrawIfActive(registration, "changed");
        registration.status = "changed";
        await this.persist();
        throw new Error("plugin source changed; generation trust withdrawn and explicit re-enable required");
      }
      const generationRoot = path.join(this.generationRoot, expectedDigest);
      const installed = await buildPackageTreeManifest(generationRoot);
      if (installed.digest !== expectedDigest) throw new Error("installed plugin generation digest mismatch");
      const inspection = await inspectPluginPackage(generationRoot);
      if (inspection.status !== "valid" || !inspection.manifest || inspection.manifest.name !== registration.name) {
        throw new Error("installed plugin generation is invalid or does not match registration identity");
      }
      return {
        registrationId: registration.registrationId,
        dataOwnerId: registration.dataOwnerId,
        name: registration.name,
        digest: expectedDigest,
        pluginRoot: generationRoot,
        pluginData: this.pluginDataPath(registration.dataOwnerId),
        inspection,
      };
    });
  }

  /** Reconciles persisted enablement before any adapter restarts after Host startup. */
  startup(): Promise<void> {
    return this.mutate(async () => {
      for (const registration of this.registrations.values()) {
        if (registration.status !== "enabled" || registration.activeDigest === undefined) continue;
        const expectedDigest = registration.activeDigest;
        try {
          const source = await buildPackageTreeManifest(registration.sourceRoot);
          if (source.digest !== expectedDigest) {
            registration.sourceDigest = source.digest;
            delete registration.activeDigest;
            registration.status = "changed";
            continue;
          }
          const generationRoot = path.join(this.generationRoot, expectedDigest);
          const installed = await buildPackageTreeManifest(generationRoot);
          if (installed.digest !== expectedDigest) throw new Error("installed generation mismatch");
          const inspection = await inspectPluginPackage(generationRoot);
          if (inspection.status !== "valid") throw new Error("installed generation invalid");
          await mkdir(this.pluginDataPath(registration.dataOwnerId), { recursive: true });
          await this.lifecycle.activate({
            registrationId: registration.registrationId,
            dataOwnerId: registration.dataOwnerId,
            name: registration.name,
            digest: expectedDigest,
            pluginRoot: generationRoot,
            pluginData: this.pluginDataPath(registration.dataOwnerId),
            inspection,
          });
        } catch (error) {
          delete registration.activeDigest;
          registration.status = "invalid";
          registration.diagnostics = [{ code: "startup.reconcile_failed", severity: "error", message: error instanceof Error ? error.message : String(error) }];
        }
      }
      await this.persist();
    });
  }

  private activationOf(registration: HostPluginRegistration, staged: StagedPluginGeneration): PluginRuntimeActivation {
    return {
      registrationId: registration.registrationId,
      dataOwnerId: registration.dataOwnerId,
      name: registration.name,
      digest: staged.digest,
      pluginRoot: staged.root,
      pluginData: this.pluginDataPath(registration.dataOwnerId),
      inspection: structuredClone(staged.inspection),
    };
  }

  private pluginDataPath(dataOwnerId: string): string {
    return path.join(this.dataRoot, dataOwnerId);
  }

  private requireRegistration(registrationId: string): HostPluginRegistration {
    const registration = this.registrations.get(registrationId);
    if (!registration) throw new Error(`unknown plugin registration: ${registrationId}`);
    return registration;
  }

  private async withdrawIfActive(registration: HostPluginRegistration, reason: Parameters<HostPluginLifecycle["withdraw"]>[2]): Promise<void> {
    if (registration.activeDigest === undefined) return;
    const digest = registration.activeDigest;
    // Withdraw new admission before clearing the trusted binding/persisting state.
    await this.lifecycle.withdraw(registration.registrationId, digest, reason);
    delete registration.activeDigest;
  }

  private async persist(): Promise<void> {
    await mkdir(this.pluginHome, { recursive: true });
    const payload: PersistedRegistry = {
      version: 1,
      registrations: [...this.registrations.values()].map(cloneRegistration).sort((a, b) => a.registrationId.localeCompare(b.registrationId, "en")),
    };
    const temporary = `${this.registryPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.registryPath);
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("HostPluginService.initialize() must complete before use");
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    this.assertInitialized();
    const result = this.mutationChain.then(operation, operation);
    this.mutationChain = result.then(() => undefined, () => undefined);
    return result;
  }
}
