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
  reduceOperationsFromEvents,
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

  it("13: reconciliation can prove an indeterminate effect confirmed", async () => {
    const opId = mkOperationId() as string;
    await appendAndCatchUp([
      makeOperationDraft(opId, "operation.requested", { operationId: opId, toolName: "bash", args: {}, isReadOnly: false }),
      makeOperationDraft(opId, "operation.completed", { operationId: opId, outcome: "failed", isReadOnly: false }),
      makeOperationDraft(opId, "operation.reconciliation.resolved", {
        operationId: opId, effectStatus: "confirmed", evidenceDigest: "sha256:confirmed",
        reconciliationContractId: "bash-reconcile-v1", reconciliationContractVersion: 1,
      }),
    ]);
    const op = createOperationQuery(db).getById(opId)!;
    expect(op.effectStatus).toBe("confirmed");
    expect(op.reconciliationStatus).toBe("resolved");
    const replayed = [];
    for await (const event of rt.store.replay()) replayed.push(event);
    const reduced = reduceOperationsFromEvents(replayed).find((item) => item.operationId === opId);
    expect(reduced).toMatchObject({ effectStatus: "confirmed", reconciliationStatus: "resolved" });
  });

  it("14: insufficient reconciliation preserves indeterminate effect as unresolved", async () => {
    const opId = mkOperationId() as string;
    await appendAndCatchUp([
      makeOperationDraft(opId, "operation.requested", { operationId: opId, toolName: "bash", args: {}, isReadOnly: false }),
      makeOperationDraft(opId, "operation.started", { operationId: opId }),
      makeOperationDraft(opId, "operation.interrupted", { operationId: opId }),
      makeOperationDraft(opId, "operation.reconciliation.unresolved", {
        operationId: opId, evidenceDigest: "sha256:insufficient",
        reconciliationContractId: "bash-reconcile-v1", reconciliationContractVersion: 1,
      }),
    ]);
    const op = createOperationQuery(db).getById(opId)!;
    expect(op.effectStatus).toBe("indeterminate");
    expect(op.reconciliationStatus).toBe("unresolved");
    const replayed = [];
    for await (const event of rt.store.replay()) replayed.push(event);
    const reduced = reduceOperationsFromEvents(replayed).find((item) => item.operationId === opId);
    expect(reduced).toMatchObject({ effectStatus: "indeterminate", reconciliationStatus: "unresolved" });
  });

  it("15: unresolved reconciliation may later resolve from stronger evidence", async () => {
    const opId = mkOperationId() as string;
    await appendAndCatchUp([
      makeOperationDraft(opId, "operation.requested", { operationId: opId, toolName: "bash", args: {}, isReadOnly: false }),
      makeOperationDraft(opId, "operation.completed", { operationId: opId, outcome: "timed_out", isReadOnly: false }),
      makeOperationDraft(opId, "operation.reconciliation.unresolved", {
        operationId: opId, evidenceDigest: "sha256:first",
        reconciliationContractId: "bash-reconcile-v1", reconciliationContractVersion: 1,
      }),
      makeOperationDraft(opId, "operation.reconciliation.resolved", {
        operationId: opId, effectStatus: "absent", evidenceDigest: "sha256:stronger",
        reconciliationContractId: "bash-reconcile-v1", reconciliationContractVersion: 1,
      }),
    ]);
    const op = createOperationQuery(db).getById(opId)!;
    expect(op.effectStatus).toBe("absent");
    expect(op.reconciliationStatus).toBe("resolved");
  });
});

describeLocked("operations model — invalid transition rejection", () => {
  let dir: string;
  let rt: Awaited<ReturnType<typeof openLockedWorkspaceStore>>;
  let db: Database;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "alcode-ops-inv-"));
    rt = await openLockedWorkspaceStore({
      databasePath: join(dir, "ws.sqlite"), lockPath: join(dir, "ws.lock"),
      workspaceId: TEST_WS, repositoryId: TEST_REPO,
    });
    db = Database(join(dir, "ws.sqlite"));
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

  // 1. started without requested → throws; cursor unchanged
  it("started without requested → throws and no operation created", async () => {
    const opId = mkOperationId() as string;
    await expect(appendAndCatchUp([
      makeOperationDraft(opId, "operation.started", { operationId: opId }),
    ])).rejects.toThrow();

    const query = createOperationQuery(db);
    expect(query.getById(opId)).toBeUndefined();
  });

  // 2. duplicate started → throws
  it("duplicate started → throws", async () => {
    const opId = mkOperationId() as string;
    // First requested + started succeed
    await appendAndCatchUp([
      makeOperationDraft(opId, "operation.requested", { operationId: opId, toolName: "bash", args: {}, isReadOnly: false }),
      makeOperationDraft(opId, "operation.started", { operationId: opId }),
    ]);
    // Second started should fail (already in 'started' state)
    await expect(appendAndCatchUp([
      makeOperationDraft(opId, "operation.started", { operationId: opId }),
    ])).rejects.toThrow();

    const op = createOperationQuery(db).getById(opId)!;
    expect(op.lifecycleState).toBe("started"); // unchanged
  });

  // 3. completed without requested → throws
  it("completed without requested → throws", async () => {
    const opId = mkOperationId() as string;
    await expect(appendAndCatchUp([
      makeOperationDraft(opId, "operation.completed", { operationId: opId, outcome: "succeeded", isReadOnly: false }),
    ])).rejects.toThrow();
  });

  // 4. contradictory terminal → throws, preserves original
  it("second contradictory terminal → throws and preserves original", async () => {
    const opId = mkOperationId() as string;
    await appendAndCatchUp([
      makeOperationDraft(opId, "operation.requested", { operationId: opId, toolName: "bash", args: {}, isReadOnly: false }),
      makeOperationDraft(opId, "operation.completed", { operationId: opId, outcome: "succeeded", isReadOnly: false }),
    ]);

    // Attempt contradictory completion (failed after succeeded)
    await expect(appendAndCatchUp([
      makeOperationDraft(opId, "operation.completed", { operationId: opId, outcome: "failed", isReadOnly: false }),
    ])).rejects.toThrow();

    const op = createOperationQuery(db).getById(opId)!;
    expect(op.executionOutcome).toBe("succeeded"); // original preserved
    expect(op.effectStatus).toBe("confirmed");
  });

  // 5. duplicate operation.requested → throws (INSERT not INSERT OR REPLACE)
  it("duplicate requested → throws (strict insert)", async () => {
    const opId = mkOperationId() as string;
    await appendAndCatchUp([
      makeOperationDraft(opId, "operation.requested", { operationId: opId, toolName: "bash", args: {}, isReadOnly: false }),
    ]);
    await expect(appendAndCatchUp([
      makeOperationDraft(opId, "operation.requested", { operationId: opId, toolName: "bash", args: {}, isReadOnly: false }),
    ])).rejects.toThrow();
  });

  it("reconciliation cannot rewrite an already certain effect", async () => {
    const opId = mkOperationId() as string;
    await appendAndCatchUp([
      makeOperationDraft(opId, "operation.requested", { operationId: opId, toolName: "bash", args: {}, isReadOnly: false }),
      makeOperationDraft(opId, "operation.completed", { operationId: opId, outcome: "succeeded", isReadOnly: false }),
    ]);
    await expect(appendAndCatchUp([
      makeOperationDraft(opId, "operation.reconciliation.resolved", {
        operationId: opId, effectStatus: "absent", evidenceDigest: "sha256:nope",
        reconciliationContractId: "bash-reconcile-v1", reconciliationContractVersion: 1,
      }),
    ])).rejects.toThrow();
    expect(createOperationQuery(db).getById(opId)?.effectStatus).toBe("confirmed");
  });

  it("reconciliation rejects missing versioned evidence authority", async () => {
    const opId = mkOperationId() as string;
    await appendAndCatchUp([
      makeOperationDraft(opId, "operation.requested", { operationId: opId, toolName: "bash", args: {}, isReadOnly: false }),
      makeOperationDraft(opId, "operation.completed", { operationId: opId, outcome: "failed", isReadOnly: false }),
    ]);
    await expect(appendAndCatchUp([
      makeOperationDraft(opId, "operation.reconciliation.unresolved", {
        operationId: opId, evidenceDigest: "", reconciliationContractId: "", reconciliationContractVersion: 0,
      }),
    ])).rejects.toThrow("versioned Host evidence authority");
  });
});
