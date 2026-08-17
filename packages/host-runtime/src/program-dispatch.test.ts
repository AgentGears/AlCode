import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asProgramStateId as asEventProgramStateId,
  asWorkspaceId,
  mkEventId,
  mkOperationId,
  mkProgramStateId,
  type EventDraft,
  type SessionId,
} from "@alcode/events";
import {
  ProgramRevisionConflictError,
  applyProgramTransition,
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  createProgramState,
  type ProgramAttemptExecutionBase,
  type ProgramState,
} from "@alcode/program-state";
import { openLockedWorkspaceStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import {
  ProgramDispatchServiceV1,
  ProgramDispatchStaleError,
  type ProgramExecutionObservationSourceV1,
} from "./program-dispatch.ts";
import { HostSessionManager } from "./session-manager.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

class MutableObservation implements ProgramExecutionObservationSourceV1 {
  value: Awaited<ReturnType<ProgramExecutionObservationSourceV1["observe"]>>;

  constructor(base: ProgramAttemptExecutionBase) {
    this.value = { status: "complete", base };
  }

  observe(): Promise<Awaited<ReturnType<ProgramExecutionObservationSourceV1["observe"]>>> {
    return Promise.resolve(this.value);
  }
}

function base(workspaceIdentity: string, generation: number, stateDigest: string): ProgramAttemptExecutionBase {
  return {
    workspaceEffectGeneration: generation,
    observation: {
      kind: "workspace-observation-v1",
      providerKind: "test-observer",
      workspaceIdentity,
      coverageDigest: "coverage-v1",
      stateDigest,
    },
  };
}

async function appendProgramState(
  admission: CanonicalAdmissionQueue,
  workspaceId: string,
  sessionId: SessionId,
  state: ProgramState,
  type: "program.created" | "program.transitioned" = "program.created",
): Promise<void> {
  await admission.append([{
    eventId: mkEventId(),
    idempotencyKey: `${type}:${String(state.programStateId)}:${state.revision}`,
    workspaceId: asWorkspaceId(workspaceId),
    sessionId,
    programStateId: asEventProgramStateId(String(state.programStateId)),
    occurredAt: new Date().toISOString(),
    type,
    payload: { state },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-dispatch-test" },
  }]);
}

function program(sessionId: SessionId, suffix: string): ProgramState {
  return createProgramState({
    programStateId: asProgramStateId(String(mkProgramStateId())),
    sourceSessionId: asSessionId(String(sessionId)),
    objective: `Dispatch ${suffix}`,
    workItems: [{
      workItemId: asProgramWorkItemId(`work-${suffix}`),
      creationOrder: 0,
      description: `Do ${suffix}`,
      dependencyIds: [],
      affectedPaths: [`src/${suffix}.ts`],
    }],
    verification: [],
    outputSlots: [],
    productionSteps: [],
  });
}

function serviceOptions(input: {
  store: Parameters<typeof CanonicalAdmissionQueue>[0] extends never ? never : any;
}): never {
  throw new Error(String(input));
}

async function setup(suffix: string) {
  const dir = mkdtempSync(join(tmpdir(), `alcode-program-dispatch-${suffix}-`));
  const locked = await openLockedWorkspaceStore({
    databasePath: join(dir, "workspace.sqlite"),
    lockPath: join(dir, "workspace.lock"),
    workspaceId: `018f0000-0000-7000-8000-0000000004${suffix.padStart(2, "0")}`,
    repositoryId: `program-dispatch-${suffix}`,
  });
  const admission = new CanonicalAdmissionQueue(locked.store);
  const sessions = new HostSessionManager(locked, admission);
  const session = await sessions.openOrResume();
  const initial = program(session.sessionId, suffix);
  await appendProgramState(admission, locked.store.workspaceId, session.sessionId, initial);
  const observation = new MutableObservation(base(locked.store.workspaceId, 0, "state-0"));
  let agentGeneration = 7;
  let recoveryClear = true;
  let planningRechecks = 0;
  const service = new ProgramDispatchServiceV1({
    store: locked.store,
    admission,
    workspaceCoordinator: { runExclusive: (work) => work() },
    observations: observation,
    agentGenerations: {
      isCurrent: (_sessionId, generation) => generation === agentGeneration,
    },
    recovery: { isClear: () => recoveryClear },
    firstDispatchPlanning: {
      recheckAcceptedPlanningBase: async () => { planningRechecks += 1; },
    },
  });
  return {
    locked,
    admission,
    sessions,
    session,
    initial,
    observation,
    service,
    setAgentGeneration: (value: number) => { agentGeneration = value; },
    setRecoveryClear: (value: boolean) => { recoveryClear = value; },
    planningRechecks: () => planningRechecks,
  };
}

describeLocked("Program dispatch admission", () => {
  it("bridges first dispatch, mints a fresh Attempt, and enforces exact current authority", async () => {
    const runtime = await setup("01");
    const issued = await runtime.service.issueAttempt({
      programStateId: String(runtime.initial.programStateId),
      expectedProgramRevision: 1,
      workItemId: "work-01",
      sessionId: runtime.session.sessionId,
      agentGeneration: 7,
    });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") throw new Error("expected issued Attempt");
    expect(issued.state.revision).toBe(2);
    expect(issued.state.acceptedExecutionBase).toEqual(base(runtime.locked.store.workspaceId, 0, "state-0"));
    expect(issued.state.activeAttempt?.programAttemptId).toBe(issued.programAttemptId);
    expect(runtime.planningRechecks()).toBe(1);

    await expect(runtime.service.assertCurrentAttempt({
      programStateId: String(runtime.initial.programStateId),
      expectedProgramRevision: 1,
      programAttemptId: issued.programAttemptId,
      workItemId: "work-01",
      sessionId: runtime.session.sessionId,
      agentGeneration: 7,
    })).rejects.toBeInstanceOf(ProgramRevisionConflictError);

    await expect(runtime.service.assertCurrentAttempt({
      programStateId: String(runtime.initial.programStateId),
      expectedProgramRevision: 2,
      programAttemptId: "old-attempt",
      workItemId: "work-01",
      sessionId: runtime.session.sessionId,
      agentGeneration: 7,
    })).rejects.toBeInstanceOf(ProgramDispatchStaleError);

    runtime.setAgentGeneration(8);
    await expect(runtime.service.assertCurrentAttempt({
      programStateId: String(runtime.initial.programStateId),
      expectedProgramRevision: 2,
      programAttemptId: issued.programAttemptId,
      workItemId: "work-01",
      sessionId: runtime.session.sessionId,
      agentGeneration: 7,
    })).rejects.toBeInstanceOf(ProgramDispatchStaleError);
    runtime.locked.close();
  });

  it("records a complete mismatch, refuses a changed rebase target, then admits the exact candidate", async () => {
    const runtime = await setup("02");
    const first = await runtime.service.issueAttempt({
      programStateId: String(runtime.initial.programStateId),
      expectedProgramRevision: 1,
      workItemId: "work-02",
      sessionId: runtime.session.sessionId,
      agentGeneration: 7,
    });
    if (first.status !== "issued") throw new Error("expected first Attempt");

    const interrupted = applyProgramTransition(first.state, {
      kind: "attempt.interrupt",
      expectedProgramRevision: first.state.revision,
      programAttemptId: first.programAttemptId,
    });
    await appendProgramState(runtime.admission, runtime.locked.store.workspaceId, runtime.session.sessionId, interrupted, "program.transitioned");

    runtime.observation.value = { status: "complete", base: base(runtime.locked.store.workspaceId, 1, "state-1") };
    const mismatch = await runtime.service.issueAttempt({
      programStateId: String(runtime.initial.programStateId),
      expectedProgramRevision: interrupted.revision,
      workItemId: "work-02",
      sessionId: runtime.session.sessionId,
      agentGeneration: 7,
    });
    expect(mismatch.status).toBe("rebase_required");
    if (mismatch.status !== "rebase_required") throw new Error("expected mismatch");
    expect(mismatch.state.executionBaseMismatch?.kind).toBe("causal_and_observation_mismatch");

    runtime.observation.value = { status: "complete", base: base(runtime.locked.store.workspaceId, 2, "state-2") };
    await expect(runtime.service.acceptRebase({
      programStateId: String(runtime.initial.programStateId),
      expectedProgramRevision: mismatch.state.revision,
      mismatchReceiptId: mismatch.mismatchReceiptId,
      sessionId: runtime.session.sessionId,
    })).rejects.toBeInstanceOf(ProgramDispatchStaleError);

    runtime.observation.value = { status: "complete", base: base(runtime.locked.store.workspaceId, 1, "state-1") };
    const rebased = await runtime.service.acceptRebase({
      programStateId: String(runtime.initial.programStateId),
      expectedProgramRevision: mismatch.state.revision,
      mismatchReceiptId: mismatch.mismatchReceiptId,
      sessionId: runtime.session.sessionId,
    });
    expect(rebased.executionBaseMismatch).toBeNull();
    expect(rebased.acceptedExecutionBase).toEqual(base(runtime.locked.store.workspaceId, 1, "state-1"));

    const successor = await runtime.service.issueAttempt({
      programStateId: String(runtime.initial.programStateId),
      expectedProgramRevision: rebased.revision,
      workItemId: "work-02",
      sessionId: runtime.session.sessionId,
      agentGeneration: 7,
    });
    expect(successor.status).toBe("issued");
    expect(runtime.planningRechecks()).toBe(1);
    runtime.locked.close();
  });

  it("serializes same-Workspace ProgramAttempts without creating a hidden queue", async () => {
    const runtime = await setup("03");
    const secondSession = await runtime.sessions.openOrResume();
    const second = program(secondSession.sessionId, "03b");
    await appendProgramState(runtime.admission, runtime.locked.store.workspaceId, secondSession.sessionId, second);

    const first = await runtime.service.issueAttempt({
      programStateId: String(runtime.initial.programStateId),
      expectedProgramRevision: 1,
      workItemId: "work-03",
      sessionId: runtime.session.sessionId,
      agentGeneration: 7,
    });
    expect(first.status).toBe("issued");

    const blocked = await runtime.service.issueAttempt({
      programStateId: String(second.programStateId),
      expectedProgramRevision: 1,
      workItemId: "work-03b",
      sessionId: secondSession.sessionId,
      agentGeneration: 7,
    });
    expect(blocked.status).toBe("workspace_busy");
    if (blocked.status === "workspace_busy") {
      expect(blocked.activeProgramStateId).toBe(String(runtime.initial.programStateId));
    }
    runtime.locked.close();
  });

  it("blocks dispatch on an unresolved may-write quiescence barrier and releases only on canonical proof", async () => {
    const runtime = await setup("04");
    const operationId = mkOperationId();
    const eventBase = {
      workspaceId: asWorkspaceId(runtime.locked.store.workspaceId),
      sessionId: runtime.session.sessionId,
      operationId,
      occurredAt: new Date().toISOString(),
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "program-dispatch-test" } as const,
    };
    const requested: EventDraft<string, unknown> = {
      ...eventBase,
      eventId: mkEventId(),
      type: "operation.requested",
      payload: { operationId: String(operationId), workspaceAccessClass: "may_write" },
    };
    await runtime.admission.append([requested]);

    const blocked = await runtime.service.issueAttempt({
      programStateId: String(runtime.initial.programStateId),
      expectedProgramRevision: 1,
      workItemId: "work-04",
      sessionId: runtime.session.sessionId,
      agentGeneration: 7,
    });
    expect(blocked).toEqual({ status: "writer_barrier", operationIds: [String(operationId)] });

    await runtime.admission.append([{
      ...eventBase,
      eventId: mkEventId(),
      type: "operation.mutation_quiesced",
      payload: { operationId: String(operationId) },
    }]);
    const issued = await runtime.service.issueAttempt({
      programStateId: String(runtime.initial.programStateId),
      expectedProgramRevision: 1,
      workItemId: "work-04",
      sessionId: runtime.session.sessionId,
      agentGeneration: 7,
    });
    expect(issued.status).toBe("issued");
    runtime.locked.close();
  });

  it("fails closed when direct execution observation or recovery is unavailable", async () => {
    const runtime = await setup("05");
    runtime.setRecoveryClear(false);
    const recoveryBlocked = await runtime.service.issueAttempt({
      programStateId: String(runtime.initial.programStateId),
      expectedProgramRevision: 1,
      workItemId: "work-05",
      sessionId: runtime.session.sessionId,
      agentGeneration: 7,
    });
    expect(recoveryBlocked.status).toBe("recovery_blocked");

    runtime.setRecoveryClear(true);
    runtime.observation.value = { status: "unknown", reason: "observation overflow" };
    const unavailable = await runtime.service.issueAttempt({
      programStateId: String(runtime.initial.programStateId),
      expectedProgramRevision: 1,
      workItemId: "work-05",
      sessionId: runtime.session.sessionId,
      agentGeneration: 7,
    });
    expect(unavailable.status).toBe("execution_base_unavailable");
    if (unavailable.status === "execution_base_unavailable") {
      expect(unavailable.state.activeAttempt).toBeNull();
      expect(unavailable.state.executionBaseUnavailable).toBe(true);
      expect(unavailable.state.revision).toBe(2);
    }
    runtime.locked.close();
  });
});
