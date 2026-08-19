import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DURABLE_TRANSCRIPT_CAPABILITY,
  PROGRAM_EXECUTION_CAPABILITY,
  PROGRAM_STATE_CAPABILITY,
  createInMemoryTransportPair,
  type AgentToHostMessage,
  type HostToAgentMessage,
} from "@alcode/agent-protocol";
import {
  asProgramStateId as asEventProgramStateId,
  asWorkspaceId,
  mkEventId,
  mkProgramStateId,
  uuidv7,
  type EventDraft,
  type PersistedDomainEvent,
} from "@alcode/events";
import {
  applyProgramTransition,
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  asVerificationObligationId,
  createProgramState,
  isVerificationCurrent,
  type ProgramAttemptExecutionBase,
  type ProgramState,
  type WorkspacePathState,
} from "@alcode/program-state";
import { openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import type { AgentConnection } from "./agent-supervisor.ts";
import { HostArtifactStore } from "./artifact-store.ts";
import { CapabilityBroker } from "./capability-broker.ts";
import { CognitionGateway } from "./cognition-gateway.ts";
import { DefaultHostPolicy } from "./policy.ts";
import { ProgramAgentServiceV1 } from "./program-agent.ts";
import { ProgramDispatchServiceV1 } from "./program-dispatch.ts";
import { ProgramExecutionControlV1 } from "./program-execution-control.ts";
import { ProgramExecutionSchedulerV1 } from "./program-execution-scheduler.ts";
import { PlanningReadRegistry } from "./planning-read.ts";
import { ProgramTerminalServiceV1 } from "./program-terminal.ts";
import {
  HostVerificationOperationRegistryV1,
  ProgramVerificationServiceV1,
} from "./program-verification.ts";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { HostSessionManager } from "./session-manager.ts";
import { createProgramExecutionRuntimeV1 } from "./program-execution-runtime.ts";

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
      providerKind: "phase-1.1-idle-test",
      workspaceIdentity,
      coverageDigest: "workspace-complete-v1",
      stateDigest: "state-v1",
    },
  };
}

async function events(store: LockedWorkspaceStore): Promise<PersistedDomainEvent<string, unknown>[]> {
  const out: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of store.store.replay()) out.push(event);
  return out;
}

function latestState(source: readonly PersistedDomainEvent<string, unknown>[], programStateId: string): ProgramState {
  let state: ProgramState | undefined;
  for (const event of source) {
    if (String(event.programStateId ?? "") !== programStateId) continue;
    if (event.type !== "program.created" && event.type !== "program.transitioned"
        && event.type !== "program.completed" && event.type !== "program.cancelled") continue;
    state = (event.payload as { state?: ProgramState }).state ?? state;
  }
  if (state === undefined) throw new Error("missing ProgramState");
  return state;
}

async function setupControl(options: { pathState: WorkspacePathState; twoWork?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "alcode-program-execution-control-"));
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
  const base = executionBase(locked.store.workspaceId);
  const work1 = asProgramWorkItemId("work-idle-1");
  const work2 = asProgramWorkItemId("work-idle-2");
  const verify1 = asVerificationObligationId("verify-idle-1");
  const initial = createProgramState({
    programStateId: asProgramStateId(String(mkProgramStateId())),
    sourceSessionId: asSessionId(String(session.sessionId)),
    objective: "Route Program idle through Host verification and terminal authority",
    workItems: [
      {
        workItemId: work1,
        creationOrder: 0,
        description: "Create src/a.ts",
        dependencyIds: [],
        affectedPaths: ["src/a.ts"],
      },
      ...(options.twoWork ? [{
        workItemId: work2,
        creationOrder: 1,
        description: "Create src/b.ts",
        dependencyIds: [work1],
        affectedPaths: ["src/b.ts"],
      }] : []),
    ],
    verification: [{
      obligationId: verify1,
      predicate: { kind: "workspace_path_state", path: "src/a.ts", requiredState: "file" },
      freshnessScope: { kind: "paths", entries: [{ path: "src/a.ts", mode: "exact" }] },
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
    producer: { kind: "runtime", component: "program-execution-control-test" },
  }]);

  const agents = new ProgramAgentServiceV1(locked.store, admission);
  const connectionGenerationId = "idle-agent-connection-1";
  const agentGeneration = await agents.attach(session.sessionId, connectionGenerationId, true);
  const coordinator = { runExclusive: <T>(work: () => Promise<T>) => work() };
  const recovery = { isClear: async () => true };
  const observations = { observe: async () => ({ status: "complete" as const, base }) };
  const dispatch = new ProgramDispatchServiceV1({
    store: locked.store,
    admission,
    workspaceCoordinator: coordinator,
    observations,
    agentGenerations: agents,
    recovery,
    firstDispatchPlanning: { recheckAcceptedPlanningBase: async () => undefined },
  });
  const issued = await dispatch.issueAttempt({
    programStateId: String(initial.programStateId),
    expectedProgramRevision: initial.revision,
    workItemId: String(work1),
    sessionId: session.sessionId,
    agentGeneration,
  });
  if (issued.status !== "issued") throw new Error(`expected Attempt, got ${issued.status}`);
  const awaiting = applyProgramTransition(issued.state, {
    kind: "work.lifecycle.set",
    expectedProgramRevision: issued.state.revision,
    workItemId: work1,
    lifecycle: "awaiting_verification",
  });
  await admission.append([{
    eventId: mkEventId(),
    workspaceId: asWorkspaceId(locked.store.workspaceId),
    sessionId: session.sessionId,
    programStateId: asEventProgramStateId(String(initial.programStateId)),
    occurredAt: new Date().toISOString(),
    type: "program.transitioned",
    payload: { state: awaiting, transitionKind: "work.lifecycle.set:awaiting_verification" },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-execution-control-test" },
  }]);

  const broker = new CapabilityBroker(
    locked.store,
    admission,
    new CognitionGateway(locked),
    new DefaultHostPolicy({ knownTools: [], allowMutations: true }),
    [],
  );
  broker.setProgramOperationAuthority(dispatch);
  const artifactStore = new HostArtifactStore({ root: join(dir, "artifacts") });
  const verification = new ProgramVerificationServiceV1({
    store: locked.store,
    admission,
    workspaceCoordinator: coordinator,
    observations,
    pathObservations: {
      observePath: async () => ({ status: "complete" as const, base, pathState: options.pathState }),
    },
    recovery,
    capabilityBroker: broker,
    operationSpecs: new HostVerificationOperationRegistryV1([]),
    artifactStore,
  });
  const terminal = new ProgramTerminalServiceV1({
    store: locked.store,
    admission,
    workspaceCoordinator: coordinator,
    observations,
    recovery,
    artifactStore,
  });
  const scheduler = new ProgramExecutionSchedulerV1({ store: locked.store, dispatch, agents });
  const control = new ProgramExecutionControlV1({
    store: locked.store,
    admission,
    verification,
    scheduler,
    terminal,
    agents: {
      isCurrent: (candidateSession, candidateConnection, candidateGeneration) =>
        candidateConnection === connectionGenerationId && agents.isCurrent(candidateSession, candidateGeneration),
    },
  });
  return { locked, session, initial, work1, work2, verify1, agents, connectionGenerationId, control, scheduler };
}

describeLocked("Program-backed idle/verification/terminal routing", () => {
  it("satisfies current verification, completes work, and terminalizes only through the Completion Oracle", async () => {
    const fixture = await setupControl({ pathState: "file" });
    const result = await fixture.control.handleAgentIdle({
      connectionGenerationId: fixture.connectionGenerationId,
      sessionId: fixture.session.sessionId,
    });
    expect(result).toEqual({ status: "handled", terminal: "completed" });
    const state = latestState(await events(fixture.locked), String(fixture.initial.programStateId));
    expect(state.lifecycle).toBe("completed");
    expect(state.activeAttempt).toBeNull();
    expect(state.workItems[0]?.lifecycle).toBe("completed");
    expect(isVerificationCurrent(state.verification[0]!)).toBe(true);
    expect((await events(fixture.locked)).filter((event) => event.type === "program.completed")).toHaveLength(1);
  });

  it("turns verification failure into active idle retry state without autonomous redispatch", async () => {
    const fixture = await setupControl({ pathState: "absent" });
    const oldAttemptId = latestState(await events(fixture.locked), String(fixture.initial.programStateId)).activeAttempt!.programAttemptId;
    const result = await fixture.control.handleAgentIdle({
      connectionGenerationId: fixture.connectionGenerationId,
      sessionId: fixture.session.sessionId,
    });
    expect(result).toMatchObject({ status: "handled", terminal: "none", reason: "verification_not_satisfied" });
    let state = latestState(await events(fixture.locked), String(fixture.initial.programStateId));
    expect(state.lifecycle).toBe("active");
    expect(state.activeAttempt).toBeNull();
    expect(state.workItems[0]?.lifecycle).toBe("pending");

    const fresh = await fixture.scheduler.dispatchNext({
      programStateId: String(fixture.initial.programStateId),
      sessionId: fixture.session.sessionId,
    });
    expect(fresh.status).toBe("issued");
    if (fresh.status !== "issued") throw new Error("fresh Attempt was not issued");
    expect(fresh.programAttemptId).not.toBe(String(oldAttemptId));
    state = fresh.state;
    expect(state.workItems[0]?.lifecycle).toBe("in_progress");
  });

  it("dispatches the deterministic successor after verified work completion", async () => {
    const fixture = await setupControl({ pathState: "file", twoWork: true });
    const firstAttemptId = latestState(await events(fixture.locked), String(fixture.initial.programStateId)).activeAttempt!.programAttemptId;
    const result = await fixture.control.handleAgentIdle({
      connectionGenerationId: fixture.connectionGenerationId,
      sessionId: fixture.session.sessionId,
    });
    expect(result).toMatchObject({ status: "handled", terminal: "none", reason: "successor_dispatched" });
    const state = latestState(await events(fixture.locked), String(fixture.initial.programStateId));
    expect(state.workItems.find((work) => work.workItemId === fixture.work1)?.lifecycle).toBe("completed");
    expect(state.activeAttempt?.workItemId).toBe(fixture.work2);
    expect(state.activeAttempt?.programAttemptId).not.toBe(firstAttemptId);
  });

  it("does not let Program-backed agent.idle fall through to legacy cognition completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-idle-host-route-"));
    dirs.push(dir);
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: asWorkspaceId(uuidv7()),
      repositoryId: uuidv7(),
    });
    stores.push(locked);
    const base = executionBase(locked.store.workspaceId);
    const runtime = createProgramExecutionRuntimeV1({
      host: { store: locked, capabilities: [] },
      planningReads: new PlanningReadRegistry("idle-host-route", 1, []),
      creationPolicy: { current: () => ({ generation: "p1", digest: "pd1", requirements: [] }) },
      executionObservationProfiles: {
        current: () => ({ profileId: "workspace-observation-v1", profileVersion: 1, coverageIdentity: "workspace-complete-v1" }),
        validate: () => undefined,
      },
      observations: { observe: async () => ({ status: "complete", base }) },
      pathObservations: { observePath: async () => ({ status: "unknown", reason: "not used" }) },
      operationSpecs: new HostVerificationOperationRegistryV1([]),
      artifactStore: new HostArtifactStore({ root: join(dir, "artifacts") }),
    });
    const session = await runtime.host.sessions.openOrResume();
    const pair = createInMemoryTransportPair<HostToAgentMessage, AgentToHostMessage>();
    const neverExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {});
    const connection: AgentConnection = {
      generationId: "host-idle-agent",
      capabilities: [DURABLE_TRANSCRIPT_CAPABILITY, PROGRAM_STATE_CAPABILITY, PROGRAM_EXECUTION_CAPABILITY],
      transport: pair.a,
      waitForExit: () => neverExit,
      terminate: () => undefined,
    };
    await runtime.attachAgent(connection, session, "system");
    const agentGeneration = runtime.host.programAgents.currentAgentGeneration(String(session.sessionId));
    if (agentGeneration === null) throw new Error("missing agent generation");

    const programStateId = asProgramStateId(String(mkProgramStateId()));
    const workItemId = asProgramWorkItemId("work-host-idle");
    const initial = createProgramState({
      programStateId,
      sourceSessionId: asSessionId(String(session.sessionId)),
      objective: "Remain active while current work is still in progress",
      workItems: [{ workItemId, creationOrder: 0, description: "Keep working", dependencyIds: [], affectedPaths: [] }],
      verification: [],
      outputSlots: [],
      productionSteps: [],
    });
    await runtime.host.admission.append([{
      eventId: mkEventId(), workspaceId: asWorkspaceId(locked.store.workspaceId), sessionId: session.sessionId,
      programStateId: asEventProgramStateId(String(programStateId)), occurredAt: new Date().toISOString(),
      type: "program.created", payload: { state: initial }, payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "program-execution-control-test" },
    }]);
    const issued = await runtime.dispatch.issueAttempt({
      programStateId: String(programStateId),
      expectedProgramRevision: initial.revision,
      workItemId: String(workItemId),
      sessionId: session.sessionId,
      agentGeneration,
    });
    expect(issued.status).toBe("issued");

    await pair.b.send({
      type: "agent.idle",
      requestId: "idle-in-progress",
      sessionId: String(session.sessionId),
      reason: "stop",
    });
    expect((await runtime.host.sessions.getState(session.sessionId)).stopped).toBe(false);
    expect(latestState(await events(locked), String(programStateId)).lifecycle).toBe("active");
  });
});
