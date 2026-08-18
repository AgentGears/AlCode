from pathlib import Path

ROOT = Path('.')

def replace_once(path: str, old: str, new: str) -> None:
    p = ROOT / path
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'missing patch anchor in {path}: {old[:120]!r}')
    if text.count(old) != 1:
        raise SystemExit(f'non-unique patch anchor in {path}: {text.count(old)} matches')
    p.write_text(text.replace(old, new, 1))

# --- agent-protocol messages -------------------------------------------------
messages = 'packages/agent-protocol/src/messages.ts'
replace_once(messages,
'''export const PROGRAM_STATE_CAPABILITY = "program_state_v1" as const;\nexport const VERBATIM_COMPILER_VERSION = "verbatim-v1" as const;''',
'''export const PROGRAM_STATE_CAPABILITY = "program_state_v1" as const;\nexport const PROGRAM_EXECUTION_CAPABILITY = "program_execution_v1" as const;\nexport const PROGRAM_EXECUTION_MESSAGE_VERSION = 1 as const;\nexport const PROGRAM_PLANNING_READ_MAX_BYTES = 1024 * 1024;\nexport const PROGRAM_PROPOSAL_MAX_BYTES = 4 * 1024 * 1024;\nexport const VERBATIM_COMPILER_VERSION = "verbatim-v1" as const;''')

replace_once(messages,
'''export interface AgentHello { type: "agent.hello"; protocolVersion: typeof AGENT_PROTOCOL_VERSION; generationId: AgentGenerationId; capabilities: string[]; }''',
'''export interface ProgramCreationProposalWireV1 {\n  objective: string;\n  workItems: unknown[];\n  verification: unknown[];\n  outputSlots: unknown[];\n  productionSteps: unknown[];\n}\n\nexport interface ProgramPlanningReadRequest {\n  type: "program.planning.read";\n  version: typeof PROGRAM_EXECUTION_MESSAGE_VERSION;\n  requestId: ProtocolRequestId;\n  sessionId: string;\n  planningEpisodeId: string;\n  readContractId: string;\n  readContractVersion: number;\n  args: unknown;\n}\n\nexport interface ProgramProposalSubmitted {\n  type: "program.proposal";\n  version: typeof PROGRAM_EXECUTION_MESSAGE_VERSION;\n  requestId: ProtocolRequestId;\n  sessionId: string;\n  planningEpisodeId: string;\n  proposal: ProgramCreationProposalWireV1;\n}\n\nexport interface AgentHello { type: "agent.hello"; protocolVersion: typeof AGENT_PROTOCOL_VERSION; generationId: AgentGenerationId; capabilities: string[]; }''')

replace_once(messages,
'''export interface CapabilityRequest { type: "capability.request"; requestId: ProtocolRequestId; sessionId: string; toolCallId: string; toolName: string; args: unknown; expectedCapabilityRevision?: string; }''',
'''export interface CapabilityRequest { type: "capability.request"; requestId: ProtocolRequestId; sessionId: string; toolCallId: string; toolName: string; args: unknown; expectedCapabilityRevision?: string; programAttemptAuthority?: ProgramAttemptAuthorityV1; }''')

replace_once(messages,
'''export type AgentToHostMessage = AgentHello | AssistantMessageProduced | ToolResultProduced | CapabilityRequest | ContextRefreshRequest | CriterionEvidence | AgentIdle | AgentError;''',
'''export type AgentToHostMessage = AgentHello | AssistantMessageProduced | ToolResultProduced | CapabilityRequest | ProgramPlanningReadRequest | ProgramProposalSubmitted | ContextRefreshRequest | CriterionEvidence | AgentIdle | AgentError;''')

replace_once(messages,
'''export interface HostHello { type: "host.hello"; protocolVersion: typeof AGENT_PROTOCOL_VERSION; hostInstanceId: string; }''',
'''export interface ProgramPlanningBegin {\n  type: "program.planning.begin";\n  version: typeof PROGRAM_EXECUTION_MESSAGE_VERSION;\n  requestId: ProtocolRequestId;\n  sessionId: string;\n  planningEpisodeId: string;\n  objective: string;\n}\n\nexport interface ProgramPlanningReadResult {\n  type: "program.planning.read.result";\n  version: typeof PROGRAM_EXECUTION_MESSAGE_VERSION;\n  requestId: ProtocolRequestId;\n  sessionId: string;\n  planningEpisodeId: string;\n  outcome: "succeeded" | "stale" | "denied" | "failed";\n  result?: unknown;\n  errorCode?: string;\n  error?: string;\n}\n\nexport interface ProgramProposalResult {\n  type: "program.proposal.result";\n  version: typeof PROGRAM_EXECUTION_MESSAGE_VERSION;\n  requestId: ProtocolRequestId;\n  sessionId: string;\n  planningEpisodeId: string;\n  outcome: "sealed" | "stale" | "denied" | "failed";\n  errorCode?: string;\n  error?: string;\n}\n\nexport interface HostHello { type: "host.hello"; protocolVersion: typeof AGENT_PROTOCOL_VERSION; hostInstanceId: string; }''')

replace_once(messages,
'''export type HostToAgentMessage = HostHello | SessionOpen | SessionResume | InputAdmitted | ContextProvide | ContextUpdate | TranscriptAdmitted | CapabilityResult | Cancel | Shutdown;''',
'''export type HostToAgentMessage = HostHello | SessionOpen | SessionResume | InputAdmitted | ProgramPlanningBegin | ProgramPlanningReadResult | ProgramProposalResult | ContextProvide | ContextUpdate | TranscriptAdmitted | CapabilityResult | Cancel | Shutdown;''')

# --- agent-protocol validation ----------------------------------------------
validation = 'packages/agent-protocol/src/validation.ts'
replace_once(validation,
'''import { AGENT_PROTOCOL_VERSION, type AgentToHostMessage, type HostToAgentMessage } from "./messages.ts";''',
'''import {\n  AGENT_PROTOCOL_VERSION,\n  PROGRAM_EXECUTION_MESSAGE_VERSION,\n  PROGRAM_PLANNING_READ_MAX_BYTES,\n  PROGRAM_PROPOSAL_MAX_BYTES,\n  type AgentToHostMessage,\n  type HostToAgentMessage,\n} from "./messages.ts";''')

replace_once(validation,
'''function hasNumber(value: Record<string, unknown>, key: string): boolean { return typeof value[key] === "number" && Number.isFinite(value[key]); }''',
'''function hasNumber(value: Record<string, unknown>, key: string): boolean { return typeof value[key] === "number" && Number.isFinite(value[key]); }\nfunction hasPositiveInteger(value: Record<string, unknown>, key: string): boolean {\n  return typeof value[key] === "number" && Number.isSafeInteger(value[key]) && Number(value[key]) > 0;\n}\nfunction hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {\n  const allowed = new Set(keys);\n  return Object.keys(value).every((key) => allowed.has(key));\n}\nconst encoder = new TextEncoder();\nfunction withinSerializedBytes(value: unknown, maxBytes: number): boolean {\n  try {\n    const serialized = JSON.stringify(value);\n    return typeof serialized === "string" && encoder.encode(serialized).byteLength <= maxBytes;\n  } catch {\n    return false;\n  }\n}\nfunction isProgramAttemptAuthority(value: unknown): boolean {\n  return isObject(value)\n    && hasOnlyKeys(value, ["programStateId", "expectedProgramRevision", "programAttemptId", "workItemId", "agentGeneration"])\n    && hasString(value, "programStateId")\n    && hasPositiveInteger(value, "expectedProgramRevision")\n    && hasString(value, "programAttemptId")\n    && hasString(value, "workItemId")\n    && hasPositiveInteger(value, "agentGeneration");\n}\nfunction isProgramCreationProposalWire(value: unknown): boolean {\n  return isObject(value)\n    && hasOnlyKeys(value, ["objective", "workItems", "verification", "outputSlots", "productionSteps"])\n    && hasString(value, "objective")\n    && value.objective.length > 0\n    && Array.isArray(value.workItems)\n    && Array.isArray(value.verification)\n    && Array.isArray(value.outputSlots)\n    && Array.isArray(value.productionSteps)\n    && withinSerializedBytes(value, PROGRAM_PROPOSAL_MAX_BYTES);\n}''')

replace_once(validation,
'''    case "capability.request":\n      return hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "toolCallId") && hasString(value, "toolName")\n        && (value.expectedCapabilityRevision === undefined || hasString(value, "expectedCapabilityRevision"));\n    case "context.refresh.request":''',
'''    case "capability.request":\n      return hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "toolCallId") && hasString(value, "toolName")\n        && (value.expectedCapabilityRevision === undefined || hasString(value, "expectedCapabilityRevision"))\n        && (value.programAttemptAuthority === undefined || isProgramAttemptAuthority(value.programAttemptAuthority));\n    case "program.planning.read":\n      return value.version === PROGRAM_EXECUTION_MESSAGE_VERSION\n        && hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "planningEpisodeId")\n        && hasString(value, "readContractId") && hasPositiveInteger(value, "readContractVersion")\n        && withinSerializedBytes(value.args, PROGRAM_PLANNING_READ_MAX_BYTES);\n    case "program.proposal":\n      return value.version === PROGRAM_EXECUTION_MESSAGE_VERSION\n        && hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "planningEpisodeId")\n        && isProgramCreationProposalWire(value.proposal);\n    case "context.refresh.request":''')

replace_once(validation,
'''    case "context.provide":''',
'''    case "program.planning.begin":\n      return value.version === PROGRAM_EXECUTION_MESSAGE_VERSION\n        && hasString(value, "requestId") && hasString(value, "sessionId")\n        && hasString(value, "planningEpisodeId") && hasString(value, "objective");\n    case "program.planning.read.result":\n      return value.version === PROGRAM_EXECUTION_MESSAGE_VERSION\n        && hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "planningEpisodeId")\n        && ["succeeded", "stale", "denied", "failed"].includes(String(value.outcome))\n        && (value.errorCode === undefined || hasString(value, "errorCode"))\n        && (value.error === undefined || hasString(value, "error"));\n    case "program.proposal.result":\n      return value.version === PROGRAM_EXECUTION_MESSAGE_VERSION\n        && hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "planningEpisodeId")\n        && ["sealed", "stale", "denied", "failed"].includes(String(value.outcome))\n        && (value.errorCode === undefined || hasString(value, "errorCode"))\n        && (value.error === undefined || hasString(value, "error"));\n    case "context.provide":''')

# --- agent-protocol exports --------------------------------------------------
index = 'packages/agent-protocol/src/index.ts'
replace_once(index,
'''  PROGRAM_STATE_CAPABILITY,\n  VERBATIM_COMPILER_VERSION,''',
'''  PROGRAM_STATE_CAPABILITY,\n  PROGRAM_EXECUTION_CAPABILITY,\n  PROGRAM_EXECUTION_MESSAGE_VERSION,\n  PROGRAM_PLANNING_READ_MAX_BYTES,\n  PROGRAM_PROPOSAL_MAX_BYTES,\n  VERBATIM_COMPILER_VERSION,''')
replace_once(index,
'''  type ProgramAttemptProjectionV1,\n  type AgentHello,''',
'''  type ProgramAttemptProjectionV1,\n  type ProgramCreationProposalWireV1,\n  type ProgramPlanningReadRequest,\n  type ProgramProposalSubmitted,\n  type ProgramPlanningBegin,\n  type ProgramPlanningReadResult,\n  type ProgramProposalResult,\n  type AgentHello,''')

# --- Host ProgramAgent connection identity helper ---------------------------
program_agent = 'packages/host-runtime/src/program-agent.ts'
replace_once(program_agent,
'''  isCurrent(sessionId: string, agentGeneration: number): boolean {\n    return this.bindings.get(sessionId)?.agentGeneration === agentGeneration;\n  }\n\n  currentAgentGeneration(sessionId: string): number | null {''',
'''  isCurrent(sessionId: string, agentGeneration: number): boolean {\n    return this.bindings.get(sessionId)?.agentGeneration === agentGeneration;\n  }\n\n  isCurrentConnection(sessionId: string, connectionGenerationId: string): boolean {\n    return this.bindings.get(sessionId)?.connectionGenerationId === connectionGenerationId;\n  }\n\n  currentAgentGeneration(sessionId: string): number | null {''')

# --- Host Runtime capability-gated exact Program authority ------------------
host = 'packages/host-runtime/src/host.ts'
replace_once(host,
'''  PROGRAM_STATE_CAPABILITY,\n  type AgentToHostMessage,''',
'''  PROGRAM_STATE_CAPABILITY,\n  PROGRAM_EXECUTION_CAPABILITY,\n  type AgentToHostMessage,\n  type ProgramAttemptAuthorityV1,''')

replace_once(host,
'''function cognitionDescriptors(): AuthorizedToolDescriptor[] {''',
'''function sameProgramAttemptAuthority(\n  left: ProgramAttemptAuthorityV1,\n  right: ProgramAttemptAuthorityV1,\n): boolean {\n  return left.programStateId === right.programStateId\n    && left.expectedProgramRevision === right.expectedProgramRevision\n    && left.programAttemptId === right.programAttemptId\n    && left.workItemId === right.workItemId\n    && left.agentGeneration === right.agentGeneration;\n}\n\nfunction cognitionDescriptors(): AuthorizedToolDescriptor[] {''')

replace_once(host,
'''    const programStateCapable = connection.capabilities?.includes(PROGRAM_STATE_CAPABILITY) ?? false;\n    if (connection.capabilities !== undefined && !durableTranscript) {''',
'''    const programStateCapable = connection.capabilities?.includes(PROGRAM_STATE_CAPABILITY) ?? false;\n    const programExecutionCapable = connection.capabilities?.includes(PROGRAM_EXECUTION_CAPABILITY) ?? false;\n    if (programExecutionCapable && !programStateCapable) {\n      throw new Error(`Agent capability ${PROGRAM_EXECUTION_CAPABILITY} requires ${PROGRAM_STATE_CAPABILITY}`);\n    }\n    if (connection.capabilities !== undefined && !durableTranscript) {''')

replace_once(host,
'''      programStateCapable,\n      systemPrompt,''',
'''      programStateCapable,\n      programExecutionCapable,\n      systemPrompt,''')

replace_once(host,
'''    programStateCapable: boolean,\n    baseSystemPrompt: string,''',
'''    programStateCapable: boolean,\n    programExecutionCapable: boolean,\n    baseSystemPrompt: string,''')

replace_once(host,
'''        let response = this.requestCache.get(cacheKey);\n        if (!response) {\n          if (COGNITION_TOOL_NAMES.has(message.toolName)) {''',
'''        let response = this.requestCache.get(cacheKey);\n        if (!response) {\n          let explicitProgramAuthority: ProgramAttemptAuthorityV1 | undefined;\n          if (programExecutionCapable) {\n            const currentAttempt = await this.programAgents.currentAttemptProjection(sessionId, generationId);\n            if (currentAttempt === undefined || message.programAttemptAuthority === undefined\n                || !sameProgramAttemptAuthority(currentAttempt.authority, message.programAttemptAuthority)) {\n              response = {\n                type: "capability.result", requestId: message.requestId, sessionId: sessionId as string,\n                toolCallId: message.toolCallId, toolName: message.toolName, outcome: "stale",\n                errorCode: "program_execution_stale",\n                error: "Program capability request is not bound to the exact current inference authority",\n              };\n            } else {\n              explicitProgramAuthority = message.programAttemptAuthority;\n            }\n          } else if (message.programAttemptAuthority !== undefined) {\n            response = {\n              type: "capability.result", requestId: message.requestId, sessionId: sessionId as string,\n              toolCallId: message.toolCallId, toolName: message.toolName, outcome: "stale",\n              errorCode: "program_execution_capability_required",\n              error: `Program authority binding requires ${PROGRAM_EXECUTION_CAPABILITY}`,\n            };\n          }\n\n          if (response === undefined && COGNITION_TOOL_NAMES.has(message.toolName)) {''')

replace_once(host,
'''          } else {\n            const result = await this.capabilityBroker.execute({''',
'''          } else if (response === undefined) {\n            const result = await this.capabilityBroker.execute({''')

replace_once(host,
'''              ...(message.expectedCapabilityRevision !== undefined ? { expectedCapabilityRevision: message.expectedCapabilityRevision } : {}),\n            });''',
'''              ...(message.expectedCapabilityRevision !== undefined ? { expectedCapabilityRevision: message.expectedCapabilityRevision } : {}),\n              ...(explicitProgramAuthority !== undefined ? { program: explicitProgramAuthority } : {}),\n            });''')

# --- new Host Program planning service --------------------------------------
Path('packages/host-runtime/src/program-planning.ts').write_text(r'''import {
  PROGRAM_EXECUTION_MESSAGE_VERSION,
  type AgentToHostMessage,
  type ProgramPlanningBegin,
  type ProgramPlanningReadResult,
  type ProgramProposalResult,
} from "@alcode/agent-protocol";
import { uuidv7, type PersistedDomainEvent, type SessionId } from "@alcode/events";
import type { Json } from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import { ProgramAgentServiceV1 } from "./program-agent.ts";
import {
  ProgramCreationControlError,
  ProgramCreationServiceV1,
  ProgramCreationStaleError,
  type ProgramCreationProposalV1,
} from "./program-creation.ts";
import { PlanningReadError, PlanningReadRegistry, TrackedPlanningReads } from "./planning-read.ts";

export const PROGRAM_PLANNING_MAX_CACHED_RESPONSES = 256;

interface ProgramPlanningEpisodeV1 {
  planningEpisodeId: string;
  sourceSessionId: SessionId;
  connectionGenerationId: string;
  agentGeneration: number;
  objective: string;
  sourceObjectiveEventId: string;
  planningReads: TrackedPlanningReads;
  submitted: boolean;
}

export type ProgramPlanningResponseV1 = ProgramPlanningReadResult | ProgramProposalResult;

export interface ProgramPlanningServiceOptionsV1 {
  store: WorkspaceEventStore;
  planningReads: PlanningReadRegistry;
  creation: ProgramCreationServiceV1;
  agents: ProgramAgentServiceV1;
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
    if (!this.options.agents.isCurrent(sessionId, input.agentGeneration)
        || !this.options.agents.isCurrentConnection(sessionId, input.connectionGenerationId)) {
      throw new ProgramPlanningStaleError("Planning Agent authority is stale");
    }

    const sourceObjectiveEventId = objectiveSourceEventId(
      await replayAll(this.options.store),
      sessionId,
      input.objective,
    );
    const previous = this.activeBySession.get(sessionId);
    if (previous !== undefined) this.episodes.delete(previous);

    const planningEpisodeId = uuidv7();
    const episode: ProgramPlanningEpisodeV1 = {
      planningEpisodeId,
      sourceSessionId: input.sourceSessionId,
      connectionGenerationId: input.connectionGenerationId,
      agentGeneration: input.agentGeneration,
      objective: input.objective,
      sourceObjectiveEventId,
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
        || !this.options.agents.isCurrent(String(input.sessionId), input.agentGeneration)
        || !this.options.agents.isCurrentConnection(String(input.sessionId), input.connectionGenerationId)) {
      const result = this.failureFor(message, "stale", "program_planning_stale", "Planning episode or Agent authority is stale");
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
      } else if (message.proposal.objective !== episode.objective) {
        response = this.failureFor(message, "denied", "program_planning_objective_mismatch", "Program proposal objective differs from the Host planning objective");
      } else {
        episode.submitted = true;
        try {
          await this.options.creation.sealDraft({
            sourceSessionId: episode.sourceSessionId,
            proposal: message.proposal as ProgramCreationProposalV1,
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
            stale ? "program_planning_stale" : controlled ? "program_proposal_invalid" : "program_proposal_failed",
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          this.episodes.delete(episode.planningEpisodeId);
          if (this.activeBySession.get(String(episode.sourceSessionId)) === episode.planningEpisodeId) {
            this.activeBySession.delete(String(episode.sourceSessionId));
          }
        }
      }
    }

    this.cache(cacheKey, response);
    return response;
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
''')

# --- Program execution runtime bridge ---------------------------------------
runtime = 'packages/host-runtime/src/program-execution-runtime.ts'
replace_once(runtime,
'''import type { WorkspaceEventStore } from "@alcode/storage";''',
'''import {\n  PROGRAM_EXECUTION_CAPABILITY,\n  PROGRAM_STATE_CAPABILITY,\n  type ProgramPlanningBegin,\n} from "@alcode/agent-protocol";\nimport type { WorkspaceEventStore } from "@alcode/storage";''')
replace_once(runtime,
'''import type { ApplicationAgentControl } from "./application-service.ts";''',
'''import type { AgentConnection } from "./agent-supervisor.ts";\nimport type { ApplicationAgentControl } from "./application-service.ts";''')
replace_once(runtime,
'''import { HostRuntime, type HostRuntimeOptions } from "./host.ts";''',
'''import {\n  HostRuntime,\n  type AgentResumeReason,\n  type AttachedAgent,\n  type HostRuntimeOptions,\n} from "./host.ts";''')
replace_once(runtime,
'''import type { PlanningReadRegistry } from "./planning-read.ts";''',
'''import type { PlanningReadRegistry } from "./planning-read.ts";\nimport { ProgramPlanningControlError, ProgramPlanningServiceV1 } from "./program-planning.ts";''')
replace_once(runtime,
'''import { HostProgramApplicationControlV1 } from "./program-application.ts";''',
'''import { HostProgramApplicationControlV1 } from "./program-application.ts";\nimport type { HostSessionHandle } from "./session-manager.ts";''')
replace_once(runtime,
'''  readonly creation: ProgramCreationServiceV1;\n  readonly recovery: Phase1RecoveryControllerV1;''',
'''  readonly creation: ProgramCreationServiceV1;\n  readonly planning: ProgramPlanningServiceV1;\n  readonly recovery: Phase1RecoveryControllerV1;''')
replace_once(runtime,
'''    this.recovery = new Phase1RecoveryControllerV1({''',
'''    this.planning = new ProgramPlanningServiceV1({\n      store: this.store,\n      planningReads: options.planningReads,\n      creation: this.creation,\n      agents: this.host.programAgents,\n    });\n\n    this.recovery = new Phase1RecoveryControllerV1({''')
replace_once(runtime,
'''  createApplicationService(agent: ApplicationAgentControl, maxReplayEvents?: number): HostApplicationService {''',
'''  async attachAgent(\n    connection: AgentConnection,\n    session: HostSessionHandle,\n    systemPrompt: string,\n    resumeReason: AgentResumeReason = "reattach",\n  ): Promise<AttachedAgent> {\n    const capabilities = connection.capabilities ?? [];\n    const programStateCapable = capabilities.includes(PROGRAM_STATE_CAPABILITY);\n    const programExecutionCapable = capabilities.includes(PROGRAM_EXECUTION_CAPABILITY);\n    if (programExecutionCapable && !programStateCapable) {\n      throw new ProgramPlanningControlError(\n        `${PROGRAM_EXECUTION_CAPABILITY} requires ${PROGRAM_STATE_CAPABILITY}`,\n      );\n    }\n\n    const attached = await this.host.attachAgent(connection, session, systemPrompt, resumeReason);\n    if (!programExecutionCapable) return attached;\n    const agentGeneration = this.host.programAgents.currentAgentGeneration(String(session.sessionId));\n    if (agentGeneration === null) {\n      attached.detach();\n      throw new ProgramPlanningControlError("Attached Program Agent lacks current generation authority");\n    }\n\n    const unsubscribePlanning = connection.transport.onMessage(async (message) => {\n      const response = await this.planning.handleAgentMessage({\n        connectionGenerationId: connection.generationId,\n        agentGeneration,\n        sessionId: session.sessionId,\n        message,\n      });\n      if (response !== undefined) {\n        try { await connection.transport.send(response); } catch {}\n      }\n    });\n    return {\n      generationId: attached.generationId,\n      detach: () => {\n        unsubscribePlanning();\n        attached.detach();\n      },\n    };\n  }\n\n  async beginPlanning(\n    connection: AgentConnection,\n    session: HostSessionHandle,\n    objective: string,\n  ): Promise<ProgramPlanningBegin> {\n    const capabilities = connection.capabilities ?? [];\n    if (!capabilities.includes(PROGRAM_STATE_CAPABILITY)\n        || !capabilities.includes(PROGRAM_EXECUTION_CAPABILITY)) {\n      throw new ProgramPlanningControlError(\n        `Program planning requires ${PROGRAM_STATE_CAPABILITY} and ${PROGRAM_EXECUTION_CAPABILITY}`,\n      );\n    }\n    const sessionId = String(session.sessionId);\n    if (!this.host.programAgents.isCurrentConnection(sessionId, connection.generationId)) {\n      throw new ProgramPlanningControlError("Planning connection is not the current Agent connection");\n    }\n    const agentGeneration = this.host.programAgents.currentAgentGeneration(sessionId);\n    if (agentGeneration === null) throw new ProgramPlanningControlError("Planning Agent generation is unavailable");\n    const begin = await this.planning.begin({\n      sourceSessionId: session.sessionId,\n      connectionGenerationId: connection.generationId,\n      agentGeneration,\n      objective,\n    });\n    await connection.transport.send(begin);\n    return begin;\n  }\n\n  createApplicationService(agent: ApplicationAgentControl, maxReplayEvents?: number): HostApplicationService {''')

# --- host-runtime exports ----------------------------------------------------
host_index = 'packages/host-runtime/src/index.ts'
replace_once(host_index,
'''export {\n  ProgramCreationServiceV1,''',
'''export {\n  ProgramPlanningServiceV1,\n  ProgramPlanningControlError,\n  ProgramPlanningStaleError,\n  PROGRAM_PLANNING_MAX_CACHED_RESPONSES,\n  type ProgramPlanningServiceOptionsV1,\n  type ProgramPlanningResponseV1,\n} from "./program-planning.ts";\n\nexport {\n  ProgramCreationServiceV1,''')

# --- protocol tests ----------------------------------------------------------
Path('packages/agent-protocol/src/program-execution-protocol.test.ts').write_text(r'''import { describe, expect, it } from "vitest";
import {
  PROGRAM_EXECUTION_CAPABILITY,
  PROGRAM_EXECUTION_MESSAGE_VERSION,
  isAgentToHostMessage,
  isHostToAgentMessage,
} from "./index.ts";

describe("program_execution_v1 protocol", () => {
  it("keeps the additive capability separate from program_state_v1", () => {
    expect(PROGRAM_EXECUTION_CAPABILITY).toBe("program_execution_v1");
    expect(PROGRAM_EXECUTION_MESSAGE_VERSION).toBe(1);
  });

  it("validates bounded planning reads and Program proposals", () => {
    expect(isAgentToHostMessage({
      type: "program.planning.read",
      version: 1,
      requestId: "read-1",
      sessionId: "session-1",
      planningEpisodeId: "episode-1",
      readContractId: "workspace.read.v1",
      readContractVersion: 1,
      args: { path: "src/a.ts" },
    })).toBe(true);

    const proposal = {
      objective: "Update src/a.ts",
      workItems: [],
      verification: [],
      outputSlots: [],
      productionSteps: [],
    };
    expect(isAgentToHostMessage({
      type: "program.proposal",
      version: 1,
      requestId: "proposal-1",
      sessionId: "session-1",
      planningEpisodeId: "episode-1",
      proposal,
    })).toBe(true);
    expect(isAgentToHostMessage({
      type: "program.proposal",
      version: 1,
      requestId: "proposal-2",
      sessionId: "session-1",
      planningEpisodeId: "episode-1",
      proposal: { ...proposal, programStateId: "agent-chosen" },
    })).toBe(false);
  });

  it("accepts only complete inference-bound ProgramAttempt authority", () => {
    const base = {
      type: "capability.request",
      requestId: "cap-1",
      sessionId: "session-1",
      toolCallId: "call-1",
      toolName: "read_file",
      args: { path: "src/a.ts" },
    };
    expect(isAgentToHostMessage({
      ...base,
      programAttemptAuthority: {
        programStateId: "program-1",
        expectedProgramRevision: 2,
        programAttemptId: "attempt-1",
        workItemId: "work-1",
        agentGeneration: 3,
      },
    })).toBe(true);
    expect(isAgentToHostMessage({
      ...base,
      programAttemptAuthority: {
        programStateId: "program-1",
        expectedProgramRevision: 2,
        programAttemptId: "attempt-1",
        workItemId: "work-1",
      },
    })).toBe(false);
  });

  it("validates Host planning responses", () => {
    expect(isHostToAgentMessage({
      type: "program.planning.begin",
      version: 1,
      requestId: "begin-1",
      sessionId: "session-1",
      planningEpisodeId: "episode-1",
      objective: "Update src/a.ts",
    })).toBe(true);
    expect(isHostToAgentMessage({
      type: "program.proposal.result",
      version: 1,
      requestId: "proposal-1",
      sessionId: "session-1",
      planningEpisodeId: "episode-1",
      outcome: "sealed",
    })).toBe(true);
  });
});
''')

# --- host planning tests -----------------------------------------------------
Path('packages/host-runtime/src/program-planning.test.ts').write_text(r'''import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asWorkspaceId, mkEventId } from "@alcode/events";
import {
  asProgramWorkItemId,
  asVerificationObligationId,
  type Json,
} from "@alcode/program-state";
import { openLockedWorkspaceStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { ProgramAgentServiceV1 } from "./program-agent.ts";
import {
  ProgramCreationServiceV1,
  type ExecutionObservationProfileAuthorityV1,
  type PlanningReadBarrierV1,
  type ProgramCreationPolicySourceV1,
} from "./program-creation.ts";
import { ProgramPlanningServiceV1, ProgramPlanningStaleError } from "./program-planning.ts";
import { PlanningReadRegistry, type PlanningReadContractV1 } from "./planning-read.ts";
import { HostSessionManager } from "./session-manager.ts";

class ImmediateBarrier implements PlanningReadBarrierV1 {
  runExclusive<T>(work: () => Promise<T>): Promise<T> { return work(); }
}

function fileContract(files: Map<string, string>): PlanningReadContractV1 {
  return {
    readContractId: "file.read.v1",
    readContractVersion: 1,
    maxCanonicalArgsBytes: 1024,
    maxCanonicalResultBytes: 64 * 1024,
    normalizeArgs(input: Json): Json {
      const path = (input as { path?: unknown }).path;
      if (typeof path !== "string" || path.length === 0) throw new Error("path required");
      return { path };
    },
    async execute(canonicalArgs) {
      const path = (canonicalArgs as { path: string }).path;
      return {
        result: files.has(path) ? { kind: "file", text: files.get(path)! } : { kind: "absent" },
        complete: true,
        coverageIdentity: "workspace-files-v1",
        providerBindingRevision: "provider-1",
      };
    },
  };
}

const policy: ProgramCreationPolicySourceV1 = {
  current: () => ({ generation: "policy-1", digest: "policy-digest-1", requirements: [] }),
};
const executionProfiles: ExecutionObservationProfileAuthorityV1 = {
  current: () => ({ profileId: "workspace-observation-v1", profileVersion: 1, coverageIdentity: "local-complete-v1" }),
  validate: () => undefined,
};

async function appendObjective(admission: CanonicalAdmissionQueue, workspaceId: string, sessionId: any, objective: string) {
  await admission.append([{
    eventId: mkEventId(),
    workspaceId: asWorkspaceId(workspaceId),
    sessionId,
    occurredAt: new Date().toISOString(),
    type: "user.message.appended",
    payload: { text: objective, timestamp: Date.now() },
    payloadSchemaVersion: 1,
    producer: { kind: "user" },
  }]);
}

async function allEvents(store: { replay(): AsyncIterable<any> }): Promise<any[]> {
  const events: any[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

const describeLocked = process.platform === "win32" ? describe.skip : describe;

describeLocked("Program planning bridge", () => {
  it("tracks Host planning reads, seals one Agent proposal, and deduplicates request retry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-planning-"));
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: "018f0000-0000-7000-8000-000000000401",
      repositoryId: "program-planning-test",
    });
    const admission = new CanonicalAdmissionQueue(locked.store);
    const sessions = new HostSessionManager(locked, admission);
    const session = await sessions.openOrResume();
    const objective = "Update src/a.ts through the Program planning bridge";
    await appendObjective(admission, locked.store.workspaceId, session.sessionId, objective);

    const files = new Map([["src/a.ts", "before"]]);
    const registry = new PlanningReadRegistry("planning-files-v1", 1, [fileContract(files)]);
    const creation = new ProgramCreationServiceV1({
      store: locked.store,
      admission,
      planningReads: registry,
      planningBarrier: new ImmediateBarrier(),
      policy,
      executionObservationProfiles: executionProfiles,
    });
    const agents = new ProgramAgentServiceV1(locked.store, admission);
    const agentGeneration = await agents.attach(session.sessionId, "connection-1", true);
    const planning = new ProgramPlanningServiceV1({ store: locked.store, planningReads: registry, creation, agents });
    const begin = await planning.begin({
      sourceSessionId: session.sessionId,
      connectionGenerationId: "connection-1",
      agentGeneration,
      objective,
    });

    const read = await planning.handleAgentMessage({
      connectionGenerationId: "connection-1",
      agentGeneration,
      sessionId: session.sessionId,
      message: {
        type: "program.planning.read",
        version: 1,
        requestId: "read-1",
        sessionId: String(session.sessionId),
        planningEpisodeId: begin.planningEpisodeId,
        readContractId: "file.read.v1",
        readContractVersion: 1,
        args: { path: "src/a.ts" },
      },
    });
    expect(read).toMatchObject({ outcome: "succeeded", result: { kind: "file", text: "before" } });

    const workItemId = asProgramWorkItemId("work-1");
    const proposalMessage = {
      type: "program.proposal" as const,
      version: 1 as const,
      requestId: "proposal-1",
      sessionId: String(session.sessionId),
      planningEpisodeId: begin.planningEpisodeId,
      proposal: {
        objective,
        workItems: [{
          workItemId,
          creationOrder: 0,
          description: "Update the file",
          dependencyIds: [],
          affectedPaths: ["src/a.ts"],
        }],
        verification: [{
          obligationId: asVerificationObligationId("verify-a"),
          predicate: { kind: "workspace_path_state" as const, path: "src/a.ts", requiredState: "file" as const },
          freshnessScope: { kind: "paths" as const, entries: [{ path: "src/a.ts", mode: "exact" as const }] },
        }],
        outputSlots: [],
        productionSteps: [],
      },
    };
    const sealed = await planning.handleAgentMessage({
      connectionGenerationId: "connection-1",
      agentGeneration,
      sessionId: session.sessionId,
      message: proposalMessage,
    });
    expect(sealed).toMatchObject({ outcome: "sealed" });

    const duplicate = await planning.handleAgentMessage({
      connectionGenerationId: "connection-1",
      agentGeneration,
      sessionId: session.sessionId,
      message: proposalMessage,
    });
    expect(duplicate).toEqual(sealed);
    const events = await allEvents(locked.store);
    const drafts = events.filter((event) => event.type === "program.creation.draft.sealed");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].payload.draft.planningObservationIdentity.dependencies).toHaveLength(1);
    expect(events.some((event) => event.type === "program.created")).toBe(false);
    locked.close();
  });

  it("fails stale for replaced Agent authority and for a stopped source Session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-planning-stale-"));
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: "018f0000-0000-7000-8000-000000000402",
      repositoryId: "program-planning-stale-test",
    });
    const admission = new CanonicalAdmissionQueue(locked.store);
    const sessions = new HostSessionManager(locked, admission);
    const session = await sessions.openOrResume();
    const objective = "Inspect src/a.ts";
    await appendObjective(admission, locked.store.workspaceId, session.sessionId, objective);
    const registry = new PlanningReadRegistry("planning-files-v1", 1, [fileContract(new Map([["src/a.ts", "before"]]))]);
    const creation = new ProgramCreationServiceV1({
      store: locked.store,
      admission,
      planningReads: registry,
      planningBarrier: new ImmediateBarrier(),
      policy,
      executionObservationProfiles: executionProfiles,
    });
    const agents = new ProgramAgentServiceV1(locked.store, admission);
    const generation1 = await agents.attach(session.sessionId, "connection-1", true);
    const planning = new ProgramPlanningServiceV1({ store: locked.store, planningReads: registry, creation, agents });
    const begin = await planning.begin({
      sourceSessionId: session.sessionId,
      connectionGenerationId: "connection-1",
      agentGeneration: generation1,
      objective,
    });
    await agents.attach(session.sessionId, "connection-2", true);
    const replaced = await planning.handleAgentMessage({
      connectionGenerationId: "connection-1",
      agentGeneration: generation1,
      sessionId: session.sessionId,
      message: {
        type: "program.planning.read",
        version: 1,
        requestId: "read-stale",
        sessionId: String(session.sessionId),
        planningEpisodeId: begin.planningEpisodeId,
        readContractId: "file.read.v1",
        readContractVersion: 1,
        args: { path: "src/a.ts" },
      },
    });
    expect(replaced).toMatchObject({ outcome: "stale", errorCode: "program_planning_stale" });

    const generation2 = agents.currentAgentGeneration(String(session.sessionId))!;
    const begin2 = await planning.begin({
      sourceSessionId: session.sessionId,
      connectionGenerationId: "connection-2",
      agentGeneration: generation2,
      objective,
    });
    await sessions.stop(session.sessionId, "cancelled");
    const stopped = await planning.handleAgentMessage({
      connectionGenerationId: "connection-2",
      agentGeneration: generation2,
      sessionId: session.sessionId,
      message: {
        type: "program.proposal",
        version: 1,
        requestId: "proposal-stopped",
        sessionId: String(session.sessionId),
        planningEpisodeId: begin2.planningEpisodeId,
        proposal: { objective, workItems: [], verification: [], outputSlots: [], productionSteps: [] },
      },
    });
    expect(stopped).toMatchObject({ outcome: "stale", errorCode: "program_planning_stale" });
    locked.close();
  });

  it("rejects begin when the connection is not current", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-planning-authority-"));
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: "018f0000-0000-7000-8000-000000000403",
      repositoryId: "program-planning-authority-test",
    });
    const admission = new CanonicalAdmissionQueue(locked.store);
    const sessions = new HostSessionManager(locked, admission);
    const session = await sessions.openOrResume();
    const objective = "Inspect src/a.ts";
    await appendObjective(admission, locked.store.workspaceId, session.sessionId, objective);
    const registry = new PlanningReadRegistry("planning-files-v1", 1, [fileContract(new Map())]);
    const creation = new ProgramCreationServiceV1({
      store: locked.store,
      admission,
      planningReads: registry,
      planningBarrier: new ImmediateBarrier(),
      policy,
      executionObservationProfiles: executionProfiles,
    });
    const agents = new ProgramAgentServiceV1(locked.store, admission);
    const generation = await agents.attach(session.sessionId, "connection-current", true);
    const planning = new ProgramPlanningServiceV1({ store: locked.store, planningReads: registry, creation, agents });
    await expect(planning.begin({
      sourceSessionId: session.sessionId,
      connectionGenerationId: "connection-stale",
      agentGeneration: generation,
      objective,
    })).rejects.toBeInstanceOf(ProgramPlanningStaleError);
    locked.close();
  });
});
''')

print('phase 1.1 planning bridge patch applied')
