import {
  asOperationId,
  asProgramStateId as asEventProgramStateId,
  asWorkspaceId,
  mkEventId,
  type EventDraft,
  type PersistedDomainEvent,
  type SessionId as EventSessionId,
} from "@alcode/events";
import {
  applyProgramTransition,
  canonicalStringify,
  type ProgramAttemptExecutionBase,
  type ProgramState,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import {
  adaptiveTransitionEventV2,
  durableAdaptiveWorkspaceEffectGenerationV2,
  materializeAdaptiveMutationSettlementProgramStateV2,
  requireAdaptiveRawProgramStateV2,
} from "./program-adaptive-admission-v2.ts";
import type {
  ProgramAgentGenerationAuthorityV1,
  ProgramDispatchWorkspaceCoordinatorV1,
  ProgramExecutionObservationSourceV1,
  ProgramMutationSettlementInputV1,
  ProgramRecoveryAuthorityV1,
  ProgramRootOperationAuthorityV1,
  ProgramRootOperationContextV1,
  ProgramRootOperationInputV1,
  ProgramRoutedRootOperationInputV1,
  ProgramRoutedRootOperationResultV1,
} from "./program-dispatch.ts";
import {
  ProgramDispatchControlError,
  ProgramDispatchStaleError,
} from "./program-dispatch.ts";
import type { ProgramSemanticCurrentSnapshotV1, ProgramSemanticCurrentStateSourceV1 } from "./program-revision.ts";
import { ProgramSemanticRecoveryError } from "./program-semantic-recovery-v1.ts";

export class ProgramAdaptiveSettlementControlErrorV2 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramAdaptiveSettlementControlErrorV2";
  }
}

export interface ProgramAdaptiveRootOperationAuthorityOptionsV2 {
  store: WorkspaceEventStore;
  admission: CanonicalAdmissionQueue;
  workspaceCoordinator: ProgramDispatchWorkspaceCoordinatorV1;
  observations: ProgramExecutionObservationSourceV1;
  currentState: ProgramSemanticCurrentStateSourceV1;
  agentGenerations: ProgramAgentGenerationAuthorityV1;
  recovery: ProgramRecoveryAuthorityV1;
  delegate: ProgramRootOperationAuthorityV1;
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

function requireObservationWorkspace(store: WorkspaceEventStore, base: ProgramAttemptExecutionBase): void {
  if (base.observation.workspaceIdentity !== store.workspaceId) {
    throw new ProgramAdaptiveSettlementControlErrorV2(
      `Settlement observation belongs to another Workspace: ${base.observation.workspaceIdentity}`,
    );
  }
}

function sameBase(left: ProgramAttemptExecutionBase, right: ProgramAttemptExecutionBase): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

function effectiveObservedBase(
  events: readonly PersistedDomainEvent<string, unknown>[],
  base: ProgramAttemptExecutionBase,
): ProgramAttemptExecutionBase {
  const durable = durableAdaptiveWorkspaceEffectGenerationV2(events);
  if (durable === null || durable <= base.workspaceEffectGeneration) return base;
  return { ...base, workspaceEffectGeneration: durable };
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
      const legacyMayWrite = payload.workspaceAccessClass === undefined && payload.isReadOnly === false;
      if (operationId && payload.workspaceAccessClass === "may_write") writers.set(operationId, { legacy: false });
      else if (operationId && legacyMayWrite) writers.set(operationId, { legacy: true });
    } else if (event.type === "operation.completed") {
      const operationId = String(record(event.payload).operationId ?? event.operationId ?? "");
      if (operationId && writers.get(operationId)?.legacy) writers.delete(operationId);
    } else if (event.type === "operation.mutation_quiesced") {
      const operationId = String(record(event.payload).operationId ?? event.operationId ?? "");
      if (operationId) writers.delete(operationId);
    }
  }
  return [...writers.keys()].sort((left, right) => left.localeCompare(right, "en"));
}

function adaptiveCurrentOrNull(
  currentState: ProgramSemanticCurrentStateSourceV1,
  programStateId: string,
): Promise<ProgramSemanticCurrentSnapshotV1 | null> {
  return currentState.current(programStateId).then(
    (current) => current,
    (error: unknown) => {
      if (error instanceof ProgramSemanticRecoveryError) return null;
      throw error;
    },
  );
}

function requireAdaptiveProgramOwnership(
  current: ProgramSemanticCurrentSnapshotV1,
  raw: ProgramState,
  program: ProgramRootOperationContextV1,
  sessionId: string,
): void {
  if (current.lifecycle !== "active" || !current.attachedSessionIds.includes(sessionId)) {
    throw new ProgramDispatchStaleError("Adaptive ProgramAttempt session is detached or Program is not active");
  }
  const semanticAttempt = current.activeAttempt;
  if (semanticAttempt === null
      || String(semanticAttempt.programAttemptId) !== program.programAttemptId
      || String(semanticAttempt.workItemId) !== program.workItemId) {
    throw new ProgramDispatchStaleError("Adaptive ProgramAttempt was invalidated by semantic currentness");
  }
  if (raw.revision !== program.expectedProgramRevision) {
    throw new ProgramDispatchStaleError(
      `Adaptive Program revision mismatch: expected ${program.expectedProgramRevision}, current ${raw.revision}`,
    );
  }
  const attempt = raw.activeAttempt;
  if (attempt === null
      || String(attempt.programAttemptId) !== program.programAttemptId
      || String(attempt.workItemId) !== program.workItemId
      || String(attempt.sessionId) !== sessionId
      || attempt.agentGeneration !== program.agentGeneration) {
    throw new ProgramDispatchStaleError("Adaptive operational ProgramAttempt authority is stale");
  }
}

function isTrustedHostVerificationOperation(
  input: ProgramRoutedRootOperationInputV1,
): boolean {
  const requested = input.drafts[0];
  if (requested === undefined || requested.type !== "operation.requested") return false;
  const producer = record(requested.producer);
  if (producer.kind !== "runtime" || producer.component !== "host-capability-broker") return false;
  const invocation = record(record(requested.payload).programVerificationInvocation);
  if (typeof invocation.specId !== "string" || invocation.specId.length === 0
      || typeof invocation.specVersion !== "number"
      || !Number.isSafeInteger(invocation.specVersion) || invocation.specVersion <= 0
      || typeof invocation.canonicalArgsDigest !== "string" || invocation.canonicalArgsDigest.length === 0) {
    return false;
  }
  if (invocation.kind === "operation_result") {
    return typeof invocation.verificationObligationId === "string" && invocation.verificationObligationId.length > 0
      && typeof invocation.subjectGeneration === "number"
      && Number.isSafeInteger(invocation.subjectGeneration) && invocation.subjectGeneration > 0;
  }
  if (invocation.kind === "artifact_production") {
    return typeof invocation.productionStepId === "string" && invocation.productionStepId.length > 0
      && typeof invocation.outputSlotId === "string" && invocation.outputSlotId.length > 0;
  }
  return false;
}

function operationalProgramContextForAdaptiveAdmission(
  current: ProgramSemanticCurrentSnapshotV1,
  raw: ProgramState,
  input: ProgramRoutedRootOperationInputV1,
): ProgramRootOperationContextV1 {
  const program = input.program!;
  if (!isTrustedHostVerificationOperation(input)) return program;
  if (program.expectedProgramRevision !== current.programStateRevision) {
    throw new ProgramDispatchStaleError(
      `Adaptive Host verification semantic revision mismatch: expected ${program.expectedProgramRevision}, current ${current.programStateRevision}`,
    );
  }
  return { ...program, expectedProgramRevision: raw.revision };
}

function validateAdaptiveOperationDrafts(
  store: WorkspaceEventStore,
  input: ProgramRoutedRootOperationInputV1,
  program: ProgramRootOperationContextV1,
): EventDraft<string, unknown>[] {
  const operationId = String(asOperationId(input.operationId));
  const sessionId = String(input.sessionId);
  return input.drafts.map((draft, index) => {
    if (String(draft.workspaceId) !== store.workspaceId) {
      throw new ProgramDispatchControlError("Adaptive Program operation draft belongs to another Workspace");
    }
    if (String(draft.sessionId) !== sessionId) {
      throw new ProgramDispatchControlError("Adaptive Program operation draft session does not match Attempt authority");
    }
    if (draft.operationId === undefined || String(draft.operationId) !== operationId) {
      throw new ProgramDispatchControlError("Adaptive Program operation draft operationId does not match root operation");
    }
    if (draft.programStateId !== undefined && String(draft.programStateId) !== program.programStateId) {
      throw new ProgramDispatchControlError("Adaptive Program operation draft ProgramStateId does not match Attempt authority");
    }
    return {
      ...draft,
      ...(index === 0 ? {
        payload: {
          ...record(draft.payload),
          programStateId: program.programStateId,
          expectedProgramRevision: program.expectedProgramRevision,
          programAttemptId: program.programAttemptId,
          workItemId: program.workItemId,
          agentGeneration: program.agentGeneration,
        },
      } : {}),
      programStateId: asEventProgramStateId(program.programStateId),
    };
  });
}

function requestedMutation(
  events: readonly PersistedDomainEvent<string, unknown>[],
  input: ProgramMutationSettlementInputV1,
): PersistedDomainEvent<string, unknown> {
  const operationId = String(asOperationId(input.operationId));
  const requested = events.find((event) =>
    event.type === "operation.requested"
    && String(event.operationId ?? record(event.payload).operationId ?? "") === operationId,
  );
  if (requested === undefined || String(requested.programStateId ?? "") !== input.program.programStateId) {
    throw new ProgramAdaptiveSettlementControlErrorV2("Adaptive mutation settlement lacks its protected operation.requested event");
  }
  const payload = record(requested.payload);
  if (payload.workspaceAccessClass !== "may_write") {
    throw new ProgramAdaptiveSettlementControlErrorV2("Adaptive mutation settlement targets a non-may_write operation");
  }
  if (String(requested.sessionId ?? "") !== String(input.sessionId)
      || String(payload.programAttemptId ?? "") !== input.program.programAttemptId
      || String(payload.workItemId ?? "") !== input.program.workItemId
      || Number(payload.agentGeneration) !== input.program.agentGeneration) {
    throw new ProgramAdaptiveSettlementControlErrorV2(
      "Admitted mutation ownership cannot be reassigned after semantic Attempt invalidation",
    );
  }
  return requested;
}

function validateTerminalDrafts(
  store: WorkspaceEventStore,
  input: ProgramMutationSettlementInputV1,
  requested: PersistedDomainEvent<string, unknown>,
  drafts: readonly EventDraft<string, unknown>[],
): { completed: EventDraft<string, unknown>; quiesced: EventDraft<string, unknown> | undefined } {
  if (drafts.length === 0) throw new ProgramAdaptiveSettlementControlErrorV2("Adaptive mutation settlement requires terminal events");
  const operationId = String(input.operationId);
  const sessionId = String(input.sessionId);
  for (const draft of drafts) {
    if (String(draft.workspaceId) !== store.workspaceId
        || String(draft.sessionId) !== sessionId
        || draft.operationId === undefined || String(draft.operationId) !== operationId
        || draft.programStateId === undefined || String(draft.programStateId) !== input.program.programStateId) {
      throw new ProgramAdaptiveSettlementControlErrorV2("Adaptive mutation terminal event does not match protected operation ownership");
    }
  }
  const completed = drafts.find((draft) => draft.type === "operation.completed");
  if (completed === undefined) {
    throw new ProgramAdaptiveSettlementControlErrorV2("Adaptive mutation settlement requires a terminal completion fact");
  }
  const quiesced = drafts.find((draft) => draft.type === "operation.mutation_quiesced");
  if (input.quiescenceProven !== (quiesced !== undefined)) {
    throw new ProgramAdaptiveSettlementControlErrorV2("Adaptive settlement quiescence flag does not match canonical proof event");
  }
  const requestQuiescence = record(record(requested.payload).quiescenceContract);
  if (requestQuiescence.containment !== "operation_scoped_containment") {
    throw new ProgramAdaptiveSettlementControlErrorV2("Adaptive mutation settlement lacks a supported request-time quiescence contract");
  }
  if (quiesced !== undefined) {
    const actual = record(quiesced.payload);
    for (const key of ["containmentInstanceId", "containment", "proofContractId", "proofContractVersion", "providerBindingRevision"] as const) {
      if (canonicalStringify(requestQuiescence[key] ?? null) !== canonicalStringify(actual[key] ?? null)) {
        throw new ProgramAdaptiveSettlementControlErrorV2(`Adaptive mutation quiescence proof does not match request-time ${key}`);
      }
    }
    if (actual.proofKind !== "operation_containment_ended"
        || typeof actual.proofEvidenceDigest !== "string" || actual.proofEvidenceDigest.length === 0) {
      throw new ProgramAdaptiveSettlementControlErrorV2("Adaptive mutation quiescence proof lacks validated proof authority");
    }
  }
  return { completed, quiesced };
}

function effectGenerationDraft(
  store: WorkspaceEventStore,
  input: ProgramMutationSettlementInputV1,
  previous: number,
  next: number,
): EventDraft<string, unknown> {
  return {
    eventId: mkEventId(),
    idempotencyKey: `workspace.effect_generation.advanced:${input.operationId}`,
    correlationId: input.operationId,
    workspaceId: asWorkspaceId(store.workspaceId),
    sessionId: input.sessionId,
    operationId: asOperationId(input.operationId),
    programStateId: input.program.programStateId as never,
    occurredAt: new Date().toISOString(),
    type: "workspace.effect_generation.advanced",
    payload: {
      operationId: input.operationId,
      previousWorkspaceEffectGeneration: previous,
      workspaceEffectGeneration: next,
      effectStatus: "confirmed",
    },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-adaptive-settlement-v2" },
  };
}

/**
 * Adaptive Program operation authority. Fixed-topology and ordinary root
 * operations delegate unchanged. Adaptive operation admission is specialized
 * so semantic Attempt currentness is rechecked inside the same canonical
 * admission transaction that persists operation.requested. Once admitted, the
 * settlement path deliberately stops requiring current Attempt authority and
 * preserves terminal/effect/quiescence truth after semantic invalidation.
 */
export class ProgramAdaptiveRootOperationAuthorityV2 implements ProgramRootOperationAuthorityV1 {
  constructor(private readonly options: ProgramAdaptiveRootOperationAuthorityOptionsV2) {}

  async resolveCurrentOperation(sessionId: EventSessionId): Promise<ProgramRootOperationContextV1 | null> {
    const raw = await this.options.delegate.resolveCurrentOperation(sessionId);
    if (raw === null) return null;
    const current = await adaptiveCurrentOrNull(this.options.currentState, raw.programStateId);
    if (current === null) return raw;
    if (current.lifecycle !== "active" || !current.attachedSessionIds.includes(String(sessionId))) return null;
    const attempt = current.activeAttempt;
    if (attempt === null
        || String(attempt.programAttemptId) !== raw.programAttemptId
        || String(attempt.workItemId) !== raw.workItemId) return null;
    return raw;
  }

  async appendRoutedRootOperation(
    input: ProgramRoutedRootOperationInputV1,
  ): Promise<ProgramRoutedRootOperationResultV1> {
    if (input.drafts.length === 0 || input.drafts[0]?.type !== "operation.requested") {
      throw new ProgramDispatchControlError("Root operation must begin with operation.requested");
    }
    if (input.program === undefined) return this.options.delegate.appendRoutedRootOperation(input);

    const preliminaryCurrent = await adaptiveCurrentOrNull(this.options.currentState, input.program.programStateId);
    if (preliminaryCurrent === null) return this.options.delegate.appendRoutedRootOperation(input);

    return this.options.workspaceCoordinator.runExclusive(async () => {
      const preliminaryEvents = await replayAll(this.options.store);
      const observation = await this.options.observations.observe();
      if (observation.status === "unknown") {
        throw new ProgramDispatchStaleError(`Current execution base is unavailable: ${observation.reason}`);
      }
      requireObservationWorkspace(this.options.store, observation.base);
      const protectedObservation = effectiveObservedBase(preliminaryEvents, observation.base);

      return this.options.admission.enqueue(async () => {
        const events = await replayAll(this.options.store);
        const current = await this.options.currentState.current(input.program!.programStateId);
        const raw = requireAdaptiveRawProgramStateV2(events, input.program!.programStateId);
        const sessionId = String(input.sessionId);
        const program = operationalProgramContextForAdaptiveAdmission(current, raw, input);
        requireAdaptiveProgramOwnership(current, raw, program, sessionId);
        if (!sessionIsActive(events, sessionId)) {
          throw new ProgramDispatchStaleError("Adaptive ProgramAttempt session is stopped");
        }
        if (!await this.options.agentGenerations.isCurrent(sessionId, program.agentGeneration)) {
          throw new ProgramDispatchStaleError("Adaptive ProgramAttempt Agent generation is stale");
        }
        if (!await this.options.recovery.isClear()) {
          throw new ProgramDispatchStaleError("Adaptive Program recovery barrier is not clear");
        }
        const writers = outstandingWriterOperations(events);
        if (writers.length > 0) {
          throw new ProgramDispatchStaleError(`Outstanding Workspace writer barrier: ${writers.join(",")}`);
        }
        if (raw.executionBaseMismatch !== null || raw.executionBaseUnavailable || raw.activeAttempt === null) {
          throw new ProgramDispatchStaleError("Adaptive Program execution base is not current");
        }
        if (!sameBase(raw.activeAttempt.expectedExecutionBase, protectedObservation)) {
          throw new ProgramDispatchStaleError(
            "Adaptive ProgramAttempt execution base no longer matches the protected current base",
          );
        }
        if (input.workspaceAccessClass === "may_write") {
          const quiescence = record(record(input.drafts[0]!.payload).quiescenceContract);
          if (quiescence.containment !== "operation_scoped_containment"
              || typeof quiescence.proofContractId !== "string" || quiescence.proofContractId.length === 0
              || !Number.isSafeInteger(Number(quiescence.proofContractVersion)) || Number(quiescence.proofContractVersion) <= 0
              || typeof quiescence.containmentInstanceId !== "string" || quiescence.containmentInstanceId.length === 0) {
            return { status: "program_may_write_blocked", program } as const;
          }
        }
        const stamped = validateAdaptiveOperationDrafts(this.options.store, input, program);
        return {
          status: "appended",
          events: await this.options.store.append(stamped),
          program,
        } as const;
      });
    });
  }

  async appendRootOperation(
    input: ProgramRootOperationInputV1,
    drafts: readonly EventDraft<string, unknown>[],
  ): Promise<PersistedDomainEvent<string, unknown>[]> {
    const requested = record(drafts[0]?.payload);
    const explicit = requested.workspaceAccessClass;
    const workspaceAccessClass = explicit === "no_workspace_access" || explicit === "read_only" || explicit === "may_write"
      ? explicit
      : requested.isReadOnly === true ? "read_only" : "may_write";
    const routed = await this.appendRoutedRootOperation({
      sessionId: input.sessionId,
      operationId: input.operationId,
      workspaceAccessClass,
      program: {
        programStateId: input.programStateId,
        expectedProgramRevision: input.expectedProgramRevision,
        programAttemptId: input.programAttemptId,
        workItemId: input.workItemId,
        agentGeneration: input.agentGeneration,
      },
      drafts,
    });
    if (routed.status === "program_may_write_blocked") {
      throw new ProgramDispatchControlError("Adaptive Program may_write operation lacks supported quiescence authority");
    }
    return routed.events;
  }

  async settleProgramMutation(
    input: ProgramMutationSettlementInputV1,
  ): Promise<{ state: ProgramState | null; events: PersistedDomainEvent<string, unknown>[] }> {
    try {
      await this.options.currentState.current(input.program.programStateId);
    } catch (error) {
      if (error instanceof ProgramSemanticRecoveryError) {
        return this.options.delegate.settleProgramMutation(input);
      }
      throw error;
    }

    return this.options.workspaceCoordinator.runExclusive(async () => {
      const postObservation = input.quiescenceProven ? await this.options.observations.observe() : null;
      if (postObservation?.status === "complete") requireObservationWorkspace(this.options.store, postObservation.base);

      return this.options.admission.enqueue(async () => {
        const events = await replayAll(this.options.store);
        const requested = requestedMutation(events, input);
        if (events.some((event) => event.type === "workspace.effect_generation.advanced"
          && String(record(event.payload).operationId ?? event.operationId ?? "") === input.operationId)) {
          throw new ProgramAdaptiveSettlementControlErrorV2("Adaptive mutation effect generation was already settled");
        }
        const current = await this.options.currentState.current(input.program.programStateId);
        const raw = requireAdaptiveRawProgramStateV2(events, input.program.programStateId);
        const baseState = materializeAdaptiveMutationSettlementProgramStateV2(raw, current);
        const head = await this.options.store.headSequence();
        const terminalDrafts = [...input.buildTerminalDrafts(head)];
        const { completed, quiesced } = validateTerminalDrafts(
          this.options.store,
          input,
          requested,
          terminalDrafts,
        );
        const settlementDrafts: EventDraft<string, unknown>[] = [...terminalDrafts];
        const outcome = String(record(completed.payload).outcome ?? "failed");
        const effectConfirmed = outcome === "succeeded";
        let nextState: ProgramState | null = baseState;

        if (effectConfirmed) {
          const durable = durableAdaptiveWorkspaceEffectGenerationV2(events);
          const ownerBaseGeneration = raw.activeAttempt?.expectedExecutionBase.workspaceEffectGeneration
            ?? raw.acceptedExecutionBase?.workspaceEffectGeneration ?? 0;
          const previous = Math.max(ownerBaseGeneration, durable ?? ownerBaseGeneration);
          const nextGeneration = previous + 1;
          if (!Number.isSafeInteger(nextGeneration)) {
            throw new ProgramAdaptiveSettlementControlErrorV2("WorkspaceEffectGeneration overflow");
          }
          settlementDrafts.push(effectGenerationDraft(this.options.store, input, previous, nextGeneration));

          const attemptStillCurrent = baseState.activeAttempt !== null
            && String(baseState.activeAttempt.programAttemptId) === input.program.programAttemptId
            && String(baseState.activeAttempt.sessionId) === String(input.sessionId)
            && baseState.activeAttempt.agentGeneration === input.program.agentGeneration;
          if (baseState.lifecycle === "active") {
            if (attemptStillCurrent && quiesced !== undefined && postObservation?.status === "complete") {
              const settledBase: ProgramAttemptExecutionBase = {
                workspaceEffectGeneration: nextGeneration,
                observation: postObservation.base.observation,
              };
              nextState = applyProgramTransition(baseState, {
                kind: "attempt.execution_base.advance",
                expectedProgramRevision: baseState.revision,
                programAttemptId: input.program.programAttemptId,
                executionBase: settledBase,
                invalidateVerificationObligationIds: baseState.verification.map((item) => item.obligationId),
              });
              settlementDrafts.push(adaptiveTransitionEventV2(
                this.options.store,
                input.sessionId,
                nextState,
                "attempt.execution_base.advance",
                input.operationId,
                "program-adaptive-settlement-v2",
              ));
            } else {
              nextState = applyProgramTransition(baseState, {
                kind: "execution_base.unavailable",
                expectedProgramRevision: baseState.revision,
              });
              if (nextState !== baseState) {
                settlementDrafts.push(adaptiveTransitionEventV2(
                  this.options.store,
                  input.sessionId,
                  nextState,
                  "execution_base.unavailable",
                  input.operationId,
                  "program-adaptive-settlement-v2",
                ));
              }
            }
          }
        } else if (baseState.lifecycle === "active") {
          nextState = applyProgramTransition(baseState, {
            kind: "execution_base.unavailable",
            expectedProgramRevision: baseState.revision,
          });
          if (nextState !== baseState) {
            settlementDrafts.push(adaptiveTransitionEventV2(
              this.options.store,
              input.sessionId,
              nextState,
              "execution_base.unavailable",
              input.operationId,
              "program-adaptive-settlement-v2",
            ));
          }
        }

        const persisted = await this.options.store.append(settlementDrafts);
        for (let index = 0; index < persisted.length; index++) {
          if (persisted[index]?.sequence !== head + index + 1) {
            throw new ProgramAdaptiveSettlementControlErrorV2("Adaptive mutation settlement interleaved during canonical admission");
          }
        }
        return { state: nextState, events: persisted };
      });
    });
  }
}
