import { describe, expect, it } from "vitest";
import {
  applyProgramTransition,
  asExecutionBaseMismatchReceiptId,
  asProgramArtifactProductionStepId,
  asProgramAttemptId,
  asProgramEvidenceRefId,
  asProgramOutputSlotId,
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  asVerificationObligationId,
  createProgramState,
  type ProgramAttemptExecutionBase,
  type ProgramCreationInput,
} from "./index.ts";

const programId = asProgramStateId("018f0000-0000-7000-8000-000000000001");
const sourceSession = asSessionId("018f0000-0000-7000-8000-000000000101");
const workA = asProgramWorkItemId("work-a");
const workB = asProgramWorkItemId("work-b");
const verificationA = asVerificationObligationId("verify-a");

function executionBase(generation = 0, stateDigest = "O0"): ProgramAttemptExecutionBase {
  return {
    workspaceEffectGeneration: generation,
    observation: {
      kind: "workspace-observation-v1",
      providerKind: "local-git-v1",
      workspaceIdentity: "workspace-1",
      coverageDigest: "coverage-1",
      stateDigest,
    },
  };
}

function input(): ProgramCreationInput {
  return {
    programStateId: programId,
    objective: "Adversarial ProgramState invariant test",
    sourceSessionId: sourceSession,
    workItems: [
      {
        workItemId: workA,
        creationOrder: 0,
        description: "A",
        dependencyIds: [],
        affectedPaths: ["src/a.ts"],
      },
      {
        workItemId: workB,
        creationOrder: 1,
        description: "B",
        dependencyIds: [workA],
        affectedPaths: ["src/b.ts"],
      },
    ],
    verification: [
      {
        obligationId: verificationA,
        predicate: {
          kind: "workspace_path_state",
          path: "src/a.ts",
          requiredState: "file",
        },
        freshnessScope: { kind: "workspace" },
      },
    ],
    outputSlots: [],
    productionSteps: [],
  };
}

describe("ProgramAttempt admission authority", () => {
  it("cannot issue dependency-blocked work directly through the reducer", () => {
    const program = createProgramState(input());
    expect(() => applyProgramTransition(program, {
      kind: "attempt.issue",
      expectedProgramRevision: program.revision,
      attempt: {
        programAttemptId: asProgramAttemptId("attempt-b"),
        workItemId: workB,
        sessionId: sourceSession,
        agentGeneration: 1,
        initialExecutionBase: executionBase(),
        expectedExecutionBase: executionBase(),
      },
    })).toThrow(/not Program-locally eligible/);
  });

  it("first Attempt atomically establishes the accepted execution base", () => {
    const program = createProgramState(input());
    const base = executionBase();
    const next = applyProgramTransition(program, {
      kind: "attempt.issue",
      expectedProgramRevision: program.revision,
      attempt: {
        programAttemptId: asProgramAttemptId("attempt-a"),
        workItemId: workA,
        sessionId: sourceSession,
        agentGeneration: 1,
        initialExecutionBase: base,
        expectedExecutionBase: base,
      },
    });
    expect(next.acceptedExecutionBase).toEqual(base);
    expect(next.activeAttempt?.expectedExecutionBase).toEqual(base);
    expect(next.revision).toBe(program.revision + 1);
  });
});

describe("execution-base structural authority", () => {
  it("rejects malformed execution bases", () => {
    const program = createProgramState(input());
    expect(() => applyProgramTransition(program, {
      kind: "execution_base.adopt",
      expectedProgramRevision: program.revision,
      executionBase: {
        ...executionBase(),
        workspaceEffectGeneration: -1,
      },
    })).toThrow(/non-negative safe integer/);

    expect(() => applyProgramTransition(program, {
      kind: "execution_base.adopt",
      expectedProgramRevision: program.revision,
      executionBase: {
        workspaceEffectGeneration: 0,
        observation: {
          kind: "other" as "workspace-observation-v1",
          providerKind: "",
          workspaceIdentity: "workspace-1",
          coverageDigest: "coverage-1",
          stateDigest: "O0",
        },
      },
    })).toThrow(/workspace-observation-v1/);
  });

  it("binds mismatch provenance to the exact accepted Program base", () => {
    let program = createProgramState(input());
    const accepted = executionBase(4, "O4");
    program = applyProgramTransition(program, {
      kind: "execution_base.adopt",
      expectedProgramRevision: program.revision,
      executionBase: accepted,
    });

    expect(() => applyProgramTransition(program, {
      kind: "execution_base.mismatch",
      expectedProgramRevision: program.revision,
      receipt: {
        receiptId: asExecutionBaseMismatchReceiptId("bad-receipt"),
        programStateId: program.programStateId,
        expectedProgramRevision: program.revision,
        acceptedWorkspaceEffectGeneration: 3,
        acceptedObservationIdentity: executionBase(3, "O3").observation,
        currentWorkspaceEffectGeneration: 4,
        currentObservationIdentity: executionBase(4, "O5").observation,
        kind: "causal_and_observation_mismatch",
        verificationImpactComplete: true,
      },
      invalidateVerificationObligationIds: [verificationA],
    })).toThrow(/accepted fields do not match/);
  });
});

describe("closed verification predicate semantics", () => {
  it("rejects unsupported workspace_path_state requiredState values", () => {
    const creation = input();
    (creation.verification[0]!.predicate as unknown as { requiredState: string }).requiredState = "socket";
    expect(() => createProgramState(creation)).toThrow(/Unsupported workspace_path_state requiredState/);
  });

  it("artifact_present satisfaction must use retained artifact bound to the exact slot and production step", () => {
    const creation = input();
    const outputSlotId = asProgramOutputSlotId("slot-1");
    const productionStepId = asProgramArtifactProductionStepId("step-1");
    creation.productionSteps = [
      {
        productionStepId,
        producerWorkItemId: workA,
        outputChannel: "artifact",
        specId: "artifact.produce.v1",
        specVersion: 1,
        canonicalArgs: { path: "out.bin" },
        canonicalArgsDigest: "args",
      },
    ];
    creation.outputSlots = [{ outputSlotId, productionStepId }];
    creation.verification = [
      {
        obligationId: verificationA,
        predicate: { kind: "artifact_present", outputSlotId },
        freshnessScope: { kind: "workspace" },
      },
    ];

    let program = createProgramState(creation);
    program = applyProgramTransition(program, {
      kind: "artifact.add",
      expectedProgramRevision: program.revision,
      artifact: {
        artifactRef: "sha256:wrong",
        outputSlotId: null,
        productionStepId: null,
      },
    });
    const wrongEvidence = asProgramEvidenceRefId("wrong-artifact-evidence");
    program = applyProgramTransition(program, {
      kind: "evidence.add",
      expectedProgramRevision: program.revision,
      evidence: {
        evidenceRefId: wrongEvidence,
        workItemId: workA,
        verificationObligationId: verificationA,
        sourceOperationId: null,
        artifactRef: "sha256:wrong",
      },
    });
    expect(() => applyProgramTransition(program, {
      kind: "verification.satisfy",
      expectedProgramRevision: program.revision,
      obligationId: verificationA,
      satisfaction: { subjectGeneration: 1, evidenceRefIds: [wrongEvidence] },
    })).toThrow(/not bound to the required output slot\/production step/);

    program = applyProgramTransition(program, {
      kind: "artifact.add",
      expectedProgramRevision: program.revision,
      artifact: {
        artifactRef: "sha256:right",
        outputSlotId,
        productionStepId,
      },
    });
    const rightEvidence = asProgramEvidenceRefId("right-artifact-evidence");
    program = applyProgramTransition(program, {
      kind: "evidence.add",
      expectedProgramRevision: program.revision,
      evidence: {
        evidenceRefId: rightEvidence,
        workItemId: workA,
        verificationObligationId: verificationA,
        sourceOperationId: null,
        artifactRef: "sha256:right",
      },
    });
    const satisfied = applyProgramTransition(program, {
      kind: "verification.satisfy",
      expectedProgramRevision: program.revision,
      obligationId: verificationA,
      satisfaction: { subjectGeneration: 1, evidenceRefIds: [rightEvidence] },
    });
    expect(satisfied.verification[0]!.satisfaction?.evidenceRefIds).toEqual([rightEvidence]);
  });
});
