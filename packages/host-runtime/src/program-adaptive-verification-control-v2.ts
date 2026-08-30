import {
  asProgramStateId as asEventProgramStateId,
  asWorkspaceId,
  mkEventId,
  type EventDraft,
  type PersistedDomainEvent,
  type SessionId,
} from "@alcode/events";
import {
  ProgramRevisionConflictError,
  allRequiredSemanticWorkComplete,
  applyProgramTransition,
  assertValidProgramState,
  isVerificationCurrent,
  type ProgramSemanticStateV1,
  type ProgramState,
  type ProgramWorkItem,
  type VerificationObligation,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import type { CanonicalAdmissionQueue } from "./admission-queue.ts";
import {
  materializeAdaptiveMutationSettlementProgramStateV2,
  materializeAdaptiveRetainedAttemptProgramStateV2,
} from "./program-adaptive-admission-v2.ts";
import type {
  ProgramAdaptiveScheduleControlPortV2,
  ProgramAdaptiveScheduleResultV2,
} from "./program-adaptive-control-v2.ts";
import type { ProgramAdaptiveOperationalCurrentStateSourceV2 } from "./program-adaptive-operational-v2.ts";
import { ProgramSemanticRecoveryError } from "./program-semantic-recovery-v1.ts";
import {
  ProgramVerificationControlError,
  ProgramVerificationServiceV1,
  ProgramVerificationStaleError,
  type ProgramVerificationResultV1,
} from "./program-verification.ts";

const ADAPTIVE_VERIFICATION_COMPONENT = "program-adaptive-verification-v2";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isProgramStateEvent(event: PersistedDomainEvent<string, unknown>): boolean {
  return event.type === "program.created"
    || event.type === "program.transitioned"
    || event.type === "program.completed"
    || event.type === "program.cancelled";
}

function isProgramStateDraft(draft: EventDraft<string, unknown>): boolean {
  return draft.type === "program.created"
    || draft.type === "program.transitioned"
    || draft.type === "program.completed"
    || draft.type === "program.cancelled";
}

function materializeForVerification(
  raw: ProgramState,
  current: Awaited<ReturnType<ProgramAdaptiveOperationalCurrentStateSourceV2["current"]>>,
): ProgramState {
  const materialized = current.activeAttempt === null
    ? materializeAdaptiveMutationSettlementProgramStateV2(raw, current)
    : materializeAdaptiveRetainedAttemptProgramStateV2(raw, current);
  const requirementById = new Map(
    current.semanticState.workItems.map((work) => [String(work.workItemId), work.requirementState] as const),
  );
  return {
    ...materialized,
    workItems: materialized.workItems.map((work) =>
      requirementById.get(String(work.workItemId)) !== "required"
        ? { ...work, lifecycle: "completed" as const }
        : work),
  };
}

/**
 * Verification sees the exact current semantic materialization without first
 * persisting a synthetic ProgramState. Appends remain canonical base-store
 * events and are relabelled as trusted adaptive verification transitions.
 */
export class ProgramAdaptiveVerificationEventStoreV2 implements WorkspaceEventStore {
  constructor(
    private readonly base: WorkspaceEventStore,
    private readonly currentState: ProgramAdaptiveOperationalCurrentStateSourceV2,
  ) {}

  get workspaceId(): string {
    return this.base.workspaceId;
  }

  async append(
    drafts: readonly EventDraft<string, unknown>[],
  ): Promise<PersistedDomainEvent<string, unknown>[]> {
    const rewritten = drafts.map((draft) => {
      if (!isProgramStateDraft(draft)) return draft;
      const producer = record(draft.producer);
      if (producer.kind !== "runtime" || producer.component !== "program-verification") return draft;
      return {
        ...draft,
        producer: { kind: "runtime" as const, component: ADAPTIVE_VERIFICATION_COMPONENT },
      };
    });
    return this.base.append(rewritten);
  }

  async *replay(fromSequence?: number, toSequence?: number): AsyncIterable<PersistedDomainEvent<string, unknown>> {
    const events: PersistedDomainEvent<string, unknown>[] = [];
    for await (const event of this.base.replay(fromSequence, toSequence)) events.push(event);

    const latestByProgram = new Map<string, number>();
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      if (!isProgramStateEvent(event) || event.programStateId === undefined) continue;
      latestByProgram.set(String(event.programStateId), index);
    }

    for (const [programStateId, index] of latestByProgram) {
      const event = events[index]!;
      const raw = record(event.payload).state as ProgramState | undefined;
      if (raw === undefined) continue;
      assertValidProgramState(raw);
      try {
        const current = await this.currentState.current(programStateId);
        const state = materializeForVerification(raw, current);
        events[index] = {
          ...event,
          payload: { ...record(event.payload), state },
        };
      } catch (error) {
        if (!(error instanceof ProgramSemanticRecoveryError)) throw error;
      }
    }

    for (const event of events) yield event;
  }

  get(eventId: string): Promise<PersistedDomainEvent<string, unknown> | undefined> {
    return this.base.get(eventId);
  }

  headSequence(): Promise<number> {
    return this.base.headSequence();
  }

  getVerifiedEvents(fromSeq: number, limit: number): PersistedDomainEvent<string, unknown>[] {
    return this.base.getVerifiedEvents(fromSeq, limit);
  }

  getProjectionRunner(): ReturnType<WorkspaceEventStore["getProjectionRunner"]> {
    return this.base.getProjectionRunner();
  }

  recoverInterruptedOperations(): ReturnType<WorkspaceEventStore["recoverInterruptedOperations"]> {
    return this.base.recoverInterruptedOperations();
  }
}

function latestProgramState(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
): ProgramState {
  let state: ProgramState | undefined;
  for (const event of events) {
    if (!isProgramStateEvent(event) || String(event.programStateId ?? "") !== programStateId) continue;
    const candidate = record(event.payload).state as ProgramState | undefined;
    if (candidate !== undefined) state = candidate;
  }
  if (state === undefined) throw new ProgramVerificationControlError(`Unknown ProgramState ${programStateId}`);
  assertValidProgramState(state);
  return state;
}

async function replayAll(store: WorkspaceEventStore): Promise<PersistedDomainEvent<string, unknown>[]> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

function semanticWorkForVerification(
  semanticState: ProgramSemanticStateV1,
  work: ProgramWorkItem,
) {
  const semanticWork = semanticState.workItems.find((candidate) => candidate.workItemId === work.workItemId);
  if (semanticWork === undefined || semanticWork.requirementState !== "required") {
    throw new ProgramVerificationControlError(
      `Adaptive verification work ${String(work.workItemId)} is not a current required semantic WorkItem`,
    );
  }
  return semanticWork;
}

/**
 * Resolve verification ownership only from the frozen semantic subject binding.
 * Predicate shape, affected paths, and already-existing evidence are not
 * authority for deciding which WorkItem must carry an obligation.
 */
export function requiredAdaptiveVerificationForCurrentWorkV2(
  state: ProgramState,
  semanticState: ProgramSemanticStateV1,
  work: ProgramWorkItem,
): VerificationObligation[] {
  const semanticWork = semanticWorkForVerification(semanticState, work);
  const bindings = new Map(
    semanticState.verificationBindings.map((binding) => [String(binding.obligationId), binding] as const),
  );
  const programCompleteIfCurrentWorkSatisfied = allRequiredSemanticWorkComplete(
    semanticState.workItems.map((candidate) =>
      candidate.workItemId === semanticWork.workItemId
        ? { ...candidate, satisfactionState: "satisfied" as const }
        : candidate),
  );

  return state.verification.filter((obligation) => {
    const binding = bindings.get(String(obligation.obligationId));
    if (binding === undefined) {
      throw new ProgramVerificationControlError(
        `Adaptive verification obligation ${String(obligation.obligationId)} lacks its semantic subject binding`,
      );
    }
    switch (binding.subject.kind) {
      case "work_item":
        return binding.subject.workItemId === semanticWork.workItemId
          && binding.subject.workItemGeneration === semanticWork.workItemGeneration;
      case "output":
        return binding.subject.producerWorkItemId === semanticWork.workItemId
          && binding.subject.producerWorkItemGeneration === semanticWork.workItemGeneration;
      case "program":
        return programCompleteIfCurrentWorkSatisfied;
    }
  });
}

/**
 * Program-scoped artifact verification may be deferred until semantic closure,
 * but an artifact production step still belongs to its declared producer
 * WorkItem. Produce that durable artifact while the owning WorkItem/Attempt is
 * current so the final leaf never borrows another WorkItem's execution authority.
 */
export function requiredAdaptiveProgramArtifactProductionForCurrentWorkV2(
  state: ProgramState,
  semanticState: ProgramSemanticStateV1,
  work: ProgramWorkItem,
): VerificationObligation[] {
  const semanticWork = semanticWorkForVerification(semanticState, work);
  const bindings = new Map(
    semanticState.verificationBindings.map((binding) => [String(binding.obligationId), binding] as const),
  );

  return state.verification.filter((obligation) => {
    const binding = bindings.get(String(obligation.obligationId));
    if (binding === undefined) {
      throw new ProgramVerificationControlError(
        `Adaptive verification obligation ${String(obligation.obligationId)} lacks its semantic subject binding`,
      );
    }
    if (binding.subject.kind !== "program" || obligation.predicate.kind !== "artifact_present") return false;
    const slot = semanticState.outputSlots.find((candidate) =>
      candidate.outputSlotId === obligation.predicate.outputSlotId);
    if (slot === undefined) {
      throw new ProgramVerificationControlError(
        `Program-scoped artifact verification ${String(obligation.obligationId)} lacks its semantic output slot`,
      );
    }
    const step = semanticState.productionSteps.find((candidate) =>
      candidate.productionStepId === slot.productionStepId);
    if (step === undefined) {
      throw new ProgramVerificationControlError(
        `Program-scoped artifact verification ${String(obligation.obligationId)} lacks its semantic production step`,
      );
    }
    return step.producerWorkItemId === semanticWork.workItemId;
  });
}

function currentWork(state: ProgramState): ProgramWorkItem | undefined {
  const attempt = state.activeAttempt;
  return attempt === null ? undefined : state.workItems.find((item) => item.workItemId === attempt.workItemId);
}

function adaptiveTransitionDraft(
  store: WorkspaceEventStore,
  sessionId: SessionId,
  state: ProgramState,
  transitionKind: string,
  correlationId: string,
): EventDraft<string, unknown> {
  return {
    eventId: mkEventId(),
    idempotencyKey: `program.adaptive.verification:${String(state.programStateId)}:${state.revision}`,
    correlationId,
    workspaceId: asWorkspaceId(store.workspaceId),
    sessionId,
    programStateId: asEventProgramStateId(String(state.programStateId)),
    occurredAt: new Date().toISOString(),
    type: "program.transitioned",
    payload: { state, transitionKind },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: ADAPTIVE_VERIFICATION_COMPONENT },
  };
}

export type ProgramAdaptiveVerificationDriveResultV2 =
  | { status: "not_program" }
  | { status: "not_ready" }
  | { status: "advanced" }
  | { status: "stale" };

export interface ProgramAdaptiveVerificationControlOptionsV2 {
  store: WorkspaceEventStore;
  admission: CanonicalAdmissionQueue;
  currentState: ProgramAdaptiveOperationalCurrentStateSourceV2;
  verification: ProgramVerificationServiceV1;
}

/**
 * Host-owned adaptive verification/control. Agent progress may move current work
 * to awaiting_verification, but only this service can satisfy Host obligations,
 * retire the Attempt, and mark semantic work complete/pending for the next
 * scheduler decision.
 */
export class ProgramAdaptiveVerificationControlV2 {
  constructor(private readonly options: ProgramAdaptiveVerificationControlOptionsV2) {}

  async drive(sessionId: string): Promise<ProgramAdaptiveVerificationDriveResultV2> {
    const current = await this.options.currentState.currentForSession(sessionId);
    if (current === undefined) return { status: "not_program" };
    if (current.lifecycle !== "active" || current.activeAttempt === null) return { status: "not_ready" };

    const programStateId = String(current.semanticState.programStateId);
    let state = latestProgramState(await replayAll(this.options.store), programStateId);
    const attempt = state.activeAttempt;
    const work = currentWork(state);
    if (attempt === null || work === undefined || String(attempt.programAttemptId) !== String(current.activeAttempt.programAttemptId)) {
      return { status: "stale" };
    }
    if (work.lifecycle !== "awaiting_verification") return { status: "not_ready" };

    const maxVerificationPasses = Math.max(1, state.verification.length * 3 + state.productionSteps.length + 2);
    for (let pass = 0; pass < maxVerificationPasses; pass += 1) {
      state = latestProgramState(await replayAll(this.options.store), programStateId);
      const currentAttempt = state.activeAttempt;
      const currentWorkItem = currentWork(state);
      if (currentAttempt === null || currentWorkItem === undefined
          || String(currentAttempt.programAttemptId) !== String(attempt.programAttemptId)
          || currentWorkItem.lifecycle !== "awaiting_verification") return { status: "stale" };

      const semantic = await this.options.currentState.current(programStateId);
      if (semantic.programStateRevision !== state.revision
          || semantic.activeAttempt === null
          || String(semantic.activeAttempt.programAttemptId) !== String(currentAttempt.programAttemptId)) {
        return { status: "stale" };
      }

      const producerArtifact = requiredAdaptiveProgramArtifactProductionForCurrentWorkV2(
        state,
        semantic.semanticState,
        currentWorkItem,
      ).find((obligation) => {
        if (isVerificationCurrent(obligation) || obligation.predicate.kind !== "artifact_present") return false;
        return !state.artifacts.some((artifact) => artifact.outputSlotId === obligation.predicate.outputSlotId);
      });
      if (producerArtifact !== undefined) {
        if (producerArtifact.predicate.kind !== "artifact_present") {
          throw new ProgramVerificationControlError("Adaptive program artifact production lost its predicate identity");
        }
        try {
          const produced = await this.options.verification.executeProductionStep({
            programStateId,
            expectedProgramRevision: state.revision,
            outputSlotId: String(producerArtifact.predicate.outputSlotId),
            sessionId: sessionId as SessionId,
          });
          if (produced.status !== "bound") {
            await this.returnCurrentWorkToPending(programStateId, sessionId as SessionId, String(currentAttempt.programAttemptId));
            return { status: "advanced" };
          }
          continue;
        } catch (error) {
          if (error instanceof ProgramVerificationStaleError || error instanceof ProgramRevisionConflictError) {
            return { status: "stale" };
          }
          throw error;
        }
      }

      const pending = requiredAdaptiveVerificationForCurrentWorkV2(
        state,
        semantic.semanticState,
        currentWorkItem,
      ).find((obligation) => !isVerificationCurrent(obligation));
      if (pending === undefined) {
        await this.completeCurrentWork(state, sessionId as SessionId, String(currentAttempt.programAttemptId));
        return { status: "advanced" };
      }

      let result: ProgramVerificationResultV1;
      const command = {
        programStateId,
        expectedProgramRevision: state.revision,
        verificationObligationId: String(pending.obligationId),
        sessionId: sessionId as SessionId,
      };
      try {
        switch (pending.predicate.kind) {
          case "operation_result":
            result = await this.options.verification.satisfyOperationResult(command);
            break;
          case "workspace_path_state":
            result = await this.options.verification.satisfyWorkspacePathState(command);
            break;
          case "artifact_present": {
            const outputSlotId = pending.predicate.outputSlotId;
            const slotBound = state.artifacts.some((artifact) => artifact.outputSlotId === outputSlotId);
            if (!slotBound) {
              const produced = await this.options.verification.executeProductionStep({
                programStateId,
                expectedProgramRevision: state.revision,
                outputSlotId: String(outputSlotId),
                sessionId: sessionId as SessionId,
              });
              if (produced.status !== "bound") {
                await this.returnCurrentWorkToPending(programStateId, sessionId as SessionId, String(currentAttempt.programAttemptId));
                return { status: "advanced" };
              }
              state = produced.state;
            }
            result = await this.options.verification.satisfyArtifactPresent({
              ...command,
              expectedProgramRevision: state.revision,
            });
            break;
          }
          default:
            throw new ProgramVerificationControlError(
              `Unsupported adaptive verification predicate kind: ${String(pending.predicate.kind)}`,
            );
        }
      } catch (error) {
        if (error instanceof ProgramVerificationStaleError || error instanceof ProgramRevisionConflictError) {
          return { status: "stale" };
        }
        throw error;
      }

      if (result.status === "satisfied") continue;
      await this.returnCurrentWorkToPending(programStateId, sessionId as SessionId, String(currentAttempt.programAttemptId));
      return { status: "advanced" };
    }

    await this.returnCurrentWorkToPending(programStateId, sessionId as SessionId, String(attempt.programAttemptId));
    return { status: "advanced" };
  }

  private async completeCurrentWork(
    expected: ProgramState,
    sessionId: SessionId,
    programAttemptId: string,
  ): Promise<void> {
    await this.options.admission.enqueue(async () => {
      const state = latestProgramState(await replayAll(this.options.store), String(expected.programStateId));
      if (state.revision !== expected.revision || state.lifecycle !== "active") {
        throw new ProgramRevisionConflictError(expected.revision, state.revision);
      }
      const attempt = state.activeAttempt;
      const work = currentWork(state);
      if (attempt === null || work === undefined || String(attempt.programAttemptId) !== programAttemptId
          || work.lifecycle !== "awaiting_verification") {
        throw new ProgramVerificationStaleError("Adaptive ProgramAttempt changed before verified work completion");
      }
      const semantic = await this.options.currentState.current(String(state.programStateId));
      if (semantic.programStateRevision !== state.revision
          || semantic.activeAttempt === null
          || String(semantic.activeAttempt.programAttemptId) !== programAttemptId) {
        throw new ProgramVerificationStaleError("Adaptive semantic verification subject changed before work completion");
      }
      if (requiredAdaptiveVerificationForCurrentWorkV2(state, semantic.semanticState, work)
        .some((obligation) => !isVerificationCurrent(obligation))) {
        throw new ProgramVerificationControlError("Adaptive work verification is not complete");
      }
      const retired = applyProgramTransition(state, {
        kind: "attempt.interrupt",
        expectedProgramRevision: state.revision,
        programAttemptId,
      });
      const completed = applyProgramTransition(retired, {
        kind: "work.lifecycle.set",
        expectedProgramRevision: retired.revision,
        workItemId: work.workItemId,
        lifecycle: "completed",
      });
      const persisted = await this.options.store.append([
        adaptiveTransitionDraft(this.options.store, sessionId, retired, "attempt.interrupt:verified", programAttemptId),
        adaptiveTransitionDraft(this.options.store, sessionId, completed, "work.lifecycle.set:completed", programAttemptId),
      ]);
      if (persisted.length !== 2) {
        throw new ProgramVerificationControlError("Adaptive verified work completion admission was not atomic");
      }
    });
  }

  private async returnCurrentWorkToPending(
    programStateId: string,
    sessionId: SessionId,
    programAttemptId: string,
  ): Promise<void> {
    await this.options.admission.enqueue(async () => {
      const state = latestProgramState(await replayAll(this.options.store), programStateId);
      if (state.lifecycle !== "active" || state.activeAttempt === null
          || String(state.activeAttempt.programAttemptId) !== programAttemptId) return;
      const work = currentWork(state);
      if (work === undefined) throw new ProgramVerificationControlError("Adaptive retry work item is missing");
      const retired = applyProgramTransition(state, {
        kind: "attempt.interrupt",
        expectedProgramRevision: state.revision,
        programAttemptId,
      });
      const pending = applyProgramTransition(retired, {
        kind: "work.lifecycle.set",
        expectedProgramRevision: retired.revision,
        workItemId: work.workItemId,
        lifecycle: "pending",
      });
      const drafts = [
        adaptiveTransitionDraft(this.options.store, sessionId, retired, "attempt.interrupt:verification_failed", programAttemptId),
      ];
      if (pending !== retired) {
        drafts.push(adaptiveTransitionDraft(this.options.store, sessionId, pending, "work.lifecycle.set:pending", programAttemptId));
      }
      await this.options.store.append(drafts);
    });
  }
}

export class ProgramAdaptiveVerificationSchedulerV2 implements ProgramAdaptiveScheduleControlPortV2 {
  constructor(
    private readonly verification: ProgramAdaptiveVerificationControlV2,
    private readonly delegate: ProgramAdaptiveScheduleControlPortV2,
  ) {}

  async dispatchNext(sessionId: string): Promise<ProgramAdaptiveScheduleResultV2> {
    await this.verification.drive(sessionId);
    return this.delegate.dispatchNext(sessionId);
  }
}
