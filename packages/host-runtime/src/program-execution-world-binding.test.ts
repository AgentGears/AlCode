import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestOf } from "@alcode/context";
import {
  asProgramStateId as asEventProgramStateId,
  asWorkspaceId,
  mkEventId,
  mkOperationId,
  mkProgramStateId,
  uuidv7,
  type EventDraft,
  type SessionId,
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
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import {
  ProgramDispatchServiceV1,
  ProgramDispatchStaleError,
  resolveProgramAttemptExecutionWorldBindingV1,
} from "./program-dispatch.ts";
import {
  ExecutionWorldServiceV1,
  type ExecutionContainmentPolicyDescriptorV1,
  type ExecutionProviderDescriptorV1,
} from "./execution-world.ts";
import { HostSessionManager } from "./session-manager.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

const provider: ExecutionProviderDescriptorV1 = {
  providerKind: "local-trusted",
  adapter: "a5-program-binding-test",
  adapterVersion: 1,
  semanticConfig: { transport: "host-process", hostileCodeIsolation: false },
};

const policy: ExecutionContainmentPolicyDescriptorV1 = {
  profile: "local-trusted-v1",
  semanticConfig: { filesystem: "workspace-root", network: "host" },
};

function base(workspaceId: string): ProgramAttemptExecutionBase {
  return {
    workspaceEffectGeneration: 0,
    observation: {
      kind: "workspace-observation-v1",
      providerKind: "test-observer",
      workspaceIdentity: workspaceId,
      coverageDigest: "same-coverage",
      stateDigest: "same-bytes",
    },
  };
}

async function appendProgramState(
  admission: CanonicalAdmissionQueue,
  workspaceId: string,
  sessionId: SessionId,
  state: ProgramState,
): Promise<void> {
  await admission.append([{
    eventId: mkEventId(),
    idempotencyKey: `program.created:${String(state.programStateId)}:${state.revision}`,
    workspaceId: asWorkspaceId(workspaceId),
    sessionId,
    programStateId: asEventProgramStateId(String(state.programStateId)),
    occurredAt: new Date().toISOString(),
    type: "program.created",
    payload: { state },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-execution-world-binding-test" },
  }]);
}

function readiness(label: string) {
  return { readinessEvidenceDigest: digestOf({ contract: "a5-test-readiness", label }) };
}

async function replayAll(locked: LockedWorkspaceStore) {
  const events = [];
  for await (const event of locked.store.replay()) events.push(event);
  return events;
}

describeLocked("A5 ProgramAttempt execution-world binding", () => {
  let dir: string;
  let locked: LockedWorkspaceStore | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-a5-program-world-"));
    locked = null;
  });

  afterEach(() => {
    try { locked?.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("binds an Attempt to G0, stamps Operation provenance, and rejects G0 after same-bytes G1", async () => {
    locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: asWorkspaceId(uuidv7()),
      repositoryId: uuidv7(),
    });
    const admission = new CanonicalAdmissionQueue(locked.store);
    const sessions = new HostSessionManager(locked, admission);
    const session = await sessions.openOrResume();
    const workspaceId = String(locked.store.workspaceId);
    const workItemId = asProgramWorkItemId("work-a5-2");
    const initial = createProgramState({
      programStateId: asProgramStateId(String(mkProgramStateId())),
      sourceSessionId: asSessionId(String(session.sessionId)),
      objective: "Prove A5-2 world binding",
      workItems: [{
        workItemId,
        creationOrder: 0,
        description: "Exercise generation binding",
        dependencyIds: [],
        affectedPaths: ["src/a5-2.ts"],
      }],
      verification: [],
      outputSlots: [],
      productionSteps: [],
    });
    await appendProgramState(admission, workspaceId, session.sessionId, initial);

    const worlds = new ExecutionWorldServiceV1(locked.store, admission);
    const g0 = await worlds.prepareActivation({
      activationRequestId: "g0",
      workspaceId,
      sessionId: String(session.sessionId),
      providerDescriptor: provider,
      effectivePolicy: policy,
    });
    await worlds.observeActivation({
      executionWorldGenerationId: g0.executionWorldGenerationId,
      evidence: readiness("same-bytes"),
    });

    const dispatch = new ProgramDispatchServiceV1({
      store: locked.store,
      admission,
      workspaceCoordinator: { runExclusive: (work) => work() },
      observations: { observe: async () => ({ status: "complete", base: base(workspaceId) }) },
      agentGenerations: { isCurrent: (_sessionId, generation) => generation === 7 },
      recovery: { isClear: () => true },
      firstDispatchPlanning: { recheckAcceptedPlanningBase: async () => undefined },
      executionWorld: worlds,
    });

    const issued = await dispatch.issueAttempt({
      programStateId: String(initial.programStateId),
      expectedProgramRevision: initial.revision,
      workItemId: String(workItemId),
      sessionId: session.sessionId,
      agentGeneration: 7,
    });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") throw new Error("expected issued Attempt");

    const issuedEvents = await replayAll(locked);
    expect(resolveProgramAttemptExecutionWorldBindingV1(
      issuedEvents,
      issued.programAttemptId,
    )).toEqual(g0);

    const operationId = mkOperationId();
    const requested: EventDraft<string, unknown> = {
      eventId: mkEventId(),
      idempotencyKey: `operation.requested:${String(operationId)}`,
      correlationId: String(operationId),
      workspaceId: asWorkspaceId(workspaceId),
      sessionId: session.sessionId,
      operationId,
      occurredAt: new Date().toISOString(),
      type: "operation.requested",
      payload: {
        operationId: String(operationId),
        workspaceAccessClass: "read_only",
      },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "program-execution-world-binding-test" },
    };
    const program = {
      programStateId: String(initial.programStateId),
      expectedProgramRevision: issued.state.revision,
      programAttemptId: issued.programAttemptId,
      workItemId: String(workItemId),
      agentGeneration: 7,
    };
    const admitted = await dispatch.appendRoutedRootOperation({
      sessionId: session.sessionId,
      operationId: String(operationId),
      workspaceAccessClass: "read_only",
      program,
      executionWorld: g0,
      drafts: [requested],
    });
    expect(admitted.status).toBe("appended");
    if (admitted.status !== "appended") throw new Error("expected appended Operation");
    expect((admitted.events[0]?.payload as Record<string, unknown>).executionWorld).toEqual(g0);

    const g1 = await worlds.prepareActivation({
      activationRequestId: "g1",
      workspaceId,
      sessionId: String(session.sessionId),
      providerDescriptor: provider,
      effectivePolicy: policy,
    });
    await worlds.observeActivation({
      executionWorldGenerationId: g1.executionWorldGenerationId,
      evidence: readiness("same-bytes"),
    });
    expect(g1.executionWorldGenerationId).not.toBe(g0.executionWorldGenerationId);

    await expect(dispatch.assertCurrentAttempt({
      ...program,
      sessionId: session.sessionId,
    })).rejects.toBeInstanceOf(ProgramDispatchStaleError);

    const staleOperationId = mkOperationId();
    await expect(dispatch.appendRoutedRootOperation({
      sessionId: session.sessionId,
      operationId: String(staleOperationId),
      workspaceAccessClass: "read_only",
      program,
      executionWorld: g0,
      drafts: [{
        ...requested,
        eventId: mkEventId(),
        idempotencyKey: `operation.requested:${String(staleOperationId)}`,
        correlationId: String(staleOperationId),
        operationId: staleOperationId,
        payload: { operationId: String(staleOperationId), workspaceAccessClass: "read_only" },
      }],
    })).rejects.toBeInstanceOf(ProgramDispatchStaleError);

    const after = await replayAll(locked);
    expect(after.some((event) =>
      event.type === "operation.requested" && String(event.operationId ?? "") === String(staleOperationId),
    )).toBe(false);
    expect(resolveProgramAttemptExecutionWorldBindingV1(after, issued.programAttemptId)).toEqual(g0);

    const restartedDispatch = new ProgramDispatchServiceV1({
      store: locked.store,
      admission,
      workspaceCoordinator: { runExclusive: (work) => work() },
      observations: { observe: async () => ({ status: "complete", base: base(workspaceId) }) },
      agentGenerations: { isCurrent: () => true },
      recovery: { isClear: () => true },
      firstDispatchPlanning: { recheckAcceptedPlanningBase: async () => undefined },
      executionWorld: new ExecutionWorldServiceV1(locked.store, admission),
    });
    await expect(restartedDispatch.assertCurrentAttempt({
      ...program,
      sessionId: session.sessionId,
    })).rejects.toBeInstanceOf(ProgramDispatchStaleError);
  });
});
