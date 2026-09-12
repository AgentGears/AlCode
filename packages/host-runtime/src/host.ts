import {
  asWorkspaceId,
  mkEventId,
  uuidv7,
  type SessionId,
} from "@alcode/events";
import {
  DYNAMIC_CAPABILITY_BINDING_CAPABILITY,
  DURABLE_TRANSCRIPT_CAPABILITY,
  GRAPH_CONTEXT_CAPABILITY,
  INFERENCE_PROVENANCE_CAPABILITY,
  PROGRAM_EXECUTION_CAPABILITY,
  PROGRAM_STATE_CAPABILITY,
  type AgentToHostMessage,
  type AuthorizedToolDescriptor,
  type CapabilityResult,
  type ContextUpdate,
  type HostToAgentMessage,
  type InferenceToolCatalog,
  type ProgramAttemptAuthorityV1,
  type ProtocolTransport,
} from "@alcode/agent-protocol";
import { digestOf } from "@alcode/context";
import {
  createOperationsProjection,
  createTranscriptProjection,
  createWorkspaceReadModels,
  type LockedWorkspaceStore,
} from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { type AgentConnection } from "./agent-supervisor.ts";
import { CapabilityBroker, type HostCapability } from "./capability-broker.ts";
import { CognitionGateway } from "./cognition-gateway.ts";
import { COGNITION_TOOL_NAMES, HostCognitionService } from "./cognition-service.ts";
import { HostContextService, type HostContextServiceOptions } from "./context-service.ts";
import { HostContextSourceReader } from "./context-source.ts";
import { InferenceProvenanceServiceV1 } from "./inference-provenance.ts";
import { DefaultHostPolicy, type HostPolicy } from "./policy.ts";
import { ProgramAgentServiceV1 } from "./program-agent.ts";
import type { ProgramRootOperationAuthorityV1 } from "./program-dispatch.ts";
import type { Phase1RecoveryLifecycleV1 } from "./program-recovery.ts";
import { HostSessionManager, type HostSessionHandle } from "./session-manager.ts";
import { TranscriptAdmissionService } from "./transcript-admission.ts";
import { assertContextContinuable, compileVerbatimContext } from "./verbatim-context.ts";
import { DurableWorkDispatcher } from "./work-dispatcher.ts";

export interface HostRuntimeOptions {
  store: LockedWorkspaceStore;
  capabilities: readonly HostCapability[];
  policy?: HostPolicy;
  hostInstanceId?: string;
  context?: HostContextServiceOptions;
}

export interface AttachedAgent {
  generationId: string;
  detach(): void;
}

export type AgentResumeReason = "agent_replaced" | "host_reopened" | "reattach";

function sameProgramAttemptAuthority(
  left: ProgramAttemptAuthorityV1,
  right: ProgramAttemptAuthorityV1,
): boolean {
  return left.programStateId === right.programStateId
    && left.expectedProgramRevision === right.expectedProgramRevision
    && left.programAttemptId === right.programAttemptId
    && left.workItemId === right.workItemId
    && left.agentGeneration === right.agentGeneration;
}

function cognitionDescriptors(): AuthorizedToolDescriptor[] {
  return [...COGNITION_TOOL_NAMES]
    .sort((a, b) => a.localeCompare(b, "en"))
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

export class HostRuntime {
  readonly admission: CanonicalAdmissionQueue;
  readonly programAgents: ProgramAgentServiceV1;
  readonly cognitionGateway: CognitionGateway;
  readonly workDispatcher: DurableWorkDispatcher;
  readonly sessions: HostSessionManager;
  readonly cognition: HostCognitionService;
  readonly capabilityBroker: CapabilityBroker;
  readonly transcriptAdmission: TranscriptAdmissionService;
  readonly contextSource: HostContextSourceReader;
  readonly contextService: HostContextService;
  readonly inferenceProvenance: InferenceProvenanceServiceV1;

  private readonly store: LockedWorkspaceStore;
  private readonly hostInstanceId: string;
  private readonly requestCache = new Map<string, CapabilityResult>();
  private readonly contextRequestCache = new Map<string, ContextUpdate>();
  private phase1Recovery: Phase1RecoveryLifecycleV1 | undefined;

  constructor(options: HostRuntimeOptions) {
    this.store = options.store;
    this.hostInstanceId = options.hostInstanceId ?? uuidv7();
    this.admission = new CanonicalAdmissionQueue(options.store.store);
    this.programAgents = new ProgramAgentServiceV1(options.store.store, this.admission);
    this.cognitionGateway = new CognitionGateway(options.store);
    this.workDispatcher = new DurableWorkDispatcher(options.store.store, this.admission);
    this.sessions = new HostSessionManager(options.store, this.admission);
    this.cognition = new HostCognitionService(options.store.store, this.admission, this.cognitionGateway, this.workDispatcher);
    this.inferenceProvenance = new InferenceProvenanceServiceV1(options.store.store, this.admission);
    this.transcriptAdmission = new TranscriptAdmissionService(options.store.store, this.admission);
    this.contextSource = new HostContextSourceReader(options.store);
    this.contextService = new HostContextService(
      options.store.store.workspaceId,
      this.contextSource,
      this.admission,
      options.context,
    );
    this.capabilityBroker = new CapabilityBroker(
      options.store.store,
      this.admission,
      this.cognitionGateway,
      options.policy ?? new DefaultHostPolicy(),
      options.capabilities,
    );
  }

  private inferenceToolCatalog(includeDynamic: boolean): InferenceToolCatalog {
    const tools = [...cognitionDescriptors(), ...this.capabilityBroker.describeCapabilities(includeDynamic)]
      .sort((a, b) => a.definition.name.localeCompare(b.definition.name, "en"));
    for (let i = 1; i < tools.length; i++) {
      if (tools[i - 1]?.definition.name === tools[i]?.definition.name) {
        throw new Error(`duplicate effective capability: ${tools[i]!.definition.name}`);
      }
    }
    const definitions = tools.map((tool) => structuredClone(tool.definition));
    return { digest: digestOf(definitions), tools };
  }

  async startup(): Promise<{ pendingOperationIds: string[]; interruptedWork: number }> {
    const recovery = await this.store.store.recoverInterruptedOperations();
    const interruptedWork = await this.workDispatcher.recoverInterruptedWork();
    if (this.phase1Recovery !== undefined) await this.phase1Recovery.recover();
    this.cognitionGateway.catchUpCognition();
    return { pendingOperationIds: recovery.pendingOperationIds, interruptedWork };
  }

  openOrResumeSession(sessionId?: SessionId): Promise<HostSessionHandle> {
    return this.sessions.openOrResume(sessionId);
  }

  setProgramOperationAuthority(authority: ProgramRootOperationAuthorityV1 | undefined): void {
    this.capabilityBroker.setProgramOperationAuthority(authority);
  }

  setPhase1RecoveryController(controller: Phase1RecoveryLifecycleV1 | undefined): void {
    this.phase1Recovery = controller;
    this.capabilityBroker.setWorkspaceMutationAdmissionAuthority(controller);
  }

  async admitInput(sessionId: SessionId, text: string): Promise<{ timestamp: number }> {
    const timestamp = Date.now();
    await this.admission.append([{
      eventId: mkEventId(),
      workspaceId: asWorkspaceId(this.store.store.workspaceId),
      sessionId,
      occurredAt: new Date(timestamp).toISOString(),
      type: "user.message.appended",
      payload: { text, timestamp },
      payloadSchemaVersion: 1,
      producer: { kind: "user" },
    }]);
    this.catchUpCritical();
    return { timestamp };
  }

  async attachAgent(
    connection: AgentConnection,
    session: HostSessionHandle,
    systemPrompt: string,
    resumeReason: AgentResumeReason = "reattach",
  ): Promise<AttachedAgent> {
    const durableTranscript = connection.capabilities?.includes(DURABLE_TRANSCRIPT_CAPABILITY) ?? false;
    const graphContext = connection.capabilities?.includes(GRAPH_CONTEXT_CAPABILITY) ?? false;
    const dynamicCapabilityBinding = connection.capabilities?.includes(DYNAMIC_CAPABILITY_BINDING_CAPABILITY) ?? false;
    const inferenceProvenanceCapable = connection.capabilities?.includes(INFERENCE_PROVENANCE_CAPABILITY) ?? false;
    const programStateCapable = connection.capabilities?.includes(PROGRAM_STATE_CAPABILITY) ?? false;
    const programExecutionCapable = connection.capabilities?.includes(PROGRAM_EXECUTION_CAPABILITY) ?? false;
    if (programExecutionCapable && !programStateCapable) {
      throw new Error(`${PROGRAM_EXECUTION_CAPABILITY} requires ${PROGRAM_STATE_CAPABILITY}`);
    }
    if (connection.capabilities !== undefined && !durableTranscript) {
      throw new Error(`Agent missing required capability: ${DURABLE_TRANSCRIPT_CAPABILITY}`);
    }

    if (resumeReason === "agent_replaced") {
      if (inferenceProvenanceCapable) {
        await this.inferenceProvenance.interruptOtherGenerations(
          String(session.sessionId),
          connection.generationId,
        );
      }
      await this.store.store.recoverInterruptedOperations();
      if (durableTranscript) {
        await this.transcriptAdmission.recoverInterruptedToolResults(session.sessionId);
      }
    }

    await this.programAgents.attach(
      session.sessionId,
      connection.generationId,
      programStateCapable,
      programExecutionCapable,
    );
    const finalizeGeneration = async (): Promise<void> => {
      try {
        if (inferenceProvenanceCapable) {
          await this.inferenceProvenance.interruptGeneration(
            String(session.sessionId),
            connection.generationId,
          );
        }
      } catch {
      } finally {
        this.programAgents.detach(session.sessionId, connection.generationId);
      }
    };
    void connection.waitForExit().then(finalizeGeneration, finalizeGeneration);

    const transport = connection.transport;
    await transport.send({ type: "host.hello", protocolVersion: 1, hostInstanceId: this.hostInstanceId });
    const sessionRequestId = uuidv7();
    if (session.resumed) {
      await transport.send({
        type: "session.resume",
        requestId: sessionRequestId,
        sessionId: session.sessionId as string,
        workspaceId: this.store.store.workspaceId,
        reason: resumeReason,
      });
    } else {
      await transport.send({
        type: "session.open",
        requestId: sessionRequestId,
        sessionId: session.sessionId as string,
        workspaceId: this.store.store.workspaceId,
      });
    }

    const snapshot = durableTranscript
      ? await createWorkspaceReadModels(this.store.store).getTranscriptSnapshot(session.sessionId as string)
      : undefined;
    const staticCatalog = this.inferenceToolCatalog(false);
    await transport.send({
      type: "context.provide",
      requestId: uuidv7(),
      sessionId: session.sessionId as string,
      systemPrompt,
      orientationRequired: session.resumed,
      toolNames: staticCatalog.tools.map((tool) => tool.definition.name),
      ...(snapshot !== undefined ? { verbatim: compileVerbatimContext(snapshot) } : {}),
    });

    const unsubscribe = transport.onMessage((message) => this.handleAgentMessage(
      connection.generationId,
      transport,
      session.sessionId,
      message,
      durableTranscript,
      graphContext,
      dynamicCapabilityBinding,
      inferenceProvenanceCapable,
      programStateCapable,
      programExecutionCapable,
      systemPrompt,
    ));
    return {
      generationId: connection.generationId,
      detach: () => {
        unsubscribe();
        void finalizeGeneration();
      },
    };
  }

  async sendInput(
    transport: ProtocolTransport<HostToAgentMessage, AgentToHostMessage>,
    sessionId: SessionId,
    text: string,
  ): Promise<void> {
    const snapshot = await createWorkspaceReadModels(this.store.store).getTranscriptSnapshot(sessionId as string);
    assertContextContinuable(compileVerbatimContext(snapshot));
    const { timestamp } = await this.admitInput(sessionId, text);
    await transport.send({
      type: "input.admitted",
      requestId: uuidv7(),
      sessionId: sessionId as string,
      text,
      timestamp,
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
    durableTranscript: boolean,
    graphContext: boolean,
    dynamicCapabilityBinding: boolean,
    inferenceProvenanceCapable: boolean,
    programStateCapable: boolean,
    programExecutionCapable: boolean,
    baseSystemPrompt: string,
  ): Promise<void> {
    switch (message.type) {
      case "context.refresh.request": {
        if (message.sessionId !== (sessionId as string)) throw new Error("Agent session mismatch");
        if (!graphContext && !dynamicCapabilityBinding && !programStateCapable && !inferenceProvenanceCapable) {
          throw new Error("Agent has no inference-refresh capability");
        }
        if (inferenceProvenanceCapable && message.providerDescriptor === undefined) {
          throw new Error("Negotiated inference provenance requires a provider descriptor");
        }
        const cacheKey = `${generationId}:${message.requestId}`;
        let update = this.contextRequestCache.get(cacheKey);
        if (!update) {
          const toolCatalog = this.inferenceToolCatalog(dynamicCapabilityBinding);
          const definitions = toolCatalog.tools.map((tool) => tool.definition);
          const refreshed = await this.contextService.refresh({
            requestId: message.requestId,
            sessionId: sessionId as string,
            baseSystemPrompt,
            toolDefinitions: definitions,
            graphCapable: graphContext,
          });
          const programAttempt = programStateCapable
            ? await this.programAgents.currentAttemptProjection(sessionId, generationId)
            : undefined;
          const inferenceEpoch = inferenceProvenanceCapable
            ? await this.inferenceProvenance.authorize({
                sessionId: String(sessionId),
                connectionGenerationId: generationId,
                contextReceiptId: refreshed.receiptId,
                sourceEventSequence: refreshed.sourceEventSequence,
                providerDescriptor: structuredClone(message.providerDescriptor!),
                capabilityCatalogDigest: toolCatalog.digest,
                capabilityBindingSnapshot: toolCatalog.tools.map((tool) => ({
                  toolName: tool.definition.name,
                  binding: structuredClone(tool.binding),
                })),
                ...(programAttempt !== undefined
                  ? {
                      programAttemptAuthority: structuredClone(programAttempt.authority),
                      executionBase: structuredClone(programAttempt.executionBase),
                    }
                  : {}),
              }, {
                assertCurrent: () => {
                  if (!this.programAgents.isCurrentConnection(String(sessionId), generationId)) {
                    throw new Error("Inference authorization Agent generation changed during refresh");
                  }
                  const currentCatalog = this.inferenceToolCatalog(dynamicCapabilityBinding);
                  if (digestOf(currentCatalog.tools) !== digestOf(toolCatalog.tools)) {
                    throw new Error("Inference authorization capability catalog changed during refresh");
                  }
                },
              })
            : undefined;
          update = {
            ...refreshed,
            ...(inferenceEpoch !== undefined ? { inferenceEpochId: inferenceEpoch.inferenceEpochId } : {}),
            ...(dynamicCapabilityBinding ? { toolCatalog } : {}),
            ...(programAttempt !== undefined ? { programAttempt } : {}),
          };
          this.contextRequestCache.set(cacheKey, update);
        }
        try {
          await transport.send(update);
        } catch {
        }
        break;
      }

      case "inference.prepared": {
        if (!inferenceProvenanceCapable) throw new Error("Inference provenance was not negotiated");
        if (message.sessionId !== String(sessionId)) throw new Error("Agent session mismatch");
        await this.inferenceProvenance.prepare({
          inferenceEpochId: message.inferenceEpochId,
          sessionId: String(sessionId),
          connectionGenerationId: generationId,
        });
        try {
          await transport.send({
            type: "inference.prepared.ack",
            requestId: message.requestId,
            sessionId: String(sessionId),
            inferenceEpochId: message.inferenceEpochId,
          });
        } catch {}
        break;
      }

      case "inference.terminal": {
        if (!inferenceProvenanceCapable) throw new Error("Inference provenance was not negotiated");
        if (message.sessionId !== String(sessionId)) throw new Error("Agent session mismatch");
        await this.inferenceProvenance.terminal({
          inferenceEpochId: message.inferenceEpochId,
          sessionId: String(sessionId),
          connectionGenerationId: generationId,
          outcome: message.outcome,
          ...(message.stopReason !== undefined ? { stopReason: message.stopReason } : {}),
          ...(message.providerObservation !== undefined
            ? { providerObservation: structuredClone(message.providerObservation) }
            : {}),
        });
        try {
          await transport.send({
            type: "inference.terminal.ack",
            requestId: message.requestId,
            sessionId: String(sessionId),
            inferenceEpochId: message.inferenceEpochId,
          });
        } catch {}
        break;
      }

      case "assistant.message": {
        if (message.sessionId !== (sessionId as string)) throw new Error("Agent session mismatch");
        if (!durableTranscript) {
          await this.admission.append([{
            eventId: mkEventId(),
            workspaceId: asWorkspaceId(this.store.store.workspaceId),
            sessionId,
            occurredAt: new Date().toISOString(),
            type: "assistant.message.appended",
            payload: {
              text: message.text,
              ...(message.inferenceEpochId !== undefined ? { inferenceEpochId: message.inferenceEpochId } : {}),
            },
            payloadSchemaVersion: 1,
            producer: { kind: "model", provider: `agent:${generationId}` },
          }]);
          this.catchUpCritical();
          break;
        }
        const persisted = await this.transcriptAdmission.admitAssistant(generationId, sessionId, message);
        try {
          await transport.send({
            type: "transcript.admitted",
            requestId: message.requestId,
            sessionId: sessionId as string,
            eventId: persisted.eventId,
            sequence: persisted.sequence,
          });
        } catch {}
        break;
      }

      case "tool.result": {
        if (!durableTranscript) throw new Error("tool.result requires durable transcript capability");
        if (message.sessionId !== (sessionId as string)) throw new Error("Agent session mismatch");
        const persisted = await this.transcriptAdmission.admitToolResult(generationId, sessionId, message);
        try {
          await transport.send({
            type: "transcript.admitted",
            requestId: message.requestId,
            sessionId: sessionId as string,
            eventId: persisted.eventId,
            sequence: persisted.sequence,
          });
        } catch {}
        break;
      }

      case "capability.request": {
        if (message.sessionId !== (sessionId as string)) throw new Error("Agent session mismatch");
        const cacheKey = `${generationId}:${message.requestId}`;
        let response = this.requestCache.get(cacheKey);
        if (!response) {
          if (inferenceProvenanceCapable) {
            if (message.inferenceEpochId === undefined) {
              response = {
                type: "capability.result",
                requestId: message.requestId,
                sessionId: String(sessionId),
                toolCallId: message.toolCallId,
                toolName: message.toolName,
                outcome: "stale",
                errorCode: "inference_provenance_required",
                error: "Capability request lacks its current inference epoch",
              };
            } else {
              try {
                await this.inferenceProvenance.requireCurrentEpoch({
                  inferenceEpochId: message.inferenceEpochId,
                  sessionId: String(sessionId),
                  connectionGenerationId: generationId,
                  requirePrepared: true,
                });
              } catch (error) {
                response = {
                  type: "capability.result",
                  requestId: message.requestId,
                  sessionId: String(sessionId),
                  toolCallId: message.toolCallId,
                  toolName: message.toolName,
                  outcome: "stale",
                  errorCode: "inference_provenance_stale",
                  error: error instanceof Error ? error.message : String(error),
                };
              }
            }
          }

          const activeProgramAuthority = response === undefined
            ? await this.programAgents.currentAttemptAuthority(sessionId)
            : undefined;
          let programAuthority: ProgramAttemptAuthorityV1 | undefined;

          if (response === undefined && activeProgramAuthority !== undefined) {
            if (!programExecutionCapable) {
              response = {
                type: "capability.result", requestId: message.requestId, sessionId: sessionId as string,
                toolCallId: message.toolCallId, toolName: message.toolName, outcome: "denied",
                errorCode: "program_execution_capability_required",
                error: `${PROGRAM_EXECUTION_CAPABILITY} is required for Program-backed capability execution`,
              };
            } else if (!this.programAgents.isCurrentConnection(String(sessionId), generationId)
                || message.programAttemptAuthority === undefined
                || !sameProgramAttemptAuthority(activeProgramAuthority, message.programAttemptAuthority)) {
              response = {
                type: "capability.result", requestId: message.requestId, sessionId: sessionId as string,
                toolCallId: message.toolCallId, toolName: message.toolName, outcome: "stale",
                errorCode: "program_execution_stale",
                error: "ProgramAttempt authority is stale; refresh before retry",
              };
            } else {
              programAuthority = structuredClone(message.programAttemptAuthority);
            }
          } else if (response === undefined && message.programAttemptAuthority !== undefined) {
            response = {
              type: "capability.result", requestId: message.requestId, sessionId: sessionId as string,
              toolCallId: message.toolCallId, toolName: message.toolName,
              outcome: programExecutionCapable ? "stale" : "denied",
              errorCode: programExecutionCapable
                ? "program_execution_stale"
                : "program_execution_capability_required",
              error: programExecutionCapable
                ? "ProgramAttempt authority is no longer current; refresh before retry"
                : `${PROGRAM_EXECUTION_CAPABILITY} is required for Program-backed capability execution`,
            };
          } else if (response === undefined && programExecutionCapable
              && !this.programAgents.isCurrentConnection(String(sessionId), generationId)) {
            response = {
              type: "capability.result", requestId: message.requestId, sessionId: sessionId as string,
              toolCallId: message.toolCallId, toolName: message.toolName, outcome: "stale",
              errorCode: "program_execution_stale",
              error: "Agent generation is no longer current",
            };
          }

          if (response === undefined && COGNITION_TOOL_NAMES.has(message.toolName)) {
            if (message.expectedCapabilityRevision !== undefined) {
              response = {
                type: "capability.result", requestId: message.requestId, sessionId: sessionId as string,
                toolCallId: message.toolCallId, toolName: message.toolName, outcome: "stale",
                errorCode: "capability_stale", error: "capability binding no longer matches; refresh before retry",
              };
            } else {
              try {
                const result = await this.cognition.invoke(sessionId, message.toolName, message.args);
                response = { type: "capability.result", requestId: message.requestId, sessionId: sessionId as string, toolCallId: message.toolCallId, toolName: message.toolName, outcome: "succeeded", result };
              } catch (error) {
                response = { type: "capability.result", requestId: message.requestId, sessionId: sessionId as string, toolCallId: message.toolCallId, toolName: message.toolName, outcome: "failed", error: error instanceof Error ? error.message : String(error) };
              }
            }
          } else if (response === undefined) {
            const result = await this.capabilityBroker.execute({
              sessionId,
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              args: message.args,
              ...(message.expectedCapabilityRevision !== undefined ? { expectedCapabilityRevision: message.expectedCapabilityRevision } : {}),
              ...(programAuthority !== undefined ? { program: programAuthority } : {}),
              ...(message.inferenceEpochId !== undefined ? { inferenceEpochId: message.inferenceEpochId } : {}),
              ...(message.parentToolCallId !== undefined ? { parentToolCallId: message.parentToolCallId } : {}),
              ...(message.localSubcallIndex !== undefined ? { localSubcallIndex: message.localSubcallIndex } : {}),
            });
            response = {
              type: "capability.result", requestId: message.requestId, sessionId: sessionId as string,
              toolCallId: message.toolCallId, toolName: message.toolName,
              ...(result.operationId ? { operationId: result.operationId as string } : {}), outcome: result.outcome,
              ...(result.result !== undefined ? { result: result.result } : {}), ...(result.error !== undefined ? { error: result.error } : {}),
              ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
            };
          }
          this.requestCache.set(cacheKey, response);
        }
        try { await transport.send(response); } catch {}
        break;
      }

      case "criterion.evidence":
        await this.admission.append([{
          eventId: mkEventId(), workspaceId: asWorkspaceId(this.store.store.workspaceId), sessionId,
          occurredAt: new Date().toISOString(), type: "runtime.criterion.evidence",
          payload: { evidenceType: message.evidenceType, data: message.data ?? null, generationId }, payloadSchemaVersion: 1,
          producer: { kind: "runtime", component: `agent:${generationId}` },
        }]);
        break;

      case "agent.idle": {
        const completion = await this.assessAndComplete(sessionId, true);
        if (completion.completed) {
          try { await transport.send({ type: "shutdown", requestId: uuidv7(), sessionId: sessionId as string, reason: "completed" }); } catch {}
        }
        break;
      }

      case "agent.error":
        await this.admission.append([{
          eventId: mkEventId(), workspaceId: asWorkspaceId(this.store.store.workspaceId), sessionId,
          occurredAt: new Date().toISOString(), type: "runtime.agent.error",
          payload: { message: message.message, generationId }, payloadSchemaVersion: 1,
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
