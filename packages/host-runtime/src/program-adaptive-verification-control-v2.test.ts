import { describe, expect, it } from "vitest";
import {
  asProgramRevisionId,
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  asVerificationObligationId,
  createProgramState,
  type ProgramSemanticStateV1,
  type ProgramSemanticWorkItemV1,
  type ProgramWorkItem,
  type ProgramWorkLifecycle,
  type ProgramSatisfactionState,
  type WorkAuthorityEnvelopeV1,
} from "@alcode/program-state";
import { planningCanonicalDigest } from "./planning-read.ts";
import { requiredAdaptiveVerificationForCurrentWorkV2 } from "./program-adaptive-verification-control-v2.ts";

const programStateId = asProgramStateId("018f0000-0000-7000-8000-000000000f01");
const sessionId = asSessionId("018f0000-0000-7000-8000-000000000f02");
const firstWorkId = asProgramWorkItemId("verification-binding-first");
const secondWorkId = asProgramWorkItemId("verification-binding-second");
const decomposedParentId = asProgramWorkItemId("verification-binding-parent");
const completedChildId = asProgramWorkItemId("verification-binding-completed-child");
const finalChildId = asProgramWorkItemId("verification-binding-final-child");
const workObligationId = asVerificationObligationId("verification-binding-operation");
const programObligationId = asVerificationObligationId("verification-binding-program");
const revisionId = asProgramRevisionId("verification-binding-r1");
const operationArgs = { command: "verify-current-work" } as const;

const initial = createProgramState({
  programStateId,
  sourceSessionId: sessionId,
  objective: "Honor explicit adaptive verification subjects",
  workItems: [
    {
      workItemId: firstWorkId,
      creationOrder: 0,
      description: "First work owns the operation verification",
      dependencyIds: [],
      affectedPaths: ["src/first.ts"],
    },
    {
      workItemId: secondWorkId,
      creationOrder: 1,
      description: "Second work remains incomplete",
      dependencyIds: [],
      affectedPaths: ["src/second.ts"],
    },
  ],
  verification: [
    {
      obligationId: workObligationId,
      predicate: {
        kind: "operation_result",
        specId: "verify-current-work",
        specVersion: 1,
        canonicalArgs: operationArgs,
        canonicalArgsDigest: planningCanonicalDigest(operationArgs),
      },
      freshnessScope: { kind: "workspace" },
    },
    {
      obligationId: programObligationId,
      predicate: {
        kind: "operation_result",
        specId: "verify-program",
        specVersion: 1,
        canonicalArgs: operationArgs,
        canonicalArgsDigest: planningCanonicalDigest(operationArgs),
      },
      freshnessScope: { kind: "workspace" },
    },
  ],
  outputSlots: [],
  productionSteps: [],
});

function envelope(anchorWorkItemId: ReturnType<typeof asProgramWorkItemId>): WorkAuthorityEnvelopeV1 {
  return {
    objectiveBoundaryRef: {
      programStateId,
      rootProgramRevisionId: revisionId,
      anchorWorkItemId,
    },
    allowedRepositoryRoots: ["."],
    allowedEffectClasses: ["fs.read"],
    allowedExternalSystems: [],
    capabilityCeiling: ["read"],
    maximumTopologyExpansion: 8,
    mandatoryVerificationIds: [workObligationId, programObligationId],
    forbiddenChangeKinds: ["delete_repository"],
  };
}

function semanticWork(
  work: ProgramWorkItem,
  satisfactionState: ProgramSatisfactionState,
): ProgramSemanticWorkItemV1 {
  return {
    ...work,
    workItemGeneration: 1,
    requirementState: "required",
    topologyState: "leaf",
    satisfactionState,
    parentWorkItemId: null,
    authorityEnvelope: envelope(work.workItemId),
  };
}

function semanticState(
  firstState: ProgramSatisfactionState,
  secondState: ProgramSatisfactionState,
): ProgramSemanticStateV1 {
  return {
    programStateId,
    currentRevision: {
      programRevisionId: revisionId,
      parentProgramRevisionId: null,
      ordinal: 1,
      changeClass: "initial",
      acceptedAtStateRevision: 1,
      admissionEventId: "verification-binding-baseline",
      sourceDraftId: null,
      sourceDraftDigest: null,
    },
    workItems: [
      semanticWork(initial.workItems[0]!, firstState),
      semanticWork(initial.workItems[1]!, secondState),
    ],
    verification: initial.verification,
    verificationBindings: [
      {
        obligationId: workObligationId,
        subject: { kind: "work_item", workItemId: firstWorkId, workItemGeneration: 1 },
      },
      {
        obligationId: programObligationId,
        subject: { kind: "program" },
      },
    ],
    outputSlots: [],
    productionSteps: [],
  };
}

function operationalState(firstLifecycle: ProgramWorkLifecycle, secondLifecycle: ProgramWorkLifecycle) {
  return {
    ...initial,
    workItems: initial.workItems.map((work) => ({
      ...work,
      lifecycle: work.workItemId === firstWorkId ? firstLifecycle : secondLifecycle,
    })),
  };
}

function decomposedFinalLeafFixture() {
  const raw = createProgramState({
    programStateId,
    sourceSessionId: sessionId,
    objective: "Run program verification on the final decomposed leaf",
    workItems: [
      {
        workItemId: decomposedParentId,
        creationOrder: 0,
        description: "Decomposed parent",
        dependencyIds: [],
        affectedPaths: [],
      },
      {
        workItemId: completedChildId,
        creationOrder: 1,
        description: "Already satisfied child",
        dependencyIds: [],
        affectedPaths: ["src/completed-child.ts"],
      },
      {
        workItemId: finalChildId,
        creationOrder: 2,
        description: "Final child awaiting program verification",
        dependencyIds: [],
        affectedPaths: ["src/final-child.ts"],
      },
    ],
    verification: [{
      obligationId: programObligationId,
      predicate: {
        kind: "operation_result",
        specId: "verify-program",
        specVersion: 1,
        canonicalArgs: operationArgs,
        canonicalArgsDigest: planningCanonicalDigest(operationArgs),
      },
      freshnessScope: { kind: "workspace" },
    }],
    outputSlots: [],
    productionSteps: [],
  });
  raw.workItems = raw.workItems.map((work) => ({
    ...work,
    lifecycle: work.workItemId === completedChildId
      ? "completed" as const
      : work.workItemId === finalChildId
        ? "awaiting_verification" as const
        : "pending" as const,
  }));

  const semantic: ProgramSemanticStateV1 = {
    programStateId,
    currentRevision: {
      programRevisionId: revisionId,
      parentProgramRevisionId: null,
      ordinal: 1,
      changeClass: "initial",
      acceptedAtStateRevision: 1,
      admissionEventId: "verification-binding-decomposed-baseline",
      sourceDraftId: null,
      sourceDraftDigest: null,
    },
    workItems: [
      {
        workItemId: decomposedParentId,
        creationOrder: 0,
        description: "Decomposed parent",
        dependencyIds: [],
        affectedPaths: [],
        workItemGeneration: 1,
        requirementState: "required",
        topologyState: "decomposed",
        satisfactionState: "pending",
        parentWorkItemId: null,
        authorityEnvelope: envelope(decomposedParentId),
      },
      {
        workItemId: completedChildId,
        creationOrder: 1,
        description: "Already satisfied child",
        dependencyIds: [],
        affectedPaths: ["src/completed-child.ts"],
        workItemGeneration: 1,
        requirementState: "required",
        topologyState: "leaf",
        satisfactionState: "satisfied",
        parentWorkItemId: decomposedParentId,
        authorityEnvelope: envelope(completedChildId),
      },
      {
        workItemId: finalChildId,
        creationOrder: 2,
        description: "Final child awaiting program verification",
        dependencyIds: [],
        affectedPaths: ["src/final-child.ts"],
        workItemGeneration: 1,
        requirementState: "required",
        topologyState: "leaf",
        satisfactionState: "awaiting_verification",
        parentWorkItemId: decomposedParentId,
        authorityEnvelope: envelope(finalChildId),
      },
    ],
    verification: raw.verification,
    verificationBindings: [{
      obligationId: programObligationId,
      subject: { kind: "program" },
    }],
    outputSlots: [],
    productionSteps: [],
  };
  return { raw, semantic };
}

describe("adaptive verification semantic bindings", () => {
  it("selects a pathless operation_result from the authoritative binding while other work remains incomplete", () => {
    const state = operationalState("awaiting_verification", "pending");
    const selected = requiredAdaptiveVerificationForCurrentWorkV2(
      state,
      semanticState("awaiting_verification", "pending"),
      state.workItems[0]!,
    );

    expect(selected.map((obligation) => obligation.obligationId)).toEqual([workObligationId]);
  });

  it("does not transfer work-bound verification to the final work and only then admits program-scoped verification", () => {
    const state = operationalState("completed", "awaiting_verification");
    const selected = requiredAdaptiveVerificationForCurrentWorkV2(
      state,
      semanticState("satisfied", "awaiting_verification"),
      state.workItems[1]!,
    );

    expect(selected.map((obligation) => obligation.obligationId)).toEqual([programObligationId]);
  });

  it("runs program-scoped verification on the final leaf of a decomposed semantic requirement", () => {
    const { raw, semantic } = decomposedFinalLeafFixture();
    expect(raw.workItems.find((work) => work.workItemId === decomposedParentId)?.lifecycle).toBe("pending");
    const current = raw.workItems.find((work) => work.workItemId === finalChildId)!;

    const selected = requiredAdaptiveVerificationForCurrentWorkV2(raw, semantic, current);

    expect(selected.map((obligation) => obligation.obligationId)).toEqual([programObligationId]);
  });
});
