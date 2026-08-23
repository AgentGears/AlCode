import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
      providerKind: "p01-awaiting-replacement-test",
      workspaceIdentity,
      coverageDigest: "coverage-v1",
      stateDigest: "state-v1",
    },
  };
}

describeLocked("P-01 awaiting-verification Agent replacement", () => {
  it("atomically retires A, returns awaiting work pending, and permits a fresh B Attempt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-p01-awaiting-replacement-"));
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
    const workItemId = asProgramWorkItemId("work-awaiting-replacement");
    const initial = createProgramState({
      programStateId: asProgramStateId(String(mkProgramStateId())),
      sourceSessionId: asSessionId(String(session.sessionId)),
      objective: "Resume awaiting verification after Agent replacement",
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
      producer: { kind: "runtime", component: "p01-awaiting-replacement-test" },
    }]);

    const observedBase = base(locked.store.workspaceId);
    const recovery = new Phase1RecoveryControllerV1({
      store: locked.store,
      admission,
      workspaceCoordinator: { runExclusive: (work) => work() },
      observations: { observe: async () => ({ status: "complete" as const, base: observedBase }) },
      capabilities: [],
    });
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
    expect(issuedA.status).toBe("issued");
    if (issuedA.status !== "issued") throw new Error(`Attempt A not issued: ${issuedA.status}`);

    const awaiting = applyProgramTransition(issuedA.state, {
      kind: "work.lifecycle.set",
      expectedProgramRevision: issuedA.state.revision,
      workItemId,
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
      producer: { kind: "runtime", component: "p01-awaiting-replacement-test" },
    }]);

    const generationB = await agents.attach(session.sessionId, "connection-b", true, true);
    expect(generationB).toBeGreaterThan(generationA);
    expect(await agents.currentAttemptAuthority(session.sessionId)).toBeUndefined();

    const scheduler = new ProgramExecutionSchedulerV1({ store: locked.store, dispatch, agents });
    const scheduled = await scheduler.dispatchNext({
      programStateId: String(initial.programStateId),
      sessionId: session.sessionId,
    });
    expect(scheduled.status).toBe("issued");
    if (scheduled.status !== "issued") throw new Error(`replacement Attempt not issued: ${scheduled.status}`);
    expect(scheduled.programAttemptId).not.toBe(issuedA.programAttemptId);
    expect(scheduled.state.workItems.find((work) => work.workItemId === workItemId)?.lifecycle).toBe("in_progress");
    expect(scheduled.state.activeAttempt?.agentGeneration).toBe(generationB);
  });
});
