import { describe, expect, it } from "vitest";
import {
  applyProgramSemanticRevisionCutV1,
  asProgramArtifactProductionStepId,
  asProgramAttemptId,
  asProgramOutputSlotId,
  asProgramRevisionId,
  asProgramStateId,
  asProgramWorkItemId,
  asVerificationObligationId,
  createProgramSemanticRevisionCutV1,
  type ProgramArtifactProductionStep,
  type ProgramAttemptSemanticAssumptionsV1,
  type ProgramChangeClass,
  type ProgramOutputSlot,
  type ProgramRevision,
  type ProgramSemanticRevisionEditV1,
  type ProgramSemanticStateV1,
  type ProgramSemanticWorkItemV1,
  type VerificationDefinition,
  type VerificationObligation,
  type VerificationSemanticBindingV1,
  type WorkAuthorityEnvelopeV1,
  type WorkItemIdentityDecisionV1,
} from "./index.ts";

const programId = asProgramStateId("018f0000-0000-7000-8000-000000000001");
const r1 = asProgramRevisionId("revision-1");
const workAId = asProgramWorkItemId("work-a");
const workBId = asProgramWorkItemId("work-b");
const verifyProgram = asVerificationObligationId("verify-program");
const verifyA = asVerificationObligationId("verify-a");
const verifyB = asVerificationObligationId("verify-b");

function envelope(overrides: Partial<WorkAuthorityEnvelopeV1> = {}): WorkAuthorityEnvelopeV1 {
  return {
    objectiveBoundaryRef: {
      programStateId: programId,
      rootProgramRevisionId: r1,
      anchorWorkItemId: null,
    },
    allowedRepositoryRoots: ["."],
    allowedEffectClasses: ["fs.read", "fs.write"],
    allowedExternalSystems: ["github"],
    capabilityCeiling: ["edit", "read"],
    maximumTopologyExpansion: 8,
    mandatoryVerificationIds: [verifyProgram],
    forbiddenChangeKinds: ["delete_repository"],
    ...overrides,
  };
}

function work(
  id: ReturnType<typeof asProgramWorkItemId>,
  overrides: Partial<ProgramSemanticWorkItemV1> = {},
): ProgramSemanticWorkItemV1 {
  return {
    workItemId: id,
    creationOrder: id === workAId ? 0 : 1,
    description: String(id),
    dependencyIds: [],
    affectedPaths: [id === workAId ? "src/a.ts" : "src/b.ts"],
    workItemGeneration: 1,
    requirementState: "required",
    topologyState: "leaf",
    satisfactionState: id === workAId ? "active" : "pending",
    parentWorkItemId: null,
    authorityEnvelope: envelope(),
    ...overrides,
  };
}

function definition(id: ReturnType<typeof asVerificationObligationId>): VerificationDefinition {
  return {
    obligationId: id,
    predicate: {
      kind: "operation_result",
      specId: `verify.${String(id)}`,
      specVersion: 1,
      canonicalArgs: {},
      canonicalArgsDigest: `digest-${String(id)}`,
    },
    freshnessScope: { kind: "workspace" },
  };
}

function obligation(id: ReturnType<typeof asVerificationObligationId>): VerificationObligation {
  return { ...definition(id), subjectGeneration: 1, satisfaction: null, waiver: null };
}

function initialRevision(): ProgramRevision {
  return {
    programRevisionId: r1,
    parentProgramRevisionId: null,
    ordinal: 1,
    changeClass: "initial",
    acceptedAtStateRevision: 1,
    admissionEventId: "baseline-event",
    sourceDraftId: null,
    sourceDraftDigest: null,
  };
}

function bindings(workA = workAId, workAGeneration = 1, workB = workBId, workBGeneration = 1): VerificationSemanticBindingV1[] {
  return [
    { obligationId: verifyProgram, subject: { kind: "program" } },
    { obligationId: verifyA, subject: { kind: "work_item", workItemId: workA, workItemGeneration: workAGeneration } },
    { obligationId: verifyB, subject: { kind: "work_item", workItemId: workB, workItemGeneration: workBGeneration } },
  ];
}

function semanticState(overrides: Partial<ProgramSemanticStateV1> = {}): ProgramSemanticStateV1 {
  return {
    programStateId: programId,
    currentRevision: initialRevision(),
    workItems: [work(workAId), work(workBId)],
    verification: [obligation(verifyProgram), obligation(verifyA), obligation(verifyB)],
    verificationBindings: bindings(),
    outputSlots: [],
    productionSteps: [],
    ...overrides,
  };
}

function decisions(
  changes: Partial<Record<"a" | "b", WorkItemIdentityDecisionV1>> = {},
): WorkItemIdentityDecisionV1[] {
  return [
    changes.a ?? {
      workItemId: workAId,
      fromGeneration: 1,
      disposition: "unchanged",
      successorWorkItemId: null,
    },
    changes.b ?? {
      workItemId: workBId,
      fromGeneration: 1,
      disposition: "unchanged",
      successorWorkItemId: null,
    },
  ];
}

function nextRevision(
  id: string,
  changeClass: Exclude<ProgramChangeClass, "initial">,
  acceptedAtStateRevision = 8,
): ProgramRevision {
  return {
    programRevisionId: asProgramRevisionId(id),
    parentProgramRevisionId: r1,
    ordinal: 2,
    changeClass,
    acceptedAtStateRevision,
    admissionEventId: `event-${id}`,
    sourceDraftId: `draft-${id}`,
    sourceDraftDigest: `digest-${id}`,
  };
}

function edit(
  state: ProgramSemanticStateV1,
  overrides: Partial<ProgramSemanticRevisionEditV1> = {},
): ProgramSemanticRevisionEditV1 {
  return {
    workItems: state.workItems,
    identityDecisions: decisions(),
    verification: state.verification.map(({ obligationId, predicate, freshnessScope }) => ({ obligationId, predicate, freshnessScope })),
    verificationBindings: state.verificationBindings,
    outputSlots: state.outputSlots,
    productionSteps: state.productionSteps,
    ...overrides,
  };
}

function activeAttempt(
  target = workAId,
  generation = 1,
  directDependencies: ProgramAttemptSemanticAssumptionsV1["directDependencies"] = [],
  authority = envelope(),
): ProgramAttemptSemanticAssumptionsV1 {
  return {
    programAttemptId: asProgramAttemptId("attempt-1"),
    workItemId: target,
    workItemGeneration: generation,
    directDependencies,
    workAuthorityEnvelope: authority,
  };
}

function decomposeB(state: ProgramSemanticStateV1): ProgramSemanticRevisionEditV1 {
  const childId = asProgramWorkItemId("work-b-child");
  return edit(state, {
    workItems: [
      state.workItems[0]!,
      { ...state.workItems[1]!, workItemGeneration: 2, topologyState: "decomposed", satisfactionState: "pending" },
      work(childId, {
        workItemId: childId,
        creationOrder: 2,
        description: "child",
        parentWorkItemId: workBId,
        satisfactionState: "pending",
      }),
    ],
    identityDecisions: decisions({
      b: {
        workItemId: workBId,
        fromGeneration: 1,
        disposition: "preserve_identity_and_advance_generation",
        successorWorkItemId: null,
      },
    }),
    verificationBindings: bindings(workAId, 1, workBId, 2),
  });
}

describe("A1 atomic semantic revision transaction", () => {
  it("retains an unrelated active Attempt and emits deterministic full impact", () => {
    const previous = semanticState();
    const cut = createProgramSemanticRevisionCutV1(previous, {
      currentProgramStateRevision: 7,
      nextRevision: nextRevision("revision-2", "refinement"),
      edit: decomposeB(previous),
      activeAttempt: activeAttempt(),
    });

    expect(cut.fromProgramStateRevision).toBe(7);
    expect(cut.toProgramStateRevision).toBe(8);
    expect(cut.nextSemanticState.currentRevision.ordinal).toBe(2);
    expect(cut.revisionImpact.retainedAttempts.map(String)).toEqual(["attempt-1"]);
    expect(cut.revisionImpact.invalidatedAttempts).toEqual([]);
    expect(cut.revisionImpact.modifiedWorkItems.map((value) => String(value.workItemId))).toEqual(["work-b"]);
    expect(cut.revisionImpact.addedWorkItems.map((value) => String(value.workItemId))).toEqual(["work-b-child"]);
    expect(cut.revisionImpact.retainedVerification.map((value) => String(value.obligationId))).toEqual(["verify-a"]);
    expect(cut.revisionImpact.staleVerification.map((value) => String(value.obligationId))).toEqual(["verify-program"]);
    expect(cut.revisionImpact.reboundVerification.map((value) => String(value.obligationId))).toEqual(["verify-b"]);

    const replay = applyProgramSemanticRevisionCutV1(previous, 7, cut);
    expect(replay.programStateRevision).toBe(8);
    expect(replay.semanticState.currentRevision.programRevisionId).toBe(asProgramRevisionId("revision-2"));
  });

  it("invalidates the active Attempt when its target is decomposed", () => {
    const previous = semanticState({
      workItems: [work(workAId), work(workBId, { satisfactionState: "pending" })],
    });
    const childId = asProgramWorkItemId("work-a-child");
    const nextWork = [
      { ...previous.workItems[0]!, workItemGeneration: 2, topologyState: "decomposed" as const, satisfactionState: "pending" as const },
      previous.workItems[1]!,
      work(childId, { workItemId: childId, creationOrder: 2, description: "child-a", parentWorkItemId: workAId }),
    ];
    const cut = createProgramSemanticRevisionCutV1(previous, {
      currentProgramStateRevision: 7,
      nextRevision: nextRevision("revision-target", "refinement"),
      edit: edit(previous, {
        workItems: nextWork,
        identityDecisions: decisions({
          a: { workItemId: workAId, fromGeneration: 1, disposition: "preserve_identity_and_advance_generation", successorWorkItemId: null },
        }),
        verificationBindings: bindings(workAId, 2, workBId, 1),
      }),
      activeAttempt: activeAttempt(),
    });
    expect(cut.revisionImpact.retainedAttempts).toEqual([]);
    expect(cut.revisionImpact.invalidatedAttempts.map(String)).toEqual(["attempt-1"]);
  });

  it("invalidates a dependent Attempt when a direct dependency generation changes", () => {
    const dependencyId = asProgramWorkItemId("dependency");
    const targetId = asProgramWorkItemId("target");
    const dependency = work(dependencyId, {
      creationOrder: 0,
      affectedPaths: ["src/dep.ts"],
      satisfactionState: "satisfied",
      authorityEnvelope: envelope(),
    });
    const target = work(targetId, {
      creationOrder: 1,
      affectedPaths: ["src/target.ts"],
      dependencyIds: [dependencyId],
      satisfactionState: "active",
      authorityEnvelope: envelope(),
    });
    const previous = semanticState({
      workItems: [dependency, target],
      verification: [obligation(verifyProgram)],
      verificationBindings: [{ obligationId: verifyProgram, subject: { kind: "program" } }],
    });
    const narrowed = envelope({ allowedEffectClasses: ["fs.read"] });
    const nextDependency = { ...dependency, workItemGeneration: 2, authorityEnvelope: narrowed };
    const attempt = activeAttempt(targetId, 1, [{
      workItemId: dependencyId,
      workItemGeneration: 1,
      required: true,
      satisfiedOrDischargedAtIssue: true,
    }], envelope());
    const cut = createProgramSemanticRevisionCutV1(previous, {
      currentProgramStateRevision: 7,
      nextRevision: nextRevision("revision-dependency", "refinement"),
      edit: edit(previous, {
        workItems: [nextDependency, target],
        identityDecisions: [
          { workItemId: dependencyId, fromGeneration: 1, disposition: "preserve_identity_and_advance_generation", successorWorkItemId: null },
          { workItemId: targetId, fromGeneration: 1, disposition: "unchanged", successorWorkItemId: null },
        ],
      }),
      activeAttempt: attempt,
    });
    expect(cut.revisionImpact.invalidatedAttempts.map(String)).toEqual(["attempt-1"]);
  });

  it("classifies decomposition of already-satisfied work as correction", () => {
    const previous = semanticState({
      workItems: [work(workAId), work(workBId, { satisfactionState: "satisfied" })],
    });
    const candidate = decomposeB(previous);
    expect(() => createProgramSemanticRevisionCutV1(previous, {
      currentProgramStateRevision: 7,
      nextRevision: nextRevision("revision-wrong-class", "refinement"),
      edit: candidate,
      activeAttempt: activeAttempt(),
    })).toThrow(/does not match Host classification correction/);

    expect(() => createProgramSemanticRevisionCutV1(previous, {
      currentProgramStateRevision: 7,
      nextRevision: nextRevision("revision-correction", "correction"),
      edit: candidate,
      activeAttempt: activeAttempt(),
    })).not.toThrow();
  });

  it("classifies mechanical authority widening as scope amendment", () => {
    const previous = semanticState();
    const widened = envelope({ allowedExternalSystems: ["github", "slack"] });
    const candidate = edit(previous, {
      workItems: [previous.workItems[0]!, { ...previous.workItems[1]!, workItemGeneration: 2, authorityEnvelope: widened }],
      identityDecisions: decisions({
        b: { workItemId: workBId, fromGeneration: 1, disposition: "preserve_identity_and_advance_generation", successorWorkItemId: null },
      }),
      verificationBindings: bindings(workAId, 1, workBId, 2),
    });
    expect(() => createProgramSemanticRevisionCutV1(previous, {
      currentProgramStateRevision: 7,
      nextRevision: nextRevision("revision-widen", "correction"),
      edit: candidate,
      activeAttempt: activeAttempt(),
    })).toThrow(/scope_amendment/);
    expect(() => createProgramSemanticRevisionCutV1(previous, {
      currentProgramStateRevision: 7,
      nextRevision: nextRevision("revision-scope", "scope_amendment"),
      edit: candidate,
      activeAttempt: activeAttempt(),
    })).not.toThrow();
  });

  it("tracks output semantic changes and stales output verification", () => {
    const outputId = asProgramOutputSlotId("output-1");
    const stepId = asProgramArtifactProductionStepId("produce-1");
    const outputVerification = asVerificationObligationId("verify-output");
    const slot: ProgramOutputSlot = { outputSlotId: outputId, productionStepId: stepId };
    const step: ProgramArtifactProductionStep = {
      productionStepId: stepId,
      producerWorkItemId: workBId,
      outputChannel: "artifact",
      specId: "produce.v1",
      specVersion: 1,
      canonicalArgs: { path: "dist/a" },
      canonicalArgsDigest: "args-a",
    };
    const previous = semanticState({
      verification: [obligation(verifyProgram), obligation(verifyA), obligation(verifyB), obligation(outputVerification)],
      verificationBindings: [
        ...bindings(),
        { obligationId: outputVerification, subject: { kind: "output", outputSlotId: outputId, producerWorkItemId: workBId, producerWorkItemGeneration: 1 } },
      ],
      outputSlots: [slot],
      productionSteps: [step],
    });
    const changedStep = { ...step, canonicalArgs: { path: "dist/b" }, canonicalArgsDigest: "args-b" };
    const cut = createProgramSemanticRevisionCutV1(previous, {
      currentProgramStateRevision: 7,
      nextRevision: nextRevision("revision-output", "scope_amendment"),
      edit: edit(previous, { productionSteps: [changedStep] }),
      activeAttempt: activeAttempt(),
    });
    expect(cut.revisionImpact.modifiedOutputs.map((value) => String(value.outputSlotId))).toEqual(["output-1"]);
    expect(cut.revisionImpact.staleVerification.map((value) => String(value.obligationId))).toEqual([
      "verify-output",
      "verify-program",
    ]);
  });

  it("rejects a stale concurrent semantic cut and keeps semantic ordinal separate from state revision", () => {
    const previous = semanticState();
    const cutA = createProgramSemanticRevisionCutV1(previous, {
      currentProgramStateRevision: 7,
      nextRevision: nextRevision("revision-a", "refinement"),
      edit: decomposeB(previous),
      activeAttempt: activeAttempt(),
    });
    const cutB = createProgramSemanticRevisionCutV1(previous, {
      currentProgramStateRevision: 7,
      nextRevision: nextRevision("revision-b", "refinement"),
      edit: decomposeB(previous),
      activeAttempt: activeAttempt(),
    });
    const applied = applyProgramSemanticRevisionCutV1(previous, 7, cutA);
    expect(applied.programStateRevision).toBe(8);
    expect(applied.semanticState.currentRevision.ordinal).toBe(2);
    expect(() => applyProgramSemanticRevisionCutV1(applied.semanticState, 8, cutB)).toThrow(/stale/);
  });

  it("rejects missing identity disposition and WorkItem generation jumps", () => {
    const previous = semanticState();
    const candidate = decomposeB(previous);
    expect(() => createProgramSemanticRevisionCutV1(previous, {
      currentProgramStateRevision: 7,
      nextRevision: nextRevision("revision-missing-id", "refinement"),
      edit: { ...candidate, identityDecisions: candidate.identityDecisions.filter((value) => value.workItemId !== workAId) },
      activeAttempt: activeAttempt(),
    })).toThrow(/missing an explicit identity disposition/);

    const jumped = candidate.workItems.map((value) => value.workItemId === workBId ? { ...value, workItemGeneration: 3 } : value);
    expect(() => createProgramSemanticRevisionCutV1(previous, {
      currentProgramStateRevision: 7,
      nextRevision: nextRevision("revision-generation-jump", "refinement"),
      edit: { ...candidate, workItems: jumped },
      activeAttempt: activeAttempt(),
    })).toThrow(/advance exactly one generation/);
  });

  it("rejects a tampered RevisionImpact during replay", () => {
    const previous = semanticState();
    const cut = createProgramSemanticRevisionCutV1(previous, {
      currentProgramStateRevision: 7,
      nextRevision: nextRevision("revision-tamper", "refinement"),
      edit: decomposeB(previous),
      activeAttempt: activeAttempt(),
    });
    const tampered = {
      ...cut,
      revisionImpact: { ...cut.revisionImpact, retainedAttempts: [] },
    };
    expect(() => applyProgramSemanticRevisionCutV1(previous, 7, tampered)).toThrow(/deterministic recomputation/);
  });
});
