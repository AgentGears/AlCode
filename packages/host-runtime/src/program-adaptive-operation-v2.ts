import {
  asOperationId,
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
  ProgramDispatchWorkspaceCoordinatorV1,
  ProgramExecutionObservationSourceV1,
  ProgramMutationSettlementInputV1,
  ProgramRootOperationAuthorityV1,
  ProgramRootOperationContextV1,
  ProgramRootOperationInputV1,
  ProgramRoutedRootOperationInputV1,
  ProgramRoutedRootOperationResultV1,
} from "./program-dispatch.ts";
import type { ProgramSemanticCurrentStateSourceV1 } from "./program-revision.ts";
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
 * Adapter over the existing V1 Program operation authority. Admission remains
 * on the established Host authority graph. Only adaptive mutation settlement is
 * specialized so an already-admitted operation can publish terminal/effect/
 * quiescence truth after semantic invalidation without reviving its Attempt.
 */
export class ProgramAdaptiveRootOperationAuthorityV2 implements ProgramRootOperationAuthorityV1 {
  constructor(private readonly options: ProgramAdaptiveRootOperationAuthorityOptionsV2) {}

  resolveCurrentOperation(sessionId: EventSessionId): Promise<ProgramRootOperationContextV1 | null> {
    return this.options.delegate.resolveCurrentOperation(sessionId);
  }

  appendRoutedRootOperation(input: ProgramRoutedRootOperationInputV1): Promise<ProgramRoutedRootOperationResultV1> {
    return this.options.delegate.appendRoutedRootOperation(input);
  }

  appendRootOperation(
    input: ProgramRootOperationInputV1,
    drafts: readonly EventDraft<string, unknown>[],
  ): Promise<PersistedDomainEvent<string, unknown>[]> {
    return this.options.delegate.appendRootOperation(input, drafts);
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
