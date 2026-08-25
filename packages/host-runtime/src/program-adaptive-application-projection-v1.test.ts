import { describe, expect, it } from "vitest";
import {
  PROGRAM_LIMITS,
  asProgramRevisionId,
  asProgramStateId,
  asProgramWorkItemId,
  canonicalStringify,
  type ProgramSemanticStateV1,
  type ProgramSemanticWorkItemV1,
  type RevisionImpactV1,
} from "@alcode/program-state";
import { projectAdaptiveProgramForApplicationV1 } from "./program-adaptive-application-projection-v1.ts";
import type { ProgramSemanticRecoverySnapshotV1 } from "./program-semantic-recovery-v1.ts";

const programStateId = asProgramStateId("018f0000-0000-7000-8000-000000000f01");
const programRevisionId = asProgramRevisionId("projection-byte-budget-r1");

function largeWork(index: number): ProgramSemanticWorkItemV1 {
  const workItemId = asProgramWorkItemId(`projection-byte-budget-work-${index}`);
  return {
    workItemId,
    creationOrder: index,
    description: `Projection byte-budget work ${index}`,
    dependencyIds: [],
    affectedPaths: [],
    workItemGeneration: 1,
    requirementState: "required",
    topologyState: "leaf",
    satisfactionState: "pending",
    parentWorkItemId: null,
    authorityEnvelope: {
      objectiveBoundaryRef: {
        programStateId,
        rootProgramRevisionId: programRevisionId,
        anchorWorkItemId: workItemId,
      },
      allowedRepositoryRoots: [`src/${index}/${"x".repeat(7900)}`],
      allowedEffectClasses: [],
      allowedExternalSystems: [],
      capabilityCeiling: [],
      maximumTopologyExpansion: 0,
      mandatoryVerificationIds: [],
      forbiddenChangeKinds: [],
    },
  };
}

function identityImpact(state: ProgramSemanticStateV1): RevisionImpactV1 {
  return {
    fromProgramRevisionId: programRevisionId,
    toProgramRevisionId: programRevisionId,
    unchangedWorkItems: state.workItems.map((work) => ({
      workItemId: work.workItemId,
      generation: work.workItemGeneration,
    })),
    modifiedWorkItems: [],
    addedWorkItems: [],
    supersededWorkItems: [],
    withdrawnWorkItems: [],
    retainedAttempts: [],
    invalidatedAttempts: [],
    retainedVerification: [],
    staleVerification: [],
    addedVerification: [],
    reboundVerification: [],
    retiredVerification: [],
    retainedOutputs: [],
    addedOutputs: [],
    modifiedOutputs: [],
    retiredOutputs: [],
  };
}

describe("A1 adaptive Application projection byte budget", () => {
  it("clips projected WorkItems against the serialized byte budget and reports exact omissions", () => {
    const semanticState: ProgramSemanticStateV1 = {
      programStateId,
      currentRevision: {
        programRevisionId,
        parentProgramRevisionId: null,
        ordinal: 1,
        changeClass: "initial",
        acceptedAtStateRevision: 1,
        admissionEventId: "projection-byte-budget-admission",
        sourceDraftId: null,
        sourceDraftDigest: null,
      },
      workItems: Array.from({ length: 32 }, (_, index) => largeWork(index)),
      verification: [],
      verificationBindings: [],
      outputSlots: [],
      productionSteps: [],
    };
    const impact = identityImpact(semanticState);
    const recovered: ProgramSemanticRecoverySnapshotV1 = {
      programStateId: String(programStateId),
      sourceEventSequence: 1,
      programStateRevision: 1,
      semanticState,
      lineage: [],
      drafts: [],
      pendingDraft: null,
      latestRevisionImpact: impact,
      latestAttemptDisposition: {
        retainedAttemptIds: [],
        invalidatedAttemptIds: [],
      },
    };

    const projection = projectAdaptiveProgramForApplicationV1(recovered);
    const bytes = new TextEncoder().encode(canonicalStringify(projection)).byteLength;

    expect(bytes).toBeLessThanOrEqual(PROGRAM_LIMITS.applicationProgramProjectionBytes);
    expect(projection.workItems.length).toBeGreaterThan(0);
    expect(projection.workItems.length).toBeLessThan(semanticState.workItems.length);
    expect(projection.omissions.workItems).toBe(semanticState.workItems.length - projection.workItems.length);
  });
});
