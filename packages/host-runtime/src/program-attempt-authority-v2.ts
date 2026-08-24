import type {
  AttemptDependencyReceiptV1,
  ProgramAttemptAuthorityV2,
  ProgramConstraintReceiptV1,
  ProgramWorkAuthorityEnvelopeWireV1,
} from "@alcode/agent-protocol";
import {
  canonicalStringify,
  isProgramSemanticRequirementComplete,
  type ProgramAttemptSemanticAssumptionsV1,
  type ProgramSemanticStateV1,
  type ProgramSemanticWorkItemV1,
  type WorkAuthorityEnvelopeV1,
} from "@alcode/program-state";
import type { ProgramSemanticCurrentSnapshotV1 } from "./program-revision.ts";

/**
 * Operational facts must be captured at the same protected Host admission cut
 * as the semantic snapshot. This module never performs independent reads.
 */
export interface ProgramAttemptRuntimeFactsV2 {
  programAttemptId: string;
  sessionId: string;
  agentGeneration: number;
  sessionActive: boolean;
  agentGenerationCurrent: boolean;
  recoveryClear: boolean;
  writerBarriersClear: boolean;
  quiescenceClear: boolean;
  executionBaseCurrent: boolean;
}

export interface ProgramAttemptAuthorityFactsV2 {
  semantic: ProgramSemanticCurrentSnapshotV1;
  runtime: ProgramAttemptRuntimeFactsV2;
}

export type ProgramAttemptAuthorityV2StaleReason =
  | "program_not_active"
  | "attempt_missing"
  | "attempt_identity_stale"
  | "work_missing"
  | "work_not_required"
  | "work_not_leaf"
  | "work_not_executable"
  | "work_generation_stale"
  | "dependency_receipt_stale"
  | "dependency_not_current"
  | "constraint_receipt_stale"
  | "session_stale"
  | "agent_generation_stale"
  | "recovery_barrier"
  | "writer_barrier"
  | "quiescence_barrier"
  | "execution_base_stale";

export type ProgramAttemptAuthorityV2Stale = { current: false; reason: ProgramAttemptAuthorityV2StaleReason };
export type ProgramAttemptAuthorityV2Evaluation = { current: true } | ProgramAttemptAuthorityV2Stale;

export class ProgramAttemptAuthorityV2Error extends Error {
  constructor(
    readonly reason: ProgramAttemptAuthorityV2StaleReason,
    message: string,
  ) {
    super(message);
    this.name = "ProgramAttemptAuthorityV2Error";
  }
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

function wireEnvelope(envelope: WorkAuthorityEnvelopeV1): ProgramWorkAuthorityEnvelopeWireV1 {
  return {
    objectiveBoundaryRef: {
      programStateId: String(envelope.objectiveBoundaryRef.programStateId),
      rootProgramRevisionId: String(envelope.objectiveBoundaryRef.rootProgramRevisionId),
      anchorWorkItemId: envelope.objectiveBoundaryRef.anchorWorkItemId === null
        ? null
        : String(envelope.objectiveBoundaryRef.anchorWorkItemId),
    },
    allowedRepositoryRoots: [...envelope.allowedRepositoryRoots],
    allowedEffectClasses: [...envelope.allowedEffectClasses],
    allowedExternalSystems: [...envelope.allowedExternalSystems],
    capabilityCeiling: [...envelope.capabilityCeiling],
    maximumTopologyExpansion: envelope.maximumTopologyExpansion,
    mandatoryVerificationIds: envelope.mandatoryVerificationIds.map(String),
    forbiddenChangeKinds: [...envelope.forbiddenChangeKinds],
  };
}

function workById(state: ProgramSemanticStateV1, workItemId: string): ProgramSemanticWorkItemV1 | undefined {
  return state.workItems.find((work) => String(work.workItemId) === workItemId);
}

function derivedDependencyReceipt(
  state: ProgramSemanticStateV1,
  work: ProgramSemanticWorkItemV1,
): AttemptDependencyReceiptV1 | undefined {
  const entries = [...work.dependencyIds]
    .map((dependencyId) => workById(state, String(dependencyId)))
    .sort((left, right) => String(left?.workItemId ?? "").localeCompare(String(right?.workItemId ?? ""), "en"));
  if (entries.some((dependency) => dependency === undefined)) return undefined;
  const receipt: AttemptDependencyReceiptV1 = { entries: [] };
  for (const dependency of entries as ProgramSemanticWorkItemV1[]) {
    if (
      dependency.requirementState !== "required"
      || !isProgramSemanticRequirementComplete(dependency.workItemId, state.workItems)
    ) return undefined;
    receipt.entries.push({
      workItemId: String(dependency.workItemId),
      workItemGeneration: dependency.workItemGeneration,
      required: true,
      satisfiedOrDischargedAtIssue: true,
    });
  }
  return receipt;
}

/**
 * The current A1 semantic kernel has no separate mandatory-constraint registry.
 * All mechanically enforceable semantic constraints are carried by the exact
 * WorkAuthorityEnvelope, so this receipt version canonically uses an empty
 * mandatoryConstraintIds array. A later constraint registry must version this
 * receipt rather than mint IDs from prose.
 */
function derivedConstraintReceipt(work: ProgramSemanticWorkItemV1): ProgramConstraintReceiptV1 {
  return {
    workAuthorityEnvelope: wireEnvelope(work.authorityEnvelope),
    mandatoryConstraintIds: [],
  };
}

function runtimeCurrentness(facts: ProgramAttemptAuthorityFactsV2): ProgramAttemptAuthorityV2Evaluation {
  const { semantic, runtime } = facts;
  if (semantic.lifecycle !== "active") return { current: false, reason: "program_not_active" };
  if (!runtime.sessionActive || !semantic.attachedSessionIds.includes(runtime.sessionId)) {
    return { current: false, reason: "session_stale" };
  }
  if (!runtime.agentGenerationCurrent) return { current: false, reason: "agent_generation_stale" };
  if (!runtime.recoveryClear) return { current: false, reason: "recovery_barrier" };
  if (!runtime.writerBarriersClear) return { current: false, reason: "writer_barrier" };
  if (!runtime.quiescenceClear) return { current: false, reason: "quiescence_barrier" };
  if (!runtime.executionBaseCurrent) return { current: false, reason: "execution_base_stale" };
  return { current: true };
}

function currentAttemptAndWork(
  facts: ProgramAttemptAuthorityFactsV2,
): { attempt: ProgramAttemptSemanticAssumptionsV1; work: ProgramSemanticWorkItemV1 } | ProgramAttemptAuthorityV2Stale {
  const attempt = facts.semantic.activeAttempt;
  if (attempt === null) return { current: false, reason: "attempt_missing" };
  if (String(attempt.programAttemptId) !== facts.runtime.programAttemptId) {
    return { current: false, reason: "attempt_identity_stale" };
  }
  const work = workById(facts.semantic.semanticState, String(attempt.workItemId));
  if (work === undefined) return { current: false, reason: "work_missing" };
  if (work.requirementState !== "required") return { current: false, reason: "work_not_required" };
  if (work.topologyState !== "leaf") return { current: false, reason: "work_not_leaf" };
  if (work.satisfactionState !== "active" && work.satisfactionState !== "awaiting_verification") {
    return { current: false, reason: "work_not_executable" };
  }
  if (work.workItemGeneration !== attempt.workItemGeneration) {
    return { current: false, reason: "work_generation_stale" };
  }
  if (!sameCanonical(work.authorityEnvelope, attempt.workAuthorityEnvelope)) {
    return { current: false, reason: "constraint_receipt_stale" };
  }
  const dependencyReceipt = derivedDependencyReceipt(facts.semantic.semanticState, work);
  if (dependencyReceipt === undefined) return { current: false, reason: "dependency_not_current" };
  const assumptionsReceipt: AttemptDependencyReceiptV1 = {
    entries: attempt.directDependencies.map((entry) => ({
      workItemId: String(entry.workItemId),
      workItemGeneration: entry.workItemGeneration,
      required: true,
      satisfiedOrDischargedAtIssue: true,
    })),
  };
  if (!sameCanonical(dependencyReceipt, assumptionsReceipt)) {
    return { current: false, reason: "dependency_receipt_stale" };
  }
  return { attempt, work };
}

/** Issue exact V2 authority from one protected-cut fact bundle. */
export function issueProgramAttemptAuthorityV2(facts: ProgramAttemptAuthorityFactsV2): ProgramAttemptAuthorityV2 {
  const runtime = runtimeCurrentness(facts);
  if (runtime.current === false) {
    throw new ProgramAttemptAuthorityV2Error(runtime.reason, `Cannot issue ProgramAttemptAuthorityV2: ${runtime.reason}`);
  }
  const resolved = currentAttemptAndWork(facts);
  if ("current" in resolved) {
    throw new ProgramAttemptAuthorityV2Error(resolved.reason, `Cannot issue ProgramAttemptAuthorityV2: ${resolved.reason}`);
  }
  if (resolved.work.satisfactionState !== "active") {
    throw new ProgramAttemptAuthorityV2Error("work_not_executable", "New V2 authority may only issue for active work");
  }
  if (!Number.isSafeInteger(facts.runtime.agentGeneration) || facts.runtime.agentGeneration < 1) {
    throw new ProgramAttemptAuthorityV2Error("agent_generation_stale", "Agent generation must be a positive safe integer");
  }
  const dependencyReceipt = derivedDependencyReceipt(facts.semantic.semanticState, resolved.work);
  if (dependencyReceipt === undefined) {
    throw new ProgramAttemptAuthorityV2Error("dependency_not_current", "Direct dependencies are not current and complete");
  }
  return {
    authorityVersion: 2,
    programStateId: String(facts.semantic.semanticState.programStateId),
    issuedUnderProgramRevisionId: String(facts.semantic.semanticState.currentRevision.programRevisionId),
    programAttemptId: String(resolved.attempt.programAttemptId),
    workItemId: String(resolved.work.workItemId),
    workItemGeneration: resolved.work.workItemGeneration,
    dependencyReceipt,
    constraintReceipt: derivedConstraintReceipt(resolved.work),
    agentGeneration: facts.runtime.agentGeneration,
  };
}

/**
 * Reconstruct V2 currentness. Deliberately does not compare
 * issuedUnderProgramRevisionId with the current semantic head.
 */
export function evaluateProgramAttemptAuthorityV2(
  authority: ProgramAttemptAuthorityV2,
  facts: ProgramAttemptAuthorityFactsV2,
): ProgramAttemptAuthorityV2Evaluation {
  const runtime = runtimeCurrentness(facts);
  if (!runtime.current) return runtime;
  const resolved = currentAttemptAndWork(facts);
  if ("current" in resolved) return resolved;

  if (
    authority.authorityVersion !== 2
    || authority.programStateId !== String(facts.semantic.semanticState.programStateId)
    || authority.programAttemptId !== String(resolved.attempt.programAttemptId)
    || authority.programAttemptId !== facts.runtime.programAttemptId
    || authority.workItemId !== String(resolved.work.workItemId)
  ) return { current: false, reason: "attempt_identity_stale" };

  if (authority.workItemGeneration !== resolved.work.workItemGeneration) {
    return { current: false, reason: "work_generation_stale" };
  }
  if (authority.agentGeneration !== facts.runtime.agentGeneration || authority.agentGeneration < 1) {
    return { current: false, reason: "agent_generation_stale" };
  }

  const dependencyReceipt = derivedDependencyReceipt(facts.semantic.semanticState, resolved.work);
  if (dependencyReceipt === undefined) return { current: false, reason: "dependency_not_current" };
  if (!sameCanonical(authority.dependencyReceipt, dependencyReceipt)) {
    return { current: false, reason: "dependency_receipt_stale" };
  }
  if (!sameCanonical(authority.constraintReceipt, derivedConstraintReceipt(resolved.work))) {
    return { current: false, reason: "constraint_receipt_stale" };
  }
  return { current: true };
}
