import {
  asProgramStateId as asEventProgramStateId,
  asWorkspaceId,
  mkEventId,
  uuidv7,
  type EventDraft,
  type PersistedDomainEvent,
  type SessionId as EventSessionId,
} from "@alcode/events";
import {
  ProgramRevisionConflictError,
  ProgramTransitionError,
  applyProgramTransition,
  asExecutionBaseMismatchReceiptId,
  asProgramAttemptId,
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  assertValidProgramState,
  canonicalStringify,
  type ExecutionBaseMismatchKind,
  type ProgramAttemptExecutionBase,
  type ProgramState,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";

export interface ProgramDispatchWorkspaceCoordinatorV1 {
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
}

export interface ProgramExecutionObservationSourceV1 {
  observe(): Promise<
    | { status: "complete"; base: ProgramAttemptExecutionBase }
    | { status: "unknown"; reason: string }
  >;
}

export interface ProgramAgentGenerationAuthorityV1 {
  isCurrent(sessionId: string, agentGeneration: number): Promise<boolean> | boolean;
}

export interface ProgramRecoveryAuthorityV1 {
  isClear(): Promise<boolean> | boolean;
}

export interface ProgramFirstDispatchPlanningBridgeV1 {
  recheckAcceptedPlanningBase(programStateId: ReturnType<typeof asEventProgramStateId>): Promise<void>;
}

export interface ProgramDispatchServiceOptionsV1 {
  store: WorkspaceEventStore;
  admission: CanonicalAdmissionQueue;
  workspaceCoordinator: ProgramDispatchWorkspaceCoordinatorV1;
  observations: ProgramExecutionObservationSourceV1;
  agentGenerations: ProgramAgentGenerationAuthorityV1;
  recovery: ProgramRecoveryAuthorityV1;
  firstDispatchPlanning: ProgramFirstDispatchPlanningBridgeV1;
}

export type ProgramDispatchResult =
  | { status: "issued"; state: ProgramState; programAttemptId: string }
  | { status: "rebase_required"; state: ProgramState; mismatchReceiptId: string }
  | { status: "execution_base_unavailable"; state: ProgramState; reason: string }
  | { status: "workspace_busy"; activeProgramStateId: string; activeProgramAttemptId: string }
  | { status: "writer_barrier"; operationIds: string[] }
  | { status: "recovery_blocked" }
  | { status: "agent_generation_stale" }
  | { status: "session_inactive" };

export class ProgramDispatchControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramDispatchControlError";
  }
}

export class ProgramDispatchStaleError extends ProgramDispatchControlError {
  constructor(message: string) {
    super(message);
    this.name = "ProgramDispatchStaleError";
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

function isProgramStateEvent(type: string): boolean {
  return type === "program.created" || type === "program.transitioned" ||
    type === "program.completed" || type === "program.cancelled";
}

function latestProgramStates(
  events: readonly PersistedDomainEvent<string, unknown>[],
): Map<string, ProgramState> {
  const states = new Map<string, ProgramState>();
  for (const event of events) {
    if (!isProgramStateEvent(event.type) || event.programStateId === undefined) continue;
    const state = record(event.payload).state as ProgramState | undefined;
    if (state === undefined) {
      throw new ProgramDispatchControlError(`${event.type} lacks payload.state`);
    }
    assertValidProgramState(state);
    if (String(state.programStateId) !== String(event.programStateId)) {
      throw new ProgramDispatchControlError(`${event.type} state identity does not match envelope`);
    }
    states.set(String(event.programStateId), state);
  }
  return states;
}

function requireProgramState(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
): ProgramState {
  const state = latestProgramStates(events).get(programStateId);
  if (state === undefined) throw new ProgramDispatchControlError(`Unknown ProgramState ${programStateId}`);
  return state;
}

function sessionIsActive(
  events: readonly PersistedDomainEvent<string, unknown>[],
  sessionId: string,
): boolean {
  let started = false;
  let stopped = false;
  for (const event of events) {
    if (String(event.sessionId) !== sessionId) continue;
    if (event.type === "runtime.session.started") started = true;
    if (event.type === "runtime.session.stopped") stopped = true;
  }
  return started && !stopped;
}

function outstandingWriterOperations(
  events: readonly PersistedDomainEvent<string, unknown>[],
): string[] {
  const outstanding = new Set<string>();
  for (const event of events) {
    const payload = record(event.payload);
    const operationId = String(event.operationId ?? payload.operationId ?? "");
    if (operationId.length === 0) continue;
    if (event.type === "operation.requested" && payload.workspaceAccessClass === "may_write") {
      outstanding.add(operationId);
      continue;
    }
    if (event.type === "operation.mutation_quiesced") {
      outstanding.delete(operationId);
    }
  }
  return [...outstanding].sort();
}

function activeWorkspaceAttempt(
  events: readonly PersistedDomainEvent<string, unknown>[],
  excludingProgramStateId?: string,
): { programStateId: string; programAttemptId: string } | null {
  for (const [programStateId, state] of latestProgramStates(events)) {
    if (programStateId === excludingProgramStateId) continue;
    if (state.lifecycle !== "active" || state.activeAttempt === null) continue;
    return {
      programStateId,
      programAttemptId: String(state.activeAttempt.programAttemptId),
    };
  }
  return null;
}

function sameBase(left: ProgramAttemptExecutionBase, right: ProgramAttemptExecutionBase): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

function mismatchKind(
  accepted: ProgramAttemptExecutionBase,
  current: ProgramAttemptExecutionBase,
): ExecutionBaseMismatchKind {
  const generationChanged = accepted.workspaceEffectGeneration !== current.workspaceEffectGeneration;
  const observationChanged = canonicalStringify(accepted.observation) !== canonicalStringify(current.observation);
  if (generationChanged && observationChanged) return "causal_and_observation_mismatch";
  if (generationChanged) return "causal_generation_mismatch";
  return "observation_mismatch";
}

function transitionEvent(
  store: WorkspaceEventStore,
  sessionId: EventSessionId,
  state: ProgramState,
  transitionKind: string,
  correlationId: string,
): EventDraft<string, unknown> {
  return {
    eventId: mkEventId(),
    idempotencyKey: `program.transitioned:${String(state.programStateId)}:${state.revision}`,
    correlationId,
    workspaceId: asWorkspaceId(store.workspaceId),
    sessionId,
    programStateId: asEventProgramStateId(String(state.programStateId)),
    occurredAt: new Date().toISOString(),
    type: "program.transitioned",
    payload: { state, transitionKind },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-dispatch" },
  };
}

function requireExactRevision(state: ProgramState, expectedProgramRevision: number): void {
  if (state.revision !== expectedProgramRevision) {
    throw new ProgramRevisionConflictError(expectedProgramRevision, state.revision);
  }
}

export class ProgramDispatchServiceV1 {
  constructor(private readonly options: ProgramDispatchServiceOptionsV1) {}

  async issueAttempt(input: {
    programStateId: string;
    expectedProgramRevision: number;
    workItemId: string;
    sessionId: EventSessionId;
    agentGeneration: number;
  }): Promise<ProgramDispatchResult> {
    const programStateId = String(asProgramStateId(input.programStateId));
    const workItemId = asProgramWorkItemId(input.workItemId);
    const sessionId = String(input.sessionId);
    if (!Number.isSafeInteger(input.agentGeneration) || input.agentGeneration <= 0) {
      throw new ProgramDispatchControlError("agentGeneration must be a positive safe integer");
    }

    return this.options.workspaceCoordinator.runExclusive(async () => {
      const beforeEvents = await replayAll(this.options.store);
      const before = requireProgramState(beforeEvents, programStateId);
      requireExactRevision(before, input.expectedProgramRevision);

      if (before.acceptedExecutionBase === null) {
        await this.options.firstDispatchPlanning.recheckAcceptedPlanningBase(
          asEventProgramStateId(programStateId),
        );
      }

      const observation = await this.options.observations.observe();

      return this.options.admission.enqueue(async () => {
        const events = await replayAll(this.options.store);
        const state = requireProgramState(events, programStateId);
        requireExactRevision(state, input.expectedProgramRevision);

        if (!sessionIsActive(events, sessionId) || !state.attachedSessionIds.some((id) => String(id) === sessionId)) {
          return { status: "session_inactive" } as const;
        }
        if (!await this.options.agentGenerations.isCurrent(sessionId, input.agentGeneration)) {
          return { status: "agent_generation_stale" } as const;
        }
        if (!await this.options.recovery.isClear()) {
          return { status: "recovery_blocked" } as const;
        }

        const writerBarriers = outstandingWriterOperations(events);
        if (writerBarriers.length > 0) {
          return { status: "writer_barrier", operationIds: writerBarriers } as const;
        }

        const otherAttempt = activeWorkspaceAttempt(events, programStateId);
        if (otherAttempt !== null) {
          return {
            status: "workspace_busy",
            activeProgramStateId: otherAttempt.programStateId,
            activeProgramAttemptId: otherAttempt.programAttemptId,
          } as const;
        }

        if (state.executionBaseMismatch !== null) {
          return {
            status: "rebase_required",
            state,
            mismatchReceiptId: String(state.executionBaseMismatch.receiptId),
          } as const;
        }

        if (observation.status === "unknown") {
          const next = applyProgramTransition(state, {
            kind: "execution_base.unavailable",
            expectedProgramRevision: state.revision,
          });
          if (next !== state) {
            await this.options.store.append([
              transitionEvent(this.options.store, input.sessionId, next, "execution_base.unavailable", uuidv7()),
            ]);
          }
          return { status: "execution_base_unavailable", state: next, reason: observation.reason } as const;
        }

        const currentBase = observation.base;
        if (state.acceptedExecutionBase !== null && !sameBase(state.acceptedExecutionBase, currentBase)) {
          const receiptId = asExecutionBaseMismatchReceiptId(uuidv7());
          const receipt = {
            receiptId,
            programStateId: state.programStateId,
            expectedProgramRevision: state.revision,
            acceptedWorkspaceEffectGeneration: state.acceptedExecutionBase.workspaceEffectGeneration,
            acceptedObservationIdentity: state.acceptedExecutionBase.observation,
            currentWorkspaceEffectGeneration: currentBase.workspaceEffectGeneration,
            currentObservationIdentity: currentBase.observation,
            kind: mismatchKind(state.acceptedExecutionBase, currentBase),
            verificationImpactComplete: true,
          } as const;
          const next = applyProgramTransition(state, {
            kind: "execution_base.mismatch",
            expectedProgramRevision: state.revision,
            receipt,
            // This slice uses the safe complete impact result: unknown/disputed
            // Workspace impact invalidates every current obligation rather than
            // optimistically retaining proof. Later operation impact admission
            // may provide a narrower provably-disjoint set.
            invalidateVerificationObligationIds: state.verification.map((item) => item.obligationId),
          });
          await this.options.store.append([
            transitionEvent(this.options.store, input.sessionId, next, "execution_base.mismatch", String(receiptId)),
          ]);
          return { status: "rebase_required", state: next, mismatchReceiptId: String(receiptId) } as const;
        }

        const attemptId = asProgramAttemptId(uuidv7());
        const executionBase = currentBase;
        const next = applyProgramTransition(state, {
          kind: "attempt.issue",
          expectedProgramRevision: state.revision,
          attempt: {
            programAttemptId: attemptId,
            workItemId,
            sessionId: asSessionId(sessionId),
            agentGeneration: input.agentGeneration,
            initialExecutionBase: executionBase,
            expectedExecutionBase: executionBase,
          },
        });
        await this.options.store.append([
          transitionEvent(this.options.store, input.sessionId, next, "attempt.issue", String(attemptId)),
        ]);
        return { status: "issued", state: next, programAttemptId: String(attemptId) } as const;
      });
    });
  }

  async acceptRebase(input: {
    programStateId: string;
    expectedProgramRevision: number;
    mismatchReceiptId: string;
    sessionId: EventSessionId;
  }): Promise<ProgramState> {
    const programStateId = String(asProgramStateId(input.programStateId));
    if (input.mismatchReceiptId.length === 0) {
      throw new ProgramDispatchControlError("mismatchReceiptId is required");
    }

    return this.options.workspaceCoordinator.runExclusive(async () => {
      const observation = await this.options.observations.observe();
      if (observation.status === "unknown") {
        throw new ProgramDispatchStaleError(`Current execution base is unavailable: ${observation.reason}`);
      }

      return this.options.admission.enqueue(async () => {
        const events = await replayAll(this.options.store);
        const state = requireProgramState(events, programStateId);
        requireExactRevision(state, input.expectedProgramRevision);
        const receipt = state.executionBaseMismatch;
        if (receipt === null || String(receipt.receiptId) !== input.mismatchReceiptId) {
          throw new ProgramDispatchStaleError("Rebase targets a stale or unknown mismatch receipt");
        }
        const candidate: ProgramAttemptExecutionBase = {
          workspaceEffectGeneration: receipt.currentWorkspaceEffectGeneration,
          observation: receipt.currentObservationIdentity,
        };
        if (!sameBase(observation.base, candidate)) {
          throw new ProgramDispatchStaleError("Execution base changed again after mismatch receipt creation");
        }
        const next = applyProgramTransition(state, {
          kind: "execution_base.rebase_accept",
          expectedProgramRevision: state.revision,
          mismatchReceiptId: input.mismatchReceiptId,
          executionBase: candidate,
        });
        await this.options.store.append([
          transitionEvent(this.options.store, input.sessionId, next, "execution_base.rebase_accept", input.mismatchReceiptId),
        ]);
        return next;
      });
    });
  }

  async assertCurrentAttempt(input: {
    programStateId: string;
    expectedProgramRevision: number;
    programAttemptId: string;
    workItemId: string;
    sessionId: EventSessionId;
    agentGeneration: number;
  }): Promise<{ state: ProgramState; executionBase: ProgramAttemptExecutionBase }> {
    const programStateId = String(asProgramStateId(input.programStateId));
    return this.options.workspaceCoordinator.runExclusive(async () => {
      const observation = await this.options.observations.observe();
      if (observation.status === "unknown") {
        throw new ProgramDispatchStaleError(`Current execution base is unavailable: ${observation.reason}`);
      }
      return this.options.admission.enqueue(async () => {
        const events = await replayAll(this.options.store);
        const state = requireProgramState(events, programStateId);
        requireExactRevision(state, input.expectedProgramRevision);
        const attempt = state.activeAttempt;
        if (attempt === null || String(attempt.programAttemptId) !== input.programAttemptId) {
          throw new ProgramDispatchStaleError("ProgramAttempt authority is stale");
        }
        if (String(attempt.workItemId) !== input.workItemId || String(attempt.sessionId) !== String(input.sessionId)) {
          throw new ProgramDispatchStaleError("ProgramAttempt work/session authority is stale");
        }
        if (attempt.agentGeneration !== input.agentGeneration ||
            !await this.options.agentGenerations.isCurrent(String(input.sessionId), input.agentGeneration)) {
          throw new ProgramDispatchStaleError("ProgramAttempt Agent generation is stale");
        }
        if (!await this.options.recovery.isClear()) {
          throw new ProgramDispatchStaleError("Program recovery barrier is not clear");
        }
        const writers = outstandingWriterOperations(events);
        if (writers.length > 0) {
          throw new ProgramDispatchStaleError(`Outstanding Workspace writer barrier: ${writers.join(",")}`);
        }
        if (state.executionBaseMismatch !== null || state.executionBaseUnavailable) {
          throw new ProgramDispatchStaleError("Program execution base is not current");
        }
        if (!sameBase(attempt.expectedExecutionBase, observation.base)) {
          throw new ProgramDispatchStaleError("ProgramAttempt execution base no longer matches the protected current base");
        }
        return { state, executionBase: observation.base };
      });
    });
  }
}

export { ProgramRevisionConflictError, ProgramTransitionError };
