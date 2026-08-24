import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asProgramAttemptId,
  asProgramRevisionId,
  asProgramStateId,
  asProgramWorkItemId,
  type ProgramAttemptSemanticAssumptionsV1,
  type ProgramSemanticRevisionCutV1,
  type ProgramSemanticRevisionEditV1,
  type ProgramSemanticStateV1,
  type ProgramSemanticWorkItemV1,
  type WorkAuthorityEnvelopeV1,
  type WorkItemIdentityDecisionV1,
} from "@alcode/program-state";
import { openLockedWorkspaceStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import {
  HostProgramRevisionApplicationControlV1,
  ProgramRevisionControlError,
  ProgramRevisionControlServiceV1,
  ProgramRevisionPlanningServiceV1,
  ProgramRevisionStaleError,
  type ProgramRevisionAgentProposalV1,
  type ProgramSemanticCurrentSnapshotV1,
  type ProgramSemanticCurrentStateSourceV1,
} from "./program-revision.ts";
import { HostSessionManager } from "./session-manager.ts";

const programId = asProgramStateId("018f0000-0000-7000-8000-000000000901");
const r1 = asProgramRevisionId("semantic-r1");
const workAId = asProgramWorkItemId("work-a");
const workBId = asProgramWorkItemId("work-b");
const attemptId = asProgramAttemptId("attempt-a");

function envelope(anchorWorkItemId: ReturnType<typeof asProgramWorkItemId> | null = null): WorkAuthorityEnvelopeV1 {
  return {
    objectiveBoundaryRef: {
      programStateId: programId,
      rootProgramRevisionId: r1,
      anchorWorkItemId,
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

function workA(): ProgramSemanticWorkItemV1 {
  return {
    workItemId: workAId,
    creationOrder: 0,
    description: "Implement A",
    dependencyIds: [],
    affectedPaths: ["src/a.ts"],
    workItemGeneration: 1,
    requirementState: "required",
    topologyState: "leaf",
    satisfactionState: "active",
    parentWorkItemId: null,
    authorityEnvelope: envelope(),
  };
}

function workB(generation = 1, affectedPaths = ["src/b.ts", "src/shared.ts"]): ProgramSemanticWorkItemV1 {
  return {
    workItemId: workBId,
    creationOrder: 1,
    description: "Implement B",
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

function baselineSemanticState(): ProgramSemanticStateV1 {
  return {
    programStateId: programId,
    currentRevision: {
      programRevisionId: r1,
      parentProgramRevisionId: null,
      ordinal: 1,
      changeClass: "initial",
      acceptedAtStateRevision: 1,
      admissionEventId: "baseline-admission",
      sourceDraftId: null,
      sourceDraftDigest: null,
    },
    workItems: [workA(), workB()],
    verification: [],
    verificationBindings: [],
    outputSlots: [],
    productionSteps: [],
  };
}

function activeAttempt(): ProgramAttemptSemanticAssumptionsV1 {
  return {
    programAttemptId: attemptId,
    workItemId: workAId,
    workItemGeneration: 1,
    directDependencies: [],
    workAuthorityEnvelope: envelope(),
  };
}

function exactRefinementEdit(): ProgramSemanticRevisionEditV1 {
  const decisions: WorkItemIdentityDecisionV1[] = [
    {
      workItemId: workAId,
      fromGeneration: 1,
      disposition: "unchanged",
      successorWorkItemId: null,
    },
    {
      workItemId: workBId,
      fromGeneration: 1,
      disposition: "preserve_identity_and_advance_generation",
      successorWorkItemId: null,
    },
  ];
  return {
    workItems: [workA(), workB(2, ["src/b.ts"])],
    identityDecisions: decisions,
    verification: [],
    verificationBindings: [],
    outputSlots: [],
    productionSteps: [],
  };
}

function advisoryProposal(planningEpisodeId: string, requestId = "proposal-1"): ProgramRevisionAgentProposalV1 {
  return {
    planningEpisodeId,
    requestId,
    programStateId: String(programId),
    parentProgramRevisionId: String(r1),
    // Intentionally advisory/wrong: the Host canonicalizer below seals a
    // refinement with a different exact edit.
    proposedChangeClass: "correction",
    proposedEdit: {
      workItems: [workA(), workB()],
      identityDecisions: [
        { workItemId: workAId, fromGeneration: 1, disposition: "unchanged", successorWorkItemId: null },
        { workItemId: workBId, fromGeneration: 1, disposition: "unchanged", successorWorkItemId: null },
      ],
      verification: [],
      verificationBindings: [],
      outputSlots: [],
      productionSteps: [],
    },
    rationale: "Narrow B to the path actually required by the objective.",
  };
}

class MutableSemanticSource implements ProgramSemanticCurrentStateSourceV1 {
  snapshot: ProgramSemanticCurrentSnapshotV1;

  constructor(sessionId: string) {
    this.snapshot = {
      programStateRevision: 7,
      semanticState: baselineSemanticState(),
      activeAttempt: activeAttempt(),
      lifecycle: "active",
      attachedSessionIds: [sessionId],
    };
  }

  async current(programStateId: string): Promise<ProgramSemanticCurrentSnapshotV1> {
    if (programStateId !== String(programId)) throw new Error(`unknown program ${programStateId}`);
    return structuredClone(this.snapshot);
  }

  apply(cut: ProgramSemanticRevisionCutV1): void {
    this.snapshot = {
      ...this.snapshot,
      programStateRevision: cut.toProgramStateRevision,
      semanticState: structuredClone(cut.nextSemanticState),
      activeAttempt: cut.revisionImpact.retainedAttempts.includes(attemptId)
        ? this.snapshot.activeAttempt
        : null,
    };
  }
}

async function allEvents(store: { replay(): AsyncIterable<any> }): Promise<any[]> {
  const events: any[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "alcode-program-revision-"));
  const locked = await openLockedWorkspaceStore({
    databasePath: join(dir, "workspace.sqlite"),
    lockPath: join(dir, "workspace.lock"),
    workspaceId: "018f0000-0000-7000-8000-000000000902",
    repositoryId: "program-revision-test",
  });
  const admission = new CanonicalAdmissionQueue(locked.store);
  const sessions = new HostSessionManager(locked, admission);
  const session = await sessions.openOrResume();
  const source = new MutableSemanticSource(String(session.sessionId));
  const revision = new ProgramRevisionControlServiceV1({
    store: locked.store,
    admission,
    currentState: source,
  });
  const application = new HostProgramRevisionApplicationControlV1(revision);
  const planning = new ProgramRevisionPlanningServiceV1({
    revision,
    currentState: source,
    agents: { isCurrent: (_sessionId, connectionGenerationId, agentGeneration) => connectionGenerationId === "connection-1" && agentGeneration === 3 },
    canonicalizer: {
      canonicalize: () => ({ changeClass: "refinement", edit: exactRefinementEdit() }),
    },
  });
  return { locked, admission, session, source, revision, application, planning };
}

const describeLocked = process.platform === "win32" ? describe.skip : describe;

describeLocked("A1 Host semantic revision draft and Application acceptance", () => {
  it("seals Host-owned exact meaning, requires exact digest, admits one atomic semantic cut, and deduplicates acceptance", async () => {
    const f = await fixture();
    const begin = await f.planning.begin({
      sourceSessionId: String(f.session.sessionId),
      connectionGenerationId: "connection-1",
      agentGeneration: 3,
      programStateId: String(programId),
    });
    expect(begin.fromProgramStateRevision).toBe(7);
    expect(begin.parentProgramRevisionId).toBe(String(r1));

    const draft = await f.planning.submitProposal({
      sourceSessionId: String(f.session.sessionId),
      connectionGenerationId: "connection-1",
      agentGeneration: 3,
      proposal: advisoryProposal(begin.planningEpisodeId),
    });
    expect(draft.changeClass).toBe("refinement");
    expect(draft.edit.workItems.find((work) => work.workItemId === workBId)?.workItemGeneration).toBe(2);
    expect(draft.revisionImpact.retainedAttempts).toEqual([attemptId]);
    expect((await f.application.pendingForSession(String(f.session.sessionId))).map((item) => item.draftId)).toEqual([draft.draftId]);

    let events = await allEvents(f.locked.store);
    expect(events.filter((event) => event.type === "program.semantic_revision.draft.sealed.v1")).toHaveLength(1);
    expect(events.filter((event) => event.type === "program.semantic_revision.admitted.v1")).toHaveLength(0);

    await expect(f.application.accept({
      commandId: "accept-wrong",
      clientId: "test-application",
      sourceSessionId: String(f.session.sessionId),
      programStateId: String(programId),
      draftId: draft.draftId,
      draftDigest: `${draft.draftDigest}-stale`,
    })).rejects.toBeInstanceOf(ProgramRevisionStaleError);
    expect(await f.application.pendingForSession(String(f.session.sessionId))).toHaveLength(1);

    const admitted = await f.application.accept({
      commandId: "accept-exact",
      clientId: "test-application",
      sourceSessionId: String(f.session.sessionId),
      programStateId: String(programId),
      draftId: draft.draftId,
      draftDigest: draft.draftDigest,
    });
    expect(admitted.status).toBe("admitted");
    expect(admitted.programStateRevision).toBe(8);
    expect(admitted.cut?.nextSemanticState.currentRevision.sourceDraftId).toBe(draft.draftId);
    expect(admitted.cut?.nextSemanticState.currentRevision.sourceDraftDigest).toBe(draft.draftDigest);
    expect(admitted.cut?.revisionImpact).toEqual(draft.revisionImpact);

    const duplicate = await f.application.accept({
      commandId: "accept-duplicate",
      clientId: "test-application",
      sourceSessionId: String(f.session.sessionId),
      programStateId: String(programId),
      draftId: draft.draftId,
      draftDigest: draft.draftDigest,
    });
    expect(duplicate.status).toBe("existing");

    events = await allEvents(f.locked.store);
    const admittedEvents = events.filter((event) => event.type === "program.semantic_revision.admitted.v1");
    expect(admittedEvents).toHaveLength(1);
    expect(admittedEvents[0].eventId).toBe(draft.admissionEventId);
    expect(admittedEvents[0].payload.applicationCommandId).toBe("accept-exact");
    expect(events.some((event) => event.type === "program.semantic_revision.draft.accepted.v1")).toBe(false);
    expect(events.some((event) => event.type === "program.transitioned")).toBe(false);
    f.locked.close();
  });

  it("arbitrates two planning episodes against one semantic parent without automatic rebase", async () => {
    const f = await fixture();
    const first = await f.planning.begin({
      sourceSessionId: String(f.session.sessionId), connectionGenerationId: "connection-1", agentGeneration: 3, programStateId: String(programId),
    });
    const second = await f.planning.begin({
      sourceSessionId: String(f.session.sessionId), connectionGenerationId: "connection-1", agentGeneration: 3, programStateId: String(programId),
    });
    const draft = await f.planning.submitProposal({
      sourceSessionId: String(f.session.sessionId), connectionGenerationId: "connection-1", agentGeneration: 3,
      proposal: advisoryProposal(first.planningEpisodeId, "proposal-first"),
    });
    const accepted = await f.application.accept({
      commandId: "accept-first", clientId: "test-application", sourceSessionId: String(f.session.sessionId),
      programStateId: String(programId), draftId: draft.draftId, draftDigest: draft.draftDigest,
    });
    f.source.apply(accepted.cut!);

    await expect(f.planning.submitProposal({
      sourceSessionId: String(f.session.sessionId), connectionGenerationId: "connection-1", agentGeneration: 3,
      proposal: advisoryProposal(second.planningEpisodeId, "proposal-second"),
    })).rejects.toThrow(/parent changed/);
    expect((await allEvents(f.locked.store)).filter((event) => event.type === "program.semantic_revision.admitted.v1")).toHaveLength(1);
    f.locked.close();
  });

  it("invalidates a sealed draft when whole-state currentness changes before acceptance", async () => {
    const f = await fixture();
    const begin = await f.planning.begin({
      sourceSessionId: String(f.session.sessionId), connectionGenerationId: "connection-1", agentGeneration: 3, programStateId: String(programId),
    });
    const draft = await f.planning.submitProposal({
      sourceSessionId: String(f.session.sessionId), connectionGenerationId: "connection-1", agentGeneration: 3,
      proposal: advisoryProposal(begin.planningEpisodeId),
    });
    f.source.snapshot.programStateRevision += 1;

    await expect(f.application.accept({
      commandId: "accept-stale", clientId: "test-application", sourceSessionId: String(f.session.sessionId),
      programStateId: String(programId), draftId: draft.draftId, draftDigest: draft.draftDigest,
    })).rejects.toBeInstanceOf(ProgramRevisionStaleError);
    expect(await f.application.pendingForSession(String(f.session.sessionId))).toHaveLength(0);
    const events = await allEvents(f.locked.store);
    expect(events.filter((event) => event.type === "program.semantic_revision.draft.invalidated.v1")).toHaveLength(1);
    expect(events.filter((event) => event.type === "program.semantic_revision.admitted.v1")).toHaveLength(0);
    f.locked.close();
  });

  it("rejects terminal acceptance and invalidates the noncanonical draft", async () => {
    const f = await fixture();
    const begin = await f.planning.begin({
      sourceSessionId: String(f.session.sessionId), connectionGenerationId: "connection-1", agentGeneration: 3, programStateId: String(programId),
    });
    const draft = await f.planning.submitProposal({
      sourceSessionId: String(f.session.sessionId), connectionGenerationId: "connection-1", agentGeneration: 3,
      proposal: advisoryProposal(begin.planningEpisodeId),
    });
    f.source.snapshot.lifecycle = "cancelled";

    await expect(f.application.accept({
      commandId: "accept-cancelled", clientId: "test-application", sourceSessionId: String(f.session.sessionId),
      programStateId: String(programId), draftId: draft.draftId, draftDigest: draft.draftDigest,
    })).rejects.toThrow(/cancelled/);
    expect((await allEvents(f.locked.store)).filter((event) => event.type === "program.semantic_revision.admitted.v1")).toHaveLength(0);
    f.locked.close();
  });

  it("enforces bounded proposal rationale before Host canonicalization", async () => {
    const f = await fixture();
    const begin = await f.planning.begin({
      sourceSessionId: String(f.session.sessionId), connectionGenerationId: "connection-1", agentGeneration: 3, programStateId: String(programId),
    });
    const proposal = advisoryProposal(begin.planningEpisodeId);
    proposal.rationale = "x".repeat(4097);
    await expect(f.planning.submitProposal({
      sourceSessionId: String(f.session.sessionId), connectionGenerationId: "connection-1", agentGeneration: 3, proposal,
    })).rejects.toBeInstanceOf(ProgramRevisionControlError);
    expect((await allEvents(f.locked.store)).some((event) => event.type.startsWith("program.semantic_revision."))).toBe(false);
    f.locked.close();
  });
});
