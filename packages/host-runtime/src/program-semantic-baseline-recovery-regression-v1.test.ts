import { describe, expect, it } from "vitest";
import type { PersistedDomainEvent } from "@alcode/events";
import {
  asProgramRevisionId,
  asProgramStateId,
  asProgramWorkItemId,
  type ProgramSemanticStateV1,
  type WorkAuthorityEnvelopeV1,
} from "@alcode/program-state";
import { planningCanonicalDigest } from "./planning-read.ts";
import {
  PROGRAM_SEMANTIC_BASELINE_DRAFT_PROFILE,
  programSemanticBaselineIdentityImpactV1,
  type ProgramSemanticBaselineDraftV1,
} from "./program-semantic-baseline-kernel.ts";
import {
  ProgramSemanticRecoveryError,
  recoverProgramSemanticStateV1,
} from "./program-semantic-recovery-v1.ts";

const programStateId = asProgramStateId("018f0000-0000-7000-8000-000000000f31");
const revisionId = asProgramRevisionId("baseline-recovery-r1");
const workItemId = asProgramWorkItemId("baseline-recovery-work");
const sessionId = "018f0000-0000-7000-8000-000000000f32";
const adoptionEventId = "018f0000-0000-7000-8000-000000000f33";

function authority(): WorkAuthorityEnvelopeV1 {
  return {
    objectiveBoundaryRef: {
      programStateId,
      rootProgramRevisionId: revisionId,
      anchorWorkItemId: workItemId,
    },
    allowedRepositoryRoots: ["."],
    allowedEffectClasses: ["fs.read"],
    allowedExternalSystems: [],
    capabilityCeiling: ["read"],
    maximumTopologyExpansion: 1,
    mandatoryVerificationIds: [],
    forbiddenChangeKinds: ["delete_repository"],
  };
}

function persisted(
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
  eventId: string,
): PersistedDomainEvent<string, unknown> {
  return {
    eventId,
    sequence,
    workspaceId: "018f0000-0000-7000-8000-000000000f34",
    sessionId,
    programStateId: String(programStateId),
    occurredAt: `2026-08-25T13:30:${String(sequence).padStart(2, "0")}.000Z`,
    recordedAt: `2026-08-25T13:30:${String(sequence).padStart(2, "0")}.000Z`,
    type,
    payload,
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "baseline-recovery-regression" },
    eventDigest: String(sequence).padStart(64, "0"),
  } as unknown as PersistedDomainEvent<string, unknown>;
}

describe("A1 semantic baseline recovery invariants", () => {
  it("fails closed when an adopted baseline carries a non-identity RevisionImpact", () => {
    const semanticState: ProgramSemanticStateV1 = {
      programStateId,
      currentRevision: {
        programRevisionId: revisionId,
        parentProgramRevisionId: null,
        ordinal: 1,
        changeClass: "initial",
        acceptedAtStateRevision: 8,
        admissionEventId: adoptionEventId,
        sourceDraftId: null,
        sourceDraftDigest: null,
      },
      workItems: [{
        workItemId,
        creationOrder: 0,
        description: "Preserve baseline identity during recovery",
        dependencyIds: [],
        affectedPaths: ["src/a.ts"],
        workItemGeneration: 1,
        requirementState: "required",
        topologyState: "leaf",
        satisfactionState: "pending",
        parentWorkItemId: null,
        authorityEnvelope: authority(),
      }],
      verification: [],
      verificationBindings: [],
      outputSlots: [],
      productionSteps: [],
    };
    const badImpact = programSemanticBaselineIdentityImpactV1(semanticState);
    badImpact.unchangedWorkItems = [];
    const cut = {
      kind: "program.semantic_baseline.adopted.v1" as const,
      fromProgramStateRevision: 7,
      toProgramStateRevision: 8,
      semanticState,
      revisionImpact: badImpact,
    };
    const body: Omit<ProgramSemanticBaselineDraftV1, "draftDigest"> = {
      profile: PROGRAM_SEMANTIC_BASELINE_DRAFT_PROFILE,
      draftId: "malformed-baseline-draft",
      sourceSessionId: sessionId,
      programStateId: String(programStateId),
      fromProgramStateRevision: 7,
      initialProgramRevisionId: String(revisionId),
      admissionEventId: adoptionEventId,
      cut,
    };
    const draft: ProgramSemanticBaselineDraftV1 = {
      ...body,
      draftDigest: planningCanonicalDigest(body),
    };
    const events = [
      persisted(1, "program.semantic_baseline.draft.sealed.v1", { draft }, "018f0000-0000-7000-8000-000000000f35"),
      persisted(2, "program.semantic_baseline.adopted.v1", {
        cut,
        draftId: draft.draftId,
        draftDigest: draft.draftDigest,
      }, adoptionEventId),
    ];

    expect(() => recoverProgramSemanticStateV1(events, String(programStateId))).toThrow(ProgramSemanticRecoveryError);
    expect(() => recoverProgramSemanticStateV1(events, String(programStateId))).toThrow(/identity RevisionImpact/);
  });
});
