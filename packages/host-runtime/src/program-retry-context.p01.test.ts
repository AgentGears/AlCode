import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROGRAM_RETRY_FAILURE_REASON_MAX_BYTES,
} from "@alcode/agent-protocol";
import {
  asProgramStateId as asEventProgramStateId,
  asWorkspaceId,
  mkEventId,
  mkProgramStateId,
  uuidv7,
} from "@alcode/events";
import {
  applyProgramTransition,
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  createProgramState,
  type ProgramAttemptExecutionBase,
} from "@alcode/program-state";
import { openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { ProgramAgentServiceV1 } from "./program-agent.ts";
import { ProgramDispatchServiceV1 } from "./program-dispatch.ts";
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
      providerKind: "p01-retry-context-test",
      workspaceIdentity,
      coverageDigest: "coverage-v1",
      stateDigest: "state-v1",
    },
  };
}

describeLocked("P-01 retry context", () => {
  it("projects only the latest Host-owned verification failure and bounds its reason", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-p01-retry-context-")); dirs.push(dir);
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
    const generation = await agents.attach(session.sessionId, "retry-context-agent", true, true);
    const workItemId = asProgramWorkItemId("work-retry-context");
    const initial = createProgramState({
      programStateId: asProgramStateId(String(mkProgramStateId())),
      sourceSessionId: asSessionId(String(session.sessionId)),
      objective: "Retry with bounded Host facts",
      workItems: [{ workItemId, creationOrder: 0, description: "retry", dependencyIds: [], affectedPaths: ["state.txt"] }],
      verification: [], outputSlots: [], productionSteps: [],
    });
    await admission.append([{
      eventId: mkEventId(), workspaceId: asWorkspaceId(locked.store.workspaceId), sessionId: session.sessionId,
      programStateId: asEventProgramStateId(String(initial.programStateId)), occurredAt: new Date().toISOString(),
      type: "program.created", payload: { state: initial }, payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "p01-retry-context-test" },
    }]);
    const observedBase = base(locked.store.workspaceId);
    const dispatch = new ProgramDispatchServiceV1({
      store: locked.store, admission,
      workspaceCoordinator: { runExclusive: (work) => work() },
      observations: { observe: async () => ({ status: "complete" as const, base: observedBase }) },
      agentGenerations: agents,
      recovery: { isClear: () => true },
      firstDispatchPlanning: { recheckAcceptedPlanningBase: async () => undefined },
    });
    const first = await dispatch.issueAttempt({
      programStateId: String(initial.programStateId), expectedProgramRevision: initial.revision,
      workItemId: String(workItemId), sessionId: session.sessionId, agentGeneration: generation,
    });
    if (first.status !== "issued") throw new Error(`first Attempt not issued: ${first.status}`);
    const retired = applyProgramTransition(first.state, {
      kind: "attempt.interrupt",
      expectedProgramRevision: first.state.revision,
      programAttemptId: first.state.activeAttempt!.programAttemptId,
    });
    const failureEventId = mkEventId();
    await admission.append([
      {
        eventId: failureEventId, workspaceId: asWorkspaceId(locked.store.workspaceId), sessionId: session.sessionId,
        programStateId: asEventProgramStateId(String(initial.programStateId)), occurredAt: new Date().toISOString(),
        type: "program.verification.failed",
        payload: {
          programAttemptId: first.programAttemptId,
          workItemId: String(workItemId),
          verificationObligationId: "verify-retry-context",
          reason: "x".repeat(PROGRAM_RETRY_FAILURE_REASON_MAX_BYTES + 500),
        },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "p01-retry-context-test" },
      },
      {
        eventId: mkEventId(), workspaceId: asWorkspaceId(locked.store.workspaceId), sessionId: session.sessionId,
        programStateId: asEventProgramStateId(String(initial.programStateId)), occurredAt: new Date().toISOString(),
        type: "program.transitioned", payload: { state: retired, transitionKind: "attempt.interrupt:verification_failed" }, payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "p01-retry-context-test" },
      },
    ]);
    const second = await dispatch.issueAttempt({
      programStateId: String(initial.programStateId), expectedProgramRevision: retired.revision,
      workItemId: String(workItemId), sessionId: session.sessionId, agentGeneration: generation,
    });
    if (second.status !== "issued") throw new Error(`second Attempt not issued: ${second.status}`);
    const projection = await agents.currentAttemptProjection(session.sessionId, "retry-context-agent");
    expect(projection?.retryFailure).toMatchObject({
      eventId: String(failureEventId),
      programAttemptId: first.programAttemptId,
      workItemId: String(workItemId),
      verificationObligationId: "verify-retry-context",
    });
    expect(Buffer.byteLength(projection?.retryFailure?.reason ?? "", "utf8"))
      .toBeLessThanOrEqual(PROGRAM_RETRY_FAILURE_REASON_MAX_BYTES);
    expect(projection?.authority.programAttemptId).toBe(second.programAttemptId);
  });
});
