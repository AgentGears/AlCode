import { describe, expect, it } from "vitest";
import {
  PROGRAM_LIMITS,
  ProgramInvariantError,
  ProgramRevisionConflictError,
  ProgramTransitionError,
  applyProgramTransition,
  asExecutionBaseMismatchReceiptId,
  asProgramAttemptId,
  asProgramArtifactProductionStepId,
  asProgramBlockerId,
  asProgramEvidenceRefId,
  asProgramOutputSlotId,
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  asVerificationObligationId,
  assertNormalizedWorkspacePath,
  createProgramState,
  deriveReadyWorkItems,
  evaluateCompletionOracle,
  freshnessScopeCoversPath,
  isVerificationCurrent,
  selectNextEligibleWork,
  type ProgramAttemptExecutionBase,
  type ProgramCreationInput,
  type ProgramState,
  type VerificationObligationId,
} from "./index.ts";

const workA = asProgramWorkItemId("work-a");
const workB = asProgramWorkItemId("work-b");
const verificationA = asVerificationObligationId("verify-a");
const verificationB = asVerificationObligationId("verify-b");
const programId = asProgramStateId("018f0000-0000-7000-8000-000000000001");
const sourceSession = asSessionId("018f0000-0000-7000-8000-000000000101");

function session(index: number) {
  return asSessionId(`018f0000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`);
}

function baseExecutionBase(generation = 1, stateDigest = "state-1"): ProgramAttemptExecutionBase {
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

function creationInput(): ProgramCreationInput {
  return {
    programStateId: programId,
    objective: "Implement a durable ProgramState kernel",
    sourceSessionId: sourceSession,
    workItems: [
      {
        workItemId: workA,
        creationOrder: 0,
        description: "Implement A",
        dependencyIds: [],
        affectedPaths: ["src/a.ts"],
      },
      {
        workItemId: workB,
        creationOrder: 1,
        description: "Implement B",
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
        freshnessScope: {
          kind: "paths",
          entries: [{ path: "src", mode: "subtree" }],
        },
      },
      {
        obligationId: verificationB,
        predicate: {
          kind: "operation_result",
          specId: "test.command.v1",
          specVersion: 1,
          canonicalArgs: { command: "pnpm test" },
          canonicalArgsDigest: "args-digest",
        },
        freshnessScope: { kind: "workspace" },
      },
    ],
    outputSlots: [],
    productionSteps: [],
    creationPolicyRequirements: [{ kind: "policy", id: "required-test" }],
  };
}

function state(): ProgramState {
  return createProgramState(creationInput());
}

function addEvidence(
  program: ProgramState,
  obligationId: VerificationObligationId,
  value: string,
): { program: ProgramState; evidenceRefId: ReturnType<typeof asProgramEvidenceRefId> } {
  const evidenceRefId = asProgramEvidenceRefId(value);
  return {
    evidenceRefId,
    program: applyProgramTransition(program, {
      kind: "evidence.add",
      expectedProgramRevision: program.revision,
      evidence: {
        evidenceRefId,
        workItemId: null,
        verificationObligationId: obligationId,
        sourceOperationId: null,
        artifactRef: null,
      },
    }),
  };
}

const allSchedulerFacts = {
  hasActiveAttachedExecutionEpisode: true,
  workspaceReservationAvailable: true,
  recoveryClear: true,
  writerBarriersClear: true,
};

const allCompletionFacts = {
  executionBaseCurrent: true,
  noOutstandingProgramOperations: true,
  noIndeterminateEffectsOrReconciliation: true,
  noOutstandingWriterBarrier: true,
  noRetryableDurableWork: true,
  artifactIntegrityCurrent: true,
};

describe("Program creation and structural validation", () => {
  it("creates revision 1 with immutable definitions and generation-1 verification", () => {
    const program = state();
    expect(program.revision).toBe(1);
    expect(program.lifecycle).toBe("active");
    expect(program.workItems.map((work) => work.lifecycle)).toEqual(["pending", "pending"]);
    expect(program.verification.map((obligation) => obligation.subjectGeneration)).toEqual([1, 1]);
    expect(program.attachedSessionIds).toHaveLength(1);
    expect(program.activeAttempt).toBeNull();
    expect(program.executionBaseMismatch).toBeNull();
  });

  it("rejects unknown, self, duplicate, and cyclic dependencies deterministically", () => {
    const unknown = creationInput();
    unknown.workItems[1]!.dependencyIds = [asProgramWorkItemId("missing")];
    expect(() => createProgramState(unknown)).toThrow(/unknown dependency/);

    const self = creationInput();
    self.workItems[0]!.dependencyIds = [workA];
    expect(() => createProgramState(self)).toThrow(/depends on itself/);

    const duplicate = creationInput();
    duplicate.workItems[1]!.dependencyIds = [workA, workA];
    expect(() => createProgramState(duplicate)).toThrow(/repeats dependency/);

    const cycle = creationInput();
    cycle.workItems[0]!.dependencyIds = [workB];
    expect(() => createProgramState(cycle)).toThrow(/cycle/);
  });

  it("uses segment-boundary exact/subtree path semantics", () => {
    const subtree = { kind: "paths" as const, entries: [{ path: "src/a", mode: "subtree" as const }] };
    expect(freshnessScopeCoversPath(subtree, "src/a")).toBe(true);
    expect(freshnessScopeCoversPath(subtree, "src/a/file.ts")).toBe(true);
    expect(freshnessScopeCoversPath(subtree, "src/ab/file.ts")).toBe(false);
    expect(() => assertNormalizedWorkspacePath("src/../secret")).toThrow(ProgramInvariantError);
    expect(() => assertNormalizedWorkspacePath("/absolute")).toThrow(ProgramInvariantError);
  });

  it("counts path occurrences across canonical collections rather than globally deduplicating", () => {
    const input = creationInput();
    input.workItems = Array.from({ length: 128 }, (_, workIndex) => ({
      workItemId: asProgramWorkItemId(`work-${workIndex}`),
      creationOrder: workIndex,
      description: `Work ${workIndex}`,
      dependencyIds: [],
      affectedPaths: Array.from({ length: 32 }, (_, pathIndex) => `p/${workIndex}/${pathIndex}`),
    }));
    input.verification = [];
    expect(input.workItems.reduce((sum, work) => sum + work.affectedPaths.length, 0)).toBe(
      PROGRAM_LIMITS.totalPathBearingEntries,
    );
    expect(() => createProgramState(input)).not.toThrow();

    input.verification = [
      {
        obligationId: verificationA,
        predicate: { kind: "workspace_path_state", path: "p/0/0", requiredState: "file" },
        freshnessScope: { kind: "paths", entries: [{ path: "p/0/0", mode: "exact" }] },
      },
    ];
    expect(() => createProgramState(input)).toThrow(/total path-bearing entries exceeds/);
  });

  it("rejects operation predicate canonical arguments above the frozen local ceiling", () => {
    const input = creationInput();
    input.verification[1]!.predicate = {
      kind: "operation_result",
      specId: "test.command.v1",
      specVersion: 1,
      canonicalArgs: { value: "x".repeat(PROGRAM_LIMITS.verificationCanonicalArgsBytes) },
      canonicalArgsDigest: "digest",
    };
    expect(() => createProgramState(input)).toThrow(/canonical arguments exceed/);
  });

  it("rejects a runtime predicate discriminant outside the closed v1 taxonomy", () => {
    const input = creationInput();
    (input.verification[0] as unknown as { predicate: unknown }).predicate = { kind: "model_judgment" };
    expect(() => createProgramState(input)).toThrow(/Unsupported VerificationPredicateV1 kind/);
  });

  it("binds artifact predicates through an existing output slot and production step", () => {
    const input = creationInput();
    const outputSlotId = asProgramOutputSlotId("output-1");
    const productionStepId = asProgramArtifactProductionStepId("produce-1");
    input.productionSteps = [
      {
        productionStepId,
        producerWorkItemId: workA,
        outputChannel: "stdout-artifact",
        specId: "artifact.produce.v1",
        specVersion: 1,
        canonicalArgs: { path: "dist/out.bin" },
        canonicalArgsDigest: "artifact-args",
      },
    ];
    input.outputSlots = [{ outputSlotId, productionStepId }];
    input.verification = [
      {
        obligationId: verificationA,
        predicate: { kind: "artifact_present", outputSlotId },
        freshnessScope: { kind: "workspace" },
      },
    ];
    expect(() => createProgramState(input)).not.toThrow();

    input.verification[0]!.predicate = {
      kind: "artifact_present",
      outputSlotId: asProgramOutputSlotId("missing-output"),
    };
    expect(() => createProgramState(input)).toThrow(/unknown output slot/);
  });
});

describe("derived eligibility", () => {
  it("selects deterministic pending work only after dependencies and barriers permit it", () => {
    let program = state();
    expect(deriveReadyWorkItems(program).map((work) => work.workItemId)).toEqual([workA]);
    expect(selectNextEligibleWork(program, allSchedulerFacts)?.workItemId).toBe(workA);
    expect(
      selectNextEligibleWork(program, { ...allSchedulerFacts, workspaceReservationAvailable: false }),
    ).toBeNull();

    program = applyProgramTransition(program, {
      kind: "work.lifecycle.set",
      expectedProgramRevision: program.revision,
      workItemId: workA,
      lifecycle: "completed",
    });
    expect(selectNextEligibleWork(program, allSchedulerFacts)?.workItemId).toBe(workB);
  });

  it("uses stable id as the secondary selection key", () => {
    const input = creationInput();
    input.workItems = [
      { workItemId: asProgramWorkItemId("work-z"), creationOrder: 0, description: "Z", dependencyIds: [], affectedPaths: [] },
      { workItemId: asProgramWorkItemId("work-a"), creationOrder: 0, description: "A", dependencyIds: [], affectedPaths: [] },
    ];
    input.verification = [];
    const program = createProgramState(input);
    expect(selectNextEligibleWork(program, allSchedulerFacts)?.workItemId).toBe("work-a");
  });
});

describe("revision algebra and atomic semantic transitions", () => {
  it("advances revision once for an effective transition and not for an exact semantic no-op", () => {
    let program = state();
    const attached = session(102);
    program = applyProgramTransition(program, {
      kind: "session.attach",
      expectedProgramRevision: 1,
      sessionId: attached,
    });
    expect(program.revision).toBe(2);

    const same = applyProgramTransition(program, {
      kind: "session.attach",
      expectedProgramRevision: 2,
      sessionId: attached,
    });
    expect(same).toBe(program);
    expect(same.revision).toBe(2);
  });

  it("rejects both lower and higher expected Program revisions", () => {
    const program = state();
    expect(() => applyProgramTransition(program, {
      kind: "session.attach",
      expectedProgramRevision: 0,
      sessionId: session(103),
    })).toThrow(ProgramRevisionConflictError);
    expect(() => applyProgramTransition(program, {
      kind: "session.attach",
      expectedProgramRevision: 2,
      sessionId: session(104),
    })).toThrow(ProgramRevisionConflictError);
  });

  it("issues a fresh Attempt and changes work + Attempt truth in one revision", () => {
    const program = state();
    const executionBase = baseExecutionBase();
    const attempt = {
      programAttemptId: asProgramAttemptId("attempt-1"),
      workItemId: workA,
      sessionId: program.attachedSessionIds[0]!,
      agentGeneration: 1,
      initialExecutionBase: executionBase,
      expectedExecutionBase: executionBase,
    };
    const next = applyProgramTransition(program, {
      kind: "attempt.issue",
      expectedProgramRevision: 1,
      attempt,
    });
    expect(next.revision).toBe(2);
    expect(next.activeAttempt?.programAttemptId).toBe("attempt-1");
    expect(next.workItems[0]!.lifecycle).toBe("in_progress");
  });

  it("records mismatch + interrupts Attempt + invalidates multiple verification generations in one revision", () => {
    let program = state();
    const accepted = baseExecutionBase(4, "O4");
    program = applyProgramTransition(program, {
      kind: "execution_base.adopt",
      expectedProgramRevision: program.revision,
      executionBase: accepted,
    });
    const checkedRevision = program.revision;

    program = applyProgramTransition(program, {
      kind: "attempt.issue",
      expectedProgramRevision: program.revision,
      attempt: {
        programAttemptId: asProgramAttemptId("attempt-A"),
        workItemId: workA,
        sessionId: program.attachedSessionIds[0]!,
        agentGeneration: 1,
        initialExecutionBase: accepted,
        expectedExecutionBase: accepted,
      },
    });
    const mismatchRevision = program.revision;
    const current = baseExecutionBase(4, "O5");
    const receipt = {
      receiptId: asExecutionBaseMismatchReceiptId("mismatch-1"),
      programStateId: program.programStateId,
      expectedProgramRevision: mismatchRevision,
      acceptedWorkspaceEffectGeneration: accepted.workspaceEffectGeneration,
      acceptedObservationIdentity: accepted.observation,
      currentWorkspaceEffectGeneration: current.workspaceEffectGeneration,
      currentObservationIdentity: current.observation,
      kind: "observation_mismatch" as const,
      verificationImpactComplete: true,
    };

    const next = applyProgramTransition(program, {
      kind: "execution_base.mismatch",
      expectedProgramRevision: mismatchRevision,
      receipt,
      invalidateVerificationObligationIds: [verificationA, verificationB],
    });
    expect(checkedRevision).toBe(2);
    expect(next.revision).toBe(mismatchRevision + 1);
    expect(next.activeAttempt).toBeNull();
    expect(next.workItems[0]!.lifecycle).toBe("pending");
    expect(next.verification.map((obligation) => obligation.subjectGeneration)).toEqual([2, 2]);
    expect(next.executionBaseMismatch?.expectedProgramRevision).toBe(mismatchRevision);
  });

  it("requires explicit exact-candidate rebase while a mismatch receipt is current", () => {
    let program = state();
    const accepted = baseExecutionBase(4, "O4");
    program = applyProgramTransition(program, {
      kind: "execution_base.adopt",
      expectedProgramRevision: program.revision,
      executionBase: accepted,
    });
    const current = baseExecutionBase(4, "O5");
    program = applyProgramTransition(program, {
      kind: "execution_base.mismatch",
      expectedProgramRevision: program.revision,
      receipt: {
        receiptId: asExecutionBaseMismatchReceiptId("mismatch-explicit"),
        programStateId: program.programStateId,
        expectedProgramRevision: program.revision,
        acceptedWorkspaceEffectGeneration: 4,
        acceptedObservationIdentity: accepted.observation,
        currentWorkspaceEffectGeneration: 4,
        currentObservationIdentity: current.observation,
        kind: "observation_mismatch",
        verificationImpactComplete: true,
      },
      invalidateVerificationObligationIds: [verificationA],
    });

    expect(() => applyProgramTransition(program, {
      kind: "execution_base.adopt",
      expectedProgramRevision: program.revision,
      executionBase: current,
    })).toThrow(/requires explicit rebase/);

    const rebased = applyProgramTransition(program, {
      kind: "execution_base.rebase_accept",
      expectedProgramRevision: program.revision,
      mismatchReceiptId: "mismatch-explicit",
      executionBase: current,
    });
    expect(rebased.executionBaseMismatch).toBeNull();
    expect(rebased.acceptedExecutionBase).toEqual(current);
  });

  it("does not let rebase overtake verification-impact processing", () => {
    let program = state();
    const accepted = baseExecutionBase(4, "O4");
    program = applyProgramTransition(program, {
      kind: "execution_base.adopt",
      expectedProgramRevision: program.revision,
      executionBase: accepted,
    });
    const current = baseExecutionBase(4, "O5");
    const receipt = {
      receiptId: asExecutionBaseMismatchReceiptId("mismatch-incomplete"),
      programStateId: program.programStateId,
      expectedProgramRevision: program.revision,
      acceptedWorkspaceEffectGeneration: 4,
      acceptedObservationIdentity: accepted.observation,
      currentWorkspaceEffectGeneration: 4,
      currentObservationIdentity: current.observation,
      kind: "observation_mismatch" as const,
      verificationImpactComplete: false,
    };
    expect(() => applyProgramTransition(program, {
      kind: "execution_base.mismatch",
      expectedProgramRevision: program.revision,
      receipt,
      invalidateVerificationObligationIds: [],
    })).toThrow(/impact is complete/);
  });
});

describe("generation-indexed verification and terminal oracle", () => {
  it("requires decisive evidence bound to the exact obligation before satisfaction is current", () => {
    let program = state();
    expect(() => applyProgramTransition(program, {
      kind: "verification.satisfy",
      expectedProgramRevision: program.revision,
      obligationId: verificationA,
      satisfaction: { subjectGeneration: 1, evidenceRefIds: [] },
    })).toThrow(/requires decisive evidence/);

    const wrong = addEvidence(program, verificationB, "wrong-evidence");
    program = wrong.program;
    expect(() => applyProgramTransition(program, {
      kind: "verification.satisfy",
      expectedProgramRevision: program.revision,
      obligationId: verificationA,
      satisfaction: { subjectGeneration: 1, evidenceRefIds: [wrong.evidenceRefId] },
    })).toThrow(/not bound to verification/);
  });

  it("invalidates satisfaction and waiver when subjectGeneration advances", () => {
    let program = state();
    const evidence = addEvidence(program, verificationA, "evidence-generation-1");
    program = evidence.program;
    program = applyProgramTransition(program, {
      kind: "verification.satisfy",
      expectedProgramRevision: program.revision,
      obligationId: verificationA,
      satisfaction: { subjectGeneration: 1, evidenceRefIds: [evidence.evidenceRefId] },
    });
    program = applyProgramTransition(program, {
      kind: "verification.waive",
      expectedProgramRevision: program.revision,
      obligationId: verificationB,
      waiver: { subjectGeneration: 1, actor: "user", source: "application", reason: "accepted" },
    });
    expect(program.verification.every(isVerificationCurrent)).toBe(true);

    program = applyProgramTransition(program, {
      kind: "verification.invalidate",
      expectedProgramRevision: program.revision,
      obligationIds: [verificationA, verificationB],
    });
    expect(program.verification.map((obligation) => obligation.subjectGeneration)).toEqual([2, 2]);
    expect(program.verification.every((obligation) => !isVerificationCurrent(obligation))).toBe(true);
  });

  it("never treats retained artifact identity as verification authority", () => {
    let program = state();
    program = applyProgramTransition(program, {
      kind: "artifact.add",
      expectedProgramRevision: program.revision,
      artifact: { artifactRef: "sha256:abc", outputSlotId: null, productionStepId: null },
    });
    expect(program.verification.every((obligation) => !isVerificationCurrent(obligation))).toBe(true);
  });

  it("blocks completion until work, verification, Program control, and Host facts all permit it", () => {
    let program = state();
    expect(evaluateCompletionOracle(program, allCompletionFacts)).toMatchObject({ eligible: false });

    for (const workItemId of [workA, workB]) {
      program = applyProgramTransition(program, {
        kind: "work.lifecycle.set",
        expectedProgramRevision: program.revision,
        workItemId,
        lifecycle: "completed",
      });
    }
    const evidence = addEvidence(program, verificationA, "completion-evidence");
    program = evidence.program;
    program = applyProgramTransition(program, {
      kind: "verification.satisfy",
      expectedProgramRevision: program.revision,
      obligationId: verificationA,
      satisfaction: { subjectGeneration: 1, evidenceRefIds: [evidence.evidenceRefId] },
    });
    program = applyProgramTransition(program, {
      kind: "verification.waive",
      expectedProgramRevision: program.revision,
      obligationId: verificationB,
      waiver: { subjectGeneration: 1, actor: "user", source: "application", reason: "approved" },
    });

    expect(evaluateCompletionOracle(program, allCompletionFacts)).toEqual({ eligible: true, blockedBy: [] });
    expect(evaluateCompletionOracle(program, { ...allCompletionFacts, noOutstandingWriterBarrier: false }))
      .toMatchObject({ eligible: false, blockedBy: ["outstanding_writer_barrier"] });

    const completed = applyProgramTransition(program, {
      kind: "program.complete",
      expectedProgramRevision: program.revision,
      oracleFacts: allCompletionFacts,
    });
    expect(completed.lifecycle).toBe("completed");
    expect(completed.revision).toBe(program.revision + 1);
    expect(() => applyProgramTransition(completed, {
      kind: "program.cancel",
      expectedProgramRevision: completed.revision,
    })).toThrow(ProgramTransitionError);
  });

  it("cancellation is terminal authority cutoff rather than rollback", () => {
    let program = state();
    program = applyProgramTransition(program, {
      kind: "attempt.issue",
      expectedProgramRevision: program.revision,
      attempt: {
        programAttemptId: asProgramAttemptId("attempt-cancel"),
        workItemId: workA,
        sessionId: program.attachedSessionIds[0]!,
        agentGeneration: 1,
        initialExecutionBase: baseExecutionBase(),
        expectedExecutionBase: baseExecutionBase(),
      },
    });
    const cancelled = applyProgramTransition(program, {
      kind: "program.cancel",
      expectedProgramRevision: program.revision,
    });
    expect(cancelled.lifecycle).toBe("cancelled");
    expect(cancelled.activeAttempt).toBeNull();
    expect(cancelled.workItems[0]!.lifecycle).toBe("in_progress");
  });
});

describe("evidence and blockers", () => {
  it("enforces stable evidence identity and blocker references", () => {
    let program = state();
    program = applyProgramTransition(program, {
      kind: "blocker.add",
      expectedProgramRevision: program.revision,
      blocker: {
        blockerId: asProgramBlockerId("blocker-1"),
        workItemId: workA,
        reason: "Need an input",
        state: "open",
      },
    });
    expect(selectNextEligibleWork(program, allSchedulerFacts)).toBeNull();
    program = applyProgramTransition(program, {
      kind: "blocker.resolve",
      expectedProgramRevision: program.revision,
      blockerId: asProgramBlockerId("blocker-1"),
    });
    expect(selectNextEligibleWork(program, allSchedulerFacts)?.workItemId).toBe(workA);

    const evidence = {
      evidenceRefId: asProgramEvidenceRefId("evidence-1"),
      workItemId: workA,
      verificationObligationId: verificationA,
      sourceOperationId: null,
      artifactRef: null,
    };
    program = applyProgramTransition(program, {
      kind: "evidence.add",
      expectedProgramRevision: program.revision,
      evidence,
    });
    const same = applyProgramTransition(program, {
      kind: "evidence.add",
      expectedProgramRevision: program.revision,
      evidence,
    });
    expect(same).toBe(program);
  });
});
