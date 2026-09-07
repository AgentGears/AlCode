import { describe, expect, it } from "vitest";
import type { ModelRequest } from "@alcode/agent-core";
import { scriptedTurnIndexFromDurableTranscript } from "./agent-runtime-profile.ts";

describe("scripted Agent durable transcript cursor", () => {
  it("derives the next scripted turn from Host-durable assistant history", () => {
    const messages: ModelRequest["messages"] = [
      {
        role: "user",
        content: [{ type: "text", text: "objective" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "first-edit",
          name: "edit",
          arguments: {},
        }],
        stopReason: "tool_use",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "first-edit",
        toolName: "edit",
        content: [{ type: "text", text: "done" }],
        isError: false,
        timestamp: 3,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "ready for verification" }],
        stopReason: "stop",
        timestamp: 4,
      },
    ];

    expect(scriptedTurnIndexFromDurableTranscript({ messages: [] })).toBe(0);
    expect(scriptedTurnIndexFromDurableTranscript({ messages })).toBe(2);
    expect(scriptedTurnIndexFromDurableTranscript({ messages: structuredClone(messages) })).toBe(2);
  });
});
