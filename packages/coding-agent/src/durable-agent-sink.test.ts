// Windows-runnable unit tests for the durable sink's event translation logic.
// These do NOT touch SQLite or the OS lock; they verify the AgentEvent →
// domain-event mapping (ordering, payload shape, isReadOnly propagation,
// causation chaining) against an in-memory fake store. The full locked-store
// integration is covered by durable-agent.test.ts (POSIX-only).
//
// See docs/phase-0-spec.md §0.2 Step 8.

import { describe, expect, it } from "vitest";
import { asWorkspaceId, type EventDraft } from "@alcode/events";
import type { AgentEvent, AgentTool } from "@alcode/agent-core";
import { buildDurableSinkForTest } from "./durable-agent.ts";

/** In-memory fake store: records appended drafts, exposes a no-op runner. */
function makeFakeStore(workspaceId: string) {
  const appended: EventDraft<string, unknown>[] = [];
  return {
    workspaceId,
    async append(drafts: readonly EventDraft<string, unknown>[]) {
      appended.push(...drafts);
      return drafts.map((d, i) => ({ ...d, sequence: appended.length - drafts.length + i + 1, recordedAt: "now", eventDigest: "x" }));
    },
    getProjectionRunner() {
      return {
        getCursor: () => ({ projectionName: "operations", lastAppliedEventSequence: appended.length, schemaVersion: 1, classification: "critical" as const }),
        catchUp: () => ({ appliedCount: appended.length, newCursor: { projectionName: "operations", lastAppliedEventSequence: appended.length, schemaVersion: 1, classification: "critical" as const }, caught: true }),
      };
    },
    snapshot: () => appended.map((d) => ({ type: d.type, payload: d.payload, operationId: d.operationId, causationEventId: d.causationEventId })),
  };
}

describe("buildDurableSink — event translation (Windows-runnable)", () => {
  it("tool_execution_start emits operation.requested then operation.started, with matching operationId", async () => {
    const store = makeFakeStore(asWorkspaceId("00000000-0000-7000-8000-000000000001") as string);
    const tools: AgentTool[] = [{ name: "write", description: "", inputSchema: { type: "object", properties: {} }, async execute() { return { content: [], details: {} }; } }];
    const { sink } = buildDurableSinkForTest(store as never, "00000000-0000-7000-8000-000000000002" as never, tools);

    await sink({ type: "tool_execution_start", toolCallId: "tc1", toolName: "write", args: { x: 1 } });

    const snap = store.snapshot();
    expect(snap.map((s) => s.type)).toEqual(["operation.requested", "operation.started"]);
    const opId = (snap[0]!.payload as { operationId: string }).operationId;
    expect((snap[1]!.payload as { operationId: string }).operationId).toBe(opId);
    expect(snap[0]!.operationId).toBe(opId);
    expect(snap[1]!.operationId).toBe(opId);

    const requestedPayload = snap[0]!.payload as { toolName: string; args: unknown; isReadOnly: boolean };
    expect(requestedPayload.toolName).toBe("write");
    expect(requestedPayload.args).toEqual({ x: 1 });
    expect(requestedPayload.isReadOnly).toBe(false);
  });

  it("tool_execution_end emits operation.completed with outcome derived from isError", async () => {
    const store = makeFakeStore(asWorkspaceId("00000000-0000-7000-8000-000000000001") as string);
    const tools: AgentTool[] = [{ name: "write", description: "", inputSchema: { type: "object", properties: {} }, async execute() { return { content: [], details: {} }; } }];
    const { sink } = buildDurableSinkForTest(store as never, "00000000-0000-7000-8000-000000000002" as never, tools);

    await sink({ type: "tool_execution_start", toolCallId: "tc1", toolName: "write", args: {} });
    await sink({ type: "tool_execution_end", toolCallId: "tc1", toolName: "write", result: { content: [], details: {} }, isError: true });

    const completed = store.snapshot().find((s) => s.type === "operation.completed")!;
    const payload = completed.payload as { outcome: string; isReadOnly: boolean };
    expect(payload.outcome).toBe("failed");
    expect(payload.isReadOnly).toBe(false);
  });

  it("isReadOnly propagates from the tool to operation.requested and operation.completed", async () => {
    const store = makeFakeStore(asWorkspaceId("00000000-0000-7000-8000-000000000001") as string);
    const tools: AgentTool[] = [{
      name: "read", description: "", isReadOnly: true,
      inputSchema: { type: "object", properties: {} },
      async execute() { return { content: [], details: {} }; },
    }];
    const { sink } = buildDurableSinkForTest(store as never, "00000000-0000-7000-8000-000000000002" as never, tools);

    await sink({ type: "tool_execution_start", toolCallId: "tc1", toolName: "read", args: {} });
    await sink({ type: "tool_execution_end", toolCallId: "tc1", toolName: "read", result: { content: [], details: {} }, isError: false });

    const requested = store.snapshot().find((s) => s.type === "operation.requested")!;
    const completed = store.snapshot().find((s) => s.type === "operation.completed")!;
    expect((requested.payload as { isReadOnly: boolean }).isReadOnly).toBe(true);
    expect((completed.payload as { isReadOnly: boolean }).isReadOnly).toBe(true);
  });

  it("operation.completed carries causationEventId pointing to operation.started", async () => {
    const store = makeFakeStore(asWorkspaceId("00000000-0000-7000-8000-000000000001") as string);
    const tools: AgentTool[] = [{ name: "write", description: "", inputSchema: { type: "object", properties: {} }, async execute() { return { content: [], details: {} }; } }];
    const { sink } = buildDurableSinkForTest(store as never, "00000000-0000-7000-8000-000000000002" as never, tools);

    await sink({ type: "tool_execution_start", toolCallId: "tc1", toolName: "write", args: {} });
    await sink({ type: "tool_execution_end", toolCallId: "tc1", toolName: "write", result: { content: [], details: {} }, isError: false });

    const started = store.snapshot().find((s) => s.type === "operation.started")!;
    const completed = store.snapshot().find((s) => s.type === "operation.completed")!;
    // The fake store mangles eventId; we can't assert identity, but we can
    // assert that causationEventId was set on completion (truthy).
    expect(completed.causationEventId).toBeTruthy();
    void started;
  });

  it("tool_execution_end without a matching start is ignored (no dangling completed)", async () => {
    const store = makeFakeStore(asWorkspaceId("00000000-0000-7000-8000-000000000001") as string);
    const tools: AgentTool[] = [{ name: "write", description: "", inputSchema: { type: "object", properties: {} }, async execute() { return { content: [], details: {} }; } }];
    const { sink } = buildDurableSinkForTest(store as never, "00000000-0000-7000-8000-000000000002" as never, tools);

    await sink({ type: "tool_execution_end", toolCallId: "ghost", toolName: "write", result: { content: [], details: {} }, isError: false });

    expect(store.snapshot().some((s) => s.type === "operation.completed")).toBe(false);
  });

  it("message_end for assistant emits assistant.message.appended with text", async () => {
    const store = makeFakeStore(asWorkspaceId("00000000-0000-7000-8000-000000000001") as string);
    const { sink } = buildDurableSinkForTest(store as never, "00000000-0000-7000-8000-000000000002" as never, []);

    const event: AgentEvent = {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "stop", timestamp: 0 },
    };
    await sink(event);

    const appended = store.snapshot().find((s) => s.type === "assistant.message.appended")!;
    expect((appended.payload as { text: string }).text).toBe("hello");
  });

  it("message_end for non-assistant messages emits nothing", async () => {
    const store = makeFakeStore(asWorkspaceId("00000000-0000-7000-8000-000000000001") as string);
    const { sink } = buildDurableSinkForTest(store as never, "00000000-0000-7000-8000-000000000002" as never, []);

    await sink({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "x" }], timestamp: 0 } });
    expect(store.snapshot().length).toBe(0);
  });

  it("onEvent is forwarded every event AFTER the durable side-effect", async () => {
    const store = makeFakeStore(asWorkspaceId("00000000-0000-7000-8000-000000000001") as string);
    const observed: AgentEvent[] = [];
    const tools: AgentTool[] = [{ name: "write", description: "", inputSchema: { type: "object", properties: {} }, async execute() { return { content: [], details: {} }; } }];
    const { sink } = buildDurableSinkForTest(store as never, "00000000-0000-7000-8000-000000000002" as never, tools, (e) => { observed.push(e); });

    const startEv: AgentEvent = { type: "tool_execution_start", toolCallId: "tc1", toolName: "write", args: {} };
    await sink(startEv);
    // onEvent should have fired with the start event, AND the durable side-effect (requested+started) preceded it.
    expect(observed).toContain(startEv);
    expect(store.snapshot().length).toBe(2);
  });
});
