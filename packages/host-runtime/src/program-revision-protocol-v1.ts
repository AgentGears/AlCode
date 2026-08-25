import {
  PROGRAM_REVISION_CAPABILITY,
  PROGRAM_REVISION_MESSAGE_VERSION,
  PROGRAM_STATE_V2_CAPABILITY,
  assertProgramV2CapabilityDependencies,
  isProgramRevisionPlanWireV1,
  type AgentToHostMessageV2Aware,
  type HostToAgentMessageV2Aware,
  type ProgramRevisionPlanWireV1,
  type ProgramRevisionProposalResultWireV1,
  type ProgramRevisionProposalWireV1,
  type ProtocolTransport,
} from "@alcode/agent-protocol";
import type { ProgramSemanticRevisionEditV1 } from "@alcode/program-state";
import {
  ProgramRevisionControlError,
  ProgramRevisionStaleError,
  type ProgramRevisionAgentProposalV1,
  type ProgramRevisionPlanningBeginV1,
} from "./program-revision.ts";

const REVISION_PROTOCOL_REPLAY_MAX = 128;

export interface ProgramRevisionPlanningProtocolAuthorityV1 {
  begin(input: {
    sourceSessionId: string;
    connectionGenerationId: string;
    agentGeneration: number;
    programStateId: string;
  }): Promise<ProgramRevisionPlanningBeginV1>;
  submitProposal(input: {
    sourceSessionId: string;
    connectionGenerationId: string;
    agentGeneration: number;
    proposal: ProgramRevisionAgentProposalV1;
  }): Promise<{ draftId: string; draftDigest: string }>;
}

export interface ProgramRevisionProtocolHostOptionsV1 {
  planning: ProgramRevisionPlanningProtocolAuthorityV1;
}

interface RevisionBindingV1 {
  generationId: string;
  agentGeneration: number;
  sessionId: string;
  capabilities: readonly string[];
  transport: ProtocolTransport<HostToAgentMessageV2Aware, AgentToHostMessageV2Aware>;
}

export class ProgramRevisionProtocolHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramRevisionProtocolHostError";
  }
}

function result(
  message: ProgramRevisionProposalWireV1,
  outcome: ProgramRevisionProposalResultWireV1["outcome"],
  extras: Partial<Pick<ProgramRevisionProposalResultWireV1, "draftId" | "draftDigest" | "errorCode" | "error">> = {},
): ProgramRevisionProposalResultWireV1 {
  return {
    type: "program.revision.proposal.result",
    version: PROGRAM_REVISION_MESSAGE_VERSION,
    requestId: message.requestId,
    sessionId: message.sessionId,
    planningEpisodeId: message.planningEpisodeId,
    outcome,
    ...extras,
  };
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= 4096 ? text : `${text.slice(0, 4093)}...`;
}

function replayKey(generationId: string, sessionId: string, requestId: string): string {
  return `${generationId}:${sessionId}:${requestId}`;
}

function replayScopePrefix(generationId: string, sessionId: string): string {
  return `${generationId}:${sessionId}:`;
}

function replayWindowFull(
  completed: ReadonlyMap<string, unknown>,
  inFlight: ReadonlyMap<string, unknown>,
  prefix: string,
): boolean {
  let count = 0;
  for (const key of completed.keys()) if (key.startsWith(prefix)) count += 1;
  for (const key of inFlight.keys()) if (key.startsWith(prefix)) count += 1;
  return count >= REVISION_PROTOCOL_REPLAY_MAX;
}

/**
 * Negotiated Host adapter for `program_revision_v1`. It is intentionally not
 * installed into production runtime composition until A1-6C.
 */
export class ProgramRevisionProtocolHostV1 {
  private readonly bindings = new Map<string, RevisionBindingV1>();
  private readonly completed = new Map<string, ProgramRevisionProposalResultWireV1>();
  private readonly inFlight = new Map<string, Promise<ProgramRevisionProposalResultWireV1>>();

  constructor(private readonly options: ProgramRevisionProtocolHostOptionsV1) {}

  attach(input: {
    generationId: string;
    agentGeneration: number;
    sessionId: string;
    capabilities: readonly string[];
    transport: ProtocolTransport<HostToAgentMessageV2Aware, AgentToHostMessageV2Aware>;
  }): void {
    if (!input.generationId || !input.sessionId || !Number.isSafeInteger(input.agentGeneration) || input.agentGeneration < 1) {
      throw new ProgramRevisionProtocolHostError("generationId, sessionId, and positive agentGeneration are required");
    }
    assertProgramV2CapabilityDependencies(input.capabilities);
    if (!input.capabilities.includes(PROGRAM_STATE_V2_CAPABILITY)
        || !input.capabilities.includes(PROGRAM_REVISION_CAPABILITY)) {
      throw new ProgramRevisionProtocolHostError(
        `${PROGRAM_REVISION_CAPABILITY} requires negotiated ${PROGRAM_STATE_V2_CAPABILITY}`,
      );
    }
    const displaced = this.bindings.get(input.sessionId);
    if (displaced !== undefined && displaced.generationId !== input.generationId) this.clearGeneration(displaced.generationId);
    this.bindings.set(input.sessionId, { ...input, capabilities: [...input.capabilities] });
  }

  detach(generationId: string): void {
    this.clearGeneration(generationId);
  }

  isCurrent(sessionId: string, generationId: string): boolean {
    return this.bindings.get(sessionId)?.generationId === generationId;
  }

  async begin(input: { sessionId: string; generationId: string; programStateId: string }): Promise<ProgramRevisionPlanWireV1> {
    const binding = this.requireBinding(input.sessionId, input.generationId);
    const begin = await this.options.planning.begin({
      sourceSessionId: input.sessionId,
      connectionGenerationId: input.generationId,
      agentGeneration: binding.agentGeneration,
      programStateId: input.programStateId,
    });
    this.requireBinding(input.sessionId, input.generationId);
    const plan: ProgramRevisionPlanWireV1 = {
      type: "program.revision.plan",
      version: PROGRAM_REVISION_MESSAGE_VERSION,
      requestId: begin.requestId,
      sessionId: input.sessionId,
      planningEpisodeId: begin.planningEpisodeId,
      programStateId: begin.programStateId,
      fromProgramStateRevision: begin.fromProgramStateRevision,
      parentProgramRevisionId: begin.parentProgramRevisionId,
      semanticState: structuredClone(begin.semanticState) as unknown as Record<string, unknown>,
    };
    if (!isProgramRevisionPlanWireV1(plan)) {
      throw new ProgramRevisionProtocolHostError("Host produced an invalid bounded semantic revision planning message");
    }
    await binding.transport.send(plan);
    return plan;
  }

  async handleProposal(
    message: ProgramRevisionProposalWireV1,
    generationId: string,
  ): Promise<ProgramRevisionProposalResultWireV1> {
    const key = replayKey(generationId, message.sessionId, message.requestId);
    const cached = this.completed.get(key);
    if (cached !== undefined) return structuredClone(cached);
    const existing = this.inFlight.get(key);
    if (existing !== undefined) return structuredClone(await existing);
    if (!this.isCurrent(message.sessionId, generationId)) {
      return result(message, "stale", {
        errorCode: "program_revision_generation_stale",
        error: "Revision-planning Agent generation is no longer current",
      });
    }
    if (replayWindowFull(this.completed, this.inFlight, replayScopePrefix(generationId, message.sessionId))) {
      const denied = result(message, "denied", {
        errorCode: "program_revision_request_window_exhausted",
        error: "Revision proposal replay window is full",
      });
      await this.requireBinding(message.sessionId, generationId).transport.send(denied);
      return denied;
    }

    const pending = this.computeProposal(message, generationId);
    this.inFlight.set(key, pending);
    try {
      return structuredClone(await pending);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async computeProposal(
    message: ProgramRevisionProposalWireV1,
    generationId: string,
  ): Promise<ProgramRevisionProposalResultWireV1> {
    const binding = this.requireBinding(message.sessionId, generationId);
    let response: ProgramRevisionProposalResultWireV1;
    try {
      const draft = await this.options.planning.submitProposal({
        sourceSessionId: message.sessionId,
        connectionGenerationId: generationId,
        agentGeneration: binding.agentGeneration,
        proposal: {
          planningEpisodeId: message.planningEpisodeId,
          requestId: message.requestId,
          programStateId: message.programStateId,
          parentProgramRevisionId: message.parentProgramRevisionId,
          proposedChangeClass: message.proposedChangeClass,
          proposedEdit: structuredClone(message.proposedEdit) as unknown as ProgramSemanticRevisionEditV1,
          ...(message.rationale !== undefined ? { rationale: message.rationale } : {}),
        },
      });
      if (!this.isCurrent(message.sessionId, generationId)) {
        response = result(message, "stale", {
          errorCode: "program_revision_generation_stale",
          error: "Revision-planning Agent generation changed before proposal result delivery",
        });
      } else {
        response = result(message, "sealed", { draftId: draft.draftId, draftDigest: draft.draftDigest });
      }
    } catch (error) {
      if (error instanceof ProgramRevisionStaleError) {
        response = result(message, "stale", { errorCode: error.name, error: errorText(error) });
      } else if (error instanceof ProgramRevisionControlError) {
        response = result(message, "denied", { errorCode: error.name, error: errorText(error) });
      } else {
        response = result(message, "failed", {
          errorCode: "program_revision_runtime_failure",
          error: errorText(error),
        });
      }
    }
    if (this.isCurrent(message.sessionId, generationId)) {
      const key = replayKey(generationId, message.sessionId, message.requestId);
      if (this.completed.size >= REVISION_PROTOCOL_REPLAY_MAX) {
        const oldest = this.completed.keys().next().value as string | undefined;
        if (oldest !== undefined) this.completed.delete(oldest);
      }
      this.completed.set(key, structuredClone(response));
      await binding.transport.send(response);
    }
    return response;
  }

  private requireBinding(sessionId: string, generationId: string): RevisionBindingV1 {
    const binding = this.bindings.get(sessionId);
    if (binding === undefined || binding.generationId !== generationId) {
      throw new ProgramRevisionProtocolHostError("Revision protocol connection is not current");
    }
    return binding;
  }

  private clearGeneration(generationId: string): void {
    for (const [sessionId, binding] of this.bindings) {
      if (binding.generationId === generationId) this.bindings.delete(sessionId);
    }
    const prefix = `${generationId}:`;
    for (const key of [...this.completed.keys()]) if (key.startsWith(prefix)) this.completed.delete(key);
    for (const key of [...this.inFlight.keys()]) if (key.startsWith(prefix)) this.inFlight.delete(key);
  }
}
