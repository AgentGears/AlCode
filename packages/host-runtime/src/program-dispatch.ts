import {
  asOperationId,
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

export interface ProgramRootOperationInputV1 {
  programStateId: string;
  expectedProgramRevision: number;
  programAttemptId: string;
  workItemId: string;
  sessionId: EventSessionId;
  agentGeneration: number;
  operationId: string;
}

export interface ProgramRootOperationAuthorityV1 {
  appendRootOperation(
    input: ProgramRootOperationInputV1,
    drafts: readonly EventDraft<string, unknown>[],
  ): Promise<PersistedDomainEvent<string, unknown>[]>;
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

function outstandingWriterOperations(events: readonly PersistedDomainEvent<string, unknown>[]): string[] {
  const writers = new Map<string, { legacy: boolean }>();
  for (const event of events) {
    if (event.type === "operation.requested") {
      const payload = record(event.payload);
      const operationId = String(payload.operationId ?? event.operationId ?? "");
      const workspaceAccessClass = payload.workspaceAccessClass;
      const legacyMayWrite = workspaceAccessClass === undefined && payload.isReadOnly === false;
      if (operationId && workspaceAccessClass === "may_write") writers.set(operationId, { legacy: false });
      else if (operationId && legacyMayWrite) writers.set(operationId, { legacy: true });
    } else if (event.type === "operation.completed") {
      const payload = record(event.payload);
      const operationId = String(payload.operationId ?? event.operationId ?? "");
      if (operationId && writers.get(operationId)?.legacy) writers.delete(operationId);
    } else if (event.type === "operation.mutation_quiesced") {
      const payload = record(event.payload);
      const operationId = String(payload.operationId ?? event.operationId ?? "");
      if (operationId) writers.delete(operationId);
    }
  }
  return [...writers.keys()].sort((a, b) => a.localeCompare(b, "en"));
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

function requireObservationWorkspace(
  store: WorkspaceEventStore,
  base: ProgramAttemptExecutionBase,
): void {
  if (base.observation.workspaceIdentity !== store.workspaceId) {
    throw new ProgramDispatchStaleError(
      `Execution observation belongs to another Workspace: ${base.observation.workspaceIdentity}`,
    );
  }
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
        requireObservationWorkspace(this.options.store, currentBase);
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
      requireObservationWorkspace(this.options.store, observation.base);

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

  async appendRootOperation(
    input: ProgramRootOperationInputV1,
    drafts: readonly EventDraft<string, unknown>[],
  ): Promise<PersistedDomainEvent<string, unknown>[]> {
    const programStateId = String(asProgramStateId(input.programStateId));
    const programAttemptId = String(asProgramAttemptId(input.programAttemptId));
    const workItemId = String(asProgramWorkItemId(input.workItemId));
    const operationId = String(asOperationId(input.operationId));
    const sessionId = String(input.sessionId);
    if (!Number.isSafeInteger(input.agentGeneration) || input.agentGeneration <= 0) {
      throw new ProgramDispatchControlError("agentGeneration must be a positive safe integer");
    }
    if (drafts.length === 0 || drafts[0]?.type !== "operation.requested") {
      throw new ProgramDispatchControlError("Program root operation must begin with operation.requested");
    }

    return this.options.workspaceCoordinator.runExclusive(async () => {
      const observation = await this.options.observations.observe();
      if (observation.status === "unknown") {
        throw new ProgramDispatchStaleError(`Current execution base is unavailable: ${observation.reason}`);
      }
      requireObservationWorkspace(this.options.store, observation.base);

      return this.options.admission.enqueue(async () => {
        const events = await replayAll(this.options.store);
        const state = requireProgramState(events, programStateId);
        requireExactRevision(state, input.expectedProgramRevision);
        if (!sessionIsActive(events, sessionId) ||
            !state.attachedSessionIds.some((id) => String(id) === sessionId)) {
          throw new ProgramDispatchStaleError("ProgramAttempt session is stopped or detached");
        }
        const attempt = state.activeAttempt;
        if (attempt === null || String(attempt.programAttemptId) !== programAttemptId) {
          throw new ProgramDispatchStaleError("ProgramAttempt authority is stale");
        }
        if (String(attempt.workItemId) !== workItemId || String(attempt.sessionId) !== sessionId) {
          throw new ProgramDispatchStaleError("ProgramAttempt work/session authority is stale");
        }
        if (attempt.agentGeneration !== input.agentGeneration ||
            !await this.options.agentGenerations.isCurrent(sessionId, input.agentGeneration)) {
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

        const rootPayload = record(drafts[0]!.payload);
        if (String(rootPayload.programStateId ?? "") !== programStateId ||
            Number(rootPayload.expectedProgramRevision) !== input.expectedProgramRevision ||
            String(rootPayload.programAttemptId ?? "") !== programAttemptId ||
            String(rootPayload.workItemId ?? "") !== workItemId ||
            Number(rootPayload.agentGeneration) !== input.agentGeneration) {
          throw new ProgramDispatchControlError("operation.requested payload does not match protected ProgramAttempt authority");
        }

        const stamped = drafts.map((draft) => {
          if (String(draft.workspaceId) !== this.options.store.workspaceId) {
            throw new ProgramDispatchControlError("Program operation draft belongs to another Workspace");
          }
          if (String(draft.sessionId) !== sessionId) {
            throw new ProgramDispatchControlError("Program operation draft session does not match Attempt authority");
          }
          if (draft.operationId === undefined || String(draft.operationId) !== operationId) {
            throw new ProgramDispatchControlError("Program operation draft operationId does not match root operation");
          }
          if (draft.programStateId !== undefined && String(draft.programStateId) !== programStateId) {
            throw new ProgramDispatchControlError("Program operation draft ProgramStateId does not match Attempt authority");
          }
          return { ...draft, programStateId: asEventProgramStateId(programStateId) };
        });
        return this.options.store.append(stamped);
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
      requireObservationWorkspace(this.options.store, observation.base);
      return this.options.admission.enqueue(async () => {
        const events = await replayAll(this.options.store);
        const state = requireProgramState(events, programStateId);
        requireExactRevision(state, input.expectedProgramRevision);
        if (!sessionIsActive(events, String(input.sessionId)) ||
            !state.attachedSessionIds.some((id) => String(id) === String(input.sessionId))) {
          throw new ProgramDispatchStaleError("ProgramAttempt session is stopped or detached");
        }
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
