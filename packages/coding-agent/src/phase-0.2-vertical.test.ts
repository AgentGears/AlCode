// Exact Phase 0.2 vertical test — the frozen gate sequence.
// POSIX-only (OS lock).
//
// Exercises the complete Phase 0.2 exact gate:
//   start runtime → resolve workspace → append user message → model response
//   → execute one controlled tool → append operation/result events
//   → objective.set (reasoning) → memory.created/retrieve (memory)
//   → stop → catch up reasoning + memory
//   → operations cursor == transcript cursor == head
//   → snapshot durable state → close
//   → reopen → zero new events → equivalent durable state
//
// See docs/phase-0-spec.md §0.2 "exact gate" (lines 310-316).

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  mkEventId,
  asWorkspaceId,
  uuidv7,
  asMemoryId,
  type PersistedDomainEvent,
} from "@alcode/events";
import {
  openLockedWorkspaceStore,
  createOperationsProjection,
  createTranscriptProjection,
  createReasoningProjection,
  createMemoryProjection,
  createMemoryQuery,
  type LockedWorkspaceStore,
} from "@alcode/storage";
import { TestModelProvider } from "./test-model-provider.ts";
import { runDurableAgent } from "./durable-agent.ts";
import type { AgentTool, AgentEvent } from "@alcode/agent-core";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

const TEST_WS = asWorkspaceId(uuidv7()) as string;
const TEST_REPO = uuidv7();
const describeLocked = process.platform === "win32" ? describe.skip : describe;

async function openStore(dbPath: string): Promise<LockedWorkspaceStore> {
  const lockPath = dbPath.replace(".sqlite", ".lock");
  return openLockedWorkspaceStore({ databasePath: dbPath, lockPath, workspaceId: TEST_WS, repositoryId: TEST_REPO });
}

function makeScriptedTool(): AgentTool {
  return {
    name: "echo",
    description: "scripted echo",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "echoed" }], details: {} };
    },
  };
}

function eventSignature(e: PersistedDomainEvent<string, unknown>) {
  return {
    eventId: e.eventId,
    sequence: e.sequence,
    type: e.type,
    payload: e.payload,
    payloadSchemaVersion: e.payloadSchemaVersion,
    producer: e.producer,
    eventDigest: e.eventDigest,
  };
}

describeLocked("Phase 0.2 exact vertical gate", () => {
  let dir: string;
  let rt: LockedWorkspaceStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-p02-vrt-"));
  });
  afterEach(() => {
    try { rt?.close(); } catch { /* idempotent */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs the full exact gate sequence: tool → reasoning → memory → stop → reopen → equivalent", async () => {
    const dbPath = join(dir, "ws.sqlite");
    const memId = "test/phase0-memory.md";
    const objectiveNodeId = "obj-001";
    const workspaceId = TEST_WS;

    // --- Phase 1: run the production path with the exact-gate additions ---
    rt = await openStore(dbPath);

    const provider = new TestModelProvider([
      { match: "run", text: "Calling echo", toolCall: { id: "tc1", name: "echo", arguments: {} } },
      { match: "*", text: "Done." },
    ]);

    // Use onEvent to append objective.set + memory.created AFTER the tool runs
    // but BEFORE runDurableAgent's finally emits session.stopped. We hook on
    // tool_execution_end (the tool just completed).
    let appendedCognition = false;
    const result = await runDurableAgent("run", {
      systemPrompt: "",
      provider,
      tools: [makeScriptedTool()],
      store: rt,
      onEvent(event: AgentEvent) {
        if (event.type === "tool_execution_end" && !appendedCognition) {
          // Append the reasoning + memory events via the store directly.
          // These happen synchronously within onEvent, before the finally block.
          appendedCognition = true;
          // We need to await, but onEvent is sync-capable. We use a void
          // promise — the test waits for runDurableAgent to resolve, and the
          // append is synchronous within better-sqlite3's transaction.
          void rt.store.append([
            {
              eventId: mkEventId(),
              workspaceId: workspaceId as never,
              sessionId: "00000000-0000-7000-8000-0000000000C1" as never,
              occurredAt: new Date().toISOString(),
              type: "objective.set",
              payload: { nodeId: objectiveNodeId, kind: "objective", label: "Phase 0.2 test objective", confidence: 1.0 },
              payloadSchemaVersion: 1,
              producer: { kind: "runtime", component: "test" },
            },
            {
              eventId: mkEventId(),
              workspaceId: workspaceId as never,
              sessionId: "00000000-0000-7000-8000-0000000000C1" as never,
              occurredAt: new Date().toISOString(),
              type: "memory.created",
              payload: { memoryId: memId, type: "reference", body: "Phase 0.2 memory" },
              payloadSchemaVersion: 1,
              producer: { kind: "runtime", component: "test" },
            },
          ]);
        }
      },
    });

    // After the run: catch up derived projections.
    const runner = rt.store.getProjectionRunner();
    runner.catchUp(createReasoningProjection(workspaceId));
    runner.catchUp(createMemoryProjection(workspaceId));

    // Verify reasoning node.
    const roDb1 = new Database(dbPath, { readonly: true, fileMustExist: true });
    let reasoningRow: { label: string; kind: string } | undefined;
    let memoryRow: { memory_id: string; body: string } | undefined;
    try {
      reasoningRow = roDb1.prepare("SELECT label, kind FROM reasoning_nodes WHERE node_id = ?").get(objectiveNodeId) as { label: string; kind: string } | undefined;
      memoryRow = roDb1.prepare("SELECT memory_id, body FROM memories WHERE memory_id = ?").get(memId) as { memory_id: string; body: string } | undefined;
    } finally {
      roDb1.close();
    }
    expect(reasoningRow).toBeDefined();
    expect(reasoningRow!.label).toBe("Phase 0.2 test objective");
    expect(reasoningRow!.kind).toBe("objective");

    // Verify memory via createMemoryQuery (the "retrieve" step).
    const roDb2 = new Database(dbPath, { readonly: true, fileMustExist: true });
    let retrieved: { body: string; type: string } | undefined;
    try {
      retrieved = createMemoryQuery(roDb2).getById(memId);
    } finally {
      roDb2.close();
    }
    expect(retrieved).toBeDefined();
    expect(retrieved!.body).toBe("Phase 0.2 memory");
    expect(retrieved!.type).toBe("reference");

    // Exit invariant: both critical cursors == head.
    const head = await rt.store.headSequence();
    const opsCursor = runner.getCursor("operations").lastAppliedEventSequence;
    const transcriptCursor = runner.getCursor("transcript").lastAppliedEventSequence;
    expect(opsCursor).toBe(head);
    expect(transcriptCursor).toBe(head);

    // Snapshot durable state (event signatures).
    const eventsS1 = [];
    for await (const e of rt.store.replay()) eventsS1.push(eventSignature(e));
    void result; // suppress unused

    rt.close();

    // --- Phase 2: reopen → zero new events → equivalent durable state ---
    rt = await openStore(dbPath);

    // Head unchanged before any catch-up.
    const headReopened = await rt.store.headSequence();
    expect(headReopened).toBe(head);

    // Catch up all projections — clean shutdown → everything applies 0.
    const runner2 = rt.store.getProjectionRunner();
    const opsResult = runner2.catchUp(createOperationsProjection(rt.store.workspaceId));
    const transcriptResult = runner2.catchUp(createTranscriptProjection(rt.store.workspaceId));
    const reasoningResult = runner2.catchUp(createReasoningProjection(rt.store.workspaceId));
    const memoryResult = runner2.catchUp(createMemoryProjection(rt.store.workspaceId));
    expect(opsResult.appliedCount).toBe(0);
    expect(transcriptResult.appliedCount).toBe(0);
    expect(reasoningResult.appliedCount).toBe(0);
    expect(memoryResult.appliedCount).toBe(0);

    // Event signatures identical.
    const eventsReopened = [];
    for await (const e of rt.store.replay()) eventsReopened.push(eventSignature(e));
    expect(eventsReopened).toEqual(eventsS1);

    // Both critical cursors still at head.
    expect(runner2.getCursor("operations").lastAppliedEventSequence).toBe(head);
    expect(runner2.getCursor("transcript").lastAppliedEventSequence).toBe(head);

    // Reasoning and memory survive intact.
    const roDb3 = new Database(dbPath, { readonly: true, fileMustExist: true });
    let reasoningAfter: { label: string } | undefined;
    let memoryAfter: { body: string } | undefined;
    try {
      reasoningAfter = roDb3.prepare("SELECT label FROM reasoning_nodes WHERE node_id = ?").get(objectiveNodeId) as { label: string } | undefined;
      memoryAfter = createMemoryQuery(roDb3).getById(memId);
    } finally {
      roDb3.close();
    }
    expect(reasoningAfter!.label).toBe("Phase 0.2 test objective");
    expect(memoryAfter!.body).toBe("Phase 0.2 memory");
  });
});
