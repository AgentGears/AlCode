import { describe, expect, it } from "vitest";
import type { PublicProgram } from "@alcode/application-protocol";
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
import {
  ProgramAdaptiveApplicationPortV1,
  projectAdaptiveProgramForApplicationV1,
} from "./program-adaptive-application-projection-v1.ts";
import type { ProgramApplicationPortV1 } from "./program-application.ts";
import {
  ProgramSemanticRecoveryRegistryV1,
  type ProgramSemanticRecoverySnapshotV1,
} from "./program-semantic-recovery-v1.ts";

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

function recoveredFixture(): ProgramSemanticRecoverySnapshotV1 {
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
  return {
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
}

describe("A1 adaptive Application projection byte budget", () => {
  it("clips projected WorkItems against the serialized byte budget and reports exact omissions", () => {
    const recovered = recoveredFixture();
    const projection = projectAdaptiveProgramForApplicationV1(recovered);
    const bytes = new TextEncoder().encode(canonicalStringify(projection)).byteLength;

    expect(bytes).toBeLessThanOrEqual(PROGRAM_LIMITS.applicationProgramProjectionBytes);
    expect(projection.workItems.length).toBeGreaterThan(0);
    expect(projection.workItems.length).toBeLessThan(recovered.semanticState.workItems.length);
    expect(projection.omissions.workItems).toBe(recovered.semanticState.workItems.length - projection.workItems.length);
  });

  it("reserves the shared byte budget for existing Application fields when composing adaptive semantics", async () => {
    const recovered = recoveredFixture();
    const standalone = projectAdaptiveProgramForApplicationV1(recovered);
    const baseProgram = {
      programStateId: String(programStateId),
      revision: 1,
      objective: "objective-".repeat(450),
      lifecycle: "active",
      attachedSessionIds: ["session-1"],
      workItems: Array.from({ length: 16 }, (_, index) => ({
        workItemId: `legacy-work-${index}`,
        lifecycle: "pending",
        description: `legacy-${index}-${"y".repeat(1000)}`,
      })),
      blockers: [],
      verification: [],
      control: { rebaseRequired: false, executionBaseUnavailable: false },
      uncertainty: { outstandingOperations: 0, indeterminateEffects: 0, unresolvedReconciliation: 0 },
      omissions: { workItems: 0, blockers: 0, verification: 0, attachedSessions: 0 },
    } as PublicProgram;
    const base: ProgramApplicationPortV1 = {
      async execute() { return { decision: "noop" }; },
      async getSnapshot() {
        return {
          programs: [baseProgram],
          pendingProgramCreations: [{
            draftId: "pending-creation",
            draftDigest: "pending-digest",
            objective: "pending-".repeat(500),
            sourceSessionId: "session-1",
            status: "pending",
          }],
          programOmissions: { programs: 0, pendingCreations: 0 },
        };
      },
    };
    const recovery = {
      async current(id: string) { return id === String(programStateId) ? recovered : undefined; },
      async isAdaptive(id: string) { return id === String(programStateId); },
    } as unknown as ProgramSemanticRecoveryRegistryV1;
    const port = new ProgramAdaptiveApplicationPortV1(base, recovery);

    const snapshot = await port.getAdaptiveSnapshot("session-1");
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
    const adaptive = snapshot.programs[0]?.adaptiveSemantic;

    expect(bytes).toBeLessThanOrEqual(PROGRAM_LIMITS.applicationProgramProjectionBytes);
    expect(adaptive).toBeDefined();
    expect(adaptive!.workItems.length).toBeLessThan(standalone.workItems.length);
    expect(adaptive!.omissions.workItems).toBe(recovered.semanticState.workItems.length - adaptive!.workItems.length);
  });
});
