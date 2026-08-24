import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asProgramRevisionId,
  asProgramStateId,
  asProgramWorkItemId,
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
  type ProgramRevisionPlanningAgentAuthorityV1,
  type ProgramRevisionHostCanonicalizerV1,
  type ProgramSemanticCurrentSnapshotV1,
  type ProgramSemanticCurrentStateSourceV1,
} from "./program-revision.ts";
import { HostSessionManager } from "./session-manager.ts";

const programId = asProgramStateId("018f0000-0000-7000-8000-000000000921");
const r1 = asProgramRevisionId("semantic-race-r1");
const workId = asProgramWorkItemId("race-work");

function envelope(): WorkAuthorityEnvelopeV1 {
  return {
    objectiveBoundaryRef: {
      programStateId: programId,
      rootProgramRevisionId: r1,
      anchorWorkItemId: null,
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

function work(generation = 1, affectedPaths = ["src/a.ts", "src/shared.ts"]): ProgramSemanticWorkItemV1 {
  return {
    workItemId: workId,
    creationOrder: 0,
    description: "Implement race-safe semantic planning",
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
      admissionEventId: "race-baseline-admission",
      sourceDraftId: null,
      sourceDraftDigest: null,
    },
    workItems: [work()],
    verification: [],
    verificationBindings: [],
    outputSlots: [],
    productionSteps: [],
  };
}

function exactRefinementEdit(): ProgramSemanticRevisionEditV1 {
  const identityDecisions: WorkItemIdentityDecisionV1[] = [{
    workItemId: workId,
    fromGeneration: 1,
    disposition: "preserve_identity_and_advance_generation",
    successorWorkItemId: null,
  }];
  return {
    workItems: [work(2, ["src/a.ts"])],
    identityDecisions,
    verification: [],
    verificationBindings: [],
    outputSlots: [],
    productionSteps: [],
  };
}

function advisoryProposal(planningEpisodeId: string, requestId = "race-proposal"): ProgramRevisionAgentProposalV1 {
  return {
    planningEpisodeId,
    requestId,
    programStateId: String(programId),
    parentProgramRevisionId: String(r1),
    proposedChangeClass: "refinement",
    proposedEdit: exactRefinementEdit(),
    rationale: "Narrow the work to the path required by the objective.",
  };
}

class MutableSemanticSource implements ProgramSemanticCurrentStateSourceV1 {
  snapshot: ProgramSemanticCurrentSnapshotV1;

  constructor(sessionId: string) {
    this.snapshot = {
      programStateRevision: 7,
      semanticState: baselineSemanticState(),
      activeAttempt: null,
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
      activeAttempt: null,
    };
  }
}

async function allEvents(store: { replay(): AsyncIterable<any> }): Promise<any[]> {
  const events: any[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

async function fixture(options?: {
  agents?: ProgramRevisionPlanningAgentAuthorityV1;
  canonicalizer?: ProgramRevisionHostCanonicalizerV1;
  sourceFactory?: (sessionId: string) => MutableSemanticSource;
}) {
  const dir = mkdtempSync(join(tmpdir(), "alcode-program-revision-race-"));
  const locked = await openLockedWorkspaceStore({
    databasePath: join(dir, "workspace.sqlite"),
    lockPath: join(dir, "workspace.lock"),
    workspaceId: "018f0000-0000-7000-8000-000000000922",
    repositoryId: "program-revision-race-test",
  });
  const admission = new CanonicalAdmissionQueue(locked.store);
  const sessions = new HostSessionManager(locked, admission);
  const session = await sessions.openOrResume();
  const source = options?.sourceFactory?.(String(session.sessionId))
    ?? new MutableSemanticSource(String(session.sessionId));
  const revision = new ProgramRevisionControlServiceV1({
    store: locked.store,
    admission,
    currentState: source,
  });
  const application = new HostProgramRevisionApplicationControlV1(revision);
  const agents = options?.agents ?? {
    isCurrent: (_sessionId: string, connectionGenerationId: string, agentGeneration: number) => (
      connectionGenerationId === "connection-race" && agentGeneration === 4
    ),
  };
  const canonicalizer = options?.canonicalizer ?? {
    canonicalize: () => ({ changeClass: "refinement" as const, edit: exactRefinementEdit() }),
  };
  const planning = new ProgramRevisionPlanningServiceV1({
    revision,
    currentState: source,
    agents,
    canonicalizer,
  });
  return { locked, session, source, revision, application, planning };
}

function beginInput(sessionId: string) {
  return {
    sourceSessionId: sessionId,
    connectionGenerationId: "connection-race",
    agentGeneration: 4,
    programStateId: String(programId),
  };
}

const describeLocked = process.platform === "win32" ? describe.skip : describe;

describeLocked("A1 semantic revision planning race guards", () => {
  it("rejects planning before model invocation while the latest admitted cut is not reflected by the semantic projection", async () => {
    const f = await fixture();
    const sessionId = String(f.session.sessionId);
    const begin = await f.planning.begin(beginInput(sessionId));
    const draft = await f.planning.submitProposal({
      sourceSessionId: sessionId,
      connectionGenerationId: "connection-race",
      agentGeneration: 4,
      proposal: advisoryProposal(begin.planningEpisodeId),
    });
    const admitted = await f.application.accept({
      commandId: "race-accept",
      clientId: "race-application",
      sourceSessionId: sessionId,
      programStateId: String(programId),
      draftId: draft.draftId,
      draftDigest: draft.draftDigest,
    });
    expect(admitted.status).toBe("admitted");
    expect(admitted.cut).toBeDefined();

    await expect(f.planning.begin(beginInput(sessionId))).rejects.toThrow(
      "Current semantic source has not incorporated the latest canonical semantic cut",
    );

    f.source.apply(admitted.cut!);
    const fresh = await f.planning.begin(beginInput(sessionId));
    expect(fresh.fromProgramStateRevision).toBe(admitted.programStateRevision);
    expect(fresh.parentProgramRevisionId).toBe(admitted.programRevisionId);
    await f.locked.close();
  });

  it("rejects the proposal if Agent generation becomes stale during asynchronous Host canonicalization", async () => {
    let agentCurrent = true;
    let started!: () => void;
    let release!: () => void;
    const canonicalizationStarted = new Promise<void>((resolve) => { started = resolve; });
    const canonicalizationRelease = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture({
      agents: { isCurrent: () => agentCurrent },
      canonicalizer: {
        canonicalize: async () => {
          started();
          await canonicalizationRelease;
          return { changeClass: "refinement", edit: exactRefinementEdit() };
        },
      },
    });
    const sessionId = String(f.session.sessionId);
    const begin = await f.planning.begin(beginInput(sessionId));
    const sealing = f.planning.submitProposal({
      sourceSessionId: sessionId,
      connectionGenerationId: "connection-race",
      agentGeneration: 4,
      proposal: advisoryProposal(begin.planningEpisodeId),
    });
    await canonicalizationStarted;
    agentCurrent = false;
    release();

    await expect(sealing).rejects.toBeInstanceOf(ProgramRevisionStaleError);
    const events = await allEvents(f.locked.store);
    expect(events.filter((event) => event.type === "program.semantic_revision.draft.sealed.v1")).toHaveLength(0);
    await f.locked.close();
  });

  it("rechecks Agent generation inside the admission transaction immediately before the sealed draft append", async () => {
    let agentCurrent = true;
    let sealReadStarted!: () => void;
    let releaseSealRead!: () => void;
    const sealRead = new Promise<void>((resolve) => { sealReadStarted = resolve; });
    const sealRelease = new Promise<void>((resolve) => { releaseSealRead = resolve; });

    class BlockingSource extends MutableSemanticSource {
      calls = 0;

      override async current(programStateId: string): Promise<ProgramSemanticCurrentSnapshotV1> {
        this.calls += 1;
        const snapshot = await super.current(programStateId);
        // begin=current call 1; submit pre-canonicalization=current call 2;
        // sealDraft admission=current call 3.
        if (this.calls === 3) {
          sealReadStarted();
          await sealRelease;
        }
        return snapshot;
      }
    }

    const f = await fixture({
      agents: { isCurrent: () => agentCurrent },
      sourceFactory: (sessionId) => new BlockingSource(sessionId),
    });
    const sessionId = String(f.session.sessionId);
    const begin = await f.planning.begin(beginInput(sessionId));
    const sealing = f.planning.submitProposal({
      sourceSessionId: sessionId,
      connectionGenerationId: "connection-race",
      agentGeneration: 4,
      proposal: advisoryProposal(begin.planningEpisodeId, "race-final-guard"),
    });
    await sealRead;
    agentCurrent = false;
    releaseSealRead();

    await expect(sealing).rejects.toBeInstanceOf(ProgramRevisionStaleError);
    const events = await allEvents(f.locked.store);
    expect(events.filter((event) => event.type === "program.semantic_revision.draft.sealed.v1")).toHaveLength(0);
    expect(events.filter((event) => event.type === "program.semantic_revision.draft.invalidated.v1")).toHaveLength(0);
    await f.locked.close();
  });

  it("keeps Promise<X> | X canonicalizer returns valid and awaited", async () => {
    const f = await fixture({
      canonicalizer: {
        canonicalize: async () => ({ changeClass: "refinement", edit: exactRefinementEdit() }),
      },
    });
    const sessionId = String(f.session.sessionId);
    const begin = await f.planning.begin(beginInput(sessionId));
    const draft = await f.planning.submitProposal({
      sourceSessionId: sessionId,
      connectionGenerationId: "connection-race",
      agentGeneration: 4,
      proposal: advisoryProposal(begin.planningEpisodeId, "race-async-canonicalizer"),
    });
    expect(draft.changeClass).toBe("refinement");
    expect(await f.application.pendingForSession(sessionId)).toHaveLength(1);
    await f.locked.close();
  });
});
