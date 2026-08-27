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
  applyProgramTransition,
  asProgramAttemptId,
  asSessionId,
  assertValidProgramState,
  canonicalStringify,
  deriveReadySemanticWorkItems,
  isProgramSemanticRequirementComplete,
  type ProgramAttempt,
  type ProgramAttemptExecutionBase,
  type ProgramSemanticWorkItemV1,
  type ProgramState,
  type ProgramWorkItem,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import type {
  ProgramAdaptiveAttemptAdmissionResultV2,
  ProgramAdaptiveAttemptAdmissionV2,
  ProgramAdaptiveEligibilityFactSourceV2,
  ProgramAdaptiveEligibilityFactsV2,
} from "./program-adaptive-control-v2.ts";
import { recoverAdaptiveProgramCurrentSnapshotV2 } from "./program-adaptive-operational-v2.ts";
import type {
  ProgramAgentGenerationAuthorityV1,
  ProgramDispatchWorkspaceCoordinatorV1,
  ProgramExecutionObservationSourceV1,
  ProgramFirstDispatchPlanningBridgeV1,
  ProgramRecoveryAuthorityV1,
} from "./program-dispatch.ts";
import type { ProgramSemanticCurrentSnapshotV1 } from "./program-revision.ts";

export class ProgramAdaptiveAdmissionControlErrorV2 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramAdaptiveAdmissionControlErrorV2";
  }
}

export interface ProgramAdaptiveAdmissionServiceOptionsV2 {
  store: WorkspaceEventStore;
  admission: CanonicalAdmissionQueue;
  workspaceCoordinator: ProgramDispatchWorkspaceCoordinatorV1;
  observations: ProgramExecutionObservationSourceV1;
  agentGenerations: ProgramAgentGenerationAuthorityV1;
  recovery: ProgramRecoveryAuthorityV1;
  firstDispatchPlanning: ProgramFirstDispatchPlanningBridgeV1;
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
  return type === "program.created" || type === "program.transitioned"
    || type === "program.completed" || type === "program.cancelled";
}

function latestProgramStates(
  events: readonly PersistedDomainEvent<string, unknown>[],
): Map<string, ProgramState> {
  const states = new Map<string, ProgramState>();
  for (const event of events) {
    if (!isProgramStateEvent(event.type) || event.programStateId === undefined) continue;
    const state = record(event.payload).state as ProgramState | undefined;
    if (state === undefined) throw new ProgramAdaptiveAdmissionControlErrorV2(`${event.type} lacks payload.state`);
    assertValidProgramState(state);
    if (String(state.programStateId) !== String(event.programStateId)) {
      throw new ProgramAdaptiveAdmissionControlErrorV2(`${event.type} state identity does not match envelope`);
    }
    states.set(String(event.programStateId), state);
  }
  return states;
}

export function requireAdaptiveRawProgramStateV2(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
): ProgramState {
  const state = latestProgramStates(events).get(programStateId);
  if (state === undefined) throw new ProgramAdaptiveAdmissionControlErrorV2(`Unknown ProgramState ${programStateId}`);
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

export function durableAdaptiveWorkspaceEffectGenerationV2(
  events: readonly PersistedDomainEvent<string, unknown>[],
): number | null {
  let current: number | null = null;
  for (const event of events) {
    if (event.type !== "workspace.effect_generation.advanced") continue;
    const generation = Number(record(event.payload).workspaceEffectGeneration);
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new ProgramAdaptiveAdmissionControlErrorV2("Invalid durable WorkspaceEffectGeneration event");
    }
    current = current === null ? generation : Math.max(current, generation);
  }
  return current;
}

function effectiveObservedBase(
  events: readonly PersistedDomainEvent<string, unknown>[],
  base: ProgramAttemptExecutionBase,
): ProgramAttemptExecutionBase {
  const durable = durableAdaptiveWorkspaceEffectGenerationV2(events);
  if (durable === null || durable <= base.workspaceEffectGeneration) return base;
  return { ...base, workspaceEffectGeneration: durable };
}

function sameBase(left: ProgramAttemptExecutionBase, right: ProgramAttemptExecutionBase): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

function requireObservationWorkspace(store: WorkspaceEventStore, base: ProgramAttemptExecutionBase): void {
  if (base.observation.workspaceIdentity !== store.workspaceId) {
    throw new ProgramAdaptiveAdmissionControlErrorV2(
      `Execution observation belongs to another Workspace: ${base.observation.workspaceIdentity}`,
    );
  }
}

function hasAnyAttempt(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
): boolean {
  return events.some((event) => {
    if (event.type !== "program.transitioned" || String(event.programStateId ?? "") !== programStateId) return false;
    return record(event.payload).transitionKind === "attempt.issue";
  });
}

function logicalActiveWorkspaceAttempt(
  events: readonly PersistedDomainEvent<string, unknown>[],
  excludingProgramStateId?: string,
): { programStateId: string; programAttemptId: string } | null {
  for (const [programStateId, raw] of latestProgramStates(events)) {
    if (programStateId === excludingProgramStateId) continue;
    const adaptive = recoverAdaptiveProgramCurrentSnapshotV2(events, programStateId);
    if (adaptive !== undefined) {
      if (adaptive.lifecycle === "active" && adaptive.activeAttempt !== null) {
        return { programStateId, programAttemptId: String(adaptive.activeAttempt.programAttemptId) };
      }
      continue;
    }
    if (raw.lifecycle === "active" && raw.activeAttempt !== null) {
      return { programStateId, programAttemptId: String(raw.activeAttempt.programAttemptId) };
    }
  }
  return null;
}

function lifecycleForSemanticWork(
  work: ProgramSemanticWorkItemV1,
  allWork: readonly ProgramSemanticWorkItemV1[],
  legacy: ProgramWorkItem | undefined,
): ProgramWorkItem["lifecycle"] {
  if (work.requirementState !== "required") return legacy?.lifecycle ?? "completed";
  if (work.topologyState === "decomposed") {
    return isProgramSemanticRequirementComplete(work.workItemId, allWork) ? "completed" : "pending";
  }
  switch (work.satisfactionState) {
    case "pending": return "pending";
    case "active": return "in_progress";
    case "blocked": return "blocked";
    case "awaiting_verification": return "awaiting_verification";
    case "satisfied": return "completed";
  }
}

function materializeSemanticCollections(
  raw: ProgramState,
  current: ProgramSemanticCurrentSnapshotV1,
): Pick<ProgramState, "workItems" | "blockers" | "verification" | "outputSlots" | "productionSteps" | "decisiveEvidence" | "artifacts"> {
  const rawWork = new Map(raw.workItems.map((work) => [String(work.workItemId), work]));
  const workItems: ProgramWorkItem[] = current.semanticState.workItems.map((work) => ({
    workItemId: work.workItemId,
    creationOrder: work.creationOrder,
    description: work.description,
    dependencyIds: [...work.dependencyIds],
    affectedPaths: [...work.affectedPaths],
    lifecycle: lifecycleForSemanticWork(work, current.semanticState.workItems, rawWork.get(String(work.workItemId))),
  }));
  const workIds = new Set(workItems.map((work) => String(work.workItemId)));
  const verification = current.semanticState.verification.map((item) => structuredClone(item));
  const verificationIds = new Set(verification.map((item) => String(item.obligationId)));
  const outputSlots = current.semanticState.outputSlots.map((item) => structuredClone(item));
  const outputSlotIds = new Set(outputSlots.map((item) => String(item.outputSlotId)));
  const productionSteps = current.semanticState.productionSteps.map((item) => structuredClone(item));
  const productionStepIds = new Set(productionSteps.map((item) => String(item.productionStepId)));
  const blockers = raw.blockers
    .filter((item) => item.workItemId === null || workIds.has(String(item.workItemId)))
    .map((item) => structuredClone(item));
  const artifacts = raw.artifacts
    .filter((item) => (item.outputSlotId === null || outputSlotIds.has(String(item.outputSlotId)))
      && (item.productionStepId === null || productionStepIds.has(String(item.productionStepId))))
    .map((item) => structuredClone(item));
  const artifactRefs = new Set(artifacts.map((item) => item.artifactRef));
  const decisiveEvidence = raw.decisiveEvidence
    .filter((item) => (item.workItemId === null || workIds.has(String(item.workItemId)))
      && (item.verificationObligationId === null || verificationIds.has(String(item.verificationObligationId)))
      && (item.artifactRef === null || artifactRefs.has(item.artifactRef)))
    .map((item) => structuredClone(item));
  return { workItems, blockers, verification, outputSlots, productionSteps, decisiveEvidence, artifacts };
}

function materializeAdaptiveBase(
  raw: ProgramState,
  current: ProgramSemanticCurrentSnapshotV1,
  activeAttempt: ProgramAttempt | null,
  acceptedExecutionBase: ProgramAttemptExecutionBase | null,
  clearExecutionControl: boolean,
): ProgramState {
  if (String(raw.programStateId) !== String(current.semanticState.programStateId)) {
    throw new ProgramAdaptiveAdmissionControlErrorV2("Semantic and operational ProgramState identity differ");
  }
  const next: ProgramState = {
    ...structuredClone(raw),
    ...materializeSemanticCollections(raw, current),
    lifecycle: current.lifecycle,
    revision: current.programStateRevision,
    attachedSessionIds: current.attachedSessionIds.map((id) => asSessionId(id)),
    activeAttempt: activeAttempt === null ? null : structuredClone(activeAttempt),
    acceptedExecutionBase: acceptedExecutionBase === null ? null : structuredClone(acceptedExecutionBase),
    executionBaseMismatch: clearExecutionControl ? null : structuredClone(raw.executionBaseMismatch),
    executionBaseUnavailable: clearExecutionControl ? false : raw.executionBaseUnavailable,
  };
  assertValidProgramState(next);
  return next;
}

export function materializeAdaptiveOperationalProgramStateV2(
  raw: ProgramState,
  current: ProgramSemanticCurrentSnapshotV1,
  acceptedExecutionBase: ProgramAttemptExecutionBase,
): ProgramState {
  return materializeAdaptiveBase(raw, current, null, acceptedExecutionBase, true);
}

export function materializeAdaptiveRetainedAttemptProgramStateV2(
  raw: ProgramState,
  current: ProgramSemanticCurrentSnapshotV1,
): ProgramState {
  if (current.lifecycle !== "active" || current.activeAttempt === null || raw.activeAttempt === null) {
    throw new ProgramAdaptiveAdmissionControlErrorV2("Adaptive retained-attempt materialization requires one current Attempt");
  }
  if (String(raw.activeAttempt.programAttemptId) !== String(current.activeAttempt.programAttemptId)
      || String(raw.activeAttempt.workItemId) !== String(current.activeAttempt.workItemId)
      || raw.activeAttempt.agentGeneration <= 0) {
    throw new ProgramAdaptiveAdmissionControlErrorV2("Raw Attempt does not match current retained semantic authority");
  }
  return materializeAdaptiveBase(
    raw,
    current,
    raw.activeAttempt,
    raw.activeAttempt.expectedExecutionBase,
    false,
  );
}

export function materializeAdaptiveMutationSettlementProgramStateV2(
  raw: ProgramState,
  current: ProgramSemanticCurrentSnapshotV1,
): ProgramState {
  let activeAttempt: ProgramAttempt | null = null;
  let acceptedExecutionBase = raw.acceptedExecutionBase;
  if (current.activeAttempt !== null) {
    if (raw.activeAttempt === null
        || String(raw.activeAttempt.programAttemptId) !== String(current.activeAttempt.programAttemptId)) {
      throw new ProgramAdaptiveAdmissionControlErrorV2("Current retained semantic Attempt lacks matching operational Attempt truth");
    }
    activeAttempt = raw.activeAttempt;
    acceptedExecutionBase = raw.activeAttempt.expectedExecutionBase;
  }
  return materializeAdaptiveBase(raw, current, activeAttempt, acceptedExecutionBase, false);
}

export function adaptiveTransitionEventV2(
  store: WorkspaceEventStore,
  sessionId: EventSessionId,
  state: ProgramState,
  transitionKind: string,
  correlationId: string,
  component: "program-adaptive-admission-v2" | "program-adaptive-progress-v2" | "program-adaptive-settlement-v2",
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
    producer: { kind: "runtime", component },
  };
}

export class ProgramAdaptiveAdmissionServiceV2
implements ProgramAdaptiveAttemptAdmissionV2, ProgramAdaptiveEligibilityFactSourceV2 {
  constructor(private readonly options: ProgramAdaptiveAdmissionServiceOptionsV2) {}

  async currentForSession(
    sessionId: string,
    semantic: ProgramSemanticCurrentSnapshotV1,
  ): Promise<ProgramAdaptiveEligibilityFactsV2> {
    const events = await replayAll(this.options.store);
    const raw = requireAdaptiveRawProgramStateV2(events, String(semantic.semanticState.programStateId));
    const writers = outstandingWriterOperations(events);
    const recoveryClear = await this.options.recovery.isClear();
    const observation = await this.options.observations.observe();
    let executionBaseCurrent = false;
    if (observation.status === "complete") {
      const currentBase = effectiveObservedBase(events, observation.base);
      requireObservationWorkspace(this.options.store, currentBase);
      executionBaseCurrent = raw.executionBaseMismatch === null
        && !raw.executionBaseUnavailable
        && (raw.acceptedExecutionBase === null || sameBase(raw.acceptedExecutionBase, currentBase));
    }
    return {
      hasActiveAttachedExecutionEpisode:
        sessionIsActive(events, sessionId) && semantic.attachedSessionIds.includes(sessionId),
      workspaceReservationAvailable:
        logicalActiveWorkspaceAttempt(events, String(semantic.semanticState.programStateId)) === null,
      recoveryClear,
      writerBarriersClear: writers.length === 0,
      quiescenceClear: writers.length === 0,
      executionBaseCurrent,
      openCanonicalBlockers: raw.blockers
        .filter((blocker) => blocker.state === "open")
        .map((blocker) => ({ workItemId: blocker.workItemId === null ? null : String(blocker.workItemId) })),
    };
  }

  async issue(input: {
    programStateId: string;
    expectedProgramStateRevision: number;
    expectedProgramRevisionId: string;
    workItemId: string;
    workItemGeneration: number;
    sessionId: string;
    agentGeneration: number;
    dispatchKind: "first" | "successor";
  }): Promise<ProgramAdaptiveAttemptAdmissionResultV2> {
    if (!Number.isSafeInteger(input.agentGeneration) || input.agentGeneration <= 0) {
      throw new ProgramAdaptiveAdmissionControlErrorV2("agentGeneration must be a positive safe integer");
    }
    return this.options.workspaceCoordinator.runExclusive(async () => {
      if (input.dispatchKind === "first") {
        await this.options.firstDispatchPlanning.recheckAcceptedPlanningBase(
          asEventProgramStateId(input.programStateId),
        );
      }
      const observation = await this.options.observations.observe();
      return this.options.admission.enqueue(async () => {
        const events = await replayAll(this.options.store);
        const current = recoverAdaptiveProgramCurrentSnapshotV2(events, input.programStateId);
        if (current === undefined) return { status: "stale", reason: "adaptive_semantics_missing" };
        if (current.programStateRevision !== input.expectedProgramStateRevision
            || String(current.semanticState.currentRevision.programRevisionId) !== input.expectedProgramRevisionId) {
          return { status: "stale", reason: "program_currentness_changed" };
        }
        if (current.lifecycle !== "active") return { status: "stale", reason: "program_not_active" };
        if (!current.attachedSessionIds.includes(input.sessionId) || !sessionIsActive(events, input.sessionId)) {
          return { status: "blocked", reason: "session_inactive" };
        }
        if (current.activeAttempt !== null) return { status: "stale", reason: "attempt_already_active" };
        const expectedDispatchKind = hasAnyAttempt(events, input.programStateId) ? "successor" : "first";
        if (expectedDispatchKind !== input.dispatchKind) return { status: "stale", reason: "dispatch_kind_changed" };
        const target = current.semanticState.workItems.find((work) => String(work.workItemId) === input.workItemId);
        if (target === undefined
            || target.requirementState !== "required"
            || target.topologyState !== "leaf"
            || target.satisfactionState !== "pending"
            || target.workItemGeneration !== input.workItemGeneration) {
          return { status: "stale", reason: "work_currentness_changed" };
        }
        if (!deriveReadySemanticWorkItems(current.semanticState.workItems)
          .some((work) => String(work.workItemId) === input.workItemId)) {
          return { status: "stale", reason: "work_not_ready" };
        }
        if (!await this.options.agentGenerations.isCurrent(input.sessionId, input.agentGeneration)) {
          return { status: "blocked", reason: "agent_generation_stale" };
        }
        if (!await this.options.recovery.isClear()) return { status: "blocked", reason: "recovery_blocked" };
        if (outstandingWriterOperations(events).length > 0) return { status: "blocked", reason: "writer_barrier" };
        if (logicalActiveWorkspaceAttempt(events, input.programStateId) !== null) {
          return { status: "blocked", reason: "workspace_busy" };
        }
        const raw = requireAdaptiveRawProgramStateV2(events, input.programStateId);
        if (raw.executionBaseMismatch !== null || raw.executionBaseUnavailable) {
          return { status: "blocked", reason: "execution_base_stale" };
        }
        if (observation.status === "unknown") return { status: "blocked", reason: "execution_base_unavailable" };
        const currentBase = effectiveObservedBase(events, observation.base);
        requireObservationWorkspace(this.options.store, currentBase);
        if (raw.acceptedExecutionBase !== null && !sameBase(raw.acceptedExecutionBase, currentBase)) {
          return { status: "blocked", reason: "execution_base_stale" };
        }
        const materialized = materializeAdaptiveOperationalProgramStateV2(raw, current, currentBase);
        const attemptId = asProgramAttemptId(uuidv7());
        const next = applyProgramTransition(materialized, {
          kind: "attempt.issue",
          expectedProgramRevision: materialized.revision,
          attempt: {
            programAttemptId: attemptId,
            workItemId: target.workItemId,
            sessionId: asSessionId(input.sessionId),
            agentGeneration: input.agentGeneration,
            initialExecutionBase: currentBase,
            expectedExecutionBase: currentBase,
          },
        });
        await this.options.store.append([
          adaptiveTransitionEventV2(
            this.options.store,
            input.sessionId as EventSessionId,
            next,
            "attempt.issue",
            String(attemptId),
            "program-adaptive-admission-v2",
          ),
        ]);
        return { status: "issued", programAttemptId: String(attemptId) };
      });
    });
  }
}
