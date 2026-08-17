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
  asOperationId,
  asProgramEvidenceRefId,
  asProgramStateId,
  asVerificationObligationId,
  assertValidProgramState,
  canonicalStringify,
  type ProgramAttemptExecutionBase,
  type ProgramEvidenceReference,
  type ProgramState,
  type VerificationObligation,
} from "@alcode/program-state";
import { reduceOperationsFromEvents, type WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import {
  type CapabilityBroker,
  type CapabilityBrokerResult,
  type HostProgramVerificationInvocationV1,
  type WorkspaceAccessClassV1,
} from "./capability-broker.ts";
import { planningCanonicalDigest } from "./planning-read.ts";
import type {
  ProgramDispatchWorkspaceCoordinatorV1,
  ProgramExecutionObservationSourceV1,
  ProgramRecoveryAuthorityV1,
  ProgramRootOperationContextV1,
} from "./program-dispatch.ts";

export interface HostVerificationOperationSpecV1 {
  specId: string;
  specVersion: number;
  capabilityName: string;
  workspaceAccessClass: WorkspaceAccessClassV1;
  isSuccessful(result: CapabilityBrokerResult): boolean;
}

export class HostVerificationOperationRegistryV1 {
  private readonly specs = new Map<string, HostVerificationOperationSpecV1>();

  constructor(specs: readonly HostVerificationOperationSpecV1[]) {
    for (const spec of specs) {
      if (!spec.specId || !Number.isSafeInteger(spec.specVersion) || spec.specVersion <= 0 || !spec.capabilityName) {
        throw new ProgramVerificationControlError("Invalid HostVerificationOperationSpecV1");
      }
      const key = `${spec.specId}\u0000${spec.specVersion}`;
      if (this.specs.has(key)) throw new ProgramVerificationControlError(`Duplicate Host verification spec ${spec.specId}@${spec.specVersion}`);
      this.specs.set(key, spec);
    }
  }

  resolve(specId: string, specVersion: number): HostVerificationOperationSpecV1 {
    const spec = this.specs.get(`${specId}\u0000${specVersion}`);
    if (spec === undefined) throw new ProgramVerificationControlError(`Unknown Host verification spec ${specId}@${specVersion}`);
    return spec;
  }
}

export interface ProgramVerificationServiceOptionsV1 {
  store: WorkspaceEventStore;
  admission: CanonicalAdmissionQueue;
  workspaceCoordinator: ProgramDispatchWorkspaceCoordinatorV1;
  observations: ProgramExecutionObservationSourceV1;
  recovery: ProgramRecoveryAuthorityV1;
  capabilityBroker: CapabilityBroker;
  operationSpecs: HostVerificationOperationRegistryV1;
}

export interface ProgramVerificationCommandV1 {
  programStateId: string;
  expectedProgramRevision: number;
  verificationObligationId: string;
  sessionId: EventSessionId;
}

export type ProgramVerificationResultV1 =
  | { status: "satisfied"; state: ProgramState; evidenceRefId: string; operationId: string }
  | { status: "not_satisfied"; reason: string; operationId?: string }
  | { status: "stale_generation"; state: ProgramState; operationId: string };

export class ProgramVerificationControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramVerificationControlError";
  }
}

export class ProgramVerificationStaleError extends ProgramVerificationControlError {
  constructor(message: string) {
    super(message);
    this.name = "ProgramVerificationStaleError";
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

function latestProgramState(events: readonly PersistedDomainEvent<string, unknown>[], programStateId: string): ProgramState {
  let latest: ProgramState | undefined;
  for (const event of events) {
    if (String(event.programStateId ?? "") !== programStateId) continue;
    if (event.type !== "program.created" && event.type !== "program.transitioned" &&
        event.type !== "program.completed" && event.type !== "program.cancelled") continue;
    const state = record(event.payload).state as ProgramState | undefined;
    if (state === undefined) throw new ProgramVerificationControlError(`${event.type} lacks payload.state`);
    assertValidProgramState(state);
    latest = state;
  }
  if (latest === undefined) throw new ProgramVerificationControlError(`Unknown ProgramState ${programStateId}`);
  return latest;
}

function requireExactRevision(state: ProgramState, expected: number): void {
  if (state.revision !== expected) throw new ProgramVerificationStaleError(`Program revision conflict: expected ${expected}, current ${state.revision}`);
}

function requireObligation(state: ProgramState, id: string): VerificationObligation {
  const obligationId = asVerificationObligationId(id);
  const obligation = state.verification.find((item) => item.obligationId === obligationId);
  if (obligation === undefined) throw new ProgramVerificationControlError(`Unknown verification obligation ${id}`);
  return obligation;
}

function sameBase(left: ProgramAttemptExecutionBase, right: ProgramAttemptExecutionBase): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

function durableWorkspaceEffectGeneration(events: readonly PersistedDomainEvent<string, unknown>[]): number {
  let current = 0;
  const operationIds = new Set<string>();
  for (const event of events) {
    if (event.type !== "workspace.effect_generation.advanced") continue;
    const payload = record(event.payload);
    const previous = Number(payload.previousWorkspaceEffectGeneration);
    const next = Number(payload.workspaceEffectGeneration);
    const operationId = String(payload.operationId ?? event.operationId ?? "");
    if (!Number.isSafeInteger(previous) || previous < 0 || !Number.isSafeInteger(next) || next <= 0 ||
        previous !== current || next !== current + 1 || !operationId || operationIds.has(operationId) ||
        payload.effectStatus !== "confirmed") {
      throw new ProgramVerificationControlError("Invalid WorkspaceEffectGeneration continuity");
    }
    operationIds.add(operationId);
    current = next;
  }
  return current;
}

function effectiveObservedBase(events: readonly PersistedDomainEvent<string, unknown>[], observed: ProgramAttemptExecutionBase): ProgramAttemptExecutionBase {
  const generation = durableWorkspaceEffectGeneration(events);
  return generation <= observed.workspaceEffectGeneration ? observed : { ...observed, workspaceEffectGeneration: generation };
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
    producer: { kind: "runtime", component: "program-verification" },
  };
}

function requestedOperation(events: readonly PersistedDomainEvent<string, unknown>[], operationId: string): PersistedDomainEvent<string, unknown> | undefined {
  return events.find((event) => event.type === "operation.requested" &&
    String(event.operationId ?? record(event.payload).operationId ?? "") === operationId);
}

function hasQuiescence(events: readonly PersistedDomainEvent<string, unknown>[], operationId: string): boolean {
  return events.some((event) => event.type === "operation.mutation_quiesced" &&
    String(event.operationId ?? record(event.payload).operationId ?? "") === operationId);
}

function requireOperationSafety(
  events: readonly PersistedDomainEvent<string, unknown>[],
  operationId: string,
  expectedAccess: WorkspaceAccessClassV1,
): void {
  const requested = requestedOperation(events, operationId);
  if (requested === undefined) throw new ProgramVerificationControlError(`Missing operation.requested ${operationId}`);
  if (record(requested.payload).workspaceAccessClass !== expectedAccess) {
    throw new ProgramVerificationControlError("Host verification operation WorkspaceAccessClass mismatch");
  }
  const operation = reduceOperationsFromEvents(events).find((item) => item.operationId === operationId);
  if (operation === undefined || operation.lifecycleState !== "terminal" || operation.executionOutcome !== "succeeded") {
    throw new ProgramVerificationControlError("Host verification operation is not terminal-successful");
  }
  if (expectedAccess === "may_write") {
    if (!hasQuiescence(events, operationId) || operation.effectStatus !== "confirmed" ||
        (operation.reconciliationStatus !== "not_required" && operation.reconciliationStatus !== "resolved")) {
      throw new ProgramVerificationControlError("Mutating Host verification operation is not quiescent/effect-certain");
    }
  } else if (operation.effectStatus !== "not_applicable") {
    throw new ProgramVerificationControlError("Read-only Host verification operation has unexpected effect authority");
  }
}

function currentAttemptContext(state: ProgramState, sessionId: EventSessionId): ProgramRootOperationContextV1 {
  if (state.lifecycle !== "active" || state.activeAttempt === null) {
    throw new ProgramVerificationStaleError("Program verification operation requires a current ProgramAttempt");
  }
  const attempt = state.activeAttempt;
  if (String(attempt.sessionId) !== String(sessionId)) {
    throw new ProgramVerificationStaleError("Program verification session does not own the current ProgramAttempt");
  }
  return {
    programStateId: String(state.programStateId),
    expectedProgramRevision: state.revision,
    programAttemptId: String(attempt.programAttemptId),
    workItemId: String(attempt.workItemId),
    agentGeneration: attempt.agentGeneration,
  };
}

export class ProgramVerificationServiceV1 {
  constructor(private readonly options: ProgramVerificationServiceOptionsV1) {}

  async satisfyOperationResult(command: ProgramVerificationCommandV1): Promise<ProgramVerificationResultV1> {
    const prepared = await this.options.admission.enqueue(async () => {
      const events = await replayAll(this.options.store);
      const state = latestProgramState(events, String(asProgramStateId(command.programStateId)));
      requireExactRevision(state, command.expectedProgramRevision);
      const obligation = requireObligation(state, command.verificationObligationId);
      if (obligation.predicate.kind !== "operation_result") {
        throw new ProgramVerificationControlError("Verification obligation is not operation_result");
      }
      if (planningCanonicalDigest(obligation.predicate.canonicalArgs) !== obligation.predicate.canonicalArgsDigest) {
        throw new ProgramVerificationControlError("Host verification canonicalArgsDigest mismatch");
      }
      const attempt = currentAttemptContext(state, command.sessionId);
      const spec = this.options.operationSpecs.resolve(obligation.predicate.specId, obligation.predicate.specVersion);
      return {
        attempt,
        generation: obligation.subjectGeneration,
        args: obligation.predicate.canonicalArgs,
        argsDigest: obligation.predicate.canonicalArgsDigest,
        spec,
      };
    });

    const invocation: HostProgramVerificationInvocationV1 = {
      kind: "operation_result",
      specId: prepared.spec.specId,
      specVersion: prepared.spec.specVersion,
      canonicalArgsDigest: prepared.argsDigest,
      verificationObligationId: command.verificationObligationId,
      subjectGeneration: prepared.generation,
    };
    const result = await this.options.capabilityBroker.execute({
      sessionId: command.sessionId,
      toolCallId: uuidv7(),
      toolName: prepared.spec.capabilityName,
      args: prepared.args,
      program: prepared.attempt,
      programVerificationInvocation: invocation,
    });
    const operationId = result.operationId ? String(result.operationId) : undefined;
    if (result.outcome !== "succeeded" || operationId === undefined || !prepared.spec.isSuccessful(result)) {
      return { status: "not_satisfied", reason: "Host verification operation did not satisfy stable success semantics", ...(operationId ? { operationId } : {}) };
    }

    return this.options.workspaceCoordinator.runExclusive(async () => {
      const observation = await this.options.observations.observe();
      if (observation.status === "unknown") {
        throw new ProgramVerificationStaleError(`Current execution base is unavailable: ${observation.reason}`);
      }
      return this.options.admission.enqueue(async () => {
        if (!await this.options.recovery.isClear()) throw new ProgramVerificationStaleError("Program recovery barrier is not clear");
        const events = await replayAll(this.options.store);
        const state = latestProgramState(events, command.programStateId);
        if (state.lifecycle !== "active") throw new ProgramVerificationStaleError(`Program is terminal: ${state.lifecycle}`);
        if (observation.base.observation.workspaceIdentity !== this.options.store.workspaceId) {
          throw new ProgramVerificationControlError("Protected verification observation belongs to another Workspace");
        }
        const currentBase = effectiveObservedBase(events, observation.base);
        if (state.executionBaseMismatch !== null || state.executionBaseUnavailable || state.acceptedExecutionBase === null ||
            !sameBase(state.acceptedExecutionBase, currentBase)) {
          throw new ProgramVerificationStaleError("Program accepted execution base is not the protected current base");
        }
        const attempt = state.activeAttempt;
        if (attempt === null || String(attempt.programAttemptId) !== prepared.attempt.programAttemptId ||
            String(attempt.sessionId) !== String(command.sessionId) || !sameBase(attempt.expectedExecutionBase, currentBase)) {
          throw new ProgramVerificationStaleError("ProgramAttempt changed before verification satisfaction cut");
        }
        if (prepared.spec.workspaceAccessClass !== "may_write" && state.revision !== prepared.attempt.expectedProgramRevision) {
          throw new ProgramVerificationStaleError("Program revision changed during read-only verification operation");
        }
        const requested = requestedOperation(events, operationId);
        if (requested === undefined) throw new ProgramVerificationControlError("Verification operation request disappeared");
        const actualInvocation = record(record(requested.payload).programVerificationInvocation);
        if (canonicalStringify(actualInvocation) !== canonicalStringify(invocation)) {
          throw new ProgramVerificationControlError("Host verification invocation provenance mismatch");
        }
        requireOperationSafety(events, operationId, prepared.spec.workspaceAccessClass);
        const obligation = requireObligation(state, command.verificationObligationId);
        if (obligation.subjectGeneration !== prepared.generation) {
          return { status: "stale_generation", state, operationId } as const;
        }

        const evidenceRefId = asProgramEvidenceRefId(uuidv7());
        const evidence: ProgramEvidenceReference = {
          evidenceRefId,
          workItemId: attempt.workItemId,
          verificationObligationId: obligation.obligationId,
          sourceOperationId: asOperationId(operationId),
          artifactRef: null,
          subjectGeneration: obligation.subjectGeneration,
        };
        const withEvidence = applyProgramTransition(state, {
          kind: "evidence.add",
          expectedProgramRevision: state.revision,
          evidence,
        });
        const satisfied = applyProgramTransition(withEvidence, {
          kind: "verification.satisfy",
          expectedProgramRevision: withEvidence.revision,
          obligationId: obligation.obligationId,
          satisfaction: { subjectGeneration: obligation.subjectGeneration, evidenceRefIds: [evidenceRefId] },
        });
        const persisted = await this.options.store.append([
          transitionDraft(this.options.store, command.sessionId, withEvidence, "evidence.add", operationId),
          transitionDraft(this.options.store, command.sessionId, satisfied, "verification.satisfy", operationId),
        ]);
        if (persisted.length !== 2) throw new ProgramVerificationControlError("Verification evidence/satisfaction admission was not atomic");
        return { status: "satisfied", state: satisfied, evidenceRefId: String(evidenceRefId), operationId } as const;
      });
    });
  }

  async waiveAuthorized(command: ProgramVerificationCommandV1 & { actor: string; source: string; reason: string }): Promise<ProgramState> {
    return this.options.admission.enqueue(async () => {
      const events = await replayAll(this.options.store);
      const state = latestProgramState(events, String(asProgramStateId(command.programStateId)));
      if (state.lifecycle !== "active") throw new ProgramVerificationStaleError(`Program is terminal: ${state.lifecycle}`);
      requireExactRevision(state, command.expectedProgramRevision);
      if (!command.actor || !command.source || !command.reason) {
        throw new ProgramVerificationControlError("Verification waiver requires actor/source/reason");
      }
      const obligation = requireObligation(state, command.verificationObligationId);
      const next = applyProgramTransition(state, {
        kind: "verification.waive",
        expectedProgramRevision: state.revision,
        obligationId: obligation.obligationId,
        waiver: {
          subjectGeneration: obligation.subjectGeneration,
          actor: command.actor,
          source: command.source,
          reason: command.reason,
        },
      });
      if (next !== state) {
        await this.options.store.append([
          transitionDraft(this.options.store, command.sessionId, next, "verification.waive", command.verificationObligationId),
        ]);
      }
      return next;
    });
  }
}
