import {
  asWorkspaceId,
  mkEventId,
  uuidv7,
  type SessionId,
} from "@alcode/events";
import {
  type AgentToHostMessage,
  type CapabilityResult,
  type HostToAgentMessage,
  type ProtocolTransport,
} from "@alcode/agent-protocol";
import {
  createOperationsProjection,
  createTranscriptProjection,
  type LockedWorkspaceStore,
} from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { type AgentConnection } from "./agent-supervisor.ts";
import { CapabilityBroker, type HostCapability } from "./capability-broker.ts";
import { CognitionGateway } from "./cognition-gateway.ts";
import { COGNITION_TOOL_NAMES, HostCognitionService } from "./cognition-service.ts";
import { DefaultHostPolicy, type HostPolicy } from "./policy.ts";
import { HostSessionManager, type HostSessionHandle } from "./session-manager.ts";
import { DurableWorkDispatcher } from "./work-dispatcher.ts";

export interface HostRuntimeOptions {
  store: LockedWorkspaceStore;
  capabilities: readonly HostCapability[];
  policy?: HostPolicy;
  hostInstanceId?: string;
}

export interface AttachedAgent {
  generationId: string;
  detach(): void;
}

export class HostRuntime {
  readonly admission: CanonicalAdmissionQueue;
  readonly cognitionGateway: CognitionGateway;
  readonly workDispatcher: DurableWorkDispatcher;
  readonly sessions: HostSessionManager;
  readonly cognition: HostCognitionService;
  readonly capabilityBroker: CapabilityBroker;

  private readonly store: LockedWorkspaceStore;
  private readonly hostInstanceId: string;
  private readonly capabilityNames: string[];
  private readonly requestCache = new Map<string, CapabilityResult>();

  constructor(options: HostRuntimeOptions) {
    this.store = options.store;
    this.hostInstanceId = options.hostInstanceId ?? uuidv7();
    this.capabilityNames = options.capabilities.map((capability) => capability.name);
    this.admission = new CanonicalAdmissionQueue(options.store.store);
    this.cognitionGateway = new CognitionGateway(options.store);
    this.workDispatcher = new DurableWorkDispatcher(options.store.store, this.admission);
    this.sessions = new HostSessionManager(options.store);
    this.cognition = new HostCognitionService(options.store.store, this.admission, this.cognitionGateway, this.workDispatcher);
    this.capabilityBroker = new CapabilityBroker(
      options.store.store,
      this.admission,
      this.cognitionGateway,
      options.policy ?? new DefaultHostPolicy({ knownTools: this.capabilityNames }),
      options.capabilities,
    );
  }

  async startup(): Promise<{ pendingOperationIds: string[]; interruptedWork: number }> {
    const recovery = await this.store.store.recoverInterruptedOperations();
    const interruptedWork = await this.workDispatcher.recoverInterruptedWork();
    this.cognitionGateway.catchUpCognition();
    return { pendingOperationIds: recovery.pendingOperationIds, interruptedWork };
  }

  openOrResumeSession(sessionId?: SessionId): Promise<HostSessionHandle> {
    return this.sessions.openOrResume(sessionId);
  }

  async admitInput(sessionId: SessionId, text: string): Promise<void> {
    await this.admission.append([{
      eventId: mkEventId(),
      workspaceId: asWorkspaceId(this.store.store.workspaceId),
      sessionId,
      occurredAt: new Date().toISOString(),
      type: "user.message.appended",
      payload: { text },
      payloadSchemaVersion: 1,
      producer: { kind: "user" },
    }]);
    this.catchUpCritical();
  }

  async attachAgent(
    connection: AgentConnection,
    session: HostSessionHandle,
    systemPrompt: string,
  ): Promise<AttachedAgent> {
    const transport = connection.transport;
    await transport.send({
      type: "host.hello",
      protocolVersion: 1,
      hostInstanceId: this.hostInstanceId,
    });
    const sessionRequestId = uuidv7();
    if (session.resumed) {
      await transport.send({
        type: "session.resume",
        requestId: sessionRequestId,
        sessionId: session.sessionId as string,
        workspaceId: this.store.store.workspaceId,
        reason: "reattach",
      });
    } else {
      await transport.send({
        type: "session.open",
        requestId: sessionRequestId,
        sessionId: session.sessionId as string,
        workspaceId: this.store.store.workspaceId,
      });
    }
    await transport.send({
      type: "context.provide",
      requestId: uuidv7(),
      sessionId: session.sessionId as string,
      systemPrompt,
      orientationRequired: session.resumed,
      toolNames: [...COGNITION_TOOL_NAMES, ...this.capabilityNames],
    });

    const unsubscribe = transport.onMessage((message) => this.handleAgentMessage(connection.generationId, transport, session.sessionId, message));
    return { generationId: connection.generationId, detach: unsubscribe };
  }

  async sendInput(
    transport: ProtocolTransport<HostToAgentMessage, AgentToHostMessage>,
    sessionId: SessionId,
    text: string,
  ): Promise<void> {
    await this.admitInput(sessionId, text);
    await transport.send({
      type: "input.admitted",
      requestId: uuidv7(),
      sessionId: sessionId as string,
      text,
    });
  }

  async assessAndComplete(sessionId: SessionId, agentIdle: boolean): Promise<{ completed: boolean; reasons: string[] }> {
    const snapshot = await this.cognitionGateway.snapshot(sessionId as string);
    const assessment = this.cognitionGateway.coordinator.assessCompletion(snapshot, agentIdle);
    if (!assessment.allowed) return { completed: false, reasons: assessment.blockingReasons };
    await this.sessions.stop(sessionId, "completed", {
      sourceEventSequence: snapshot.sourceEventSequence,
      blockingFindingIds: assessment.blockingFindingIds,
    });
    return { completed: true, reasons: [] };
  }

  async shutdown(): Promise<void> {
    this.store.close();
  }

  private async handleAgentMessage(
    generationId: string,
    transport: ProtocolTransport<HostToAgentMessage, AgentToHostMessage>,
    sessionId: SessionId,
    message: AgentToHostMessage,
  ): Promise<void> {
    switch (message.type) {
      case "assistant.message":
        if (message.sessionId !== (sessionId as string)) throw new Error("Agent session mismatch");
        await this.admission.append([{
          eventId: mkEventId(),
          workspaceId: asWorkspaceId(this.store.store.workspaceId),
          sessionId,
          occurredAt: new Date().toISOString(),
          type: "assistant.message.appended",
          payload: { text: message.text },
          payloadSchemaVersion: 1,
          producer: { kind: "model", provider: `agent:${generationId}` },
        }]);
        this.catchUpCritical();
        break;

      case "capability.request": {
        if (message.sessionId !== (sessionId as string)) throw new Error("Agent session mismatch");
        const cacheKey = `${generationId}:${message.requestId}`;
        let response = this.requestCache.get(cacheKey);
        if (!response) {
          if (COGNITION_TOOL_NAMES.has(message.toolName)) {
            try {
              const result = await this.cognition.invoke(sessionId, message.toolName, message.args);
              response = {
                type: "capability.result",
                requestId: message.requestId,
                sessionId: sessionId as string,
                toolCallId: message.toolCallId,
                toolName: message.toolName,
                outcome: "succeeded",
                result,
              };
            } catch (error) {
              response = {
                type: "capability.result",
                requestId: message.requestId,
                sessionId: sessionId as string,
                toolCallId: message.toolCallId,
                toolName: message.toolName,
                outcome: "failed",
                error: error instanceof Error ? error.message : String(error),
              };
            }
          } else {
            const result = await this.capabilityBroker.execute({
              sessionId,
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              args: message.args,
            });
            response = {
              type: "capability.result",
              requestId: message.requestId,
              sessionId: sessionId as string,
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              ...(result.operationId ? { operationId: result.operationId as string } : {}),
              outcome: result.outcome,
              ...(result.result !== undefined ? { result: result.result } : {}),
              ...(result.error !== undefined ? { error: result.error } : {}),
            };
          }
          this.requestCache.set(cacheKey, response);
        }
        await transport.send(response);
        break;
      }

      case "criterion.evidence":
        await this.admission.append([{
          eventId: mkEventId(),
          workspaceId: asWorkspaceId(this.store.store.workspaceId),
          sessionId,
          occurredAt: new Date().toISOString(),
          type: "runtime.criterion.evidence",
          payload: { evidenceType: message.evidenceType, data: message.data ?? null, generationId },
          payloadSchemaVersion: 1,
          producer: { kind: "runtime", component: `agent:${generationId}` },
        }]);
        break;

      case "agent.idle": {
        const completion = await this.assessAndComplete(sessionId, true);
        if (completion.completed) {
          await transport.send({ type: "shutdown", requestId: uuidv7(), sessionId: sessionId as string, reason: "completed" });
        }
        break;
      }

      case "agent.error":
        await this.admission.append([{
          eventId: mkEventId(),
          workspaceId: asWorkspaceId(this.store.store.workspaceId),
          sessionId,
          occurredAt: new Date().toISOString(),
          type: "runtime.agent.error",
          payload: { message: message.message, generationId },
          payloadSchemaVersion: 1,
          producer: { kind: "runtime", component: `agent:${generationId}` },
        }]);
        break;

      case "agent.hello":
        break;
    }
  }

  private catchUpCritical(): void {
    const runner = this.store.store.getProjectionRunner();
    runner.catchUp(createTranscriptProjection(this.store.store.workspaceId));
    runner.catchUp(createOperationsProjection(this.store.store.workspaceId));
  }
}
