import {
  PROGRAM_EXECUTION_MESSAGE_VERSION,
  type AgentToHostMessage,
  type ProgramAttemptAuthorityV1,
  type ProgramProgressProposal,
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
  ProgramRevisionConflictError,
  ProgramTransitionError,
  applyProgramTransition,
  asOperationId,
  asProgramEvidenceRefId,
  asVerificationObligationId,
  assertValidProgramState,
  type ProgramEvidenceReference,
  type ProgramState,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
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
  let state: ProgramState | undefined;
  for (const event of events) {
    if (String(event.programStateId ?? "") !== programStateId) continue;
    if (event.type !== "program.created" && event.type !== "program.transitioned"
        && event.type !== "program.completed" && event.type !== "program.cancelled") continue;
    const candidate = record(event.payload).state as ProgramState | undefined;
    if (candidate !== undefined) state = candidate;
  }
  if (state === undefined) throw new ProgramProgressStaleError(`Unknown ProgramState ${programStateId}`);
  assertValidProgramState(state);
  return state;
}

function sameAuthority(state: ProgramState, sessionId: SessionId, authority: ProgramAttemptAuthorityV1): boolean {
  if (state.lifecycle !== "active" || state.revision !== authority.expectedProgramRevision) return false;
  const attempt = state.activeAttempt;
  return attempt !== null
    && String(attempt.programAttemptId) === authority.programAttemptId
    && String(attempt.workItemId) === authority.workItemId
    && String(attempt.sessionId) === String(sessionId)
    && attempt.agentGeneration === authority.agentGeneration;
}

function requireCurrentAuthority(
  state: ProgramState,
  sessionId: SessionId,
  authority: ProgramAttemptAuthorityV1,
  connectionGenerationId: string,
  agents: ProgramProgressAgentAuthorityV1,
): void {
  if (String(state.programStateId) !== authority.programStateId || !sameAuthority(state, sessionId, authority)) {
    throw new ProgramProgressStaleError("Program progress authority is stale");
  }
  if (!state.attachedSessionIds.some((id) => String(id) === String(sessionId))) {
    throw new ProgramProgressStaleError("Program progress Session is detached");
  }
  if (!agents.isCurrent(String(sessionId), connectionGenerationId, authority.agentGeneration)) {
    throw new ProgramProgressStaleError("Program progress Agent authority is stale");
  }
  if (state.executionBaseMismatch !== null || state.executionBaseUnavailable) {
    throw new ProgramProgressStaleError("Program execution base is not current");
  }
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
    idempotencyKey: `program.progress.transition:${String(state.programStateId)}:${state.revision}`,
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

function requireOwnedOperation(
  events: readonly PersistedDomainEvent<string, unknown>[],
  sessionId: SessionId,
  authority: ProgramAttemptAuthorityV1,
  operationId: string,
): void {
  const requested = events.find((event) => event.type === "operation.requested"
    && String(event.operationId ?? record(event.payload).operationId ?? "") === operationId);
  if (requested === undefined) {
    throw new ProgramProgressControlError(`Unknown source operation ${operationId}`);
  }
  const payload = record(requested.payload);
  if (String(requested.sessionId) !== String(sessionId)
      || String(requested.programStateId ?? "") !== authority.programStateId
      || String(payload.programAttemptId ?? "") !== authority.programAttemptId
      || String(payload.workItemId ?? "") !== authority.workItemId
      || Number(payload.agentGeneration) !== authority.agentGeneration) {
    throw new ProgramProgressControlError("Source operation is not owned by the current ProgramAttempt");
  }
}

function requireArtifactOwnedByWork(state: ProgramState, workItemId: string, artifactRef: string): void {
  const artifact = state.artifacts.find((item) => item.artifactRef === artifactRef);
  if (artifact === undefined) throw new ProgramProgressControlError(`Unknown ArtifactRef ${artifactRef}`);
  if (artifact.productionStepId === null) {
    throw new ProgramProgressControlError("Agent progress cannot bind an unscoped ArtifactRef as decisive evidence");
  }
  const step = state.productionSteps.find((item) => item.productionStepId === artifact.productionStepId);
  if (step === undefined || String(step.producerWorkItemId) !== workItemId) {
    throw new ProgramProgressControlError("ArtifactRef is not produced by the current work item");
  }
}

function requireVerification(state: ProgramState, id: string): void {
  const obligationId = asVerificationObligationId(id);
  if (!state.verification.some((item) => item.obligationId === obligationId)) {
    throw new ProgramProgressControlError(`Unknown verification obligation ${id}`);
  }
}

function priorAdvisoryReport(
  events: readonly PersistedDomainEvent<string, unknown>[],
  authority: ProgramAttemptAuthorityV1,
  reportId: string,
): PersistedDomainEvent<string, unknown> | undefined {
  let reported: PersistedDomainEvent<string, unknown> | undefined;
  let resolved = false;
  for (const event of events) {
    if (String(event.programStateId ?? "") !== authority.programStateId) continue;
    const payload = record(event.payload);
    if (String(payload.reportId ?? "") !== reportId
        || String(payload.programAttemptId ?? "") !== authority.programAttemptId
        || String(payload.workItemId ?? "") !== authority.workItemId
        || Number(payload.agentGeneration) !== authority.agentGeneration) continue;
    if (event.type === "program.agent_advisory.reported") {
      reported = event;
      resolved = false;
    } else if (event.type === "program.agent_advisory.resolved") {
      resolved = true;
    }
  }
  return reported !== undefined && !resolved ? reported : undefined;
}

function advisoryDraft(
  store: WorkspaceEventStore,
  sessionId: SessionId,
  authority: ProgramAttemptAuthorityV1,
  advisory: ProgramProgressProposal["advisoryBlockers"][number],
): EventDraft<string, unknown> {
  const payload: Record<string, unknown> = {
    reportId: advisory.reportId,
    programAttemptId: authority.programAttemptId,
    workItemId: authority.workItemId,
    agentGeneration: authority.agentGeneration,
    advisoryOnly: true,
  };
  if (advisory.action === "report") {
    payload.scope = advisory.scope;
    payload.reason = advisory.reason;
  }
  return {
    eventId: mkEventId(),
    correlationId: authority.programAttemptId,
    workspaceId: asWorkspaceId(store.workspaceId),
    sessionId,
    programStateId: asEventProgramStateId(authority.programStateId),
    occurredAt: new Date().toISOString(),
    type: advisory.action === "report"
      ? "program.agent_advisory.reported"
      : "program.agent_advisory.resolved",
    payload,
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-progress" },
  };
}

export class ProgramProgressServiceV1 {
  private readonly responseCache = new Map<string, ProgramProgressResult>();

  constructor(private readonly options: ProgramProgressServiceOptionsV1) {}

  async handleAgentMessage(input: {
    connectionGenerationId: string;
    sessionId: SessionId;
    message: AgentToHostMessage;
  }): Promise<ProgramProgressResult | undefined> {
    if (input.message.type !== "program.progress") return undefined;
    const message = input.message;
    if (message.sessionId !== String(input.sessionId)) {
      return this.failure(message, "stale", "program_progress_stale", "Program progress Session authority is stale");
    }

    const cacheKey = `${input.connectionGenerationId}:${message.requestId}`;
    const cached = this.responseCache.get(cacheKey);
    if (cached !== undefined) return structuredClone(cached);

    let response: ProgramProgressResult;
    try {
      response = await this.options.admission.enqueue(async () => {
        const events = await replayAll(this.options.store);
        const state = latestProgramState(events, message.authority.programStateId);
        requireCurrentAuthority(
          state,
          input.sessionId,
          message.authority,
          input.connectionGenerationId,
          this.options.agents,
        );

        if (message.evidence.length === 0
            && message.advisoryBlockers.length === 0
            && !message.requestAwaitingVerification) {
          throw new ProgramProgressControlError("Program progress proposal contains no intent");
        }

        let next = state;
        const drafts: EventDraft<string, unknown>[] = [];
        const correlationId = message.authority.programAttemptId;

        for (const proposed of message.evidence) {
          if (proposed.sourceOperationId !== undefined) {
            requireOwnedOperation(events, input.sessionId, message.authority, proposed.sourceOperationId);
          }
          if (proposed.artifactRef !== undefined) {
            requireArtifactOwnedByWork(next, message.authority.workItemId, proposed.artifactRef);
          }
          if (proposed.verificationObligationId !== undefined) {
            requireVerification(next, proposed.verificationObligationId);
          }

          const evidence: ProgramEvidenceReference = {
            evidenceRefId: asProgramEvidenceRefId(uuidv7()),
            workItemId: next.activeAttempt!.workItemId,
            verificationObligationId: proposed.verificationObligationId === undefined
              ? null
              : asVerificationObligationId(proposed.verificationObligationId),
            sourceOperationId: proposed.sourceOperationId === undefined
              ? null
              : asOperationId(proposed.sourceOperationId),
            artifactRef: proposed.artifactRef ?? null,
          };
          next = applyProgramTransition(next, {
            kind: "evidence.add",
            expectedProgramRevision: next.revision,
            evidence,
          });
          drafts.push(transitionDraft(this.options.store, input.sessionId, next, "evidence.add", correlationId));
        }

        const advisorySeen = new Set<string>();
        for (const advisory of message.advisoryBlockers) {
          if (advisorySeen.has(advisory.reportId)) {
            throw new ProgramProgressControlError(`Duplicate advisory reportId ${advisory.reportId}`);
          }
          advisorySeen.add(advisory.reportId);
          const existing = priorAdvisoryReport(events, message.authority, advisory.reportId);
          if (advisory.action === "report" && existing !== undefined) {
            throw new ProgramProgressControlError(`Advisory reportId already active: ${advisory.reportId}`);
          }
          if (advisory.action === "resolve" && existing === undefined) {
            throw new ProgramProgressControlError(`Advisory reportId is not active: ${advisory.reportId}`);
          }
          drafts.push(advisoryDraft(this.options.store, input.sessionId, message.authority, advisory));
        }

        if (message.requestAwaitingVerification) {
          const attempt = next.activeAttempt;
          if (attempt === null || String(attempt.programAttemptId) !== message.authority.programAttemptId) {
            throw new ProgramProgressStaleError("ProgramAttempt changed before awaiting-verification admission");
          }
          const work = next.workItems.find((item) => item.workItemId === attempt.workItemId);
          if (work === undefined || work.lifecycle !== "in_progress") {
            throw new ProgramProgressControlError("Only current in_progress work may request awaiting_verification");
          }
          next = applyProgramTransition(next, {
            kind: "work.lifecycle.set",
            expectedProgramRevision: next.revision,
            workItemId: attempt.workItemId,
            lifecycle: "awaiting_verification",
          });
          drafts.push(transitionDraft(
            this.options.store,
            input.sessionId,
            next,
            "work.lifecycle.set:awaiting_verification",
            correlationId,
          ));
        }

        if (drafts.length > 0) await this.options.store.append(drafts);
        return {
          type: "program.progress.result",
          version: PROGRAM_EXECUTION_MESSAGE_VERSION,
          requestId: message.requestId,
          sessionId: message.sessionId,
          outcome: "admitted",
          programStateId: String(next.programStateId),
          programRevision: next.revision,
        } as const;
      });
    } catch (error) {
      const stale = error instanceof ProgramProgressStaleError
        || error instanceof ProgramRevisionConflictError;
      const controlled = error instanceof ProgramProgressControlError
        || error instanceof ProgramTransitionError;
      response = this.failure(
        message,
        stale ? "stale" : controlled ? "denied" : "failed",
        stale ? "program_progress_stale" : controlled ? "program_progress_invalid" : "program_progress_failed",
        error instanceof Error ? error.message : String(error),
      );
    }

    this.cache(cacheKey, response);
    return response;
  }

  private failure(
    message: ProgramProgressProposal,
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
      programStateId: message.authority.programStateId,
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
