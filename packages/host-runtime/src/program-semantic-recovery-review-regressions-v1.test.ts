import { describe, expect, it } from "vitest";
import {
  PROGRAM_REVISION_CAPABILITY,
  PROGRAM_REVISION_MESSAGE_VERSION,
  PROGRAM_STATE_V2_CAPABILITY,
  createInMemoryTransportPair,
  type AgentToHostMessageV2Aware,
  type HostToAgentMessageV2Aware,
  type ProgramRevisionProposalWireV1,
} from "@alcode/agent-protocol";
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
import type { PersistedDomainEvent } from "@alcode/events";
import type { WorkspaceEventStore } from "@alcode/storage";
import type { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { planningCanonicalDigest } from "./planning-read.ts";
import {
  PROGRAM_SEMANTIC_BASELINE_DRAFT_PROFILE,
  programSemanticBaselineIdentityImpactV1,
  type ProgramSemanticBaselineDraftV1,
} from "./program-semantic-baseline-kernel.ts";
import {
  PROGRAM_SEMANTIC_REVISION_DRAFT_PROFILE,
  ProgramRevisionControlServiceV1,
  type ProgramSemanticRevisionDraftV1,
} from "./program-revision.ts";
import { ProgramRevisionProtocolHostV1 } from "./program-revision-protocol-v1.ts";
import {
  ProgramSemanticRecoveryError,
  recoverProgramSemanticStateV1,
} from "./program-semantic-recovery-v1.ts";

const programStateId = asProgramStateId("018f0000-0000-7000-8000-000000000f01");
const workItemId = asProgramWorkItemId("review-regression-work");
const r1 = asProgramRevisionId("review-regression-r1");
const r2 = asProgramRevisionId("review-regression-r2");
const r3 = asProgramRevisionId("review-regression-r3");

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
    description: "Review-regression semantic work",
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

function persisted(
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
  eventId: string,
): PersistedDomainEvent<string, unknown> {
  return {
    eventId,
    sequence,
    workspaceId: "018f0000-0000-7000-8000-000000000f02",
    sessionId: "018f0000-0000-7000-8000-000000000f03",
    programStateId: String(programStateId),
    occurredAt: `2026-08-25T13:00:${String(sequence).padStart(2, "0")}.000Z`,
    recordedAt: `2026-08-25T13:00:${String(sequence).padStart(2, "0")}.000Z`,
    type,
    payload,
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "review-regression-test" },
    eventDigest: String(sequence).padStart(64, "0"),
  } as unknown as PersistedDomainEvent<string, unknown>;
}

function baselineFixture(): {
  semanticState: ProgramSemanticStateV1;
  draft: ProgramSemanticBaselineDraftV1;
  events: PersistedDomainEvent<string, unknown>[];
} {
  const admissionEventId = "018f0000-0000-7000-8000-000000000f04";
  const semanticState: ProgramSemanticStateV1 = {
    programStateId,
    currentRevision: {
      programRevisionId: r1,
      parentProgramRevisionId: null,
      ordinal: 1,
      changeClass: "initial",
      acceptedAtStateRevision: 8,
      admissionEventId,
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
    draftId: "review-baseline-draft",
    sourceSessionId: "018f0000-0000-7000-8000-000000000f03",
    programStateId: String(programStateId),
    fromProgramStateRevision: 7,
    initialProgramRevisionId: String(r1),
    admissionEventId,
    cut,
  };
  const draft: ProgramSemanticBaselineDraftV1 = { ...body, draftDigest: planningCanonicalDigest(body) };
  return {
    semanticState,
    draft,
    events: [
      persisted(1, "program.semantic_baseline.draft.sealed.v1", { draft }, "018f0000-0000-7000-8000-000000000f05"),
      persisted(2, "program.semantic_baseline.adopted.v1", {
        cut,
        draftId: draft.draftId,
        draftDigest: draft.draftDigest,
      }, admissionEventId),
    ],
  };
}

function revisionFixture(
  previous: ProgramSemanticStateV1,
  fromProgramStateRevision: number,
  nextProgramRevisionId: ReturnType<typeof asProgramRevisionId>,
  revisionEdit: ProgramSemanticRevisionEditV1,
  draftId: string,
  planningEpisodeId: string,
  admissionEventId: string,
): { draft: ProgramSemanticRevisionDraftV1; cut: ReturnType<typeof createProgramSemanticRevisionCutV1> } {
  const placeholder = createProgramSemanticRevisionCutV1(previous, {
    currentProgramStateRevision: fromProgramStateRevision,
    nextRevision: {
      programRevisionId: nextProgramRevisionId,
      parentProgramRevisionId: previous.currentRevision.programRevisionId,
      ordinal: previous.currentRevision.ordinal + 1,
      changeClass: "refinement",
      acceptedAtStateRevision: fromProgramStateRevision + 1,
      admissionEventId,
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
    sourceSessionId: "018f0000-0000-7000-8000-000000000f03",
    programStateId: String(programStateId),
    fromProgramStateRevision,
    parentProgramRevisionId: String(previous.currentRevision.programRevisionId),
    nextProgramRevisionId: String(nextProgramRevisionId),
    changeClass: "refinement",
    admissionEventId,
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
      admissionEventId,
      sourceDraftId: draftId,
      sourceDraftDigest: draft.draftDigest,
    },
    edit: revisionEdit,
    activeAttempt: null,
  });
  return { draft, cut };
}

function proposal(sessionId: string, requestId: string): ProgramRevisionProposalWireV1 {
  return {
    type: "program.revision.proposal",
    version: PROGRAM_REVISION_MESSAGE_VERSION,
    requestId,
    sessionId,
    planningEpisodeId: `episode-${requestId}`,
    programStateId: String(programStateId),
    parentProgramRevisionId: String(r1),
    proposedChangeClass: "refinement",
    proposedEdit: { workItems: [] },
  };
}

describe("A1-6B review regressions", () => {
  it("replays semantic admissions across operational whole-state revision gaps", () => {
    const baseline = baselineFixture();
    const first = revisionFixture(
      baseline.semanticState,
      8,
      r2,
      edit(1, 2, "src/a.ts"),
      "review-draft-1",
      "review-episode-1",
      "018f0000-0000-7000-8000-000000000f06",
    );
    const second = revisionFixture(
      first.cut.nextSemanticState,
      12,
      r3,
      edit(2, 3, "src/a.ts"),
      "review-draft-2",
      "review-episode-2",
      "018f0000-0000-7000-8000-000000000f07",
    );
    const events = [
      ...baseline.events,
      persisted(3, "program.semantic_revision.draft.sealed.v1", { draft: first.draft }, "018f0000-0000-7000-8000-000000000f08"),
      persisted(4, "program.semantic_revision.admitted.v1", {
        cut: first.cut,
        draftId: first.draft.draftId,
        draftDigest: first.draft.draftDigest,
      }, first.draft.admissionEventId),
      persisted(5, "program.semantic_revision.draft.sealed.v1", { draft: second.draft }, "018f0000-0000-7000-8000-000000000f09"),
      persisted(6, "program.semantic_revision.admitted.v1", {
        cut: second.cut,
        draftId: second.draft.draftId,
        draftDigest: second.draft.draftDigest,
      }, second.draft.admissionEventId),
    ];

    const recovered = recoverProgramSemanticStateV1(events, String(programStateId));
    expect(recovered?.programStateRevision).toBe(13);
    expect(recovered?.lineage.map((entry) => entry.programRevisionId)).toEqual([String(r1), String(r2), String(r3)]);
  });

  it("rejects an internally valid semantic cut that differs from the exact sealed draft", () => {
    const baseline = baselineFixture();
    const authorized = revisionFixture(
      baseline.semanticState,
      8,
      r2,
      edit(1, 2, "src/a.ts"),
      "review-authorized-draft",
      "review-authorized-episode",
      "018f0000-0000-7000-8000-000000000f10",
    );
    const unauthorizedCut = createProgramSemanticRevisionCutV1(baseline.semanticState, {
      currentProgramStateRevision: authorized.draft.fromProgramStateRevision,
      nextRevision: {
        programRevisionId: r2,
        parentProgramRevisionId: r1,
        ordinal: 2,
        changeClass: "refinement",
        acceptedAtStateRevision: 9,
        admissionEventId: authorized.draft.admissionEventId,
        sourceDraftId: authorized.draft.draftId,
        sourceDraftDigest: authorized.draft.draftDigest,
      },
      edit: edit(1, 2, "src/shared.ts"),
      activeAttempt: null,
    });
    const events = [
      ...baseline.events,
      persisted(3, "program.semantic_revision.draft.sealed.v1", { draft: authorized.draft }, "018f0000-0000-7000-8000-000000000f11"),
      persisted(4, "program.semantic_revision.admitted.v1", {
        cut: unauthorizedCut,
        draftId: authorized.draft.draftId,
        draftDigest: authorized.draft.draftDigest,
      }, authorized.draft.admissionEventId),
    ];

    expect(() => recoverProgramSemanticStateV1(events, String(programStateId))).toThrow(ProgramSemanticRecoveryError);
    expect(() => recoverProgramSemanticStateV1(events, String(programStateId))).toThrow(/exact digest-sealed draft cut/);
  });

  it("allows a current whole-state CAS revision newer than the latest unchanged semantic head", async () => {
    const baseline = baselineFixture();
    const admitted = revisionFixture(
      baseline.semanticState,
      8,
      r2,
      edit(1, 2, "src/a.ts"),
      "review-currentness-draft",
      "review-currentness-episode",
      "018f0000-0000-7000-8000-000000000f12",
    );
    const canonicalEvent = persisted(1, "program.semantic_revision.admitted.v1", {
      cut: admitted.cut,
      draftId: admitted.draft.draftId,
      draftDigest: admitted.draft.draftDigest,
    }, admitted.draft.admissionEventId);
    const store = {
      async *replay() { yield canonicalEvent; },
    } as unknown as WorkspaceEventStore;
    const admission = {
      enqueue: async <T>(operation: () => Promise<T>): Promise<T> => operation(),
    } as unknown as CanonicalAdmissionQueue;
    const revision = new ProgramRevisionControlServiceV1({
      store,
      admission,
      currentState: {
        current: async () => ({
          programStateRevision: 12,
          semanticState: structuredClone(admitted.cut.nextSemanticState),
          activeAttempt: null,
          lifecycle: "active",
          attachedSessionIds: ["session-review"],
        }),
      },
    });

    await expect(revision.currentPlanningBase(String(programStateId))).resolves.toMatchObject({
      programStateRevision: 12,
      semanticState: { currentRevision: { programRevisionId: r2 } },
    });
  });

  it("resends cached proposal results without resealing a Host draft", async () => {
    const pair = createInMemoryTransportPair<HostToAgentMessageV2Aware, AgentToHostMessageV2Aware>();
    let submitCalls = 0;
    let resultFrames = 0;
    pair.b.onMessage((message) => {
      if (message.type === "program.revision.proposal.result") resultFrames += 1;
    });
    const host = new ProgramRevisionProtocolHostV1({
      planning: {
        async begin() { throw new Error("not used"); },
        cancel() {},
        async submitProposal() {
          submitCalls += 1;
          return { draftId: "cached-draft", draftDigest: "cached-digest" };
        },
      },
    });
    host.attach({
      generationId: "review-connection",
      agentGeneration: 1,
      sessionId: "review-session",
      capabilities: [PROGRAM_STATE_V2_CAPABILITY, PROGRAM_REVISION_CAPABILITY],
      transport: pair.a,
    });
    const message = proposal("review-session", "cached-request");

    await host.handleProposal(message, "review-connection");
    await host.handleProposal(structuredClone(message), "review-connection");
    expect(submitCalls).toBe(1);
    expect(resultFrames).toBe(2);
  });

  it("retains replay records per generation/session instead of globally evicting another active session", async () => {
    const pairOne = createInMemoryTransportPair<HostToAgentMessageV2Aware, AgentToHostMessageV2Aware>();
    const pairTwo = createInMemoryTransportPair<HostToAgentMessageV2Aware, AgentToHostMessageV2Aware>();
    let submitCalls = 0;
    const host = new ProgramRevisionProtocolHostV1({
      planning: {
        async begin() { throw new Error("not used"); },
        cancel() {},
        async submitProposal(input) {
          submitCalls += 1;
          return { draftId: `draft-${input.proposal.requestId}`, draftDigest: `digest-${input.proposal.requestId}` };
        },
      },
    });
    host.attach({
      generationId: "shared-generation",
      agentGeneration: 1,
      sessionId: "scope-session-1",
      capabilities: [PROGRAM_STATE_V2_CAPABILITY, PROGRAM_REVISION_CAPABILITY],
      transport: pairOne.a,
    });
    host.attach({
      generationId: "shared-generation",
      agentGeneration: 1,
      sessionId: "scope-session-2",
      capabilities: [PROGRAM_STATE_V2_CAPABILITY, PROGRAM_REVISION_CAPABILITY],
      transport: pairTwo.a,
    });

    for (let index = 0; index < 65; index += 1) {
      await host.handleProposal(proposal("scope-session-1", `s1-${index}`), "shared-generation");
    }
    for (let index = 0; index < 64; index += 1) {
      await host.handleProposal(proposal("scope-session-2", `s2-${index}`), "shared-generation");
    }
    expect(submitCalls).toBe(129);

    await host.handleProposal(proposal("scope-session-1", "s1-0"), "shared-generation");
    expect(submitCalls).toBe(129);
  });
});
