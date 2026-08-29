import {
  DYNAMIC_CAPABILITY_BINDING_CAPABILITY,
  GRAPH_CONTEXT_CAPABILITY,
  PROGRAM_EXECUTION_V2_CAPABILITY,
  PROGRAM_EXECUTION_V2_MESSAGE_VERSION,
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
  type ProgramProgressResultV2,
  type ProtocolTransport,
} from "@alcode/agent-protocol";
import { digestOf } from "@alcode/context";
import { uuidv7, type SessionId } from "@alcode/events";
import type { AgentConnection } from "./agent-supervisor.ts";
import type { CapabilityBrokerRequest, CapabilityBrokerResult } from "./capability-broker.ts";
import { COGNITION_TOOL_NAMES } from "./cognition-service.ts";
import type {
  AgentResumeReason,
  AttachedAgent,
  HostRuntime,
} from "./host.ts";
import type { ProgramAdaptiveExecutionControlV2 } from "./program-adaptive-control-v2.ts";
import type { ProgramAdaptiveSessionRoutingAuthorityV1 } from "./program-adaptive-session-classifier-v1.ts";
import {
  ProgramAgentServiceV2,
  ProgramAgentV2ControlError,
  type ProgramAgentServiceV2Options,
} from "./program-agent-v2.ts";
import type { ProgramExecutionRuntimeV1 } from "./program-execution-runtime.ts";
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

function progressFailure(
  message: { requestId: string; sessionId: string },
): ProgramProgressResultV2 {
  return {
    type: "program.progress.result",
    version: PROGRAM_EXECUTION_V2_MESSAGE_VERSION,
    requestId: message.requestId,
    sessionId: message.sessionId,
    outcome: "failed",
    errorCode: "adaptive_runtime_failure",
    error: "Adaptive Program progress routing failed",
  };
}

export interface ProgramExecutionRuntimeOptionsV2 {
  /**
   * The already-composed production V1 runtime is the compatibility and
   * operational-authority foundation. A1 layers adaptive routing around this
   * exact Host instead of creating a second or reduced Host authority graph.
   */
  fixedTopology: ProgramExecutionRuntimeV1;
  adaptive: ProgramAgentServiceV2Options;
  /** Host-owned semantic eligibility/Completion control for adaptive Programs. */
  control: ProgramAdaptiveExecutionControlV2;
  /** Canonical route selection and routing action share one Workspace-exclusive cut. */
  routing: ProgramAdaptiveSessionRoutingAuthorityV1;
}

/**
 * Operational A1 adapter. Fixed-topology Programs retain the production V1
 * runtime exactly; adaptive Programs delegate semantic eligibility and terminal
 * closure to the frozen Host control without pulling product integration into
 * this slice.
 */
export class ProgramExecutionRuntimeV2 {
  readonly fixedTopology: ProgramExecutionRuntimeV1;
  readonly host: HostRuntime;
  readonly agent: ProgramAgentServiceV2;
  private readonly control: ProgramAdaptiveExecutionControlV2;
  private readonly routing: ProgramAdaptiveSessionRoutingAuthorityV1;
  private readonly contextCache = new Map<string, ContextUpdateV2>();

  constructor(options: ProgramExecutionRuntimeOptionsV2) {
    this.fixedTopology = options.fixedTopology;
    this.host = this.fixedTopology.host;
    this.control = options.control;
    this.routing = options.routing;
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

  private clearContextCacheForGeneration(generationId: string): void {
    for (const key of [...this.contextCache.keys()]) {
      if (key.startsWith(`${generationId}:`)) this.contextCache.delete(key);
    }
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
    const sessionId = String(session.sessionId);
    return this.routing.withClassification(sessionId, async (classification) => {
      if (classification.mode !== "adaptive") {
        // Preserve the complete production V1 Program execution path: planning,
        // progress, idle/Completion, scheduler, recovery, and dispatch authority.
        return this.fixedTopology.attachAgent(connection, session, systemPrompt, resumeReason);
      }

      const capabilities = connection.capabilities ?? [];
      if (!capabilities.includes(PROGRAM_STATE_V2_CAPABILITY)
          || !capabilities.includes(PROGRAM_EXECUTION_V2_CAPABILITY)) {
        throw new Error(
          `Adaptive Program execution requires ${PROGRAM_STATE_V2_CAPABILITY} and ${PROGRAM_EXECUTION_V2_CAPABILITY}`,
        );
      }

      const adaptiveTransport = this.v2Transport(connection);
      const displacedGenerationId = this.agent.attach({
        generationId: connection.generationId,
        sessionId,
        capabilities,
        transport: adaptiveTransport,
      });
      if (displacedGenerationId !== undefined) this.clearContextCacheForGeneration(displacedGenerationId);

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
        this.clearContextCacheForGeneration(connection.generationId);
        throw error;
      }

      const includeDynamic = capabilities.includes(DYNAMIC_CAPABILITY_BINDING_CAPABILITY);
      const graphContext = capabilities.includes(GRAPH_CONTEXT_CAPABILITY);
      const unsubscribe = adaptiveTransport.onMessage(async (message) => {
        try {
          if (message.type === "context.refresh.request") {
            if (message.sessionId !== sessionId) return;
            const cacheKey = `${connection.generationId}:${message.requestId}`;
            let update = this.contextCache.get(cacheKey);
            if (update === undefined) {
              const toolCatalog = this.toolCatalog(includeDynamic);
              const refreshed = await this.host.contextService.refresh({
                requestId: message.requestId,
                sessionId,
                baseSystemPrompt: systemPrompt,
                toolDefinitions: toolCatalog.tools.map((tool) => tool.definition),
                graphCapable: graphContext,
              });
              update = await this.agent.enrichContextUpdate(
                {
                  ...refreshed,
                  ...(includeDynamic ? { toolCatalog } : {}),
                },
                sessionId,
                connection.generationId,
              );
              this.contextCache.set(cacheKey, update);
            }
            try { await adaptiveTransport.send(update); } catch {}
            return;
          }

          if (message.type === "capability.request") {
            if (message.sessionId !== sessionId) return;
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
            if (message.sessionId !== sessionId) return;
            const response = await this.agent.handleProgress(message, connection.generationId);
            try { await adaptiveTransport.send(response); } catch {}
            return;
          }

          if (message.type === "agent.idle" && message.sessionId === sessionId) {
            // A displaced generation may still drain a buffered idle before its
            // process exits. It has no authority to schedule or complete work.
            if (!this.agent.isCurrentConnection(sessionId, connection.generationId)) return;
            const decision = await this.control.handleAgentIdle(sessionId);
            if (decision.status === "not_program") return;
            if (decision.terminal === "none") {
              if (decision.reason === "successor_dispatched") {
                try {
                  await this.agent.requestCurrentAttemptExecution(sessionId, connection.generationId);
                } catch {
                  // A successor is already canonical. If its directive cannot be
                  // delivered to the still-current generation, fail that process
                  // closed so normal replacement/recovery can replay the Attempt.
                  if (this.agent.isCurrentConnection(sessionId, connection.generationId)) {
                    connection.terminate();
                  }
                }
              }
              return;
            }

            const sessionState = await this.host.sessions.getState(session.sessionId);
            if (sessionState.started && !sessionState.stopped) {
              await this.host.sessions.stop(session.sessionId, decision.terminal);
            }
            try {
              await adaptiveTransport.send({
                type: "shutdown",
                requestId: uuidv7(),
                sessionId,
                reason: decision.terminal,
              });
            } catch {
              // Terminal Program/session truth is already durable. Ensure a failed
              // notification cannot leave the disposable Agent process orphaned.
            } finally {
              connection.terminate();
            }
            return;
          }
        } catch {
          // Protocol handlers are invoked fire-and-forget by the IPC transport.
          // Convert failures into bounded outcomes or fail the disposable Agent
          // generation closed so no rejection escapes the Host callback.
          if (message.type === "context.refresh.request" && message.sessionId === sessionId) {
            try {
              await adaptiveTransport.send({
                type: "cancel",
                requestId: message.requestId,
                sessionId,
                reason: "Adaptive context refresh failed",
              });
            } catch {}
            return;
          }
          if (message.type === "capability.request" && message.sessionId === sessionId) {
            try {
              await adaptiveTransport.send(capabilityResult(message, "failed", {
                errorCode: "adaptive_runtime_failure",
                error: "Adaptive Program capability routing failed",
              }));
            } catch {}
            return;
          }
          if (message.type === "program.progress"
              && isProgramProgressProposalV2(message)
              && message.sessionId === sessionId) {
            try { await adaptiveTransport.send(progressFailure(message)); } catch {}
            return;
          }
          if (message.type === "agent.idle" && message.sessionId === sessionId) {
            if (this.agent.isCurrentConnection(sessionId, connection.generationId)) {
              connection.terminate();
            }
          }
        }
      });

      let adaptiveDetached = false;
      const detachAdaptiveGeneration = (): void => {
        if (adaptiveDetached) return;
        adaptiveDetached = true;
        unsubscribe();
        this.agent.detach(connection.generationId);
        this.clearContextCacheForGeneration(connection.generationId);
      };
      void connection.waitForExit().then(
        () => detachAdaptiveGeneration(),
        () => detachAdaptiveGeneration(),
      );

      return {
        generationId: attached.generationId,
        detach: () => {
          detachAdaptiveGeneration();
          attached.detach();
        },
      };
    });
  }

  async requestCurrentAttemptExecution(
    connection: AgentConnection,
    session: HostSessionHandle,
  ) {
    const sessionId = String(session.sessionId);
    return this.routing.withClassification(sessionId, async (classification) => {
      if (classification.mode !== "adaptive") {
        return this.fixedTopology.requestCurrentAttemptExecution(connection, session);
      }
      // Mirror the V1 runtime's generation-currentness guard before any Host
      // scheduler/admission call. A displaced caller cannot create a successor.
      if (!this.agent.isCurrentConnection(sessionId, connection.generationId)) {
        throw new ProgramAgentV2ControlError("Adaptive Program execution connection is not current");
      }
      const scheduled = await this.control.ensureCurrentAttempt(sessionId);
      if (scheduled.status !== "issued" && scheduled.status !== "already_started") return undefined;
      return this.agent.requestCurrentAttemptExecution(sessionId, connection.generationId);
    });
  }
}

export function createProgramExecutionRuntimeV2(
  options: ProgramExecutionRuntimeOptionsV2,
): ProgramExecutionRuntimeV2 {
  return new ProgramExecutionRuntimeV2(options);
}
