import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolResult, ToolInputSchema } from "@alcode/agent-core";
import type {
  AgentToHostMessage,
  HostToAgentMessage,
  ProgramAttemptAuthorityV1,
  ProtocolTransport,
} from "@alcode/agent-protocol";

export interface ProxyToolOptions {
  name: string;
  description?: string;
  inputSchema?: ToolInputSchema;
  isReadOnly?: boolean;
  expectedCapabilityRevision?: string;
  programAttemptAuthority?: ProgramAttemptAuthorityV1;
  sessionId: () => string;
  transport: ProtocolTransport<AgentToHostMessage, HostToAgentMessage>;
}

async function requestHost(
  transport: ProtocolTransport<AgentToHostMessage, HostToAgentMessage>,
  message: AgentToHostMessage & { type: "capability.request" },
): Promise<Extract<HostToAgentMessage, { type: "capability.result" }>> {
  return new Promise((resolve, reject) => {
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
  const programAttemptAuthority = options.programAttemptAuthority === undefined
    ? undefined
    : structuredClone(options.programAttemptAuthority);
  return {
    name: options.name,
    description: options.description ?? `Request Host-owned ${options.name} capability or cognition operation.`,
    inputSchema: structuredClone(options.inputSchema ?? { type: "object", properties: {} }),
    ...(options.isReadOnly !== undefined ? { isReadOnly: options.isReadOnly } : {}),
    async execute(input, context): Promise<AgentToolResult<unknown>> {
      const requestId = randomUUID();
      const response = await requestHost(options.transport, {
        type: "capability.request",
        requestId,
        sessionId: options.sessionId(),
        toolCallId: context.toolCallId ?? randomUUID(),
        toolName: options.name,
        args: input,
        ...(options.expectedCapabilityRevision !== undefined ? { expectedCapabilityRevision: options.expectedCapabilityRevision } : {}),
        ...(programAttemptAuthority !== undefined
          ? { programAttemptAuthority: structuredClone(programAttemptAuthority) }
          : {}),
      });
      const text = response.error ?? JSON.stringify(response.result ?? null);
      const executionOutcome = response.outcome === "denied" || response.outcome === "stale" ? "failed" : response.outcome;
      return {
        content: [{ type: "text", text }],
        details: response.result ?? { error: response.error ?? null, ...(response.errorCode !== undefined ? { errorCode: response.errorCode } : {}) },
        executionOutcome,
      };
    },
  };
}
