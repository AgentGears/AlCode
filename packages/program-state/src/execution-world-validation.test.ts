import { describe, expect, it } from "vitest";
import {
  applyProgramTransition,
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  assertValidProgramState,
  createProgramState,
  programStateIsValid,
  type ProgramAttemptExecutionBase,
} from "./index.ts";

function executionBase(): ProgramAttemptExecutionBase {
  return {
    workspaceEffectGeneration: 0,
    observation: {
      kind: "workspace-observation-v1",
      providerKind: "isolated-test",
      workspaceIdentity: "workspace-a5",
      coverageDigest: "coverage-a5",
      stateDigest: "state-a5",
      executionWorld: {
        workspaceId: "workspace-a5",
        providerKind: "isolated-test",
        executionWorldGenerationId: "generation-a5",
        providerDescriptorDigest: "provider-digest-a5",
        effectivePolicyDigest: "policy-digest-a5",
      },
    },
  };
}

function stateWithBase() {
  const created = createProgramState({
    programStateId: asProgramStateId("018f3f7e-7b5a-7cc1-8f6a-123456789abc"),
    sourceSessionId: asSessionId("session-a5"),
    objective: "Validate A5 execution-world observation coherence",
    workItems: [{
      workItemId: asProgramWorkItemId("work-a5"),
      creationOrder: 0,
      description: "Validate the physical-world reference",
      dependencyIds: [],
      affectedPaths: ["src/a5.ts"],
    }],
    verification: [],
    outputSlots: [],
    productionSteps: [],
  });
  return applyProgramTransition(created, {
    kind: "execution_base.adopt",
    expectedProgramRevision: created.revision,
    executionBase: executionBase(),
  });
}

describe("A5 ProgramState execution-world observation validation", () => {
  it("accepts a coherent generation-bound observation", () => {
    const state = stateWithBase();
    expect(() => assertValidProgramState(state)).not.toThrow();
    expect(programStateIsValid(state)).toBe(true);
  });

  it("rejects a generation reference for another Workspace", () => {
    const state = structuredClone(stateWithBase());
    state.acceptedExecutionBase!.observation.executionWorld!.workspaceId = "workspace-other";
    expect(() => assertValidProgramState(state)).toThrow(/Workspace does not match observation Workspace identity/);
    expect(programStateIsValid(state)).toBe(false);
  });

  it("rejects a generation reference for another provider", () => {
    const state = structuredClone(stateWithBase());
    state.acceptedExecutionBase!.observation.executionWorld!.providerKind = "other-provider";
    expect(() => assertValidProgramState(state)).toThrow(/provider does not match observation provider/);
  });

  it("keeps legacy pre-A5 observations valid when no execution-world reference exists", () => {
    const state = structuredClone(stateWithBase());
    delete state.acceptedExecutionBase!.observation.executionWorld;
    expect(() => assertValidProgramState(state)).not.toThrow();
  });
});
