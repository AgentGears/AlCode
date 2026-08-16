import { describe, expect, it } from "vitest";
import {
  applyProgramTransition,
  asProgramAttemptId,
  asProgramBlockerId,
  asProgramEvidenceRefId,
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  asVerificationObligationId,
  createProgramState,
  type ProgramAttemptExecutionBase,
  type ProgramCreationInput,
} from "./index.ts";

const programId = asProgramStateId("018f0000-0000-7000-8000-000000000201");
const sessionId = asSessionId("018f0000-0000-7000-8000-000000000202");
const workId = asProgramWorkItemId("work-authority");
const verificationId = asVerificationObligationId("verify-authority");

function base(generation: number, stateDigest: string): ProgramAttemptExecutionBase {
  return {
    workspaceEffectGeneration: generation,
    observation: {
      kind: "workspace-observation-v1",
      providerKind: "local-git-v1",
      workspaceIdentity: "workspace-authority",
      coverageDigest: "coverage-authority",
      stateDigest,
    },
  };
}

function input(): ProgramCreationInput {
  return {
    programStateId: programId,
    objective: "Prove bounded ProgramState authority corrections",
    sourceSessionId: sessionId,
    workItems: [
      {
        workItemId: workId,
        creationOrder: 0,
        description: "Authority work",
        dependencyIds: [],
        affectedPaths: ["src/authority.ts"],
      },
    ],
    verification: [
      {
        obligationId: verificationId,
        predicate: {
          kind: "workspace_path_state",
          path: "src/authority.ts",
          requiredState: "file",
        },
        freshnessScope: { kind: "workspace" },
      },
    ],
    outputSlots: [],
    productionSteps: [],
  };
}

describe("bounded ProgramState authority corrections", () => {
  it("stamps decisive evidence with the current generation and prevents stale reuse", () => {
    let program = createProgramState(input());
    const evidenceRefId = asProgramEvidenceRefId("evidence-generation-1");
    program = applyProgramTransition(program, {
      kind: "evidence.add",
      expectedProgramRevision: program.revision,
      evidence: {
        evidenceRefId,
        workItemId: workId,
        verificationObligationId: verificationId,
        sourceOperationId: null,
        artifactRef: null,
      },
    });
    expect(program.decisiveEvidence[0]!.subjectGeneration).toBe(1);

    program = applyProgramTransition(program, {
      kind: "verification.invalidate",
      expectedProgramRevision: program.revision,
      obligationIds: [verificationId],
    });
    expect(program.verification[0]!.subjectGeneration).toBe(2);

    expect(() => applyProgramTransition(program, {
      kind: "verification.satisfy",
      expectedProgramRevision: program.revision,
      obligationId: verificationId,
      satisfaction: { subjectGeneration: 2, evidenceRefIds: [evidenceRefId] },
    })).toThrow(/cannot use evidence .* generation 1/);
  });

  it("rejects malformed blocker states before they can bypass readiness/completion", () => {
    const program = createProgramState(input());
    expect(() => applyProgramTransition(program, {
      kind: "blocker.add",
      expectedProgramRevision: program.revision,
      blocker: {
        blockerId: asProgramBlockerId("bad-blocker"),
        workItemId: workId,
        reason: "Malformed state must fail closed",
        state: "resolvd" as "open",
      },
    })).toThrow(/Unsupported blocker state/);
  });

  it("does not allow an active Attempt execution base to roll backward or rewrite observation at one generation", () => {
    let program = createProgramState(input());
    const initial = base(2, "O2");
    program = applyProgramTransition(program, {
      kind: "attempt.issue",
      expectedProgramRevision: program.revision,
      attempt: {
        programAttemptId: asProgramAttemptId("attempt-authority"),
        workItemId: workId,
        sessionId,
        agentGeneration: 1,
        initialExecutionBase: initial,
        expectedExecutionBase: initial,
      },
    });

    expect(() => applyProgramTransition(program, {
      kind: "attempt.execution_base.advance",
      expectedProgramRevision: program.revision,
      programAttemptId: "attempt-authority",
      executionBase: base(1, "O1"),
    })).toThrow(/cannot roll WorkspaceEffectGeneration backward/);

    expect(() => applyProgramTransition(program, {
      kind: "attempt.execution_base.advance",
      expectedProgramRevision: program.revision,
      programAttemptId: "attempt-authority",
      executionBase: base(2, "O2-different"),
    })).toThrow(/requires mismatch\/rebase handling/);
  });
});
