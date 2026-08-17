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
  applyProgramTransition,
  asExecutionBaseMismatchReceiptId,
  asProgramStateId,
  assertValidProgramState,
  canonicalStringify,
  evaluateCompletionOracle,
  isVerificationCurrent,
  type CompletionBlockReason,
  type ExecutionBaseMismatchKind,
  type ProgramAttemptExecutionBase,
  type ProgramState,
} from "@alcode/program-state";
import { reduceOperationsFromEvents, type WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { HostArtifactStore } from "./artifact-store.ts";
import type {
  ProgramDispatchWorkspaceCoordinatorV1,
  ProgramExecutionObservationSourceV1,
  ProgramRecoveryAuthorityV1,
} from "./program-dispatch.ts";

export interface ProgramTerminalServiceOptionsV1 {
  store: WorkspaceEventStore;
  admission: CanonicalAdmissionQueue;
  workspaceCoordinator: ProgramDispatchWorkspaceCoordinatorV1;
  observations: ProgramExecutionObservationSourceV1;
  recovery: ProgramRecoveryAuthorityV1;
  artifactStore: HostArtifactStore;
}

export interface ProgramCancellationCommandV1 {
  programStateId: string;
  expectedProgramRevision: number;
  sessionId: EventSessionId;
  actor?: string;
  client?: string;
  reason?: string;
}

export interface ProgramCompletionCommandV1 {
  programStateId: string;
  expectedProgramRevision: number;
  sessionId: EventSessionId;
}

export type ProgramCancellationResultV1 = {
  status: "cancelled";
  state: ProgramState;
  duplicate: boolean;
};

export type ProgramCompletionResultV1 =
  | { status: "completed"; state: ProgramState; duplicate: boolean }
  | { status: "blocked"; state: ProgramState; blockedBy: CompletionBlockReason[] }
  | { status: "rebase_required"; state: ProgramState; mismatchReceiptId: string }
  | { status: "execution_base_unavailable"; state: ProgramState; reason: string }
  | { status: "recovery_blocked"; state: ProgramState };

export class ProgramTerminalControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramTerminalControlError";
  }
}

export class ProgramTerminalStaleError extends ProgramTerminalControlError {
  constructor(message: string) {
    super(message);
    this.name = "ProgramTerminalStaleError";
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

function latestProgramState(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
): ProgramState {
  let latest: ProgramState | undefined;
  for (const event of events) {
    if (!isProgramStateEvent(event.type) || String(event.programStateId ?? "") !== programStateId) continue;
    const state = record(event.payload).state as ProgramState | undefined;
    if (state === undefined) throw new ProgramTerminalControlError(`${event.type} lacks payload.state`);
    assertValidProgramState(state);
    if (String(state.programStateId) !== programStateId) {
      throw new ProgramTerminalControlError(`${event.type} state identity does not match envelope`);
    }
    latest = state;
  }
  if (latest === undefined) throw new ProgramTerminalControlError(`Unknown ProgramState ${programStateId}`);
  return latest;
}

function requireExactRevision(state: ProgramState, expectedProgramRevision: number): void {
  if (state.revision !== expectedProgramRevision) {
    throw new ProgramRevisionConflictError(expectedProgramRevision, state.revision);
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
      throw new ProgramTerminalControlError("Invalid durable WorkspaceEffectGeneration event");
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

function transitionDraft(
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
    producer: { kind: "runtime", component: "program-terminal" },
  };
}

function terminalDraft(
  store: WorkspaceEventStore,
  sessionId: EventSessionId,
  state: ProgramState,
  type: "program.completed" | "program.cancelled",
  payloadExtra: Record<string, unknown> = {},
): EventDraft<string, unknown> {
  return {
    eventId: mkEventId(),
    idempotencyKey: `${type}:${String(state.programStateId)}`,
    correlationId: String(state.programStateId),
    workspaceId: asWorkspaceId(store.workspaceId),
    sessionId,
    programStateId: asEventProgramStateId(String(state.programStateId)),
    occurredAt: new Date().toISOString(),
    type,
    payload: { state, ...payloadExtra },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-terminal" },
  };
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
      const operationId = String(record(event.payload).operationId ?? event.operationId ?? "");
      if (operationId && writers.get(operationId)?.legacy) writers.delete(operationId);
    } else if (event.type === "operation.mutation_quiesced") {
      const operationId = String(record(event.payload).operationId ?? event.operationId ?? "");
      if (operationId) writers.delete(operationId);
    }
  }
  return [...writers.keys()].sort((a, b) => a.localeCompare(b, "en"));
}

function programOperationRecords(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
) {
  const owned = new Set<string>();
  for (const event of events) {
    if (event.type !== "operation.requested" || String(event.programStateId ?? "") !== programStateId) continue;
    const operationId = String(record(event.payload).operationId ?? event.operationId ?? "");
    if (operationId) owned.add(operationId);
  }
  return reduceOperationsFromEvents(events).filter((operation) => owned.has(operation.operationId));
}

function hasRetryableProgramWork(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
): boolean {
  const ledger = new Map<string, { state: string; retryEligible: boolean }>();
  for (const event of events) {
    if (!event.type.startsWith("runtime.work.") || String(event.programStateId ?? "") !== programStateId) continue;
    const payload = record(event.payload);
    const workId = typeof payload.workId === "string" ? payload.workId : "";
    if (!workId) continue;
    const current = ledger.get(workId);
    switch (event.type) {
      case "runtime.work.requested":
        ledger.set(workId, { state: "requested", retryEligible: payload.retryEligible !== false });
        break;
      case "runtime.work.claimed":
        ledger.set(workId, { state: "claimed", retryEligible: payload.retryEligible !== false && (current?.retryEligible ?? true) });
        break;
      case "runtime.work.interrupted":
        ledger.set(workId, { state: "interrupted", retryEligible: payload.retryEligible !== false });
        break;
      case "runtime.work.failed":
        ledger.set(workId, { state: "failed", retryEligible: payload.retryEligible === true });
        break;
      case "runtime.work.completed":
        ledger.set(workId, { state: "completed", retryEligible: false });
        break;
      default:
        break;
    }
  }
  return [...ledger.values()].some((item) => item.state !== "completed" && item.retryEligible);
}

async function artifactIntegrityCurrent(state: ProgramState, store: HostArtifactStore): Promise<boolean> {
  for (const obligation of state.verification) {
    if (obligation.predicate.kind !== "artifact_present") continue;
    const outputSlotId = obligation.predicate.outputSlotId;
    if (obligation.waiver?.subjectGeneration === obligation.subjectGeneration) continue;
    if (!isVerificationCurrent(obligation) || obligation.satisfaction === null) continue;

    let foundArtifactEvidence = false;
    for (const evidenceRefId of obligation.satisfaction.evidenceRefIds) {
      const evidence = state.decisiveEvidence.find((item) => item.evidenceRefId === evidenceRefId);
      if (evidence === undefined || evidence.verificationObligationId !== obligation.obligationId ||
          evidence.subjectGeneration !== obligation.subjectGeneration || evidence.artifactRef === null) continue;
      const binding = state.artifacts.find((artifact) =>
        artifact.artifactRef === evidence.artifactRef && artifact.outputSlotId === outputSlotId,
      );
      if (binding === undefined) return false;
      foundArtifactEvidence = true;
      try {
        await store.verify(evidence.artifactRef);
      } catch {
        return false;
      }
    }
    if (!foundArtifactEvidence) return false;
  }
  return true;
}

export class ProgramTerminalServiceV1 {
  constructor(private readonly options: ProgramTerminalServiceOptionsV1) {}

  async cancel(command: ProgramCancellationCommandV1): Promise<ProgramCancellationResultV1> {
    const programStateId = String(asProgramStateId(command.programStateId));
    return this.options.admission.enqueue(async () => {
      const events = await replayAll(this.options.store);
      const state = latestProgramState(events, programStateId);
      if (state.lifecycle === "cancelled") return { status: "cancelled", state, duplicate: true } as const;
      if (state.lifecycle === "completed") throw new ProgramTerminalStaleError("Program already completed");
      requireExactRevision(state, command.expectedProgramRevision);

      const next = applyProgramTransition(state, {
        kind: "program.cancel",
        expectedProgramRevision: state.revision,
      });
      const provenance = {
        ...(command.actor !== undefined ? { actor: command.actor } : {}),
        ...(command.client !== undefined ? { client: command.client } : {}),
        ...(command.reason !== undefined ? { reason: command.reason } : {}),
      };
      const persisted = await this.options.store.append([
        terminalDraft(this.options.store, command.sessionId, next, "program.cancelled", { provenance }),
      ]);
      if (persisted.length !== 1) throw new ProgramTerminalControlError("Program cancellation admission failed");
      return { status: "cancelled", state: next, duplicate: false } as const;
    });
  }

  async complete(command: ProgramCompletionCommandV1): Promise<ProgramCompletionResultV1> {
    const programStateId = String(asProgramStateId(command.programStateId));
    const preliminaryEvents = await replayAll(this.options.store);
    const preliminary = latestProgramState(preliminaryEvents, programStateId);
    if (preliminary.lifecycle === "completed") return { status: "completed", state: preliminary, duplicate: true };
    if (preliminary.lifecycle === "cancelled") throw new ProgramTerminalStaleError("Program already cancelled");
    requireExactRevision(preliminary, command.expectedProgramRevision);
    if (!await this.options.recovery.isClear()) {
      return { status: "recovery_blocked", state: preliminary };
    }

    return this.options.workspaceCoordinator.runExclusive(async () => {
      const observation = await this.options.observations.observe();

      return this.options.admission.enqueue(async () => {
        const events = await replayAll(this.options.store);
        const state = latestProgramState(events, programStateId);
        if (state.lifecycle === "completed") return { status: "completed", state, duplicate: true } as const;
        if (state.lifecycle === "cancelled") throw new ProgramTerminalStaleError("Program was cancelled before completion admission");
        requireExactRevision(state, command.expectedProgramRevision);
        if (!await this.options.recovery.isClear()) return { status: "recovery_blocked", state } as const;

        if (observation.status === "unknown") {
          const next = applyProgramTransition(state, {
            kind: "execution_base.unavailable",
            expectedProgramRevision: state.revision,
          });
          if (next !== state) {
            await this.options.store.append([
              transitionDraft(this.options.store, command.sessionId, next, "execution_base.unavailable", uuidv7()),
            ]);
          }
          return { status: "execution_base_unavailable", state: next, reason: observation.reason } as const;
        }
        if (observation.base.observation.workspaceIdentity !== this.options.store.workspaceId) {
          throw new ProgramTerminalStaleError("Terminal execution observation belongs to another Workspace");
        }
        const currentBase = effectiveObservedBase(events, observation.base);

        if (state.executionBaseMismatch !== null) {
          return {
            status: "rebase_required",
            state,
            mismatchReceiptId: String(state.executionBaseMismatch.receiptId),
          } as const;
        }
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
            invalidateVerificationObligationIds: state.verification.map((item) => item.obligationId),
          });
          await this.options.store.append([
            transitionDraft(this.options.store, command.sessionId, next, "execution_base.mismatch", String(receiptId)),
          ]);
          return { status: "rebase_required", state: next, mismatchReceiptId: String(receiptId) } as const;
        }

        const operations = programOperationRecords(events, programStateId);
        const noOutstandingProgramOperations = operations.every((operation) => operation.lifecycleState === "terminal");
        const noIndeterminateEffectsOrReconciliation = operations.every((operation) =>
          operation.effectStatus !== "indeterminate" &&
          operation.reconciliationStatus !== "pending" && operation.reconciliationStatus !== "unresolved",
        );
        const noOutstandingWriterBarrier = outstandingWriterOperations(events).length === 0;
        const noRetryableDurableWork = !hasRetryableProgramWork(events, programStateId);
        const integrityCurrent = await artifactIntegrityCurrent(state, this.options.artifactStore);
        const executionBaseCurrent = state.acceptedExecutionBase !== null &&
          !state.executionBaseUnavailable && sameBase(state.acceptedExecutionBase, currentBase);

        const oracleFacts = {
          executionBaseCurrent,
          noOutstandingProgramOperations,
          noIndeterminateEffectsOrReconciliation,
          noOutstandingWriterBarrier,
          noRetryableDurableWork,
          artifactIntegrityCurrent: integrityCurrent,
        };
        const oracle = evaluateCompletionOracle(state, oracleFacts);
        if (!oracle.eligible) {
          return { status: "blocked", state, blockedBy: oracle.blockedBy } as const;
        }

        const completed = applyProgramTransition(state, {
          kind: "program.complete",
          expectedProgramRevision: state.revision,
          oracleFacts,
        });
        const persisted = await this.options.store.append([
          terminalDraft(this.options.store, command.sessionId, completed, "program.completed"),
        ]);
        if (persisted.length !== 1) throw new ProgramTerminalControlError("Program completion admission failed");
        return { status: "completed", state: completed, duplicate: false } as const;
      });
    });
  }
}
