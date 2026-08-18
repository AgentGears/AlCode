import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asProgramStateId as asEventProgramStateId,
  asWorkspaceId,
  mkEventId,
  mkProgramStateId,
  type PersistedDomainEvent,
} from "@alcode/events";
import {
  applyProgramTransition,
  asProgramArtifactProductionStepId,
  asProgramAttemptId,
  asProgramOutputSlotId,
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  createProgramState,
  type ProgramAttemptExecutionBase,
  type ProgramState,
} from "@alcode/program-state";
import { openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { ProgramProgressServiceV1 } from "./program-progress.ts";
import { HostSessionManager } from "./session-manager.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function base(workspaceIdentity: string): ProgramAttemptExecutionBase {
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

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function replay(locked: LockedWorkspaceStore): Promise<PersistedDomainEvent<string, unknown>[]> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of locked.store.replay()) events.push(event);
  return events;
}

function latestState(events: readonly PersistedDomainEvent<string, unknown>[], id: string): ProgramState {
  let state: ProgramState | undefined;
  for (const event of events) {
    if (String(event.programStateId ?? "") !== id) continue;
    if (event.type !== "program.created" && event.type !== "program.transitioned"
        && event.type !== "program.completed" && event.type !== "program.cancelled") continue;
    const candidate = record(event.payload).state as ProgramState | undefined;
    if (candidate !== undefined) state = candidate;
  }
  if (state === undefined) throw new Error("missing Program state");
  return state;
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "alcode-program-progress-"));
  dirs.push(dir);
  const locked = await openLockedWorkspaceStore({
    databasePath: join(dir, "workspace.sqlite"),
    lockPath: join(dir, "workspace.lock"),
    workspaceId: "018f0000-0000-7000-8000-000000000620",
    repositoryId: "program-progress-test",
  });
  const admission = new CanonicalAdmissionQueue(locked.store);
  const sessions = new HostSessionManager(locked, admission);
  const session = await sessions.openOrResume();
  const workItemId = asProgramWorkItemId("work-1");
  const productionStepId = asProgramArtifactProductionStepId("production-1");
  const outputSlotId = asProgramOutputSlotId("output-1");
  const created = createProgramState({
    programStateId: asProgramStateId(String(mkProgramStateId())),
    sourceSessionId: asSessionId(String(session.sessionId)),
    objective: "Implement progress bridge",
    workItems: [{
      workItemId,
      creationOrder: 0,
      description: "Implement current work",
      dependencyIds: [],
      affectedPaths: ["src/current.ts"],
    }],
    verification: [],
    outputSlots: [{ outputSlotId, productionStepId }],
    productionSteps: [{
      productionStepId,
      producerWorkItemId: workItemId,
      outputChannel: "result",
      specId: "test.production",
      specVersion: 1,
      canonicalArgs: {},
      canonicalArgsDigest: "digest-v1",
    }],
  });
  const issued = applyProgramTransition(created, {
    kind: "attempt.issue",
    expectedProgramRevision: created.revision,
    attempt: {
      programAttemptId: asProgramAttemptId("attempt-1"),
      workItemId,
      sessionId: asSessionId(String(session.sessionId)),
      agentGeneration: 7,
      initialExecutionBase: base(locked.store.workspaceId),
      expectedExecutionBase: base(locked.store.workspaceId),
    },
  });
  const state = applyProgramTransition(issued, {
    kind: "artifact.add",
    expectedProgramRevision: issued.revision,
    artifact: { artifactRef: "artifact:current", outputSlotId, productionStepId },
  });
  const timestamp = new Date().toISOString();
  await locked.store.append([
    {
      eventId: mkEventId(),
      workspaceId: asWorkspaceId(locked.store.workspaceId),
      sessionId: session.sessionId,
      programStateId: asEventProgramStateId(String(created.programStateId)),
      occurredAt: timestamp,
      type: "program.created",
      payload: { state: created },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "program-progress-test" },
    },
    {
      eventId: mkEventId(),
      workspaceId: asWorkspaceId(locked.store.workspaceId),
      sessionId: session.sessionId,
      programStateId: asEventProgramStateId(String(issued.programStateId)),
      occurredAt: timestamp,
      type: "program.transitioned",
      payload: { state: issued, transitionKind: "attempt.issue" },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "program-progress-test" },
    },
    {
      eventId: mkEventId(),
      workspaceId: asWorkspaceId(locked.store.workspaceId),
      sessionId: session.sessionId,
      programStateId: asEventProgramStateId(String(state.programStateId)),
      occurredAt: timestamp,
      type: "program.transitioned",
      payload: { state, transitionKind: "artifact.add" },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "program-progress-test" },
    },
  ]);
  const service = new ProgramProgressServiceV1({
    store: locked.store,
    admission,
    agents: {
      isCurrent: (sessionId, connectionGenerationId, agentGeneration) =>
        sessionId === String(session.sessionId)
        && connectionGenerationId === "connection-1"
        && agentGeneration === 7,
    },
  });
  const authority = {
    programStateId: String(state.programStateId),
    expectedProgramRevision: state.revision,
    programAttemptId: "attempt-1",
    workItemId: "work-1",
    agentGeneration: 7,
  };
  return { locked, session, service, state, authority };
}

function progress(
  runtime: Awaited<ReturnType<typeof setup>>,
  requestId: string,
  intent: any,
  authority = runtime.authority,
) {
  return runtime.service.handleAgentMessage({
    connectionGenerationId: "connection-1",
    agentGeneration: 7,
    sessionId: runtime.session.sessionId,
    programExecutionCapable: true,
    message: {
      type: "program.progress",
      version: 1,
      requestId,
      sessionId: String(runtime.session.sessionId),
      authority,
      intent,
    },
  });
}

describeLocked("Program progress proposal bridge", () => {
  it("admits only exact-current work-bound evidence and invalidates the old revision tuple", async () => {
    const runtime = await setup();
    const accepted = await progress(runtime, "evidence-1", { kind: "evidence.add", artifactRef: "artifact:current" });
    expect(accepted).toMatchObject({ outcome: "accepted", evidenceRefId: expect.any(String) });
    const state = latestState(await replay(runtime.locked), runtime.authority.programStateId);
    expect(state.decisiveEvidence).toHaveLength(1);
    expect(state.decisiveEvidence[0]).toMatchObject({
      workItemId: "work-1",
      verificationObligationId: null,
      sourceOperationId: null,
      artifactRef: "artifact:current",
      subjectGeneration: null,
    });
    expect(state.revision).toBe(runtime.state.revision + 1);

    const duplicate = await progress(runtime, "evidence-1", { kind: "evidence.add", artifactRef: "artifact:current" });
    expect(duplicate).toEqual(accepted);
    expect(latestState(await replay(runtime.locked), runtime.authority.programStateId).decisiveEvidence).toHaveLength(1);

    const stale = await progress(runtime, "evidence-2", { kind: "evidence.add", artifactRef: "artifact:current" });
    expect(stale).toMatchObject({ outcome: "stale", errorCode: "program_execution_stale" });
    runtime.locked.close();
  });

  it("keeps Agent blocker reports advisory rather than mutating canonical ProgramBlocker state", async () => {
    const runtime = await setup();
    const report = await progress(runtime, "blocker-1", {
      kind: "blocker.report",
      scope: "work",
      reason: "Need API answer",
    });
    expect(report).toMatchObject({
      outcome: "accepted",
      advisoryBlockerId: expect.any(String),
      programRevision: runtime.state.revision,
    });
    expect(latestState(await replay(runtime.locked), runtime.authority.programStateId).blockers).toEqual([]);

    const resolved = await progress(runtime, "blocker-2", {
      kind: "blocker.resolve",
      advisoryBlockerId: report?.advisoryBlockerId,
    });
    expect(resolved).toMatchObject({ outcome: "accepted", advisoryBlockerId: report?.advisoryBlockerId });
    expect(latestState(await replay(runtime.locked), runtime.authority.programStateId).blockers).toEqual([]);
    runtime.locked.close();
  });

  it("allows only the current work item to request awaiting_verification", async () => {
    const runtime = await setup();
    const accepted = await progress(runtime, "await-1", { kind: "work.awaiting_verification" });
    expect(accepted).toMatchObject({ outcome: "accepted", programRevision: runtime.state.revision + 1 });
    const state = latestState(await replay(runtime.locked), runtime.authority.programStateId);
    expect(state.workItems[0]?.lifecycle).toBe("awaiting_verification");
    expect(state.activeAttempt?.programAttemptId).toBe("attempt-1");
    runtime.locked.close();
  });

  it("rejects progress without program_execution_v1 before canonical mutation", async () => {
    const runtime = await setup();
    const before = await replay(runtime.locked);
    const result = await runtime.service.handleAgentMessage({
      connectionGenerationId: "connection-1",
      agentGeneration: 7,
      sessionId: runtime.session.sessionId,
      programExecutionCapable: false,
      message: {
        type: "program.progress",
        version: 1,
        requestId: "state-only-1",
        sessionId: String(runtime.session.sessionId),
        authority: runtime.authority,
        intent: { kind: "work.awaiting_verification" },
      },
    });
    expect(result).toMatchObject({ outcome: "denied", errorCode: "program_execution_capability_required" });
    expect(await replay(runtime.locked)).toHaveLength(before.length);
    runtime.locked.close();
  });

  it("rejects stale Attempt, work, revision, Session, and Agent-generation tuples", async () => {
    const variants = [
      { programAttemptId: "attempt-old" },
      { workItemId: "work-old" },
      { expectedProgramRevision: 999 },
      { agentGeneration: 8 },
    ];
    for (const [index, patch] of variants.entries()) {
      const runtime = await setup();
      const result = await progress(
        runtime,
        `stale-${index}`,
        { kind: "work.awaiting_verification" },
        { ...runtime.authority, ...patch },
      );
      expect(result).toMatchObject({ outcome: "stale", errorCode: "program_execution_stale" });
      expect(latestState(await replay(runtime.locked), runtime.authority.programStateId).workItems[0]?.lifecycle).toBe("in_progress");
      runtime.locked.close();
    }

    const runtime = await setup();
    const result = await runtime.service.handleAgentMessage({
      connectionGenerationId: "connection-1",
      agentGeneration: 7,
      sessionId: runtime.session.sessionId,
      programExecutionCapable: true,
      message: {
        type: "program.progress",
        version: 1,
        requestId: "wrong-session",
        sessionId: "wrong-session",
        authority: runtime.authority,
        intent: { kind: "work.awaiting_verification" },
      },
    });
    expect(result).toMatchObject({ outcome: "stale", errorCode: "program_execution_stale" });
    runtime.locked.close();
  });

  it("rejects non-canonical artifact evidence without changing Program truth", async () => {
    const runtime = await setup();
    const result = await progress(runtime, "bad-artifact", {
      kind: "evidence.add",
      artifactRef: "artifact:not-current",
    });
    expect(result).toMatchObject({ outcome: "denied", errorCode: "program_progress_invalid" });
    expect(latestState(await replay(runtime.locked), runtime.authority.programStateId).decisiveEvidence).toEqual([]);
    runtime.locked.close();
  });
});
