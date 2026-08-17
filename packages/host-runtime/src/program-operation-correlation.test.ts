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
  type EventDraft,
  type PersistedDomainEvent,
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
import { CapabilityBroker, type HostCapability } from "./capability-broker.ts";
import { CognitionGateway } from "./cognition-gateway.ts";
import { DefaultHostPolicy } from "./policy.ts";
import { ProgramDispatchServiceV1 } from "./program-dispatch.ts";
import { HostSessionManager } from "./session-manager.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function base(workspaceIdentity: string): ProgramAttemptExecutionBase {
  return { workspaceEffectGeneration: 0, observation: { kind: "workspace-observation-v1", providerKind: "program-operation-test", workspaceIdentity, coverageDigest: "coverage-v1", stateDigest: "state-v1" } };
}

function program(sessionId: SessionId, suffix: string): ProgramState {
  return createProgramState({
    programStateId: asProgramStateId(String(mkProgramStateId())),
    sourceSessionId: asSessionId(String(sessionId)),
    objective: `Operation ${suffix}`,
    workItems: [{ workItemId: asProgramWorkItemId(`work-${suffix}`), creationOrder: 0, description: `Do ${suffix}`, dependencyIds: [], affectedPaths: [`src/${suffix}.ts`] }],
    verification: [], outputSlots: [], productionSteps: [],
  });
}

async function replay(locked: LockedWorkspaceStore): Promise<PersistedDomainEvent<string, unknown>[]> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of locked.store.replay()) events.push(event);
  return events;
}

async function setup(suffix: string, capability: HostCapability) {
  const dir = mkdtempSync(join(tmpdir(), `alcode-program-operation-${suffix}-`));
  dirs.push(dir);
  const locked = await openLockedWorkspaceStore({ databasePath: join(dir, "workspace.sqlite"), lockPath: join(dir, "workspace.lock"), workspaceId: `018f0000-0000-7000-8000-0000000005${suffix.padStart(2, "0")}`, repositoryId: `program-operation-${suffix}` });
  const admission = new CanonicalAdmissionQueue(locked.store);
  const sessions = new HostSessionManager(locked, admission);
  const session = await sessions.openOrResume();
  const initial = program(session.sessionId, suffix);
  await admission.append([{ eventId: mkEventId(), workspaceId: asWorkspaceId(locked.store.workspaceId), sessionId: session.sessionId, programStateId: asEventProgramStateId(String(initial.programStateId)), occurredAt: new Date().toISOString(), type: "program.created", payload: { state: initial }, payloadSchemaVersion: 1, producer: { kind: "runtime", component: "program-operation-test" } }]);
  const current = base(locked.store.workspaceId);
  const dispatch = new ProgramDispatchServiceV1({ store: locked.store, admission, workspaceCoordinator: { runExclusive: (work) => work() }, observations: { observe: async () => ({ status: "complete" as const, base: current }) }, agentGenerations: { isCurrent: (_sessionId, generation) => generation === 7 }, recovery: { isClear: () => true }, firstDispatchPlanning: { recheckAcceptedPlanningBase: async () => {} } });
  const issued = await dispatch.issueAttempt({ programStateId: String(initial.programStateId), expectedProgramRevision: initial.revision, workItemId: `work-${suffix}`, sessionId: session.sessionId, agentGeneration: 7 });
  if (issued.status !== "issued") throw new Error(`expected Attempt issuance, got ${issued.status}`);
  const broker = new CapabilityBroker(locked.store, admission, new CognitionGateway(locked), new DefaultHostPolicy({ knownTools: [capability.name], allowMutations: true }), [capability]);
  broker.setProgramOperationAuthority(dispatch);
  return { locked, admission, session, initial, issued, dispatch, broker };
}

function programContext(runtime: Awaited<ReturnType<typeof setup>>, suffix: string) {
  return { programStateId: String(runtime.initial.programStateId), expectedProgramRevision: runtime.issued.state.revision, programAttemptId: runtime.issued.programAttemptId, workItemId: `work-${suffix}`, agentGeneration: 7 };
}

describeLocked("Program root operation correlation", () => {
  it("binds a read-only root operation to the exact current ProgramAttempt", async () => {
    let executed = 0;
    const runtime = await setup("11", { name: "inspect", workspaceAccessClass: "read_only", async execute() { executed += 1; return { result: { ok: true }, outcome: "succeeded" }; } });
    const result = await runtime.broker.execute({ sessionId: runtime.session.sessionId, toolCallId: "tc-program-read", toolName: "inspect", args: { path: "src/11.ts" } });
    expect(result.outcome).toBe("succeeded");
    expect(executed).toBe(1);
    const events = await replay(runtime.locked);
    const requested = events.find((event) => event.type === "operation.requested");
    expect(String(requested?.programStateId)).toBe(String(runtime.initial.programStateId));
    expect(requested?.payload).toMatchObject({ programStateId: String(runtime.initial.programStateId), expectedProgramRevision: runtime.issued.state.revision, programAttemptId: runtime.issued.programAttemptId, workItemId: "work-11", agentGeneration: 7, workspaceAccessClass: "read_only", workspaceAccessClassifier: { id: "host-capability-workspace-access-v1", version: 1 } });
    expect(events.some((event) => event.type === "operation.mutation_quiesced")).toBe(false);
    runtime.locked.close();
  });

  it("atomically routes an Attempt issued after capability handling begins but before root admission", async () => {
    const suffix = "17";
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-operation-race-"));
    dirs.push(dir);
    const locked = await openLockedWorkspaceStore({ databasePath: join(dir, "workspace.sqlite"), lockPath: join(dir, "workspace.lock"), workspaceId: "018f0000-0000-7000-8000-000000000517", repositoryId: "program-operation-race" });
    const admission = new CanonicalAdmissionQueue(locked.store);
    const sessions = new HostSessionManager(locked, admission);
    const session = await sessions.openOrResume();
    const initial = program(session.sessionId, suffix);
    await admission.append([{ eventId: mkEventId(), workspaceId: asWorkspaceId(locked.store.workspaceId), sessionId: session.sessionId, programStateId: asEventProgramStateId(String(initial.programStateId)), occurredAt: new Date().toISOString(), type: "program.created", payload: { state: initial }, payloadSchemaVersion: 1, producer: { kind: "runtime", component: "program-operation-race-test" } }]);
    const current = base(locked.store.workspaceId);
    const dispatch = new ProgramDispatchServiceV1({ store: locked.store, admission, workspaceCoordinator: { runExclusive: (work) => work() }, observations: { observe: async () => ({ status: "complete" as const, base: current }) }, agentGenerations: { isCurrent: (_sessionId, generation) => generation === 7 }, recovery: { isClear: () => true }, firstDispatchPlanning: { recheckAcceptedPlanningBase: async () => {} } });
    let releasePolicy!: () => void;
    let policyEntered!: () => void;
    const entered = new Promise<void>((resolve) => { policyEntered = resolve; });
    const released = new Promise<void>((resolve) => { releasePolicy = resolve; });
    let executed = 0;
    const broker = new CapabilityBroker(locked.store, admission, new CognitionGateway(locked), { authorizeCapability: async () => { policyEntered(); await released; return { allowed: true as const }; } }, [{ name: "inspect", workspaceAccessClass: "read_only", async execute() { executed += 1; return { result: {}, outcome: "succeeded" }; } }]);
    broker.setProgramOperationAuthority(dispatch);

    const pending = broker.execute({ sessionId: session.sessionId, toolCallId: "tc-race", toolName: "inspect", args: {} });
    await entered;
    const issued = await dispatch.issueAttempt({ programStateId: String(initial.programStateId), expectedProgramRevision: initial.revision, workItemId: "work-17", sessionId: session.sessionId, agentGeneration: 7 });
    if (issued.status !== "issued") throw new Error(`expected Attempt issuance, got ${issued.status}`);
    releasePolicy();
    const result = await pending;
    expect(result.outcome).toBe("succeeded");
    expect(executed).toBe(1);
    const requested = (await replay(locked)).find((event) => event.type === "operation.requested");
    expect(String(requested?.programStateId)).toBe(String(initial.programStateId));
    expect(requested?.payload).toMatchObject({ programAttemptId: issued.programAttemptId, expectedProgramRevision: issued.state.revision, workItemId: "work-17", agentGeneration: 7 });
    locked.close();
  });

  it("fails closed when an active ProgramAttempt exists before Host Program authority is wired", async () => {
    let executed = 0;
    const runtime = await setup("16", { name: "inspect", workspaceAccessClass: "read_only", async execute() { executed += 1; return { result: {}, outcome: "succeeded" }; } });
    runtime.broker.setProgramOperationAuthority(undefined);
    const before = (await replay(runtime.locked)).filter((event) => event.type === "operation.requested").length;
    const result = await runtime.broker.execute({ sessionId: runtime.session.sessionId, toolCallId: "tc-no-program-authority", toolName: "inspect", args: {} });
    expect(result).toMatchObject({ outcome: "denied", errorCode: "program_operation_authority_unavailable" });
    expect(executed).toBe(0);
    expect((await replay(runtime.locked)).filter((event) => event.type === "operation.requested")).toHaveLength(before);
    runtime.locked.close();
  });

  it("rejects stale Attempt authority before operation.requested or environmental execution", async () => {
    let executed = 0;
    const runtime = await setup("12", { name: "inspect", workspaceAccessClass: "read_only", async execute() { executed += 1; return { result: {}, outcome: "succeeded" }; } });
    const before = (await replay(runtime.locked)).filter((event) => event.type === "operation.requested").length;
    const stale = await runtime.broker.execute({ sessionId: runtime.session.sessionId, toolCallId: "tc-stale", toolName: "inspect", args: {}, program: { ...programContext(runtime, "12"), programAttemptId: `${runtime.issued.programAttemptId}-stale` } });
    expect(stale).toMatchObject({ outcome: "stale", errorCode: "program_execution_stale" });
    expect(executed).toBe(0);
    expect((await replay(runtime.locked)).filter((event) => event.type === "operation.requested")).toHaveLength(before);
    runtime.locked.close();
  });

  it("rejects Program may_write without supported containment before operation.requested", async () => {
    let executed = 0;
    const runtime = await setup("13", { name: "mutate", workspaceAccessClass: "may_write", async execute() { executed += 1; return { result: {}, outcome: "succeeded" }; } });
    const result = await runtime.broker.execute({ sessionId: runtime.session.sessionId, toolCallId: "tc-no-quiescence", toolName: "mutate", args: {}, program: programContext(runtime, "13") });
    expect(result).toMatchObject({ outcome: "denied", errorCode: "program_quiescence_unsupported" });
    expect(executed).toBe(0);
    expect((await replay(runtime.locked)).some((event) => event.type === "operation.requested")).toBe(false);
    runtime.locked.close();
  });

  it("returns structured stale when protected Program observation is unavailable", async () => {
    const runtime = await setup("19", { name: "inspect", workspaceAccessClass: "read_only", async execute() { return { result: {}, outcome: "succeeded" }; } });
    const unavailable = new ProgramDispatchServiceV1({
      store: runtime.locked.store,
      admission: runtime.admission,
      workspaceCoordinator: { runExclusive: (work) => work() },
      observations: { observe: async () => ({ status: "unknown" as const, reason: "tracker unavailable" }) },
      agentGenerations: { isCurrent: (_sessionId, generation) => generation === 7 },
      recovery: { isClear: () => true },
      firstDispatchPlanning: { recheckAcceptedPlanningBase: async () => {} },
    });
    runtime.broker.setProgramOperationAuthority(unavailable);
    const before = (await replay(runtime.locked)).filter((event) => event.type === "operation.requested").length;
    const result = await runtime.broker.execute({ sessionId: runtime.session.sessionId, toolCallId: "tc-stale-result", toolName: "inspect", args: {} });
    expect(result).toMatchObject({ outcome: "stale", errorCode: "program_execution_stale" });
    expect((await replay(runtime.locked)).filter((event) => event.type === "operation.requested")).toHaveLength(before);
    runtime.locked.close();
  });

  it("settles supported Program may_write through confirmed G advancement and post-quiescence observation", async () => {
    let executed = 0;
    const runtime = await setup("14", { name: "mutate", workspaceAccessClass: "may_write", quiescence: { containmentKind: "operation_scoped_containment", proofContractId: "host-capability-promise-v1", proofContractVersion: 1 }, async execute() { executed += 1; return { result: { ok: true }, outcome: "succeeded" }; } });
    const result = await runtime.broker.execute({ sessionId: runtime.session.sessionId, toolCallId: "tc-settled-mutation", toolName: "mutate", args: { path: "src/14.ts" } });
    expect(result).toMatchObject({ outcome: "succeeded", result: { ok: true } });
    expect(executed).toBe(1);

    const events = await replay(runtime.locked);
    const requested = events.find((event) => event.type === "operation.requested");
    expect(requested?.payload).toMatchObject({
      workspaceAccessClass: "may_write",
      quiescenceContract: {
        containment: "operation_scoped_containment",
        proofContractId: "host-capability-promise-v1",
        proofContractVersion: 1,
      },
    });
    expect(events.some((event) => event.type === "operation.completed")).toBe(true);
    expect(events.some((event) => event.type === "operation.mutation_quiesced")).toBe(true);
    const generation = events.find((event) => event.type === "workspace.effect_generation.advanced");
    expect(generation?.payload).toMatchObject({ previousWorkspaceEffectGeneration: 0, workspaceEffectGeneration: 1, effectStatus: "confirmed" });
    const transition = [...events].reverse().find((event) => event.type === "program.transitioned");
    expect(transition?.payload).toMatchObject({
      transitionKind: "attempt.execution_base.advance",
      state: { revision: 3, acceptedExecutionBase: { workspaceEffectGeneration: 1 } },
    });

    await expect(runtime.dispatch.assertCurrentAttempt({
      programStateId: String(runtime.initial.programStateId),
      expectedProgramRevision: 3,
      programAttemptId: runtime.issued.programAttemptId,
      workItemId: "work-14",
      sessionId: runtime.session.sessionId,
      agentGeneration: 7,
    })).resolves.toMatchObject({ executionBase: { workspaceEffectGeneration: 1 } });
    runtime.locked.close();
  });

  it("keeps failed Program may_write effect certainty unavailable after quiescence", async () => {
    const runtime = await setup("19", { name: "mutate", workspaceAccessClass: "may_write", quiescence: { containmentKind: "operation_scoped_containment", proofContractId: "host-capability-promise-v1", proofContractVersion: 1 }, async execute() { return { result: { ok: false }, outcome: "failed" }; } });
    const result = await runtime.broker.execute({ sessionId: runtime.session.sessionId, toolCallId: "tc-indeterminate-mutation", toolName: "mutate", args: {} });
    expect(result).toMatchObject({ outcome: "failed", result: { ok: false } });
    const events = await replay(runtime.locked);
    expect(events.some((event) => event.type === "operation.mutation_quiesced")).toBe(true);
    expect(events.some((event) => event.type === "workspace.effect_generation.advanced")).toBe(false);
    const transition = [...events].reverse().find((event) => event.type === "program.transitioned");
    expect(transition?.payload).toMatchObject({ transitionKind: "execution_base.unavailable", state: { executionBaseUnavailable: true, activeAttempt: null } });
    runtime.locked.close();
  });

  it("fails an invalid explicit Workspace access class closed to may_write", async () => {
    let executed = 0;
    const runtime = await setup("18", {
      name: "inspect",
      workspaceAccessClass: "READ_ONL" as unknown as "read_only",
      isReadOnly: true,
      async execute() { executed += 1; return { result: {}, outcome: "succeeded" }; },
    });
    const before = (await replay(runtime.locked)).filter((event) => event.type === "operation.requested").length;
    const result = await runtime.broker.execute({ sessionId: runtime.session.sessionId, toolCallId: "tc-invalid-access", toolName: "inspect", args: {} });
    expect(result).toMatchObject({ outcome: "denied", errorCode: "program_quiescence_unsupported" });
    expect(executed).toBe(0);
    expect((await replay(runtime.locked)).filter((event) => event.type === "operation.requested")).toHaveLength(before);
    runtime.locked.close();
  });

  it("keeps an unsupported ordinary writer on the legacy completion-cleared path", async () => {
    const suffix = "20";
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-operation-ordinary-writer-"));
    dirs.push(dir);
    const locked = await openLockedWorkspaceStore({ databasePath: join(dir, "workspace.sqlite"), lockPath: join(dir, "workspace.lock"), workspaceId: "018f0000-0000-7000-8000-000000000520", repositoryId: "program-operation-ordinary-writer" });
    const admission = new CanonicalAdmissionQueue(locked.store);
    const sessions = new HostSessionManager(locked, admission);
    const session = await sessions.openOrResume();
    const initial = program(session.sessionId, suffix);
    await admission.append([{ eventId: mkEventId(), workspaceId: asWorkspaceId(locked.store.workspaceId), sessionId: session.sessionId, programStateId: asEventProgramStateId(String(initial.programStateId)), occurredAt: new Date().toISOString(), type: "program.created", payload: { state: initial }, payloadSchemaVersion: 1, producer: { kind: "runtime", component: "ordinary-writer-test" } }]);
    const current = base(locked.store.workspaceId);
    const dispatch = new ProgramDispatchServiceV1({ store: locked.store, admission, workspaceCoordinator: { runExclusive: (work) => work() }, observations: { observe: async () => ({ status: "complete" as const, base: current }) }, agentGenerations: { isCurrent: (_sessionId, generation) => generation === 7 }, recovery: { isClear: () => true }, firstDispatchPlanning: { recheckAcceptedPlanningBase: async () => {} } });
    const broker = new CapabilityBroker(locked.store, admission, new CognitionGateway(locked), new DefaultHostPolicy({ knownTools: ["mutate"], allowMutations: true }), [{ name: "mutate", isReadOnly: false, async execute() { return { result: {}, outcome: "succeeded" }; } }]);
    broker.setProgramOperationAuthority(dispatch);
    const mutation = await broker.execute({ sessionId: session.sessionId, toolCallId: "tc-ordinary-writer", toolName: "mutate", args: {} });
    expect(mutation.outcome).toBe("succeeded");
    const requested = (await replay(locked)).find((event) => event.type === "operation.requested");
    expect((requested?.payload as Record<string, unknown>).workspaceAccessClass).toBeUndefined();
    const issued = await dispatch.issueAttempt({ programStateId: String(initial.programStateId), expectedProgramRevision: initial.revision, workItemId: "work-20", sessionId: session.sessionId, agentGeneration: 7 });
    expect(issued.status).toBe("issued");
    locked.close();
  });

  it("does not turn a completed legacy pre-baseline writer into a permanent barrier", async () => {
    const runtime = await setup("15", { name: "inspect", workspaceAccessClass: "read_only", async execute() { return { result: {}, outcome: "succeeded" }; } });
    const legacyOperationId = mkOperationId();
    const drafts: EventDraft<string, unknown>[] = [
      { eventId: mkEventId(), workspaceId: asWorkspaceId(runtime.locked.store.workspaceId), sessionId: runtime.session.sessionId, operationId: legacyOperationId, occurredAt: new Date().toISOString(), type: "operation.requested", payload: { operationId: legacyOperationId as string, toolName: "legacy", args: {}, isReadOnly: false }, payloadSchemaVersion: 1, producer: { kind: "runtime", component: "legacy-test" } },
      { eventId: mkEventId(), workspaceId: asWorkspaceId(runtime.locked.store.workspaceId), sessionId: runtime.session.sessionId, operationId: legacyOperationId, occurredAt: new Date().toISOString(), type: "operation.completed", payload: { operationId: legacyOperationId as string, outcome: "succeeded", isReadOnly: false }, payloadSchemaVersion: 1, producer: { kind: "runtime", component: "legacy-test" } },
    ];
    await runtime.admission.append(drafts);
    await expect(runtime.dispatch.assertCurrentAttempt({ programStateId: String(runtime.initial.programStateId), expectedProgramRevision: runtime.issued.state.revision, programAttemptId: runtime.issued.programAttemptId, workItemId: "work-15", sessionId: runtime.session.sessionId, agentGeneration: 7 })).resolves.toBeDefined();
    runtime.locked.close();
  });
});
