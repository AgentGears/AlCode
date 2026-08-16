import { canonicalStringify } from "./canonical.ts";
import { evaluateCompletionOracle } from "./completion.ts";
import { assertValidProgramState, ProgramInvariantError } from "./validation.ts";
import { isVerificationCurrent } from "./verification.ts";
import type {
  CompletionOracleFacts,
  ExecutionBaseMismatchReceipt,
  ProgramArtifactReference,
  ProgramAttempt,
  ProgramAttemptExecutionBase,
  ProgramBlocker,
  ProgramBlockerId,
  ProgramEvidenceReference,
  ProgramState,
  ProgramWorkItemId,
  ProgramWorkLifecycle,
  SessionId,
  VerificationObligationId,
  VerificationSatisfaction,
  VerificationWaiver,
} from "./types.ts";

export class ProgramRevisionConflictError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`Program revision conflict: expected ${expected}, current ${actual}`);
    this.name = "ProgramRevisionConflictError";
  }
}

export class ProgramTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramTransitionError";
  }
}

interface RevisionedTransition {
  expectedProgramRevision: number;
}

export type ProgramTransition =
  | (RevisionedTransition & { kind: "session.attach"; sessionId: SessionId })
  | (RevisionedTransition & { kind: "session.detach"; sessionId: SessionId })
  | (RevisionedTransition & {
      kind: "work.lifecycle.set";
      workItemId: ProgramWorkItemId;
      lifecycle: ProgramWorkLifecycle;
    })
  | (RevisionedTransition & { kind: "blocker.add"; blocker: ProgramBlocker })
  | (RevisionedTransition & { kind: "blocker.resolve"; blockerId: ProgramBlockerId })
  | (RevisionedTransition & { kind: "attempt.issue"; attempt: ProgramAttempt })
  | (RevisionedTransition & { kind: "attempt.interrupt"; programAttemptId: string })
  | (RevisionedTransition & {
      kind: "attempt.execution_base.advance";
      programAttemptId: string;
      executionBase: ProgramAttemptExecutionBase;
    })
  | (RevisionedTransition & {
      kind: "execution_base.adopt";
      executionBase: ProgramAttemptExecutionBase;
    })
  | (RevisionedTransition & {
      kind: "execution_base.mismatch";
      receipt: ExecutionBaseMismatchReceipt;
      invalidateVerificationObligationIds: VerificationObligationId[];
    })
  | (RevisionedTransition & {
      kind: "execution_base.rebase_accept";
      mismatchReceiptId: string;
      executionBase: ProgramAttemptExecutionBase;
    })
  | (RevisionedTransition & { kind: "execution_base.unavailable" })
  | (RevisionedTransition & {
      kind: "verification.invalidate";
      obligationIds: VerificationObligationId[];
    })
  | (RevisionedTransition & {
      kind: "verification.satisfy";
      obligationId: VerificationObligationId;
      satisfaction: VerificationSatisfaction;
    })
  | (RevisionedTransition & {
      kind: "verification.waive";
      obligationId: VerificationObligationId;
      waiver: VerificationWaiver;
    })
  | (RevisionedTransition & { kind: "evidence.add"; evidence: ProgramEvidenceReference })
  | (RevisionedTransition & { kind: "artifact.add"; artifact: ProgramArtifactReference })
  | (RevisionedTransition & { kind: "program.cancel" })
  | (RevisionedTransition & { kind: "program.complete"; oracleFacts: CompletionOracleFacts });

function requireCurrentRevision(state: ProgramState, transition: RevisionedTransition): void {
  if (transition.expectedProgramRevision !== state.revision) {
    throw new ProgramRevisionConflictError(transition.expectedProgramRevision, state.revision);
  }
}

function requireActive(state: ProgramState): void {
  if (state.lifecycle !== "active") {
    throw new ProgramTransitionError(`Program is terminal: ${state.lifecycle}`);
  }
}

function findWorkIndex(state: ProgramState, id: ProgramWorkItemId): number {
  const index = state.workItems.findIndex((work) => work.workItemId === id);
  if (index < 0) throw new ProgramTransitionError(`Unknown work item ${String(id)}`);
  return index;
}

function findVerificationIndex(state: ProgramState, id: VerificationObligationId): number {
  const index = state.verification.findIndex((obligation) => obligation.obligationId === id);
  if (index < 0) throw new ProgramTransitionError(`Unknown verification obligation ${String(id)}`);
  return index;
}

function semanticEqual(a: ProgramState, b: ProgramState): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}

/**
 * One admitted semantic transition changes the Program revision exactly once,
 * regardless of how many current fields it changes. A semantic no-op returns
 * the original state and does not advance the revision.
 */
function finalize(state: ProgramState, candidate: ProgramState): ProgramState {
  if (semanticEqual(state, candidate)) return state;
  const next = { ...candidate, revision: state.revision + 1 };
  assertValidProgramState(next);
  return next;
}

function invalidateVerification(
  state: ProgramState,
  ids: readonly VerificationObligationId[],
): ProgramState["verification"] {
  if (ids.length === 0) return state.verification;
  const wanted = new Set(ids.map(String));
  for (const id of wanted) {
    if (!state.verification.some((obligation) => String(obligation.obligationId) === id)) {
      throw new ProgramTransitionError(`Unknown verification obligation ${id}`);
    }
  }
  return state.verification.map((obligation) =>
    wanted.has(String(obligation.obligationId))
      ? {
          ...obligation,
          subjectGeneration: obligation.subjectGeneration + 1,
          satisfaction: null,
          waiver: null,
        }
      : obligation,
  );
}

/**
 * Apply a Host-admitted semantic Program transition. This function performs no
 * environmental checks and no I/O; the Host must establish external authority
 * (Workspace observations, quiescence, policy, operation outcomes) before
 * selecting a transition.
 */
export function applyProgramTransition(
  state: ProgramState,
  transition: ProgramTransition,
): ProgramState {
  assertValidProgramState(state);
  requireCurrentRevision(state, transition);

  switch (transition.kind) {
    case "session.attach": {
      requireActive(state);
      if (state.attachedSessionIds.includes(transition.sessionId)) return state;
      return finalize(state, {
        ...state,
        attachedSessionIds: [...state.attachedSessionIds, transition.sessionId],
      });
    }

    case "session.detach": {
      requireActive(state);
      if (!state.attachedSessionIds.includes(transition.sessionId)) return state;
      if (state.activeAttempt?.sessionId === transition.sessionId) {
        throw new ProgramTransitionError("Cannot detach the session that owns the active ProgramAttempt");
      }
      return finalize(state, {
        ...state,
        attachedSessionIds: state.attachedSessionIds.filter((id) => id !== transition.sessionId),
      });
    }

    case "work.lifecycle.set": {
      requireActive(state);
      const index = findWorkIndex(state, transition.workItemId);
      const current = state.workItems[index]!;
      if (current.lifecycle === "completed" && transition.lifecycle !== "completed") {
        throw new ProgramTransitionError("Completed required work is not reopened in Phase 1.0");
      }
      if (current.lifecycle === transition.lifecycle) return state;
      const workItems = [...state.workItems];
      workItems[index] = { ...current, lifecycle: transition.lifecycle };
      return finalize(state, { ...state, workItems });
    }

    case "blocker.add": {
      requireActive(state);
      const existing = state.blockers.find((blocker) => blocker.blockerId === transition.blocker.blockerId);
      if (existing !== undefined) {
        if (canonicalStringify(existing) === canonicalStringify(transition.blocker)) return state;
        throw new ProgramTransitionError(`Blocker id already exists: ${String(transition.blocker.blockerId)}`);
      }
      return finalize(state, { ...state, blockers: [...state.blockers, transition.blocker] });
    }

    case "blocker.resolve": {
      requireActive(state);
      const index = state.blockers.findIndex((blocker) => blocker.blockerId === transition.blockerId);
      if (index < 0) throw new ProgramTransitionError(`Unknown blocker ${String(transition.blockerId)}`);
      if (state.blockers[index]!.state === "resolved") return state;
      const blockers = [...state.blockers];
      blockers[index] = { ...blockers[index]!, state: "resolved" };
      return finalize(state, { ...state, blockers });
    }

    case "attempt.issue": {
      requireActive(state);
      if (state.activeAttempt !== null) throw new ProgramTransitionError("A ProgramAttempt is already active");
      if (!state.attachedSessionIds.includes(transition.attempt.sessionId)) {
        throw new ProgramTransitionError("ProgramAttempt session is not attached");
      }
      const index = findWorkIndex(state, transition.attempt.workItemId);
      const work = state.workItems[index]!;
      if (work.lifecycle !== "pending") {
        throw new ProgramTransitionError(`Work ${String(work.workItemId)} is not pending`);
      }
      const workItems = [...state.workItems];
      workItems[index] = { ...work, lifecycle: "in_progress" };
      return finalize(state, { ...state, workItems, activeAttempt: transition.attempt });
    }

    case "attempt.interrupt": {
      requireActive(state);
      const attempt = state.activeAttempt;
      if (attempt === null) return state;
      if (String(attempt.programAttemptId) !== transition.programAttemptId) {
        throw new ProgramTransitionError("Attempt interruption targets a stale ProgramAttemptId");
      }
      const index = findWorkIndex(state, attempt.workItemId);
      const work = state.workItems[index]!;
      const workItems = [...state.workItems];
      if (work.lifecycle === "in_progress") workItems[index] = { ...work, lifecycle: "pending" };
      return finalize(state, { ...state, workItems, activeAttempt: null });
    }

    case "attempt.execution_base.advance": {
      requireActive(state);
      const attempt = state.activeAttempt;
      if (attempt === null || String(attempt.programAttemptId) !== transition.programAttemptId) {
        throw new ProgramTransitionError("Execution-base advance targets a stale ProgramAttemptId");
      }
      return finalize(state, {
        ...state,
        acceptedExecutionBase: transition.executionBase,
        activeAttempt: { ...attempt, expectedExecutionBase: transition.executionBase },
      });
    }

    case "execution_base.adopt": {
      requireActive(state);
      return finalize(state, {
        ...state,
        acceptedExecutionBase: transition.executionBase,
        executionBaseMismatch: null,
        executionBaseUnavailable: false,
      });
    }

    case "execution_base.mismatch": {
      requireActive(state);
      if (transition.receipt.programStateId !== state.programStateId) {
        throw new ProgramTransitionError("Mismatch receipt belongs to another ProgramState");
      }
      if (transition.receipt.expectedProgramRevision !== state.revision) {
        throw new ProgramTransitionError("Mismatch receipt historical revision does not match the checked current revision");
      }
      if (!transition.receipt.verificationImpactComplete) {
        throw new ProgramTransitionError("Mismatch receipt cannot become current before verification impact is complete");
      }
      let workItems = state.workItems;
      if (state.activeAttempt !== null) {
        const index = findWorkIndex(state, state.activeAttempt.workItemId);
        const work = state.workItems[index]!;
        if (work.lifecycle === "in_progress") {
          workItems = [...state.workItems];
          workItems[index] = { ...work, lifecycle: "pending" };
        }
      }
      return finalize(state, {
        ...state,
        workItems,
        activeAttempt: null,
        executionBaseMismatch: transition.receipt,
        executionBaseUnavailable: false,
        verification: invalidateVerification(state, transition.invalidateVerificationObligationIds),
      });
    }

    case "execution_base.rebase_accept": {
      requireActive(state);
      const receipt = state.executionBaseMismatch;
      if (receipt === null || String(receipt.receiptId) !== transition.mismatchReceiptId) {
        throw new ProgramTransitionError("Rebase targets a stale or unknown mismatch receipt");
      }
      if (!receipt.verificationImpactComplete) {
        throw new ProgramTransitionError("Rebase cannot overtake verification-impact processing");
      }
      if (
        transition.executionBase.workspaceEffectGeneration !== receipt.currentWorkspaceEffectGeneration ||
        canonicalStringify(transition.executionBase.observation) !== canonicalStringify(receipt.currentObservationIdentity)
      ) {
        throw new ProgramTransitionError("Rebase does not accept the exact mismatch candidate execution base");
      }
      return finalize(state, {
        ...state,
        acceptedExecutionBase: transition.executionBase,
        executionBaseMismatch: null,
        executionBaseUnavailable: false,
      });
    }

    case "execution_base.unavailable": {
      requireActive(state);
      if (state.executionBaseUnavailable && state.activeAttempt === null) return state;
      let workItems = state.workItems;
      if (state.activeAttempt !== null) {
        const index = findWorkIndex(state, state.activeAttempt.workItemId);
        const work = state.workItems[index]!;
        if (work.lifecycle === "in_progress") {
          workItems = [...state.workItems];
          workItems[index] = { ...work, lifecycle: "pending" };
        }
      }
      return finalize(state, {
        ...state,
        workItems,
        activeAttempt: null,
        executionBaseUnavailable: true,
      });
    }

    case "verification.invalidate": {
      requireActive(state);
      if (transition.obligationIds.length === 0) return state;
      return finalize(state, {
        ...state,
        verification: invalidateVerification(state, transition.obligationIds),
      });
    }

    case "verification.satisfy": {
      requireActive(state);
      const index = findVerificationIndex(state, transition.obligationId);
      const obligation = state.verification[index]!;
      if (transition.satisfaction.subjectGeneration !== obligation.subjectGeneration) {
        throw new ProgramTransitionError("Verification satisfaction targets a stale subjectGeneration");
      }
      if (
        obligation.satisfaction !== null &&
        canonicalStringify(obligation.satisfaction) === canonicalStringify(transition.satisfaction)
      ) return state;
      const verification = [...state.verification];
      verification[index] = { ...obligation, satisfaction: transition.satisfaction };
      return finalize(state, { ...state, verification });
    }

    case "verification.waive": {
      requireActive(state);
      const index = findVerificationIndex(state, transition.obligationId);
      const obligation = state.verification[index]!;
      if (transition.waiver.subjectGeneration !== obligation.subjectGeneration) {
        throw new ProgramTransitionError("Verification waiver targets a stale subjectGeneration");
      }
      if (obligation.waiver !== null && canonicalStringify(obligation.waiver) === canonicalStringify(transition.waiver)) {
        return state;
      }
      const verification = [...state.verification];
      verification[index] = { ...obligation, waiver: transition.waiver };
      return finalize(state, { ...state, verification });
    }

    case "evidence.add": {
      requireActive(state);
      const existing = state.decisiveEvidence.find(
        (evidence) => evidence.evidenceRefId === transition.evidence.evidenceRefId,
      );
      if (existing !== undefined) {
        if (canonicalStringify(existing) === canonicalStringify(transition.evidence)) return state;
        throw new ProgramTransitionError(`Evidence ref already exists: ${String(transition.evidence.evidenceRefId)}`);
      }
      return finalize(state, {
        ...state,
        decisiveEvidence: [...state.decisiveEvidence, transition.evidence],
      });
    }

    case "artifact.add": {
      requireActive(state);
      const existing = state.artifacts.find((artifact) => artifact.artifactRef === transition.artifact.artifactRef);
      if (existing !== undefined) {
        if (canonicalStringify(existing) === canonicalStringify(transition.artifact)) return state;
        throw new ProgramTransitionError(`ArtifactRef already retained with different provenance: ${transition.artifact.artifactRef}`);
      }
      return finalize(state, { ...state, artifacts: [...state.artifacts, transition.artifact] });
    }

    case "program.cancel": {
      requireActive(state);
      return finalize(state, { ...state, lifecycle: "cancelled", activeAttempt: null });
    }

    case "program.complete": {
      requireActive(state);
      const oracle = evaluateCompletionOracle(state, transition.oracleFacts);
      if (!oracle.eligible) {
        throw new ProgramTransitionError(`Completion Oracle blocked: ${oracle.blockedBy.join(", ")}`);
      }
      return finalize(state, { ...state, lifecycle: "completed" });
    }

    default: {
      const exhaustive: never = transition;
      throw new ProgramTransitionError(`Unsupported Program transition ${(exhaustive as { kind?: string }).kind ?? "unknown"}`);
    }
  }
}

/** Convenience helper for callers that need exact-current admission checks. */
export function assertExpectedProgramRevision(state: ProgramState, expectedProgramRevision: number): void {
  if (expectedProgramRevision !== state.revision) {
    throw new ProgramRevisionConflictError(expectedProgramRevision, state.revision);
  }
}

/** Current verification is generation-indexed, never inferred from evidence identity. */
export function verificationIsCurrent(state: ProgramState, obligationId: VerificationObligationId): boolean {
  const index = findVerificationIndex(state, obligationId);
  return isVerificationCurrent(state.verification[index]!);
}

/** Narrow error helper for consumers that treat structural invalidity separately. */
export function isProgramSemanticError(error: unknown): boolean {
  return error instanceof ProgramTransitionError ||
    error instanceof ProgramRevisionConflictError ||
    error instanceof ProgramInvariantError;
}
