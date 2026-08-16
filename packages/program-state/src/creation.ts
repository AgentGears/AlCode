import { assertCanonical } from "@alcode/events";
import { assertValidProgramState } from "./validation.ts";
import type {
  ProgramCreationInput,
  ProgramState,
  ProgramWorkItem,
  VerificationObligation,
} from "./types.ts";

/**
 * Build the immutable Phase 1.0 Program contract and its initial mutable state.
 * Program creation itself is admitted atomically by the Host; this pure helper
 * only constructs and validates the semantic result of that admitted cut.
 */
export function createProgramState(input: ProgramCreationInput): ProgramState {
  assertCanonical(input.creationPolicyRequirements ?? []);

  const workItems: ProgramWorkItem[] = input.workItems.map((work) => ({
    ...work,
    dependencyIds: [...work.dependencyIds],
    affectedPaths: [...work.affectedPaths],
    lifecycle: "pending",
  }));

  const verification: VerificationObligation[] = input.verification.map((definition) => ({
    ...definition,
    freshnessScope:
      definition.freshnessScope.kind === "workspace"
        ? { kind: "workspace" }
        : {
            kind: "paths",
            entries: definition.freshnessScope.entries.map((entry) => ({ ...entry })),
          },
    subjectGeneration: 1,
    satisfaction: null,
    waiver: null,
  }));

  const state: ProgramState = {
    programStateId: input.programStateId,
    objective: input.objective,
    lifecycle: "active",
    revision: 1,
    workItems,
    blockers: [],
    verification,
    outputSlots: input.outputSlots.map((slot) => ({ ...slot })),
    productionSteps: input.productionSteps.map((step) => ({ ...step })),
    decisiveEvidence: [],
    artifacts: [],
    attachedSessionIds: [input.sourceSessionId],
    activeAttempt: null,
    acceptedExecutionBase: null,
    executionBaseMismatch: null,
    executionBaseUnavailable: false,
    creationPolicyRequirements: [...(input.creationPolicyRequirements ?? [])],
  };

  assertValidProgramState(state);
  return state;
}
