import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolResult, ToolInputSchema } from "@alcode/agent-core";
import type { ProgramAttemptAuthorityV1 } from "@alcode/agent-protocol";
import type { CognitionHostClient } from "./host-client.ts";

export interface ProxyToolOptions {
  name: string;
  description?: string;
  inputSchema?: ToolInputSchema;
  isReadOnly?: boolean;
  expectedCapabilityRevision?: string;
  programAttemptAuthority?: ProgramAttemptAuthorityV1;
  sessionId: () => string;
  client: Pick<CognitionHostClient, "requestCapability">;
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
      const response = await options.client.requestCapability({
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
