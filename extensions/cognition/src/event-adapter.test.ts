import { describe, expect, it } from "vitest";
import type {
  CognitionAssistantRecord,
  CognitionCapabilityRequest,
  CognitionHostClient,
  CognitionIdleRecord,
  CognitionToolResultRecord,
} from "./host-client.ts";
import type { CapabilityResult } from "@alcode/agent-protocol";
import { createAgentEventForwarder } from "./event-adapter.ts";

function recordingClient() {
  const assistants: CognitionAssistantRecord[] = [];
  const tools: CognitionToolResultRecord[] = [];
  const idle: CognitionIdleRecord[] = [];
  const client: CognitionHostClient = {
    async requestCapability(request: CognitionCapabilityRequest): Promise<CapabilityResult> {
      return {
        type: "capability.result", requestId: "unused", sessionId: request.sessionId,
        toolCallId: request.toolCallId, toolName: request.toolName, outcome: "succeeded",
      };
    },
    async recordAssistant(record) { assistants.push(structuredClone(record)); },
    async recordToolResult(record) { tools.push(structuredClone(record)); },
    async reportIdle(record) { idle.push(structuredClone(record)); },
  };
  return { client, assistants, tools, idle };
}

describe("cognition semantic Host client", () => {
  it("preserves durable assistant/tool/idle forwarding without raw transport access", async () => {
    const recording = recordingClient();
    const forward = createAgentEventForwarder(recording.client, () => "session-a", true);
    await forward({
      type: "message_end",
      message: {
        role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 10,
      },
    });
    await forward({
      type: "message_end",
      message: {
        role: "toolResult", toolCallId: "tool-1", toolName: "read",
        content: [{ type: "text", text: "ok" }], isError: false, timestamp: 11,
      },
    });
    await forward({ type: "agent_end" });

    expect(recording.assistants).toEqual([{
      sessionId: "session-a", text: "done", content: [{ type: "text", text: "done" }],
      stopReason: "stop", timestamp: 10, durable: true,
    }]);
    expect(recording.tools).toEqual([{
      sessionId: "session-a", toolCallId: "tool-1", toolName: "read",
      content: [{ type: "text", text: "ok" }], isError: false, timestamp: 11,
    }]);
    expect(recording.idle).toEqual([{ sessionId: "session-a", reason: "stop" }]);
  });

  it("keeps pre-0.6 non-durable behavior: text-only assistants and no tool results", async () => {
    const recording = recordingClient();
    const forward = createAgentEventForwarder(recording.client, () => "session-b", false);
    await forward({
      type: "message_end",
      message: {
        role: "assistant", content: [{ type: "toolCall", id: "tc", name: "read", arguments: {} }],
        stopReason: "tool_use", timestamp: 20,
      },
    });
    await forward({
      type: "message_end",
      message: {
        role: "assistant", content: [{ type: "text", text: "legacy" }], stopReason: "stop", timestamp: 21,
      },
    });
    await forward({
      type: "message_end",
      message: {
        role: "toolResult", toolCallId: "tc", toolName: "read",
        content: [{ type: "text", text: "ignored" }], isError: false, timestamp: 22,
      },
    });

    expect(recording.assistants).toEqual([{
      sessionId: "session-b", text: "legacy", content: [{ type: "text", text: "legacy" }],
      stopReason: "stop", timestamp: 21, durable: false,
    }]);
    expect(recording.tools).toEqual([]);
  });
});
