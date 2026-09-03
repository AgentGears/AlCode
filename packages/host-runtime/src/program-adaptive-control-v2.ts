import {
  allRequiredSemanticWorkComplete,
  assertValidProgramSemanticStateV1,
  deriveReadySemanticWorkItems,
  isVerificationCurrent,
  verificationSubjectIsCurrent,
  type CompletionBlockReason,
  type CompletionOracleFacts,
  type ProgramSemanticWorkItemV1,
} from "@alcode/program-state";
import type { ProgramDispatchWorkspaceCoordinatorV1 } from "./program-dispatch.ts";
import type { ProgramSemanticCurrentSnapshotV1 } from "./program-revision.ts";

export interface ProgramAdaptiveSemanticSessionStateSourceV2 {
  currentForSession(sessionId: string): Promise<ProgramSemanticCurrentSnapshotV1 | undefined>;
}

export interface ProgramAdaptiveEligibilityFactsV2 {
  hasActiveAttachedExecutionEpisode: boolean;
  workspaceReservationAvailable: boolean;
  recoveryClear: boolean;
  writerBarriersClear: boolean;
  quiescenceClear: boolean;
  executionBaseCurrent: boolean;
  openCanonicalBlockers: readonly { workItemId: string | null }[];
}

export interface ProgramAdaptiveEligibilityFactSourceV2 {
  currentForSession(
    sessionId: string,
    semantic: ProgramSemanticCurrentSnapshotV1,
  ): Promise<ProgramAdaptiveEligibilityFactsV2>;
}

export interface ProgramAdaptiveAttemptHistoryV2 {
  hasAnyAttempt(programStateId: string): Promise<boolean>;
}

export interface ProgramAdaptiveAgentGenerationSourceV2 {
  currentAgentGeneration(sessionId: string): number | null;
}

export type ProgramAdaptiveAttemptAdmissionResultV2 =
  | { status: "issued"; programAttemptId: string }
  | { status: "stale"; reason: string }
  | { status: "blocked"; reason: string };

export interface ProgramAdaptiveAttemptAdmissionV2 {
  issue(input: {
    programStateId: string;
    expectedProgramStateRevision: number;
    expectedProgramRevisionId: string;
    workItemId: string;
    workItemGeneration: number;
    sessionId: string;
    agentGeneration: number;
    dispatchKind: "first" | "successor";
  }): Promise<ProgramAdaptiveAttemptAdmissionResultV2>;
}

export type ProgramAdaptiveEligibilityBlockReasonV2 =
  | "semantic_state_invalid"
  | "session_inactive"
  | "canonical_blocker"
  | "workspace_busy"
  | "recovery_blocked"
  | "writer_barrier"
  | "quiescence_barrier"
  | "execution_base_stale";

export type ProgramAdaptiveScheduleResultV2 =
  | { status: "not_program" }
  | { status: "program_not_active"; lifecycle: "completed" | "cancelled" }
  | { status: "session_stale" }
  | { status: "already_started"; programAttemptId: string }
  | { status: "no_ready_work"; programStateRevision: number; programRevisionId: string }
  | { status: "operationally_blocked"; reason: ProgramAdaptiveEligibilityBlockReasonV2 }
  | { status: "agent_generation_stale" }
  | ({
      dispatchKind: "first" | "successor";
      workItemId: string;
      workItemGeneration: number;
      programStateRevision: number;
      programRevisionId: string;
    } & ProgramAdaptiveAttemptAdmissionResultV2);

export interface ProgramSemanticExecutionSchedulerOptionsV2 {
  workspaceCoordinator: ProgramDispatchWorkspaceCoordinatorV1;
  semantic: ProgramAdaptiveSemanticSessionStateSourceV2;
  operational: ProgramAdaptiveEligibilityFactSourceV2;
  attemptHistory: ProgramAdaptiveAttemptHistoryV2;
  agents: ProgramAdaptiveAgentGenerationSourceV2;
  attempts: ProgramAdaptiveAttemptAdmissionV2;
}

function compareSemanticWorkSelectionOrder(
  left: ProgramSemanticWorkItemV1,
  right: ProgramSemanticWorkItemV1,
): number {
  if (left.creationOrder !== right.creationOrder) return left.creationOrder - right.creationOrder;
  const leftId = String(left.workItemId);
  const rightId = String(right.workItemId);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function semanticStateValid(snapshot: ProgramSemanticCurrentSnapshotV1): boolean {
  try {
    assertValidProgramSemanticStateV1(snapshot.semanticState);
    return Number.isSafeInteger(snapshot.programStateRevision)
      && snapshot.programStateRevision > 0
      && String(snapshot.semanticState.programStateId).length > 0;
  } catch {
    return false;
  }
}

function workBlocked(
  facts: ProgramAdaptiveEligibilityFactsV2,
  workItemId: string,
): boolean {
  return facts.openCanonicalBlockers.some((blocker) =>
    blocker.workItemId === null || blocker.workItemId === workItemId);
}

function operationalBlockReason(
  facts: ProgramAdaptiveEligibilityFactsV2,
): ProgramAdaptiveEligibilityBlockReasonV2 | null {
  if (!facts.hasActiveAttachedExecutionEpisode) return "session_inactive";
  if (!facts.workspaceReservationAvailable) return "workspace_busy";
  if (!facts.recoveryClear) return "recovery_blocked";
  if (!facts.writerBarriersClear) return "writer_barrier";
  if (!facts.quiescenceClear) return "quiescence_barrier";
  if (!facts.executionBaseCurrent) return "execution_base_stale";
  return null;
}

/**
 * A1 semantic scheduler. Structural readiness comes only from the current
 * semantic graph; whole-state revision is passed through solely as an exact CAS
 * expectation and is never interpreted as first-dispatch state.
 */
export class ProgramSemanticExecutionSchedulerV2 {
  constructor(private readonly options: ProgramSemanticExecutionSchedulerOptionsV2) {}

  async dispatchNext(sessionId: string): Promise<ProgramAdaptiveScheduleResultV2> {
    return this.options.workspaceCoordinator.runExclusive(async () => {
      const snapshot = await this.options.semantic.currentForSession(sessionId);
      if (snapshot === undefined) return { status: "not_program" } as const;
      if (!semanticStateValid(snapshot)) {
        return { status: "operationally_blocked", reason: "semantic_state_invalid" } as const;
      }
      if (snapshot.lifecycle !== "active") {
        return { status: "program_not_active", lifecycle: snapshot.lifecycle } as const;
      }
      if (!snapshot.attachedSessionIds.includes(sessionId)) return { status: "session_stale" } as const;
      if (snapshot.activeAttempt !== null) {
        return {
          status: "already_started",
          programAttemptId: String(snapshot.activeAttempt.programAttemptId),
        } as const;
      }

      const structurallyReady = deriveReadySemanticWorkItems(snapshot.semanticState.workItems)
        .sort(compareSemanticWorkSelectionOrder);
      if (structurallyReady.length === 0) {
        return {
          status: "no_ready_work",
          programStateRevision: snapshot.programStateRevision,
          programRevisionId: String(snapshot.semanticState.currentRevision.programRevisionId),
        } as const;
      }

      const facts = await this.options.operational.currentForSession(sessionId, snapshot);
      const operational = operationalBlockReason(facts);
      if (operational !== null) return { status: "operationally_blocked", reason: operational } as const;

      const work = structurallyReady.find((candidate) => !workBlocked(facts, String(candidate.workItemId)));
      if (work === undefined) {
        return { status: "operationally_blocked", reason: "canonical_blocker" } as const;
      }

      const agentGeneration = this.options.agents.currentAgentGeneration(sessionId);
      if (agentGeneration === null || !Number.isSafeInteger(agentGeneration) || agentGeneration < 1) {
        return { status: "agent_generation_stale" } as const;
      }

      // Canonical Attempt history, not ProgramState.revision, defines whether
      // this is the first adaptive dispatch after baseline/operational churn.
      const programStateId = String(snapshot.semanticState.programStateId);
      const hasAttemptHistory = await this.options.attemptHistory.hasAnyAttempt(programStateId);
      const dispatchKind = hasAttemptHistory ? "successor" as const : "first" as const;
      const programRevisionId = String(snapshot.semanticState.currentRevision.programRevisionId);
      const admitted = await this.options.attempts.issue({
        programStateId,
        expectedProgramStateRevision: snapshot.programStateRevision,
        expectedProgramRevisionId: programRevisionId,
        workItemId: String(work.workItemId),
        workItemGeneration: work.workItemGeneration,
        sessionId,
        agentGeneration,
        dispatchKind,
      });
      return {
        ...admitted,
        dispatchKind,
        workItemId: String(work.workItemId),
        workItemGeneration: work.workItemGeneration,
        programStateRevision: snapshot.programStateRevision,
        programRevisionId,
      };
    });
  }
}

export interface ProgramAdaptiveCompletionFactsV2 extends CompletionOracleFacts {
  recoveryClear: boolean;
  hasOpenCanonicalBlocker: boolean;
  executionBaseMismatch: boolean;
  executionBaseUnavailable: boolean;
}

export interface ProgramAdaptiveCompletionFactSourceV2 {
  currentForSession(
    sessionId: string,
    semantic: ProgramSemanticCurrentSnapshotV1,
  ): Promise<ProgramAdaptiveCompletionFactsV2>;
}

export type ProgramAdaptiveCompletionBlockReasonV2 = CompletionBlockReason | "recovery_blocked";

export interface ProgramAdaptiveCompletionOracleResultV2 {
  eligible: boolean;
  blockedBy: ProgramAdaptiveCompletionBlockReasonV2[];
}

function allSemanticVerificationCurrent(snapshot: ProgramSemanticCurrentSnapshotV1): boolean {
  const semantic = snapshot.semanticState;
  const obligations = new Map(semantic.verification.map((item) => [String(item.obligationId), item]));
  if (semantic.verificationBindings.length !== semantic.verification.length) return false;
  return semantic.verification.every(isVerificationCurrent)
    && semantic.verificationBindings.every((binding) => {
      if (!obligations.has(String(binding.obligationId))) return false;
      return verificationSubjectIsCurrent(
        binding.subject,
        semantic.workItems,
        semantic.outputSlots,
        semantic.productionSteps,
      );
    });
}

/** Pure A1 Completion Oracle over one protected-cut fact bundle. */
export function evaluateAdaptiveCompletionOracleV2(
  snapshot: ProgramSemanticCurrentSnapshotV1,
  facts: ProgramAdaptiveCompletionFactsV2,
): ProgramAdaptiveCompletionOracleResultV2 {
  const blockedBy: ProgramAdaptiveCompletionBlockReasonV2[] = [];
  const semanticValid = semanticStateValid(snapshot);
  if (!semanticValid) blockedBy.push("structural_invariant_violation");
  if (snapshot.lifecycle !== "active") blockedBy.push("program_not_active");
  if (!semanticValid || !allRequiredSemanticWorkComplete(snapshot.semanticState.workItems)) {
    blockedBy.push("required_work_incomplete");
  }
  if (!semanticValid || !allSemanticVerificationCurrent(snapshot)) blockedBy.push("verification_not_current");
  if (facts.hasOpenCanonicalBlocker) blockedBy.push("unresolved_blocker");
  if (snapshot.activeAttempt !== null) blockedBy.push("active_attempt");
  if (facts.executionBaseMismatch) blockedBy.push("execution_base_mismatch");
  if (facts.executionBaseUnavailable) blockedBy.push("execution_base_unavailable");
  if (!facts.executionBaseCurrent) blockedBy.push("execution_base_not_current");
  if (!facts.recoveryClear) blockedBy.push("recovery_blocked");
  if (!facts.noOutstandingProgramOperations) blockedBy.push("outstanding_program_operation");
  if (!facts.noIndeterminateEffectsOrReconciliation) {
    blockedBy.push("indeterminate_effect_or_reconciliation");
  }
  if (!facts.noOutstandingWriterBarrier) blockedBy.push("outstanding_writer_barrier");
  if (!facts.noRetryableDurableWork) blockedBy.push("retryable_durable_work");
  if (!facts.artifactIntegrityCurrent) blockedBy.push("artifact_integrity_unavailable");
  return { eligible: blockedBy.length === 0, blockedBy };
}

export type ProgramAdaptiveCompletionAdmissionResultV2 =
  | { status: "completed"; duplicate?: boolean }
  | { status: "stale"; reason: string };

export interface ProgramAdaptiveCompletionAdmissionV2 {
  complete(input: {
    programStateId: string;
    expectedProgramStateRevision: number;
    expectedProgramRevisionId: string;
    sessionId: string;
  }): Promise<ProgramAdaptiveCompletionAdmissionResultV2>;
}

export interface ProgramSemanticCompletionServiceOptionsV2 {
  workspaceCoordinator: ProgramDispatchWorkspaceCoordinatorV1;
  semantic: ProgramAdaptiveSemanticSessionStateSourceV2;
  operational: ProgramAdaptiveCompletionFactSourceV2;
  admission: ProgramAdaptiveCompletionAdmissionV2;
}

export type ProgramAdaptiveCompletionResultV2 =
  | { status: "not_program" }
  | { status: "completed"; duplicate: boolean }
  | { status: "cancelled" }
  | { status: "blocked"; blockedBy: ProgramAdaptiveCompletionBlockReasonV2[] }
  | { status: "stale"; reason: string };

/**
 * Host completion coordinator for adaptive Programs. Pending semantic drafts are
 * intentionally absent from this interface because they are noncanonical
 * control state and therefore cannot become Completion burden.
 */
export class ProgramSemanticCompletionServiceV2 {
  constructor(private readonly options: ProgramSemanticCompletionServiceOptionsV2) {}

  async complete(sessionId: string): Promise<ProgramAdaptiveCompletionResultV2> {
    return this.options.workspaceCoordinator.runExclusive(async () => {
      const snapshot = await this.options.semantic.currentForSession(sessionId);
      if (snapshot === undefined) return { status: "not_program" } as const;
      if (snapshot.lifecycle === "completed") return { status: "completed", duplicate: true } as const;
      if (snapshot.lifecycle === "cancelled") return { status: "cancelled" } as const;
      if (!snapshot.attachedSessionIds.includes(sessionId)) {
        return { status: "stale", reason: "Completion session is no longer attached" } as const;
      }

      const facts = await this.options.operational.currentForSession(sessionId, snapshot);
      const oracle = evaluateAdaptiveCompletionOracleV2(snapshot, facts);
      if (!oracle.eligible) return { status: "blocked", blockedBy: oracle.blockedBy } as const;

      const admitted = await this.options.admission.complete({
        programStateId: String(snapshot.semanticState.programStateId),
        expectedProgramStateRevision: snapshot.programStateRevision,
        expectedProgramRevisionId: String(snapshot.semanticState.currentRevision.programRevisionId),
        sessionId,
      });
      if (admitted.status === "stale") return admitted;
      return { status: "completed", duplicate: admitted.duplicate === true } as const;
    });
  }
}

export type ProgramAdaptiveIdleResultV2 =
  | { status: "not_program" }
  | { status: "handled"; terminal: "none" | "completed" | "cancelled"; reason?: string };

export interface ProgramAdaptiveScheduleControlPortV2 {
  dispatchNext(sessionId: string): Promise<ProgramAdaptiveScheduleResultV2>;
}

export interface ProgramAdaptiveCompletionControlPortV2 {
  complete(sessionId: string): Promise<ProgramAdaptiveCompletionResultV2>;
}

export interface ProgramAdaptiveExecutionControlOptionsV2 {
  scheduler: ProgramAdaptiveScheduleControlPortV2;
  completion: ProgramAdaptiveCompletionControlPortV2;
}

/** Event-driven adaptive control: schedule one semantic successor or prove terminal closure. */
export class ProgramAdaptiveExecutionControlV2 {
  constructor(private readonly options: ProgramAdaptiveExecutionControlOptionsV2) {}

  async ensureCurrentAttempt(sessionId: string): Promise<ProgramAdaptiveScheduleResultV2> {
    const scheduled = await this.options.scheduler.dispatchNext(sessionId);
    if (scheduled.status !== "no_ready_work") return scheduled;

    // Explicit product redrive must not depend on a second Agent idle edge after
    // final progress retires the active Attempt. Re-evaluate Host Completion
    // whenever the semantic scheduler proves there is no successor to dispatch.
    const terminal = await this.options.completion.complete(sessionId);
    if (terminal.status === "not_program") return { status: "not_program" };
    if (terminal.status === "completed") return { status: "program_not_active", lifecycle: "completed" };
    if (terminal.status === "cancelled") return { status: "program_not_active", lifecycle: "cancelled" };
    return scheduled;
  }

  async handleAgentIdle(sessionId: string): Promise<ProgramAdaptiveIdleResultV2> {
    const scheduled = await this.options.scheduler.dispatchNext(sessionId);
    if (scheduled.status === "not_program") return { status: "not_program" };
    if (scheduled.status === "program_not_active") {
      return { status: "handled", terminal: scheduled.lifecycle };
    }
    if (scheduled.status === "already_started") {
      return { status: "handled", terminal: "none", reason: "active_attempt" };
    }
    if (scheduled.status === "session_stale") {
      return { status: "handled", terminal: "none", reason: "session_stale" };
    }
    if (scheduled.status === "issued") {
      return { status: "handled", terminal: "none", reason: "successor_dispatched" };
    }
    if (scheduled.status === "stale" || scheduled.status === "blocked") {
      return { status: "handled", terminal: "none", reason: `dispatch_${scheduled.status}` };
    }

    const terminal = await this.options.completion.complete(sessionId);
    if (terminal.status === "not_program") return { status: "not_program" };
    if (terminal.status === "completed") return { status: "handled", terminal: "completed" };
    if (terminal.status === "cancelled") return { status: "handled", terminal: "cancelled" };
    return {
      status: "handled",
      terminal: "none",
      reason: terminal.status === "blocked" ? "completion_blocked" : "completion_stale",
    };
  }
}
