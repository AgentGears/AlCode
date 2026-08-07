import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  mkEventId, mkWorkspaceId, mkSessionId, mkOperationId,
  asWorkspaceId, uuidv7, type EventDraft,
} from "@alcode/events";
import {
  openLockedWorkspaceStore,
  createOperationsProjection,
  createOperationQuery,
  defaultEffectStatus,
  defaultReconciliationStatus,
  OperationStateError,
  type ExecutionOutcome,
  type EffectStatus,
} from "./index.ts";
import type { Database } from "better-sqlite3";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

const describeLocked = process.platform === "win32" ? describe.skip : describe;

const TEST_WS = asWorkspaceId(uuidv7()) as string;
const TEST_REPO = uuidv7();

function makeOperationDraft(
  operationId: string,
  type: string,
  payload: Record<string, unknown>,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    eventId: mkEventId(),
    workspaceId: TEST_WS,
    sessionId: mkSessionId(),
    operationId,
    occurredAt: new Date().toISOString(),
    type,
    payload,
    payloadSchemaVersion: 1,
    producer: { kind: "tool", toolName: "bash" },
    ...overrides,
  };
}

describeLocked("operations model — projection + state machine", () => {
  let dir: string;
  let rt: Awaited<ReturnType<typeof openLockedWorkspaceStore>>;
  let db: Database;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "alcode-ops-"));
    const dbPath = join(dir, "ws.sqlite");
    const lockPath = join(dir, "ws.lock");
    rt = await openLockedWorkspaceStore({
      databasePath: dbPath, lockPath,
      workspaceId: TEST_WS, repositoryId: TEST_REPO,
    });
    db = Database(dbPath);
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    rt.close();
  });

  async function appendAndCatchUp(drafts: Record<string, unknown>[]) {
    await rt.store.append(drafts as EventDraft<string, unknown>[]);
    const proj = createOperationsProjection(TEST_WS);
    const runner = rt.store.getProjectionRunner();
    runner.catchUp(proj);
  }

  // 1. requested → started → terminal lifecycle
  it("1: operation goes through requested → started → terminal", async () => {
    const opId = mkOperationId() as string;
    await appendAndCatchUp([
      makeOperationDraft(opId, "operation.requested", { operationId: opId, toolName: "bash", args: { cmd: "echo hi" }, isReadOnly: false }),
      makeOperationDraft(opId, "operation.started", { operationId: opId }),
      makeOperationDraft(opId, "operation.completed", { operationId: opId, outcome: "succeeded", isReadOnly: false }),
    ]);

    const query = createOperationQuery(db);
    const op = query.getById(opId)!;
    expect(op.lifecycleState).toBe("terminal");
    expect(op.executionOutcome).toBe("succeeded");
    expect(op.startedAt).not.toBeNull();
    expect(op.completedAt).not.toBeNull();
  });

  // 2. Default mappings: success → confirmed, not_required
  it("2: succeeded → effect=confirmed, reconciliation=not_required", async () => {
    const opId = mkOperationId() as string;
    await appendAndCatchUp([
      makeOperationDraft(opId, "operation.requested", { operationId: opId, toolName: "bash", args: {}, isReadOnly: false }),
      makeOperationDraft(opId, "operation.completed", { operationId: opId, outcome: "succeeded", isReadOnly: false }),
    ]);

    const query = createOperationQuery(db);
    const op = query.getById(opId)!;
    expect(op.effectStatus).toBe("confirmed");
    expect(op.reconciliationStatus).toBe("not_required");
  });

  // 3. Default mappings: failure → indeterminate, pending
  it("3: failed → effect=indeterminate, reconciliation=pending", async () => {
    const opId = mkOperationId() as string;
    await appendAndCatchUp([
      makeOperationDraft(opId, "operation.requested", { operationId: opId, toolName: "bash", args: {}, isReadOnly: false }),
      makeOperationDraft(opId, "operation.completed", { operationId: opId, outcome: "failed", isReadOnly: false }),
    ]);

    const query = createOperationQuery(db);
    const op = query.getById(opId)!;
    expect(op.effectStatus).toBe("indeterminate");
    expect(op.reconciliationStatus).toBe("pending");
  });

  // 4. cancelled → indeterminate
  it("4: cancelled → effect=indeterminate", async () => {
    const opId = mkOperationId() as string;
    await appendAndCatchUp([
      makeOperationDraft(opId, "operation.requested", { operationId: opId, toolName: "bash", args: {}, isReadOnly: false }),
      makeOperationDraft(opId, "operation.completed", { operationId: opId, outcome: "cancelled", isReadOnly: false }),
    ]);

    const op = createOperationQuery(db).getById(opId)!;
    expect(op.effectStatus).toBe("indeterminate");
    expect(op.reconciliationStatus).toBe("pending");
  });

  // 5. timed_out → indeterminate
  it("5: timed_out → effect=indeterminate", async () => {
    const opId = mkOperationId() as string;
    await appendAndCatchUp([
      makeOperationDraft(opId, "operation.requested", { operationId: opId, toolName: "bash", args: {}, isReadOnly: false }),
      makeOperationDraft(opId, "operation.completed", { operationId: opId, outcome: "timed_out", isReadOnly: false }),
    ]);

    const op = createOperationQuery(db).getById(opId)!;
    expect(op.effectStatus).toBe("indeterminate");
  });

  // 6. read-only tool → not_applicable
  it("6: read-only tool → effect=not_applicable", async () => {
    const opId = mkOperationId() as string;
    await appendAndCatchUp([
      makeOperationDraft(opId, "operation.requested", { operationId: opId, toolName: "read", args: {}, isReadOnly: true }),
      makeOperationDraft(opId, "operation.completed", { operationId: opId, outcome: "succeeded", isReadOnly: true }),
    ]);

    const op = createOperationQuery(db).getById(opId)!;
    expect(op.effectStatus).toBe("not_applicable");
    expect(op.reconciliationStatus).toBe("not_required");
  });

  // 7. tool-declared effect overrides default
  it("7: tool-declared effect overrides default", async () => {
    const opId = mkOperationId() as string;
    await appendAndCatchUp([
      makeOperationDraft(opId, "operation.requested", { operationId: opId, toolName: "bash", args: {}, isReadOnly: false }),
      makeOperationDraft(opId, "operation.completed", {
        operationId: opId, outcome: "failed", isReadOnly: false,
        toolDeclaredEffect: "absent" as EffectStatus,
      }),
    ]);

    const op = createOperationQuery(db).getById(opId)!;
    expect(op.effectStatus).toBe("absent");
    expect(op.reconciliationStatus).toBe("not_required");
  });

  // 8. Indeterminate is persisted as a real durable state
  it("8: indeterminate persists across reopen", async () => {
    const opId = mkOperationId() as string;
    await appendAndCatchUp([
      makeOperationDraft(opId, "operation.requested", { operationId: opId, toolName: "bash", args: {}, isReadOnly: false }),
      makeOperationDraft(opId, "operation.completed", { operationId: opId, outcome: "timed_out", isReadOnly: false }),
    ]);
    db.close();
    rt.close();

    // Reopen
    rt = await openLockedWorkspaceStore({
      databasePath: join(dir, "ws.sqlite"), lockPath: join(dir, "ws.lock"),
      workspaceId: TEST_WS, repositoryId: TEST_REPO,
    });
    db = Database(join(dir, "ws.sqlite"));

    const op = createOperationQuery(db).getById(opId)!;
    expect(op.lifecycleState).toBe("terminal");
    expect(op.executionOutcome).toBe("timed_out");
    expect(op.effectStatus).toBe("indeterminate");
    expect(op.reconciliationStatus).toBe("pending");
  });

  // 9. getPendingReconciliation finds indeterminate ops
  it("9: getPendingReconciliation returns indeterminate operations", async () => {
    const op1 = mkOperationId() as string;
    const op2 = mkOperationId() as string;
    await appendAndCatchUp([
      makeOperationDraft(op1, "operation.requested", { operationId: op1, toolName: "bash", args: {}, isReadOnly: false }),
      makeOperationDraft(op1, "operation.completed", { operationId: op1, outcome: "failed", isReadOnly: false }),
      makeOperationDraft(op2, "operation.requested", { operationId: op2, toolName: "read", args: {}, isReadOnly: true }),
      makeOperationDraft(op2, "operation.completed", { operationId: op2, outcome: "succeeded", isReadOnly: true }),
    ]);

    const query = createOperationQuery(db);
    const pending = query.getPendingReconciliation();
    expect(pending.length).toBe(1);
    expect(pending[0]!.operationId).toBe(op1);
  });

  // 10. getByLifecycleState works
  it("10: getByLifecycleState returns operations in a state", async () => {
    const op1 = mkOperationId() as string;
    const op2 = mkOperationId() as string;
    await appendAndCatchUp([
      makeOperationDraft(op1, "operation.requested", { operationId: op1, toolName: "bash", args: {}, isReadOnly: false }),
      makeOperationDraft(op2, "operation.requested", { operationId: op2, toolName: "bash", args: {}, isReadOnly: false }),
      makeOperationDraft(op2, "operation.started", { operationId: op2 }),
    ]);

    const query = createOperationQuery(db);
    expect(query.getByLifecycleState("requested").length).toBe(1); // op1
    expect(query.getByLifecycleState("started").length).toBe(1); // op2
    expect(query.getByLifecycleState("terminal").length).toBe(0);
  });

  // 11. Unknown event types are ignored by the projection (no operations created)
  it("11: non-operation events produce no operation records", async () => {
    await rt.store.append([
      makeOperationDraft(mkOperationId() as string, "memory.created", { value: 42 }) as EventDraft<string, unknown>,
    ]);
    const proj = createOperationsProjection(TEST_WS);
    const runner = rt.store.getProjectionRunner();
    runner.catchUp(proj); // cursor advances (event processed) but no operation rows created
    // Verify no operations exist
    const query = createOperationQuery(db);
    expect(query.getByLifecycleState("requested").length).toBe(0);
    expect(query.getByLifecycleState("terminal").length).toBe(0);
  });

  // 12. Default mapping function correctness
  it("12: defaultEffectStatus and defaultReconciliationStatus", () => {
    expect(defaultEffectStatus("succeeded", false)).toBe("confirmed");
    expect(defaultEffectStatus("failed", false)).toBe("indeterminate");
    expect(defaultEffectStatus("cancelled", false)).toBe("indeterminate");
    expect(defaultEffectStatus("timed_out", false)).toBe("indeterminate");
    expect(defaultEffectStatus("succeeded", true)).toBe("not_applicable");

    expect(defaultReconciliationStatus("confirmed")).toBe("not_required");
    expect(defaultReconciliationStatus("absent")).toBe("not_required");
    expect(defaultReconciliationStatus("not_applicable")).toBe("not_required");
    expect(defaultReconciliationStatus("indeterminate")).toBe("pending");
  });
});
