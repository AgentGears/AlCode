from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, got {count}")
    return text.replace(old, new, 1)


Path("packages/host-runtime/src/program-recovery.ts").write_text(r'''import { randomUUID } from "node:crypto";
import {
  asProgramStateId as asEventProgramStateId,
  asWorkspaceId,
  mkEventId,
  type EventDraft,
  type PersistedDomainEvent,
  type SessionId as EventSessionId,
} from "@alcode/events";
import {
  applyProgramTransition,
  asExecutionBaseMismatchReceiptId,
  canonicalStringify,
  type ExecutionBaseMismatchKind,
  type ProgramAttemptExecutionBase,
  type ProgramState,
} from "@alcode/program-state";
import { canonicalDigestOf } from "@alcode/reasoning";
import {
  createOperationsProjection,
  reduceOperationsFromEvents,
  type OperationRecord,
  type WorkspaceEventStore,
} from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import {
  validateHostCapabilityOperationScopedQuiescenceProofV1,
  type HostCapability,
  type HostCapabilityExecutionQuiescenceContractV1,
  type HostCapabilityReconciliationResultV1,
} from "./capability-broker.ts";
import type {
  ProgramDispatchWorkspaceCoordinatorV1,
  ProgramExecutionObservationSourceV1,
  ProgramRecoveryAuthorityV1,
} from "./program-dispatch.ts";

export type WorkspaceMutationAdmissionStatusV1 =
  | { status: "clear" }
  | { status: "recovery_blocked"; reason: string }
  | { status: "writer_barrier"; operationIds: string[] };

export interface WorkspaceMutationAdmissionAuthorityV1 {
  mayWriteAdmissionStatus(): Promise<WorkspaceMutationAdmissionStatusV1>;
}

export interface Phase1RecoveryResultV1 {
  clear: boolean;
  interruptedAttempts: number;
  quiescenceProofs: number;
  reconciliations: number;
  effectGenerations: number;
  writerBarrierOperationIds: string[];
  reason?: string;
}

export interface Phase1RecoveryLifecycleV1
  extends ProgramRecoveryAuthorityV1, WorkspaceMutationAdmissionAuthorityV1 {
  recover(): Promise<Phase1RecoveryResultV1>;
}

export interface Phase1RecoveryControllerOptionsV1 {
  store: WorkspaceEventStore;
  admission: CanonicalAdmissionQueue;
  workspaceCoordinator: ProgramDispatchWorkspaceCoordinatorV1;
  observations: ProgramExecutionObservationSourceV1;
  capabilities: readonly HostCapability[];
}

interface MayWriteRequestV1 {
  event: PersistedDomainEvent<string, unknown>;
  operationId: string;
  toolName: string;
  args: unknown;
  quiescenceContract: Record<string, unknown>;
  reconciliationContract: Record<string, unknown>;
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

function operationIdOf(event: PersistedDomainEvent<string, unknown>): string {
  return String(event.operationId ?? record(event.payload).operationId ?? "");
}

function mayWriteRequests(events: readonly PersistedDomainEvent<string, unknown>[]): MayWriteRequestV1[] {
  const result: MayWriteRequestV1[] = [];
  for (const event of events) {
    if (event.type !== "operation.requested") continue;
    const payload = record(event.payload);
    if (payload.workspaceAccessClass !== "may_write") continue;
    const operationId = operationIdOf(event);
    const toolName = String(payload.toolName ?? "");
    if (!operationId || !toolName) continue;
    result.push({
      event,
      operationId,
      toolName,
      args: payload.args,
      quiescenceContract: record(payload.quiescenceContract),
      reconciliationContract: record(payload.reconciliationContract),
    });
  }
  return result;
}

function hasQuiescenceProof(events: readonly PersistedDomainEvent<string, unknown>[], operationId: string): boolean {
  return events.some((event) => event.type === "operation.mutation_quiesced" && operationIdOf(event) === operationId);
}

function hasEffectGeneration(events: readonly PersistedDomainEvent<string, unknown>[], operationId: string): boolean {
  return events.some((event) => event.type === "workspace.effect_generation.advanced" && operationIdOf(event) === operationId);
}

function durableWorkspaceEffectGeneration(events: readonly PersistedDomainEvent<string, unknown>[]): number {
  let current = 0;
  for (const event of events) {
    if (event.type !== "workspace.effect_generation.advanced") continue;
    const generation = Number(record(event.payload).workspaceEffectGeneration);
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new Error("Invalid durable WorkspaceEffectGeneration event during recovery");
    }
    current = Math.max(current, generation);
  }
  return current;
}

function confirmationSequence(events: readonly PersistedDomainEvent<string, unknown>[], operationId: string): number | null {
  for (const event of events) {
    if (operationIdOf(event) !== operationId) continue;
    if (event.type === "operation.completed") {
      const payload = record(event.payload);
      const declared = payload.toolDeclaredEffect;
      const confirmed = declared === "confirmed" ||
        (declared === undefined && payload.outcome === "succeeded" && payload.isReadOnly !== true);
      if (confirmed) return event.sequence;
    }
    if (event.type === "operation.reconciliation.resolved" && record(event.payload).effectStatus === "confirmed") {
      return event.sequence;
    }
  }
  return null;
}

function outstandingWriterOperations(events: readonly PersistedDomainEvent<string, unknown>[]): string[] {
  const writers = new Map<string, { legacy: boolean }>();
  for (const event of events) {
    if (event.type === "operation.requested") {
      const payload = record(event.payload);
      const operationId = operationIdOf(event);
      const access = payload.workspaceAccessClass;
      const legacyMayWrite = access === undefined && payload.isReadOnly === false;
      if (operationId && access === "may_write") writers.set(operationId, { legacy: false });
      else if (operationId && legacyMayWrite) writers.set(operationId, { legacy: true });
    } else if (event.type === "operation.completed") {
      const operationId = operationIdOf(event);
      if (operationId && writers.get(operationId)?.legacy) writers.delete(operationId);
    } else if (event.type === "operation.mutation_quiesced") {
      const operationId = operationIdOf(event);
      if (operationId) writers.delete(operationId);
    }
  }
  return [...writers.keys()].sort((a, b) => a.localeCompare(b, "en"));
}

function unresolvedMayWriteEffects(events: readonly PersistedDomainEvent<string, unknown>[]): string[] {
  const postBaselineIds = new Set(mayWriteRequests(events).map((request) => request.operationId));
  return reduceOperationsFromEvents(events)
    .filter((operation) => postBaselineIds.has(operation.operationId) && operation.effectStatus === "indeterminate")
    .map((operation) => operation.operationId)
    .sort((a, b) => a.localeCompare(b, "en"));
}

function nonterminalMayWriteOperations(events: readonly PersistedDomainEvent<string, unknown>[]): string[] {
  const postBaselineIds = new Set(mayWriteRequests(events).map((request) => request.operationId));
  return reduceOperationsFromEvents(events)
    .filter((operation) => postBaselineIds.has(operation.operationId) && operation.lifecycleState !== "terminal")
    .map((operation) => operation.operationId)
    .sort((a, b) => a.localeCompare(b, "en"));
}

function latestProgramStates(events: readonly PersistedDomainEvent<string, unknown>[]): Map<string, ProgramState> {
  const states = new Map<string, ProgramState>();
  for (const event of events) {
    if ((event.type !== "program.created" && event.type !== "program.transitioned" &&
         event.type !== "program.completed" && event.type !== "program.cancelled") ||
        event.programStateId === undefined) continue;
    const state = record(event.payload).state as ProgramState | undefined;
    if (state !== undefined) states.set(String(event.programStateId), state);
  }
  return states;
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
    producer: { kind: "runtime", component: "phase1-recovery" },
  };
}

function sameBase(left: ProgramAttemptExecutionBase, right: ProgramAttemptExecutionBase): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

function effectiveObservedBase(
  events: readonly PersistedDomainEvent<string, unknown>[],
  base: ProgramAttemptExecutionBase,
): ProgramAttemptExecutionBase {
  const durable = durableWorkspaceEffectGeneration(events);
  return durable <= base.workspaceEffectGeneration ? base : { ...base, workspaceEffectGeneration: durable };
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

function acceptedBaseSessionId(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
  accepted: ProgramAttemptExecutionBase,
): EventSessionId | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (String(event.programStateId ?? "") !== programStateId) continue;
    if (event.type !== "program.created" && event.type !== "program.transitioned") continue;
    const state = record(event.payload).state as ProgramState | undefined;
    if (state?.acceptedExecutionBase !== null && state?.acceptedExecutionBase !== undefined &&
        sameBase(state.acceptedExecutionBase, accepted)) {
      return event.sessionId;
    }
  }
  return null;
}

function operationRecord(events: readonly PersistedDomainEvent<string, unknown>[], operationId: string): OperationRecord | undefined {
  return reduceOperationsFromEvents(events).find((operation) => operation.operationId === operationId);
}

export class Phase1RecoveryControllerV1 implements Phase1RecoveryLifecycleV1 {
  private recoveryCompleted = false;
  private blockingReason = "Phase 1 recovery has not completed";
  private readonly capabilities = new Map<string, HostCapability>();

  constructor(private readonly options: Phase1RecoveryControllerOptionsV1) {
    for (const capability of options.capabilities) {
      if (this.capabilities.has(capability.name)) throw new Error(`duplicate recovery capability: ${capability.name}`);
      this.capabilities.set(capability.name, capability);
    }
  }

  async isClear(): Promise<boolean> {
    return (await this.mayWriteAdmissionStatus()).status === "clear";
  }

  async mayWriteAdmissionStatus(): Promise<WorkspaceMutationAdmissionStatusV1> {
    if (!this.recoveryCompleted) return { status: "recovery_blocked", reason: this.blockingReason };
    const events = await replayAll(this.options.store);
    const barriers = outstandingWriterOperations(events);
    if (barriers.length > 0) return { status: "writer_barrier", operationIds: barriers };
    const uncertain = unresolvedMayWriteEffects(events);
    if (uncertain.length > 0) {
      return { status: "recovery_blocked", reason: `Unresolved may_write effect certainty: ${uncertain.join(",")}` };
    }
    const nonterminal = nonterminalMayWriteOperations(events);
    if (nonterminal.length > 0) {
      return { status: "recovery_blocked", reason: `Recovered may_write operation remains nonterminal: ${nonterminal.join(",")}` };
    }
    return { status: "clear" };
  }

  async recover(): Promise<Phase1RecoveryResultV1> {
    this.recoveryCompleted = false;
    this.blockingReason = "Phase 1 recovery is in progress";
    let interruptedAttempts = 0;
    let quiescenceProofs = 0;
    let reconciliations = 0;
    let effectGenerations = 0;

    return this.options.workspaceCoordinator.runExclusive(async () => {
      const operationRecovery = await this.recoverOperations();
      quiescenceProofs += operationRecovery.quiescenceProofs;
      reconciliations += operationRecovery.reconciliations;
      effectGenerations += operationRecovery.effectGenerations;

      interruptedAttempts += await this.interruptOrphanAttempts();

      let events = await replayAll(this.options.store);
      const barriers = outstandingWriterOperations(events);
      if (barriers.length > 0) {
        this.blockingReason = `Outstanding Workspace writer barrier: ${barriers.join(",")}`;
        this.options.store.getProjectionRunner().catchUp(createOperationsProjection(this.options.store.workspaceId));
        return {
          clear: false,
          interruptedAttempts,
          quiescenceProofs,
          reconciliations,
          effectGenerations,
          writerBarrierOperationIds: barriers,
          reason: this.blockingReason,
        };
      }

      const uncertain = unresolvedMayWriteEffects(events);
      const nonterminal = nonterminalMayWriteOperations(events);
      if (uncertain.length > 0 || nonterminal.length > 0) {
        this.blockingReason = uncertain.length > 0
          ? `Unresolved may_write effect certainty: ${uncertain.join(",")}`
          : `Recovered may_write operation remains nonterminal: ${nonterminal.join(",")}`;
        this.options.store.getProjectionRunner().catchUp(createOperationsProjection(this.options.store.workspaceId));
        return {
          clear: false,
          interruptedAttempts,
          quiescenceProofs,
          reconciliations,
          effectGenerations,
          writerBarrierOperationIds: [],
          reason: this.blockingReason,
        };
      }

      const observation = await this.options.observations.observe();
      if (observation.status === "unknown") {
        this.blockingReason = `Execution observation unavailable during recovery: ${observation.reason}`;
        return {
          clear: false,
          interruptedAttempts,
          quiescenceProofs,
          reconciliations,
          effectGenerations,
          writerBarrierOperationIds: [],
          reason: this.blockingReason,
        };
      }
      if (observation.base.observation.workspaceIdentity !== this.options.store.workspaceId) {
        this.blockingReason = "Recovery observation belongs to another Workspace";
        return {
          clear: false,
          interruptedAttempts,
          quiescenceProofs,
          reconciliations,
          effectGenerations,
          writerBarrierOperationIds: [],
          reason: this.blockingReason,
        };
      }

      const baseResult = await this.revalidateProgramBases(observation.base);
      if (!baseResult.clear) {
        this.blockingReason = baseResult.reason;
        return {
          clear: false,
          interruptedAttempts,
          quiescenceProofs,
          reconciliations,
          effectGenerations,
          writerBarrierOperationIds: [],
          reason: this.blockingReason,
        };
      }

      events = await replayAll(this.options.store);
      this.options.store.getProjectionRunner().catchUp(createOperationsProjection(this.options.store.workspaceId));
      this.recoveryCompleted = true;
      this.blockingReason = "";
      return {
        clear: true,
        interruptedAttempts,
        quiescenceProofs,
        reconciliations,
        effectGenerations,
        writerBarrierOperationIds: outstandingWriterOperations(events),
      };
    });
  }

  private async recoverOperations(): Promise<{ quiescenceProofs: number; reconciliations: number; effectGenerations: number }> {
    let quiescenceProofs = 0;
    let reconciliations = 0;
    let effectGenerations = 0;
    let events = await replayAll(this.options.store);

    for (const request of mayWriteRequests(events)) {
      if (!hasQuiescenceProof(events, request.operationId)) {
        const capability = this.capabilities.get(request.toolName);
        const quiescence = capability?.quiescence;
        const persisted = request.quiescenceContract;
        const exactStaticBinding = persisted.providerBindingRevision === undefined && persisted.providerGenerationId === undefined;
        if (quiescence?.recover !== undefined && exactStaticBinding &&
            quiescence.containmentKind === "operation_scoped_containment" &&
            quiescence.proofContractId === persisted.proofContractId &&
            quiescence.proofContractVersion === Number(persisted.proofContractVersion) &&
            persisted.containment === "operation_scoped_containment" &&
            typeof persisted.containmentInstanceId === "string") {
          let proof;
          try {
            proof = await quiescence.recover({
              operationId: request.operationId,
              sessionId: String(request.event.sessionId),
              args: request.args,
              containmentInstanceId: persisted.containmentInstanceId,
            });
          } catch {
            proof = undefined;
          }
          const contract: HostCapabilityExecutionQuiescenceContractV1 = {
            containment: "operation_scoped_containment",
            proofContractId: String(persisted.proofContractId),
            proofContractVersion: Number(persisted.proofContractVersion),
            containmentInstanceId: persisted.containmentInstanceId,
          };
          const validated = validateHostCapabilityOperationScopedQuiescenceProofV1(contract, proof);
          if (validated !== undefined) {
            const appended = await this.options.admission.enqueue(async () => {
              const current = await replayAll(this.options.store);
              if (hasQuiescenceProof(current, request.operationId)) return false;
              await this.options.store.append([{
                eventId: mkEventId(),
                idempotencyKey: `operation.mutation_quiesced:${request.operationId}`,
                correlationId: request.operationId,
                workspaceId: asWorkspaceId(this.options.store.workspaceId),
                sessionId: request.event.sessionId,
                operationId: request.event.operationId,
                ...(request.event.programStateId !== undefined ? { programStateId: request.event.programStateId } : {}),
                occurredAt: new Date().toISOString(),
                type: "operation.mutation_quiesced",
                payload: {
                  operationId: request.operationId,
                  containmentInstanceId: validated.containmentInstanceId,
                  containment: "operation_scoped_containment",
                  proofContractId: validated.proofContractId,
                  proofContractVersion: validated.proofContractVersion,
                  proofKind: validated.proofKind,
                  proofEvidenceDigest: validated.proofEvidenceDigest,
                },
                payloadSchemaVersion: 1,
                producer: { kind: "runtime", component: "phase1-recovery" },
              }]);
              return true;
            });
            if (appended) quiescenceProofs += 1;
          }
        }
      }

      events = await replayAll(this.options.store);
      if (hasQuiescenceProof(events, request.operationId)) {
        const recovered = await this.reconcileOperation(request);
        if (recovered.reconciled) reconciliations += 1;
        if (recovered.generationAdvanced) effectGenerations += 1;
      }
      events = await replayAll(this.options.store);
    }

    effectGenerations += await this.catchUpConfirmedEffectGenerations();
    return { quiescenceProofs, reconciliations, effectGenerations };
  }

  private async reconcileOperation(request: MayWriteRequestV1): Promise<{ reconciled: boolean; generationAdvanced: boolean }> {
    const events = await replayAll(this.options.store);
    const current = operationRecord(events, request.operationId);
    if (current === undefined || current.effectStatus !== "indeterminate" ||
        (current.reconciliationStatus !== "pending" && current.reconciliationStatus !== "unresolved")) {
      return { reconciled: false, generationAdvanced: false };
    }
    const persisted = request.reconciliationContract;
    const capability = this.capabilities.get(request.toolName);
    const contract = capability?.reconciliation;
    const exactStaticBinding = persisted.providerBindingRevision === undefined && persisted.providerGenerationId === undefined;
    if (contract?.recover === undefined || !exactStaticBinding ||
        contract.contractId !== persisted.id || contract.contractVersion !== Number(persisted.version)) {
      return { reconciled: false, generationAdvanced: false };
    }

    let result: HostCapabilityReconciliationResultV1;
    try {
      result = await contract.recover({
        operationId: request.operationId,
        sessionId: String(request.event.sessionId),
        args: request.args,
        executionOutcome: current.executionOutcome,
      });
    } catch (error) {
      result = { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
    }
    if (result.status === "unavailable") return { reconciled: false, generationAdvanced: false };
    const evidenceDigest = canonicalDigestOf(result.evidence);

    return this.options.admission.enqueue(async () => {
      const latest = await replayAll(this.options.store);
      if (!hasQuiescenceProof(latest, request.operationId)) return { reconciled: false, generationAdvanced: false };
      const operation = operationRecord(latest, request.operationId);
      if (operation === undefined || operation.effectStatus !== "indeterminate" ||
          (operation.reconciliationStatus !== "pending" && operation.reconciliationStatus !== "unresolved")) {
        return { reconciled: false, generationAdvanced: false };
      }

      const drafts: EventDraft<string, unknown>[] = [];
      if (operation.lifecycleState !== "terminal" && result.executionOutcome !== undefined) {
        drafts.push({
          eventId: mkEventId(),
          idempotencyKey: `operation.recovery.completed:${request.operationId}`,
          correlationId: request.operationId,
          workspaceId: asWorkspaceId(this.options.store.workspaceId),
          sessionId: request.event.sessionId,
          operationId: request.event.operationId,
          ...(request.event.programStateId !== undefined ? { programStateId: request.event.programStateId } : {}),
          occurredAt: new Date().toISOString(),
          type: "operation.completed",
          payload: {
            operationId: request.operationId,
            outcome: result.executionOutcome,
            isReadOnly: false,
            workspaceAccessClass: "may_write",
            toolDeclaredEffect: "indeterminate",
            recoveryEvidenceDigest: evidenceDigest,
          },
          payloadSchemaVersion: 1,
          producer: { kind: "runtime", component: "phase1-recovery" },
        });
      }

      if (result.status === "unresolved") {
        if (operation.reconciliationStatus === "unresolved") {
          if (drafts.length > 0) await this.options.store.append(drafts);
          return { reconciled: drafts.length > 0, generationAdvanced: false };
        }
        drafts.push({
          eventId: mkEventId(),
          idempotencyKey: `operation.reconciliation.unresolved:${request.operationId}:${evidenceDigest}`,
          correlationId: request.operationId,
          workspaceId: asWorkspaceId(this.options.store.workspaceId),
          sessionId: request.event.sessionId,
          operationId: request.event.operationId,
          ...(request.event.programStateId !== undefined ? { programStateId: request.event.programStateId } : {}),
          occurredAt: new Date().toISOString(),
          type: "operation.reconciliation.unresolved",
          payload: {
            operationId: request.operationId,
            evidenceDigest,
            reconciliationContractId: String(persisted.id),
            reconciliationContractVersion: Number(persisted.version),
          },
          payloadSchemaVersion: 1,
          producer: { kind: "runtime", component: "phase1-recovery" },
        });
        await this.options.store.append(drafts);
        return { reconciled: true, generationAdvanced: false };
      }

      drafts.push({
        eventId: mkEventId(),
        idempotencyKey: `operation.reconciliation.resolved:${request.operationId}:${evidenceDigest}`,
        correlationId: request.operationId,
        workspaceId: asWorkspaceId(this.options.store.workspaceId),
        sessionId: request.event.sessionId,
        operationId: request.event.operationId,
        ...(request.event.programStateId !== undefined ? { programStateId: request.event.programStateId } : {}),
        occurredAt: new Date().toISOString(),
        type: "operation.reconciliation.resolved",
        payload: {
          operationId: request.operationId,
          effectStatus: result.effectStatus,
          evidenceDigest,
          reconciliationContractId: String(persisted.id),
          reconciliationContractVersion: Number(persisted.version),
        },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "phase1-recovery" },
      });

      let generationAdvanced = false;
      if (result.effectStatus === "confirmed" && !hasEffectGeneration(latest, request.operationId)) {
        const previous = durableWorkspaceEffectGeneration(latest);
        if (!Number.isSafeInteger(previous + 1)) throw new Error("WorkspaceEffectGeneration overflow during recovery");
        drafts.push({
          eventId: mkEventId(),
          idempotencyKey: `workspace.effect_generation.advanced:${request.operationId}`,
          correlationId: request.operationId,
          workspaceId: asWorkspaceId(this.options.store.workspaceId),
          sessionId: request.event.sessionId,
          operationId: request.event.operationId,
          ...(request.event.programStateId !== undefined ? { programStateId: request.event.programStateId } : {}),
          occurredAt: new Date().toISOString(),
          type: "workspace.effect_generation.advanced",
          payload: {
            operationId: request.operationId,
            previousWorkspaceEffectGeneration: previous,
            workspaceEffectGeneration: previous + 1,
            effectStatus: "confirmed",
          },
          payloadSchemaVersion: 1,
          producer: { kind: "runtime", component: "phase1-recovery" },
        });
        generationAdvanced = true;
      }
      await this.options.store.append(drafts);
      return { reconciled: true, generationAdvanced };
    });
  }

  private async catchUpConfirmedEffectGenerations(): Promise<number> {
    return this.options.admission.enqueue(async () => {
      const events = await replayAll(this.options.store);
      const requests = mayWriteRequests(events);
      const operations = new Map(reduceOperationsFromEvents(events).map((operation) => [operation.operationId, operation]));
      const missing = requests
        .filter((request) => operations.get(request.operationId)?.effectStatus === "confirmed" && !hasEffectGeneration(events, request.operationId))
        .map((request) => ({ request, sequence: confirmationSequence(events, request.operationId) }))
        .filter((item): item is { request: MayWriteRequestV1; sequence: number } => item.sequence !== null)
        .sort((a, b) => a.sequence - b.sequence || a.request.operationId.localeCompare(b.request.operationId, "en"));
      if (missing.length === 0) return 0;
      const firstMissing = missing[0]!.sequence;
      if (events.some((event) => event.type === "workspace.effect_generation.advanced" && event.sequence > firstMissing)) {
        throw new Error("Cannot append-only repair WorkspaceEffectGeneration ordering after a later durable generation");
      }
      let generation = durableWorkspaceEffectGeneration(events);
      const drafts: EventDraft<string, unknown>[] = [];
      for (const { request } of missing) {
        const previous = generation;
        generation += 1;
        if (!Number.isSafeInteger(generation)) throw new Error("WorkspaceEffectGeneration overflow during recovery");
        drafts.push({
          eventId: mkEventId(),
          idempotencyKey: `workspace.effect_generation.advanced:${request.operationId}`,
          correlationId: request.operationId,
          workspaceId: asWorkspaceId(this.options.store.workspaceId),
          sessionId: request.event.sessionId,
          operationId: request.event.operationId,
          ...(request.event.programStateId !== undefined ? { programStateId: request.event.programStateId } : {}),
          occurredAt: new Date().toISOString(),
          type: "workspace.effect_generation.advanced",
          payload: {
            operationId: request.operationId,
            previousWorkspaceEffectGeneration: previous,
            workspaceEffectGeneration: generation,
            effectStatus: "confirmed",
          },
          payloadSchemaVersion: 1,
          producer: { kind: "runtime", component: "phase1-recovery" },
        });
      }
      await this.options.store.append(drafts);
      return drafts.length;
    });
  }

  private async interruptOrphanAttempts(): Promise<number> {
    return this.options.admission.enqueue(async () => {
      const events = await replayAll(this.options.store);
      const drafts: EventDraft<string, unknown>[] = [];
      let count = 0;
      for (const state of latestProgramStates(events).values()) {
        if (state.lifecycle !== "active" || state.activeAttempt === null) continue;
        const attempt = state.activeAttempt;
        const next = applyProgramTransition(state, {
          kind: "attempt.interrupt",
          expectedProgramRevision: state.revision,
          programAttemptId: String(attempt.programAttemptId),
        });
        drafts.push(transitionEvent(
          this.options.store,
          attempt.sessionId as unknown as EventSessionId,
          next,
          "attempt.interrupt.recovery",
          String(attempt.programAttemptId),
        ));
        count += 1;
      }
      if (drafts.length > 0) await this.options.store.append(drafts);
      return count;
    });
  }

  private async revalidateProgramBases(
    observed: ProgramAttemptExecutionBase,
  ): Promise<{ clear: true } | { clear: false; reason: string }> {
    return this.options.admission.enqueue(async () => {
      const events = await replayAll(this.options.store);
      const barriers = outstandingWriterOperations(events);
      if (barriers.length > 0) {
        return { clear: false, reason: `Outstanding Workspace writer barrier: ${barriers.join(",")}` } as const;
      }
      const currentBase = effectiveObservedBase(events, observed);
      const drafts: EventDraft<string, unknown>[] = [];

      for (const [programStateId, state] of latestProgramStates(events)) {
        if (state.lifecycle !== "active" || state.acceptedExecutionBase === null) continue;
        const sourceSessionId = acceptedBaseSessionId(events, programStateId, state.acceptedExecutionBase);
        if (sourceSessionId === null) {
          return { clear: false, reason: `Accepted execution base lacks deterministic source session: ${programStateId}` } as const;
        }

        if (state.executionBaseMismatch !== null) {
          const receiptCandidate: ProgramAttemptExecutionBase = {
            workspaceEffectGeneration: state.executionBaseMismatch.currentWorkspaceEffectGeneration,
            observation: state.executionBaseMismatch.currentObservationIdentity,
          };
          if (!sameBase(receiptCandidate, currentBase)) {
            return { clear: false, reason: `Execution base changed after mismatch receipt: ${programStateId}` } as const;
          }
          continue;
        }

        if (sameBase(state.acceptedExecutionBase, currentBase)) {
          if (state.executionBaseUnavailable) {
            const next = applyProgramTransition(state, {
              kind: "execution_base.adopt",
              expectedProgramRevision: state.revision,
              executionBase: currentBase,
            });
            if (next !== state) {
              drafts.push(transitionEvent(
                this.options.store,
                sourceSessionId,
                next,
                "execution_base.recovery_current",
                programStateId,
              ));
            }
          }
          continue;
        }

        const receiptId = asExecutionBaseMismatchReceiptId(randomUUID());
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
        drafts.push(transitionEvent(
          this.options.store,
          sourceSessionId,
          next,
          "execution_base.mismatch.recovery",
          String(receiptId),
        ));
      }

      if (drafts.length > 0) await this.options.store.append(drafts);
      return { clear: true } as const;
    });
  }
}
''')

p = Path("packages/host-runtime/src/capability-broker.ts")
s = p.read_text()
s = replace_once(
    s,
    'import { DefaultHostPolicy, type HostPolicy } from "./policy.ts";\n',
    'import { DefaultHostPolicy, type HostPolicy } from "./policy.ts";\nimport type { WorkspaceMutationAdmissionAuthorityV1 } from "./program-recovery.ts";\n',
    "recovery authority import",
)
old = '''export interface HostCapabilityQuiescenceV1 {
  containmentKind: "operation_scoped_containment" | "host_lifetime_containment";
  proofContractId: string;
  proofContractVersion: number;
}

export interface ProgramCapabilityOperationContextV1 {'''
new = '''export interface HostCapabilityQuiescenceRecoveryInputV1 {
  operationId: string;
  sessionId: string;
  args: unknown;
  containmentInstanceId: string;
}

export interface HostCapabilityQuiescenceV1 {
  containmentKind: "operation_scoped_containment" | "host_lifetime_containment";
  proofContractId: string;
  proofContractVersion: number;
  recover?(input: HostCapabilityQuiescenceRecoveryInputV1): Promise<HostCapabilityQuiescenceProofV1 | undefined>;
}

export interface HostCapabilityReconciliationInputV1 {
  operationId: string;
  sessionId: string;
  args: unknown;
  executionOutcome: ExecutionOutcome | null;
}

export type HostCapabilityReconciliationResultV1 =
  | {
      status: "resolved";
      effectStatus: "confirmed" | "absent";
      evidence: unknown;
      executionOutcome?: ExecutionOutcome;
    }
  | { status: "unresolved"; evidence: unknown; executionOutcome?: ExecutionOutcome }
  | { status: "unavailable"; reason: string };

export interface HostCapabilityReconciliationV1 {
  contractId: string;
  contractVersion: number;
  recover(input: HostCapabilityReconciliationInputV1): Promise<HostCapabilityReconciliationResultV1>;
}

export interface ProgramCapabilityOperationContextV1 {'''
s = replace_once(s, old, new, "recovery interfaces")
s = replace_once(
    s,
    '  /** Host-owned containment proof contract for Program-linked may_write execution. */\n  quiescence?: HostCapabilityQuiescenceV1;\n  execute(args: unknown, context: HostCapabilityContext): Promise<HostCapabilityResult>;\n',
    '  /** Host-owned containment proof contract for Program-linked may_write execution. */\n  quiescence?: HostCapabilityQuiescenceV1;\n  /** Optional stable Host-owned historical effect reconciliation contract. */\n  reconciliation?: HostCapabilityReconciliationV1;\n  execute(args: unknown, context: HostCapabilityContext): Promise<HostCapabilityResult>;\n',
    "capability reconciliation field",
)
s = replace_once(
    s,
    'function validateOperationScopedQuiescenceProof(\n',
    'export function validateHostCapabilityOperationScopedQuiescenceProofV1(\n',
    "quiescence validator export",
)
s = s.replace(
    'validateOperationScopedQuiescenceProof(\n',
    'validateHostCapabilityOperationScopedQuiescenceProofV1(\n',
)
marker = '''function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}
'''
addition = marker + '''
async function replayAllEvents(store: WorkspaceEventStore): Promise<PersistedDomainEvent<string, unknown>[]> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

function durableWorkspaceEffectGeneration(events: readonly PersistedDomainEvent<string, unknown>[]): number {
  let current = 0;
  for (const event of events) {
    if (event.type !== "workspace.effect_generation.advanced") continue;
    const generation = Number(record(event.payload).workspaceEffectGeneration);
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("invalid WorkspaceEffectGeneration event");
    current = Math.max(current, generation);
  }
  return current;
}

function hasOperationEffectGeneration(
  events: readonly PersistedDomainEvent<string, unknown>[],
  operationId: string,
): boolean {
  return events.some((event) => event.type === "workspace.effect_generation.advanced" &&
    String(record(event.payload).operationId ?? event.operationId ?? "") === operationId);
}
'''
s = replace_once(s, marker, addition, "broker generation helpers")
s = replace_once(
    s,
    '  private programOperationAuthority: ProgramRootOperationAuthorityV1 | undefined;\n',
    '  private programOperationAuthority: ProgramRootOperationAuthorityV1 | undefined;\n  private workspaceMutationAdmissionAuthority: WorkspaceMutationAdmissionAuthorityV1 | undefined;\n',
    "broker recovery field",
)
s = replace_once(
    s,
    '''  setProgramOperationAuthority(authority: ProgramRootOperationAuthorityV1 | undefined): void {
    this.programOperationAuthority = authority;
  }
''',
    '''  setProgramOperationAuthority(authority: ProgramRootOperationAuthorityV1 | undefined): void {
    this.programOperationAuthority = authority;
  }

  setWorkspaceMutationAdmissionAuthority(authority: WorkspaceMutationAdmissionAuthorityV1 | undefined): void {
    this.workspaceMutationAdmissionAuthority = authority;
  }
''',
    "broker recovery setter",
)
s = replace_once(
    s,
    '    const quiescenceBinding = workspaceAccessClass === "may_write" ? operationScopedQuiescence(capability) : undefined;\n',
    '''    if (workspaceAccessClass === "may_write" && this.workspaceMutationAdmissionAuthority !== undefined) {
      const recoveryStatus = await this.workspaceMutationAdmissionAuthority.mayWriteAdmissionStatus();
      if (recoveryStatus.status === "recovery_blocked") {
        return this.finish(request, {
          outcome: "denied",
          errorCode: "workspace_recovery_blocked",
          error: recoveryStatus.reason,
        });
      }
      if (recoveryStatus.status === "writer_barrier") {
        return this.finish(request, {
          outcome: "denied",
          errorCode: "workspace_writer_barrier",
          error: `Outstanding Workspace writer barrier: ${recoveryStatus.operationIds.join(",")}`,
        });
      }
    }

    const quiescenceBinding = workspaceAccessClass === "may_write" ? operationScopedQuiescence(capability) : undefined;
''',
    "broker maywrite gate",
)
s = replace_once(
    s,
    '''    const verificationPlan = await this.cognition.matchVerification(
''',
    '''    const reconciliationContract =
      persistedWorkspaceAccessClass === "may_write" && capability.reconciliation !== undefined
        ? {
            id: capability.reconciliation.contractId,
            version: capability.reconciliation.contractVersion,
            ...(registration.binding.kind === "dynamic" ? { providerBindingRevision: registration.binding.revision } : {}),
          }
        : undefined;

    const verificationPlan = await this.cognition.matchVerification(
''',
    "persist reconciliation contract",
)
s = replace_once(
    s,
    '          ...(quiescenceContract !== undefined ? { quiescenceContract } : {}),\n',
    '          ...(quiescenceContract !== undefined ? { quiescenceContract } : {}),\n          ...(reconciliationContract !== undefined ? { reconciliationContract } : {}),\n',
    "request reconciliation payload",
)
s = replace_once(
    s,
    '    const terminalDraftsForHead = (head: number): EventDraft<string, unknown>[] => {\n',
    '    const terminalDraftsForHead = (head: number, ordinaryEffectGeneration?: { previous: number; next: number }): EventDraft<string, unknown>[] => {\n',
    "terminal builder signature",
)
s = replace_once(
    s,
    '''      const evidenceKind = isReadOnly ? "observation" : "action_result";
      const evidenceSequence = head + (validatedQuiescenceProof !== undefined ? 3 : 2);
      const evidenceId = `event:${request.sessionId as string}:${evidenceSequence}:${evidenceKind}`;
      const drafts: EventDraft<string, unknown>[] = [
''',
    '''      const evidenceKind = isReadOnly ? "observation" : "action_result";
      const drafts: EventDraft<string, unknown>[] = [
''',
    "terminal evidence prelude",
)
needle = '''      drafts.push({
          eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId, ...programEnvelope, causationEventId: completedEventId,
          occurredAt: new Date().toISOString(), type: "evidence.recorded",
'''
insert = '''      if (ordinaryEffectGeneration !== undefined) {
        drafts.push({
          eventId: mkEventId(),
          idempotencyKey: `workspace.effect_generation.advanced:${operationId as string}`,
          correlationId: operationId as string,
          workspaceId,
          sessionId: request.sessionId,
          operationId,
          ...programEnvelope,
          occurredAt: new Date().toISOString(),
          type: "workspace.effect_generation.advanced",
          payload: {
            operationId: operationId as string,
            previousWorkspaceEffectGeneration: ordinaryEffectGeneration.previous,
            workspaceEffectGeneration: ordinaryEffectGeneration.next,
            effectStatus: "confirmed",
          },
          payloadSchemaVersion: 1,
          producer: { kind: "runtime", component: "host-capability-broker" },
        });
      }
      const evidenceSequence = head + drafts.length + 1;
      const evidenceId = `event:${request.sessionId as string}:${evidenceSequence}:${evidenceKind}`;
      drafts.push({
          eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId, ...programEnvelope, causationEventId: completedEventId,
          occurredAt: new Date().toISOString(), type: "evidence.recorded",
'''
s = replace_once(s, needle, insert, "ordinary generation in terminal batch")
old = '''      await this.admission.enqueue(async () => {
        const head = await this.store.headSequence();
        const drafts = terminalDraftsForHead(head);
      const persisted = await this.store.append(drafts);
      for (let i = 0; i < persisted.length; i++) {
        if (persisted[i]?.sequence !== head + i + 1) throw new Error("capability terminal batch interleaved during canonical admission");
      }
      });
'''
new = '''      await this.admission.enqueue(async () => {
        const head = await this.store.headSequence();
        let ordinaryEffectGeneration: { previous: number; next: number } | undefined;
        if (workspaceAccessClass === "may_write" && persistedWorkspaceAccessClass === "may_write" && outcome === "succeeded") {
          const history = await replayAllEvents(this.store);
          if (!hasOperationEffectGeneration(history, operationId as string)) {
            const previous = durableWorkspaceEffectGeneration(history);
            if (!Number.isSafeInteger(previous + 1)) throw new Error("WorkspaceEffectGeneration overflow");
            ordinaryEffectGeneration = { previous, next: previous + 1 };
          }
        }
        const drafts = terminalDraftsForHead(head, ordinaryEffectGeneration);
        const persisted = await this.store.append(drafts);
        for (let i = 0; i < persisted.length; i++) {
          if (persisted[i]?.sequence !== head + i + 1) throw new Error("capability terminal batch interleaved during canonical admission");
        }
      });
'''
s = replace_once(s, old, new, "ordinary terminal generation")
p.write_text(s)

p = Path("packages/host-runtime/src/host.ts")
s = p.read_text()
s = replace_once(
    s,
    'import type { ProgramRootOperationAuthorityV1 } from "./program-dispatch.ts";\n',
    'import type { ProgramRootOperationAuthorityV1 } from "./program-dispatch.ts";\nimport type { Phase1RecoveryLifecycleV1 } from "./program-recovery.ts";\n',
    "host recovery import",
)
s = replace_once(
    s,
    '  private readonly contextRequestCache = new Map<string, ContextUpdate>();\n',
    '  private readonly contextRequestCache = new Map<string, ContextUpdate>();\n  private phase1Recovery: Phase1RecoveryLifecycleV1 | undefined;\n',
    "host recovery field",
)
s = replace_once(
    s,
    '''  async startup(): Promise<{ pendingOperationIds: string[]; interruptedWork: number }> {
    const recovery = await this.store.store.recoverInterruptedOperations();
    const interruptedWork = await this.workDispatcher.recoverInterruptedWork();
    this.cognitionGateway.catchUpCognition();
    return { pendingOperationIds: recovery.pendingOperationIds, interruptedWork };
  }
''',
    '''  async startup(): Promise<{ pendingOperationIds: string[]; interruptedWork: number }> {
    const recovery = await this.store.store.recoverInterruptedOperations();
    const interruptedWork = await this.workDispatcher.recoverInterruptedWork();
    if (this.phase1Recovery !== undefined) await this.phase1Recovery.recover();
    this.cognitionGateway.catchUpCognition();
    return { pendingOperationIds: recovery.pendingOperationIds, interruptedWork };
  }
''',
    "host startup recovery",
)
s = replace_once(
    s,
    '''  setProgramOperationAuthority(authority: ProgramRootOperationAuthorityV1 | undefined): void {
    this.capabilityBroker.setProgramOperationAuthority(authority);
  }
''',
    '''  setProgramOperationAuthority(authority: ProgramRootOperationAuthorityV1 | undefined): void {
    this.capabilityBroker.setProgramOperationAuthority(authority);
  }

  setPhase1RecoveryController(controller: Phase1RecoveryLifecycleV1 | undefined): void {
    this.phase1Recovery = controller;
    this.capabilityBroker.setWorkspaceMutationAdmissionAuthority(controller);
  }
''',
    "host recovery setter",
)
p.write_text(s)

p = Path("packages/host-runtime/src/index.ts")
s = p.read_text()
s = replace_once(
    s,
    '  type HostCapabilityQuiescenceV1,\n',
    '  type HostCapabilityQuiescenceV1,\n  type HostCapabilityQuiescenceRecoveryInputV1,\n  type HostCapabilityReconciliationInputV1,\n  type HostCapabilityReconciliationResultV1,\n  type HostCapabilityReconciliationV1,\n',
    "index broker recovery types",
)
s = replace_once(
    s,
    '  type CapabilityHookCoordinator,\n',
    '  type CapabilityHookCoordinator,\n  validateHostCapabilityOperationScopedQuiescenceProofV1,\n',
    "index validator",
)
s += '''\nexport {
  Phase1RecoveryControllerV1,
  type Phase1RecoveryControllerOptionsV1,
  type Phase1RecoveryLifecycleV1,
  type Phase1RecoveryResultV1,
  type WorkspaceMutationAdmissionAuthorityV1,
  type WorkspaceMutationAdmissionStatusV1,
} from "./program-recovery.ts";\n'''
p.write_text(s)

Path("packages/host-runtime/src/program-recovery.test.ts").write_text(r'''import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asProgramStateId as asEventProgramStateId,
  asSessionId as asEventSessionId,
  asWorkspaceId,
  mkEventId,
  mkOperationId,
  mkProgramStateId,
  uuidv7,
  type EventDraft,
  type SessionId,
} from "@alcode/events";
import {
  applyProgramTransition,
  asProgramAttemptId,
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  createProgramState,
  type ProgramAttemptExecutionBase,
  type ProgramState,
} from "@alcode/program-state";
import {
  createWorkspaceReadModels,
  openLockedWorkspaceStore,
  reduceOperationsFromEvents,
  type LockedWorkspaceStore,
} from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { DefaultHostPolicy } from "./policy.ts";
import { HostRuntime, type HostCapability } from "./index.ts";
import { Phase1RecoveryControllerV1 } from "./program-recovery.ts";
import type { ProgramExecutionObservationSourceV1 } from "./program-dispatch.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;
const opened: LockedWorkspaceStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of opened.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(suffix: string) {
  const dir = mkdtempSync(join(tmpdir(), `alcode-recovery-10-${suffix}-`));
  dirs.push(dir);
  const locked = await openLockedWorkspaceStore({
    databasePath: join(dir, "workspace.sqlite"),
    lockPath: join(dir, "workspace.lock"),
    workspaceId: `018f0000-0000-7000-8000-0000000010${suffix.padStart(2, "0")}`,
    repositoryId: `phase1-recovery-${suffix}`,
  });
  opened.push(locked);
  const admission = new CanonicalAdmissionQueue(locked.store);
  const sessionId = asEventSessionId(uuidv7());
  return { locked, admission, sessionId };
}

function base(workspaceIdentity: string, generation = 0, stateDigest = "state-0"): ProgramAttemptExecutionBase {
  return {
    workspaceEffectGeneration: generation,
    observation: {
      kind: "workspace-observation-v1",
      providerKind: "recovery-test",
      workspaceIdentity,
      coverageDigest: "coverage-v1",
      stateDigest,
    },
  };
}

class MutableObservation implements ProgramExecutionObservationSourceV1 {
  constructor(public value: Awaited<ReturnType<ProgramExecutionObservationSourceV1["observe"]>>) {}
  observe(): Promise<Awaited<ReturnType<ProgramExecutionObservationSourceV1["observe"]>>> {
    return Promise.resolve(this.value);
  }
}

function recoveryCapability(
  effect: "confirmed" | "absent" = "confirmed",
  quiescenceAvailable = true,
): HostCapability {
  return {
    name: "mutate",
    workspaceAccessClass: "may_write",
    quiescence: {
      containmentKind: "operation_scoped_containment",
      proofContractId: "host-capability-promise-v1",
      proofContractVersion: 1,
      async recover(input) {
        if (!quiescenceAvailable) return undefined;
        return {
          containmentInstanceId: input.containmentInstanceId,
          proofContractId: "host-capability-promise-v1",
          proofContractVersion: 1,
          proofKind: "operation_containment_ended",
          evidence: { kind: "operation_scope_ended", containmentInstanceId: input.containmentInstanceId },
        };
      },
    },
    reconciliation: {
      contractId: "mutate-reconcile-v1",
      contractVersion: 1,
      async recover() {
        return {
          status: "resolved" as const,
          effectStatus: effect,
          executionOutcome: effect === "confirmed" ? "succeeded" as const : "failed" as const,
          evidence: { source: "recovery-test", effect },
        };
      },
    },
    async execute(_args, context) {
      const containmentInstanceId = context.quiescenceContract?.containmentInstanceId ?? "missing";
      return {
        outcome: "succeeded",
        result: "ok",
        quiescenceProof: {
          containmentInstanceId,
          proofContractId: "host-capability-promise-v1",
          proofContractVersion: 1,
          proofKind: "operation_containment_ended",
          evidence: { kind: "operation_scope_ended", containmentInstanceId },
        },
      };
    },
  };
}

async function appendInterruptedMayWrite(
  admission: CanonicalAdmissionQueue,
  workspaceId: string,
  sessionId: SessionId,
): Promise<string> {
  const operationId = mkOperationId();
  const common = {
    workspaceId: asWorkspaceId(workspaceId),
    sessionId,
    operationId,
    occurredAt: new Date().toISOString(),
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "recovery-test" } as const,
  };
  await admission.append([
    {
      ...common,
      eventId: mkEventId(),
      type: "operation.requested",
      payload: {
        operationId: String(operationId),
        toolName: "mutate",
        args: { path: "state.txt" },
        isReadOnly: false,
        workspaceAccessClass: "may_write",
        workspaceAccessClassifier: { id: "host-capability-workspace-access-v1", version: 1 },
        quiescenceContract: {
          version: 1,
          containment: "operation_scoped_containment",
          proofContractId: "host-capability-promise-v1",
          proofContractVersion: 1,
          containmentInstanceId: `containment-${String(operationId)}`,
        },
        reconciliationContract: { id: "mutate-reconcile-v1", version: 1 },
      },
    },
    {
      ...common,
      eventId: mkEventId(),
      type: "operation.started",
      payload: { operationId: String(operationId) },
    },
  ] as EventDraft<string, unknown>[]);
  return String(operationId);
}

async function allEvents(locked: LockedWorkspaceStore) {
  return createWorkspaceReadModels(locked.store).getAllEvents();
}

describeLocked("Phase 1 operation recovery barrier", () => {
  it("recovers exact historical quiescence, terminal outcome, effect certainty, and G exactly once", async () => {
    const runtime = await setup("01");
    const operationId = await appendInterruptedMayWrite(runtime.admission, runtime.locked.store.workspaceId, runtime.sessionId);
    await runtime.locked.store.recoverInterruptedOperations();
    const controller = new Phase1RecoveryControllerV1({
      store: runtime.locked.store,
      admission: runtime.admission,
      workspaceCoordinator: { runExclusive: (work) => work() },
      observations: new MutableObservation({ status: "complete", base: base(runtime.locked.store.workspaceId) }),
      capabilities: [recoveryCapability("confirmed")],
    });

    const first = await controller.recover();
    expect(first.clear).toBe(true);
    expect(first.quiescenceProofs).toBe(1);
    expect(first.reconciliations).toBe(1);
    expect(first.effectGenerations).toBe(1);
    expect(await controller.isClear()).toBe(true);

    let events = await allEvents(runtime.locked);
    expect(events.filter((event) => event.type === "operation.mutation_quiesced" && String(event.operationId) === operationId)).toHaveLength(1);
    expect(events.filter((event) => event.type === "operation.reconciliation.resolved" && String(event.operationId) === operationId)).toHaveLength(1);
    expect(events.filter((event) => event.type === "workspace.effect_generation.advanced" && String(event.operationId) === operationId)).toHaveLength(1);
    const operation = reduceOperationsFromEvents(events).find((item) => item.operationId === operationId)!;
    expect(operation.lifecycleState).toBe("terminal");
    expect(operation.effectStatus).toBe("confirmed");
    expect(operation.reconciliationStatus).toBe("resolved");

    const second = await controller.recover();
    expect(second.clear).toBe(true);
    events = await allEvents(runtime.locked);
    expect(events.filter((event) => event.type === "operation.mutation_quiesced" && String(event.operationId) === operationId)).toHaveLength(1);
    expect(events.filter((event) => event.type === "workspace.effect_generation.advanced" && String(event.operationId) === operationId)).toHaveLength(1);
  });

  it("keeps recovery fail-closed when exact historical quiescence cannot be proved", async () => {
    const runtime = await setup("02");
    const operationId = await appendInterruptedMayWrite(runtime.admission, runtime.locked.store.workspaceId, runtime.sessionId);
    await runtime.locked.store.recoverInterruptedOperations();
    const controller = new Phase1RecoveryControllerV1({
      store: runtime.locked.store,
      admission: runtime.admission,
      workspaceCoordinator: { runExclusive: (work) => work() },
      observations: new MutableObservation({ status: "complete", base: base(runtime.locked.store.workspaceId) }),
      capabilities: [recoveryCapability("confirmed", false)],
    });

    const result = await controller.recover();
    expect(result.clear).toBe(false);
    expect(result.writerBarrierOperationIds).toEqual([operationId]);
    expect(await controller.isClear()).toBe(false);
    const events = await allEvents(runtime.locked);
    expect(events.some((event) => event.type === "operation.reconciliation.resolved")).toBe(false);
  });

  it("admits recovered absent effect only after quiescence and does not advance G", async () => {
    const runtime = await setup("03");
    const operationId = await appendInterruptedMayWrite(runtime.admission, runtime.locked.store.workspaceId, runtime.sessionId);
    await runtime.locked.store.recoverInterruptedOperations();
    const controller = new Phase1RecoveryControllerV1({
      store: runtime.locked.store,
      admission: runtime.admission,
      workspaceCoordinator: { runExclusive: (work) => work() },
      observations: new MutableObservation({ status: "complete", base: base(runtime.locked.store.workspaceId) }),
      capabilities: [recoveryCapability("absent")],
    });

    expect((await controller.recover()).clear).toBe(true);
    const events = await allEvents(runtime.locked);
    const q = events.findIndex((event) => event.type === "operation.mutation_quiesced" && String(event.operationId) === operationId);
    const r = events.findIndex((event) => event.type === "operation.reconciliation.resolved" && String(event.operationId) === operationId);
    expect(q).toBeGreaterThanOrEqual(0);
    expect(r).toBeGreaterThan(q);
    expect(events.some((event) => event.type === "workspace.effect_generation.advanced" && String(event.operationId) === operationId)).toBe(false);
    const operation = reduceOperationsFromEvents(events).find((item) => item.operationId === operationId)!;
    expect(operation.effectStatus).toBe("absent");
  });

  it("interrupts orphan Attempts and catches their accepted base up to a recovery mismatch", async () => {
    const runtime = await setup("04");
    const initial = createProgramState({
      programStateId: asProgramStateId(String(mkProgramStateId())),
      sourceSessionId: asSessionId(String(runtime.sessionId)),
      objective: "recover program",
      workItems: [{
        workItemId: asProgramWorkItemId("work-recovery"),
        creationOrder: 0,
        description: "recover",
        dependencyIds: [],
        affectedPaths: ["src/recovery.ts"],
      }],
      verification: [],
      outputSlots: [],
      productionSteps: [],
    });
    const withAttempt = applyProgramTransition(initial, {
      kind: "attempt.issue",
      expectedProgramRevision: initial.revision,
      attempt: {
        programAttemptId: asProgramAttemptId(uuidv7()),
        workItemId: asProgramWorkItemId("work-recovery"),
        sessionId: asSessionId(String(runtime.sessionId)),
        agentGeneration: 1,
        initialExecutionBase: base(runtime.locked.store.workspaceId, 0, "old"),
        expectedExecutionBase: base(runtime.locked.store.workspaceId, 0, "old"),
      },
    });
    await runtime.admission.append([
      {
        eventId: mkEventId(), workspaceId: asWorkspaceId(runtime.locked.store.workspaceId), sessionId: runtime.sessionId,
        programStateId: asEventProgramStateId(String(initial.programStateId)), occurredAt: new Date().toISOString(),
        type: "program.created", payload: { state: initial }, payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "recovery-test" },
      },
      {
        eventId: mkEventId(), workspaceId: asWorkspaceId(runtime.locked.store.workspaceId), sessionId: runtime.sessionId,
        programStateId: asEventProgramStateId(String(initial.programStateId)), occurredAt: new Date().toISOString(),
        type: "program.transitioned", payload: { state: withAttempt, transitionKind: "attempt.issue" }, payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "recovery-test" },
      },
    ]);

    const controller = new Phase1RecoveryControllerV1({
      store: runtime.locked.store,
      admission: runtime.admission,
      workspaceCoordinator: { runExclusive: (work) => work() },
      observations: new MutableObservation({ status: "complete", base: base(runtime.locked.store.workspaceId, 0, "new") }),
      capabilities: [],
    });
    const result = await controller.recover();
    expect(result.clear).toBe(true);
    expect(result.interruptedAttempts).toBe(1);
    const events = await allEvents(runtime.locked);
    const programEvents = events.filter((event) => String(event.programStateId ?? "") === String(initial.programStateId));
    const latest = (programEvents[programEvents.length - 1]!.payload as { state: ProgramState }).state;
    expect(latest.activeAttempt).toBeNull();
    expect(latest.executionBaseMismatch).not.toBeNull();
    expect(latest.executionBaseMismatch?.currentObservationIdentity.stateDigest).toBe("new");
    expect(programEvents.some((event) => (event.payload as Record<string, unknown>).transitionKind === "attempt.interrupt.recovery")).toBe(true);
  });

  it("wires Host startup recovery and advances ordinary post-baseline may_write G in the terminal batch", async () => {
    const runtime = await setup("05");
    const capability = recoveryCapability("confirmed");
    const host = new HostRuntime({
      store: runtime.locked,
      capabilities: [capability],
      policy: new DefaultHostPolicy({ knownTools: ["mutate"], allowMutations: true }),
    });
    const controller = new Phase1RecoveryControllerV1({
      store: runtime.locked.store,
      admission: host.admission,
      workspaceCoordinator: { runExclusive: (work) => work() },
      observations: new MutableObservation({ status: "complete", base: base(runtime.locked.store.workspaceId) }),
      capabilities: [capability],
    });
    host.setPhase1RecoveryController(controller);

    const preStartup = await host.capabilityBroker.execute({
      sessionId: runtime.sessionId,
      toolCallId: "pre-startup",
      toolName: "mutate",
      args: { path: "state.txt" },
    });
    expect(preStartup.errorCode).toBe("workspace_recovery_blocked");

    await host.startup();
    expect(await controller.isClear()).toBe(true);
    const result = await host.capabilityBroker.execute({
      sessionId: runtime.sessionId,
      toolCallId: "after-startup",
      toolName: "mutate",
      args: { path: "state.txt" },
    });
    expect(result.outcome).toBe("succeeded");
    const events = await allEvents(runtime.locked);
    const operationId = String(result.operationId);
    expect(events.filter((event) => event.type === "workspace.effect_generation.advanced" && String(event.operationId) === operationId)).toHaveLength(1);
    expect(events.filter((event) => event.type === "operation.mutation_quiesced" && String(event.operationId) === operationId)).toHaveLength(1);
  });
});
''')
