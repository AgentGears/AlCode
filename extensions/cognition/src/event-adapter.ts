import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentEventSink, AssistantMessage, ToolResultMessage } from "@alcode/agent-core";
import type {
  AgentToHostMessage,
  HostToAgentMessage,
  ProtocolTransport,
  TranscriptAdmitted,
} from "@alcode/agent-protocol";

async function admitTranscript(
  transport: ProtocolTransport<AgentToHostMessage, HostToAgentMessage>,
  message: AgentToHostMessage & ({ type: "assistant.message" } | { type: "tool.result" }),
): Promise<TranscriptAdmitted> {
  return new Promise<TranscriptAdmitted>((resolve, reject) => {
    const unsubscribe = transport.onMessage((response) => {
      if (response.type !== "transcript.admitted" || response.requestId !== message.requestId) return;
      unsubscribe();
      resolve(response);
    });
    transport.send(message).catch((error) => {
      unsubscribe();
      reject(error);
    });
  });
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function createAgentEventForwarder(
  transport: ProtocolTransport<AgentToHostMessage, HostToAgentMessage>,
  sessionId: () => string,
  durableTranscript = true,
): AgentEventSink {
  return async (event: AgentEvent) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      const message = event.message as AssistantMessage;
      const text = assistantText(message);
      if (!durableTranscript) {
        // Exact Phase 0.5 compatibility: only non-empty assistant text crosses
        // the protocol; tool-call structure and tool results remain ephemeral.
        if (text) {
          await transport.send({
            type: "assistant.message",
            requestId: randomUUID(),
            sessionId: sessionId(),
            text,
          });
        }
        return;
      }

      const requestId = randomUUID();
      await admitTranscript(transport, {
        type: "assistant.message",
        requestId,
        sessionId: sessionId(),
        text,
        content: message.content,
        stopReason: message.stopReason,
        ...(message.errorMessage !== undefined ? { errorMessage: message.errorMessage } : {}),
        timestamp: message.timestamp,
      });
      return;
    }

    if (event.type === "message_end" && event.message.role === "toolResult") {
      if (!durableTranscript) return;
      const message = event.message as ToolResultMessage;
      const requestId = randomUUID();
      await admitTranscript(transport, {
        type: "tool.result",
        requestId,
        sessionId: sessionId(),
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: message.content,
        isError: message.isError,
        timestamp: message.timestamp,
      });
      return;
    }

    if (event.type === "agent_end") {
      await transport.send({
        type: "agent.idle",
        requestId: randomUUID(),
        sessionId: sessionId(),
        reason: "stop",
      });
    }
  };
}
