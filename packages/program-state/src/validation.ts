import { canonicalStringify } from "./canonical.ts";
import {
  ProgramInvariantError,
  type ProgramInvariantCode,
  assertNormalizedWorkspacePath,
  freshnessScopeCoversPath,
  utf8Bytes,
  assertValidProgramState as assertCoreValidProgramState,
} from "./validation-core.ts";
import type { ProgramEvidenceReference, ProgramState } from "./types.ts";

export {
  ProgramInvariantError,
  type ProgramInvariantCode,
  assertNormalizedWorkspacePath,
  freshnessScopeCoversPath,
  utf8Bytes,
};

type GenerationBoundEvidence = ProgramEvidenceReference & {
  subjectGeneration?: number | null;
};

function fail(code: ProgramInvariantCode, message: string): never {
  throw new ProgramInvariantError(code, message);
}

function basesEqual(a: unknown, b: unknown): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}

function requirePositiveGeneration(label: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("invalid_value", `${label} must be a positive safe integer`);
  }
  return value as number;
}

/**
 * Validate the core bounded/rebuildable shape plus the authority relations that
 * make current Program truth safe to use for dispatch and verification.
 */
export function assertValidProgramState(state: ProgramState): void {
  assertCoreValidProgramState(state);

  for (const blocker of state.blockers) {
    if (blocker.state !== "open" && blocker.state !== "resolved") {
      fail(
        "invalid_value",
        `Unsupported blocker state for ${String(blocker.blockerId)}: ${String(blocker.state)}`,
      );
    }
  }

  const verificationById = new Map(
    state.verification.map((obligation) => [String(obligation.obligationId), obligation]),
  );
  const evidenceById = new Map(
    state.decisiveEvidence.map((evidence) => [String(evidence.evidenceRefId), evidence as GenerationBoundEvidence]),
  );

  for (const rawEvidence of state.decisiveEvidence) {
    const evidence = rawEvidence as GenerationBoundEvidence;
    if (evidence.verificationObligationId === null) {
      if (evidence.subjectGeneration !== null) {
        fail(
          "structural_invariant",
          `work-only evidence ${String(evidence.evidenceRefId)} must carry subjectGeneration: null`,
        );
      }
      continue;
    }

    const obligation = verificationById.get(String(evidence.verificationObligationId));
    if (obligation === undefined) {
      // The core validator reports the precise unknown-reference error first;
      // keep this branch defensive if the core contract changes later.
      fail(
        "unknown_reference",
        `evidence ${String(evidence.evidenceRefId)} references unknown verification ${String(evidence.verificationObligationId)}`,
      );
    }
    const evidenceGeneration = requirePositiveGeneration(
      `evidence ${String(evidence.evidenceRefId)} subjectGeneration`,
      evidence.subjectGeneration,
    );
    if (evidenceGeneration > obligation.subjectGeneration) {
      fail(
        "structural_invariant",
        `evidence ${String(evidence.evidenceRefId)} generation ${evidenceGeneration} is ahead of verification ${String(obligation.obligationId)} generation ${obligation.subjectGeneration}`,
      );
    }
  }

  for (const obligation of state.verification) {
    const satisfaction = obligation.satisfaction;
    if (satisfaction === null) continue;
    for (const evidenceRefId of satisfaction.evidenceRefIds) {
      const evidence = evidenceById.get(String(evidenceRefId));
      if (evidence === undefined) continue; // core validator reports this first
      if (evidence.subjectGeneration !== satisfaction.subjectGeneration) {
        fail(
          "structural_invariant",
          `verification ${String(obligation.obligationId)} satisfaction generation ${satisfaction.subjectGeneration} cannot use evidence ${String(evidenceRefId)} from generation ${String(evidence.subjectGeneration)}`,
        );
      }
    }
  }

  if (state.activeAttempt !== null) {
    if (state.acceptedExecutionBase === null) {
      fail("structural_invariant", "An active ProgramAttempt requires an accepted execution base");
    }
    if (!basesEqual(state.activeAttempt.expectedExecutionBase, state.acceptedExecutionBase)) {
      fail(
        "structural_invariant",
        "The active ProgramAttempt expected execution base must equal Program acceptedExecutionBase",
      );
    }
    if (
      state.activeAttempt.initialExecutionBase.workspaceEffectGeneration >
      state.activeAttempt.expectedExecutionBase.workspaceEffectGeneration
    ) {
      fail(
        "structural_invariant",
        "ProgramAttempt execution-base generation cannot precede its initial generation",
      );
    }
  }
}

export function programStateIsValid(state: ProgramState): boolean {
  try {
    assertValidProgramState(state);
    return true;
  } catch {
    return false;
  }
}
