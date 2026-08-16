import { createHash } from "node:crypto";
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

export class PlanningReadRegistry {
  private readonly contracts = new Map<string, PlanningReadContractV1>();

  constructor(
    public readonly planningCoverageProfileId: string,
    public readonly planningCoverageProfileVersion: number,
    contracts: readonly PlanningReadContractV1[],
  ) {
    requireNonEmpty("planningCoverageProfileId", planningCoverageProfileId);
    requireVersion("planningCoverageProfileVersion", planningCoverageProfileVersion);
    for (const contract of contracts) this.register(contract);
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
  private sealed = false;

  constructor(
    private readonly registry: PlanningReadRegistry,
    private readonly workspaceIdentity: string,
  ) {
    requireNonEmpty("workspaceIdentity", workspaceIdentity);
  }

  async read(
    readContractId: string,
    readContractVersion: number,
    input: Json,
  ): Promise<Json> {
    if (this.sealed) throw new PlanningReadError("Planning dependency set is already sealed");
    const delivery = await this.registry.read(readContractId, readContractVersion, input);
    this.dependencies.push(delivery.dependency);
    if (this.dependencies.length > PLANNING_PROVENANCE_LIMITS.dependencies) {
      throw new PlanningReadError(
        `Planning dependency count exceeds ${PLANNING_PROVENANCE_LIMITS.dependencies}`,
      );
    }
    return delivery.result;
  }

  seal(): PlanningObservationIdentityV1 {
    if (this.sealed) throw new PlanningReadError("Planning dependency set is already sealed");
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

    const dependencies = [...byKey.values()].sort((a, b) => dependencyKey(a).localeCompare(dependencyKey(b)));
    const body: Omit<PlanningObservationIdentityV1, "digest"> = {
      profileId: TRACKED_PLANNING_PROFILE_ID,
      profileVersion: TRACKED_PLANNING_PROFILE_VERSION,
      workspaceIdentity: this.workspaceIdentity,
      planningCoverageProfileId: this.registry.planningCoverageProfileId,
      planningCoverageProfileVersion: this.registry.planningCoverageProfileVersion,
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
