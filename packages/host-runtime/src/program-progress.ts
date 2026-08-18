import {
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
