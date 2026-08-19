import { randomUUID } from "node:crypto";
import {
  AGENT_PROTOCOL_VERSION,
  PROGRAM_EXECUTION_MESSAGE_VERSION,
  createProcessAgentTransport,
  type AgentToHostMessage,
  type CapabilityResult,
  type ContextUpdate,
  type HostToAgentMessage,
  type ProgramAttemptAuthorityV1,
  type ProgramCreationProposalWireV1,
  type ProgramProgressAdvisoryBlockerV1,
  type ProgramProgressEvidenceProposalV1,
  type ProgramProgressResult,
  type ProgramProposalResult,
  type ProtocolTransport,
  type TranscriptAdmitted,
} from "@alcode/agent-protocol";
import type {
  CognitionAssistantRecord,
  CognitionCapabilityRequest,
  CognitionHostClient,
  CognitionIdleRecord,
  CognitionToolResultRecord,
} from "@alcode/cognition-extension";

export interface ProgramProposalRequest {
  sessionId: string;
  planningEpisodeId: string;
  proposal: ProgramCreationProposalWireV1;
}

export interface ProgramProgressRequest {
  sessionId: string;
  authority: ProgramAttemptAuthorityV1;
  evidence: ProgramProgressEvidenceProposalV1[];
  advisoryBlockers: ProgramProgressAdvisoryBlockerV1[];
  requestAwaitingVerification: boolean;
}

export type HostMessageHandler = (message: HostToAgentMessage) => void | Promise<void>;

/** Privileged Agent-side semantic surface. It intentionally exposes no raw transport primitives. */
export interface AgentProtocolClient extends CognitionHostClient {
  announceHello(generationId: string, capabilities: readonly string[]): Promise<void>;
  reportError(message: string, sessionId?: string): Promise<void>;
  requestContextUpdate(sessionId: string, signal: AbortSignal): Promise<ContextUpdate>;
  submitProgramProposal(request: ProgramProposalRequest): Promise<ProgramProposalResult>;
  submitProgramProgress(request: ProgramProgressRequest): Promise<ProgramProgressResult>;
  onHostMessage(handler: HostMessageHandler): () => void;
  close(): Promise<void>;
}

export class AgentProtocolBridgeClosedError extends Error {
  constructor() {
    super("Agent protocol bridge is closed");
    this.name = "AgentProtocolBridgeClosedError";
  }
}

interface PendingResponse {
  matches(message: HostToAgentMessage): boolean;
  resolve(message: HostToAgentMessage): void;
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

class AgentProtocolBridge implements AgentProtocolClient {
  private readonly pending = new Map<string, PendingResponse>();
  private readonly hostHandlers = new Set<HostMessageHandler>();
  private readonly unsubscribeTransport: () => void;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly transport: ProtocolTransport<AgentToHostMessage, HostToAgentMessage>,
  ) {
    this.unsubscribeTransport = transport.onMessage((message) => {
      this.receive(message);
    });
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

  requestContextUpdate(sessionId: string, signal: AbortSignal): Promise<ContextUpdate> {
    const requestId = randomUUID();
    return this.request(
      requestId,
      { type: "context.refresh.request", requestId, sessionId },
      (message): message is ContextUpdate => message.type === "context.update"
        && message.requestId === requestId
        && message.sessionId === sessionId,
      { signal },
    );
  }

  submitProgramProposal(request: ProgramProposalRequest): Promise<ProgramProposalResult> {
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

  submitProgramProgress(request: ProgramProgressRequest): Promise<ProgramProgressResult> {
    const requestId = randomUUID();
    return this.request(
      requestId,
      {
        type: "program.progress",
        version: PROGRAM_EXECUTION_MESSAGE_VERSION,
        requestId,
        sessionId: request.sessionId,
        authority: structuredClone(request.authority),
        evidence: structuredClone(request.evidence),
        advisoryBlockers: structuredClone(request.advisoryBlockers),
        requestAwaitingVerification: request.requestAwaitingVerification,
      },
      (message): message is ProgramProgressResult => message.type === "program.progress.result"
        && message.requestId === requestId
        && message.sessionId === request.sessionId,
      { timeoutMs: 10_000, timeoutMessage: "Program progress proposal timed out" },
    );
  }

  requestCapability(request: CognitionCapabilityRequest): Promise<CapabilityResult> {
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
      },
      (message): message is CapabilityResult => message.type === "capability.result"
        && message.requestId === requestId
        && message.sessionId === request.sessionId
        && message.toolCallId === request.toolCallId
        && message.toolName === request.toolName,
    );
  }

  async recordAssistant(record: CognitionAssistantRecord): Promise<void> {
    const requestId = randomUUID();
    if (!record.durable) {
      await this.send({
        type: "assistant.message",
        requestId,
        sessionId: record.sessionId,
        text: record.text,
      });
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

  onHostMessage(handler: HostMessageHandler): () => void {
    if (this.closed) throw new AgentProtocolBridgeClosedError();
    this.hostHandlers.add(handler);
    return () => this.hostHandlers.delete(handler);
  }

  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closed = true;
    this.unsubscribeTransport();
    const closeError = new AgentProtocolBridgeClosedError();
    for (const pending of [...this.pending.values()]) pending.reject(closeError);
    this.hostHandlers.clear();
    this.closePromise = this.transport.close();
    return this.closePromise;
  }

  private async send(message: AgentToHostMessage): Promise<void> {
    if (this.closed) throw new AgentProtocolBridgeClosedError();
    await this.transport.send(message);
  }

  private request<TResponse extends HostToAgentMessage>(
    requestId: string,
    outgoing: AgentToHostMessage,
    matches: (message: HostToAgentMessage) => message is TResponse,
    options: RequestOptions = {},
  ): Promise<TResponse> {
    if (this.closed) return Promise.reject(new AgentProtocolBridgeClosedError());
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

      try {
        void this.transport.send(outgoing).catch(fail);
      } catch (error) {
        fail(error);
      }
    });
  }

  private receive(message: HostToAgentMessage): void {
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

/** Test seam only; the production worker uses `createProcessAgentProtocolBridge`. */
export function createAgentProtocolBridgeForTransport(
  transport: ProtocolTransport<AgentToHostMessage, HostToAgentMessage>,
): AgentProtocolClient {
  return new AgentProtocolBridge(transport);
}

export function createProcessAgentProtocolBridge(): AgentProtocolClient {
  return new AgentProtocolBridge(createProcessAgentTransport());
}
