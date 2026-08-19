import type { AgentEvent, AgentEventSink, AssistantMessage, ToolResultMessage } from "@alcode/agent-core";
import type { CognitionHostClient } from "./host-client.ts";

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function createAgentEventForwarder(
  client: Pick<CognitionHostClient, "recordAssistant" | "recordToolResult" | "reportIdle">,
  sessionId: () => string,
  durableTranscript = true,
): AgentEventSink {
  return async (event: AgentEvent) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      const message = event.message as AssistantMessage;
      const text = assistantText(message);
      if (!durableTranscript && !text) return;
      await client.recordAssistant({
        sessionId: sessionId(),
        text,
        content: structuredClone(message.content),
        stopReason: message.stopReason,
        ...(message.errorMessage !== undefined ? { errorMessage: message.errorMessage } : {}),
        timestamp: message.timestamp,
        durable: durableTranscript,
      });
      return;
    }

    if (event.type === "message_end" && event.message.role === "toolResult") {
      if (!durableTranscript) return;
      const message = event.message as ToolResultMessage;
      await client.recordToolResult({
        sessionId: sessionId(),
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: structuredClone(message.content),
        isError: message.isError,
        timestamp: message.timestamp,
      });
      return;
    }

    if (event.type === "agent_end") {
      await client.reportIdle({
        sessionId: sessionId(),
        reason: "stop",
      });
    }
  };
}
