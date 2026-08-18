import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DURABLE_TRANSCRIPT_CAPABILITY,
  GRAPH_CONTEXT_CAPABILITY,
  PROGRAM_EXECUTION_CAPABILITY,
  PROGRAM_STATE_CAPABILITY,
  createInMemoryTransportPair,
  type AgentToHostMessage,
  type ContextUpdate,
  type HostToAgentMessage,
} from "@alcode/agent-protocol";
import {
  asProgramStateId as asEventProgramStateId,
  asWorkspaceId,
  mkEventId,
  mkProgramStateId,
  uuidv7,
} from "@alcode/events";
import {
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  createProgramState,
  type ProgramAttemptExecutionBase,
  type ProgramState,
} from "@alcode/program-state";
import { openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import type { AgentConnection } from "./agent-supervisor.ts";
import { HostRuntime } from "./host.ts";
import { ProgramDispatchServiceV1 } from "./program-dispatch.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;
const stores: LockedWorkspaceStore[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch {} }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function base(workspaceIdentity: string): ProgramAttemptExecutionBase {
  return {
    workspaceEffectGeneration: 0,
    observation: {
      kind: "workspace-observation-v1",
      providerKind: "program-agent-host-test",
      workspaceIdentity,
      coverageDigest: "coverage-v1",
      stateDigest: "state-0",
    },
  };
}

async function latestState(store: LockedWorkspaceStore, programStateId: string): Promise<ProgramState> {
  let latest: ProgramState | undefined;
  for await (const event of store.store.replay()) {
    if (String(event.programStateId ?? "") !== programStateId) continue;
    if (["program.created", "program.transitioned", "program.completed", "program.cancelled"].includes(event.type)) {
      latest = (event.payload as { state: ProgramState }).state;
    }
  }
  if (latest === undefined) throw new Error("missing ProgramState");
  return latest;
}

function connection(generationId: string) {
  const pair = createInMemoryTransportPair<HostToAgentMessage, AgentToHostMessage>();
  const messages: HostToAgentMessage[] = [];
  pair.b.onMessage((message) => { messages.push(message); });
  const neverExits = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => undefined);
  const hostConnection: AgentConnection = {
    generationId,
    capabilities: [
      DURABLE_TRANSCRIPT_CAPABILITY,
      GRAPH_CONTEXT_CAPABILITY,
      PROGRAM_STATE_CAPABILITY,
      PROGRAM_EXECUTION_CAPABILITY,
    ],
    transport: pair.a,
    waitForExit: () => neverExits,
    terminate: () => undefined,
  };
  return { pair, messages, hostConnection };
}

describeLocked("Host Program Agent integration", () => {
  it("delivers only the current AttemptProjection at the inference refresh cut and replacement interrupts it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-agent-host-"));
    dirs.push(dir);
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: asWorkspaceId(uuidv7()),
      repositoryId: uuidv7(),
    });
    stores.push(locked);
    const host = new HostRuntime({ store: locked, capabilities: [] });
    await host.startup();
    const session = await host.openOrResumeSession();
    const firstConnection = connection("connection-1");
    await host.attachAgent(firstConnection.hostConnection, session, "Host prompt");
    const generation = host.programAgents.currentAgentGeneration(String(session.sessionId));
    if (generation === null) throw new Error("missing current Program Agent generation");

    const workItemId = asProgramWorkItemId("work-host-agent");
    const initial = createProgramState({
      programStateId: asProgramStateId(String(mkProgramStateId())),
      sourceSessionId: asSessionId(String(session.sessionId)),
      objective: "Continue across Agent replacement",
      workItems: [{ workItemId, creationOrder: 0, description: "Current work", dependencyIds: [], affectedPaths: ["src/current.ts"] }],
      verification: [], outputSlots: [], productionSteps: [],
    });
    await host.admission.append([{
      eventId: mkEventId(), workspaceId: asWorkspaceId(locked.store.workspaceId), sessionId: session.sessionId,
      programStateId: asEventProgramStateId(String(initial.programStateId)), occurredAt: new Date().toISOString(),
      type: "program.created", payload: { state: initial }, payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "program-agent-host-test" },
    }]);

    const currentBase = base(locked.store.workspaceId);
    const dispatch = new ProgramDispatchServiceV1({
      store: locked.store,
      admission: host.admission,
      workspaceCoordinator: { runExclusive: (work) => work() },
      observations: { observe: async () => ({ status: "complete" as const, base: currentBase }) },
      agentGenerations: host.programAgents,
      recovery: { isClear: () => true },
      firstDispatchPlanning: { recheckAcceptedPlanningBase: async () => undefined },
    });
    host.setProgramOperationAuthority(dispatch);
    const issued = await dispatch.issueAttempt({
      programStateId: String(initial.programStateId), expectedProgramRevision: initial.revision,
      workItemId: String(workItemId), sessionId: session.sessionId,
      agentGeneration: generation,
    });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") throw new Error("Attempt not issued");

    await firstConnection.pair.b.send({
      type: "context.refresh.request", requestId: "refresh-1", sessionId: String(session.sessionId),
    });
    const update = firstConnection.messages.find((message): message is ContextUpdate =>
      message.type === "context.update" && message.requestId === "refresh-1");
    expect(update?.programAttempt?.authority).toMatchObject({
      programStateId: String(initial.programStateId),
      programAttemptId: issued.programAttemptId,
      agentGeneration: generation,
    });

    const resumed = await host.openOrResumeSession(session.sessionId);
    const secondConnection = connection("connection-2");
    await host.attachAgent(secondConnection.hostConnection, resumed, "Host prompt", "agent_replaced");
    const replacementGeneration = host.programAgents.currentAgentGeneration(String(session.sessionId));
    if (replacementGeneration === null) throw new Error("missing replacement Program Agent generation");
    expect(replacementGeneration).toBeGreaterThan(generation);
    expect((await latestState(locked, String(initial.programStateId))).activeAttempt).toBeNull();
    await secondConnection.pair.b.send({
      type: "context.refresh.request", requestId: "refresh-2", sessionId: String(session.sessionId),
    });
    const replacementUpdate = secondConnection.messages.find((message): message is ContextUpdate =>
      message.type === "context.update" && message.requestId === "refresh-2");
    expect(replacementUpdate?.programAttempt).toBeUndefined();
  });
});

describeLocked("Host inference-bound Program capability authority", () => {
  it("requires the exact inference Attempt tuple and rejects delayed ABA requests before operation admission", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-capability-authority-"));
    dirs.push(dir);
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"), lockPath: join(dir, "workspace.lock"),
      workspaceId: asWorkspaceId(uuidv7()), repositoryId: uuidv7(),
    });
    stores.push(locked);
    let executed = 0;
    const host = new HostRuntime({
      store: locked,
      capabilities: [{
        name: "inspect_program_file", workspaceAccessClass: "read_only",
        async execute() { executed += 1; return { outcome: "succeeded" as const, result: { ok: true } }; },
      }],
    });
    await host.startup();
    const session = await host.openOrResumeSession();
    const first = connection("program-connection-a");
    await host.attachAgent(first.hostConnection, session, "Host prompt");
    const generationA = host.programAgents.currentExecutionAgentGeneration(String(session.sessionId));
    if (generationA === null) throw new Error("missing Program execution generation A");

    const workItemId = asProgramWorkItemId("work-capability-authority");
    const initial = createProgramState({
      programStateId: asProgramStateId(String(mkProgramStateId())),
      sourceSessionId: asSessionId(String(session.sessionId)),
      objective: "Bind capability calls to their inference Attempt",
      workItems: [{ workItemId, creationOrder: 0, description: "Inspect the current work", dependencyIds: [], affectedPaths: ["src/current.ts"] }],
      verification: [], outputSlots: [], productionSteps: [],
    });
    await host.admission.append([{
      eventId: mkEventId(), workspaceId: asWorkspaceId(locked.store.workspaceId), sessionId: session.sessionId,
      programStateId: asEventProgramStateId(String(initial.programStateId)), occurredAt: new Date().toISOString(),
      type: "program.created", payload: { state: initial }, payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "program-capability-authority-test" },
    }]);

    const currentBase = base(locked.store.workspaceId);
    const dispatch = new ProgramDispatchServiceV1({
      store: locked.store, admission: host.admission,
      workspaceCoordinator: { runExclusive: (work) => work() },
      observations: { observe: async () => ({ status: "complete" as const, base: currentBase }) },
      agentGenerations: host.programAgents, recovery: { isClear: () => true },
      firstDispatchPlanning: { recheckAcceptedPlanningBase: async () => undefined },
    });
    host.setProgramOperationAuthority(dispatch);
    const issuedA = await dispatch.issueAttempt({
      programStateId: String(initial.programStateId), expectedProgramRevision: initial.revision,
      workItemId: String(workItemId), sessionId: session.sessionId, agentGeneration: generationA,
    });
    if (issuedA.status !== "issued") throw new Error(`Attempt A not issued: ${issuedA.status}`);

    await first.pair.b.send({ type: "context.refresh.request", requestId: "authority-refresh-a", sessionId: String(session.sessionId) });
    const updateA = first.messages.find((message): message is ContextUpdate =>
      message.type === "context.update" && message.requestId === "authority-refresh-a");
    const authorityA = updateA?.programAttempt?.authority;
    if (authorityA === undefined) throw new Error("missing inference Attempt authority A");

    await first.pair.b.send({
      type: "capability.request", requestId: "missing-attempt-authority", sessionId: String(session.sessionId),
      toolCallId: "tool-missing-authority", toolName: "inspect_program_file", args: {},
    });
    expect(first.messages.find((message) => message.type === "capability.result" && message.requestId === "missing-attempt-authority"))
      .toMatchObject({ outcome: "stale", errorCode: "program_execution_stale" });
    expect(executed).toBe(0);

    await first.pair.b.send({
      type: "capability.request", requestId: "current-attempt-authority", sessionId: String(session.sessionId),
      toolCallId: "tool-current-authority", toolName: "inspect_program_file", args: {}, programAttemptAuthority: authorityA,
    });
    expect(first.messages.find((message) => message.type === "capability.result" && message.requestId === "current-attempt-authority"))
      .toMatchObject({ outcome: "succeeded" });
    expect(executed).toBe(1);

    const requestedBefore: unknown[] = [];
    for await (const event of locked.store.replay()) if (event.type === "operation.requested") requestedBefore.push(event);
    expect(requestedBefore).toHaveLength(1);

    const resumed = await host.openOrResumeSession(session.sessionId);
    const second = connection("program-connection-b");
    await host.attachAgent(second.hostConnection, resumed, "Host prompt", "agent_replaced");
    const generationB = host.programAgents.currentExecutionAgentGeneration(String(session.sessionId));
    if (generationB === null) throw new Error("missing Program execution generation B");
    expect(generationB).toBeGreaterThan(generationA);
    const interrupted = await latestState(locked, String(initial.programStateId));
    expect(interrupted.activeAttempt).toBeNull();
    const issuedB = await dispatch.issueAttempt({
      programStateId: String(initial.programStateId), expectedProgramRevision: interrupted.revision,
      workItemId: String(workItemId), sessionId: session.sessionId, agentGeneration: generationB,
    });
    if (issuedB.status !== "issued") throw new Error(`Attempt B not issued: ${issuedB.status}`);
    expect(issuedB.programAttemptId).not.toBe(issuedA.programAttemptId);

    await first.pair.b.send({
      type: "capability.request", requestId: "delayed-attempt-a", sessionId: String(session.sessionId),
      toolCallId: "tool-delayed-a", toolName: "inspect_program_file", args: {}, programAttemptAuthority: authorityA,
    });
    expect(first.messages.find((message) => message.type === "capability.result" && message.requestId === "delayed-attempt-a"))
      .toMatchObject({ outcome: "stale", errorCode: "program_execution_stale" });
    expect(executed).toBe(1);

    const requestedAfter: unknown[] = [];
    for await (const event of locked.store.replay()) if (event.type === "operation.requested") requestedAfter.push(event);
    expect(requestedAfter).toHaveLength(1);
  });
});
