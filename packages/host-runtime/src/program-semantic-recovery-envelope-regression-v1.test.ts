import { describe, expect, it } from "vitest";
import type { PersistedDomainEvent } from "@alcode/events";
import {
  asProgramRevisionId,
  asProgramStateId,
  createProgramSemanticRevisionCutV1,
  type ProgramSemanticStateV1,
} from "@alcode/program-state";
import { planningCanonicalDigest } from "./planning-read.ts";
import {
  PROGRAM_SEMANTIC_BASELINE_DRAFT_PROFILE,
  programSemanticBaselineIdentityImpactV1,
  type ProgramSemanticBaselineDraftV1,
} from "./program-semantic-baseline-kernel.ts";
import {
  PROGRAM_SEMANTIC_REVISION_DRAFT_PROFILE,
  type ProgramSemanticRevisionDraftV1,
} from "./program-revision.ts";
import {
  ProgramSemanticRecoveryError,
  recoverProgramSemanticStateV1,
} from "./program-semantic-recovery-v1.ts";

const programA = asProgramStateId("018f0000-0000-7000-8000-000000000fa1");
const programB = asProgramStateId("018f0000-0000-7000-8000-000000000fb1");
const revision1 = asProgramRevisionId("envelope-r1");
const revision2 = asProgramRevisionId("envelope-r2");
const sessionId = "018f0000-0000-7000-8000-000000000fc1";

function persisted(
  sequence: number,
  type: string,
  eventProgramStateId: string,
  payload: Record<string, unknown>,
  eventId: string,
): PersistedDomainEvent<string, unknown> {
  return {
    eventId,
    sequence,
    workspaceId: "018f0000-0000-7000-8000-000000000fd1",
    sessionId,
    programStateId: eventProgramStateId,
    occurredAt: `2026-08-25T14:30:${String(sequence).padStart(2, "0")}.000Z`,
    recordedAt: `2026-08-25T14:30:${String(sequence).padStart(2, "0")}.000Z`,
    type,
    payload,
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "semantic-recovery-envelope-regression" },
    eventDigest: String(sequence).padStart(64, "0"),
  } as unknown as PersistedDomainEvent<string, unknown>;
}

function baseline(): {
  state: ProgramSemanticStateV1;
  events: PersistedDomainEvent<string, unknown>[];
} {
  const admissionEventId = "018f0000-0000-7000-8000-000000000fe1";
  const state: ProgramSemanticStateV1 = {
    programStateId: programA,
    currentRevision: {
      programRevisionId: revision1,
      parentProgramRevisionId: null,
      ordinal: 1,
      changeClass: "initial",
      acceptedAtStateRevision: 8,
      admissionEventId,
      sourceDraftId: null,
      sourceDraftDigest: null,
    },
    workItems: [],
    verification: [],
    verificationBindings: [],
    outputSlots: [],
    productionSteps: [],
  };
  const cut = {
    kind: "program.semantic_baseline.adopted.v1" as const,
    fromProgramStateRevision: 7,
    toProgramStateRevision: 8,
    semanticState: state,
    revisionImpact: programSemanticBaselineIdentityImpactV1(state),
  };
  const body: Omit<ProgramSemanticBaselineDraftV1, "draftDigest"> = {
    profile: PROGRAM_SEMANTIC_BASELINE_DRAFT_PROFILE,
    draftId: "envelope-baseline-draft",
    sourceSessionId: sessionId,
    programStateId: String(programA),
    fromProgramStateRevision: 7,
    initialProgramRevisionId: String(revision1),
    admissionEventId,
    cut,
  };
  const draft: ProgramSemanticBaselineDraftV1 = { ...body, draftDigest: planningCanonicalDigest(body) };
  return {
    state,
    events: [
      persisted(1, "program.semantic_baseline.draft.sealed.v1", String(programA), { draft }, "018f0000-0000-7000-8000-000000000fe2"),
      persisted(2, "program.semantic_baseline.adopted.v1", String(programA), {
        cut,
        draftId: draft.draftId,
        draftDigest: draft.draftDigest,
      }, admissionEventId),
    ],
  };
}

function revisionDraft(previous: ProgramSemanticStateV1): ProgramSemanticRevisionDraftV1 {
  const draftId = "cross-program-draft";
  const admissionEventId = "018f0000-0000-7000-8000-000000000fe3";
  const edit = {
    workItems: [],
    identityDecisions: [],
    verification: [],
    verificationBindings: [],
    outputSlots: [],
    productionSteps: [],
  };
  const placeholder = createProgramSemanticRevisionCutV1(previous, {
    currentProgramStateRevision: 8,
    nextRevision: {
      programRevisionId: revision2,
      parentProgramRevisionId: revision1,
      ordinal: 2,
      changeClass: "refinement",
      acceptedAtStateRevision: 9,
      admissionEventId,
      sourceDraftId: draftId,
      sourceDraftDigest: "placeholder",
    },
    edit,
    activeAttempt: null,
  });
  const body: Omit<ProgramSemanticRevisionDraftV1, "draftDigest"> = {
    profile: PROGRAM_SEMANTIC_REVISION_DRAFT_PROFILE,
    draftId,
    planningEpisodeId: "cross-program-episode",
    sourceSessionId: sessionId,
    programStateId: String(programA),
    fromProgramStateRevision: 8,
    parentProgramRevisionId: String(revision1),
    nextProgramRevisionId: String(revision2),
    changeClass: "refinement",
    admissionEventId,
    edit,
    activeAttempt: null,
    revisionImpact: placeholder.revisionImpact,
  };
  return { ...body, draftDigest: planningCanonicalDigest(body) };
}

describe("A1 semantic recovery event-envelope ownership", () => {
  it("rejects a Program A sealed draft persisted under Program B's event envelope", () => {
    const base = baseline();
    const draft = revisionDraft(base.state);
    const events = [
      ...base.events,
      persisted(
        3,
        "program.semantic_revision.draft.sealed.v1",
        String(programB),
        { draft },
        "018f0000-0000-7000-8000-000000000fe4",
      ),
    ];

    expect(() => recoverProgramSemanticStateV1(events, String(programA))).toThrow(ProgramSemanticRecoveryError);
    expect(() => recoverProgramSemanticStateV1(events, String(programA))).toThrow(/event envelope/);
  });
});
