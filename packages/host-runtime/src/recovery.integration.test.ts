import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  asSessionId,
  asWorkspaceId,
  mkEventId,
  mkOperationId,
  uuidv7,
} from "@alcode/events";
import {
  createOperationsProjection,
  createWorkspaceReadModels,
  openLockedWorkspaceStore,
  type LockedWorkspaceStore,
} from "@alcode/storage";
import {
  DefaultHostPolicy,
  HostRuntime,
  type HostCapability,
} from "./index.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

interface WorkspaceFixture {
  workspaceId: ReturnType<typeof asWorkspaceId>;
  repositoryId: string;
}

async function openStore(dir: string, fixture: WorkspaceFixture): Promise<LockedWorkspaceStore> {
  return openLockedWorkspaceStore({
    databasePath: join(dir, "workspace.sqlite"),
    lockPath: join(dir, "workspace.lock"),
    workspaceId: fixture.workspaceId,
    repositoryId: fixture.repositoryId,
  });
}

const lessonFields = {
  lesson_name: "recovery_boundary",
  outcome: "success",
  stage_anchor: "terminal",
  retrieval_anchor: "recovery boundary",
  not_applicable_when: "not a recovery case",
  domain: "integration-test",
  verification_boundary: "reopen and replay",
  content: "Durable work retries must not duplicate semantic effects.",
};

describeLocked("Phase 0.5 recovery", () => {
  let dir: string;
  let locked: LockedWorkspaceStore | null;
  let fixture: WorkspaceFixture;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-recovery-05-"));
    locked = null;
    fixture = { workspaceId: asWorkspaceId(uuidv7()), repositoryId: uuidv7() };
  });

  afterEach(() => {
    try { locked?.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("reopens an interrupted possibly-mutating operation as indeterminate/pending without retry", async () => {
    locked = await openStore(dir, fixture);
    let executed = 0;
    const capability: HostCapability = {
      name: "mutate",
      isReadOnly: false,
      async execute() {
        executed++;
        return { result: "mutated", outcome: "succeeded" };
      },
    };
    let host = new HostRuntime({
      store: locked,
      capabilities: [capability],
      policy: new DefaultHostPolicy({ knownTools: ["mutate"], allowMutations: true }),
    });
    await host.startup();
    const session = await host.openOrResumeSession(asSessionId(uuidv7()));
    const operationId = mkOperationId();

    // Simulate Host death after the durable execution-start barrier but before
    // any terminal fact is committed. No capability invocation is performed by
    // this fixture; recovery must not infer that retry is safe.
    await locked.store.append([
      {
        eventId: mkEventId(),
        workspaceId: fixture.workspaceId,
        sessionId: session.sessionId,
        operationId,
        occurredAt: new Date().toISOString(),
        type: "operation.requested",
        payload: {
          operationId: operationId as string,
          toolName: "mutate",
          args: { path: "state.txt" },
          isReadOnly: false,
        },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "recovery-fixture" },
      },
      {
        eventId: mkEventId(),
        workspaceId: fixture.workspaceId,
        sessionId: session.sessionId,
        operationId,
        occurredAt: new Date().toISOString(),
        type: "operation.started",
        payload: { operationId: operationId as string },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "recovery-fixture" },
      },
    ]);
    locked.store.getProjectionRunner().catchUp(createOperationsProjection(locked.store.workspaceId));
    locked.close();
    locked = null;

    locked = await openStore(dir, fixture);
    host = new HostRuntime({
      store: locked,
      capabilities: [capability],
      policy: new DefaultHostPolicy({ knownTools: ["mutate"], allowMutations: true }),
    });
    const recovery = await host.startup();

    expect(recovery.pendingOperationIds).toContain(operationId as string);
    expect(executed).toBe(0);
    const operations = await createWorkspaceReadModels(locked.store).getOperations(session.sessionId as string);
    expect(operations).toHaveLength(1);
    expect(operations[0]?.operationId).toBe(operationId as string);
    expect(operations[0]?.lifecycleState).toBe("started");
    expect(operations[0]?.effectStatus).toBe("indeterminate");
    expect(operations[0]?.reconciliationStatus).toBe("pending");

    const resumed = await host.openOrResumeSession(session.sessionId);
    expect(resumed.resumed).toBe(true);
    const orientation = await host.cognitionGateway.orient(session.sessionId as string);
    expect(orientation.pendingOperations.some((op) => op.operationId === operationId as string)).toBe(true);
  });

  it("retries interrupted consolidation after semantic commit without duplicating memory reinforcement", async () => {
    locked = await openStore(dir, fixture);
    let host = new HostRuntime({ store: locked, capabilities: [] });
    await host.startup();
    const session = await host.openOrResumeSession(asSessionId(uuidv7()));
    await host.admitInput(session.sessionId, "Remember recovery behavior");
    const remembered = await host.cognition.invoke(session.sessionId, "remember", {
      type: "lesson",
      name: "recovery_boundary",
      confidence: 0.75,
      fields: lessonFields,
    }) as { memoryId: string };

    const work = await host.workDispatcher.requestMemoryConsolidation(session.sessionId, {
      memoryId: remembered.memoryId,
      count: 5,
      consolidationCount: 1,
      strength: 0.9,
    });

    await expect(host.workDispatcher.runPending({
      afterSemanticCommit() {
        throw new Error("simulated host crash after semantic commit");
      },
    })).rejects.toThrow("simulated host crash");

    const before = [] as Array<{ eventId: string; type: string; payload: unknown }>;
    for await (const event of locked.store.replay()) {
      before.push({ eventId: event.eventId, type: event.type, payload: event.payload });
    }
    const semanticBefore = before.filter(
      (event) => event.type === "memory.reinforced" && (event.payload as Record<string, unknown>).kind === "consolidated",
    );
    expect(semanticBefore).toHaveLength(1);
    expect(semanticBefore[0]?.eventId).toBe(work.memoryEventId);
    expect(before.some((event) => event.type === "runtime.work.completed")).toBe(false);

    locked.close();
    locked = null;

    locked = await openStore(dir, fixture);
    host = new HostRuntime({ store: locked, capabilities: [] });
    const startup = await host.startup();
    expect(startup.interruptedWork).toBe(1);
    expect(await host.workDispatcher.runPending()).toBe(1);

    const after = [] as Array<{ eventId: string; type: string; payload: unknown }>;
    for await (const event of locked.store.replay()) {
      after.push({ eventId: event.eventId, type: event.type, payload: event.payload });
    }
    const semanticAfter = after.filter(
      (event) => event.type === "memory.reinforced" && (event.payload as Record<string, unknown>).kind === "consolidated",
    );
    expect(semanticAfter).toHaveLength(1);
    expect(semanticAfter[0]?.eventId).toBe(work.memoryEventId);
    expect(after.filter((event) => event.type === "runtime.work.completed")).toHaveLength(1);
  });
});
