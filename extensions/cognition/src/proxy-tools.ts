import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@alcode/agent-core";
import type {
  AgentToHostMessage,
  CapabilityResult,
  HostToAgentMessage,
  ProtocolTransport,
} from "@alcode/agent-protocol";

export interface ProxyToolOptions {
  name: string;
  description?: string;
  isReadOnly?: boolean;
  sessionId: () => string;
  transport: ProtocolTransport<AgentToHostMessage, HostToAgentMessage>;
}

async function requestHost(
  transport: ProtocolTransport<AgentToHostMessage, HostToAgentMessage>,
  message: AgentToHostMessage & { type: "capability.request" },
): Promise<CapabilityResult> {
  return new Promise<CapabilityResult>((resolve, reject) => {
    const unsubscribe = transport.onMessage((response) => {
      if (response.type !== "capability.result" || response.requestId !== message.requestId) return;
      unsubscribe();
      resolve(response);
    });
    transport.send(message).catch((error) => {
      unsubscribe();
      reject(error);
    });
  });
}

export function createProtocolProxyTool(options: ProxyToolOptions): AgentTool<Record<string, unknown>, unknown> {
  return {
    name: options.name,
    description: options.description ?? `Request Host-owned ${options.name} capability or cognition operation.`,
    ...(options.isReadOnly !== undefined ? { isReadOnly: options.isReadOnly } : {}),
    inputSchema: {
      type: "object",
      properties: {},
    },
    async execute(input): Promise<AgentToolResult<unknown>> {
      const requestId = randomUUID();
      const response = await requestHost(options.transport, {
        type: "capability.request",
        requestId,
        sessionId: options.sessionId(),
        toolCallId: randomUUID(),
        toolName: options.name,
        args: input,
      });
      const text = response.error ?? JSON.stringify(response.result ?? null);
      const executionOutcome = response.outcome === "denied"
        ? "failed"
        : response.outcome;
      return {
        content: [{ type: "text", text }],
        details: response.result ?? { error: response.error ?? null },
        executionOutcome,
      };
    },
  };
}
