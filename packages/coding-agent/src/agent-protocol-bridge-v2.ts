import { randomUUID } from "node:crypto";
import {
  AGENT_PROTOCOL_VERSION,
  PROGRAM_EXECUTION_MESSAGE_VERSION,
  PROGRAM_EXECUTION_V2_MESSAGE_VERSION,
  createProcessAgentTransport,
  isProgramAttemptAuthorityV2,
  type AgentToHostMessageV2Aware,
  type CapabilityResult,
  type ContextUpdate,
  type ContextUpdateV2,
  type HostToAgentMessageV2Aware,
  type ProgramAttemptAuthorityAny,
  type ProgramCreationProposalWireV1,
  type ProgramPlanningReadResult,
  type ProgramProgressAdvisoryBlockerV1,
  type ProgramProgressEvidenceProposalV1,
  type ProgramProgressResult,
  type ProgramProgressResultV2,
  type ProgramProposalResult,
  type ProtocolTransport,
  type TranscriptAdmitted,
} from "@alcode/agent-protocol";
import type {
  CognitionAssistantRecord,
  CognitionCapabilityRequestV2Aware,
  CognitionHostClientV2Aware,
  CognitionIdleRecord,
  CognitionToolResultRecord,
} from "@alcode/cognition-extension";

export interface ProgramProposalRequestV2Aware {
  sessionId: string;
  planningEpisodeId: string;
  proposal: ProgramCreationProposalWireV1;
}

export interface ProgramPlanningReadClientRequestV2Aware {
  sessionId: string;
  planningEpisodeId: string;
  readContractId: string;
  readContractVersion: number;
  args: unknown;
}

export interface ProgramProgressRequestV2Aware {
  sessionId: string;
  authority: ProgramAttemptAuthorityAny;
  evidence: ProgramProgressEvidenceProposalV1[];
  advisoryBlockers: ProgramProgressAdvisoryBlockerV1[];
  requestAwaitingVerification: boolean;
}

export type ContextUpdateAny = ContextUpdate | ContextUpdateV2;
export type ProgramProgressResultAny = ProgramProgressResult | ProgramProgressResultV2;
export type HostMessageHandlerV2Aware = (message: HostToAgentMessageV2Aware) => void | Promise<void>;

export interface AgentProtocolClientV2 extends CognitionHostClientV2Aware {
  announceHello(generationId: string, capabilities: readonly string[]): Promise<void>;
  reportError(message: string, sessionId?: string): Promise<void>;
  requestContextUpdate(sessionId: string, signal: AbortSignal): Promise<ContextUpdateAny>;
  requestProgramPlanningRead(request: ProgramPlanningReadClientRequestV2Aware): Promise<ProgramPlanningReadResult>;
  submitProgramProposal(request: ProgramProposalRequestV2Aware): Promise<ProgramProposalResult>;
  submitProgramProgress(request: ProgramProgressRequestV2Aware): Promise<ProgramProgressResultAny>;
  onHostMessage(handler: HostMessageHandlerV2Aware): () => void;
  close(): Promise<void>;
}

export class AgentProtocolBridgeV2ClosedError extends Error {
  constructor() {
    super("Agent protocol bridge is closed");
    this.name = "AgentProtocolBridgeV2ClosedError";
  }
}

interface PendingResponse {
  matches(message: HostToAgentMessageV2Aware): boolean;
  resolve(message: HostToAgentMessageV2Aware): void;
  reject(error: unknown): void;
}

interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  timeoutMessage?: string;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(signal.reason === undefined ? "Agent protocol request aborted" : String(signal.reason));
}

class AgentProtocolBridgeV2 implements AgentProtocolClientV2 {
  private readonly pending = new Map<string, PendingResponse>();
  private readonly hostHandlers = new Set<HostMessageHandlerV2Aware>();
  private readonly unsubscribeTransport: () => void;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly transport: ProtocolTransport<AgentToHostMessageV2Aware, HostToAgentMessageV2Aware>,
  ) {
    this.unsubscribeTransport = transport.onMessage((message) => this.receive(message));
  }

  async announceHello(generationId: string, capabilities: readonly string[]): Promise<void> {
    await this.send({
      type: "agent.hello",
      protocolVersion: AGENT_PROTOCOL_VERSION,
      generationId,
      capabilities: [...capabilities],
    });
  }

  async reportError(message: string, sessionId?: string): Promise<void> {
    await this.send({
      type: "agent.error",
      requestId: randomUUID(),
      ...(sessionId !== undefined ? { sessionId } : {}),
      message,
    });
  }

  requestContextUpdate(sessionId: string, signal: AbortSignal): Promise<ContextUpdateAny> {
    const requestId = randomUUID();
    return this.request(
      requestId,
      { type: "context.refresh.request", requestId, sessionId },
      (message): message is ContextUpdateAny => message.type === "context.update"
        && message.requestId === requestId
        && message.sessionId === sessionId,
      { signal, timeoutMs: 10_000, timeoutMessage: "Context refresh timed out" },
    );
  }

  requestProgramPlanningRead(
    request: ProgramPlanningReadClientRequestV2Aware,
  ): Promise<ProgramPlanningReadResult> {
    const requestId = randomUUID();
    return this.request(
      requestId,
      {
        type: "program.planning.read",
        version: PROGRAM_EXECUTION_MESSAGE_VERSION,
        requestId,
        sessionId: request.sessionId,
        planningEpisodeId: request.planningEpisodeId,
        readContractId: request.readContractId,
        readContractVersion: request.readContractVersion,
        args: structuredClone(request.args),
      },
      (message): message is ProgramPlanningReadResult => message.type === "program.planning.read.result"
        && message.requestId === requestId
        && message.sessionId === request.sessionId
        && message.planningEpisodeId === request.planningEpisodeId,
      { timeoutMs: 10_000, timeoutMessage: "Program planning read timed out" },
    );
  }

  submitProgramProposal(request: ProgramProposalRequestV2Aware): Promise<ProgramProposalResult> {
    const requestId = randomUUID();
    return this.request(
      requestId,
      {
        type: "program.proposal",
        version: PROGRAM_EXECUTION_MESSAGE_VERSION,
        requestId,
        sessionId: request.sessionId,
        planningEpisodeId: request.planningEpisodeId,
        proposal: structuredClone(request.proposal),
      },
      (message): message is ProgramProposalResult => message.type === "program.proposal.result"
        && message.requestId === requestId
        && message.sessionId === request.sessionId
        && message.planningEpisodeId === request.planningEpisodeId,
      { timeoutMs: 10_000, timeoutMessage: "Program proposal timed out" },
    );
  }

  submitProgramProgress(request: ProgramProgressRequestV2Aware): Promise<ProgramProgressResultAny> {
    const requestId = randomUUID();
    const version = isProgramAttemptAuthorityV2(request.authority)
      ? PROGRAM_EXECUTION_V2_MESSAGE_VERSION
      : PROGRAM_EXECUTION_MESSAGE_VERSION;
    return this.request(
      requestId,
      {
        type: "program.progress",
        version,
        requestId,
        sessionId: request.sessionId,
        authority: structuredClone(request.authority),
        evidence: structuredClone(request.evidence),
        advisoryBlockers: structuredClone(request.advisoryBlockers),
        requestAwaitingVerification: request.requestAwaitingVerification,
      } as AgentToHostMessageV2Aware,
      (message): message is ProgramProgressResultAny => message.type === "program.progress.result"
        && message.requestId === requestId
        && message.sessionId === request.sessionId,
      { timeoutMs: 10_000, timeoutMessage: "Program progress proposal timed out" },
    );
  }

  requestCapability(request: CognitionCapabilityRequestV2Aware): Promise<CapabilityResult> {
    const requestId = randomUUID();
    return this.request(
      requestId,
      {
        type: "capability.request",
        requestId,
        sessionId: request.sessionId,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        args: request.args,
        ...(request.expectedCapabilityRevision !== undefined
          ? { expectedCapabilityRevision: request.expectedCapabilityRevision }
          : {}),
        ...(request.programAttemptAuthority !== undefined
          ? { programAttemptAuthority: structuredClone(request.programAttemptAuthority) }
          : {}),
      } as AgentToHostMessageV2Aware,
      (message): message is CapabilityResult => message.type === "capability.result"
        && message.requestId === requestId
        && message.sessionId === request.sessionId
        && message.toolCallId === request.toolCallId
        && message.toolName === request.toolName,
      { timeoutMs: 10_000, timeoutMessage: "Capability request timed out" },
    );
  }

  async recordAssistant(record: CognitionAssistantRecord): Promise<void> {
    const requestId = randomUUID();
    if (!record.durable) {
      await this.send({ type: "assistant.message", requestId, sessionId: record.sessionId, text: record.text });
      return;
    }
    await this.request<TranscriptAdmitted>(
      requestId,
      {
        type: "assistant.message",
        requestId,
        sessionId: record.sessionId,
        text: record.text,
        content: structuredClone(record.content),
        stopReason: record.stopReason,
        ...(record.errorMessage !== undefined ? { errorMessage: record.errorMessage } : {}),
        timestamp: record.timestamp,
      },
      (message): message is TranscriptAdmitted => message.type === "transcript.admitted"
        && message.requestId === requestId
        && message.sessionId === record.sessionId,
    );
  }

  async recordToolResult(record: CognitionToolResultRecord): Promise<void> {
    const requestId = randomUUID();
    await this.request<TranscriptAdmitted>(
      requestId,
      {
        type: "tool.result",
        requestId,
        sessionId: record.sessionId,
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        content: structuredClone(record.content),
        isError: record.isError,
        timestamp: record.timestamp,
      },
      (message): message is TranscriptAdmitted => message.type === "transcript.admitted"
        && message.requestId === requestId
        && message.sessionId === record.sessionId,
    );
  }

  async reportIdle(record: CognitionIdleRecord): Promise<void> {
    await this.send({
      type: "agent.idle",
      requestId: randomUUID(),
      sessionId: record.sessionId,
      reason: record.reason,
    });
  }

  onHostMessage(handler: HostMessageHandlerV2Aware): () => void {
    if (this.closed) throw new AgentProtocolBridgeV2ClosedError();
    this.hostHandlers.add(handler);
    return () => this.hostHandlers.delete(handler);
  }

  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closed = true;
    this.unsubscribeTransport();
    const error = new AgentProtocolBridgeV2ClosedError();
    for (const pending of [...this.pending.values()]) pending.reject(error);
    this.hostHandlers.clear();
    this.closePromise = this.transport.close();
    return this.closePromise;
  }

  private async send(message: AgentToHostMessageV2Aware): Promise<void> {
    if (this.closed) throw new AgentProtocolBridgeV2ClosedError();
    await this.transport.send(message);
  }

  private request<TResponse extends HostToAgentMessageV2Aware>(
    requestId: string,
    outgoing: AgentToHostMessageV2Aware,
    matches: (message: HostToAgentMessageV2Aware) => message is TResponse,
    options: RequestOptions = {},
  ): Promise<TResponse> {
    if (this.closed) return Promise.reject(new AgentProtocolBridgeV2ClosedError());
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal));
    return new Promise<TResponse>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const signal = options.signal;
      let entry!: PendingResponse;
      const cleanup = () => {
        if (this.pending.get(requestId) === entry) this.pending.delete(requestId);
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const succeed = (message: TResponse) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(message);
      };
      const onAbort = () => {
        if (signal !== undefined) fail(abortError(signal));
      };
      entry = {
        matches,
        resolve: (message) => succeed(message as TResponse),
        reject: fail,
      };
      if (this.pending.has(requestId)) {
        fail(new Error(`Duplicate pending Agent protocol request ${requestId}`));
        return;
      }
      this.pending.set(requestId, entry);
      if (signal !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }
      }
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(
          () => fail(new Error(options.timeoutMessage ?? "Agent protocol request timed out")),
          options.timeoutMs,
        );
      }
      void this.transport.send(outgoing).catch(fail);
    });
  }

  private receive(message: HostToAgentMessageV2Aware): void {
    if (this.closed) return;
    if ("requestId" in message) {
      const pending = this.pending.get(message.requestId);
      if (pending !== undefined && pending.matches(message)) {
        pending.resolve(message);
        return;
      }
    }
    for (const handler of [...this.hostHandlers]) void Promise.resolve(handler(message));
  }
}

function createSemanticClientFacadeV2(bridge: AgentProtocolBridgeV2): AgentProtocolClientV2 {
  return Object.freeze({
    announceHello: bridge.announceHello.bind(bridge),
    reportError: bridge.reportError.bind(bridge),
    requestContextUpdate: bridge.requestContextUpdate.bind(bridge),
    requestProgramPlanningRead: bridge.requestProgramPlanningRead.bind(bridge),
    submitProgramProposal: bridge.submitProgramProposal.bind(bridge),
    submitProgramProgress: bridge.submitProgramProgress.bind(bridge),
    requestCapability: bridge.requestCapability.bind(bridge),
    recordAssistant: bridge.recordAssistant.bind(bridge),
    recordToolResult: bridge.recordToolResult.bind(bridge),
    reportIdle: bridge.reportIdle.bind(bridge),
    onHostMessage: bridge.onHostMessage.bind(bridge),
    close: bridge.close.bind(bridge),
  });
}

export function createAgentProtocolBridgeV2ForTransport(
  transport: ProtocolTransport<AgentToHostMessageV2Aware, HostToAgentMessageV2Aware>,
): AgentProtocolClientV2 {
  return createSemanticClientFacadeV2(new AgentProtocolBridgeV2(transport));
}

export function createProcessAgentProtocolBridgeV2(): AgentProtocolClientV2 {
  const transport = createProcessAgentTransport() as unknown as ProtocolTransport<
    AgentToHostMessageV2Aware,
    HostToAgentMessageV2Aware
  >;
  return createSemanticClientFacadeV2(new AgentProtocolBridgeV2(transport));
}
