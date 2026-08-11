import { describe, expect, it } from "vitest";
import {
  assertRichTranscriptTransition,
  reduceTranscript,
  type TranscriptEventRecord,
} from "./index.ts";

function event(sequence: number, type: TranscriptEventRecord["type"], payload: unknown): TranscriptEventRecord {
  return {
    eventId: `e${sequence}`,
    sequence,
    type,
    payload,
    occurredAt: `2026-08-12T00:00:0${sequence}.000Z`,
  };
}

const user = event(1, "user.message.appended", { text: "inspect", timestamp: 1 });
const assistant = event(2, "assistant.message.appended", {
  text: "checking",
  content: [
    { type: "text", text: "checking" },
    { type: "toolCall", id: "T1", name: "read", arguments: { path: "a.ts" } },
  ],
  stopReason: "tool_use",
  timestamp: 2,
});
const result = event(3, "tool.result.appended", {
  toolCallId: "T1",
  toolName: "read",
  content: [{ type: "text", text: "contents" }],
  isError: false,
  timestamp: 3,
});

describe("transcript semantics", () => {
  it("reconstructs exact complete tool history", () => {
    const reduced = reduceTranscript([user, assistant, result]);
    expect(reduced.fidelity).toBe("exact");
    expect(reduced.status).toBe("complete");
    expect(reduced.pendingToolCallIds).toEqual([]);
    expect(reduced.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
  });

  it("reconstructs orphaned calls but marks them incomplete", () => {
    const reduced = reduceTranscript([user, assistant]);
    expect(reduced.status).toBe("incomplete");
    expect(reduced.pendingToolCallIds).toEqual(["T1"]);
  });

  it("reports legacy text-only fidelity without fabricating tool history", () => {
    const reduced = reduceTranscript([
      event(1, "user.message.appended", { text: "legacy" }),
      event(2, "assistant.message.appended", { text: "reply" }),
    ]);
    expect(reduced.fidelity).toBe("legacy_text_only");
    expect(reduced.status).toBe("complete");
    expect(reduced.messages[1]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "reply" }] });
  });

  it("rejects rich assistant text/content disagreement before append", () => {
    const current = reduceTranscript([user]);
    expect(() => assertRichTranscriptTransition(current, "assistant.message.appended", {
      text: "foo",
      content: [{ type: "text", text: "bar" }],
      stopReason: "stop",
      timestamp: 2,
    })).toThrow(/text\/content mismatch/);
  });

  it("rejects result for unknown tool call", () => {
    const current = reduceTranscript([user]);
    expect(() => assertRichTranscriptTransition(current, "tool.result.appended", {
      toolCallId: "missing",
      toolName: "read",
      content: [{ type: "text", text: "x" }],
      isError: false,
      timestamp: 2,
    })).toThrow(/unresolved\/unknown/);
  });

  it("rejects duplicate tool-call identity", () => {
    const current = reduceTranscript([user, assistant]);
    expect(() => assertRichTranscriptTransition(current, "assistant.message.appended", {
      text: "again",
      content: [
        { type: "text", text: "again" },
        { type: "toolCall", id: "T1", name: "read", arguments: {} },
      ],
      stopReason: "tool_use",
      timestamp: 4,
    })).toThrow(/duplicate transcript tool call id/);
  });
});
