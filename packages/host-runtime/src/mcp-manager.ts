import { randomUUID } from "node:crypto";
import path from "node:path";
import type { McpServerConfig, McpStdioServerConfig } from "@alcode/plugins";
import {
  McpClientRuntime,
  OwnedStdioClientTransport,
  projectMcpResult,
  type McpToolDescriptor,
} from "@alcode/mcp";
import type { CapabilityBroker, HostCapability } from "./capability-broker.ts";
import type { HostArtifactStore } from "./artifact-store.ts";
import type { ExternalProcessSupervisor, OwnedExternalProcess } from "./external-process.ts";
import type { HostPluginLifecycle, PluginRuntimeActivation } from "./plugin-service.ts";
import { createSafeFetch, type SafeFetchOptions } from "./safe-network.ts";

export type HostMcpRuntimeStatus = "starting" | "ready" | "degraded" | "failed" | "stopping";

export interface HostMcpDiagnostic {
  registrationId: string;
  serverName: string;
  status: HostMcpRuntimeStatus;
  message?: string;
  revision?: string;
  toolCount?: number;
}

export interface HostMcpManagerOptions {
  capabilityBroker: CapabilityBroker;
  processSupervisor: ExternalProcessSupervisor;
  artifactStore: HostArtifactStore;
  /** Revalidate exact-generation process-start trust before a stdio restart. */
  authorizeProcessStart?: (registrationId: string, digest: string) => Promise<PluginRuntimeActivation>;
  safeFetch?: SafeFetchOptions;
  maxConcurrentCalls?: number;
  maxConcurrentCallsPerServer?: number;
  maxStdioRestartAttempts?: number;
  restartInitialDelayMs?: number;
  restartMaxDelayMs?: number;
  onDiagnostic?: (diagnostic: HostMcpDiagnostic) => void;
}

interface ServerState {
  activation: PluginRuntimeActivation;
  serverName: string;
  config: McpServerConfig;
  providerId: string;
  runtime: McpClientRuntime | undefined;
  disposeCapabilities: (() => void) | undefined;
  revision?: string;
  retiring: boolean;
  restartAttempts: number;
  restartScheduled: boolean;
  activeCalls: number;
}

function expandPluginVariables(value: string, pluginRoot: string, pluginData: string): string {
  return value.replace(/\$\{PLUGIN_ROOT\}|\$\{PLUGIN_DATA\}/g, (token) => token === "${PLUGIN_ROOT}" ? pluginRoot : pluginData);
}

function ensureContained(root: string, candidate: string, label: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolved;
  throw new Error(`${label} escapes its managed root`);
}

function resolveStdioSpec(config: McpStdioServerConfig, activation: PluginRuntimeActivation): {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
} {
  const pluginRoot = path.resolve(activation.pluginRoot);
  const pluginData = path.resolve(activation.pluginData);
  const command = config.command.startsWith("./")
    ? ensureContained(pluginRoot, path.join(pluginRoot, config.command.slice(2)), "MCP command")
    : config.command;
  const args = (config.args ?? []).map((value) => expandPluginVariables(value, pluginRoot, pluginData));
  const env = Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => [key, expandPluginVariables(value, pluginRoot, pluginData)]));

  let cwd = pluginRoot;
  if (config.cwd !== undefined) {
    if (config.cwd.startsWith("./")) {
      cwd = ensureContained(pluginRoot, path.join(pluginRoot, config.cwd.slice(2)), "MCP cwd");
    } else if (config.cwd === "${PLUGIN_ROOT}" || config.cwd.startsWith("${PLUGIN_ROOT}/")) {
      cwd = ensureContained(pluginRoot, expandPluginVariables(config.cwd, pluginRoot, pluginData), "MCP cwd");
    } else if (config.cwd === "${PLUGIN_DATA}" || config.cwd.startsWith("${PLUGIN_DATA}/")) {
      cwd = ensureContained(pluginData, expandPluginVariables(config.cwd, pluginRoot, pluginData), "MCP cwd");
    } else {
      throw new Error("MCP cwd is not in a supported Agent Plugins form");
    }
  }
  return { command, args, cwd, env };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HostMcpManager implements HostPluginLifecycle {
  private readonly registrations = new Map<string, Map<string, ServerState>>();
  private readonly maxConcurrentCalls: number;
  private readonly maxConcurrentCallsPerServer: number;
  private readonly maxStdioRestartAttempts: number;
  private readonly restartInitialDelayMs: number;
  private readonly restartMaxDelayMs: number;
  private globalActiveCalls = 0;

  constructor(private readonly options: HostMcpManagerOptions) {
    this.maxConcurrentCalls = options.maxConcurrentCalls ?? 32;
    this.maxConcurrentCallsPerServer = options.maxConcurrentCallsPerServer ?? 8;
    this.maxStdioRestartAttempts = options.maxStdioRestartAttempts ?? 10;
    this.restartInitialDelayMs = options.restartInitialDelayMs ?? 500;
    this.restartMaxDelayMs = options.restartMaxDelayMs ?? 30_000;
    for (const [name, value] of Object.entries({
      maxConcurrentCalls: this.maxConcurrentCalls,
      maxConcurrentCallsPerServer: this.maxConcurrentCallsPerServer,
      maxStdioRestartAttempts: this.maxStdioRestartAttempts,
    })) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    }
  }

  async activate(activation: PluginRuntimeActivation): Promise<void> {
    await this.withdraw(activation.registrationId, activation.digest, "replaced");
    const states = new Map<string, ServerState>();
    this.registrations.set(activation.registrationId, states);
    for (const [serverName, config] of Object.entries(activation.inspection.mcpServers)) {
      const state: ServerState = {
        activation: structuredClone(activation),
        serverName,
        config: structuredClone(config),
        providerId: `mcp:${activation.registrationId}:${serverName}`,
        runtime: undefined,
        disposeCapabilities: undefined,
        retiring: false,
        restartAttempts: 0,
        restartScheduled: false,
        activeCalls: 0,
      };
      states.set(serverName, state);
      this.emit(state, "starting");
      try {
        await this.startState(state, activation);
      } catch (error) {
        this.emit(state, "failed", error instanceof Error ? error.message : String(error));
        // Agent Plugins failure isolation: one server failure does not invalidate siblings.
      }
    }
  }

  async withdraw(registrationId: string, _digest: string, _reason: "changed" | "disabled" | "unregistered" | "replaced" | "invalid"): Promise<void> {
    const states = this.registrations.get(registrationId);
    if (!states) return;
    this.registrations.delete(registrationId);
    await Promise.all([...states.values()].map(async (state) => {
      state.retiring = true;
      this.emit(state, "stopping");
      state.disposeCapabilities?.();
      state.disposeCapabilities = undefined;
      const runtime = state.runtime;
      state.runtime = undefined;
      if (runtime) await runtime.close().catch(() => undefined);
    }));
  }

  diagnostics(): HostMcpDiagnostic[] {
    const result: HostMcpDiagnostic[] = [];
    for (const states of this.registrations.values()) {
      for (const state of states.values()) {
        result.push({
          registrationId: state.activation.registrationId,
          serverName: state.serverName,
          status: state.runtime ? "ready" : "failed",
          ...(state.revision !== undefined ? { revision: state.revision } : {}),
        });
      }
    }
    return result.sort((a, b) => `${a.registrationId}:${a.serverName}`.localeCompare(`${b.registrationId}:${b.serverName}`, "en"));
  }

  private async startState(state: ServerState, activation: PluginRuntimeActivation): Promise<void> {
    const runtime = state.config.type === "stdio"
      ? this.createStdioRuntime(state, activation)
      : McpClientRuntime.forStreamableHttp({
          provenance: { pluginName: activation.name, serverName: state.serverName },
          url: new URL(state.config.url),
          fetch: createSafeFetch({
            ...this.options.safeFetch,
            sensitiveHeaderNames: [
              ...(this.options.safeFetch?.sensitiveHeaderNames ?? []),
              ...Object.keys(state.config.headers ?? {}),
            ],
          }),
          ...(state.config.headers !== undefined ? { headers: state.config.headers } : {}),
          onCatalogChanged: (tools) => this.replaceCapabilities(state, tools),
        });
    state.runtime = runtime;
    const tools = await runtime.connect();
    if (state.retiring || state.runtime !== runtime) {
      await runtime.close().catch(() => undefined);
      return;
    }
    this.replaceCapabilities(state, tools);
    state.restartAttempts = 0;
    this.emit(state, "ready", undefined, tools.length);
  }

  private createStdioRuntime(state: ServerState, activation: PluginRuntimeActivation): McpClientRuntime {
    const spec = resolveStdioSpec(state.config as McpStdioServerConfig, activation);
    const transport = new OwnedStdioClientTransport(() => {
      const owned = this.options.processSupervisor.start({
        command: spec.command,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env,
        reservedEnv: { PLUGIN_ROOT: activation.pluginRoot, PLUGIN_DATA: activation.pluginData },
      });
      // stderr is diagnostic-only for stdio MCP and must not backpressure the server.
      owned.child.stderr.resume();
      this.observeUnexpectedStdioExit(state, owned);
      return {
        pid: owned.pid,
        stdin: owned.child.stdin,
        stdout: owned.child.stdout,
        waitForExit: () => owned.waitForExit(),
        stop: (graceMs) => owned.stop(graceMs),
      };
    });
    return McpClientRuntime.forTransport(transport, {
      provenance: { pluginName: activation.name, serverName: state.serverName },
      onCatalogChanged: (tools) => this.replaceCapabilities(state, tools),
    });
  }

  private replaceCapabilities(state: ServerState, tools: readonly McpToolDescriptor[]): void {
    if (state.retiring) return;
    const runtime = state.runtime;
    if (!runtime) return;
    const revision = randomUUID();
    const capabilities = tools.map((tool): HostCapability => ({
      name: tool.modelName,
      description: tool.description,
      inputSchema: {
        type: "object",
        properties: typeof tool.inputSchema.properties === "object" && tool.inputSchema.properties !== null && !Array.isArray(tool.inputSchema.properties)
          ? structuredClone(tool.inputSchema.properties as Record<string, unknown>)
          : {},
        ...(Array.isArray(tool.inputSchema.required) && tool.inputSchema.required.every((value) => typeof value === "string")
          ? { required: [...tool.inputSchema.required] as string[] }
          : {}),
      },
      isReadOnly: false,
      execute: async (args, context) => {
        if (state.retiring || state.runtime !== runtime) throw new Error("MCP provider generation is no longer current");
        if (state.activeCalls >= this.maxConcurrentCallsPerServer || this.globalActiveCalls >= this.maxConcurrentCalls) {
          throw new Error("MCP call concurrency limit reached");
        }
        state.activeCalls += 1;
        this.globalActiveCalls += 1;
        try {
          const result = await runtime.callTool(tool.modelName, args as Record<string, unknown>, context.signal);
          const projected = await projectMcpResult(result, {
            retain: async (serialized) => this.options.artifactStore.retain(serialized, { mediaType: "application/json" }),
          });
          return {
            result: projected,
            outcome: result.isError ? "failed" : "succeeded",
            stdout: JSON.stringify(projected),
          };
        } finally {
          state.activeCalls -= 1;
          this.globalActiveCalls -= 1;
        }
      },
    }));
    const dispose = this.options.capabilityBroker.registerDynamicProvider(state.providerId, revision, capabilities);
    state.disposeCapabilities = dispose;
    state.revision = revision;
    this.emit(state, "ready", undefined, tools.length);
  }

  private observeUnexpectedStdioExit(state: ServerState, process: OwnedExternalProcess): void {
    void process.waitForExit().then(() => {
      if (state.retiring || state.restartScheduled) return;
      state.disposeCapabilities?.();
      state.disposeCapabilities = undefined;
      state.runtime = undefined;
      this.emit(state, "degraded", "MCP stdio process exited; bounded restart scheduled");
      this.scheduleStdioRestart(state);
    }, (error) => {
      if (state.retiring) return;
      this.emit(state, "degraded", error instanceof Error ? error.message : String(error));
      this.scheduleStdioRestart(state);
    });
  }

  private scheduleStdioRestart(state: ServerState): void {
    if (state.retiring || state.restartScheduled || state.config.type !== "stdio") return;
    state.restartScheduled = true;
    void (async () => {
      while (!state.retiring && state.restartAttempts < this.maxStdioRestartAttempts) {
        const delay = Math.min(this.restartMaxDelayMs, this.restartInitialDelayMs * (2 ** state.restartAttempts));
        state.restartAttempts += 1;
        await sleep(delay);
        if (state.retiring) break;
        try {
          const trusted = this.options.authorizeProcessStart
            ? await this.options.authorizeProcessStart(state.activation.registrationId, state.activation.digest)
            : state.activation;
          state.activation = structuredClone(trusted);
          await this.startState(state, trusted);
          state.restartScheduled = false;
          return;
        } catch (error) {
          this.emit(state, "degraded", `MCP restart ${state.restartAttempts}/${this.maxStdioRestartAttempts} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      state.restartScheduled = false;
      if (!state.retiring) this.emit(state, "failed", "MCP stdio restart budget exhausted; capabilities withdrawn");
    })();
  }

  private emit(state: ServerState, status: HostMcpRuntimeStatus, message?: string, toolCount?: number): void {
    this.options.onDiagnostic?.({
      registrationId: state.activation.registrationId,
      serverName: state.serverName,
      status,
      ...(message !== undefined ? { message } : {}),
      ...(state.revision !== undefined ? { revision: state.revision } : {}),
      ...(toolCount !== undefined ? { toolCount } : {}),
    });
  }
}
