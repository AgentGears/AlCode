import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asProgramStateId as asEventProgramStateId,
  asSessionId as asEventSessionId,
  asWorkspaceId,
  mkEventId,
  mkOperationId,
  mkProgramStateId,
  uuidv7,
  type EventDraft,
  type SessionId,
} from "@alcode/events";
import {
  applyProgramTransition,
  asExecutionBaseMismatchReceiptId,
  asProgramAttemptId,
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  createProgramState,
  type ProgramAttemptExecutionBase,
  type ProgramState,
} from "@alcode/program-state";
import {
  createWorkspaceReadModels,
  openLockedWorkspaceStore,
  reduceOperationsFromEvents,
  type LockedWorkspaceStore,
} from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { DefaultHostPolicy } from "./policy.ts";
import { HostRuntime, type HostCapability } from "./index.ts";
import { Phase1RecoveryControllerV1 } from "./program-recovery.ts";
import type { ProgramExecutionObservationSourceV1 } from "./program-dispatch.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;
const opened: LockedWorkspaceStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of opened.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(suffix: string) {
  const dir = mkdtempSync(join(tmpdir(), `alcode-recovery-10-${suffix}-`));
  dirs.push(dir);
  const locked = await openLockedWorkspaceStore({
    databasePath: join(dir, "workspace.sqlite"),
    lockPath: join(dir, "workspace.lock"),
    workspaceId: `018f0000-0000-7000-8000-0000000010${suffix.padStart(2, "0")}`,
    repositoryId: `phase1-recovery-${suffix}`,
  });
  opened.push(locked);
  const admission = new CanonicalAdmissionQueue(locked.store);
  const sessionId = asEventSessionId(uuidv7());
  return { locked, admission, sessionId };
}

function base(workspaceIdentity: string, generation = 0, stateDigest = "state-0"): ProgramAttemptExecutionBase {
  return {
    workspaceEffectGeneration: generation,
    observation: {
      kind: "workspace-observation-v1",
      providerKind: "recovery-test",
      workspaceIdentity,
      coverageDigest: "coverage-v1",
      stateDigest,
    },
  };
}

class MutableObservation implements ProgramExecutionObservationSourceV1 {
  constructor(public value: Awaited<ReturnType<ProgramExecutionObservationSourceV1["observe"]>>) {}
  observe(): Promise<Awaited<ReturnType<ProgramExecutionObservationSourceV1["observe"]>>> {
    return Promise.resolve(this.value);
  }
}

function recoveryCapability(
  effect: "confirmed" | "absent" = "confirmed",
  quiescenceAvailable = true,
): HostCapability {
  return {
    name: "mutate",
    workspaceAccessClass: "may_write",
    quiescence: {
      containmentKind: "operation_scoped_containment",
      proofContractId: "host-capability-promise-v1",
      proofContractVersion: 1,
      async recover(input) {
        if (!quiescenceAvailable) return undefined;
        return {
          containmentInstanceId: input.containmentInstanceId,
          proofContractId: "host-capability-promise-v1",
          proofContractVersion: 1,
          proofKind: "operation_containment_ended",
          evidence: { kind: "operation_scope_ended", containmentInstanceId: input.containmentInstanceId },
        };
      },
    },
    reconciliation: {
      contractId: "mutate-reconcile-v1",
      contractVersion: 1,
      async recover() {
        return {
          status: "resolved" as const,
          effectStatus: effect,
          executionOutcome: effect === "confirmed" ? "succeeded" as const : "failed" as const,
          evidence: { source: "recovery-test", effect },
        };
      },
    },
    async execute(_args, context) {
      const containmentInstanceId = context.quiescenceContract?.containmentInstanceId ?? "missing";
      return {
        outcome: "succeeded",
        result: "ok",
        quiescenceProof: {
          containmentInstanceId,
          proofContractId: "host-capability-promise-v1",
          proofContractVersion: 1,
          proofKind: "operation_containment_ended",
          evidence: { kind: "operation_scope_ended", containmentInstanceId },
        },
      };
    },
  };
}

async function appendInterruptedMayWrite(
  admission: CanonicalAdmissionQueue,
  workspaceId: string,
  sessionId: SessionId,
): Promise<string> {
  const operationId = mkOperationId();
  const common = {
    workspaceId: asWorkspaceId(workspaceId),
    sessionId,
    operationId,
    occurredAt: new Date().toISOString(),
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "recovery-test" } as const,
  };
  await admission.append([
    {
      ...common,
      eventId: mkEventId(),
      type: "operation.requested",
      payload: {
        operationId: String(operationId),
        toolName: "mutate",
        args: { path: "state.txt" },
        isReadOnly: false,
        workspaceAccessClass: "may_write",
        workspaceAccessClassifier: { id: "host-capability-workspace-access-v1", version: 1 },
        quiescenceContract: {
          version: 1,
          containment: "operation_scoped_containment",
          proofContractId: "host-capability-promise-v1",
          proofContractVersion: 1,
          containmentInstanceId: `containment-${String(operationId)}`,
        },
        reconciliationContract: { id: "mutate-reconcile-v1", version: 1 },
      },
    },
    {
      ...common,
      eventId: mkEventId(),
      type: "operation.started",
      payload: { operationId: String(operationId) },
    },
  ] as EventDraft<string, unknown>[]);
  return String(operationId);
}

async function allEvents(locked: LockedWorkspaceStore) {
  return createWorkspaceReadModels(locked.store).getAllEvents();
}

describeLocked("Phase 1 operation recovery barrier", () => {
  it("recovers exact historical quiescence, terminal outcome, effect certainty, and G exactly once", async () => {
    const runtime = await setup("01");
    const operationId = await appendInterruptedMayWrite(runtime.admission, runtime.locked.store.workspaceId, runtime.sessionId);
    await runtime.locked.store.recoverInterruptedOperations();
    const controller = new Phase1RecoveryControllerV1({
      store: runtime.locked.store,
      admission: runtime.admission,
      workspaceCoordinator: { runExclusive: (work) => work() },
      observations: new MutableObservation({ status: "complete", base: base(runtime.locked.store.workspaceId) }),
      capabilities: [recoveryCapability("confirmed")],
    });

    const first = await controller.recover();
    expect(first.clear).toBe(true);
    expect(first.quiescenceProofs).toBe(1);
    expect(first.reconciliations).toBe(1);
    expect(first.effectGenerations).toBe(1);
    expect(await controller.isClear()).toBe(true);

    let events = await allEvents(runtime.locked);
    expect(events.filter((event) => event.type === "operation.mutation_quiesced" && String(event.operationId) === operationId)).toHaveLength(1);
    expect(events.filter((event) => event.type === "operation.reconciliation.resolved" && String(event.operationId) === operationId)).toHaveLength(1);
    expect(events.filter((event) => event.type === "workspace.effect_generation.advanced" && String(event.operationId) === operationId)).toHaveLength(1);
    const operation = reduceOperationsFromEvents(events).find((item) => item.operationId === operationId)!;
    expect(operation.lifecycleState).toBe("terminal");
    expect(operation.effectStatus).toBe("confirmed");
    expect(operation.reconciliationStatus).toBe("resolved");

    const second = await controller.recover();
    expect(second.clear).toBe(true);
    events = await allEvents(runtime.locked);
    expect(events.filter((event) => event.type === "operation.mutation_quiesced" && String(event.operationId) === operationId)).toHaveLength(1);
    expect(events.filter((event) => event.type === "workspace.effect_generation.advanced" && String(event.operationId) === operationId)).toHaveLength(1);
  });

  it("keeps recovery fail-closed when exact historical quiescence cannot be proved", async () => {
    const runtime = await setup("02");
    const operationId = await appendInterruptedMayWrite(runtime.admission, runtime.locked.store.workspaceId, runtime.sessionId);
    await runtime.locked.store.recoverInterruptedOperations();
    const controller = new Phase1RecoveryControllerV1({
      store: runtime.locked.store,
      admission: runtime.admission,
      workspaceCoordinator: { runExclusive: (work) => work() },
      observations: new MutableObservation({ status: "complete", base: base(runtime.locked.store.workspaceId) }),
      capabilities: [recoveryCapability("confirmed", false)],
    });

    const result = await controller.recover();
    expect(result.clear).toBe(false);
    expect(result.writerBarrierOperationIds).toEqual([operationId]);
    expect(await controller.isClear()).toBe(false);
    const events = await allEvents(runtime.locked);
    expect(events.some((event) => event.type === "operation.reconciliation.resolved")).toBe(false);
  });

  it("admits recovered absent effect only after quiescence and does not advance G", async () => {
    const runtime = await setup("03");
    const operationId = await appendInterruptedMayWrite(runtime.admission, runtime.locked.store.workspaceId, runtime.sessionId);
    await runtime.locked.store.recoverInterruptedOperations();
    const controller = new Phase1RecoveryControllerV1({
      store: runtime.locked.store,
      admission: runtime.admission,
      workspaceCoordinator: { runExclusive: (work) => work() },
      observations: new MutableObservation({ status: "complete", base: base(runtime.locked.store.workspaceId) }),
      capabilities: [recoveryCapability("absent")],
    });

    expect((await controller.recover()).clear).toBe(true);
    const events = await allEvents(runtime.locked);
    const q = events.findIndex((event) => event.type === "operation.mutation_quiesced" && String(event.operationId) === operationId);
    const r = events.findIndex((event) => event.type === "operation.reconciliation.resolved" && String(event.operationId) === operationId);
    expect(q).toBeGreaterThanOrEqual(0);
    expect(r).toBeGreaterThan(q);
    expect(events.some((event) => event.type === "workspace.effect_generation.advanced" && String(event.operationId) === operationId)).toBe(false);
    const operation = reduceOperationsFromEvents(events).find((item) => item.operationId === operationId)!;
    expect(operation.effectStatus).toBe("absent");
  });

  it("interrupts orphan Attempts and catches their accepted base up to a recovery mismatch", async () => {
    const runtime = await setup("04");
    const initial = createProgramState({
      programStateId: asProgramStateId(String(mkProgramStateId())),
      sourceSessionId: asSessionId(String(runtime.sessionId)),
      objective: "recover program",
      workItems: [{
        workItemId: asProgramWorkItemId("work-recovery"),
        creationOrder: 0,
        description: "recover",
        dependencyIds: [],
        affectedPaths: ["src/recovery.ts"],
      }],
      verification: [],
      outputSlots: [],
      productionSteps: [],
    });
    const withAttempt = applyProgramTransition(initial, {
      kind: "attempt.issue",
      expectedProgramRevision: initial.revision,
      attempt: {
        programAttemptId: asProgramAttemptId(uuidv7()),
        workItemId: asProgramWorkItemId("work-recovery"),
        sessionId: asSessionId(String(runtime.sessionId)),
        agentGeneration: 1,
        initialExecutionBase: base(runtime.locked.store.workspaceId, 0, "old"),
        expectedExecutionBase: base(runtime.locked.store.workspaceId, 0, "old"),
      },
    });
    await runtime.admission.append([
      {
        eventId: mkEventId(), workspaceId: asWorkspaceId(runtime.locked.store.workspaceId), sessionId: runtime.sessionId,
        programStateId: asEventProgramStateId(String(initial.programStateId)), occurredAt: new Date().toISOString(),
        type: "program.created", payload: { state: initial }, payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "recovery-test" },
      },
      {
        eventId: mkEventId(), workspaceId: asWorkspaceId(runtime.locked.store.workspaceId), sessionId: runtime.sessionId,
        programStateId: asEventProgramStateId(String(initial.programStateId)), occurredAt: new Date().toISOString(),
        type: "program.transitioned", payload: { state: withAttempt, transitionKind: "attempt.issue" }, payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "recovery-test" },
      },
    ]);

    const controller = new Phase1RecoveryControllerV1({
      store: runtime.locked.store,
      admission: runtime.admission,
      workspaceCoordinator: { runExclusive: (work) => work() },
      observations: new MutableObservation({ status: "complete", base: base(runtime.locked.store.workspaceId, 0, "new") }),
      capabilities: [],
    });
    const result = await controller.recover();
    expect(result.clear).toBe(true);
    expect(result.interruptedAttempts).toBe(1);
    const events = await allEvents(runtime.locked);
    const programEvents = events.filter((event) => String(event.programStateId ?? "") === String(initial.programStateId));
    const latest = (programEvents[programEvents.length - 1]!.payload as { state: ProgramState }).state;
    expect(latest.activeAttempt).toBeNull();
    expect(latest.executionBaseMismatch).not.toBeNull();
    expect(latest.executionBaseMismatch?.currentObservationIdentity.stateDigest).toBe("new");
    expect(programEvents.some((event) => (event.payload as Record<string, unknown>).transitionKind === "attempt.interrupt.recovery")).toBe(true);
  });

  it("wires Host startup recovery and advances ordinary post-baseline may_write G in the terminal batch", async () => {
    const runtime = await setup("05");
    const capability = recoveryCapability("confirmed");
    const host = new HostRuntime({
      store: runtime.locked,
      capabilities: [capability],
      policy: new DefaultHostPolicy({ knownTools: ["mutate"], allowMutations: true }),
    });
    const controller = new Phase1RecoveryControllerV1({
      store: runtime.locked.store,
      admission: host.admission,
      workspaceCoordinator: { runExclusive: (work) => work() },
      observations: new MutableObservation({ status: "complete", base: base(runtime.locked.store.workspaceId) }),
      capabilities: [capability],
    });
    host.setPhase1RecoveryController(controller);

    const preStartup = await host.capabilityBroker.execute({
      sessionId: runtime.sessionId,
      toolCallId: "pre-startup",
      toolName: "mutate",
      args: { path: "state.txt" },
    });
    expect(preStartup.errorCode).toBe("workspace_recovery_blocked");

    await host.startup();
    expect(await controller.isClear()).toBe(true);
    const result = await host.capabilityBroker.execute({
      sessionId: runtime.sessionId,
      toolCallId: "after-startup",
      toolName: "mutate",
      args: { path: "state.txt" },
    });
    expect(result.outcome).toBe("succeeded");
    const events = await allEvents(runtime.locked);
    const operationId = String(result.operationId);
    expect(events.filter((event) => event.type === "workspace.effect_generation.advanced" && String(event.operationId) === operationId)).toHaveLength(1);
    expect(events.filter((event) => event.type === "operation.mutation_quiesced" && String(event.operationId) === operationId)).toHaveLength(1);
  });
});


describeLocked("Phase 1 recovery race and attribution corrections", () => {
  it("refreshes a stale mismatch receipt using the session that established the accepted base", async () => {
    const runtime = await setup("06");
    const secondSession = asEventSessionId(uuidv7());
    const initial = createProgramState({
      programStateId: asProgramStateId(String(mkProgramStateId())),
      sourceSessionId: asSessionId(String(runtime.sessionId)),
      objective: "refresh recovery mismatch",
      workItems: [{
        workItemId: asProgramWorkItemId("work-refresh"),
        creationOrder: 0,
        description: "refresh",
        dependencyIds: [],
        affectedPaths: ["src/refresh.ts"],
      }],
      verification: [],
      outputSlots: [],
      productionSteps: [],
    });
    const accepted = applyProgramTransition(initial, {
      kind: "execution_base.adopt",
      expectedProgramRevision: initial.revision,
      executionBase: base(runtime.locked.store.workspaceId, 0, "accepted"),
    });
    const attached = applyProgramTransition(accepted, {
      kind: "session.attach",
      expectedProgramRevision: accepted.revision,
      sessionId: asSessionId(String(secondSession)),
    });
    const oldReceiptId = asExecutionBaseMismatchReceiptId(uuidv7());
    const mismatched = applyProgramTransition(attached, {
      kind: "execution_base.mismatch",
      expectedProgramRevision: attached.revision,
      receipt: {
        receiptId: oldReceiptId,
        programStateId: attached.programStateId,
        expectedProgramRevision: attached.revision,
        acceptedWorkspaceEffectGeneration: 0,
        acceptedObservationIdentity: base(runtime.locked.store.workspaceId, 0, "accepted").observation,
        currentWorkspaceEffectGeneration: 0,
        currentObservationIdentity: base(runtime.locked.store.workspaceId, 0, "candidate-1").observation,
        kind: "observation_mismatch",
        verificationImpactComplete: true,
      },
      invalidateVerificationObligationIds: [],
    });
    const envelope = asEventProgramStateId(String(initial.programStateId));
    await runtime.admission.append([
      {
        eventId: mkEventId(), workspaceId: asWorkspaceId(runtime.locked.store.workspaceId), sessionId: runtime.sessionId,
        programStateId: envelope, occurredAt: new Date().toISOString(), type: "program.created",
        payload: { state: initial }, payloadSchemaVersion: 1, producer: { kind: "runtime", component: "recovery-test" },
      },
      {
        eventId: mkEventId(), workspaceId: asWorkspaceId(runtime.locked.store.workspaceId), sessionId: runtime.sessionId,
        programStateId: envelope, occurredAt: new Date().toISOString(), type: "program.transitioned",
        payload: { state: accepted, transitionKind: "execution_base.adopt" }, payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "recovery-test" },
      },
      {
        eventId: mkEventId(), workspaceId: asWorkspaceId(runtime.locked.store.workspaceId), sessionId: secondSession,
        programStateId: envelope, occurredAt: new Date().toISOString(), type: "program.transitioned",
        payload: { state: attached, transitionKind: "session.attach" }, payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "recovery-test" },
      },
      {
        eventId: mkEventId(), workspaceId: asWorkspaceId(runtime.locked.store.workspaceId), sessionId: secondSession,
        programStateId: envelope, occurredAt: new Date().toISOString(), type: "program.transitioned",
        payload: { state: mismatched, transitionKind: "execution_base.mismatch" }, payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "recovery-test" },
      },
    ]);

    const controller = new Phase1RecoveryControllerV1({
      store: runtime.locked.store,
      admission: runtime.admission,
      workspaceCoordinator: { runExclusive: (work) => work() },
      observations: new MutableObservation({
        status: "complete",
        base: base(runtime.locked.store.workspaceId, 0, "candidate-2"),
      }),
      capabilities: [],
    });
    const result = await controller.recover();
    expect(result.clear).toBe(true);
    const events = await allEvents(runtime.locked);
    const refresh = [...events].reverse().find((event) =>
      event.type === "program.transitioned" &&
      String(event.programStateId ?? "") === String(initial.programStateId) &&
      (event.payload as Record<string, unknown>).transitionKind === "execution_base.mismatch.recovery",
    );
    expect(refresh).toBeDefined();
    expect(String(refresh!.sessionId)).toBe(String(runtime.sessionId));
    const latest = (refresh!.payload as { state: ProgramState }).state;
    expect(String(latest.executionBaseMismatch?.receiptId)).not.toBe(String(oldReceiptId));
    expect(latest.executionBaseMismatch?.currentObservationIdentity.stateDigest).toBe("candidate-2");
  });

  it("rechecks ordinary may_write admission inside the canonical lane after concurrent prechecks", async () => {
    const runtime = await setup("07");
    const capability = recoveryCapability("confirmed");
    const host = new HostRuntime({
      store: runtime.locked,
      capabilities: [capability],
      policy: new DefaultHostPolicy({ knownTools: ["mutate"], allowMutations: true }),
    });

    let calls = 0;
    let releaseTop!: () => void;
    const topReleased = new Promise<void>((resolve) => { releaseTop = resolve; });
    const authority = {
      async mayWriteAdmissionStatus() {
        calls += 1;
        if (calls <= 2) {
          if (calls === 2) releaseTop();
          await topReleased;
          return { status: "clear" as const };
        }
        if (calls === 3) return { status: "clear" as const };
        return { status: "writer_barrier" as const, operationIds: ["concurrent-writer"] };
      },
    };
    host.capabilityBroker.setWorkspaceMutationAdmissionAuthority(authority);

    const [first, second] = await Promise.all([
      host.capabilityBroker.execute({
        sessionId: runtime.sessionId,
        toolCallId: "race-a",
        toolName: "mutate",
        args: { path: "a.txt" },
      }),
      host.capabilityBroker.execute({
        sessionId: runtime.sessionId,
        toolCallId: "race-b",
        toolName: "mutate",
        args: { path: "b.txt" },
      }),
    ]);
    const outcomes = [first, second];
    expect(outcomes.filter((result) => result.outcome === "succeeded")).toHaveLength(1);
    expect(outcomes.find((result) => result.errorCode === "workspace_writer_barrier")).toBeDefined();
    expect(calls).toBeGreaterThanOrEqual(4);
  });
});


describeLocked("WorkspaceEffectGeneration recovery integrity", () => {
  it("fails closed on a non-contiguous durable generation history", async () => {
    const runtime = await setup("08");
    const operationId = mkOperationId();
    await runtime.admission.append([{
      eventId: mkEventId(),
      workspaceId: asWorkspaceId(runtime.locked.store.workspaceId),
      sessionId: runtime.sessionId,
      operationId,
      occurredAt: new Date().toISOString(),
      type: "workspace.effect_generation.advanced",
      payload: {
        operationId: String(operationId),
        previousWorkspaceEffectGeneration: 0,
        workspaceEffectGeneration: 2,
        effectStatus: "confirmed",
      },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "recovery-integrity-test" },
    }]);
    const controller = new Phase1RecoveryControllerV1({
      store: runtime.locked.store,
      admission: runtime.admission,
      workspaceCoordinator: { runExclusive: (work) => work() },
      observations: new MutableObservation({
        status: "complete",
        base: base(runtime.locked.store.workspaceId, 0, "current"),
      }),
      capabilities: [],
    });
    await expect(controller.recover()).rejects.toThrow("Invalid WorkspaceEffectGeneration continuity");
    expect(await controller.isClear()).toBe(false);
  });
});
