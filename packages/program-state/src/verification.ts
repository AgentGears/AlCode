import type {
  ProgramState,
  VerificationImpact,
  VerificationObligation,
  VerificationObligationId,
} from "./types.ts";

/** Current proof exists only for the exact current subjectGeneration. */
export function isVerificationCurrent(obligation: VerificationObligation): boolean {
  return (
    obligation.satisfaction?.subjectGeneration === obligation.subjectGeneration ||
    obligation.waiver?.subjectGeneration === obligation.subjectGeneration
  );
}

/**
 * A relevant or unknown subject change invalidates current proof by advancing
 * the obligation generation. Provably-disjoint impact retains currentness.
 */
export function applyVerificationImpact(
  obligation: VerificationObligation,
  impact: VerificationImpact,
): VerificationObligation {
  if (impact === "disjoint") return obligation;
  return {
    ...obligation,
    subjectGeneration: obligation.subjectGeneration + 1,
    satisfaction: null,
    waiver: null,
  };
}

/**
 * Pure helper for the crash-safe mismatch/effect transition: apply all Host-
 * resolved impacts to one snapshot before the Host admits the resulting state.
 */
export function applyVerificationImpacts(
  state: ProgramState,
  impacts: ReadonlyMap<VerificationObligationId, VerificationImpact>,
): VerificationObligation[] {
  return state.verification.map((obligation) => {
    const impact = impacts.get(obligation.obligationId);
    return impact === undefined ? obligation : applyVerificationImpact(obligation, impact);
  });
}

export function allMandatoryVerificationCurrent(state: ProgramState): boolean {
  return state.verification.every(isVerificationCurrent);
}
