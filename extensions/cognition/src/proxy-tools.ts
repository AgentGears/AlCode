import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolResult, ToolInputSchema } from "@alcode/agent-core";
import type {
  CapabilityResult,
  ProgramAttemptAuthorityAny,
  ProgramAttemptAuthorityV1,
} from "@alcode/agent-protocol";
import type {
  CognitionCapabilityRequest,
  CognitionCapabilityRequestV2Aware,
  CognitionHostClient,
  CognitionHostClientV2Aware,
} from "./host-client.ts";

type CapabilityClient<TAuthority extends ProgramAttemptAuthorityAny> = {
  requestCapability(
    request: TAuthority extends ProgramAttemptAuthorityV1
      ? CognitionCapabilityRequest
      : CognitionCapabilityRequestV2Aware,
  ): Promise<CapabilityResult>;
};

export interface ProxyToolOptions<TAuthority extends ProgramAttemptAuthorityAny = ProgramAttemptAuthorityV1> {
  name: string;
  description?: string;
  inputSchema?: ToolInputSchema;
  isReadOnly?: boolean;
  expectedCapabilityRevision?: string;
  programAttemptAuthority?: TAuthority;
  sessionId: () => string;
  client: CapabilityClient<TAuthority>;
}

/**
 * Agent-local proxy. Authority stays semantic data until the Host protocol
 * client chooses the exact V1/V2 wire envelope and the Host revalidates it.
 */
export function createProtocolProxyTool<TAuthority extends ProgramAttemptAuthorityAny = ProgramAttemptAuthorityV1>(
  options: ProxyToolOptions<TAuthority>,
): AgentTool<Record<string, unknown>, unknown> {
  const programAttemptAuthority = options.programAttemptAuthority === undefined
    ? undefined
    : structuredClone(options.programAttemptAuthority);
  return {
    name: options.name,
    description: options.description ?? `Request Host-owned ${options.name} capability or cognition operation.`,
    inputSchema: structuredClone(options.inputSchema ?? { type: "object", properties: {} }),
    ...(options.isReadOnly !== undefined ? { isReadOnly: options.isReadOnly } : {}),
    async execute(input, context): Promise<AgentToolResult<unknown>> {
      const request = {
        sessionId: options.sessionId(),
        toolCallId: context.toolCallId ?? randomUUID(),
        toolName: options.name,
        args: input,
        ...(options.expectedCapabilityRevision !== undefined
          ? { expectedCapabilityRevision: options.expectedCapabilityRevision }
          : {}),
        ...(programAttemptAuthority !== undefined
          ? { programAttemptAuthority: structuredClone(programAttemptAuthority) }
          : {}),
      };
      const requestCapability = options.client.requestCapability.bind(options.client) as (
        request: CognitionCapabilityRequestV2Aware,
      ) => Promise<CapabilityResult>;
      const response = await requestCapability(request);
      const text = response.error ?? JSON.stringify(response.result ?? null);
      const executionOutcome = response.outcome === "denied" || response.outcome === "stale"
        ? "failed"
        : response.outcome;
      return {
        content: [{ type: "text", text }],
        details: response.result ?? {
          error: response.error ?? null,
          ...(response.errorCode !== undefined ? { errorCode: response.errorCode } : {}),
        },
        executionOutcome,
      };
    },
  };
}

// Compile-time compatibility witnesses: ordinary cognition remains V1 while
// the explicit adaptive path can supply a V2-aware client.
const _legacyClientCompatibility: Pick<CognitionHostClient, "requestCapability"> | undefined = undefined;
const _v2ClientCompatibility: Pick<CognitionHostClientV2Aware, "requestCapability"> | undefined = undefined;
void _legacyClientCompatibility;
void _v2ClientCompatibility;
