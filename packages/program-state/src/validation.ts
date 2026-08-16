import { assertCanonical, canonicalStringify } from "./canonical.ts";
import { PROGRAM_LIMITS } from "./limits.ts";
import type {
  FreshnessPathEntry,
  ProgramArtifactProductionStep,
  ProgramState,
  VerificationFreshnessScopeV1,
  VerificationObligation,
} from "./types.ts";

export type ProgramInvariantCode =
  | "duplicate_id"
  | "unknown_reference"
  | "self_dependency"
  | "dependency_cycle"
  | "duplicate_dependency"
  | "duplicate_path"
  | "invalid_path"
  | "limit_exceeded"
  | "invalid_value"
  | "scope_mismatch"
  | "structural_invariant";

export class ProgramInvariantError extends Error {
  constructor(
    public readonly code: ProgramInvariantCode,
    message: string,
  ) {
    super(message);
    this.name = "ProgramInvariantError";
  }
}

const encoder = new TextEncoder();
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function fail(code: ProgramInvariantCode, message: string): never {
  throw new ProgramInvariantError(code, message);
}

function requireCount(label: string, actual: number, maximum: number): void {
  if (actual > maximum) {
    fail("limit_exceeded", `${label} exceeds ${maximum}; got ${actual}`);
  }
}

function requireNonEmptyString(label: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    fail("invalid_value", `${label} must be a non-empty string`);
  }
}

function requirePositiveVersion(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail("invalid_value", `${label} must be a positive safe integer`);
  }
}

function requireGeneration(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("invalid_value", `${label} must be a positive safe integer`);
  }
}

export function assertNormalizedWorkspacePath(path: string): void {
  if (typeof path !== "string" || path.length === 0) {
    fail("invalid_path", "Workspace path must be non-empty");
  }
  if (path.includes("\0") || path.includes("\\")) {
    fail("invalid_path", `Workspace path is not normalized: ${JSON.stringify(path)}`);
  }
  if (path.startsWith("/") || path.endsWith("/")) {
    fail("invalid_path", `Workspace path must be relative without a trailing slash: ${path}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("invalid_path", `Workspace path contains a non-canonical segment: ${path}`);
  }
  if (utf8Bytes(path) > PROGRAM_LIMITS.normalizedPathBytes) {
    fail("limit_exceeded", `Workspace path exceeds ${PROGRAM_LIMITS.normalizedPathBytes} UTF-8 bytes`);
  }
}

function assertLocallyDeduplicatedPaths(label: string, paths: readonly string[]): void {
  const seen = new Set<string>();
  for (const path of paths) {
    assertNormalizedWorkspacePath(path);
    if (seen.has(path)) {
      fail("duplicate_path", `${label} contains duplicate normalized path ${path}`);
    }
    seen.add(path);
  }
}

function assertFreshnessEntries(entries: readonly FreshnessPathEntry[]): void {
  requireCount("freshness paths per obligation", entries.length, PROGRAM_LIMITS.freshnessPathsPerObligation);
  if (entries.length === 0) {
    fail("invalid_value", "paths freshness scope must be non-empty");
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    assertNormalizedWorkspacePath(entry.path);
    if (entry.mode !== "exact" && entry.mode !== "subtree") {
      fail("invalid_value", `Unsupported freshness path mode: ${String(entry.mode)}`);
    }
    const key = `${entry.mode}:${entry.path}`;
    if (seen.has(key)) {
      fail("duplicate_path", `freshness scope contains duplicate entry ${key}`);
    }
    seen.add(key);
  }
}

export function freshnessScopeCoversPath(scope: VerificationFreshnessScopeV1, path: string): boolean {
  assertNormalizedWorkspacePath(path);
  if (scope.kind === "workspace") return true;
  return scope.entries.some((entry) =>
    entry.mode === "exact"
      ? entry.path === path
      : path === entry.path || path.startsWith(`${entry.path}/`),
  );
}

function canonicalArgBytes(value: unknown): number {
  assertCanonical(value);
  return utf8Bytes(canonicalStringify(value));
}

function assertOperationSpec(
  label: string,
  value: { specId: string; specVersion: number; canonicalArgs: unknown; canonicalArgsDigest: string },
  byteLimit: number,
): number {
  requireNonEmptyString(`${label}.specId`, value.specId);
  requirePositiveVersion(`${label}.specVersion`, value.specVersion);
  requireNonEmptyString(`${label}.canonicalArgsDigest`, value.canonicalArgsDigest);
  const bytes = canonicalArgBytes(value.canonicalArgs);
  if (bytes > byteLimit) {
    fail("limit_exceeded", `${label} canonical arguments exceed ${byteLimit} bytes; got ${bytes}`);
  }
  return bytes;
}

function assertPredicate(
  obligation: VerificationObligation,
  outputSlotIds: ReadonlySet<string>,
): number {
  const predicate = obligation.predicate as VerificationObligation["predicate"] & { kind: string };
  switch (predicate.kind) {
    case "operation_result":
      return assertOperationSpec(
        `verification ${String(obligation.obligationId)}`,
        predicate,
        PROGRAM_LIMITS.verificationCanonicalArgsBytes,
      );
    case "workspace_path_state":
      assertNormalizedWorkspacePath(predicate.path);
      if (!freshnessScopeCoversPath(obligation.freshnessScope, predicate.path)) {
        fail(
          "scope_mismatch",
          `verification ${String(obligation.obligationId)} freshness scope does not cover ${predicate.path}`,
        );
      }
      return 0;
    case "artifact_present":
      if (!outputSlotIds.has(String(predicate.outputSlotId))) {
        fail(
          "unknown_reference",
          `verification ${String(obligation.obligationId)} references unknown output slot ${String(predicate.outputSlotId)}`,
        );
      }
      return 0;
    default:
      return fail("invalid_value", `Unsupported VerificationPredicateV1 kind: ${String(predicate.kind)}`);
  }
}

function assertUniqueIds<T>(label: string, values: readonly T[], id: (value: T) => string): Set<string> {
  const seen = new Set<string>();
  for (const value of values) {
    const key = id(value);
    requireNonEmptyString(`${label} id`, key);
    if (seen.has(key)) fail("duplicate_id", `${label} contains duplicate id ${key}`);
    seen.add(key);
  }
  return seen;
}

function assertDag(state: ProgramState, workIds: ReadonlySet<string>): number {
  let edgeCount = 0;
  const dependencies = new Map<string, string[]>();
  for (const work of state.workItems) {
    if (!Number.isSafeInteger(work.creationOrder) || work.creationOrder < 0) {
      fail("invalid_value", `work ${String(work.workItemId)} creationOrder must be a non-negative safe integer`);
    }
    requireCount(
      `direct dependencies for ${String(work.workItemId)}`,
      work.dependencyIds.length,
      PROGRAM_LIMITS.directDependenciesPerWorkItem,
    );
    const local = new Set<string>();
    const deps: string[] = [];
    for (const dependencyId of work.dependencyIds) {
      const dep = String(dependencyId);
      if (dep === String(work.workItemId)) {
        fail("self_dependency", `work ${String(work.workItemId)} depends on itself`);
      }
      if (!workIds.has(dep)) {
        fail("unknown_reference", `work ${String(work.workItemId)} references unknown dependency ${dep}`);
      }
      if (local.has(dep)) {
        fail("duplicate_dependency", `work ${String(work.workItemId)} repeats dependency ${dep}`);
      }
      local.add(dep);
      deps.push(dep);
      edgeCount += 1;
    }
    dependencies.set(String(work.workItemId), deps);
  }
  requireCount("total dependency edges", edgeCount, PROGRAM_LIMITS.totalDependencyEdges);

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) fail("dependency_cycle", `required-work DAG contains a cycle at ${id}`);
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of workIds) visit(id);
  return edgeCount;
}

function assertProductionStep(
  step: ProgramArtifactProductionStep,
  workIds: ReadonlySet<string>,
): number {
  if (!workIds.has(String(step.producerWorkItemId))) {
    fail(
      "unknown_reference",
      `production step ${String(step.productionStepId)} references unknown work ${String(step.producerWorkItemId)}`,
    );
  }
  requireNonEmptyString(`production step ${String(step.productionStepId)} outputChannel`, step.outputChannel);
  return assertOperationSpec(
    `production step ${String(step.productionStepId)}`,
    step,
    PROGRAM_LIMITS.productionCanonicalArgsBytes,
  );
}

/** Validate every bounded/rebuildable semantic invariant owned by the pure package. */
export function assertValidProgramState(state: ProgramState): void {
  if (state.revision < 1 || !Number.isSafeInteger(state.revision)) {
    fail("invalid_value", "ProgramState.revision must be a positive safe integer");
  }
  if (!UUID_V7_RE.test(String(state.programStateId))) {
    fail("invalid_value", `ProgramStateId must be a UUIDv7; got ${String(state.programStateId)}`);
  }
  if (utf8Bytes(state.objective) > PROGRAM_LIMITS.objectiveBytes) {
    fail("limit_exceeded", `objective exceeds ${PROGRAM_LIMITS.objectiveBytes} UTF-8 bytes`);
  }

  requireCount("work items", state.workItems.length, PROGRAM_LIMITS.workItems);
  requireCount("blockers", state.blockers.length, PROGRAM_LIMITS.blockers);
  requireCount("verification obligations", state.verification.length, PROGRAM_LIMITS.verificationObligations);
  requireCount("output slots", state.outputSlots.length, PROGRAM_LIMITS.outputSlots);
  requireCount("production steps", state.productionSteps.length, PROGRAM_LIMITS.productionSteps);
  requireCount("decisive evidence refs", state.decisiveEvidence.length, PROGRAM_LIMITS.totalDecisiveEvidenceRefs);
  requireCount("retained artifact refs", state.artifacts.length, PROGRAM_LIMITS.retainedArtifactRefs);
  requireCount("session attachments", state.attachedSessionIds.length, PROGRAM_LIMITS.uniqueSessionAttachments);

  const workIds = assertUniqueIds("work items", state.workItems, (work) => String(work.workItemId));
  assertUniqueIds("blockers", state.blockers, (blocker) => String(blocker.blockerId));
  const verificationIds = assertUniqueIds(
    "verification obligations",
    state.verification,
    (obligation) => String(obligation.obligationId),
  );
  const outputSlotIds = assertUniqueIds("output slots", state.outputSlots, (slot) => String(slot.outputSlotId));
  const productionStepIds = assertUniqueIds(
    "production steps",
    state.productionSteps,
    (step) => String(step.productionStepId),
  );
  const evidenceIds = assertUniqueIds("decisive evidence", state.decisiveEvidence, (ref) => String(ref.evidenceRefId));
  assertUniqueIds("artifact refs", state.artifacts, (ref) => ref.artifactRef);

  const sessions = new Set(state.attachedSessionIds.map(String));
  if (sessions.size !== state.attachedSessionIds.length) {
    fail("duplicate_id", "attachedSessionIds contains a duplicate session");
  }

  assertDag(state, workIds);

  let totalHumanTextBytes = utf8Bytes(state.objective);
  let totalPathEntries = 0;
  let totalPathBytes = 0;
  for (const work of state.workItems) {
    if (utf8Bytes(work.description) > PROGRAM_LIMITS.workDescriptionBytes) {
      fail("limit_exceeded", `work ${String(work.workItemId)} description exceeds ${PROGRAM_LIMITS.workDescriptionBytes} UTF-8 bytes`);
    }
    totalHumanTextBytes += utf8Bytes(work.description);
    requireCount(
      `affected paths for ${String(work.workItemId)}`,
      work.affectedPaths.length,
      PROGRAM_LIMITS.affectedPathsPerWorkItem,
    );
    assertLocallyDeduplicatedPaths(`work ${String(work.workItemId)} affectedPaths`, work.affectedPaths);
    totalPathEntries += work.affectedPaths.length;
    totalPathBytes += work.affectedPaths.reduce((sum, path) => sum + utf8Bytes(path), 0);
  }

  for (const blocker of state.blockers) {
    if (blocker.workItemId !== null && !workIds.has(String(blocker.workItemId))) {
      fail("unknown_reference", `blocker ${String(blocker.blockerId)} references unknown work ${String(blocker.workItemId)}`);
    }
    if (utf8Bytes(blocker.reason) > PROGRAM_LIMITS.blockerReasonBytes) {
      fail("limit_exceeded", `blocker ${String(blocker.blockerId)} reason exceeds ${PROGRAM_LIMITS.blockerReasonBytes} UTF-8 bytes`);
    }
    totalHumanTextBytes += utf8Bytes(blocker.reason);
  }
  requireCount("total objective/work/blocker human text bytes", totalHumanTextBytes, PROGRAM_LIMITS.totalHumanTextBytes);

  let totalArgsBytes = 0;
  for (const obligation of state.verification) {
    requireGeneration(`verification ${String(obligation.obligationId)} subjectGeneration`, obligation.subjectGeneration);
    if (obligation.freshnessScope.kind === "paths") {
      assertFreshnessEntries(obligation.freshnessScope.entries);
      totalPathEntries += obligation.freshnessScope.entries.length;
      totalPathBytes += obligation.freshnessScope.entries.reduce((sum, entry) => sum + utf8Bytes(entry.path), 0);
    }
    if (obligation.satisfaction !== null) {
      requireGeneration("satisfaction subjectGeneration", obligation.satisfaction.subjectGeneration);
      requireCount(
        `satisfaction evidence refs for ${String(obligation.obligationId)}`,
        obligation.satisfaction.evidenceRefIds.length,
        PROGRAM_LIMITS.decisiveEvidenceRefsPerTarget,
      );
      for (const evidenceRefId of obligation.satisfaction.evidenceRefIds) {
        if (!evidenceIds.has(String(evidenceRefId))) {
          fail(
            "unknown_reference",
            `verification ${String(obligation.obligationId)} satisfaction references unknown evidence ${String(evidenceRefId)}`,
          );
        }
      }
    }
    if (obligation.waiver !== null) {
      requireGeneration("waiver subjectGeneration", obligation.waiver.subjectGeneration);
      requireNonEmptyString("waiver actor", obligation.waiver.actor);
      requireNonEmptyString("waiver source", obligation.waiver.source);
      requireNonEmptyString("waiver reason", obligation.waiver.reason);
    }
    totalArgsBytes += assertPredicate(obligation, outputSlotIds);
  }

  for (const step of state.productionSteps) totalArgsBytes += assertProductionStep(step, workIds);
  requireCount(
    "total predicate + production-step canonical argument bytes",
    totalArgsBytes,
    PROGRAM_LIMITS.totalPredicateAndProductionArgsBytes,
  );

  for (const slot of state.outputSlots) {
    if (!productionStepIds.has(String(slot.productionStepId))) {
      fail("unknown_reference", `output slot ${String(slot.outputSlotId)} references unknown production step ${String(slot.productionStepId)}`);
    }
  }

  requireCount("total path-bearing entries", totalPathEntries, PROGRAM_LIMITS.totalPathBearingEntries);
  requireCount("total normalized path bytes", totalPathBytes, PROGRAM_LIMITS.totalNormalizedPathBytes);

  const evidencePerWork = new Map<string, number>();
  const evidencePerVerification = new Map<string, number>();
  for (const ref of state.decisiveEvidence) {
    if (ref.workItemId !== null) {
      const id = String(ref.workItemId);
      if (!workIds.has(id)) fail("unknown_reference", `evidence ${String(ref.evidenceRefId)} references unknown work ${id}`);
      evidencePerWork.set(id, (evidencePerWork.get(id) ?? 0) + 1);
    }
    if (ref.verificationObligationId !== null) {
      const id = String(ref.verificationObligationId);
      if (!verificationIds.has(id)) {
        fail("unknown_reference", `evidence ${String(ref.evidenceRefId)} references unknown verification ${id}`);
      }
      evidencePerVerification.set(id, (evidencePerVerification.get(id) ?? 0) + 1);
    }
  }
  for (const [id, count] of evidencePerWork) {
    requireCount(`decisive evidence refs for work ${id}`, count, PROGRAM_LIMITS.decisiveEvidenceRefsPerTarget);
  }
  for (const [id, count] of evidencePerVerification) {
    requireCount(`decisive evidence refs for verification ${id}`, count, PROGRAM_LIMITS.decisiveEvidenceRefsPerTarget);
  }

  for (const artifact of state.artifacts) {
    requireNonEmptyString("ArtifactRef", artifact.artifactRef);
    if (artifact.outputSlotId !== null && !outputSlotIds.has(String(artifact.outputSlotId))) {
      fail("unknown_reference", `artifact ${artifact.artifactRef} references unknown output slot ${String(artifact.outputSlotId)}`);
    }
    if (artifact.productionStepId !== null && !productionStepIds.has(String(artifact.productionStepId))) {
      fail(
        "unknown_reference",
        `artifact ${artifact.artifactRef} references unknown production step ${String(artifact.productionStepId)}`,
      );
    }
  }

  if (state.activeAttempt !== null) {
    if (!workIds.has(String(state.activeAttempt.workItemId))) {
      fail("unknown_reference", `active attempt references unknown work ${String(state.activeAttempt.workItemId)}`);
    }
    if (!sessions.has(String(state.activeAttempt.sessionId))) {
      fail("unknown_reference", `active attempt references unattached session ${String(state.activeAttempt.sessionId)}`);
    }
  }

  if (state.executionBaseMismatch !== null && state.executionBaseMismatch.programStateId !== state.programStateId) {
    fail("structural_invariant", "execution-base mismatch receipt belongs to a different ProgramStateId");
  }

  for (const requirement of state.creationPolicyRequirements) assertCanonical(requirement);

  assertCanonical(state);
  const serializedBytes = utf8Bytes(canonicalStringify(state));
  requireCount(
    "serialized canonical current ProgramState bytes",
    serializedBytes,
    PROGRAM_LIMITS.serializedCanonicalProgramStateBytes,
  );
}

export function programStateIsValid(state: ProgramState): boolean {
  try {
    assertValidProgramState(state);
    return true;
  } catch {
    return false;
  }
}
