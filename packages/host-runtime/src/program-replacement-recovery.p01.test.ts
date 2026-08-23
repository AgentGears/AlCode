import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asProgramStateId as asEventProgramStateId,
  asWorkspaceId,
  mkEventId,
  mkOperationId,
  mkProgramStateId,
  uuidv7,
  type EventDraft,
} from "@alcode/events";
import {
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  createProgramState,
  type ProgramAttemptExecutionBase,
} from "@alcode/program-state";
import { openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import type { HostCapability } from "./capability-broker.ts";
import { ProgramAgentServiceV1 } from "./program-agent.ts";
import { ProgramDispatchServiceV1 } from "./program-dispatch.ts";
import { ProgramExecutionSchedulerV1 } from "./program-execution-scheduler.ts";
import { Phase1RecoveryControllerV1 } from "./program-recovery.ts";
import { HostSessionManager } from "./session-manager.ts";

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
      providerKind: "p01-replacement-test",
      workspaceIdentity,
      coverageDigest: "coverage-v1",
      stateDigest: "state-v1",
    },
  };
}

function recoveryCapability(quiescenceAvailable: boolean): HostCapability {
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
          effectStatus: "absent" as const,
          executionOutcome: "failed" as const,
          evidence: { source: "p01-replacement-test", effect: "absent" },
        };
      },
    },
    async execute(_args, context) {
      const containmentInstanceId = context.quiescenceContract?.containmentInstanceId ?? "missing";
      return {
        outcome: "failed" as const,
        result: "unused",
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

async function fixture(quiescenceAvailable: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "alcode-p01-replacement-recovery-"));
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
  const agents = new ProgramAgentServiceV1(locked.store, admission);
  const generationA = await agents.attach(session.sessionId, "connection-a", true, true);
  const workItemId = asProgramWorkItemId("work-replacement");
  const initial = createProgramState({
    programStateId: asProgramStateId(String(mkProgramStateId())),
    sourceSessionId: asSessionId(String(session.sessionId)),
    objective: "Recover exact operation effects before replacement execution",
    workItems: [{
      workItemId,
      creationOrder: 0,
      description: "Perform replacement-safe work",
      dependencyIds: [],
      affectedPaths: ["state.txt"],
    }],
    verification: [],
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
    producer: { kind: "runtime", component: "p01-replacement-recovery-test" },
  }]);

  const observedBase = base(locked.store.workspaceId);
  const recovery = new Phase1RecoveryControllerV1({
    store: locked.store,
    admission,
    workspaceCoordinator: { runExclusive: (work) => work() },
    observations: { observe: async () => ({ status: "complete" as const, base: observedBase }) },
    capabilities: [recoveryCapability(quiescenceAvailable)],
  });
  const initialRecovery = await recovery.recover();
  if (!initialRecovery.clear) throw new Error(`initial recovery blocked: ${initialRecovery.reason ?? "unknown"}`);
  const dispatch = new ProgramDispatchServiceV1({
    store: locked.store,
    admission,
    workspaceCoordinator: { runExclusive: (work) => work() },
    observations: { observe: async () => ({ status: "complete" as const, base: observedBase }) },
    agentGenerations: agents,
    recovery,
    firstDispatchPlanning: { recheckAcceptedPlanningBase: async () => undefined },
  });
  const issuedA = await dispatch.issueAttempt({
    programStateId: String(initial.programStateId),
    expectedProgramRevision: initial.revision,
    workItemId: String(workItemId),
    sessionId: session.sessionId,
    agentGeneration: generationA,
  });
  if (issuedA.status !== "issued") throw new Error(`Attempt A not issued: ${issuedA.status}`);

  const operationId = mkOperationId();
  const common = {
    workspaceId: asWorkspaceId(locked.store.workspaceId),
    sessionId: session.sessionId,
    operationId,
    programStateId: asEventProgramStateId(String(initial.programStateId)),
    occurredAt: new Date().toISOString(),
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "p01-replacement-recovery-test" } as const,
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

  const generationB = await agents.attach(session.sessionId, "connection-b", true, true);
  await locked.store.recoverInterruptedOperations();
  const scheduler = new ProgramExecutionSchedulerV1({ store: locked.store, dispatch, agents });
  return { locked, session, agents, recovery, scheduler, initial, workItemId, issuedA, generationA, generationB };
}

describeLocked("P-01 Agent replacement recovery", () => {
  it("retires generation A and issues a fresh B Attempt after an admitted operation is proven absent and quiescent", async () => {
    const test = await fixture(true);
    expect(test.generationB).toBeGreaterThan(test.generationA);
    expect(await test.agents.currentAttemptAuthority(test.session.sessionId)).toBeUndefined();
    const recovered = await test.recovery.recover();
    expect(recovered.clear).toBe(true);
    const scheduled = await test.scheduler.dispatchNext({
      programStateId: String(test.initial.programStateId),
      sessionId: test.session.sessionId,
    });
    expect(scheduled.status).toBe("issued");
    if (scheduled.status !== "issued") throw new Error(`replacement Attempt not issued: ${scheduled.status}`);
    expect(scheduled.programAttemptId).not.toBe(test.issuedA.programAttemptId);
    expect(scheduled.state.activeAttempt?.agentGeneration).toBe(test.generationB);
  });

  it("keeps replacement execution recovery-blocked when exact mutation quiescence is indeterminate", async () => {
    const test = await fixture(false);
    expect(test.generationB).toBeGreaterThan(test.generationA);
    expect(await test.agents.currentAttemptAuthority(test.session.sessionId)).toBeUndefined();
    const recovered = await test.recovery.recover();
    expect(recovered.clear).toBe(false);
    const scheduled = await test.scheduler.dispatchNext({
      programStateId: String(test.initial.programStateId),
      sessionId: test.session.sessionId,
    });
    expect(scheduled.status).toBe("recovery_blocked");
    expect(await test.agents.currentAttemptAuthority(test.session.sessionId)).toBeUndefined();
  });
});
