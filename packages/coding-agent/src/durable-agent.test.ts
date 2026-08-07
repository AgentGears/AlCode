// Integration tests for the durable agent runtime.
// See docs/phase-0-spec.md §0.2 Step 8.
//
// These prove the three load-bearing invariants of agent integration:
//   1. Real agent-loop execution emits the established domain events, in order.
//   2. The operations projection (critical) is caught up to the event-log head
//      after every tool completion — an operation's terminal row is visible
//      before the loop reports completion.
//   3. The operation lifecycle through the loop matches the contract:
//      succeeded → confirmed, failed → indeterminate, read-only → not_applicable.
//
// Locked-store tests are POSIX-only (no LockFileEx binding on Windows yet),
// matching the storage package's describeLocked pattern.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { asWorkspaceId, uuidv7 } from "@alcode/events";
import {
  openLockedWorkspaceStore,
  createOperationQuery,
  createOperationsProjection,
  type LockedWorkspaceStore,
} from "@alcode/storage";
import { TestModelProvider } from "./test-model-provider.ts";
import { runDurableAgent } from "./durable-agent.ts";
import type { AgentEvent, AgentTool } from "@alcode/agent-core";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

const TEST_WS = asWorkspaceId(uuidv7()) as string;
const TEST_REPO = uuidv7();

/** Skip tests that require workspace locking on Windows (no LockFileEx binding yet). */
const describeLocked = process.platform === "win32" ? describe.skip : describe;

async function openStore(dbPath: string): Promise<LockedWorkspaceStore> {
  const lockPath = dbPath.replace(".sqlite", ".lock");
  return openLockedWorkspaceStore({
    databasePath: dbPath,
    lockPath,
    workspaceId: TEST_WS,
    repositoryId: TEST_REPO,
  });
}

/** A simple deterministic tool for scripting test scenarios. */
function makeScriptedTool(opts: {
  name: string;
  isReadOnly?: boolean;
  result: string;
  throwErr?: string;
}): AgentTool<{ input?: string }, { ok: boolean }> {
  return {
    name: opts.name,
    description: `scripted tool ${opts.name}`,
    isReadOnly: opts.isReadOnly,
    inputSchema: { type: "object", properties: { input: { type: "string" } } },
    async execute() {
      if (opts.throwErr) throw new Error(opts.throwErr);
      return {
        content: [{ type: "text", text: opts.result }],
        details: { ok: true },
      };
    },
  };
}

describeLocked("runDurableAgent — event emission", () => {
  let dir: string;
  let rt: LockedWorkspaceStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-durable-"));
  });
  afterEach(() => {
    try { rt?.close(); } catch { /* idempotent */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists user.message.appended before the loop starts", async () => {
    rt = await openStore(join(dir, "ws.sqlite"));
    const provider = new TestModelProvider([{ match: "*", text: "ok" }]);
    await runDurableAgent("hello durable", {
      systemPrompt: "",
      provider,
      tools: [],
      store: rt,
    });

    const events = [];
    for await (const e of rt.store.replay()) events.push(e);
    const userMsg = events.find((e) => e.type === "user.message.appended");
    expect(userMsg).toBeDefined();
    expect((userMsg!.payload as { text: string }).text).toBe("hello durable");
  });

  it("persists assistant.message.appended for each assistant turn", async () => {
    rt = await openStore(join(dir, "ws.sqlite"));
    const provider = new TestModelProvider([{ match: "*", text: "the reply" }]);
    await runDurableAgent("hi", {
      systemPrompt: "",
      provider,
      tools: [],
      store: rt,
    });

    const events = [];
    for await (const e of rt.store.replay()) events.push(e);
    const assistantMsgs = events.filter((e) => e.type === "assistant.message.appended");
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    expect((assistantMsgs[0]!.payload as { text: string }).text).toBe("the reply");
  });

  it("emits operation.requested, .started, .completed for a tool execution, in order", async () => {
    rt = await openStore(join(dir, "ws.sqlite"));
    const tool = makeScriptedTool({ name: "echo", result: "echoed" });
    const provider = new TestModelProvider([
      {
        match: "go",
        text: "Calling echo",
        toolCall: { id: "tc1", name: "echo", arguments: {} },
      },
      { match: "*", text: "Done" },
    ]);

    await runDurableAgent("go", {
      systemPrompt: "",
      provider,
      tools: [tool],
      store: rt,
    });

    const events = [];
    for await (const e of rt.store.replay()) events.push(e);
    const opEvents = events.filter((e) => e.type.startsWith("operation."));
    const opTypes = opEvents.map((e) => e.type);
    expect(opTypes).toEqual(
      expect.arrayContaining(["operation.requested", "operation.started", "operation.completed"]),
    );

    // Ordering: requested before started before completed
    const reqIdx = opTypes.indexOf("operation.requested");
    const startedIdx = opTypes.indexOf("operation.started");
    const completedIdx = opTypes.indexOf("operation.completed");
    expect(reqIdx).toBeLessThan(startedIdx);
    expect(startedIdx).toBeLessThan(completedIdx);

    // All three reference the same operationId (from the payload), and the
    // envelope operationId matches the payload operationId.
    const requested = opEvents.find((e) => e.type === "operation.requested")!;
    const opId = (requested.payload as { operationId: string }).operationId;
    for (const e of opEvents) {
      expect(e.operationId).toBe(opId);
      expect((e.payload as { operationId: string }).operationId).toBe(opId);
    }
  });
});

describeLocked("runDurableAgent — operations projection gating", () => {
  let dir: string;
  let rt: LockedWorkspaceStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-durable-"));
  });
  afterEach(() => {
    try { rt?.close(); } catch { /* idempotent */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("catches the operations projection up to the event-log head after completion", async () => {
    rt = await openStore(join(dir, "ws.sqlite"));
    const tool = makeScriptedTool({ name: "writefile", result: "wrote" });
    const provider = new TestModelProvider([
      {
        match: "run",
        text: "Calling writefile",
        toolCall: { id: "tc1", name: "writefile", arguments: {} },
      },
      { match: "*", text: "Done" },
    ]);

    await runDurableAgent("run", {
      systemPrompt: "",
      provider,
      tools: [tool],
      store: rt,
    });

    const head = await rt.store.headSequence();
    const runner = rt.store.getProjectionRunner();
    const cursor = runner.getCursor("operations");
    expect(cursor.lastAppliedEventSequence).toBe(head);
  });

  it("the operations projection is caught up when onEvent observes tool_execution_end", async () => {
    rt = await openStore(join(dir, "ws.sqlite"));
    const tool = makeScriptedTool({ name: "touch", result: "ok" });

    // When onEvent observes tool_execution_end, the operation.completed event
    // has already been appended AND caught up. We assert this deterministically:
    // at the observation moment, a no-op catchUp proves the cursor was already
    // at the head of the operations events that had been emitted by then.
    let cursorAtEnd: number | undefined;
    let appliedIfWeCatchUpNow: number | undefined;

    const provider = new TestModelProvider([
      {
        match: "go",
        text: "Calling",
        toolCall: { id: "tc1", name: "touch", arguments: {} },
      },
      { match: "*", text: "Done" },
    ]);

    await runDurableAgent("go", {
      systemPrompt: "",
      provider,
      tools: [tool],
      store: rt,
      onEvent(event: AgentEvent) {
        if (event.type === "tool_execution_end") {
          const runner = rt.store.getProjectionRunner();
          cursorAtEnd = runner.getCursor("operations").lastAppliedEventSequence;
          // If the projection were lagging, this catchUp would apply >0 events.
          // Since the sink catches up before forwarding the event, this is a no-op.
          appliedIfWeCatchUpNow = runner.catchUp(
            createOperationsProjection(rt.store.workspaceId),
          ).appliedCount;
        }
      },
    });

    expect(cursorAtEnd).toBeDefined();
    expect(cursorAtEnd).toBeGreaterThan(0);
    expect(appliedIfWeCatchUpNow).toBe(0);
  });
});

describeLocked("runDurableAgent — operation lifecycle outcomes", () => {
  let dir: string;
  let rt: LockedWorkspaceStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-durable-"));
  });
  afterEach(() => {
    try { rt?.close(); } catch { /* idempotent */ }
    rmSync(dir, { recursive: true, force: true });
  });

  async function runWithTool(tool: AgentTool): Promise<{ events: { type: string; payload: unknown }[] }> {
    const provider = new TestModelProvider([
      {
        match: "run",
        text: "Calling",
        toolCall: { id: "tc1", name: tool.name, arguments: {} },
      },
      { match: "*", text: "Done" },
    ]);
    await runDurableAgent("run", {
      systemPrompt: "",
      provider,
      tools: [tool],
      store: rt,
    });
    const events: { type: string; payload: unknown }[] = [];
    for await (const e of rt.store.replay()) events.push({ type: e.type, payload: e.payload });
    return { events };
  }

  /** Open a read-only connection to the workspace DB (WAL allows concurrent reads). */
  function readOperations(dbPath: string) {
    const roDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return createOperationQuery(roDb).getByLifecycleState("terminal");
    } finally {
      roDb.close();
    }
  }

  it("succeeded mutating tool → executionOutcome=succeeded, effectStatus=confirmed", async () => {
    rt = await openStore(join(dir, "ws.sqlite"));
    const tool = makeScriptedTool({ name: "writer", result: "ok" });
    const { events } = await runWithTool(tool);

    const completed = events.find((e) => e.type === "operation.completed")!;
    const payload = completed.payload as { outcome: string; isReadOnly: boolean };
    expect(payload.outcome).toBe("succeeded");
    expect(payload.isReadOnly).toBe(false);

    // Assert the projection materialized the default effect mapping.
    const terminals = readOperations(join(dir, "ws.sqlite"));
    expect(terminals.length).toBe(1);
    expect(terminals[0]!.executionOutcome).toBe("succeeded");
    expect(terminals[0]!.effectStatus).toBe("confirmed");
    expect(terminals[0]!.reconciliationStatus).toBe("not_required");
    expect(terminals[0]!.lifecycleState).toBe("terminal");
  });

  it("failed tool → executionOutcome=failed, effectStatus=indeterminate", async () => {
    rt = await openStore(join(dir, "ws.sqlite"));
    const tool = makeScriptedTool({ name: "broken", result: "", throwErr: "boom" });
    const { events } = await runWithTool(tool);

    const completed = events.find((e) => e.type === "operation.completed")!;
    const payload = completed.payload as { outcome: string; isReadOnly: boolean };
    expect(payload.outcome).toBe("failed");
    expect(payload.isReadOnly).toBe(false);

    // Assert the projection materialized the indeterminate effect mapping.
    const terminals = readOperations(join(dir, "ws.sqlite"));
    expect(terminals.length).toBe(1);
    expect(terminals[0]!.executionOutcome).toBe("failed");
    expect(terminals[0]!.effectStatus).toBe("indeterminate");
    expect(terminals[0]!.reconciliationStatus).toBe("pending");
  });

  it("succeeded read-only tool → effectStatus=not_applicable (isReadOnly propagated)", async () => {
    rt = await openStore(join(dir, "ws.sqlite"));
    const tool = makeScriptedTool({ name: "reader", result: "data", isReadOnly: true });
    const { events } = await runWithTool(tool);

    const completed = events.find((e) => e.type === "operation.completed")!;
    const payload = completed.payload as { outcome: string; isReadOnly: boolean };
    expect(payload.outcome).toBe("succeeded");
    expect(payload.isReadOnly).toBe(true);

    // Assert the projection materialized not_applicable for read-only.
    const terminals = readOperations(join(dir, "ws.sqlite"));
    expect(terminals.length).toBe(1);
    expect(terminals[0]!.executionOutcome).toBe("succeeded");
    expect(terminals[0]!.effectStatus).toBe("not_applicable");
    expect(terminals[0]!.reconciliationStatus).toBe("not_required");
  });
});

describeLocked("runDurableAgent — reopen invariant", () => {
  let dir: string;
  let rt: LockedWorkspaceStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-durable-"));
  });
  afterEach(() => {
    try { rt?.close(); } catch { /* idempotent */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("reopen replays events and operations projection catches up to the same state", async () => {
    rt = await openStore(join(dir, "ws.sqlite"));
    const tool = makeScriptedTool({ name: "echo", result: "echoed" });
    const provider = new TestModelProvider([
      {
        match: "run",
        text: "Calling",
        toolCall: { id: "tc1", name: "echo", arguments: {} },
      },
      { match: "*", text: "Done" },
    ]);
    await runDurableAgent("run", {
      systemPrompt: "",
      provider,
      tools: [tool],
      store: rt,
    });
    rt.close();

    // Reopen the same workspace DB.
    rt = await openStore(join(dir, "ws.sqlite"));
    const runner = rt.store.getProjectionRunner();
    const cursor = runner.getCursor("operations");
    const head = await rt.store.headSequence();
    expect(cursor.lastAppliedEventSequence).toBe(head);

    // Re-running catchUp is a no-op (already caught up by the prior session's
    // critical-projection gating; reopening does not regress it).
    const result = runner.catchUp(createOperationsProjection(rt.store.workspaceId));
    expect(result.appliedCount).toBe(0);
    expect(result.caught).toBe(true);
  });
});
