import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asProgramStateId as asEventProgramStateId,
  asWorkspaceId,
  mkEventId,
  mkProgramStateId,
  uuidv7,
  type PersistedDomainEvent,
} from "@alcode/events";
import {
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  asVerificationObligationId,
  createProgramState,
  type ProgramAttemptExecutionBase,
  type ProgramState,
} from "@alcode/program-state";
import { openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { CapabilityBroker } from "./capability-broker.ts";
import { CognitionGateway } from "./cognition-gateway.ts";
import { DefaultHostPolicy } from "./policy.ts";
import { ProgramAgentServiceV1 } from "./program-agent.ts";
import { ProgramDispatchServiceV1 } from "./program-dispatch.ts";
import { ProgramProgressServiceV1 } from "./program-progress.ts";
import { HostSessionManager } from "./session-manager.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;
const stores: LockedWorkspaceStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function executionBase(workspaceIdentity: string): ProgramAttemptExecutionBase {
  return {
    workspaceEffectGeneration: 0,
    observation: {
      kind: "workspace-observation-v1",
      providerKind: "program-progress-test",
      workspaceIdentity,
      coverageDigest: "coverage-v1",
      stateDigest: "state-v1",
    },
  };
}

async function replay(store: LockedWorkspaceStore): Promise<PersistedDomainEvent<string, unknown>[]> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of store.store.replay()) events.push(event);
  return events;
}

function latestState(events: readonly PersistedDomainEvent<string, unknown>[], programStateId: string): ProgramState {
  let state: ProgramState | undefined;
  for (const event of events) {
    if (String(event.programStateId ?? "") !== programStateId) continue;
    if (event.type !== "program.created" && event.type !== "program.transitioned"
        && event.type !== "program.completed" && event.type !== "program.cancelled") continue;
    state = (event.payload as { state?: ProgramState }).state ?? state;
  }
  if (state === undefined) throw new Error("missing ProgramState");
  return state;
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "alcode-program-progress-"));
  dirs.push(dir);
  const locked = await openLockedWorkspaceStore({
    databasePath: join(dir, "workspace.sqlite"),
    lockPath: join(dir, "workspace.lock"),
    workspaceId: asWorkspaceId(uuidv7()),
    repositoryId: uuidv7(),
  });
  stores.push(locked);
  const admission = new CanonicalAdmissionQueue(locked.store);
  const sessions = new HostSessionManager(locked, admission);
  const session = await sessions.openOrResume();
  const workItemId = asProgramWorkItemId("work-progress");
  const verificationObligationId = asVerificationObligationId("verify-progress");
  const initial = createProgramState({
    programStateId: asProgramStateId(String(mkProgramStateId())),
    sourceSessionId: asSessionId(String(session.sessionId)),
    objective: "Advance current work through bounded Agent progress",
    workItems: [{
      workItemId,
      creationOrder: 0,
      description: "Perform the current work",
      dependencyIds: [],
      affectedPaths: ["src/progress.ts"],
    }],
    verification: [{
      obligationId: verificationObligationId,
      predicate: { kind: "workspace_path_state", path: "src/progress.ts", requiredState: "file" },
      freshnessScope: { kind: "paths", entries: [{ path: "src/progress.ts", mode: "exact" }] },
    }],
    outputSlots: [],
    productionSteps: [],
  });
  await admission.append([{
    eventId: mkEventId(),
    workspaceId: asWorkspaceId(locked.store.workspaceId),
    sessionId: session.sessionId,
    programStateId: asEventProgramStateId(String(initial.programStateId)),
    occurredAt: new Date().toISOString(),
    type: "program.created",
    payload: { state: initial },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-progress-test" },
  }]);

  const agents = new ProgramAgentServiceV1(locked.store, admission);
  const connectionGenerationId = "connection-progress-1";
  const agentGeneration = await agents.attach(session.sessionId, connectionGenerationId, true);
  const currentBase = executionBase(locked.store.workspaceId);
  const dispatch = new ProgramDispatchServiceV1({
    store: locked.store,
    admission,
    workspaceCoordinator: { runExclusive: (work) => work() },
    observations: { observe: async () => ({ status: "complete" as const, base: currentBase }) },
    agentGenerations: agents,
    recovery: { isClear: () => true },
    firstDispatchPlanning: { recheckAcceptedPlanningBase: async () => undefined },
  });
  const issued = await dispatch.issueAttempt({
    programStateId: String(initial.programStateId),
    expectedProgramRevision: initial.revision,
    workItemId: String(workItemId),
    sessionId: session.sessionId,
    agentGeneration,
  });
  if (issued.status !== "issued") throw new Error(`expected Attempt issuance, got ${issued.status}`);

  const broker = new CapabilityBroker(
    locked.store,
    admission,
    new CognitionGateway(locked),
    new DefaultHostPolicy({ knownTools: ["inspect"], allowMutations: true }),
    [{
      name: "inspect",
      workspaceAccessClass: "read_only",
      async execute() { return { result: { ok: true }, outcome: "succeeded" as const }; },
    }],
  );
  broker.setProgramOperationAuthority(dispatch);
  const authority = {
    programStateId: String(initial.programStateId),
    expectedProgramRevision: issued.state.revision,
    programAttemptId: issued.programAttemptId,
    workItemId: String(workItemId),
    agentGeneration,
  };
  const operation = await broker.execute({
    sessionId: session.sessionId,
    toolCallId: "progress-source-call",
    toolName: "inspect",
    args: { path: "src/progress.ts" },
    program: authority,
  });
  if (operation.outcome !== "succeeded" || operation.operationId === undefined) {
    throw new Error("expected owned source operation");
  }

  const progress = new ProgramProgressServiceV1({
    store: locked.store,
    admission,
    agents: {
      isCurrent: (candidateSessionId, candidateConnectionId, candidateAgentGeneration) =>
        candidateConnectionId === connectionGenerationId
        && agents.isCurrent(candidateSessionId, candidateAgentGeneration),
    },
  });
  return {
    locked,
    session,
    initial,
    workItemId,
    verificationObligationId,
    agents,
    connectionGenerationId,
    authority,
    operationId: String(operation.operationId),
    progress,
  };
}

describeLocked("Program progress admission", () => {
  it("admits work-bound evidence and awaiting-verification while keeping blocker reports advisory", async () => {
    const fixture = await setup();
    const message = {
      type: "program.progress" as const,
      version: 1 as const,
      requestId: "progress-current",
      sessionId: String(fixture.session.sessionId),
      authority: fixture.authority,
      evidence: [{
        sourceOperationId: fixture.operationId,
        verificationObligationId: String(fixture.verificationObligationId),
      }],
      advisoryBlockers: [{
        action: "report" as const,
        reportId: "advisory-1",
        scope: "work" as const,
        reason: "A caller decision may be useful before a follow-up change",
      }],
      requestAwaitingVerification: true,
    };

    const admitted = await fixture.progress.handleAgentMessage({
      connectionGenerationId: fixture.connectionGenerationId,
      sessionId: fixture.session.sessionId,
      message,
    });
    expect(admitted).toMatchObject({
      outcome: "admitted",
      programStateId: fixture.authority.programStateId,
      programRevision: fixture.authority.expectedProgramRevision + 2,
    });

    const events = await replay(fixture.locked);
    const state = latestState(events, fixture.authority.programStateId);
    expect(state.activeAttempt?.programAttemptId).toBe(fixture.authority.programAttemptId);
    expect(state.workItems[0]?.lifecycle).toBe("awaiting_verification");
    expect(state.blockers).toEqual([]);
    expect(state.decisiveEvidence).toHaveLength(1);
    expect(state.decisiveEvidence[0]).toMatchObject({
      workItemId: fixture.workItemId,
      verificationObligationId: fixture.verificationObligationId,
      sourceOperationId: fixture.operationId,
      artifactRef: null,
      subjectGeneration: 1,
    });
    expect(state.verification[0]?.satisfaction).toBeNull();
    expect(events.filter((event) => event.type === "program.agent_advisory.reported")).toHaveLength(1);
    expect(events.some((event) => event.type === "program.transitioned"
      && (event.payload as { transitionKind?: string }).transitionKind === "blocker.add")).toBe(false);

    const beforeDuplicate = events.length;
    const duplicate = await fixture.progress.handleAgentMessage({
      connectionGenerationId: fixture.connectionGenerationId,
      sessionId: fixture.session.sessionId,
      message,
    });
    expect(duplicate).toEqual(admitted);
    expect((await replay(fixture.locked))).toHaveLength(beforeDuplicate);

    const resolved = await fixture.progress.handleAgentMessage({
      connectionGenerationId: fixture.connectionGenerationId,
      sessionId: fixture.session.sessionId,
      message: {
        type: "program.progress",
        version: 1,
        requestId: "progress-resolve",
        sessionId: String(fixture.session.sessionId),
        authority: { ...fixture.authority, expectedProgramRevision: state.revision },
        evidence: [],
        advisoryBlockers: [{ action: "resolve", reportId: "advisory-1" }],
        requestAwaitingVerification: false,
      },
    });
    expect(resolved).toMatchObject({ outcome: "admitted", programRevision: state.revision });
    expect((await replay(fixture.locked)).filter((event) => event.type === "program.agent_advisory.resolved")).toHaveLength(1);
  });

  it("rejects stale authority and invalid evidence without changing canonical Program truth", async () => {
    const fixture = await setup();
    const before = await replay(fixture.locked);
    const beforeTransitions = before.filter((event) => event.type === "program.transitioned").length;

    const stale = await fixture.progress.handleAgentMessage({
      connectionGenerationId: fixture.connectionGenerationId,
      sessionId: fixture.session.sessionId,
      message: {
        type: "program.progress",
        version: 1,
        requestId: "progress-stale",
        sessionId: String(fixture.session.sessionId),
        authority: { ...fixture.authority, programAttemptId: `${fixture.authority.programAttemptId}-stale` },
        evidence: [{ sourceOperationId: fixture.operationId }],
        advisoryBlockers: [],
        requestAwaitingVerification: false,
      },
    });
    expect(stale).toMatchObject({ outcome: "stale", errorCode: "program_progress_stale" });

    const invalid = await fixture.progress.handleAgentMessage({
      connectionGenerationId: fixture.connectionGenerationId,
      sessionId: fixture.session.sessionId,
      message: {
        type: "program.progress",
        version: 1,
        requestId: "progress-invalid-evidence",
        sessionId: String(fixture.session.sessionId),
        authority: fixture.authority,
        evidence: [{ sourceOperationId: "unknown-operation" }],
        advisoryBlockers: [],
        requestAwaitingVerification: false,
      },
    });
    expect(invalid).toMatchObject({ outcome: "denied", errorCode: "program_progress_invalid" });
    expect((await replay(fixture.locked)).filter((event) => event.type === "program.transitioned")).toHaveLength(beforeTransitions);
  });

  it("fails closed when the sending connection is not the negotiated current execution peer", async () => {
    const fixture = await setup();
    const beforeTransitions = (await replay(fixture.locked)).filter((event) => event.type === "program.transitioned").length;
    const result = await fixture.progress.handleAgentMessage({
      connectionGenerationId: "legacy-or-replaced-connection",
      sessionId: fixture.session.sessionId,
      message: {
        type: "program.progress",
        version: 1,
        requestId: "progress-wrong-connection",
        sessionId: String(fixture.session.sessionId),
        authority: fixture.authority,
        evidence: [{ sourceOperationId: fixture.operationId }],
        advisoryBlockers: [],
        requestAwaitingVerification: false,
      },
    });
    expect(result).toMatchObject({ outcome: "stale", errorCode: "program_progress_stale" });
    expect((await replay(fixture.locked)).filter((event) => event.type === "program.transitioned")).toHaveLength(beforeTransitions);
  });
});
