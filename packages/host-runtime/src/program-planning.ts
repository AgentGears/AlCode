import {
  PROGRAM_EXECUTION_MESSAGE_VERSION,
  type AgentToHostMessage,
  type ProgramCreationProposalWireV1,
  type ProgramPlanningBegin,
  type ProgramPlanningReadResult,
  type ProgramProposalResult,
} from "@alcode/agent-protocol";
import { mkProgramStateId, uuidv7, type PersistedDomainEvent, type SessionId } from "@alcode/events";
import {
  asProgramStateId,
  createProgramState,
  type Json,
  type ProgramCreationInput,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import {
  ProgramCreationControlError,
  ProgramCreationServiceV1,
  ProgramCreationStaleError,
  type ProgramCreationProposalV1,
} from "./program-creation.ts";
import { PlanningReadError, PlanningReadRegistry, TrackedPlanningReads } from "./planning-read.ts";
import type { HostProgramVerifierCatalogV1 } from "./program-verifier-catalog.ts";

export const PROGRAM_PLANNING_MAX_CACHED_RESPONSES = 256;

interface ProgramPlanningEpisodeV1 {
  planningEpisodeId: string;
  sourceSessionId: SessionId;
  connectionGenerationId: string;
  agentGeneration: number;
  objective: string;
  sourceObjectiveEventId: string;
  planningCatalogDigest: string;
  verifierCatalogDigest?: string;
  planningReads: TrackedPlanningReads;
  submitted: boolean;
}

export interface ProgramPlanningAgentAuthorityV1 {
  isCurrent(sessionId: string, connectionGenerationId: string, agentGeneration: number): boolean;
}

export type ProgramPlanningResponseV1 = ProgramPlanningReadResult | ProgramProposalResult;

export interface ProgramPlanningServiceOptionsV1 {
  store: WorkspaceEventStore;
  planningReads: PlanningReadRegistry;
  creation: ProgramCreationServiceV1;
  agents: ProgramPlanningAgentAuthorityV1;
  /** Optional only for legacy direct-service fixtures. P-01 product runtime always supplies it. */
  verifiers?: HostProgramVerifierCatalogV1;
}

export class ProgramPlanningControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramPlanningControlError";
  }
}

export class ProgramPlanningStaleError extends ProgramPlanningControlError {
  constructor(message: string) {
    super(message);
    this.name = "ProgramPlanningStaleError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function replayAll(store: WorkspaceEventStore): Promise<PersistedDomainEvent<string, unknown>[]> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

function objectiveSourceEventId(
  events: readonly PersistedDomainEvent<string, unknown>[],
  sessionId: string,
  objective: string,
): string {
  let started = false;
  let stopped = false;
  let sourceEventId: string | undefined;
  for (const event of events) {
    if (String(event.sessionId) !== sessionId) continue;
    if (event.type === "runtime.session.started") started = true;
    if (event.type === "runtime.session.stopped") stopped = true;
    if (event.type === "user.message.appended" && record(event.payload).text === objective) {
      sourceEventId = String(event.eventId);
    }
  }
  if (!started || stopped) {
    throw new ProgramPlanningStaleError(`Source session ${sessionId} is not active`);
  }
  if (sourceEventId === undefined) {
    throw new ProgramPlanningStaleError("Planning objective is not backed by a caller-authored source event");
  }
  return sourceEventId;
}

function requireNonEmpty(label: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProgramPlanningControlError(`${label} must be a non-empty string`);
  }
}

function prevalidateProposal(
  episode: ProgramPlanningEpisodeV1,
  proposal: ProgramCreationProposalWireV1,
  verifiers: HostProgramVerifierCatalogV1 | undefined,
): ProgramCreationProposalV1 {
  if (proposal.objective !== episode.objective) {
    throw new ProgramPlanningControlError("Program proposal objective differs from the Host planning objective");
  }
  const candidate: ProgramCreationProposalV1 = {
    objective: proposal.objective,
    workItems: structuredClone(proposal.workItems) as ProgramCreationProposalV1["workItems"],
    verification: verifiers === undefined
      ? structuredClone(proposal.verification) as ProgramCreationProposalV1["verification"]
      : verifiers.canonicalizeVerification(proposal.verification),
    outputSlots: structuredClone(proposal.outputSlots) as ProgramCreationProposalV1["outputSlots"],
    productionSteps: structuredClone(proposal.productionSteps) as ProgramCreationProposalV1["productionSteps"],
  };
  try {
    createProgramState({
      programStateId: asProgramStateId(String(mkProgramStateId())),
      sourceSessionId: String(episode.sourceSessionId) as ProgramCreationInput["sourceSessionId"],
      objective: candidate.objective,
      workItems: candidate.workItems,
      verification: candidate.verification,
      outputSlots: candidate.outputSlots,
      productionSteps: candidate.productionSteps,
      creationPolicyRequirements: [],
    });
  } catch (error) {
    throw new ProgramPlanningControlError(
      `Program proposal failed structural validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return candidate;
}

export class ProgramPlanningServiceV1 {
  private readonly episodes = new Map<string, ProgramPlanningEpisodeV1>();
  private readonly activeBySession = new Map<string, string>();
  private readonly responseCache = new Map<string, ProgramPlanningResponseV1>();

  constructor(private readonly options: ProgramPlanningServiceOptionsV1) {}

  async begin(input: {
    sourceSessionId: SessionId;
    connectionGenerationId: string;
    agentGeneration: number;
    objective: string;
  }): Promise<ProgramPlanningBegin> {
    requireNonEmpty("connectionGenerationId", input.connectionGenerationId);
    requireNonEmpty("objective", input.objective);
    const sessionId = String(input.sourceSessionId);
    if (!this.options.agents.isCurrent(sessionId, input.connectionGenerationId, input.agentGeneration)) {
      throw new ProgramPlanningStaleError("Planning Agent authority is stale");
    }

    const sourceObjectiveEventId = objectiveSourceEventId(
      await replayAll(this.options.store),
      sessionId,
      input.objective,
    );
    const previous = this.activeBySession.get(sessionId);
    if (previous !== undefined) this.episodes.delete(previous);

    const planningCatalog = this.options.planningReads.catalog();
    const verifierCatalog = this.options.verifiers?.catalog();
    const planningEpisodeId = uuidv7();
    const episode: ProgramPlanningEpisodeV1 = {
      planningEpisodeId,
      sourceSessionId: input.sourceSessionId,
      connectionGenerationId: input.connectionGenerationId,
      agentGeneration: input.agentGeneration,
      objective: input.objective,
      sourceObjectiveEventId,
      planningCatalogDigest: planningCatalog.digest,
      ...(verifierCatalog !== undefined ? { verifierCatalogDigest: verifierCatalog.digest } : {}),
      planningReads: this.options.planningReads.track(this.options.store.workspaceId),
      submitted: false,
    };
    this.episodes.set(planningEpisodeId, episode);
    this.activeBySession.set(sessionId, planningEpisodeId);
    return {
      type: "program.planning.begin",
      version: PROGRAM_EXECUTION_MESSAGE_VERSION,
      requestId: uuidv7(),
      sessionId,
      planningEpisodeId,
      objective: input.objective,
      planningCatalog,
      ...(verifierCatalog !== undefined ? { verifierCatalog } : {}),
    };
  }

  async handleAgentMessage(input: {
    connectionGenerationId: string;
    agentGeneration: number;
    sessionId: SessionId;
    message: AgentToHostMessage;
  }): Promise<ProgramPlanningResponseV1 | undefined> {
    const message = input.message;
    if (message.type !== "program.planning.read" && message.type !== "program.proposal") return undefined;
    if (message.sessionId !== String(input.sessionId)) {
      return this.failureFor(message, "stale", "program_planning_stale", "Planning Session authority is stale");
    }

    const cacheKey = `${input.connectionGenerationId}:${message.requestId}`;
    const cached = this.responseCache.get(cacheKey);
    if (cached !== undefined) return structuredClone(cached);

    const episode = this.episodes.get(message.planningEpisodeId);
    if (episode === undefined
        || String(episode.sourceSessionId) !== String(input.sessionId)
        || episode.connectionGenerationId !== input.connectionGenerationId
        || episode.agentGeneration !== input.agentGeneration
        || !this.options.agents.isCurrent(String(input.sessionId), input.connectionGenerationId, input.agentGeneration)) {
      const result = this.failureFor(message, "stale", "program_planning_stale", "Planning episode or Agent authority is stale");
      this.cache(cacheKey, result);
      return result;
    }
    if (episode.planningCatalogDigest !== this.options.planningReads.catalog().digest) {
      const result = this.failureFor(message, "stale", "program_planning_catalog_stale", "Planning catalog changed during the episode");
      this.cache(cacheKey, result);
      return result;
    }
    if (episode.verifierCatalogDigest !== undefined
        && this.options.verifiers?.catalog().digest !== episode.verifierCatalogDigest) {
      const result = this.failureFor(message, "stale", "program_verifier_catalog_stale", "Verifier catalog changed during the episode");
      this.cache(cacheKey, result);
      return result;
    }

    let response: ProgramPlanningResponseV1;
    if (message.type === "program.planning.read") {
      if (episode.submitted) {
        response = this.failureFor(message, "stale", "program_planning_closed", "Planning episode is already closed");
      } else {
        try {
          const result = await episode.planningReads.read(
            message.readContractId,
            message.readContractVersion,
            message.args as Json,
          );
          response = {
            type: "program.planning.read.result",
            version: PROGRAM_EXECUTION_MESSAGE_VERSION,
            requestId: message.requestId,
            sessionId: message.sessionId,
            planningEpisodeId: message.planningEpisodeId,
            outcome: "succeeded",
            result,
          };
        } catch (error) {
          response = this.failureFor(
            message,
            error instanceof PlanningReadError ? "denied" : "failed",
            error instanceof PlanningReadError ? "program_planning_read_invalid" : "program_planning_read_failed",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    } else {
      if (episode.submitted) {
        response = this.failureFor(message, "stale", "program_planning_closed", "Planning proposal was already submitted");
      } else {
        let canonicalProposal: ProgramCreationProposalV1;
        try {
          canonicalProposal = prevalidateProposal(episode, message.proposal, this.options.verifiers);
        } catch (error) {
          response = this.failureFor(
            message,
            "denied",
            "program_proposal_invalid",
            error instanceof Error ? error.message : String(error),
          );
          this.cache(cacheKey, response);
          return response;
        }

        episode.submitted = true;
        try {
          await this.options.creation.sealDraft({
            sourceSessionId: episode.sourceSessionId,
            proposal: canonicalProposal,
            planningReads: episode.planningReads,
            sourceObjectiveEventId: episode.sourceObjectiveEventId,
          });
          response = {
            type: "program.proposal.result",
            version: PROGRAM_EXECUTION_MESSAGE_VERSION,
            requestId: message.requestId,
            sessionId: message.sessionId,
            planningEpisodeId: message.planningEpisodeId,
            outcome: "sealed",
          };
        } catch (error) {
          const stale = error instanceof ProgramCreationStaleError;
          const controlled = error instanceof ProgramCreationControlError;
          response = this.failureFor(
            message,
            stale ? "stale" : controlled ? "denied" : "failed",
            stale ? "program_planning_stale" : controlled ? "program_proposal_terminal_invalid" : "program_proposal_failed",
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          this.closeEpisode(episode);
        }
      }
    }

    this.cache(cacheKey, response);
    return response;
  }

  private closeEpisode(episode: ProgramPlanningEpisodeV1): void {
    this.episodes.delete(episode.planningEpisodeId);
    if (this.activeBySession.get(String(episode.sourceSessionId)) === episode.planningEpisodeId) {
      this.activeBySession.delete(String(episode.sourceSessionId));
    }
  }

  private failureFor(
    message: Extract<AgentToHostMessage, { type: "program.planning.read" | "program.proposal" }>,
    outcome: "stale" | "denied" | "failed",
    errorCode: string,
    error: string,
  ): ProgramPlanningResponseV1 {
    return message.type === "program.planning.read"
      ? {
          type: "program.planning.read.result",
          version: PROGRAM_EXECUTION_MESSAGE_VERSION,
          requestId: message.requestId,
          sessionId: message.sessionId,
          planningEpisodeId: message.planningEpisodeId,
          outcome,
          errorCode,
          error,
        }
      : {
          type: "program.proposal.result",
          version: PROGRAM_EXECUTION_MESSAGE_VERSION,
          requestId: message.requestId,
          sessionId: message.sessionId,
          planningEpisodeId: message.planningEpisodeId,
          outcome,
          errorCode,
          error,
        };
  }

  private cache(key: string, response: ProgramPlanningResponseV1): void {
    this.responseCache.set(key, structuredClone(response));
    while (this.responseCache.size > PROGRAM_PLANNING_MAX_CACHED_RESPONSES) {
      const oldest = this.responseCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.responseCache.delete(oldest);
    }
  }
}
