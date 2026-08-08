// Crash-vertical integration tests — Step 10. POSIX-only (OS lock).
//
// Proves the real tool path preserves cancelled/timed_out outcomes through
// the durable agent and produces the correct terminal operation records:
//   timed_out → executionOutcome=timed_out, effectStatus=indeterminate, reconciliationStatus=pending
//   cancelled → executionOutcome=cancelled, effectStatus=indeterminate, reconciliationStatus=pending
//
// Also proves runDurableAgent's startup recovery surfaces pending operations
// from a prior crashed session.
//
// See docs/phase-0-spec.md §0.2 Step 10 and docs/adr/0003.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { asWorkspaceId, uuidv7 } from "@alcode/events";
import {
  openLockedWorkspaceStore,
  createOperationQuery,
  type LockedWorkspaceStore,
} from "@alcode/storage";
import { TestModelProvider } from "./test-model-provider.ts";
import { runDurableAgent } from "./durable-agent.ts";
import { createBashTool } from "./tools/bash.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

const TEST_WS = asWorkspaceId(uuidv7()) as string;
const TEST_REPO = uuidv7();
const describeLocked = process.platform === "win32" ? describe.skip : describe;

async function openStore(dbPath: string): Promise<LockedWorkspaceStore> {
  const lockPath = dbPath.replace(".sqlite", ".lock");
  return openLockedWorkspaceStore({ databasePath: dbPath, lockPath, workspaceId: TEST_WS, repositoryId: TEST_REPO });
}

function readTerminalOps(dbPath: string) {
  const roDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return createOperationQuery(roDb).getByLifecycleState("terminal");
  } finally {
    roDb.close();
  }
}

function readAllOpsByTool(dbPath: string, toolName: string) {
  const roDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = roDb.prepare("SELECT * FROM operations WHERE tool_name = ? ORDER BY started_at").all(toolName) as Record<string, unknown>[];
    return rows.map((row) => ({
      operationId: row.operation_id as string,
      lifecycleState: row.lifecycle_state as string,
      executionOutcome: (row.execution_outcome as string | null) ?? null,
      effectStatus: row.effect_status as string,
      reconciliationStatus: row.reconciliation_status as string,
    }));
  } finally {
    roDb.close();
  }
}

describeLocked("Step 10 — crash-vertical integration", () => {
  let dir: string;
  let rt: LockedWorkspaceStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-crash-vrt-"));
  });
  afterEach(() => {
    try { rt?.close(); } catch { /* idempotent */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("bash timeout → operation.completed with timed_out, indeterminate, pending", async () => {
    const dbPath = join(dir, "ws.sqlite");
    rt = await openStore(dbPath);

    // Bash tool with a short timeout that will trigger a timeout.
    const bashTool = createBashTool({ workingDirectory: dir, timeoutMs: 500 });
    const cmd = process.platform === "win32"
      ? "powershell -NoProfile -Command Start-Sleep -Seconds 30"
      : "sleep 30";

    const provider = new TestModelProvider([
      { match: "run", text: "Calling bash", toolCall: { id: "tc1", name: "bash", arguments: { command: cmd } } },
      { match: "*", text: "Done." },
    ]);

    await runDurableAgent("run", {
      systemPrompt: "",
      provider,
      tools: [bashTool],
      store: rt,
    });

    // The operation should be terminal with timed_out outcome.
    const ops = readAllOpsByTool(dbPath, "bash");
    expect(ops.length).toBe(1);
    expect(ops[0]!.executionOutcome).toBe("timed_out");
    expect(ops[0]!.effectStatus).toBe("indeterminate");
    expect(ops[0]!.reconciliationStatus).toBe("pending");
    expect(ops[0]!.lifecycleState).toBe("terminal");
  });

  it("bash failure (non-zero exit) → operation.completed with failed, indeterminate, pending", async () => {
    const dbPath = join(dir, "ws.sqlite");
    rt = await openStore(dbPath);

    const bashTool = createBashTool({ workingDirectory: dir });
    const provider = new TestModelProvider([
      { match: "run", text: "Calling bash", toolCall: { id: "tc1", name: "bash", arguments: { command: "exit 42" } } },
      { match: "*", text: "Done." },
    ]);

    await runDurableAgent("run", {
      systemPrompt: "",
      provider,
      tools: [bashTool],
      store: rt,
    });

    const ops = readAllOpsByTool(dbPath, "bash");
    expect(ops.length).toBe(1);
    expect(ops[0]!.executionOutcome).toBe("failed");
    expect(ops[0]!.effectStatus).toBe("indeterminate");
    expect(ops[0]!.reconciliationStatus).toBe("pending");
  });

  it("bash success (exit 0) → operation.completed with succeeded, confirmed, not_required", async () => {
    const dbPath = join(dir, "ws.sqlite");
    rt = await openStore(dbPath);

    const bashTool = createBashTool({ workingDirectory: dir });
    const provider = new TestModelProvider([
      { match: "run", text: "Calling bash", toolCall: { id: "tc1", name: "bash", arguments: { command: "echo hello" } } },
      { match: "*", text: "Done." },
    ]);

    await runDurableAgent("run", {
      systemPrompt: "",
      provider,
      tools: [bashTool],
      store: rt,
    });

    const ops = readAllOpsByTool(dbPath, "bash");
    expect(ops.length).toBe(1);
    expect(ops[0]!.executionOutcome).toBe("succeeded");
    expect(ops[0]!.effectStatus).toBe("confirmed");
    expect(ops[0]!.reconciliationStatus).toBe("not_required");
  });

  it("bash cancellation via AbortSignal → operation.completed with cancelled, indeterminate, pending", async () => {
    const dbPath = join(dir, "ws.sqlite");
    rt = await openStore(dbPath);

    const bashTool = createBashTool({ workingDirectory: dir, timeoutMs: 60_000 });
    const cmd = process.platform === "win32"
      ? "powershell -NoProfile -Command Start-Sleep -Seconds 30"
      : "sleep 30";

    const provider = new TestModelProvider([
      { match: "run", text: "Calling bash", toolCall: { id: "tc1", name: "bash", arguments: { command: cmd } } },
      { match: "*", text: "Done." },
    ]);

    const controller = new AbortController();

    // Abort shortly after the loop starts (the bash tool is sleeping).
    setTimeout(() => controller.abort(), 500);

    await runDurableAgent("run", {
      systemPrompt: "",
      provider,
      tools: [bashTool],
      store: rt,
      signal: controller.signal,
    });

    const ops = readAllOpsByTool(dbPath, "bash");
    expect(ops.length).toBe(1);
    expect(ops[0]!.executionOutcome).toBe("cancelled");
    expect(ops[0]!.effectStatus).toBe("indeterminate");
    expect(ops[0]!.reconciliationStatus).toBe("pending");
    expect(ops[0]!.lifecycleState).toBe("terminal");
  });

  it("startup recovery surfaces pending operations from prior crashed session", async () => {
    const dbPath = join(dir, "ws.sqlite");

    // Session 1: run a bash command that times out (leaves a pending operation).
    rt = await openStore(dbPath);
    const bashTool = createBashTool({ workingDirectory: dir, timeoutMs: 500 });
    const cmd = process.platform === "win32"
      ? "powershell -NoProfile -Command Start-Sleep -Seconds 30"
      : "sleep 30";

    const provider = new TestModelProvider([
      { match: "run", text: "Calling bash", toolCall: { id: "tc1", name: "bash", arguments: { command: cmd } } },
      { match: "*", text: "Done." },
    ]);

    const result1 = await runDurableAgent("run", {
      systemPrompt: "",
      provider,
      tools: [bashTool],
      store: rt,
    });

    // First run has no prior pending ops (fresh workspace).
    expect(result1.pendingOperations.length).toBe(0);
    rt.close();

    // Simulate a crash mid-operation: the timed-out op completed as terminal/pending.
    // Now simulate a different crash: append an operation.started without completed.
    // We do this by directly appending events to simulate a prior crash.
    rt = await openStore(dbPath);
    const { mkEventId, mkSessionId, mkOperationId } = await import("@alcode/events");
    const sid = mkSessionId();
    const opId = mkOperationId();
    const wsId = rt.store.workspaceId;
    await rt.store.append([
      {
        eventId: mkEventId(),
        workspaceId: wsId as never,
        sessionId: sid,
        operationId: opId,
        occurredAt: new Date().toISOString(),
        type: "operation.requested",
        payload: { operationId: opId as string, toolName: "crashed-tool", args: {}, isReadOnly: false },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "test" },
      },
      {
        eventId: mkEventId(),
        workspaceId: wsId as never,
        sessionId: sid,
        operationId: opId,
        occurredAt: new Date().toISOString(),
        type: "operation.started",
        payload: { operationId: opId as string },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "test" },
      },
    ]);
    rt.store.getProjectionRunner().catchUp(
      await import("@alcode/storage").then((m) => m.createOperationsProjection(wsId)),
    );
    rt.close();

    // Session 2: runDurableAgent recovers and surfaces the pending operation.
    rt = await openStore(dbPath);
    const provider2 = new TestModelProvider([{ match: "*", text: "ok" }]);
    const result2 = await runDurableAgent("hello", {
      systemPrompt: "",
      provider: provider2,
      tools: [],
      store: rt,
    });

    expect(result2.pendingOperations.length).toBeGreaterThanOrEqual(1);
    expect(result2.pendingOperations).toContain(opId as string);
  });
});
