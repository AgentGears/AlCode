import {
  PROTOCOL_VERSION,
  RequestError,
  agent,
  methods,
  type AgentApp,
  type AgentContext,
  type ContentBlock,
  type PermissionOption,
  type StopReason,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk";

export type AcpPermissionDecision = "allow_once" | "allow_always" | "deny";

export interface AcpPermissionRequest {
  sessionId: string;
  toolCallId: string;
  title: string;
  reason: string;
}

export interface AcpPromptContext {
  signal: AbortSignal;
  emitAssistantText(text: string): Promise<void>;
  requestPermission(request: AcpPermissionRequest): Promise<AcpPermissionDecision>;
}

export interface AcpHostFacade {
  newSession(input: { cwd: string }): Promise<{ sessionId: string }>;
  resumeSession(input: { sessionId: string; cwd: string }): Promise<void>;
  prompt(input: { sessionId: string; text: string }, context: AcpPromptContext): Promise<{ stopReason: StopReason }>;
  cancelSession(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
}

export class AcpAdapterError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "AcpAdapterError";
  }
}

function assertNoClientConfiguration(params: { mcpServers?: readonly unknown[]; additionalDirectories?: readonly string[] | null }): void {
  if ((params.mcpServers?.length ?? 0) > 0) {
    throw RequestError.invalidParams(undefined, "unsupported_mcp_servers: ALCODE owns MCP configuration");
  }
  if ((params.additionalDirectories?.length ?? 0) > 0) {
    throw RequestError.invalidParams(undefined, "unsupported_additional_directories: ALCODE owns workspace roots");
  }
}

function textPrompt(blocks: readonly ContentBlock[]): string {
  const text: string[] = [];
  for (const block of blocks) {
    if (block.type !== "text") throw new AcpAdapterError("unsupported_prompt_content", `ACP content block ${block.type} is not supported by the Phase 0.9 adapter`);
    text.push(block.text);
  }
  return text.join("\n");
}

function permissionOptions(): PermissionOption[] {
  return [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ];
}

async function requestPermission(client: AgentContext, request: AcpPermissionRequest): Promise<AcpPermissionDecision> {
  const toolCall: ToolCallUpdate = {
    toolCallId: request.toolCallId,
    title: request.title,
    status: "pending",
    kind: "other",
    rawInput: { reason: request.reason },
  };
  let response;
  try {
    response = await client.request(methods.client.session.requestPermission, {
      sessionId: request.sessionId,
      toolCall,
      options: permissionOptions(),
    });
  } catch (error) {
    throw new AcpAdapterError("permission_unavailable", error instanceof Error ? error.message : String(error));
  }
  if (response.outcome.outcome === "cancelled") return "deny";
  switch (response.outcome.optionId) {
    case "allow_once": return "allow_once";
    case "allow_always": return "allow_always";
    default: return "deny";
  }
}

export function createAlcodeAcpApp(facade: AcpHostFacade): AgentApp {
  return agent({ name: "alcode" })
    .onRequest(methods.agent.initialize, (ctx) => ({
      protocolVersion: ctx.params.protocolVersion === PROTOCOL_VERSION ? PROTOCOL_VERSION : PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {},
        sessionCapabilities: { resume: {}, close: {} },
      },
      authMethods: [],
    }))
    .onRequest(methods.agent.session.new, async (ctx) => {
      assertNoClientConfiguration(ctx.params);
      const session = await facade.newSession({ cwd: ctx.params.cwd });
      return { sessionId: session.sessionId };
    })
    .onRequest(methods.agent.session.resume, async (ctx) => {
      assertNoClientConfiguration(ctx.params);
      await facade.resumeSession({ sessionId: ctx.params.sessionId, cwd: ctx.params.cwd });
      return {};
    })
    .onRequest(methods.agent.session.close, async (ctx) => {
      await facade.closeSession(ctx.params.sessionId);
      return {};
    })
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      const text = textPrompt(ctx.params.prompt);
      try {
        return await facade.prompt(
          { sessionId: ctx.params.sessionId, text },
          {
            signal: ctx.signal,
            emitAssistantText: async (chunk) => {
              await ctx.client.notify(methods.client.session.update, {
                sessionId: ctx.params.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: chunk },
                },
              });
            },
            requestPermission: (request) => requestPermission(ctx.client, request),
          },
        );
      } catch (error) {
        if (error instanceof AcpAdapterError) throw error;
        if (ctx.signal.aborted) return { stopReason: "cancelled" as const };
        throw error;
      }
    })
    .onNotification(methods.agent.session.cancel, async (ctx) => {
      await facade.cancelSession(ctx.params.sessionId);
    });
}
