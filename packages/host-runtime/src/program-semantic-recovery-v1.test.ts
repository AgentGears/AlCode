import { describe, expect, it } from "vitest";
import {
  asProgramStateId as asEventProgramStateId,
  asSessionId,
  asWorkspaceId,
  mkEventId,
  type EventDraft,
  type PersistedDomainEvent,
} from "@alcode/events";
import {
  asProgramRevisionId,
  asProgramStateId,
  asProgramWorkItemId,
  createProgramSemanticRevisionCutV1,
  type ProgramSemanticRevisionEditV1,
  type ProgramSemanticStateV1,
  type ProgramSemanticWorkItemV1,
  type WorkAuthorityEnvelopeV1,
} from "@alcode/program-state";
import { planningCanonicalDigest } from "./planning-read.ts";
import {
  PROGRAM_SEMANTIC_BASELINE_DRAFT_PROFILE,
  programSemanticBaselineIdentityImpactV1,
  type ProgramSemanticBaselineDraftV1,
} from "./program-semantic-baseline-kernel.ts";
import { projectAdaptiveProgramForApplicationV1 } from "./program-adaptive-application-projection-v1.ts";
import {
  recoverProgramSemanticStateV1,
  ProgramSemanticRecoveryError,
} from "./program-semantic-recovery-v1.ts";
import {
  PROGRAM_SEMANTIC_REVISION_DRAFT_PROFILE,
  type ProgramSemanticRevisionDraftV1,
} from "./program-revision.ts";

const workspaceId = asWorkspaceId("018f0000-0000-7000-8000-000000000e01");
const sessionId = asSessionId("018f0000-0000-7000-8000-000000000e02");
const programStateId = asProgramStateId("018f0000-0000-7000-8000-000000000e03");
const workItemId = asProgramWorkItemId("recovery-work");
const r1 = asProgramRevisionId("recovery-r1");
const r2 = asProgramRevisionId("recovery-r2");
const r3 = asProgramRevisionId("recovery-r3");

function envelope(): WorkAuthorityEnvelopeV1 {
  return {
    objectiveBoundaryRef: {
      programStateId,
      rootProgramRevisionId: r1,
      anchorWorkItemId: workItemId,
    },
    allowedRepositoryRoots: ["."],
    allowedEffectClasses: ["fs.read", "fs.write"],
    allowedExternalSystems: [],
    capabilityCeiling: ["edit", "read"],
    maximumTopologyExpansion: 8,
    mandatoryVerificationIds: [],
    forbiddenChangeKinds: ["delete_repository"],
  };
}

function work(generation: number, affectedPaths: string[]): ProgramSemanticWorkItemV1 {
  return {
    workItemId,
    creationOrder: 0,
    description: "Recover adaptive semantic work deterministically",
    dependencyIds: [],
    affectedPaths,
    workItemGeneration: generation,
    requirementState: "required",
    topologyState: "leaf",
    satisfactionState: "pending",
    parentWorkItemId: null,
    authorityEnvelope: envelope(),
  };
}

function persisted(
  sequence: number,
  draft: EventDraft<string, unknown>,
): PersistedDomainEvent<string, unknown> {
  return {
    ...draft,
    sequence,
    recordedAt: draft.occurredAt,
    eventDigest: String(sequence).padStart(64, "0"),
  };
}

function event(
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
  eventId = mkEventId(),
): PersistedDomainEvent<string, unknown> {
  return persisted(sequence, {
    eventId,
    workspaceId,
    sessionId,
    programStateId: asEventProgramStateId(String(programStateId)),
    occurredAt: `2026-08-25T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    type,
    payload,
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "semantic-recovery-test" },
  });
}

function baselineFixture(): {
  semanticState: ProgramSemanticStateV1;
  draft: ProgramSemanticBaselineDraftV1;
  events: PersistedDomainEvent<string, unknown>[];
} {
  const admissionEventId = mkEventId();
  const semanticState: ProgramSemanticStateV1 = {
    programStateId,
    currentRevision: {
      programRevisionId: r1,
      parentProgramRevisionId: null,
      ordinal: 1,
      changeClass: "initial",
      acceptedAtStateRevision: 8,
      admissionEventId: String(admissionEventId),
      sourceDraftId: null,
      sourceDraftDigest: null,
    },
    workItems: [work(1, ["src/a.ts", "src/shared.ts"])],
    verification: [],
    verificationBindings: [],
    outputSlots: [],
    productionSteps: [],
  };
  const cut = {
    kind: "program.semantic_baseline.adopted.v1" as const,
    fromProgramStateRevision: 7,
    toProgramStateRevision: 8,
    semanticState,
    revisionImpact: programSemanticBaselineIdentityImpactV1(semanticState),
  };
  const body: Omit<ProgramSemanticBaselineDraftV1, "draftDigest"> = {
    profile: PROGRAM_SEMANTIC_BASELINE_DRAFT_PROFILE,
    draftId: "baseline-draft",
    sourceSessionId: String(sessionId),
    programStateId: String(programStateId),
    fromProgramStateRevision: 7,
    initialProgramRevisionId: String(r1),
    admissionEventId: String(admissionEventId),
    cut,
  };
  const draft: ProgramSemanticBaselineDraftV1 = { ...body, draftDigest: planningCanonicalDigest(body) };
  return {
    semanticState,
    draft,
    events: [
      event(1, "program.semantic_baseline.draft.sealed.v1", { draft }),
      event(2, "program.semantic_baseline.adopted.v1", {
        cut,
        draftId: draft.draftId,
        draftDigest: draft.draftDigest,
      }, admissionEventId),
    ],
  };
}

function edit(fromGeneration: number, toGeneration: number, path: string): ProgramSemanticRevisionEditV1 {
  return {
    workItems: [work(toGeneration, [path])],
    identityDecisions: [{
      workItemId,
      fromGeneration,
      disposition: "preserve_identity_and_advance_generation",
      successorWorkItemId: null,
    }],
    verification: [],
    verificationBindings: [],
    outputSlots: [],
    productionSteps: [],
  };
}

function revisionFixture(
  previous: ProgramSemanticStateV1,
  fromProgramStateRevision: number,
  nextProgramRevisionId: ReturnType<typeof asProgramRevisionId>,
  revisionEdit: ProgramSemanticRevisionEditV1,
  draftId: string,
  planningEpisodeId: string,
) {
  const admissionEventId = mkEventId();
  const placeholder = createProgramSemanticRevisionCutV1(previous, {
    currentProgramStateRevision: fromProgramStateRevision,
    nextRevision: {
      programRevisionId: nextProgramRevisionId,
      parentProgramRevisionId: previous.currentRevision.programRevisionId,
      ordinal: previous.currentRevision.ordinal + 1,
      changeClass: "refinement",
      acceptedAtStateRevision: fromProgramStateRevision + 1,
      admissionEventId: String(admissionEventId),
      sourceDraftId: draftId,
      sourceDraftDigest: "placeholder",
    },
    edit: revisionEdit,
    activeAttempt: null,
  });
  const body: Omit<ProgramSemanticRevisionDraftV1, "draftDigest"> = {
    profile: PROGRAM_SEMANTIC_REVISION_DRAFT_PROFILE,
    draftId,
    planningEpisodeId,
    sourceSessionId: String(sessionId),
    programStateId: String(programStateId),
    fromProgramStateRevision,
    parentProgramRevisionId: String(previous.currentRevision.programRevisionId),
    nextProgramRevisionId: String(nextProgramRevisionId),
    changeClass: "refinement",
    admissionEventId: String(admissionEventId),
    edit: revisionEdit,
    activeAttempt: null,
    revisionImpact: placeholder.revisionImpact,
  };
  const draft: ProgramSemanticRevisionDraftV1 = { ...body, draftDigest: planningCanonicalDigest(body) };
  const cut = createProgramSemanticRevisionCutV1(previous, {
    currentProgramStateRevision: fromProgramStateRevision,
    nextRevision: {
      programRevisionId: nextProgramRevisionId,
      parentProgramRevisionId: previous.currentRevision.programRevisionId,
      ordinal: previous.currentRevision.ordinal + 1,
      changeClass: "refinement",
      acceptedAtStateRevision: fromProgramStateRevision + 1,
      admissionEventId: String(admissionEventId),
      sourceDraftId: draftId,
      sourceDraftDigest: draft.draftDigest,
    },
    edit: revisionEdit,
    activeAttempt: null,
  });
  return { draft, cut, admissionEventId };
}

describe("A1 adaptive semantic recovery and Application projection", () => {
  it("rebuilds exact baseline + revision lineage and pending/accepted draft control without model inference", () => {
    const baseline = baselineFixture();
    const revision = revisionFixture(baseline.semanticState, 8, r2, edit(1, 2, "src/a.ts"), "revision-draft-1", "episode-1");
    const pending = revisionFixture(revision.cut.nextSemanticState, 9, r3, edit(2, 3, "src/a.ts"), "revision-draft-2", "episode-2");
    const events = [
      ...baseline.events,
      event(3, "program.semantic_revision.draft.sealed.v1", { draft: revision.draft }),
      event(4, "program.semantic_revision.admitted.v1", {
        cut: revision.cut,
        draftId: revision.draft.draftId,
        draftDigest: revision.draft.draftDigest,
      }, revision.admissionEventId),
      event(5, "program.semantic_revision.draft.sealed.v1", { draft: pending.draft }),
    ];

    const recovered = recoverProgramSemanticStateV1(events, String(programStateId));
    expect(recovered).toBeDefined();
    expect(recovered).toMatchObject({ programStateRevision: 9 });
    expect(recovered!.semanticState.currentRevision).toMatchObject({
      programRevisionId: r2,
      parentProgramRevisionId: r1,
      ordinal: 2,
      changeClass: "refinement",
    });
    expect(recovered!.lineage.map((item) => item.programRevisionId)).toEqual([String(r1), String(r2)]);
    expect(recovered!.drafts).toEqual(expect.arrayContaining([
      expect.objectContaining({ draftId: "revision-draft-1", status: "accepted" }),
      expect.objectContaining({ draftId: "revision-draft-2", status: "pending" }),
    ]));
    expect(recovered!.pendingDraft).toMatchObject({ draftId: "revision-draft-2", parentProgramRevisionId: String(r2) });

    const projection = projectAdaptiveProgramForApplicationV1(recovered!);
    expect(projection).toMatchObject({
      currentProgramRevisionId: String(r2),
      currentProgramRevisionOrdinal: 2,
      changeClass: "refinement",
      pendingSemanticDraft: { draftId: "revision-draft-2" },
    });
    expect(projection.workItems[0]).toMatchObject({
      workItemId: String(workItemId),
      workItemGeneration: 2,
      requirementState: "required",
      topologyState: "leaf",
      satisfactionState: "pending",
    });
  });

  it("reconstructs invalidated draft state and never treats it as pending meaning", () => {
    const baseline = baselineFixture();
    const pending = revisionFixture(baseline.semanticState, 8, r2, edit(1, 2, "src/a.ts"), "invalidated-draft", "episode-x");
    const events = [
      ...baseline.events,
      event(3, "program.semantic_revision.draft.sealed.v1", { draft: pending.draft }),
      event(4, "program.semantic_revision.draft.invalidated.v1", {
        draftId: pending.draft.draftId,
        draftDigest: pending.draft.draftDigest,
        reason: "stale_parent",
      }),
    ];
    const recovered = recoverProgramSemanticStateV1(events, String(programStateId));
    expect(recovered!.pendingDraft).toBeNull();
    expect(recovered!.drafts).toContainEqual(expect.objectContaining({
      draftId: "invalidated-draft",
      status: "invalidated",
    }));
    expect(recovered!.semanticState.currentRevision.programRevisionId).toBe(r1);
  });

  it("fails replay closed when canonical semantic-cut ordering/currentness is tampered", () => {
    const baseline = baselineFixture();
    const revision = revisionFixture(baseline.semanticState, 8, r2, edit(1, 2, "src/a.ts"), "tampered-draft", "episode-t");
    const tampered = structuredClone(revision.cut);
    tampered.fromProgramStateRevision = 99;
    const events = [
      ...baseline.events,
      event(3, "program.semantic_revision.draft.sealed.v1", { draft: revision.draft }),
      event(4, "program.semantic_revision.admitted.v1", {
        cut: tampered,
        draftId: revision.draft.draftId,
        draftDigest: revision.draft.draftDigest,
      }, revision.admissionEventId),
    ];
    expect(() => recoverProgramSemanticStateV1(events, String(programStateId))).toThrow();
  });

  it("rejects semantic revision control history that exists without explicit baseline adoption", () => {
    expect(() => recoverProgramSemanticStateV1([
      event(1, "program.semantic_revision.draft.invalidated.v1", { draftId: "x", draftDigest: "y" }),
    ], String(programStateId))).toThrow(ProgramSemanticRecoveryError);
  });
});
