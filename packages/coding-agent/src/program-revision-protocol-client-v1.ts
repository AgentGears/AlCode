import { randomUUID } from "node:crypto";
import {
  PROGRAM_REVISION_MESSAGE_VERSION,
  isProgramRevisionPlanWireV1,
  isProgramRevisionProposalResultWireV1,
  isProgramRevisionProposalWireV1,
  type AgentToHostMessageV2Aware,
  type HostToAgentMessageV2Aware,
  type ProgramRevisionPlanWireV1,
  type ProgramRevisionProposalResultWireV1,
  type ProgramRevisionProposalWireV1,
  type ProtocolTransport,
} from "@alcode/agent-protocol";

const DEFAULT_PROGRAM_REVISION_PROPOSAL_TIMEOUT_MS = 10_000;

export interface ProgramRevisionProposalClientInputV1 {
  sessionId: string;
  planningEpisodeId: string;
  programStateId: string;
  parentProgramRevisionId: string;
  proposedChangeClass: ProgramRevisionProposalWireV1["proposedChangeClass"];
  proposedEdit: Record<string, unknown>;
  rationale?: string;
}

export interface ProgramRevisionProtocolClientOptionsV1 {
  /**
   * Bounds a pending proposal for tests/non-production transports. Set to null
   * when the transport/generation lifecycle is the authority for cancellation;
   * this prevents the Agent from abandoning a Host-consumed planning episode
   * while Host validation/sealing is still in flight.
   */
  proposalTimeoutMs?: number | null;
}

export interface ProgramRevisionProtocolClientV1 {
  onPlan(handler: (plan: ProgramRevisionPlanWireV1) => void | Promise<void>): () => void;
  onError(handler: (error: ProgramRevisionProtocolClientPlanHandlerError) => void | Promise<void>): () => void;
  submitProposal(input: ProgramRevisionProposalClientInputV1): Promise<ProgramRevisionProposalResultWireV1>;
  close(): void;
}

export class ProgramRevisionProtocolClientClosedError extends Error {
  constructor() {
    super("Program revision protocol client is closed");
    this.name = "ProgramRevisionProtocolClientClosedError";
  }
}

export class ProgramRevisionProtocolClientTimeoutError extends Error {
  constructor() {
    super("Program revision proposal timed out waiting for Host response");
    this.name = "ProgramRevisionProtocolClientTimeoutError";
  }
}

export class ProgramRevisionProtocolClientValidationError extends Error {
  constructor() {
    super("Program revision proposal is invalid or exceeds protocol limits");
    this.name = "ProgramRevisionProtocolClientValidationError";
  }
}

export class ProgramRevisionProtocolClientPlanHandlerError extends Error {
  constructor(cause: unknown) {
    super("Program revision plan handler failed", { cause });
    this.name = "ProgramRevisionProtocolClientPlanHandlerError";
  }
}

interface PendingProposal {
  sessionId: string;
  planningEpisodeId: string;
  timer?: ReturnType<typeof setTimeout>;
  resolve(result: ProgramRevisionProposalResultWireV1): void;
  reject(error: unknown): void;
}

class ProgramRevisionProtocolClientImplV1 implements ProgramRevisionProtocolClientV1 {
  private readonly plans = new Set<(plan: ProgramRevisionPlanWireV1) => void | Promise<void>>();
  private readonly errors = new Set<(error: ProgramRevisionProtocolClientPlanHandlerError) => void | Promise<void>>();
  private readonly pending = new Map<string, PendingProposal>();
  private readonly unsubscribe: () => void;
  private readonly proposalTimeoutMs: number | null;
  private closed = false;

  constructor(
    private readonly transport: ProtocolTransport<AgentToHostMessageV2Aware, HostToAgentMessageV2Aware>,
    options: ProgramRevisionProtocolClientOptionsV1,
  ) {
    const timeout = options.proposalTimeoutMs === undefined
      ? DEFAULT_PROGRAM_REVISION_PROPOSAL_TIMEOUT_MS
      : options.proposalTimeoutMs;
    if (timeout !== null && (!Number.isSafeInteger(timeout) || timeout <= 0)) {
      throw new Error("proposalTimeoutMs must be null or a positive safe integer");
    }
    this.proposalTimeoutMs = timeout;
    this.unsubscribe = transport.onMessage((message) => this.receive(message));
  }

  onPlan(handler: (plan: ProgramRevisionPlanWireV1) => void | Promise<void>): () => void {
    if (this.closed) throw new ProgramRevisionProtocolClientClosedError();
    this.plans.add(handler);
    return () => this.plans.delete(handler);
  }

  onError(handler: (error: ProgramRevisionProtocolClientPlanHandlerError) => void | Promise<void>): () => void {
    if (this.closed) throw new ProgramRevisionProtocolClientClosedError();
    this.errors.add(handler);
    return () => this.errors.delete(handler);
  }

  submitProposal(input: ProgramRevisionProposalClientInputV1): Promise<ProgramRevisionProposalResultWireV1> {
    if (this.closed) return Promise.reject(new ProgramRevisionProtocolClientClosedError());
    const requestId = randomUUID();
    let proposedEdit: Record<string, unknown>;
    try {
      proposedEdit = structuredClone(input.proposedEdit);
    } catch {
      return Promise.reject(new ProgramRevisionProtocolClientValidationError());
    }
    const message: ProgramRevisionProposalWireV1 = {
      type: "program.revision.proposal",
      version: PROGRAM_REVISION_MESSAGE_VERSION,
      requestId,
      sessionId: input.sessionId,
      planningEpisodeId: input.planningEpisodeId,
      programStateId: input.programStateId,
      parentProgramRevisionId: input.parentProgramRevisionId,
      proposedChangeClass: input.proposedChangeClass,
      proposedEdit,
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
    };
    // The checked Host IPC boundary treats malformed Agent frames as protocol
    // violations. Reject locally so model-generated oversized/malformed input
    // can never be forwarded into that fail-closed process boundary.
    if (!isProgramRevisionProposalWireV1(message)) {
      return Promise.reject(new ProgramRevisionProtocolClientValidationError());
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        const pending = this.pending.get(requestId);
        if (pending?.timer !== undefined) clearTimeout(pending.timer);
        this.pending.delete(requestId);
        action();
      };
      const timer = this.proposalTimeoutMs === null
        ? undefined
        : setTimeout(
            () => finish(() => reject(new ProgramRevisionProtocolClientTimeoutError())),
            this.proposalTimeoutMs,
          );
      this.pending.set(requestId, {
        sessionId: input.sessionId,
        planningEpisodeId: input.planningEpisodeId,
        ...(timer !== undefined ? { timer } : {}),
        resolve: (result) => finish(() => resolve(result)),
        reject: (error) => finish(() => reject(error)),
      });
      const failSend = (error: unknown): void => {
        this.pending.get(requestId)?.reject(error);
      };
      try {
        void this.transport.send(message).catch(failSend);
      } catch (error) {
        failSend(error);
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    const error = new ProgramRevisionProtocolClientClosedError();
    for (const pending of [...this.pending.values()]) pending.reject(error);
    this.plans.clear();
    this.errors.clear();
  }

  private receive(message: HostToAgentMessageV2Aware): void {
    if (this.closed) return;
    if (message.type === "program.revision.plan") {
      if (!isProgramRevisionPlanWireV1(message)) return;
      for (const handler of [...this.plans]) {
        try {
          void Promise.resolve(handler(message)).catch((cause) => this.reportPlanHandlerError(cause));
        } catch (cause) {
          this.reportPlanHandlerError(cause);
        }
      }
      return;
    }
    if (message.type !== "program.revision.proposal.result" || !isProgramRevisionProposalResultWireV1(message)) return;
    const pending = this.pending.get(message.requestId);
    if (pending === undefined
        || pending.sessionId !== message.sessionId
        || pending.planningEpisodeId !== message.planningEpisodeId) return;
    pending.resolve(message);
  }

  private reportPlanHandlerError(cause: unknown): void {
    const error = new ProgramRevisionProtocolClientPlanHandlerError(cause);
    for (const handler of [...this.errors]) {
      try {
        void Promise.resolve(handler(error)).catch(() => undefined);
      } catch {
        // Error observers are advisory and must never create a second unhandled failure.
      }
    }
  }
}

export function createProgramRevisionProtocolClientV1(
  transport: ProtocolTransport<AgentToHostMessageV2Aware, HostToAgentMessageV2Aware>,
  options: ProgramRevisionProtocolClientOptionsV1 = {},
): ProgramRevisionProtocolClientV1 {
  return new ProgramRevisionProtocolClientImplV1(transport, options);
}
