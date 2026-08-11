import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentEventSink } from "@alcode/agent-core";
import type {
  AgentToHostMessage,
  HostToAgentMessage,
  ProtocolTransport,
} from "@alcode/agent-protocol";

export function createAgentEventForwarder(
  transport: ProtocolTransport<AgentToHostMessage, HostToAgentMessage>,
  sessionId: () => string,
): AgentEventSink {
  return async (event: AgentEvent) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      const text = event.message.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("");
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
