import { randomUUID } from "node:crypto";
import {
  PROGRAM_REVISION_MESSAGE_VERSION,
  type AgentToHostMessageV2Aware,
  type HostToAgentMessageV2Aware,
  type ProgramRevisionPlanWireV1,
  type ProgramRevisionProposalResultWireV1,
  type ProgramRevisionProposalWireV1,
  type ProtocolTransport,
} from "@alcode/agent-protocol";

export interface ProgramRevisionProposalClientInputV1 {
  sessionId: string;
  planningEpisodeId: string;
  programStateId: string;
  parentProgramRevisionId: string;
  proposedChangeClass: ProgramRevisionProposalWireV1["proposedChangeClass"];
  proposedEdit: Record<string, unknown>;
  rationale?: string;
}

export interface ProgramRevisionProtocolClientV1 {
  onPlan(handler: (plan: ProgramRevisionPlanWireV1) => void | Promise<void>): () => void;
  submitProposal(input: ProgramRevisionProposalClientInputV1): Promise<ProgramRevisionProposalResultWireV1>;
  close(): void;
}

export class ProgramRevisionProtocolClientClosedError extends Error {
  constructor() {
    super("Program revision protocol client is closed");
    this.name = "ProgramRevisionProtocolClientClosedError";
  }
}

interface PendingProposal {
  sessionId: string;
  planningEpisodeId: string;
  resolve(result: ProgramRevisionProposalResultWireV1): void;
  reject(error: unknown): void;
}

class ProgramRevisionProtocolClientImplV1 implements ProgramRevisionProtocolClientV1 {
  private readonly plans = new Set<(plan: ProgramRevisionPlanWireV1) => void | Promise<void>>();
  private readonly pending = new Map<string, PendingProposal>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(private readonly transport: ProtocolTransport<AgentToHostMessageV2Aware, HostToAgentMessageV2Aware>) {
    this.unsubscribe = transport.onMessage((message) => this.receive(message));
  }

  onPlan(handler: (plan: ProgramRevisionPlanWireV1) => void | Promise<void>): () => void {
    if (this.closed) throw new ProgramRevisionProtocolClientClosedError();
    this.plans.add(handler);
    return () => this.plans.delete(handler);
  }

  submitProposal(input: ProgramRevisionProposalClientInputV1): Promise<ProgramRevisionProposalResultWireV1> {
    if (this.closed) return Promise.reject(new ProgramRevisionProtocolClientClosedError());
    const requestId = randomUUID();
    const message: ProgramRevisionProposalWireV1 = {
      type: "program.revision.proposal",
      version: PROGRAM_REVISION_MESSAGE_VERSION,
      requestId,
      sessionId: input.sessionId,
      planningEpisodeId: input.planningEpisodeId,
      programStateId: input.programStateId,
      parentProgramRevisionId: input.parentProgramRevisionId,
      proposedChangeClass: input.proposedChangeClass,
      proposedEdit: structuredClone(input.proposedEdit),
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
    };
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, {
        sessionId: input.sessionId,
        planningEpisodeId: input.planningEpisodeId,
        resolve,
        reject,
      });
      void this.transport.send(message).catch((error) => {
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    const error = new ProgramRevisionProtocolClientClosedError();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.plans.clear();
  }

  private receive(message: HostToAgentMessageV2Aware): void {
    if (this.closed) return;
    if (message.type === "program.revision.plan") {
      for (const handler of [...this.plans]) void Promise.resolve(handler(message));
      return;
    }
    if (message.type !== "program.revision.proposal.result") return;
    const pending = this.pending.get(message.requestId);
    if (pending === undefined
        || pending.sessionId !== message.sessionId
        || pending.planningEpisodeId !== message.planningEpisodeId) return;
    this.pending.delete(message.requestId);
    pending.resolve(message);
  }
}

export function createProgramRevisionProtocolClientV1(
  transport: ProtocolTransport<AgentToHostMessageV2Aware, HostToAgentMessageV2Aware>,
): ProgramRevisionProtocolClientV1 {
  return new ProgramRevisionProtocolClientImplV1(transport);
}
