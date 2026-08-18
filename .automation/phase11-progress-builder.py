from pathlib import Path

ROOT = Path('.')


def replace_once(path: str, old: str, new: str) -> None:
    p = ROOT / path
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'missing patch anchor in {path}: {old[:160]!r}')
    if text.count(old) != 1:
        raise SystemExit(f'non-unique patch anchor in {path}: {text.count(old)} matches')
    p.write_text(text.replace(old, new, 1))


messages = 'packages/agent-protocol/src/messages.ts'
replace_once(messages,
'''export const PROGRAM_PLANNING_READ_MAX_BYTES = 1024 * 1024;\nexport const PROGRAM_PROPOSAL_MAX_BYTES = 4 * 1024 * 1024;''',
'''export const PROGRAM_PLANNING_READ_MAX_BYTES = 1024 * 1024;\nexport const PROGRAM_PROPOSAL_MAX_BYTES = 4 * 1024 * 1024;\nexport const PROGRAM_PROGRESS_MAX_BYTES = 64 * 1024;\nexport const PROGRAM_PROGRESS_BLOCKER_REASON_MAX_CHARS = 4096;''')

replace_once(messages,
'''export interface ProgramProposalSubmitted {\n  type: "program.proposal";\n  version: typeof PROGRAM_EXECUTION_MESSAGE_VERSION;\n  requestId: ProtocolRequestId;\n  sessionId: string;\n  planningEpisodeId: string;\n  proposal: ProgramCreationProposalWireV1;\n}\n\nexport interface AgentHello''',
'''export interface ProgramProposalSubmitted {\n  type: "program.proposal";\n  version: typeof PROGRAM_EXECUTION_MESSAGE_VERSION;\n  requestId: ProtocolRequestId;\n  sessionId: string;\n  planningEpisodeId: string;\n  proposal: ProgramCreationProposalWireV1;\n}\n\nexport type ProgramProgressIntentV1 =\n  | { kind: "evidence.add"; sourceOperationId?: string; artifactRef?: string }\n  | { kind: "blocker.report"; scope: "program" | "work"; reason: string }\n  | { kind: "blocker.resolve"; advisoryBlockerId: string }\n  | { kind: "work.awaiting_verification" };\n\nexport interface ProgramProgressSubmitted {\n  type: "program.progress";\n  version: typeof PROGRAM_EXECUTION_MESSAGE_VERSION;\n  requestId: ProtocolRequestId;\n  sessionId: string;\n  authority: ProgramAttemptAuthorityV1;\n  intent: ProgramProgressIntentV1;\n}\n\nexport interface AgentHello''')

replace_once(messages,
'''export type AgentToHostMessage = AgentHello | AssistantMessageProduced | ToolResultProduced | CapabilityRequest | ProgramPlanningReadRequest | ProgramProposalSubmitted | ContextRefreshRequest | CriterionEvidence | AgentIdle | AgentError;''',
'''export type AgentToHostMessage = AgentHello | AssistantMessageProduced | ToolResultProduced | CapabilityRequest | ProgramPlanningReadRequest | ProgramProposalSubmitted | ProgramProgressSubmitted | ContextRefreshRequest | CriterionEvidence | AgentIdle | AgentError;''')

replace_once(messages,
'''export interface ProgramProposalResult {\n  type: "program.proposal.result";\n  version: typeof PROGRAM_EXECUTION_MESSAGE_VERSION;\n  requestId: ProtocolRequestId;\n  sessionId: string;\n  planningEpisodeId: string;\n  outcome: "sealed" | "stale" | "denied" | "failed";\n  errorCode?: string;\n  error?: string;\n}\n\nexport interface HostHello''',
'''export interface ProgramProposalResult {\n  type: "program.proposal.result";\n  version: typeof PROGRAM_EXECUTION_MESSAGE_VERSION;\n  requestId: ProtocolRequestId;\n  sessionId: string;\n  planningEpisodeId: string;\n  outcome: "sealed" | "stale" | "denied" | "failed";\n  errorCode?: string;\n  error?: string;\n}\n\nexport interface ProgramProgressResult {\n  type: "program.progress.result";\n  version: typeof PROGRAM_EXECUTION_MESSAGE_VERSION;\n  requestId: ProtocolRequestId;\n  sessionId: string;\n  outcome: "accepted" | "stale" | "denied" | "failed";\n  programRevision?: number;\n  evidenceRefId?: string;\n  advisoryBlockerId?: string;\n  errorCode?: string;\n  error?: string;\n}\n\nexport interface HostHello''')

replace_once(messages,
'''export type HostToAgentMessage = HostHello | SessionOpen | SessionResume | InputAdmitted | ProgramPlanningBegin | ProgramPlanningReadResult | ProgramProposalResult | ContextProvide | ContextUpdate | TranscriptAdmitted | CapabilityResult | Cancel | Shutdown;''',
'''export type HostToAgentMessage = HostHello | SessionOpen | SessionResume | InputAdmitted | ProgramPlanningBegin | ProgramPlanningReadResult | ProgramProposalResult | ProgramProgressResult | ContextProvide | ContextUpdate | TranscriptAdmitted | CapabilityResult | Cancel | Shutdown;''')

validation = 'packages/agent-protocol/src/validation.ts'
replace_once(validation,
'''  PROGRAM_PLANNING_READ_MAX_BYTES,\n  PROGRAM_PROPOSAL_MAX_BYTES,''',
'''  PROGRAM_PLANNING_READ_MAX_BYTES,\n  PROGRAM_PROPOSAL_MAX_BYTES,\n  PROGRAM_PROGRESS_MAX_BYTES,\n  PROGRAM_PROGRESS_BLOCKER_REASON_MAX_CHARS,''')

replace_once(validation,
'''function isProgramCreationProposalWire(value: unknown): boolean {\n  return isObject(value)\n    && hasOnlyKeys(value, ["objective", "workItems", "verification", "outputSlots", "productionSteps"])\n    && hasString(value, "objective")\n    && (value.objective as string).length > 0\n    && Array.isArray(value.workItems)\n    && Array.isArray(value.verification)\n    && Array.isArray(value.outputSlots)\n    && Array.isArray(value.productionSteps)\n    && withinSerializedBytes(value, PROGRAM_PROPOSAL_MAX_BYTES);\n}\n''',
'''function isProgramCreationProposalWire(value: unknown): boolean {\n  return isObject(value)\n    && hasOnlyKeys(value, ["objective", "workItems", "verification", "outputSlots", "productionSteps"])\n    && hasString(value, "objective")\n    && (value.objective as string).length > 0\n    && Array.isArray(value.workItems)\n    && Array.isArray(value.verification)\n    && Array.isArray(value.outputSlots)\n    && Array.isArray(value.productionSteps)\n    && withinSerializedBytes(value, PROGRAM_PROPOSAL_MAX_BYTES);\n}\n\nfunction isProgramProgressIntent(value: unknown): boolean {\n  if (!isObject(value) || typeof value.kind !== "string") return false;\n  switch (value.kind) {\n    case "evidence.add":\n      return hasOnlyKeys(value, ["kind", "sourceOperationId", "artifactRef"])\n        && (value.sourceOperationId === undefined || (hasString(value, "sourceOperationId") && (value.sourceOperationId as string).length > 0))\n        && (value.artifactRef === undefined || (hasString(value, "artifactRef") && (value.artifactRef as string).length > 0))\n        && (value.sourceOperationId !== undefined || value.artifactRef !== undefined);\n    case "blocker.report":\n      return hasOnlyKeys(value, ["kind", "scope", "reason"])\n        && ["program", "work"].includes(String(value.scope))\n        && hasString(value, "reason")\n        && (value.reason as string).length > 0\n        && (value.reason as string).length <= PROGRAM_PROGRESS_BLOCKER_REASON_MAX_CHARS;\n    case "blocker.resolve":\n      return hasOnlyKeys(value, ["kind", "advisoryBlockerId"])\n        && hasString(value, "advisoryBlockerId") && (value.advisoryBlockerId as string).length > 0;\n    case "work.awaiting_verification":\n      return hasOnlyKeys(value, ["kind"]);\n    default:\n      return false;\n  }\n}\n''')

replace_once(validation,
'''    case "program.proposal":\n      return value.version === PROGRAM_EXECUTION_MESSAGE_VERSION\n        && hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "planningEpisodeId")\n        && isProgramCreationProposalWire(value.proposal);\n    case "context.refresh.request":''',
'''    case "program.proposal":\n      return value.version === PROGRAM_EXECUTION_MESSAGE_VERSION\n        && hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "planningEpisodeId")\n        && isProgramCreationProposalWire(value.proposal);\n    case "program.progress":\n      return value.version === PROGRAM_EXECUTION_MESSAGE_VERSION\n        && hasString(value, "requestId") && hasString(value, "sessionId")\n        && isProgramAttemptAuthority(value.authority)\n        && isProgramProgressIntent(value.intent)\n        && withinSerializedBytes(value, PROGRAM_PROGRESS_MAX_BYTES);\n    case "context.refresh.request":''')

replace_once(validation,
'''    case "program.proposal.result":\n      return value.version === PROGRAM_EXECUTION_MESSAGE_VERSION\n        && hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "planningEpisodeId")\n        && ["sealed", "stale", "denied", "failed"].includes(String(value.outcome))\n        && (value.errorCode === undefined || hasString(value, "errorCode"))\n        && (value.error === undefined || hasString(value, "error"));\n    case "context.provide":''',
'''    case "program.proposal.result":\n      return value.version === PROGRAM_EXECUTION_MESSAGE_VERSION\n        && hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "planningEpisodeId")\n        && ["sealed", "stale", "denied", "failed"].includes(String(value.outcome))\n        && (value.errorCode === undefined || hasString(value, "errorCode"))\n        && (value.error === undefined || hasString(value, "error"));\n    case "program.progress.result":\n      return value.version === PROGRAM_EXECUTION_MESSAGE_VERSION\n        && hasString(value, "requestId") && hasString(value, "sessionId")\n        && ["accepted", "stale", "denied", "failed"].includes(String(value.outcome))\n        && (value.programRevision === undefined || hasPositiveInteger(value, "programRevision"))\n        && (value.evidenceRefId === undefined || hasString(value, "evidenceRefId"))\n        && (value.advisoryBlockerId === undefined || hasString(value, "advisoryBlockerId"))\n        && (value.errorCode === undefined || hasString(value, "errorCode"))\n        && (value.error === undefined || hasString(value, "error"));\n    case "context.provide":''')

index = 'packages/agent-protocol/src/index.ts'
replace_once(index,
'''  PROGRAM_PLANNING_READ_MAX_BYTES,\n  PROGRAM_PROPOSAL_MAX_BYTES,''',
'''  PROGRAM_PLANNING_READ_MAX_BYTES,\n  PROGRAM_PROPOSAL_MAX_BYTES,\n  PROGRAM_PROGRESS_MAX_BYTES,\n  PROGRAM_PROGRESS_BLOCKER_REASON_MAX_CHARS,''')
replace_once(index,
'''  type ProgramProposalSubmitted,\n  type ProgramPlanningBegin,''',
'''  type ProgramProposalSubmitted,\n  type ProgramProgressIntentV1,\n  type ProgramProgressSubmitted,\n  type ProgramPlanningBegin,''')
replace_once(index,
'''  type ProgramPlanningReadResult,\n  type ProgramProposalResult,''',
'''  type ProgramPlanningReadResult,\n  type ProgramProposalResult,\n  type ProgramProgressResult,''')

protocol_test = 'packages/agent-protocol/src/program-execution-protocol.test.ts'
replace_once(protocol_test,
'''  it("accepts only complete inference-bound ProgramAttempt authority", () => {''',
'''  it("validates only the four bounded Agent progress intents", () => {\n    const authority = {\n      programStateId: "program-1",\n      expectedProgramRevision: 2,\n      programAttemptId: "attempt-1",\n      workItemId: "work-1",\n      agentGeneration: 3,\n    };\n    const base = {\n      type: "program.progress",\n      version: 1,\n      requestId: "progress-1",\n      sessionId: "session-1",\n      authority,\n    };\n    expect(isAgentToHostMessage({ ...base, intent: { kind: "evidence.add", artifactRef: "artifact:1" } })).toBe(true);\n    expect(isAgentToHostMessage({ ...base, intent: { kind: "blocker.report", scope: "work", reason: "Need upstream API" } })).toBe(true);\n    expect(isAgentToHostMessage({ ...base, intent: { kind: "blocker.resolve", advisoryBlockerId: "advisory-1" } })).toBe(true);\n    expect(isAgentToHostMessage({ ...base, intent: { kind: "work.awaiting_verification" } })).toBe(true);\n    expect(isAgentToHostMessage({ ...base, intent: { kind: "program.complete" } })).toBe(false);\n    expect(isAgentToHostMessage({ ...base, intent: { kind: "verification.satisfy", obligationId: "verify-1" } })).toBe(false);\n    expect(isAgentToHostMessage({ ...base, intent: { kind: "blocker.report", scope: "work", reason: "x".repeat(4097) } })).toBe(false);\n  });\n\n  it("accepts only complete inference-bound ProgramAttempt authority", () => {''')
replace_once(protocol_test,
'''    expect(isHostToAgentMessage({\n      type: "program.proposal.result",\n      version: 1,\n      requestId: "proposal-1",\n      sessionId: "session-1",\n      planningEpisodeId: "episode-1",\n      outcome: "sealed",\n    })).toBe(true);\n  });''',
'''    expect(isHostToAgentMessage({\n      type: "program.proposal.result",\n      version: 1,\n      requestId: "proposal-1",\n      sessionId: "session-1",\n      planningEpisodeId: "episode-1",\n      outcome: "sealed",\n    })).toBe(true);\n    expect(isHostToAgentMessage({\n      type: "program.progress.result",\n      version: 1,\n      requestId: "progress-1",\n      sessionId: "session-1",\n      outcome: "accepted",\n      programRevision: 3,\n    })).toBe(true);\n  });''')

progress_path = ROOT / 'packages/host-runtime/src/program-progress.ts'
if progress_path.exists():
    raise SystemExit('program-progress.ts already exists')
progress_path.write_text(r'''import {
  PROGRAM_EXECUTION_MESSAGE_VERSION,
  type AgentToHostMessage,
  type ProgramAttemptAuthorityV1,
  type ProgramProgressResult,
} from "@alcode/agent-protocol";
import {
  asProgramStateId as asEventProgramStateId,
  asWorkspaceId,
  mkEventId,
  uuidv7,
  type EventDraft,
  type PersistedDomainEvent,
  type SessionId,
} from "@alcode/events";
import {
  applyProgramTransition,
  asOperationId,
  asProgramEvidenceRefId,
  assertValidProgramState,
  type ProgramAttempt,
  type ProgramEvidenceReference,
  type ProgramState,
} from "@alcode/program-state";
import { reduceOperationsFromEvents, type WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";

export const PROGRAM_PROGRESS_MAX_CACHED_RESPONSES = 256;

export interface ProgramProgressAgentAuthorityV1 {
  isCurrent(sessionId: string, connectionGenerationId: string, agentGeneration: number): boolean;
}

export interface ProgramProgressServiceOptionsV1 {
  store: WorkspaceEventStore;
  admission: CanonicalAdmissionQueue;
  agents: ProgramProgressAgentAuthorityV1;
}

interface AgentAdvisoryBlockerV1 {
  advisoryBlockerId: string;
  programStateId: string;
  programAttemptId: string;
  workItemId: string | null;
  sessionId: string;
  agentGeneration: number;
  reason: string;
  state: "open" | "resolved";
}

export class ProgramProgressControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramProgressControlError";
  }
}

export class ProgramProgressStaleError extends ProgramProgressControlError {
  constructor(message: string) {
    super(message);
    this.name = "ProgramProgressStaleError";
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

function latestProgramState(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
): ProgramState {
  let latest: ProgramState | undefined;
  for (const event of events) {
    if (String(event.programStateId ?? "") !== programStateId) continue;
    if (event.type !== "program.created" && event.type !== "program.transitioned"
        && event.type !== "program.completed" && event.type !== "program.cancelled") continue;
    const candidate = record(event.payload).state as ProgramState | undefined;
    if (candidate === undefined) throw new ProgramProgressControlError(`${event.type} lacks payload.state`);
    assertValidProgramState(candidate);
    latest = candidate;
  }
  if (latest === undefined) throw new ProgramProgressStaleError(`Unknown ProgramState ${programStateId}`);
  return latest;
}

function exactAttempt(
  state: ProgramState,
  authority: ProgramAttemptAuthorityV1,
  sessionId: SessionId,
): ProgramAttempt {
  if (state.lifecycle !== "active" || state.revision !== authority.expectedProgramRevision) {
    throw new ProgramProgressStaleError("Program revision or lifecycle is stale");
  }
  const attempt = state.activeAttempt;
  if (attempt === null
      || String(state.programStateId) !== authority.programStateId
      || String(attempt.programAttemptId) !== authority.programAttemptId
      || String(attempt.workItemId) !== authority.workItemId
      || String(attempt.sessionId) !== String(sessionId)
      || attempt.agentGeneration !== authority.agentGeneration) {
    throw new ProgramProgressStaleError("ProgramAttempt authority is stale");
  }
  return attempt;
}

function transitionDraft(
  store: WorkspaceEventStore,
  sessionId: SessionId,
  state: ProgramState,
  transitionKind: string,
  correlationId: string,
): EventDraft<string, unknown> {
  return {
    eventId: mkEventId(),
    idempotencyKey: `program.progress:${String(state.programStateId)}:${state.revision}:${correlationId}`,
    correlationId,
    workspaceId: asWorkspaceId(store.workspaceId),
    sessionId,
    programStateId: asEventProgramStateId(String(state.programStateId)),
    occurredAt: new Date().toISOString(),
    type: "program.transitioned",
    payload: { state, transitionKind },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-progress" },
  };
}

function requestedOperation(
  events: readonly PersistedDomainEvent<string, unknown>[],
  operationId: string,
): PersistedDomainEvent<string, unknown> | undefined {
  return events.find((event) => event.type === "operation.requested"
    && String(event.operationId ?? record(event.payload).operationId ?? "") === operationId);
}

function requireOperationEvidence(
  events: readonly PersistedDomainEvent<string, unknown>[],
  authority: ProgramAttemptAuthorityV1,
  operationId: string,
): void {
  const requested = requestedOperation(events, operationId);
  if (requested === undefined) throw new ProgramProgressControlError("Evidence operation is not Host-canonical");
  const payload = record(requested.payload);
  if (String(requested.programStateId ?? payload.programStateId ?? "") !== authority.programStateId
      || String(payload.programAttemptId ?? "") !== authority.programAttemptId
      || String(payload.workItemId ?? "") !== authority.workItemId
      || Number(payload.agentGeneration) !== authority.agentGeneration) {
    throw new ProgramProgressControlError("Evidence operation belongs to another ProgramAttempt");
  }
  const operation = reduceOperationsFromEvents(events).find((item) => String(item.operationId) === operationId);
  if (operation === undefined || operation.lifecycleState !== "terminal" || operation.executionOutcome !== "succeeded") {
    throw new ProgramProgressControlError("Evidence operation is not terminal-successful");
  }
  if (operation.effectStatus !== "not_applicable" && operation.effectStatus !== "confirmed") {
    throw new ProgramProgressControlError("Evidence operation effect is not certain");
  }
  if (operation.reconciliationStatus !== "not_required" && operation.reconciliationStatus !== "resolved") {
    throw new ProgramProgressControlError("Evidence operation reconciliation is unresolved");
  }
}

function requireArtifactEvidence(state: ProgramState, workItemId: string, artifactRef: string): void {
  const artifact = state.artifacts.find((item) => item.artifactRef === artifactRef);
  if (artifact === undefined || artifact.productionStepId === null) {
    throw new ProgramProgressControlError("Evidence artifact is not a canonical Program artifact");
  }
  const production = state.productionSteps.find((step) => step.productionStepId === artifact.productionStepId);
  if (production === undefined || String(production.producerWorkItemId) !== workItemId) {
    throw new ProgramProgressControlError("Evidence artifact belongs to another work item");
  }
}

export class ProgramProgressServiceV1 {
  private readonly responseCache = new Map<string, ProgramProgressResult>();
  private readonly advisoryBlockers = new Map<string, AgentAdvisoryBlockerV1>();

  constructor(private readonly options: ProgramProgressServiceOptionsV1) {}

  async handleAgentMessage(input: {
    connectionGenerationId: string;
    agentGeneration: number;
    sessionId: SessionId;
    programExecutionCapable: boolean;
    message: AgentToHostMessage;
  }): Promise<ProgramProgressResult | undefined> {
    const message = input.message;
    if (message.type !== "program.progress") return undefined;
    if (message.sessionId !== String(input.sessionId)) {
      return this.failure(message, "stale", "program_execution_stale", "Progress Session authority is stale");
    }

    const cacheKey = `${input.connectionGenerationId}:${message.requestId}`;
    const cached = this.responseCache.get(cacheKey);
    if (cached !== undefined) return structuredClone(cached);
    if (!input.programExecutionCapable) {
      const denied = this.failure(
        message,
        "denied",
        "program_execution_capability_required",
        "Program progress requires program_execution_v1",
      );
      this.cache(cacheKey, denied);
      return denied;
    }
    if (message.authority.agentGeneration !== input.agentGeneration
        || !this.options.agents.isCurrent(String(input.sessionId), input.connectionGenerationId, input.agentGeneration)) {
      const stale = this.failure(message, "stale", "program_execution_stale", "Progress Agent authority is stale");
      this.cache(cacheKey, stale);
      return stale;
    }

    let response: ProgramProgressResult;
    try {
      response = await this.options.admission.enqueue(async () => {
        const events = await replayAll(this.options.store);
        const state = latestProgramState(events, message.authority.programStateId);
        const attempt = exactAttempt(state, message.authority, input.sessionId);

        switch (message.intent.kind) {
          case "evidence.add": {
            if (message.intent.sourceOperationId !== undefined) {
              requireOperationEvidence(events, message.authority, message.intent.sourceOperationId);
            }
            if (message.intent.artifactRef !== undefined) {
              requireArtifactEvidence(state, String(attempt.workItemId), message.intent.artifactRef);
            }
            const evidenceRefId = asProgramEvidenceRefId(uuidv7());
            const evidence: ProgramEvidenceReference = {
              evidenceRefId,
              workItemId: attempt.workItemId,
              verificationObligationId: null,
              sourceOperationId: message.intent.sourceOperationId === undefined
                ? null
                : asOperationId(message.intent.sourceOperationId),
              artifactRef: message.intent.artifactRef ?? null,
              subjectGeneration: null,
            };
            const next = applyProgramTransition(state, {
              kind: "evidence.add",
              expectedProgramRevision: state.revision,
              evidence,
            });
            const persisted = await this.options.store.append([
              transitionDraft(this.options.store, input.sessionId, next, "evidence.add", message.requestId),
            ]);
            if (persisted.length !== 1) throw new ProgramProgressControlError("Progress evidence admission failed");
            return {
              type: "program.progress.result",
              version: PROGRAM_EXECUTION_MESSAGE_VERSION,
              requestId: message.requestId,
              sessionId: message.sessionId,
              outcome: "accepted",
              programRevision: next.revision,
              evidenceRefId: String(evidenceRefId),
            };
          }

          case "blocker.report": {
            const advisoryBlockerId = uuidv7();
            this.advisoryBlockers.set(advisoryBlockerId, {
              advisoryBlockerId,
              programStateId: String(state.programStateId),
              programAttemptId: String(attempt.programAttemptId),
              workItemId: message.intent.scope === "work" ? String(attempt.workItemId) : null,
              sessionId: String(input.sessionId),
              agentGeneration: attempt.agentGeneration,
              reason: message.intent.reason,
              state: "open",
            });
            return {
              type: "program.progress.result",
              version: PROGRAM_EXECUTION_MESSAGE_VERSION,
              requestId: message.requestId,
              sessionId: message.sessionId,
              outcome: "accepted",
              programRevision: state.revision,
              advisoryBlockerId,
            };
          }

          case "blocker.resolve": {
            const advisory = this.advisoryBlockers.get(message.intent.advisoryBlockerId);
            if (advisory === undefined || advisory.state !== "open"
                || advisory.programStateId !== String(state.programStateId)
                || advisory.programAttemptId !== String(attempt.programAttemptId)
                || advisory.sessionId !== String(input.sessionId)
                || advisory.agentGeneration !== attempt.agentGeneration) {
              throw new ProgramProgressStaleError("Advisory blocker report is stale or unknown");
            }
            advisory.state = "resolved";
            return {
              type: "program.progress.result",
              version: PROGRAM_EXECUTION_MESSAGE_VERSION,
              requestId: message.requestId,
              sessionId: message.sessionId,
              outcome: "accepted",
              programRevision: state.revision,
              advisoryBlockerId: advisory.advisoryBlockerId,
            };
          }

          case "work.awaiting_verification": {
            const work = state.workItems.find((item) => item.workItemId === attempt.workItemId);
            if (work === undefined || work.lifecycle !== "in_progress") {
              throw new ProgramProgressControlError("Current work item is not in progress");
            }
            const next = applyProgramTransition(state, {
              kind: "work.lifecycle.set",
              expectedProgramRevision: state.revision,
              workItemId: attempt.workItemId,
              lifecycle: "awaiting_verification",
            });
            const persisted = await this.options.store.append([
              transitionDraft(this.options.store, input.sessionId, next, "work.lifecycle.set", message.requestId),
            ]);
            if (persisted.length !== 1) throw new ProgramProgressControlError("Awaiting-verification admission failed");
            return {
              type: "program.progress.result",
              version: PROGRAM_EXECUTION_MESSAGE_VERSION,
              requestId: message.requestId,
              sessionId: message.sessionId,
              outcome: "accepted",
              programRevision: next.revision,
            };
          }
        }
      });
    } catch (error) {
      response = this.failure(
        message,
        error instanceof ProgramProgressStaleError ? "stale" : error instanceof ProgramProgressControlError || error instanceof TypeError ? "denied" : "failed",
        error instanceof ProgramProgressStaleError ? "program_execution_stale" : error instanceof ProgramProgressControlError || error instanceof TypeError ? "program_progress_invalid" : "program_progress_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    this.cache(cacheKey, response);
    return response;
  }

  private failure(
    message: Extract<AgentToHostMessage, { type: "program.progress" }>,
    outcome: "stale" | "denied" | "failed",
    errorCode: string,
    error: string,
  ): ProgramProgressResult {
    return {
      type: "program.progress.result",
      version: PROGRAM_EXECUTION_MESSAGE_VERSION,
      requestId: message.requestId,
      sessionId: message.sessionId,
      outcome,
      errorCode,
      error,
    };
  }

  private cache(key: string, response: ProgramProgressResult): void {
    this.responseCache.set(key, structuredClone(response));
    while (this.responseCache.size > PROGRAM_PROGRESS_MAX_CACHED_RESPONSES) {
      const oldest = this.responseCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.responseCache.delete(oldest);
    }
  }
}
''')

runtime = 'packages/host-runtime/src/program-execution-runtime.ts'
replace_once(runtime,
'''import {\n  ProgramPlanningControlError,\n  ProgramPlanningServiceV1,\n} from "./program-planning.ts";''',
'''import {\n  ProgramPlanningControlError,\n  ProgramPlanningServiceV1,\n} from "./program-planning.ts";\nimport { ProgramProgressServiceV1 } from "./program-progress.ts";''')
replace_once(runtime,
'''  readonly planning: ProgramPlanningServiceV1;\n  readonly recovery: Phase1RecoveryControllerV1;''',
'''  readonly planning: ProgramPlanningServiceV1;\n  readonly progress: ProgramProgressServiceV1;\n  readonly recovery: Phase1RecoveryControllerV1;''')
replace_once(runtime,
'''    this.planning = new ProgramPlanningServiceV1({\n      store: this.store,\n      planningReads: options.planningReads,\n      creation: this.creation,\n      agents: {\n        isCurrent: (sessionId, connectionGenerationId, agentGeneration) =>\n          this.currentPlanningConnections.get(sessionId) === connectionGenerationId\n          && this.host.programAgents.isCurrent(sessionId, agentGeneration),\n      },\n    });\n\n    this.recovery = new Phase1RecoveryControllerV1({''',
'''    this.planning = new ProgramPlanningServiceV1({\n      store: this.store,\n      planningReads: options.planningReads,\n      creation: this.creation,\n      agents: {\n        isCurrent: (sessionId, connectionGenerationId, agentGeneration) =>\n          this.currentPlanningConnections.get(sessionId) === connectionGenerationId\n          && this.host.programAgents.isCurrent(sessionId, agentGeneration),\n      },\n    });\n    this.progress = new ProgramProgressServiceV1({\n      store: this.store,\n      admission: this.host.admission,\n      agents: {\n        isCurrent: (sessionId, connectionGenerationId, agentGeneration) =>\n          this.currentPlanningConnections.get(sessionId) === connectionGenerationId\n          && this.host.programAgents.isCurrent(sessionId, agentGeneration),\n      },\n    });\n\n    this.recovery = new Phase1RecoveryControllerV1({''')
replace_once(runtime,
'''    const unsubscribePlanning = connection.transport.onMessage(async (message) => {\n      const response = await this.planning.handleAgentMessage({\n        connectionGenerationId: connection.generationId,\n        agentGeneration,\n        sessionId: session.sessionId,\n        message,\n      });\n      if (response !== undefined) {\n        try { await connection.transport.send(response); } catch {}\n      }\n    });''',
'''    const unsubscribePlanning = connection.transport.onMessage(async (message) => {\n      const planningResponse = await this.planning.handleAgentMessage({\n        connectionGenerationId: connection.generationId,\n        agentGeneration,\n        sessionId: session.sessionId,\n        message,\n      });\n      if (planningResponse !== undefined) {\n        try { await connection.transport.send(planningResponse); } catch {}\n        return;\n      }\n      const progressResponse = await this.progress.handleAgentMessage({\n        connectionGenerationId: connection.generationId,\n        agentGeneration,\n        sessionId: session.sessionId,\n        programExecutionCapable,\n        message,\n      });\n      if (progressResponse !== undefined) {\n        try { await connection.transport.send(progressResponse); } catch {}\n      }\n    });''')

host_index = 'packages/host-runtime/src/index.ts'
replace_once(host_index,
'''export {\n  ProgramPlanningServiceV1,\n  ProgramPlanningControlError,\n  ProgramPlanningStaleError,\n  PROGRAM_PLANNING_MAX_CACHED_RESPONSES,\n  type ProgramPlanningAgentAuthorityV1,\n  type ProgramPlanningServiceOptionsV1,\n  type ProgramPlanningResponseV1,\n} from "./program-planning.ts";''',
'''export {\n  ProgramPlanningServiceV1,\n  ProgramPlanningControlError,\n  ProgramPlanningStaleError,\n  PROGRAM_PLANNING_MAX_CACHED_RESPONSES,\n  type ProgramPlanningAgentAuthorityV1,\n  type ProgramPlanningServiceOptionsV1,\n  type ProgramPlanningResponseV1,\n} from "./program-planning.ts";\nexport {\n  ProgramProgressServiceV1,\n  ProgramProgressControlError,\n  ProgramProgressStaleError,\n  PROGRAM_PROGRESS_MAX_CACHED_RESPONSES,\n  type ProgramProgressAgentAuthorityV1,\n  type ProgramProgressServiceOptionsV1,\n} from "./program-progress.ts";''')

progress_test = ROOT / 'packages/host-runtime/src/program-progress.test.ts'
if progress_test.exists():
    raise SystemExit('program-progress.test.ts already exists')
progress_test.write_text(r'''import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asProgramStateId as asEventProgramStateId,
  asWorkspaceId,
  mkEventId,
  mkProgramStateId,
  type PersistedDomainEvent,
} from "@alcode/events";
import {
  applyProgramTransition,
  asProgramArtifactProductionStepId,
  asProgramAttemptId,
  asProgramOutputSlotId,
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  createProgramState,
  type ProgramAttemptExecutionBase,
  type ProgramState,
} from "@alcode/program-state";
import { openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { ProgramProgressServiceV1 } from "./program-progress.ts";
import { HostSessionManager } from "./session-manager.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function base(workspaceIdentity: string): ProgramAttemptExecutionBase {
  return {
    workspaceEffectGeneration: 0,
    observation: {
      kind: "workspace-observation-v1",
      providerKind: "program-progress-test",
      workspaceIdentity,
      coverageDigest: "coverage-v1",
      stateDigest: "state-v1",
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function replay(locked: LockedWorkspaceStore): Promise<PersistedDomainEvent<string, unknown>[]> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of locked.store.replay()) events.push(event);
  return events;
}

function latestState(events: readonly PersistedDomainEvent<string, unknown>[], id: string): ProgramState {
  let state: ProgramState | undefined;
  for (const event of events) {
    if (String(event.programStateId ?? "") !== id) continue;
    if (!event.type.startsWith("program.")) continue;
    const candidate = record(event.payload).state as ProgramState | undefined;
    if (candidate !== undefined) state = candidate;
  }
  if (state === undefined) throw new Error("missing Program state");
  return state;
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "alcode-program-progress-"));
  dirs.push(dir);
  const locked = await openLockedWorkspaceStore({
    databasePath: join(dir, "workspace.sqlite"),
    lockPath: join(dir, "workspace.lock"),
    workspaceId: "018f0000-0000-7000-8000-000000000620",
    repositoryId: "program-progress-test",
  });
  const admission = new CanonicalAdmissionQueue(locked.store);
  const sessions = new HostSessionManager(locked, admission);
  const session = await sessions.openOrResume();
  const workItemId = asProgramWorkItemId("work-1");
  const productionStepId = asProgramArtifactProductionStepId("production-1");
  const outputSlotId = asProgramOutputSlotId("output-1");
  let state = createProgramState({
    programStateId: asProgramStateId(String(mkProgramStateId())),
    sourceSessionId: asSessionId(String(session.sessionId)),
    objective: "Implement progress bridge",
    workItems: [{ workItemId, creationOrder: 0, description: "Implement current work", dependencyIds: [], affectedPaths: ["src/current.ts"] }],
    verification: [],
    outputSlots: [{ outputSlotId, productionStepId }],
    productionSteps: [{
      productionStepId,
      producerWorkItemId: workItemId,
      outputChannel: "result",
      specId: "test.production",
      specVersion: 1,
      canonicalArgs: {},
      canonicalArgsDigest: "digest-v1",
    }],
  });
  state = applyProgramTransition(state, {
    kind: "artifact.add",
    expectedProgramRevision: state.revision,
    artifact: { artifactRef: "artifact:current", outputSlotId, productionStepId },
  });
  state = applyProgramTransition(state, {
    kind: "attempt.issue",
    expectedProgramRevision: state.revision,
    attempt: {
      programAttemptId: asProgramAttemptId("attempt-1"),
      workItemId,
      sessionId: asSessionId(String(session.sessionId)),
      agentGeneration: 7,
      initialExecutionBase: base(locked.store.workspaceId),
      expectedExecutionBase: base(locked.store.workspaceId),
    },
  });
  await locked.store.append([{
    eventId: mkEventId(),
    workspaceId: asWorkspaceId(locked.store.workspaceId),
    sessionId: session.sessionId,
    programStateId: asEventProgramStateId(String(state.programStateId)),
    occurredAt: new Date().toISOString(),
    type: "program.transitioned",
    payload: { state, transitionKind: "test.setup" },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-progress-test" },
  }]);
  const service = new ProgramProgressServiceV1({
    store: locked.store,
    admission,
    agents: {
      isCurrent: (sessionId, connectionGenerationId, agentGeneration) =>
        sessionId === String(session.sessionId) && connectionGenerationId === "connection-1" && agentGeneration === 7,
    },
  });
  const authority = {
    programStateId: String(state.programStateId),
    expectedProgramRevision: state.revision,
    programAttemptId: "attempt-1",
    workItemId: "work-1",
    agentGeneration: 7,
  };
  return { locked, session, service, state, authority };
}

function progress(runtime: Awaited<ReturnType<typeof setup>>, requestId: string, intent: any, authority = runtime.authority) {
  return runtime.service.handleAgentMessage({
    connectionGenerationId: "connection-1",
    agentGeneration: 7,
    sessionId: runtime.session.sessionId,
    programExecutionCapable: true,
    message: {
      type: "program.progress",
      version: 1,
      requestId,
      sessionId: String(runtime.session.sessionId),
      authority,
      intent,
    },
  });
}

describeLocked("Program progress proposal bridge", () => {
  it("admits only exact-current work-bound evidence and invalidates the old revision tuple", async () => {
    const runtime = await setup();
    const accepted = await progress(runtime, "evidence-1", { kind: "evidence.add", artifactRef: "artifact:current" });
    expect(accepted).toMatchObject({ outcome: "accepted", evidenceRefId: expect.any(String) });
    const state = latestState(await replay(runtime.locked), runtime.authority.programStateId);
    expect(state.decisiveEvidence).toHaveLength(1);
    expect(state.decisiveEvidence[0]).toMatchObject({
      workItemId: "work-1",
      verificationObligationId: null,
      sourceOperationId: null,
      artifactRef: "artifact:current",
      subjectGeneration: null,
    });
    expect(state.revision).toBe(runtime.state.revision + 1);

    const duplicate = await progress(runtime, "evidence-1", { kind: "evidence.add", artifactRef: "artifact:current" });
    expect(duplicate).toEqual(accepted);
    expect(latestState(await replay(runtime.locked), runtime.authority.programStateId).decisiveEvidence).toHaveLength(1);

    const stale = await progress(runtime, "evidence-2", { kind: "evidence.add", artifactRef: "artifact:current" });
    expect(stale).toMatchObject({ outcome: "stale", errorCode: "program_execution_stale" });
    runtime.locked.close();
  });

  it("keeps Agent blocker reports advisory rather than mutating canonical ProgramBlocker state", async () => {
    const runtime = await setup();
    const report = await progress(runtime, "blocker-1", { kind: "blocker.report", scope: "work", reason: "Need API answer" });
    expect(report).toMatchObject({ outcome: "accepted", advisoryBlockerId: expect.any(String), programRevision: runtime.state.revision });
    expect(latestState(await replay(runtime.locked), runtime.authority.programStateId).blockers).toEqual([]);

    const resolved = await progress(runtime, "blocker-2", { kind: "blocker.resolve", advisoryBlockerId: report?.advisoryBlockerId });
    expect(resolved).toMatchObject({ outcome: "accepted", advisoryBlockerId: report?.advisoryBlockerId });
    expect(latestState(await replay(runtime.locked), runtime.authority.programStateId).blockers).toEqual([]);
    runtime.locked.close();
  });

  it("allows only the current work item to request awaiting_verification", async () => {
    const runtime = await setup();
    const accepted = await progress(runtime, "await-1", { kind: "work.awaiting_verification" });
    expect(accepted).toMatchObject({ outcome: "accepted", programRevision: runtime.state.revision + 1 });
    const state = latestState(await replay(runtime.locked), runtime.authority.programStateId);
    expect(state.workItems[0]?.lifecycle).toBe("awaiting_verification");
    expect(state.activeAttempt?.programAttemptId).toBe("attempt-1");
    runtime.locked.close();
  });

  it("rejects progress without program_execution_v1 before canonical mutation", async () => {
    const runtime = await setup();
    const before = await replay(runtime.locked);
    const result = await runtime.service.handleAgentMessage({
      connectionGenerationId: "connection-1",
      agentGeneration: 7,
      sessionId: runtime.session.sessionId,
      programExecutionCapable: false,
      message: {
        type: "program.progress",
        version: 1,
        requestId: "state-only-1",
        sessionId: String(runtime.session.sessionId),
        authority: runtime.authority,
        intent: { kind: "work.awaiting_verification" },
      },
    });
    expect(result).toMatchObject({ outcome: "denied", errorCode: "program_execution_capability_required" });
    expect(await replay(runtime.locked)).toHaveLength(before.length);
    runtime.locked.close();
  });

  it("rejects stale Attempt, work, revision, Session, and Agent-generation tuples", async () => {
    const variants = [
      { programAttemptId: "attempt-old" },
      { workItemId: "work-old" },
      { expectedProgramRevision: 999 },
      { agentGeneration: 8 },
    ];
    for (const [index, patch] of variants.entries()) {
      const runtime = await setup();
      const result = await progress(runtime, `stale-${index}`, { kind: "work.awaiting_verification" }, { ...runtime.authority, ...patch });
      expect(result).toMatchObject({ outcome: "stale", errorCode: "program_execution_stale" });
      expect(latestState(await replay(runtime.locked), runtime.authority.programStateId).workItems[0]?.lifecycle).toBe("in_progress");
      runtime.locked.close();
    }

    const runtime = await setup();
    const result = await runtime.service.handleAgentMessage({
      connectionGenerationId: "connection-1",
      agentGeneration: 7,
      sessionId: runtime.session.sessionId,
      programExecutionCapable: true,
      message: {
        type: "program.progress",
        version: 1,
        requestId: "wrong-session",
        sessionId: "wrong-session",
        authority: runtime.authority,
        intent: { kind: "work.awaiting_verification" },
      },
    });
    expect(result).toMatchObject({ outcome: "stale", errorCode: "program_execution_stale" });
    runtime.locked.close();
  });
});
''')

print('phase 1.1 progress bridge patch applied')
