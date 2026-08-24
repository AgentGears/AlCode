import {
  DYNAMIC_CAPABILITY_BINDING_CAPABILITY,
  GRAPH_CONTEXT_CAPABILITY,
  PROGRAM_EXECUTION_V2_CAPABILITY,
  PROGRAM_STATE_V2_CAPABILITY,
  isProgramAttemptAuthorityV2,
  isProgramProgressProposalV2,
  type AgentToHostMessageV2Aware,
  type AuthorizedToolDescriptor,
  type CapabilityRequestV2,
  type CapabilityResult,
  type ContextUpdateV2,
  type HostToAgentMessageV2Aware,
  type InferenceToolCatalog,
  type ProtocolTransport,
} from "@alcode/agent-protocol";
import { digestOf } from "@alcode/context";
import type { SessionId } from "@alcode/events";
import type { AgentConnection } from "./agent-supervisor.ts";
import type { CapabilityBrokerRequest, CapabilityBrokerResult } from "./capability-broker.ts";
import { COGNITION_TOOL_NAMES } from "./cognition-service.ts";
import {
  HostRuntime,
  type AgentResumeReason,
  type AttachedAgent,
  type HostRuntimeOptions,
} from "./host.ts";
import {
  ProgramAgentServiceV2,
  type ProgramAgentServiceV2Options,
} from "./program-agent-v2.ts";
import type { HostSessionHandle } from "./session-manager.ts";

function cognitionDescriptors(): AuthorizedToolDescriptor[] {
  return [...COGNITION_TOOL_NAMES]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map((name) => ({
      definition: {
        name,
        description: `Request Host-owned ${name} capability or cognition operation.`,
        inputSchema: { type: "object", properties: {} },
      },
      binding: { kind: "static" as const },
      isReadOnly: false,
    }));
}

function capabilityResult(
  message: { requestId: string; sessionId: string; toolCallId: string; toolName: string },
  outcome: CapabilityResult["outcome"],
  extras: { operationId?: string; result?: unknown; errorCode?: string; error?: string } = {},
): CapabilityResult {
  return {
    type: "capability.result",
    requestId: message.requestId,
    sessionId: message.sessionId,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    outcome,
    ...extras,
  };
}

function brokerResult(
  message: CapabilityRequestV2,
  result: CapabilityBrokerResult,
): CapabilityResult {
  return capabilityResult(message, result.outcome, {
    ...(result.operationId !== undefined ? { operationId: String(result.operationId) } : {}),
    ...(result.result !== undefined ? { result: result.result } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
  });
}

export interface ProgramExecutionRuntimeOptionsV2 {
  host: HostRuntimeOptions;
  adaptive: ProgramAgentServiceV2Options;
}

/**
 * Operational A1 adapter. It deliberately does not own adaptive Completion,
 * eligibility, semantic baseline adoption, or scheduler policy.
 */
export class ProgramExecutionRuntimeV2 {
  readonly host: HostRuntime;
  readonly agent: ProgramAgentServiceV2;
  private readonly contextCache = new Map<string, ContextUpdateV2>();

  constructor(options: ProgramExecutionRuntimeOptionsV2) {
    this.host = new HostRuntime(options.host);
    this.agent = new ProgramAgentServiceV2(options.adaptive);
  }

  private toolCatalog(includeDynamic: boolean): InferenceToolCatalog {
    const tools = [...cognitionDescriptors(), ...this.host.capabilityBroker.describeCapabilities(includeDynamic)]
      .sort((left, right) => left.definition.name < right.definition.name
        ? -1
        : left.definition.name > right.definition.name ? 1 : 0);
    for (let index = 1; index < tools.length; index++) {
      if (tools[index - 1]?.definition.name === tools[index]?.definition.name) {
        throw new Error(`duplicate effective capability: ${tools[index]!.definition.name}`);
      }
    }
    const definitions = tools.map((tool) => structuredClone(tool.definition));
    return { digest: digestOf(definitions), tools };
  }

  private v2Transport(
    connection: AgentConnection,
  ): ProtocolTransport<HostToAgentMessageV2Aware, AgentToHostMessageV2Aware> {
    return connection.transport as unknown as ProtocolTransport<HostToAgentMessageV2Aware, AgentToHostMessageV2Aware>;
  }

  /** Keep authority-bearing adaptive messages out of the legacy V1 Host handler. */
  private hostConnectionWithoutAdaptiveAuthorityMessages(connection: AgentConnection): AgentConnection {
    const transport = connection.transport;
    return {
      ...connection,
      transport: {
        send: (message) => transport.send(message),
        onMessage: (handler) => transport.onMessage((message) => {
          if (message.type === "context.refresh.request"
              || message.type === "capability.request"
              || message.type === "agent.idle") return;
          if (message.type === "program.progress" && (message as { version?: number }).version === 2) return;
          return handler(message);
        }),
        close: () => transport.close(),
      },
    };
  }

  async attachAgent(
    connection: AgentConnection,
    session: HostSessionHandle,
    systemPrompt: string,
    resumeReason: AgentResumeReason = "reattach",
  ): Promise<AttachedAgent> {
    const capabilities = connection.capabilities ?? [];
    if (!capabilities.includes(PROGRAM_STATE_V2_CAPABILITY)
        || !capabilities.includes(PROGRAM_EXECUTION_V2_CAPABILITY)) {
      throw new Error(
        `Adaptive Program execution requires ${PROGRAM_STATE_V2_CAPABILITY} and ${PROGRAM_EXECUTION_V2_CAPABILITY}`,
      );
    }

    const adaptiveTransport = this.v2Transport(connection);
    this.agent.attach({
      generationId: connection.generationId,
      sessionId: String(session.sessionId),
      capabilities,
      transport: adaptiveTransport,
    });

    let attached: AttachedAgent;
    try {
      attached = await this.host.attachAgent(
        this.hostConnectionWithoutAdaptiveAuthorityMessages(connection),
        session,
        systemPrompt,
        resumeReason,
      );
    } catch (error) {
      this.agent.detach(connection.generationId);
      throw error;
    }

    const includeDynamic = capabilities.includes(DYNAMIC_CAPABILITY_BINDING_CAPABILITY);
    const graphContext = capabilities.includes(GRAPH_CONTEXT_CAPABILITY);
    const unsubscribe = adaptiveTransport.onMessage(async (message) => {
      if (message.type === "context.refresh.request") {
        if (message.sessionId !== String(session.sessionId)) return;
        const cacheKey = `${connection.generationId}:${message.requestId}`;
        let update = this.contextCache.get(cacheKey);
        if (update === undefined) {
          const toolCatalog = this.toolCatalog(includeDynamic);
          const refreshed = await this.host.contextService.refresh({
            requestId: message.requestId,
            sessionId: String(session.sessionId),
            baseSystemPrompt: systemPrompt,
            toolDefinitions: toolCatalog.tools.map((tool) => tool.definition),
            graphCapable: graphContext,
          });
          update = await this.agent.enrichContextUpdate(
            {
              ...refreshed,
              ...(includeDynamic ? { toolCatalog } : {}),
            },
            String(session.sessionId),
            connection.generationId,
          );
          this.contextCache.set(cacheKey, update);
        }
        try { await adaptiveTransport.send(update); } catch {}
        return;
      }

      if (message.type === "capability.request") {
        if (message.sessionId !== String(session.sessionId)) return;
        if (!isProgramAttemptAuthorityV2(message.programAttemptAuthority)) {
          try {
            await adaptiveTransport.send(capabilityResult(
              message,
              "stale",
              {
                errorCode: "program_execution_v2_authority_required",
                error: "Adaptive Program capability requests require ProgramAttemptAuthorityV2",
              },
            ));
          } catch {}
          return;
        }
        const request = message as CapabilityRequestV2;
        const response = await this.agent.handleCapability(
          {
            message: request,
            generationId: connection.generationId,
            sessionId: session.sessionId as SessionId,
          },
          async (prepared: CapabilityBrokerRequest): Promise<CapabilityResult> => {
            if (COGNITION_TOOL_NAMES.has(request.toolName)) {
              if (request.expectedCapabilityRevision !== undefined) {
                return capabilityResult(request, "stale", {
                  errorCode: "capability_stale",
                  error: "capability binding no longer matches; refresh before retry",
                });
              }
              try {
                const result = await this.host.cognition.invoke(session.sessionId, request.toolName, request.args);
                return capabilityResult(request, "succeeded", { result });
              } catch (error) {
                return capabilityResult(request, "failed", {
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
            return brokerResult(request, await this.host.capabilityBroker.execute(prepared));
          },
        );
        try { await adaptiveTransport.send(response); } catch {}
        return;
      }

      if (message.type === "program.progress" && isProgramProgressProposalV2(message)) {
        if (message.sessionId !== String(session.sessionId)) return;
        const response = await this.agent.handleProgress(message, connection.generationId);
        try { await adaptiveTransport.send(response); } catch {}
        return;
      }

      if (message.type === "agent.idle" && message.sessionId === String(session.sessionId)) {
        // A1 adaptive Completion is intentionally not implemented in this slice.
        // Swallow adaptive idle so the legacy Completion Oracle cannot decide it.
        return;
      }
    });

    return {
      generationId: attached.generationId,
      detach: () => {
        unsubscribe();
        this.agent.detach(connection.generationId);
        for (const key of [...this.contextCache.keys()]) {
          if (key.startsWith(`${connection.generationId}:`)) this.contextCache.delete(key);
        }
        attached.detach();
      },
    };
  }

  requestCurrentAttemptExecution(
    connection: AgentConnection,
    session: HostSessionHandle,
  ) {
    return this.agent.requestCurrentAttemptExecution(String(session.sessionId), connection.generationId);
  }
}

export function createProgramExecutionRuntimeV2(
  options: ProgramExecutionRuntimeOptionsV2,
): ProgramExecutionRuntimeV2 {
  return new ProgramExecutionRuntimeV2(options);
}
