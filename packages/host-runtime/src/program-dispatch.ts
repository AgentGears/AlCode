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

export interface ProgramRootOperationContextV1 {
  programStateId: string;
  expectedProgramRevision: number;
  programAttemptId: string;
  workItemId: string;
  agentGeneration: number;
}

export interface ProgramRootOperationInputV1 extends ProgramRootOperationContextV1 {
  sessionId: EventSessionId;
  operationId: string;
}

export interface ProgramRoutedRootOperationInputV1 {
  sessionId: EventSessionId;
  operationId: string;
  workspaceAccessClass: "no_workspace_access" | "read_only" | "may_write";
  program?: ProgramRootOperationContextV1;
  drafts: readonly EventDraft<string, unknown>[];
}

export type ProgramRoutedRootOperationResultV1 =
  | {
      status: "appended";
      events: PersistedDomainEvent<string, unknown>[];
      program: ProgramRootOperationContextV1 | null;
    }
  | { status: "program_may_write_blocked"; program: ProgramRootOperationContextV1 };

export interface ProgramMutationSettlementInputV1 {
  sessionId: EventSessionId;
  operationId: string;
  program: ProgramRootOperationContextV1;
  buildTerminalDrafts(headSequence: number): readonly EventDraft<string, unknown>[];
}

export interface ProgramRootOperationAuthorityV1 {
  resolveCurrentOperation(sessionId: EventSessionId): Promise<ProgramRootOperationContextV1 | null>;
  appendRoutedRootOperation(
    input: ProgramRoutedRootOperationInputV1,
  ): Promise<ProgramRoutedRootOperationResultV1>;
  settleProgramMutation(
    input: ProgramMutationSettlementInputV1,
  ): Promise<{ state: ProgramState | null; events: PersistedDomainEvent<string, unknown>[] }>;
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

function currentProgramOperationContextFromEvents(
  events: readonly PersistedDomainEvent<string, unknown>[],
  sessionId: EventSessionId,
): ProgramRootOperationContextV1 | null {
  let current: ProgramRootOperationContextV1 | null = null;
  for (const [programStateId, state] of latestProgramStates(events)) {
    const attempt = state.lifecycle === "active" ? state.activeAttempt : null;
    if (attempt === null || String(attempt.sessionId) !== String(sessionId)) continue;
    const candidate: ProgramRootOperationContextV1 = {
      programStateId,
      expectedProgramRevision: state.revision,
      programAttemptId: String(attempt.programAttemptId),
      workItemId: String(attempt.workItemId),
      agentGeneration: attempt.agentGeneration,
    };
    if (current !== null) {
      throw new ProgramDispatchControlError(
        `Multiple active ProgramAttempts claim session ${String(sessionId)}`,
      );
    }
    current = candidate;
  }
  return current;
}

export async function resolveCurrentProgramOperationContext(
  store: WorkspaceEventStore,
  sessionId: EventSessionId,
): Promise<ProgramRootOperationContextV1 | null> {
  return currentProgramOperationContextFromEvents(await replayAll(store), sessionId);
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

function durableWorkspaceEffectGeneration(
  events: readonly PersistedDomainEvent<string, unknown>[],
): number | null {
  let current: number | null = null;
  for (const event of events) {
    if (event.type !== "workspace.effect_generation.advanced") continue;
    const generation = Number(record(event.payload).workspaceEffectGeneration);
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new ProgramDispatchControlError("Invalid durable WorkspaceEffectGeneration event");
    }
    current = current === null ? generation : Math.max(current, generation);
  }
  return current;
}

function effectiveObservedBase(
  events: readonly PersistedDomainEvent<string, unknown>[],
  base: ProgramAttemptExecutionBase,
): ProgramAttemptExecutionBase {
  const durable = durableWorkspaceEffectGeneration(events);
  if (durable === null || durable <= base.workspaceEffectGeneration) return base;
  return { ...base, workspaceEffectGeneration: durable };
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

        const currentBase = effectiveObservedBase(events, observation.base);
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
        const currentBase = effectiveObservedBase(events, observation.base);
        if (!sameBase(currentBase, candidate)) {
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

  resolveCurrentOperation(sessionId: EventSessionId): Promise<ProgramRootOperationContextV1 | null> {
    return resolveCurrentProgramOperationContext(this.options.store, sessionId);
  }

  async appendRoutedRootOperation(
    input: ProgramRoutedRootOperationInputV1,
  ): Promise<ProgramRoutedRootOperationResultV1> {
    const operationId = String(asOperationId(input.operationId));
    const sessionId = String(input.sessionId);
    if (input.drafts.length === 0 || input.drafts[0]?.type !== "operation.requested") {
      throw new ProgramDispatchControlError("Root operation must begin with operation.requested");
    }

    return this.options.workspaceCoordinator.runExclusive(async () => {
      const preliminaryEvents = await replayAll(this.options.store);
      const preliminaryProgram = input.program ??
        currentProgramOperationContextFromEvents(preliminaryEvents, input.sessionId);
      let protectedObservation: ProgramAttemptExecutionBase | null = null;
      if (preliminaryProgram !== null && preliminaryProgram !== undefined) {
        const observation = await this.options.observations.observe();
        if (observation.status === "unknown") {
          throw new ProgramDispatchStaleError(`Current execution base is unavailable: ${observation.reason}`);
        }
        requireObservationWorkspace(this.options.store, observation.base);
        protectedObservation = effectiveObservedBase(preliminaryEvents, observation.base);
      }

      return this.options.admission.enqueue(async () => {
        const events = await replayAll(this.options.store);
        const canonicalProgram = currentProgramOperationContextFromEvents(events, input.sessionId);
        const program = input.program ?? canonicalProgram;

        if (program === null || program === undefined) {
          if (input.workspaceAccessClass === "may_write") {
            const writers = outstandingWriterOperations(events);
            if (writers.length > 0) {
              throw new ProgramDispatchStaleError(`Outstanding Workspace writer barrier: ${writers.join(",")}`);
            }
          }
          const ordinary = input.drafts.map((draft) => {
            if (String(draft.workspaceId) !== this.options.store.workspaceId) {
              throw new ProgramDispatchControlError("Root operation draft belongs to another Workspace");
            }
            if (String(draft.sessionId) !== sessionId) {
              throw new ProgramDispatchControlError("Root operation draft session does not match request session");
            }
            if (draft.operationId === undefined || String(draft.operationId) !== operationId) {
              throw new ProgramDispatchControlError("Root operation draft operationId does not match root operation");
            }
            if (draft.programStateId !== undefined) {
              throw new ProgramDispatchControlError("Ordinary root operation may not carry ProgramStateId");
            }
            return draft;
          });
          return {
            status: "appended",
            events: await this.options.store.append(ordinary),
            program: null,
          } as const;
        }

        if (input.workspaceAccessClass === "may_write") {
          const requested = record(input.drafts[0]!.payload);
          const quiescence = record(requested.quiescenceContract);
          if (quiescence.containment !== "operation_scoped_containment" ||
              typeof quiescence.proofContractId !== "string" || quiescence.proofContractId.length === 0 ||
              !Number.isSafeInteger(Number(quiescence.proofContractVersion)) || Number(quiescence.proofContractVersion) <= 0 ||
              typeof quiescence.containmentInstanceId !== "string" || quiescence.containmentInstanceId.length === 0) {
            return { status: "program_may_write_blocked", program } as const;
          }
        }
        if (protectedObservation === null) {
          throw new ProgramDispatchStaleError(
            "ProgramAttempt became active after the protected routing observation cut",
          );
        }

        const programStateId = String(asProgramStateId(program.programStateId));
        const programAttemptId = String(asProgramAttemptId(program.programAttemptId));
        const workItemId = String(asProgramWorkItemId(program.workItemId));
        if (!Number.isSafeInteger(program.agentGeneration) || program.agentGeneration <= 0) {
          throw new ProgramDispatchControlError("agentGeneration must be a positive safe integer");
        }
        const state = requireProgramState(events, programStateId);
        requireExactRevision(state, program.expectedProgramRevision);
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
        if (attempt.agentGeneration !== program.agentGeneration ||
            !await this.options.agentGenerations.isCurrent(sessionId, program.agentGeneration)) {
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
        if (!sameBase(attempt.expectedExecutionBase, protectedObservation)) {
          throw new ProgramDispatchStaleError(
            "ProgramAttempt execution base no longer matches the protected current base",
          );
        }

        const ownership = {
          programStateId,
          expectedProgramRevision: program.expectedProgramRevision,
          programAttemptId,
          workItemId,
          agentGeneration: program.agentGeneration,
        };
        const stamped = input.drafts.map((draft, index) => {
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
          return {
            ...draft,
            ...(index === 0 ? { payload: { ...record(draft.payload), ...ownership } } : {}),
            programStateId: asEventProgramStateId(programStateId),
          };
        });
        return {
          status: "appended",
          events: await this.options.store.append(stamped),
          program,
        } as const;
      });
    });
  }

  async settleProgramMutation(
    input: ProgramMutationSettlementInputV1,
  ): Promise<{ state: ProgramState | null; events: PersistedDomainEvent<string, unknown>[] }> {
    const operationId = String(asOperationId(input.operationId));
    const programStateId = String(asProgramStateId(input.program.programStateId));
    const programAttemptId = String(asProgramAttemptId(input.program.programAttemptId));
    const sessionId = String(input.sessionId);

    return this.options.workspaceCoordinator.runExclusive(async () => {
      const postObservation = await this.options.observations.observe();
      if (postObservation.status === "complete") {
        requireObservationWorkspace(this.options.store, postObservation.base);
      }

      return this.options.admission.enqueue(async () => {
        const events = await replayAll(this.options.store);
        const state = requireProgramState(events, programStateId);
        const requestedEvent = events.find((event) =>
          event.type === "operation.requested" && String(event.operationId ?? record(event.payload).operationId ?? "") === operationId,
        );
        if (requestedEvent === undefined || String(requestedEvent.programStateId ?? "") !== programStateId) {
          throw new ProgramDispatchControlError("Program mutation settlement lacks its protected operation.requested event");
        }
        const requestedPayload = record(requestedEvent.payload);
        if (requestedPayload.workspaceAccessClass !== "may_write") {
          throw new ProgramDispatchControlError("Program mutation settlement targets a non-may_write operation");
        }
        const requestQuiescence = record(requestedPayload.quiescenceContract);
        if (requestQuiescence.containment !== "operation_scoped_containment") {
          throw new ProgramDispatchControlError("Program mutation settlement lacks a supported request-time quiescence contract");
        }
        if (events.some((event) =>
          event.type === "workspace.effect_generation.advanced" &&
          String(record(event.payload).operationId ?? event.operationId ?? "") === operationId,
        )) {
          throw new ProgramDispatchControlError("Program mutation effect generation was already settled");
        }

        const head = await this.options.store.headSequence();
        const terminalDrafts = [...input.buildTerminalDrafts(head)];
        if (terminalDrafts.length === 0) {
          throw new ProgramDispatchControlError("Program mutation settlement requires terminal events");
        }
        for (const draft of terminalDrafts) {
          if (String(draft.workspaceId) !== this.options.store.workspaceId ||
              String(draft.sessionId) !== sessionId ||
              draft.operationId === undefined || String(draft.operationId) !== operationId ||
              draft.programStateId === undefined || String(draft.programStateId) !== programStateId) {
            throw new ProgramDispatchControlError("Program mutation terminal event does not match protected operation ownership");
          }
        }
        const completed = terminalDrafts.find((draft) => draft.type === "operation.completed");
        const quiesced = terminalDrafts.find((draft) => draft.type === "operation.mutation_quiesced");
        if (completed === undefined || quiesced === undefined) {
          throw new ProgramDispatchControlError("Program mutation settlement requires completion and quiescence facts");
        }
        const quiescedPayload = record(quiesced.payload);
        for (const key of ["containmentInstanceId", "containment", "proofContractId", "proofContractVersion", "providerBindingRevision"] as const) {
          const expected = requestQuiescence[key];
          const actual = quiescedPayload[key];
          if (canonicalStringify(expected ?? null) !== canonicalStringify(actual ?? null)) {
            throw new ProgramDispatchControlError(`Program mutation quiescence proof does not match request-time ${key}`);
          }
        }

        const outcome = String(record(completed.payload).outcome ?? "failed");
        const effectConfirmed = outcome === "succeeded";
        const settlementDrafts: EventDraft<string, unknown>[] = [...terminalDrafts];
        let nextState: ProgramState | null = state;

        if (effectConfirmed) {
          const durableGeneration = durableWorkspaceEffectGeneration(events);
          const attempt = state.lifecycle === "active" ? state.activeAttempt : null;
          const attemptGeneration = attempt?.expectedExecutionBase.workspaceEffectGeneration ??
            state.acceptedExecutionBase?.workspaceEffectGeneration ?? 0;
          const previousGeneration = Math.max(attemptGeneration, durableGeneration ?? attemptGeneration);
          const nextGeneration = previousGeneration + 1;
          if (!Number.isSafeInteger(nextGeneration)) {
            throw new ProgramDispatchControlError("WorkspaceEffectGeneration overflow");
          }
          settlementDrafts.push({
            eventId: mkEventId(),
            idempotencyKey: `workspace.effect_generation.advanced:${operationId}`,
            correlationId: operationId,
            workspaceId: asWorkspaceId(this.options.store.workspaceId),
            sessionId: input.sessionId,
            operationId: asOperationId(operationId),
            occurredAt: new Date().toISOString(),
            type: "workspace.effect_generation.advanced",
            payload: {
              operationId,
              previousWorkspaceEffectGeneration: previousGeneration,
              workspaceEffectGeneration: nextGeneration,
              effectStatus: "confirmed",
            },
            payloadSchemaVersion: 1,
            producer: { kind: "runtime", component: "program-dispatch" },
          });

          const currentAttempt = state.lifecycle === "active" ? state.activeAttempt : null;
          const attemptStillCurrent = currentAttempt !== null &&
            String(currentAttempt.programAttemptId) === programAttemptId &&
            String(currentAttempt.sessionId) === sessionId &&
            currentAttempt.agentGeneration === input.program.agentGeneration &&
            (durableGeneration === null || durableGeneration <= currentAttempt.expectedExecutionBase.workspaceEffectGeneration);

          if (state.lifecycle === "active") {
            if (attemptStillCurrent && postObservation.status === "complete") {
              const settledBase: ProgramAttemptExecutionBase = {
                workspaceEffectGeneration: nextGeneration,
                observation: postObservation.base.observation,
              };
              nextState = applyProgramTransition(state, {
                kind: "attempt.execution_base.advance",
                expectedProgramRevision: state.revision,
                programAttemptId,
                executionBase: settledBase,
                // Until bounded path-impact admission lands, self-mutation impact is
                // conservatively unknown and invalidates every current obligation.
                invalidateVerificationObligationIds: state.verification.map((item) => item.obligationId),
              });
              settlementDrafts.push(transitionEvent(
                this.options.store,
                input.sessionId,
                nextState,
                "attempt.execution_base.advance",
                operationId,
              ));
            } else {
              nextState = applyProgramTransition(state, {
                kind: "execution_base.unavailable",
                expectedProgramRevision: state.revision,
              });
              if (nextState !== state) {
                settlementDrafts.push(transitionEvent(
                  this.options.store,
                  input.sessionId,
                  nextState,
                  "execution_base.unavailable",
                  operationId,
                ));
              }
            }
          }
        } else if (state.lifecycle === "active") {
          // A failed may_write has indeterminate effect certainty. Quiescence is
          // known, but no trusted execution base may be adopted.
          nextState = applyProgramTransition(state, {
            kind: "execution_base.unavailable",
            expectedProgramRevision: state.revision,
          });
          if (nextState !== state) {
            settlementDrafts.push(transitionEvent(
              this.options.store,
              input.sessionId,
              nextState,
              "execution_base.unavailable",
              operationId,
            ));
          }
        }

        const persisted = await this.options.store.append(settlementDrafts);
        for (let i = 0; i < persisted.length; i++) {
          if (persisted[i]?.sequence !== head + i + 1) {
            throw new ProgramDispatchControlError("Program mutation settlement interleaved during canonical admission");
          }
        }
        return { state: nextState, events: persisted };
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
        const currentBase = effectiveObservedBase(events, observation.base);
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
        if (!sameBase(attempt.expectedExecutionBase, currentBase)) {
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
        const currentBase = effectiveObservedBase(events, observation.base);
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
        if (!sameBase(attempt.expectedExecutionBase, currentBase)) {
          throw new ProgramDispatchStaleError("ProgramAttempt execution base no longer matches the protected current base");
        }
        return { state, executionBase: currentBase };
      });
    });
  }
}

export { ProgramRevisionConflictError, ProgramTransitionError };
