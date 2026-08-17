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
  PROGRAM_ATTEMPT_PROJECTION_MAX_BYTES,
  ProgramAgentServiceV1,
} from "./program-agent.ts";
import { ProgramDispatchServiceV1 } from "./program-dispatch.ts";
import { HostSessionManager } from "./session-manager.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;
const stores: LockedWorkspaceStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* closed */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function base(workspaceIdentity: string): ProgramAttemptExecutionBase {
  return {
    workspaceEffectGeneration: 0,
    observation: {
      kind: "workspace-observation-v1",
      providerKind: "program-agent-test",
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
    if (event.type === "program.created" || event.type === "program.transitioned" ||
        event.type === "program.completed" || event.type === "program.cancelled") {
      latest = (event.payload as { state: ProgramState }).state;
    }
  }
  if (latest === undefined) throw new Error("missing ProgramState");
  return latest;
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "alcode-program-agent-"));
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
  const workItemId = asProgramWorkItemId("work-agent");
  const initial = createProgramState({
    programStateId: asProgramStateId(String(mkProgramStateId())),
    sourceSessionId: asSessionId(String(session.sessionId)),
    objective: "Continue durable work",
    workItems: [{
      workItemId,
      creationOrder: 0,
      description: "Implement the current slice",
      dependencyIds: [],
      affectedPaths: ["src/a.ts"],
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
    producer: { kind: "runtime", component: "program-agent-test" },
  }]);

  const agents = new ProgramAgentServiceV1(locked.store, admission);
  const currentBase = base(locked.store.workspaceId);
  const dispatch = new ProgramDispatchServiceV1({
    store: locked.store,
    admission,
    workspaceCoordinator: { runExclusive: (work) => work() },
    observations: { observe: async () => ({ status: "complete" as const, base: currentBase }) },
    agentGenerations: agents,
    recovery: { isClear: () => true },
    firstDispatchPlanning: { recheckAcceptedPlanningBase: async () => undefined },
  });
  return { locked, session, initial, workItemId, agents, dispatch };
}

describeLocked("Program Agent authority", () => {
  it("projects only the current Agent generation and interrupts an Attempt on replacement", async () => {
    const fixture = await setup();
    const generation1 = await fixture.agents.attach(
      fixture.session.sessionId,
      "connection-1",
      true,
    );
    const issued = await fixture.dispatch.issueAttempt({
      programStateId: String(fixture.initial.programStateId),
      expectedProgramRevision: fixture.initial.revision,
      workItemId: String(fixture.workItemId),
      sessionId: fixture.session.sessionId,
      agentGeneration: generation1,
    });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") throw new Error("Attempt not issued");

    const projection = await fixture.agents.currentAttemptProjection(
      fixture.session.sessionId,
      "connection-1",
    );
    expect(projection?.authority).toMatchObject({
      programStateId: String(fixture.initial.programStateId),
      programAttemptId: issued.programAttemptId,
      agentGeneration: generation1,
    });
    expect(Buffer.byteLength(JSON.stringify(projection), "utf8"))
      .toBeLessThanOrEqual(PROGRAM_ATTEMPT_PROJECTION_MAX_BYTES);

    const generation2 = await fixture.agents.attach(
      fixture.session.sessionId,
      "connection-2",
      true,
    );
    expect(generation2).toBeGreaterThan(generation1);
    expect(fixture.agents.isCurrent(String(fixture.session.sessionId), generation1)).toBe(false);
    expect(fixture.agents.isCurrent(String(fixture.session.sessionId), generation2)).toBe(true);
    expect((await latestState(fixture.locked, String(fixture.initial.programStateId))).activeAttempt).toBeNull();
    expect(await fixture.agents.currentAttemptProjection(
      fixture.session.sessionId,
      "connection-2",
    )).toBeUndefined();
  });

  it("does not expose Program projection to a legacy Agent", async () => {
    const fixture = await setup();
    const generation = await fixture.agents.attach(
      fixture.session.sessionId,
      "legacy-connection",
      false,
    );
    const issued = await fixture.dispatch.issueAttempt({
      programStateId: String(fixture.initial.programStateId),
      expectedProgramRevision: fixture.initial.revision,
      workItemId: String(fixture.workItemId),
      sessionId: fixture.session.sessionId,
      agentGeneration: generation,
    });
    expect(issued.status).toBe("issued");
    expect(await fixture.agents.currentAttemptProjection(
      fixture.session.sessionId,
      "legacy-connection",
    )).toBeUndefined();
  });

  it("never reuses a historical Agent generation after service reconstruction", async () => {
    const fixture = await setup();
    const generation1 = await fixture.agents.attach(
      fixture.session.sessionId,
      "connection-1",
      true,
    );
    const issued = await fixture.dispatch.issueAttempt({
      programStateId: String(fixture.initial.programStateId),
      expectedProgramRevision: fixture.initial.revision,
      workItemId: String(fixture.workItemId),
      sessionId: fixture.session.sessionId,
      agentGeneration: generation1,
    });
    expect(issued.status).toBe("issued");

    const reconstructed = new ProgramAgentServiceV1(fixture.locked.store, new CanonicalAdmissionQueue(fixture.locked.store));
    const generation2 = await reconstructed.attach(
      fixture.session.sessionId,
      "connection-after-restart",
      true,
    );
    expect(generation2).toBeGreaterThan(generation1);
    expect((await latestState(fixture.locked, String(fixture.initial.programStateId))).activeAttempt).toBeNull();
  });
});
