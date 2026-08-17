import { canonicalStringify } from "./canonical.ts";
import { deriveReadyWorkItems } from "./eligibility.ts";
import {
  ProgramRevisionConflictError,
  ProgramTransitionError,
  applyProgramTransition as applyCoreProgramTransition,
  assertExpectedProgramRevision,
  isProgramSemanticError,
  verificationIsCurrent as verificationIsCurrentCore,
  type ProgramTransition,
} from "./reducer-core.ts";
import { assertValidProgramState } from "./validation.ts";
import type {
  ProgramEvidenceReference,
  ProgramState,
  VerificationObligationId,
} from "./types.ts";

export {
  ProgramRevisionConflictError,
  ProgramTransitionError,
  assertExpectedProgramRevision,
  isProgramSemanticError,
};
export type { ProgramTransition };

type GenerationBoundEvidence = ProgramEvidenceReference & {
  subjectGeneration?: number | null;
};

function semanticallyEqual(a: unknown, b: unknown): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}

function normalizeEvidence(
  state: ProgramState,
  evidence: ProgramEvidenceReference,
): ProgramEvidenceReference {
  const candidate = evidence as GenerationBoundEvidence;
  if (candidate.verificationObligationId === null) {
    if (candidate.subjectGeneration !== undefined && candidate.subjectGeneration !== null) {
      throw new ProgramTransitionError("Work-only evidence cannot carry a verification subjectGeneration");
    }
    return { ...evidence, subjectGeneration: null } as ProgramEvidenceReference;
  }

  const obligation = state.verification.find(
    (item) => item.obligationId === candidate.verificationObligationId,
  );
  if (obligation === undefined) {
    throw new ProgramTransitionError(
      `Evidence references unknown verification ${String(candidate.verificationObligationId)}`,
    );
  }
  if (
    candidate.subjectGeneration !== undefined &&
    candidate.subjectGeneration !== null &&
    candidate.subjectGeneration !== obligation.subjectGeneration
  ) {
    throw new ProgramTransitionError(
      `Evidence targets stale verification subjectGeneration ${candidate.subjectGeneration}; current is ${obligation.subjectGeneration}`,
    );
  }

  return {
    ...evidence,
    subjectGeneration: obligation.subjectGeneration,
  } as ProgramEvidenceReference;
}

/**
 * Public Host-admitted Program reducer.
 *
 * The underlying core owns the exhaustive transition mechanics. This boundary
 * closes the authority relations that must be checked before those mechanics
 * can become current Program truth: derived readiness, first-base admission,
 * monotonic execution-base progression, and generation-bound evidence.
 */
export function applyProgramTransition(
  state: ProgramState,
  transition: ProgramTransition,
): ProgramState {
  assertValidProgramState(state);

  let coreState = state;
  let admittedTransition = transition;

  switch (transition.kind) {
    case "attempt.issue": {
      if (!semanticallyEqual(
        transition.attempt.initialExecutionBase,
        transition.attempt.expectedExecutionBase,
      )) {
        throw new ProgramTransitionError(
          "A newly issued ProgramAttempt must start with identical initial and expected execution bases",
        );
      }

      if (state.acceptedExecutionBase === null) {
        // The first dispatch bridge establishes the first accepted execution
        // base in the same semantic revision as Attempt issuance. Supplying it
        // to the pure core as pre-transition context keeps the published result
        // atomic: callers never observe an accepted base without the Attempt.
        coreState = {
          ...state,
          acceptedExecutionBase: transition.attempt.initialExecutionBase,
          executionBaseUnavailable: false,
        };
        assertValidProgramState(coreState);
      } else if (
        !semanticallyEqual(state.acceptedExecutionBase, transition.attempt.initialExecutionBase) ||
        !semanticallyEqual(state.acceptedExecutionBase, transition.attempt.expectedExecutionBase)
      ) {
        throw new ProgramTransitionError(
          "ProgramAttempt issuance must use the exact current accepted execution base",
        );
      } else if (state.executionBaseUnavailable) {
        // A protected complete observation has re-established the exact
        // accepted base. Attempt issuance is the canonical cut that consumes
        // that proof, so stale unavailability cannot survive into an active
        // current Attempt.
        coreState = { ...state, executionBaseUnavailable: false };
        assertValidProgramState(coreState);
      }

      const ready = deriveReadyWorkItems(coreState).some(
        (work) => work.workItemId === transition.attempt.workItemId,
      );
      if (!ready) {
        throw new ProgramTransitionError(
          `Work ${String(transition.attempt.workItemId)} is not Program-locally eligible for Attempt issuance`,
        );
      }
      break;
    }

    case "attempt.execution_base.advance": {
      const attempt = state.activeAttempt;
      if (attempt === null || String(attempt.programAttemptId) !== transition.programAttemptId) {
        // Preserve the core's stale-attempt error wording and authority.
        break;
      }
      const previous = attempt.expectedExecutionBase;
      const next = transition.executionBase;
      if (next.workspaceEffectGeneration < previous.workspaceEffectGeneration) {
        throw new ProgramTransitionError(
          "Execution-base advance cannot roll WorkspaceEffectGeneration backward",
        );
      }
      if (
        next.workspaceEffectGeneration === previous.workspaceEffectGeneration &&
        !semanticallyEqual(next, previous)
      ) {
        throw new ProgramTransitionError(
          "A same-generation execution-base observation change requires mismatch/rebase handling",
        );
      }
      break;
    }

    case "evidence.add": {
      admittedTransition = {
        ...transition,
        evidence: normalizeEvidence(state, transition.evidence),
      };
      break;
    }

    default:
      break;
  }

  const next = applyCoreProgramTransition(coreState, admittedTransition);
  assertValidProgramState(next);
  return next;
}

/** Currentness queries reject structurally invalid Program truth first. */
export function verificationIsCurrent(
  state: ProgramState,
  obligationId: VerificationObligationId,
): boolean {
  assertValidProgramState(state);
  return verificationIsCurrentCore(state, obligationId);
}
