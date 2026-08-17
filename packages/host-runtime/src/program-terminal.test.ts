import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asProgramStateId as asEventProgramStateId,
  asSessionId as asEventSessionId,
  asWorkspaceId,
  mkEventId,
  mkProgramStateId,
  uuidv7,
  type EventDraft,
} from "@alcode/events";
import {
  applyProgramTransition,
  asProgramArtifactProductionStepId,
  asProgramAttemptId,
  asProgramEvidenceRefId,
  asProgramOutputSlotId,
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
import { HostArtifactStore } from "./artifact-store.ts";
import { ProgramTerminalServiceV1, ProgramTerminalStaleError } from "./program-terminal.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;
const stores: LockedWorkspaceStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* closed */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function base(workspaceIdentity: string, stateDigest = "state-0", generation = 0): ProgramAttemptExecutionBase {
  return {
    workspaceEffectGeneration: generation,
    observation: {
      kind: "workspace-observation-v1",
      providerKind: "terminal-test",
      workspaceIdentity,
      coverageDigest: "coverage-v1",
      stateDigest,
    },
  };
}

class ObservationSource {
  beforeObserve: (() => Promise<void>) | undefined;
  constructor(public current: ProgramAttemptExecutionBase) {}
  async observe() {
    if (this.beforeObserve) {
      const callback = this.beforeObserve;
      this.beforeObserve = undefined;
      await callback();
    }
    return { status: "complete" as const, base: this.current };
  }
}

async function latestState(store: LockedWorkspaceStore, programStateId: string): Promise<ProgramState> {
  let latest: ProgramState | undefined;
  for await (const event of store.store.replay()) {
    if (String(event.programStateId ?? "") !== programStateId) continue;
    if (event.type === "program.created" || event.type === "program.transitioned" ||
        event.type === "program.completed" || event.type === "program.cancelled") {
      latest = (event.payload as { state: ProgramState }).state;
    }
  }
  if (!latest) throw new Error("missing ProgramState");
  return latest;
}

async function countType(store: LockedWorkspaceStore, type: string): Promise<number> {
  let count = 0;
  for await (const event of store.store.replay()) if (event.type === type) count++;
  return count;
}

async function setup(options: { artifactVerification?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "alcode-program-terminal-"));
  dirs.push(dir);
  const workspaceId = asWorkspaceId(uuidv7());
  const locked = await openLockedWorkspaceStore({
    databasePath: join(dir, "workspace.sqlite"),
    lockPath: join(dir, "workspace.lock"),
    workspaceId,
    repositoryId: uuidv7(),
  });
  stores.push(locked);
  const admission = new CanonicalAdmissionQueue(locked.store);
  const sessionId = asEventSessionId(uuidv7());
  const workItemId = asProgramWorkItemId("work-1");
  const obligationId = asVerificationObligationId("verify-1");
  const outputSlotId = asProgramOutputSlotId("slot-1");
  const productionStepId = asProgramArtifactProductionStepId("produce-1");
  const initial = createProgramState({
    programStateId: asProgramStateId(String(mkProgramStateId())),
    sourceSessionId: asSessionId(String(sessionId)),
    objective: "terminal",
    workItems: [{ workItemId, creationOrder: 0, description: "finish", dependencyIds: [], affectedPaths: [] }],
    verification: options.artifactVerification ? [{
      obligationId,
      predicate: { kind: "artifact_present", outputSlotId },
      freshnessScope: { kind: "workspace" },
    }] : [],
    outputSlots: options.artifactVerification ? [{ outputSlotId, productionStepId }] : [],
    productionSteps: options.artifactVerification ? [{
      productionStepId,
      producerWorkItemId: workItemId,
      outputChannel: "stdout",
      specId: "produce",
      specVersion: 1,
      canonicalArgs: {},
      canonicalArgsDigest: "args-digest",
    }] : [],
  });
  await admission.append([{
    eventId: mkEventId(),
    workspaceId,
    sessionId,
    programStateId: asEventProgramStateId(String(initial.programStateId)),
    occurredAt: new Date().toISOString(),
    type: "program.created",
    payload: { state: initial },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "terminal-test" },
  }]);
  const observations = new ObservationSource(base(String(workspaceId)));
  const artifactStore = new HostArtifactStore({ root: join(dir, "artifacts") });
  await artifactStore.initialize();
  const coordinator = { runExclusive: <T>(work: () => Promise<T>) => work() };
  const recovery = { isClear: () => true };
  const service = new ProgramTerminalServiceV1({
    store: locked.store,
    admission,
    workspaceCoordinator: coordinator,
    observations,
    recovery,
    artifactStore,
  });
  return {
    dir, locked, admission, sessionId, workItemId, obligationId, outputSlotId, productionStepId,
    initial, observations, artifactStore, service,
  };
}

async function appendState(
  fixture: Awaited<ReturnType<typeof setup>>,
  state: ProgramState,
  transitionKind: string,
): Promise<void> {
  const draft: EventDraft<string, unknown> = {
    eventId: mkEventId(),
    workspaceId: asWorkspaceId(fixture.locked.store.workspaceId),
    sessionId: fixture.sessionId,
    programStateId: asEventProgramStateId(String(state.programStateId)),
    occurredAt: new Date().toISOString(),
    type: "program.transitioned",
    payload: { state, transitionKind },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "terminal-test" },
  };
  await fixture.admission.append([draft]);
}

async function makeCompletable(fixture: Awaited<ReturnType<typeof setup>>): Promise<ProgramState> {
  const adopted = applyProgramTransition(fixture.initial, {
    kind: "execution_base.adopt",
    expectedProgramRevision: fixture.initial.revision,
    executionBase: fixture.observations.current,
  });
  const completedWork = applyProgramTransition(adopted, {
    kind: "work.lifecycle.set",
    expectedProgramRevision: adopted.revision,
    workItemId: fixture.workItemId,
    lifecycle: "completed",
  });
  await appendState(fixture, adopted, "execution_base.adopt");
  await appendState(fixture, completedWork, "work.lifecycle.set");
  return completedWork;
}

describeLocked("Program terminal authority", () => {
  it("completes once at the protected current execution base and makes retry idempotent", async () => {
    const f = await setup();
    const ready = await makeCompletable(f);
    const result = await f.service.complete({
      programStateId: String(ready.programStateId),
      expectedProgramRevision: ready.revision,
      sessionId: f.sessionId,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("completion failed");
    expect(result.state.lifecycle).toBe("completed");
    expect(result.duplicate).toBe(false);
    expect(await countType(f.locked, "program.completed")).toBe(1);

    const retry = await f.service.complete({
      programStateId: String(ready.programStateId),
      expectedProgramRevision: ready.revision,
      sessionId: f.sessionId,
    });
    expect(retry).toMatchObject({ status: "completed", duplicate: true });
    expect(await countType(f.locked, "program.completed")).toBe(1);
  });

  it("cancels at exact revision, clears the active Attempt, and does not duplicate terminal truth", async () => {
    const f = await setup();
    const adopted = applyProgramTransition(f.initial, {
      kind: "execution_base.adopt",
      expectedProgramRevision: f.initial.revision,
      executionBase: f.observations.current,
    });
    const withAttempt = applyProgramTransition(adopted, {
      kind: "attempt.issue",
      expectedProgramRevision: adopted.revision,
      attempt: {
        programAttemptId: asProgramAttemptId(uuidv7()),
        workItemId: f.workItemId,
        sessionId: asSessionId(String(f.sessionId)),
        agentGeneration: 1,
        initialExecutionBase: f.observations.current,
        expectedExecutionBase: f.observations.current,
      },
    });
    await appendState(f, adopted, "execution_base.adopt");
    await appendState(f, withAttempt, "attempt.issue");

    const cancelled = await f.service.cancel({
      programStateId: String(withAttempt.programStateId),
      expectedProgramRevision: withAttempt.revision,
      sessionId: f.sessionId,
      actor: "application",
      reason: "user cancelled",
    });
    expect(cancelled.state.lifecycle).toBe("cancelled");
    expect(cancelled.state.activeAttempt).toBeNull();
    expect(cancelled.duplicate).toBe(false);
    expect(await countType(f.locked, "program.cancelled")).toBe(1);

    const retry = await f.service.cancel({
      programStateId: String(withAttempt.programStateId),
      expectedProgramRevision: withAttempt.revision,
      sessionId: f.sessionId,
    });
    expect(retry.duplicate).toBe(true);
    expect(await countType(f.locked, "program.cancelled")).toBe(1);
  });

  it("records mismatch plus verification-impact state instead of completing stale Workspace truth", async () => {
    const f = await setup();
    const ready = await makeCompletable(f);
    f.observations.current = base(f.locked.store.workspaceId, "external-edit");
    const result = await f.service.complete({
      programStateId: String(ready.programStateId),
      expectedProgramRevision: ready.revision,
      sessionId: f.sessionId,
    });
    expect(result.status).toBe("rebase_required");
    if (result.status !== "rebase_required") throw new Error("expected rebase");
    expect(result.state.executionBaseMismatch).not.toBeNull();
    expect(result.state.lifecycle).toBe("active");
    expect(await countType(f.locked, "program.completed")).toBe(0);
  });

  it("blocks completion while a Program-linked operation remains outstanding", async () => {
    const f = await setup();
    const ready = await makeCompletable(f);
    const operationId = uuidv7();
    await f.admission.append([
      {
        eventId: mkEventId(),
        workspaceId: asWorkspaceId(f.locked.store.workspaceId),
        sessionId: f.sessionId,
        operationId: operationId as never,
        programStateId: asEventProgramStateId(String(ready.programStateId)),
        occurredAt: new Date().toISOString(),
        type: "operation.requested",
        payload: { operationId, toolName: "read", args: {}, isReadOnly: true, workspaceAccessClass: "read_only" },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "terminal-test" },
      },
      {
        eventId: mkEventId(),
        workspaceId: asWorkspaceId(f.locked.store.workspaceId),
        sessionId: f.sessionId,
        operationId: operationId as never,
        programStateId: asEventProgramStateId(String(ready.programStateId)),
        occurredAt: new Date().toISOString(),
        type: "operation.started",
        payload: { operationId },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "terminal-test" },
      },
    ]);
    const result = await f.service.complete({
      programStateId: String(ready.programStateId), expectedProgramRevision: ready.revision, sessionId: f.sessionId,
    });
    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected blocked");
    expect(result.blockedBy).toContain("outstanding_program_operation");
    expect(await countType(f.locked, "program.completed")).toBe(0);
  });

  it("rechecks canonical terminal state after observation so cancellation wins the race exactly once", async () => {
    const f = await setup();
    const ready = await makeCompletable(f);
    f.observations.beforeObserve = async () => {
      await f.service.cancel({
        programStateId: String(ready.programStateId), expectedProgramRevision: ready.revision, sessionId: f.sessionId,
      });
    };
    await expect(f.service.complete({
      programStateId: String(ready.programStateId), expectedProgramRevision: ready.revision, sessionId: f.sessionId,
    })).rejects.toBeInstanceOf(ProgramTerminalStaleError);
    expect((await latestState(f.locked, String(ready.programStateId))).lifecycle).toBe("cancelled");
    expect(await countType(f.locked, "program.cancelled")).toBe(1);
    expect(await countType(f.locked, "program.completed")).toBe(0);
  });

  it("fails terminal artifact integrity closed without invalidating canonical evidence identity", async () => {
    const f = await setup({ artifactVerification: true });
    const retained = await f.artifactStore.retain("artifact");
    let state = applyProgramTransition(f.initial, {
      kind: "execution_base.adopt", expectedProgramRevision: f.initial.revision, executionBase: f.observations.current,
    });
    state = applyProgramTransition(state, {
      kind: "artifact.add",
      expectedProgramRevision: state.revision,
      artifact: { artifactRef: retained.handle, outputSlotId: f.outputSlotId, productionStepId: f.productionStepId },
    });
    const evidenceRefId = asProgramEvidenceRefId(uuidv7());
    state = applyProgramTransition(state, {
      kind: "evidence.add",
      expectedProgramRevision: state.revision,
      evidence: {
        evidenceRefId,
        workItemId: f.workItemId,
        verificationObligationId: f.obligationId,
        sourceOperationId: null,
        artifactRef: retained.handle,
        subjectGeneration: 1,
      },
    });
    state = applyProgramTransition(state, {
      kind: "verification.satisfy",
      expectedProgramRevision: state.revision,
      obligationId: f.obligationId,
      satisfaction: { subjectGeneration: 1, evidenceRefIds: [evidenceRefId] },
    });
    state = applyProgramTransition(state, {
      kind: "work.lifecycle.set",
      expectedProgramRevision: state.revision,
      workItemId: f.workItemId,
      lifecycle: "completed",
    });

    let cursor = f.initial;
    for (const [next, kind] of [
      [applyProgramTransition(cursor, { kind: "execution_base.adopt", expectedProgramRevision: cursor.revision, executionBase: f.observations.current }), "execution_base.adopt"],
    ] as const) {
      await appendState(f, next, kind);
      cursor = next;
    }
    // Persist the already-built later revisions in order.
    const replayStates: ProgramState[] = [];
    let staged = cursor;
    staged = applyProgramTransition(staged, { kind: "artifact.add", expectedProgramRevision: staged.revision, artifact: { artifactRef: retained.handle, outputSlotId: f.outputSlotId, productionStepId: f.productionStepId } }); replayStates.push(staged);
    staged = applyProgramTransition(staged, { kind: "evidence.add", expectedProgramRevision: staged.revision, evidence: { evidenceRefId, workItemId: f.workItemId, verificationObligationId: f.obligationId, sourceOperationId: null, artifactRef: retained.handle, subjectGeneration: 1 } }); replayStates.push(staged);
    staged = applyProgramTransition(staged, { kind: "verification.satisfy", expectedProgramRevision: staged.revision, obligationId: f.obligationId, satisfaction: { subjectGeneration: 1, evidenceRefIds: [evidenceRefId] } }); replayStates.push(staged);
    staged = applyProgramTransition(staged, { kind: "work.lifecycle.set", expectedProgramRevision: staged.revision, workItemId: f.workItemId, lifecycle: "completed" }); replayStates.push(staged);
    for (const [index, next] of replayStates.entries()) await appendState(f, next, ["artifact.add", "evidence.add", "verification.satisfy", "work.lifecycle.set"][index]!);
    state = staged;

    const digest = retained.digest;
    rmSync(join(f.dir, "artifacts", digest.slice(0, 2), digest.slice(2, 4), digest), { force: true });
    const result = await f.service.complete({
      programStateId: String(state.programStateId), expectedProgramRevision: state.revision, sessionId: f.sessionId,
    });
    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected blocked");
    expect(result.blockedBy).toContain("artifact_integrity_unavailable");
    expect(await countType(f.locked, "program.completed")).toBe(0);
  });
});
