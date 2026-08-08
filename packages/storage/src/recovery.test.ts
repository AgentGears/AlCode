// Crash matrix + recovery tests — Step 10. POSIX-only (OS lock).
//
// Proves recovery from each implementable crash boundary, the canonical
// operation.interrupted recovery, indeterminate persistence across restarts,
// no auto-retry, and derived-projection rebuild equivalence.
//
// See docs/operation-recovery.md "Crash test matrix" and
// docs/adr/0003-tool-operation-uncertainty-and-recovery.md.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  mkEventId,
  mkSessionId,
  mkOperationId,
  asWorkspaceId,
  uuidv7,
  type EventDraft,
} from "@alcode/events";
import {
  openLockedWorkspaceStore,
  createOperationsProjection,
  createOperationQuery,
  createMemoryProjection,
  createMemoryQuery,
  type LockedWorkspaceStore,
  type OperationRecord,
} from "./index.ts";
import type { ProjectionDefinition, ProjectionTransaction, StatementDefinition } from "./projection.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

const TEST_WS = asWorkspaceId(uuidv7()) as string;
const TEST_REPO = uuidv7();

const describeLocked = process.platform === "win32" ? describe.skip : describe;

async function openStore(dbPath: string): Promise<LockedWorkspaceStore> {
  const lockPath = dbPath.replace(".sqlite", ".lock");
  return openLockedWorkspaceStore({ databasePath: dbPath, lockPath, workspaceId: TEST_WS, repositoryId: TEST_REPO });
}

function makeDraft(type: string, payload: Record<string, unknown>, overrides?: Partial<EventDraft<string, unknown>>): EventDraft<string, unknown> {
  return {
    eventId: mkEventId(),
    workspaceId: TEST_WS as never,
    sessionId: mkSessionId(),
    occurredAt: "2026-08-08T00:00:00.000Z",
    type,
    payload,
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "test" },
    ...overrides,
  };
}

function makeOpRequested(opId: string, sid: string): EventDraft<string, unknown> {
  return makeDraft("operation.requested", { operationId: opId, toolName: "bash", args: {}, isReadOnly: false }, {
    sessionId: sid as never,
    operationId: opId as never,
  });
}

function makeOpStarted(opId: string, sid: string): EventDraft<string, unknown> {
  return makeDraft("operation.started", { operationId: opId }, { sessionId: sid as never, operationId: opId as never });
}

function makeOpCompleted(opId: string, sid: string, outcome: string): EventDraft<string, unknown> {
  return makeDraft("operation.completed", { operationId: opId, outcome, isReadOnly: false }, { sessionId: sid as never, operationId: opId as never });
}

function readOps(dbPath: string): OperationRecord[] {
  const roDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return createOperationQuery(roDb).getByLifecycleState("terminal");
  } finally {
    roDb.close();
  }
}

function readAllOps(dbPath: string): OperationRecord[] {
  const roDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    // Read all operations regardless of lifecycle state
    const rows = roDb.prepare("SELECT * FROM operations ORDER BY started_at").all() as Record<string, unknown>[];
    return rows.map((row) => ({
      operationId: row.operation_id as string,
      workspaceId: row.workspace_id as string,
      sessionId: row.session_id as string,
      toolName: row.tool_name as string,
      args: row.args as string | null,
      lifecycleState: row.lifecycle_state as string,
      executionOutcome: (row.execution_outcome as string | null) ?? null,
      effectStatus: row.effect_status as string,
      reconciliationStatus: row.reconciliation_status as string,
      startedAt: (row.started_at as string | null) ?? null,
      completedAt: (row.completed_at as string | null) ?? null,
    })) as OperationRecord[];
  } finally {
    roDb.close();
  }
}

describeLocked("Step 10 — crash matrix", () => {
  let dir: string;
  let rt: LockedWorkspaceStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-crash-"));
  });
  afterEach(() => {
    try { rt?.close(); } catch { /* idempotent */ }
    rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Scenario 1: crash after event append, before projection completion
  // -------------------------------------------------------------------------

  it("scenario 1: events appended but projection lagging → reopen catchUp reaches head", async () => {
    const dbPath = join(dir, "ws.sqlite");
    rt = await openStore(dbPath);
    const sid = mkSessionId() as string;
    const opId = mkOperationId() as string;

    // Append operation events but do NOT catch up the projection.
    await rt.store.append([makeOpRequested(opId, sid), makeOpStarted(opId, sid), makeOpCompleted(opId, sid, "succeeded")]);
    const head = await rt.store.headSequence();

    // Cursor is at 0 (never caught up).
    const cursorBefore = rt.store.getProjectionRunner().getCursor("operations").lastAppliedEventSequence;
    expect(cursorBefore).toBe(0);
    rt.close();

    // Reopen and catch up.
    rt = await openStore(dbPath);
    const runner = rt.store.getProjectionRunner();
    const result = runner.catchUp(createOperationsProjection(rt.store.workspaceId));
    expect(result.caught).toBe(true);
    expect(runner.getCursor("operations").lastAppliedEventSequence).toBe(head);

    // The operation is terminal with succeeded.
    const ops = readOps(dbPath);
    expect(ops.length).toBe(1);
    expect(ops[0]!.executionOutcome).toBe("succeeded");
  });

  // -------------------------------------------------------------------------
  // Scenario 2: crash after tool start, before tool-result commit
  // -------------------------------------------------------------------------

  it("scenario 2: operation.started persisted, no completed → recovery marks indeterminate/pending", async () => {
    const dbPath = join(dir, "ws.sqlite");
    rt = await openStore(dbPath);
    const sid = mkSessionId() as string;
    const opId = mkOperationId() as string;

    // Append requested + started, catch up (simulating the tool started but crashed).
    await rt.store.append([makeOpRequested(opId, sid), makeOpStarted(opId, sid)]);
    rt.store.getProjectionRunner().catchUp(createOperationsProjection(rt.store.workspaceId));
    rt.close();

    // Reopen and run recovery.
    rt = await openStore(dbPath);
    const recovery = await rt.store.recoverInterruptedOperations();

    expect(recovery.newlyMarked).toBe(1);
    expect(recovery.pendingOperationIds).toContain(opId);

    // The operation is now indeterminate/pending.
    const ops = readAllOps(dbPath);
    expect(ops.length).toBe(1);
    expect(ops[0]!.effectStatus).toBe("indeterminate");
    expect(ops[0]!.reconciliationStatus).toBe("pending");
  });

  // -------------------------------------------------------------------------
  // Scenario 3: crash after external mutation, before completed
  // -------------------------------------------------------------------------

  it("scenario 3: external file mutation persists AND operation becomes pending", async () => {
    const dbPath = join(dir, "ws.sqlite");
    const externalFile = join(dir, "mutated.txt");
    rt = await openStore(dbPath);
    const sid = mkSessionId() as string;
    const opId = mkOperationId() as string;

    // Append requested + started (simulating tool started).
    await rt.store.append([makeOpRequested(opId, sid), makeOpStarted(opId, sid)]);
    rt.store.getProjectionRunner().catchUp(createOperationsProjection(rt.store.workspaceId));

    // Simulate the external mutation happening (the tool wrote a file).
    writeFileSync(externalFile, "effect occurred");

    // Crash before completed event.
    rt.close();

    // The external mutation persists (recovery does not roll back).
    expect(existsSync(externalFile)).toBe(true);
    expect(readFileSync(externalFile, "utf-8")).toBe("effect occurred");

    // Reopen and recover.
    rt = await openStore(dbPath);
    const recovery = await rt.store.recoverInterruptedOperations();
    expect(recovery.pendingOperationIds).toContain(opId);

    // Operation is indeterminate/pending — uncertainty preserved.
    const ops = readAllOps(dbPath);
    expect(ops[0]!.effectStatus).toBe("indeterminate");
    expect(ops[0]!.reconciliationStatus).toBe("pending");
  });

  // -------------------------------------------------------------------------
  // Scenario 4: crash before final commit of a turn
  // -------------------------------------------------------------------------

  it("scenario 4: operation completed, crash before final assistant event → no interruption for completed op", async () => {
    const dbPath = join(dir, "ws.sqlite");
    rt = await openStore(dbPath);
    const sid = mkSessionId() as string;
    const opId = mkOperationId() as string;

    // Operation fully completed (requested + started + completed).
    await rt.store.append([makeOpRequested(opId, sid), makeOpStarted(opId, sid), makeOpCompleted(opId, sid, "succeeded")]);
    rt.store.getProjectionRunner().catchUp(createOperationsProjection(rt.store.workspaceId));

    // Crash before the final assistant.message.appended event.
    rt.close();

    // Reopen and recover.
    rt = await openStore(dbPath);
    const recovery = await rt.store.recoverInterruptedOperations();

    // No interruption event for the completed operation.
    expect(recovery.newlyMarked).toBe(0);
    expect(recovery.pendingOperationIds).not.toContain(opId);

    // The operation remains terminal/succeeded — no fabricated missing event.
    const ops = readOps(dbPath);
    expect(ops.length).toBe(1);
    expect(ops[0]!.executionOutcome).toBe("succeeded");
    expect(ops[0]!.lifecycleState).toBe("terminal");
  });

  // -------------------------------------------------------------------------
  // Scenario 5: crash during a projection update (mid-transaction)
  // -------------------------------------------------------------------------

  it("scenario 5: throw inside projection apply → write + cursor roll back atomically", async () => {
    const dbPath = join(dir, "ws.sqlite");
    rt = await openStore(dbPath);
    const sid = mkSessionId() as string;

    // Append an event the crashing projection will try to handle.
    await rt.store.append([
      makeDraft("test.crash-probe", { value: 42 }, { sessionId: sid as never }),
    ]);
    const head = await rt.store.headSequence();

    // Test-only projection that throws mid-apply.
    const crashStmts: readonly StatementDefinition[] = [
      { name: "insert-probe", sql: "INSERT INTO operations (operation_id, workspace_id, session_id, tool_name, args, lifecycle_state, execution_outcome, effect_status, reconciliation_status, started_at, completed_at) VALUES ('crash-probe', ?, ?, 'test', '{}', 'requested', NULL, 'indeterminate', 'not_required', NULL, NULL)" },
    ];
    const crashProjection: ProjectionDefinition = {
      name: "crash-test",
      schemaVersion: 1,
      classification: "derived",
      statements: crashStmts,
      apply(_event, tx: ProjectionTransaction) {
        tx.exec("insert-probe", TEST_WS, sid as string);
        throw new Error("INJECTED_CRASH");
      },
    };

    const runner = rt.store.getProjectionRunner();

    // The crash inside apply should cause the projection transaction to roll back.
    expect(() => runner.catchUp(crashProjection)).toThrow("INJECTED_CRASH");

    // Cursor unchanged (the write rolled back with the cursor advance).
    const cursorAfter = runner.getCursor("crash-test").lastAppliedEventSequence;
    expect(cursorAfter).toBe(0);

    // Now catch up with a non-throwing projection — the event applies cleanly.
    const cleanStmts: readonly StatementDefinition[] = [
      { name: "insert-probe-clean", sql: "INSERT INTO operations (operation_id, workspace_id, session_id, tool_name, args, lifecycle_state, execution_outcome, effect_status, reconciliation_status, started_at, completed_at) VALUES ('clean-probe', ?, ?, 'test', '{}', 'requested', NULL, 'indeterminate', 'not_required', NULL, NULL)" },
    ];
    const cleanProjection: ProjectionDefinition = {
      name: "crash-test",
      schemaVersion: 1,
      classification: "derived",
      statements: cleanStmts,
      apply(event, tx: ProjectionTransaction) {
        if (event.type === "test.crash-probe") {
          tx.exec("insert-probe-clean", TEST_WS, sid as string);
        }
      },
    };

    const result = runner.catchUp(cleanProjection);
    expect(result.caught).toBe(true);
    expect(runner.getCursor("crash-test").lastAppliedEventSequence).toBe(head);
  });

  // -------------------------------------------------------------------------
  // Scenario 6: memory consolidation — explicitly deferred
  // -------------------------------------------------------------------------

  it.skip("scenario 6: crash during memory consolidation (DEFERRED — memory scoring not implemented in Phase 0.2)", () => {
    // Memory consolidation with scoring is explicitly excluded from Phase 0.2
    // (spec line 306-308). The minimal memory.created + memories projection
    // exists, but consolidation (which would be the crash-boundary operation)
    // does not. This scenario will be implemented when memory scoring lands.
  });

  // -------------------------------------------------------------------------
  // Recovery persistence: uncertainty surfaces on second startup
  // -------------------------------------------------------------------------

  it("recovery persistence: second startup surfaces same pending operation with newlyMarked=0", async () => {
    const dbPath = join(dir, "ws.sqlite");
    const sid = mkSessionId() as string;
    const opId = mkOperationId() as string;

    // Session 1: crash mid-operation.
    rt = await openStore(dbPath);
    await rt.store.append([makeOpRequested(opId, sid), makeOpStarted(opId, sid)]);
    rt.store.getProjectionRunner().catchUp(createOperationsProjection(rt.store.workspaceId));
    rt.close();

    // Session 2: recover.
    rt = await openStore(dbPath);
    const recovery1 = await rt.store.recoverInterruptedOperations();
    expect(recovery1.newlyMarked).toBe(1);
    expect(recovery1.pendingOperationIds).toContain(opId);
    rt.close();

    // Session 3: recover again — nothing newly marked, but still surfaced.
    rt = await openStore(dbPath);
    const recovery2 = await rt.store.recoverInterruptedOperations();
    expect(recovery2.newlyMarked).toBe(0);
    expect(recovery2.pendingOperationIds).toContain(opId);
  });

  // -------------------------------------------------------------------------
  // No auto-retry: indeterminate operations are never resolved by restart
  // -------------------------------------------------------------------------

  it("no auto-retry: indeterminate operation stays indeterminate/pending after recovery", async () => {
    const dbPath = join(dir, "ws.sqlite");
    const sid = mkSessionId() as string;
    const opId = mkOperationId() as string;

    rt = await openStore(dbPath);
    await rt.store.append([makeOpRequested(opId, sid), makeOpStarted(opId, sid)]);
    rt.store.getProjectionRunner().catchUp(createOperationsProjection(rt.store.workspaceId));
    rt.close();

    rt = await openStore(dbPath);
    await rt.store.recoverInterruptedOperations();

    // The operation is indeterminate/pending — NOT confirmed, NOT resolved.
    const ops = readAllOps(dbPath);
    expect(ops[0]!.effectStatus).toBe("indeterminate");
    expect(ops[0]!.reconciliationStatus).toBe("pending");
    expect(ops[0]!.lifecycleState).not.toBe("terminal");
  });

  // -------------------------------------------------------------------------
  // Canonical recovery: deleting and rebuilding operations from events
  // reproduces the interrupted state
  // -------------------------------------------------------------------------

  it("canonical recovery: rebuild operations projection from events reproduces interrupted state", async () => {
    const dbPath = join(dir, "ws.sqlite");
    const sid = mkSessionId() as string;
    const opId = mkOperationId() as string;

    // Crash mid-operation + recovery.
    rt = await openStore(dbPath);
    await rt.store.append([makeOpRequested(opId, sid), makeOpStarted(opId, sid)]);
    rt.store.getProjectionRunner().catchUp(createOperationsProjection(rt.store.workspaceId));
    rt.close();

    rt = await openStore(dbPath);
    await rt.store.recoverInterruptedOperations();
    const opsBefore = readAllOps(dbPath);
    expect(opsBefore[0]!.reconciliationStatus).toBe("pending");
    rt.close();

    // Delete the operations projection rows + reset cursor.
    const rawDb = new Database(dbPath);
    rawDb.exec("DELETE FROM operations");
    rawDb.prepare("DELETE FROM projection_cursors WHERE projection_name = 'operations'").run();
    rawDb.close();

    // Reopen and rebuild from scratch.
    rt = await openStore(dbPath);
    const result = rt.store.getProjectionRunner().catchUp(createOperationsProjection(rt.store.workspaceId));
    expect(result.caught).toBe(true);

    // The rebuilt projection reproduces the interrupted state (pending).
    const opsAfter = readAllOps(dbPath);
    expect(opsAfter.length).toBe(1);
    expect(opsAfter[0]!.effectStatus).toBe("indeterminate");
    expect(opsAfter[0]!.reconciliationStatus).toBe("pending");
  });

  // -------------------------------------------------------------------------
  // Derived-projection rebuild equivalence (memories)
  // -------------------------------------------------------------------------

  it("derived rebuild: delete memories projection + reset cursor → catchUp → equivalent", async () => {
    const dbPath = join(dir, "ws.sqlite");
    const sid = mkSessionId() as string;
    const memId = "test/mem-001.md";

    rt = await openStore(dbPath);
    await rt.store.append([
      makeDraft("memory.created", { memoryId: memId, type: "reference", body: "test memory body" }, { sessionId: sid as never }),
    ]);
    const memProj = createMemoryProjection(TEST_WS);
    rt.store.getProjectionRunner().catchUp(memProj);

    // Snapshot memory records.
    const roDb1 = new Database(dbPath, { readonly: true, fileMustExist: true });
    const before = createMemoryQuery(roDb1).getAll();
    roDb1.close();
    expect(before.length).toBe(1);
    rt.close();

    // Delete memories rows + reset cursor.
    const rawDb = new Database(dbPath);
    rawDb.exec("DELETE FROM memories");
    rawDb.prepare("DELETE FROM projection_cursors WHERE projection_name = 'memory'").run();
    rawDb.close();

    // Reopen and rebuild.
    rt = await openStore(dbPath);
    const result = rt.store.getProjectionRunner().catchUp(createMemoryProjection(TEST_WS));
    expect(result.caught).toBe(true);

    // Rebuilt projection is equivalent.
    const roDb2 = new Database(dbPath, { readonly: true, fileMustExist: true });
    const after = createMemoryQuery(roDb2).getAll();
    roDb2.close();
    expect(after).toEqual(before);
  });
});
