import { createHash } from "node:crypto";
import type {
  ProgramPlanningCatalogV1,
  ProgramPlanningReadDescriptorV1,
} from "@alcode/agent-protocol";
import {
  canonicalStringify,
  type Json,
} from "@alcode/program-state";

export const TRACKED_PLANNING_PROFILE_ID = "tracked-read-v1" as const;
export const TRACKED_PLANNING_PROFILE_VERSION = 1 as const;

export const PLANNING_PROVENANCE_LIMITS = Object.freeze({
  dependencies: 1_024,
  serializedIdentityBytes: 1024 * 1024,
});

export const PLANNING_CATALOG_LIMITS = Object.freeze({
  reads: 64,
  serializedBytes: 64 * 1024,
});

export interface PlanningReadDependencyV1 {
  readContractId: string;
  readContractVersion: number;
  canonicalArgs: Json;
  canonicalArgsDigest: string;
  canonicalResultDigest: string;
  coverageIdentity: string;
  providerBindingRevision?: string;
}

export interface PlanningObservationIdentityV1 {
  profileId: typeof TRACKED_PLANNING_PROFILE_ID;
  profileVersion: typeof TRACKED_PLANNING_PROFILE_VERSION;
  workspaceIdentity: string;
  planningCoverageProfileId: string;
  planningCoverageProfileVersion: number;
  /** P-01 planning episodes seal the exact model-facing planning catalog. */
  planningCatalogDigest?: string;
  dependencies: PlanningReadDependencyV1[];
  digest: string;
}

export interface PlanningReadObservationV1 {
  result: Json;
  complete: boolean;
  coverageIdentity: string;
  providerBindingRevision?: string;
}

export interface PlanningReadContractV1 {
  readContractId: string;
  readContractVersion: number;
  maxCanonicalArgsBytes: number;
  maxCanonicalResultBytes: number;
  normalizeArgs(input: Json): Json;
  execute(canonicalArgs: Json): Promise<PlanningReadObservationV1>;
}

export interface PlanningReadDeliveryV1 {
  result: Json;
  dependency: PlanningReadDependencyV1;
}

export class PlanningReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanningReadError";
  }
}

export class PlanningBaseStaleError extends PlanningReadError {
  constructor(message: string) {
    super(message);
    this.name = "PlanningBaseStaleError";
  }
}

const encoder = new TextEncoder();

export function planningCanonicalDigest(value: unknown): string {
  const canonical = canonicalStringify(value);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function canonicalBytes(value: unknown): number {
  return encoder.encode(canonicalStringify(value)).byteLength;
}

function requireNonEmpty(label: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new PlanningReadError(`${label} must be a non-empty string`);
  }
}

function requireVersion(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PlanningReadError(`${label} must be a positive safe integer`);
  }
}

function contractKey(readContractId: string, readContractVersion: number): string {
  return `${readContractId}\u0000${readContractVersion}`;
}

function dependencyKey(dependency: PlanningReadDependencyV1): string {
  return `${dependency.readContractId}\u0000${dependency.readContractVersion}\u0000${dependency.canonicalArgsDigest}`;
}

function identityBody(
  identity: Omit<PlanningObservationIdentityV1, "digest">,
): Omit<PlanningObservationIdentityV1, "digest"> {
  return identity;
}

function descriptorKey(descriptor: ProgramPlanningReadDescriptorV1): string {
  return `${descriptor.definition.name}\u0000${descriptor.readContractId}\u0000${descriptor.readContractVersion}`;
}

export class PlanningReadRegistry {
  private readonly contracts = new Map<string, PlanningReadContractV1>();
  private readonly issuedTrackers = new WeakSet<TrackedPlanningReads>();
  private readonly planningCatalog: ProgramPlanningCatalogV1;

  constructor(
    public readonly planningCoverageProfileId: string,
    public readonly planningCoverageProfileVersion: number,
    contracts: readonly PlanningReadContractV1[],
    planningCatalog: readonly ProgramPlanningReadDescriptorV1[] = [],
  ) {
    requireNonEmpty("planningCoverageProfileId", planningCoverageProfileId);
    requireVersion("planningCoverageProfileVersion", planningCoverageProfileVersion);
    for (const contract of contracts) this.register(contract);
    this.planningCatalog = this.buildPlanningCatalog(planningCatalog);
  }

  private register(contract: PlanningReadContractV1): void {
    requireNonEmpty("readContractId", contract.readContractId);
    requireVersion("readContractVersion", contract.readContractVersion);
    if (!Number.isSafeInteger(contract.maxCanonicalArgsBytes) || contract.maxCanonicalArgsBytes <= 0) {
      throw new PlanningReadError(`${contract.readContractId} maxCanonicalArgsBytes must be positive`);
    }
    if (!Number.isSafeInteger(contract.maxCanonicalResultBytes) || contract.maxCanonicalResultBytes <= 0) {
      throw new PlanningReadError(`${contract.readContractId} maxCanonicalResultBytes must be positive`);
    }
    const key = contractKey(contract.readContractId, contract.readContractVersion);
    if (this.contracts.has(key)) {
      throw new PlanningReadError(`Duplicate planning read contract ${contract.readContractId}@${contract.readContractVersion}`);
    }
    this.contracts.set(key, contract);
  }

  private buildPlanningCatalog(
    descriptors: readonly ProgramPlanningReadDescriptorV1[],
  ): ProgramPlanningCatalogV1 {
    if (descriptors.length > PLANNING_CATALOG_LIMITS.reads) {
      throw new PlanningReadError(`Planning catalog exceeds ${PLANNING_CATALOG_LIMITS.reads} reads`);
    }
    const names = new Set<string>();
    const bindings = new Set<string>();
    const reads = descriptors.map((source) => {
      const descriptor = structuredClone(source);
      requireNonEmpty("planningCatalog.definition.name", descriptor.definition.name);
      requireNonEmpty("planningCatalog.definition.description", descriptor.definition.description);
      requireNonEmpty("planningCatalog.readContractId", descriptor.readContractId);
      requireVersion("planningCatalog.readContractVersion", descriptor.readContractVersion);
      if (descriptor.definition.inputSchema.type !== "object"
          || typeof descriptor.definition.inputSchema.properties !== "object"
          || descriptor.definition.inputSchema.properties === null) {
        throw new PlanningReadError(`Invalid planning input schema for ${descriptor.definition.name}`);
      }
      this.get(descriptor.readContractId, descriptor.readContractVersion);
      if (names.has(descriptor.definition.name)) {
        throw new PlanningReadError(`Duplicate planning model read ${descriptor.definition.name}`);
      }
      const binding = contractKey(descriptor.readContractId, descriptor.readContractVersion);
      if (bindings.has(binding)) {
        throw new PlanningReadError(`Duplicate planning read binding ${descriptor.readContractId}@${descriptor.readContractVersion}`);
      }
      names.add(descriptor.definition.name);
      bindings.add(binding);
      return descriptor;
    }).sort((left, right) => {
      const a = descriptorKey(left);
      const b = descriptorKey(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    if (canonicalBytes(reads) > PLANNING_CATALOG_LIMITS.serializedBytes) {
      throw new PlanningReadError(`Planning catalog exceeds ${PLANNING_CATALOG_LIMITS.serializedBytes} canonical bytes`);
    }
    return {
      digest: planningCanonicalDigest(reads),
      reads,
    };
  }

  catalog(): ProgramPlanningCatalogV1 {
    return structuredClone(this.planningCatalog);
  }

  track(workspaceIdentity: string): TrackedPlanningReads {
    const tracker = new TrackedPlanningReads(this, workspaceIdentity);
    this.issuedTrackers.add(tracker);
    return tracker;
  }

  isIssuedTracker(tracker: TrackedPlanningReads): boolean {
    return this.issuedTrackers.has(tracker);
  }

  get(readContractId: string, readContractVersion: number): PlanningReadContractV1 {
    const contract = this.contracts.get(contractKey(readContractId, readContractVersion));
    if (contract === undefined) {
      throw new PlanningReadError(`Unknown planning read contract ${readContractId}@${readContractVersion}`);
    }
    return contract;
  }

  async read(
    readContractId: string,
    readContractVersion: number,
    input: Json,
  ): Promise<PlanningReadDeliveryV1> {
    const contract = this.get(readContractId, readContractVersion);
    const canonicalArgs = contract.normalizeArgs(input);
    const argsBytes = canonicalBytes(canonicalArgs);
    if (argsBytes > contract.maxCanonicalArgsBytes) {
      throw new PlanningReadError(
        `${readContractId}@${readContractVersion} canonical arguments exceed ${contract.maxCanonicalArgsBytes} bytes`,
      );
    }

    const observation = await contract.execute(canonicalArgs);
    if (!observation.complete) {
      throw new PlanningReadError(`${readContractId}@${readContractVersion} returned incomplete/unknown planning data`);
    }
    requireNonEmpty("coverageIdentity", observation.coverageIdentity);
    const resultBytes = canonicalBytes(observation.result);
    if (resultBytes > contract.maxCanonicalResultBytes) {
      throw new PlanningReadError(
        `${readContractId}@${readContractVersion} canonical result exceeds ${contract.maxCanonicalResultBytes} bytes`,
      );
    }

    return {
      result: observation.result,
      dependency: {
        readContractId,
        readContractVersion,
        canonicalArgs,
        canonicalArgsDigest: planningCanonicalDigest(canonicalArgs),
        canonicalResultDigest: planningCanonicalDigest(observation.result),
        coverageIdentity: observation.coverageIdentity,
        ...(observation.providerBindingRevision !== undefined
          ? { providerBindingRevision: observation.providerBindingRevision }
          : {}),
      },
    };
  }

  async recheck(identity: PlanningObservationIdentityV1): Promise<void> {
    assertPlanningObservationIdentity(identity);
    if (identity.planningCatalogDigest === undefined) {
      if (this.planningCatalog.reads.length > 0) {
        throw new PlanningBaseStaleError("Planning model-facing catalog changed or is unavailable");
      }
    } else if (identity.planningCatalogDigest !== this.planningCatalog.digest) {
      throw new PlanningBaseStaleError("Planning model-facing catalog changed or is unavailable");
    }
    if (identity.planningCoverageProfileId !== this.planningCoverageProfileId ||
        identity.planningCoverageProfileVersion !== this.planningCoverageProfileVersion) {
      throw new PlanningBaseStaleError("Planning coverage profile changed or is unavailable");
    }

    for (const dependency of identity.dependencies) {
      if (planningCanonicalDigest(dependency.canonicalArgs) !== dependency.canonicalArgsDigest) {
        throw new PlanningBaseStaleError(
          `Planning dependency argument integrity failed for ${dependency.readContractId}@${dependency.readContractVersion}`,
        );
      }

      let current: PlanningReadDeliveryV1;
      try {
        current = await this.read(
          dependency.readContractId,
          dependency.readContractVersion,
          dependency.canonicalArgs,
        );
      } catch (error) {
        throw new PlanningBaseStaleError(
          `Planning dependency unavailable for ${dependency.readContractId}@${dependency.readContractVersion}: ${String(error)}`,
        );
      }

      const actual = current.dependency;
      if (actual.canonicalArgsDigest !== dependency.canonicalArgsDigest ||
          actual.canonicalResultDigest !== dependency.canonicalResultDigest ||
          actual.coverageIdentity !== dependency.coverageIdentity ||
          actual.providerBindingRevision !== dependency.providerBindingRevision) {
        throw new PlanningBaseStaleError(
          `Planning dependency changed for ${dependency.readContractId}@${dependency.readContractVersion}`,
        );
      }
    }
  }
}

export class TrackedPlanningReads {
  private readonly dependencies: PlanningReadDependencyV1[] = [];
  private readonly planningCatalogDigest: string;
  private sealed = false;
  private inFlight = 0;

  constructor(
    private readonly registry: PlanningReadRegistry,
    private readonly workspaceIdentity: string,
  ) {
    requireNonEmpty("workspaceIdentity", workspaceIdentity);
    this.planningCatalogDigest = registry.catalog().digest;
  }

  async read(
    readContractId: string,
    readContractVersion: number,
    input: Json,
  ): Promise<Json> {
    if (this.sealed) throw new PlanningReadError("Planning dependency set is already sealed");
    this.inFlight += 1;
    try {
      const delivery = await this.registry.read(readContractId, readContractVersion, input);
      if (this.sealed) {
        throw new PlanningReadError("Planning dependency set was sealed while a semantic read was in flight");
      }
      this.dependencies.push(delivery.dependency);
      if (this.dependencies.length > PLANNING_PROVENANCE_LIMITS.dependencies) {
        throw new PlanningReadError(
          `Planning dependency count exceeds ${PLANNING_PROVENANCE_LIMITS.dependencies}`,
        );
      }
      return delivery.result;
    } finally {
      this.inFlight -= 1;
    }
  }

  seal(): PlanningObservationIdentityV1 {
    if (this.sealed) throw new PlanningReadError("Planning dependency set is already sealed");
    if (this.inFlight != 0) {
      throw new PlanningReadError("Cannot seal planning dependencies while semantic reads are in flight");
    }
    this.sealed = true;

    const byKey = new Map<string, PlanningReadDependencyV1>();
    for (const dependency of this.dependencies) {
      const key = dependencyKey(dependency);
      const prior = byKey.get(key);
      if (prior === undefined) {
        byKey.set(key, dependency);
      } else if (canonicalStringify(prior) !== canonicalStringify(dependency)) {
        throw new PlanningReadError(
          `Planning read ${dependency.readContractId}@${dependency.readContractVersion} changed during planning`,
        );
      }
    }

    const dependencies = [...byKey.values()].sort((a, b) => {
      const left = dependencyKey(a);
      const right = dependencyKey(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const body: Omit<PlanningObservationIdentityV1, "digest"> = {
      profileId: TRACKED_PLANNING_PROFILE_ID,
      profileVersion: TRACKED_PLANNING_PROFILE_VERSION,
      workspaceIdentity: this.workspaceIdentity,
      planningCoverageProfileId: this.registry.planningCoverageProfileId,
      planningCoverageProfileVersion: this.registry.planningCoverageProfileVersion,
      planningCatalogDigest: this.planningCatalogDigest,
      dependencies,
    };
    const identity: PlanningObservationIdentityV1 = {
      ...body,
      digest: planningCanonicalDigest(identityBody(body)),
    };
    assertPlanningObservationIdentity(identity);
    return identity;
  }
}

export function assertPlanningObservationIdentity(identity: PlanningObservationIdentityV1): void {
  if (identity.profileId !== TRACKED_PLANNING_PROFILE_ID ||
      identity.profileVersion !== TRACKED_PLANNING_PROFILE_VERSION) {
    throw new PlanningReadError("Unsupported planning provenance profile");
  }
  requireNonEmpty("workspaceIdentity", identity.workspaceIdentity);
  requireNonEmpty("planningCoverageProfileId", identity.planningCoverageProfileId);
  requireVersion("planningCoverageProfileVersion", identity.planningCoverageProfileVersion);
  if (identity.planningCatalogDigest !== undefined) {
    requireNonEmpty("planningCatalogDigest", identity.planningCatalogDigest);
  }
  if (identity.dependencies.length > PLANNING_PROVENANCE_LIMITS.dependencies) {
    throw new PlanningReadError(`Planning dependency count exceeds ${PLANNING_PROVENANCE_LIMITS.dependencies}`);
  }

  let previous = "";
  for (const dependency of identity.dependencies) {
    requireNonEmpty("readContractId", dependency.readContractId);
    requireVersion("readContractVersion", dependency.readContractVersion);
    requireNonEmpty("canonicalArgsDigest", dependency.canonicalArgsDigest);
    requireNonEmpty("canonicalResultDigest", dependency.canonicalResultDigest);
    requireNonEmpty("coverageIdentity", dependency.coverageIdentity);
    if (planningCanonicalDigest(dependency.canonicalArgs) !== dependency.canonicalArgsDigest) {
      throw new PlanningReadError("Planning dependency canonicalArgsDigest does not match canonicalArgs");
    }
    const key = dependencyKey(dependency);
    if (key <= previous) {
      throw new PlanningReadError("Planning dependencies must be uniquely sorted by stable dependency identity");
    }
    previous = key;
  }

  const expectedDigest = planningCanonicalDigest(identityBody({
    profileId: identity.profileId,
    profileVersion: identity.profileVersion,
    workspaceIdentity: identity.workspaceIdentity,
    planningCoverageProfileId: identity.planningCoverageProfileId,
    planningCoverageProfileVersion: identity.planningCoverageProfileVersion,
    ...(identity.planningCatalogDigest !== undefined
      ? { planningCatalogDigest: identity.planningCatalogDigest }
      : {}),
    dependencies: identity.dependencies,
  }));
  if (identity.digest !== expectedDigest) {
    throw new PlanningReadError("PlanningObservationIdentity digest mismatch");
  }
  if (canonicalBytes(identity) > PLANNING_PROVENANCE_LIMITS.serializedIdentityBytes) {
    throw new PlanningReadError(
      `PlanningObservationIdentity exceeds ${PLANNING_PROVENANCE_LIMITS.serializedIdentityBytes} bytes`,
    );
  }
}
