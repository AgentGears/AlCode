import { describe, expect, it } from "vitest";
import {
  PROGRAM_LIMITS,
  ProgramInvariantError,
  allRequiredSemanticWorkComplete,
  asProgramArtifactProductionStepId,
  asProgramOutputSlotId,
  asProgramRevisionId,
  asProgramStateId,
  asProgramWorkItemId,
  asVerificationObligationId,
  assertCurrentVerificationSubjectV1,
  assertSemanticRationaleWithinLimit,
  assertValidProgramRevision,
  assertValidProgramSemanticWorkGraph,
  assertValidVerificationSemanticBindingsV1,
  assertValidWorkAuthorityEnvelopeV1,
  deriveReadySemanticWorkItems,
  isProgramSemanticWorkItemDischarged,
  legacyLifecycleToSatisfactionState,
  verificationSubjectIsCurrent,
  workAuthorityEnvelopeIsEqualOrNarrower,
  type ProgramSemanticWorkItemV1,
  type WorkAuthorityEnvelopeV1,
} from "./index.ts";

const programId = asProgramStateId("018f0000-0000-7000-8000-000000000001");
const rootRevisionId = asProgramRevisionId("revision-root");
const rootId = asProgramWorkItemId("root");

function envelope(overrides: Partial<WorkAuthorityEnvelopeV1> = {}): WorkAuthorityEnvelopeV1 {
  return {
    objectiveBoundaryRef: {
      programStateId: programId,
      rootProgramRevisionId: rootRevisionId,
      anchorWorkItemId: rootId,
    },
    allowedRepositoryRoots: ["."],
    allowedEffectClasses: ["fs.read", "fs.write"],
    allowedExternalSystems: ["github"],
    capabilityCeiling: ["edit", "read"],
    maximumTopologyExpansion: 8,
    mandatoryVerificationIds: [asVerificationObligationId("verify-a")],
    forbiddenChangeKinds: ["delete_repository"],
    ...overrides,
  };
}

function work(
  id: string,
  overrides: Partial<ProgramSemanticWorkItemV1> = {},
): ProgramSemanticWorkItemV1 {
  return {
    workItemId: asProgramWorkItemId(id),
    creationOrder: 0,
    description: id,
    dependencyIds: [],
    affectedPaths: [],
    workItemGeneration: 1,
    requirementState: "required",
    topologyState: "leaf",
    satisfactionState: "pending",
    parentWorkItemId: null,
    authorityEnvelope: envelope(),
    ...overrides,
  };
}

describe("A1 frozen semantic kernel", () => {
  it("exports the exact frozen A1 hard limits without raising Phase-1 ceilings", () => {
    expect(PROGRAM_LIMITS.workItems).toBe(128);
    expect(PROGRAM_LIMITS.totalDependencyEdges).toBe(1_024);
    expect(PROGRAM_LIMITS.serializedCanonicalProgramStateBytes).toBe(4 * 1024 * 1024);
    expect(PROGRAM_LIMITS.decompositionDepth).toBe(8);
    expect(PROGRAM_LIMITS.childrenPerDecomposition).toBe(8);
    expect(PROGRAM_LIMITS.semanticProgramRevisions).toBe(32);
    expect(PROGRAM_LIMITS.semanticRevisionProposalBytes).toBe(3 * 1024 * 1024);
    expect(PROGRAM_LIMITS.revisionImpactBytes).toBe(256 * 1024);
    expect(PROGRAM_LIMITS.sealedPendingSemanticDraftBytes).toBe(4 * 1024 * 1024);
    expect(PROGRAM_LIMITS.workAuthorityEnvelopeBytes).toBe(8 * 1024);
    expect(PROGRAM_LIMITS.semanticRationaleBytes).toBe(4 * 1024);
  });

  it("maps legacy lifecycle into the orthogonal A1 satisfaction axis", () => {
    expect(legacyLifecycleToSatisfactionState("pending")).toBe("pending");
    expect(legacyLifecycleToSatisfactionState("in_progress")).toBe("active");
    expect(legacyLifecycleToSatisfactionState("blocked")).toBe("blocked");
    expect(legacyLifecycleToSatisfactionState("awaiting_verification")).toBe("awaiting_verification");
    expect(legacyLifecycleToSatisfactionState("completed")).toBe("satisfied");
  });

  it("validates recursive non-vacuous decomposition and derived discharge", () => {
    const middleId = asProgramWorkItemId("middle");
    const leafBId = asProgramWorkItemId("leaf-b");
    const graph = [
      work("root", { topologyState: "decomposed" }),
      work("middle", { parentWorkItemId: rootId, topologyState: "decomposed" }),
      work("leaf-a", { parentWorkItemId: middleId, satisfactionState: "satisfied" }),
      work("leaf-b", { parentWorkItemId: middleId, satisfactionState: "satisfied" }),
      work("downstream", { dependencyIds: [rootId] }),
    ];

    assertValidProgramSemanticWorkGraph(graph);
    expect(isProgramSemanticWorkItemDischarged(middleId, graph)).toBe(true);
    expect(isProgramSemanticWorkItemDischarged(rootId, graph)).toBe(true);
    expect(allRequiredSemanticWorkComplete(graph)).toBe(false);
    expect(deriveReadySemanticWorkItems(graph).map((item) => String(item.workItemId))).toEqual(["downstream"]);

    const incomplete = graph.map((item) =>
      item.workItemId === leafBId ? { ...item, satisfactionState: "pending" as const } : item);
    expect(isProgramSemanticWorkItemDischarged(rootId, incomplete)).toBe(false);
    expect(deriveReadySemanticWorkItems(incomplete).map((item) => String(item.workItemId)))
      .toEqual(["leaf-b"]);

    const vacuous = [work("root", { topologyState: "decomposed" })];
    expect(() => assertValidProgramSemanticWorkGraph(vacuous)).toThrow(/zero current required children/);
    expect(isProgramSemanticWorkItemDischarged(rootId, vacuous)).toBe(false);
  });

  it("enforces root-depth-zero max depth 8 and current required fan-out 8", () => {
    const chain: ProgramSemanticWorkItemV1[] = [];
    for (let depth = 0; depth <= 8; depth += 1) {
      chain.push(work(`depth-${depth}`, {
        creationOrder: depth,
        parentWorkItemId: depth === 0 ? null : asProgramWorkItemId(`depth-${depth - 1}`),
        topologyState: depth === 8 ? "leaf" : "decomposed",
      }));
    }
    expect(() => assertValidProgramSemanticWorkGraph(chain)).not.toThrow();
    chain.push(work("depth-9", {
      creationOrder: 9,
      parentWorkItemId: asProgramWorkItemId("depth-8"),
    }));
    chain[8] = { ...chain[8]!, topologyState: "decomposed" };
    expect(() => assertValidProgramSemanticWorkGraph(chain)).toThrow(/decomposition depth exceeds 8/);

    const eightChildren = [
      work("root", { topologyState: "decomposed" }),
      ...Array.from({ length: 8 }, (_, index) => work(`child-${index}`, {
        creationOrder: index + 1,
        parentWorkItemId: rootId,
      })),
    ];
    expect(() => assertValidProgramSemanticWorkGraph(eightChildren)).not.toThrow();
    const nineChildren = [...eightChildren, work("child-8", { creationOrder: 9, parentWorkItemId: rootId })];
    expect(() => assertValidProgramSemanticWorkGraph(nineChildren)).toThrow(/required direct children.*exceeds 8/);
  });

  it("enforces mechanical authority narrowing and parent expansion ceilings", () => {
    const parent = envelope();
    const child = envelope({
      allowedRepositoryRoots: ["src"],
      allowedEffectClasses: ["fs.read"],
      allowedExternalSystems: [],
      capabilityCeiling: ["read"],
      maximumTopologyExpansion: 2,
      mandatoryVerificationIds: [
        asVerificationObligationId("verify-a"),
        asVerificationObligationId("verify-b"),
      ],
      forbiddenChangeKinds: ["delete_repository", "network_write"],
    });
    expect(workAuthorityEnvelopeIsEqualOrNarrower(child, parent)).toBe(true);
    expect(workAuthorityEnvelopeIsEqualOrNarrower(
      envelope({ allowedExternalSystems: ["github", "slack"] }),
      parent,
    )).toBe(false);

    const graph = [
      work("root", { topologyState: "decomposed", authorityEnvelope: envelope({ maximumTopologyExpansion: 1 }) }),
      work("child-a", { parentWorkItemId: rootId, authorityEnvelope: child }),
      work("child-b", { parentWorkItemId: rootId, authorityEnvelope: child }),
    ];
    expect(() => assertValidProgramSemanticWorkGraph(graph)).toThrow(/maximumTopologyExpansion/);

    expect(() => assertValidWorkAuthorityEnvelopeV1(
      envelope({ capabilityCeiling: ["read", "edit"] }),
    )).toThrow(/strictly sorted and deduplicated/);
  });

  it("binds verification subjects to exact WorkItem generations and output producers", () => {
    const producer = work("producer", { workItemGeneration: 3 });
    const currentWorkSubject = { kind: "work_item" as const, workItemId: producer.workItemId, workItemGeneration: 3 };
    const staleWorkSubject = { ...currentWorkSubject, workItemGeneration: 2 };
    expect(verificationSubjectIsCurrent(currentWorkSubject, [producer])).toBe(true);
    expect(verificationSubjectIsCurrent(staleWorkSubject, [producer])).toBe(false);

    const outputSlotId = asProgramOutputSlotId("output-1");
    const productionStepId = asProgramArtifactProductionStepId("produce-1");
    const outputSlots = [{ outputSlotId, productionStepId }];
    const productionSteps = [{
      productionStepId,
      producerWorkItemId: producer.workItemId,
      outputChannel: "artifact",
      specId: "artifact.produce.v1",
      specVersion: 1,
      canonicalArgs: {},
      canonicalArgsDigest: "digest",
    }];
    const outputSubject = {
      kind: "output" as const,
      outputSlotId,
      producerWorkItemId: producer.workItemId,
      producerWorkItemGeneration: 3,
    };
    expect(verificationSubjectIsCurrent(outputSubject, [producer], outputSlots, productionSteps)).toBe(true);
    expect(verificationSubjectIsCurrent(
      { ...outputSubject, producerWorkItemGeneration: 2 },
      [producer],
      outputSlots,
      productionSteps,
    )).toBe(false);
    expect(() => assertCurrentVerificationSubjectV1(outputSubject, [producer], outputSlots, productionSteps)).not.toThrow();

    const obligationId = asVerificationObligationId("verify-output");
    expect(() => assertValidVerificationSemanticBindingsV1(
      [{ obligationId, subject: outputSubject }],
      new Set([String(obligationId)]),
      [producer],
      outputSlots,
      productionSteps,
    )).not.toThrow();
    expect(() => assertValidVerificationSemanticBindingsV1(
      [],
      new Set([String(obligationId)]),
      [producer],
      outputSlots,
      productionSteps,
    )).toThrow(/exactly one subject binding/);
  });

  it("validates bounded immutable ProgramRevision records", () => {
    expect(() => assertValidProgramRevision({
      programRevisionId: rootRevisionId,
      parentProgramRevisionId: null,
      ordinal: 1,
      changeClass: "initial",
      acceptedAtStateRevision: 7,
      admissionEventId: "event-initial",
      sourceDraftId: null,
      sourceDraftDigest: null,
    })).not.toThrow();

    expect(() => assertValidProgramRevision({
      programRevisionId: asProgramRevisionId("revision-2"),
      parentProgramRevisionId: rootRevisionId,
      ordinal: 2,
      changeClass: "refinement",
      acceptedAtStateRevision: 9,
      admissionEventId: "event-r2",
      sourceDraftId: "draft-1",
      sourceDraftDigest: "digest-1",
    })).not.toThrow();

    expect(() => assertValidProgramRevision({
      programRevisionId: asProgramRevisionId("revision-33"),
      parentProgramRevisionId: rootRevisionId,
      ordinal: 33,
      changeClass: "correction",
      acceptedAtStateRevision: 40,
      admissionEventId: "event-r33",
      sourceDraftId: "draft-33",
      sourceDraftDigest: "digest-33",
    })).toThrow(/exceeds 32/);
  });

  it("rejects semantic diagnostics over the frozen byte limit", () => {
    expect(() => assertSemanticRationaleWithinLimit("x".repeat(PROGRAM_LIMITS.semanticRationaleBytes))).not.toThrow();
    expect(() => assertSemanticRationaleWithinLimit("x".repeat(PROGRAM_LIMITS.semanticRationaleBytes + 1)))
      .toThrow(ProgramInvariantError);
  });
});
