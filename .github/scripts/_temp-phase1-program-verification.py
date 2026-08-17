from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, got {count}")
    return text.replace(old, new, 1)

Path("packages/host-runtime/src/program-verification.ts").write_text(r'''import {
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
''')

p = Path("packages/host-runtime/src/capability-broker.ts")
s = p.read_text()
s = replace_once(s, "export interface CapabilityBrokerRequest {\n", r'''export interface HostProgramVerificationInvocationV1 {
  kind: "operation_result";
  specId: string;
  specVersion: number;
  canonicalArgsDigest: string;
  verificationObligationId: string;
  subjectGeneration: number;
}

export interface CapabilityBrokerRequest {
''', "verification invocation type")
s = replace_once(s,
'''  program?: ProgramCapabilityOperationContextV1;
  signal?: AbortSignal;
''',
'''  program?: ProgramCapabilityOperationContextV1;
  /** Host-only stable Program verification provenance; never Agent-authored. */
  programVerificationInvocation?: HostProgramVerificationInvocationV1;
  signal?: AbortSignal;
''', "verification request field")
s = replace_once(s,
'''          ...(reconciliationContract !== undefined ? { reconciliationContract } : {}),
''',
'''          ...(reconciliationContract !== undefined ? { reconciliationContract } : {}),
          ...(request.programVerificationInvocation !== undefined
            ? { programVerificationInvocation: freezeCanonical(request.programVerificationInvocation) }
            : {}),
''', "verification provenance persistence")
p.write_text(s)

p = Path("packages/host-runtime/src/index.ts")
s = p.read_text()
s = replace_once(s, "  type ProgramCapabilityOperationContextV1,\n", "  type ProgramCapabilityOperationContextV1,\n  type HostProgramVerificationInvocationV1,\n", "index broker export")
s += '''\nexport {
  HostVerificationOperationRegistryV1,
  ProgramVerificationServiceV1,
  ProgramVerificationControlError,
  ProgramVerificationStaleError,
  type HostVerificationOperationSpecV1,
  type ProgramVerificationServiceOptionsV1,
  type ProgramVerificationCommandV1,
  type ProgramVerificationResultV1,
} from "./program-verification.ts";\n'''
p.write_text(s)

Path("packages/host-runtime/src/program-verification.test.ts").write_text(r'''import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asProgramStateId as asEventProgramStateId,
  asSessionId as asEventSessionId,
  asWorkspaceId,
  mkEventId,
  mkProgramStateId,
  uuidv7,
} from "@alcode/events";
import {
  applyProgramTransition,
  asProgramAttemptId,
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  asVerificationObligationId,
  createProgramState,
  isVerificationCurrent,
  type ProgramAttemptExecutionBase,
  type ProgramState,
} from "@alcode/program-state";
import { openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { CognitionGateway } from "./cognition-gateway.ts";
import { CapabilityBroker, type HostCapability } from "./capability-broker.ts";
import { DefaultHostPolicy } from "./policy.ts";
import { planningCanonicalDigest } from "./planning-read.ts";
import { ProgramDispatchServiceV1 } from "./program-dispatch.ts";
import { HostVerificationOperationRegistryV1, ProgramVerificationServiceV1 } from "./program-verification.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;
const stores: LockedWorkspaceStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* closed */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function base(workspaceIdentity: string, generation = 0, stateDigest = "state-0"): ProgramAttemptExecutionBase {
  return {
    workspaceEffectGeneration: generation,
    observation: { kind: "workspace-observation-v1", providerKind: "verification-test", workspaceIdentity, coverageDigest: "coverage-v1", stateDigest },
  };
}

class ObservationSource {
  constructor(public current: ProgramAttemptExecutionBase) {}
  observe() { return Promise.resolve({ status: "complete" as const, base: this.current }); }
}

async function latestState(store: LockedWorkspaceStore, programStateId: string): Promise<ProgramState> {
  let latest: ProgramState | undefined;
  for await (const event of store.store.replay()) {
    if (String(event.programStateId ?? "") !== programStateId) continue;
    if (event.type === "program.created" || event.type === "program.transitioned") latest = (event.payload as { state: ProgramState }).state;
  }
  if (!latest) throw new Error("missing ProgramState");
  return latest;
}

async function setup(makeCapability: (observations: ObservationSource) => HostCapability) {
  const dir = mkdtempSync(join(tmpdir(), "alcode-program-verification-"));
  dirs.push(dir);
  const workspaceId = asWorkspaceId(uuidv7());
  const locked = await openLockedWorkspaceStore({
    databasePath: join(dir, "workspace.sqlite"), lockPath: join(dir, "workspace.lock"), workspaceId, repositoryId: uuidv7(),
  });
  stores.push(locked);
  const admission = new CanonicalAdmissionQueue(locked.store);
  const sessionId = asEventSessionId(uuidv7());
  await admission.append([{
    eventId: mkEventId(), workspaceId, sessionId, occurredAt: new Date().toISOString(), type: "runtime.session.started",
    payload: { sessionId: String(sessionId) }, payloadSchemaVersion: 1, producer: { kind: "runtime", component: "verification-test" },
  }]);
  const observations = new ObservationSource(base(String(workspaceId)));
  const capability = makeCapability(observations);
  const args = { command: "verify" } as const;
  const obligationId = asVerificationObligationId("verify-1");
  const workItemId = asProgramWorkItemId("work-1");
  const initial = createProgramState({
    programStateId: asProgramStateId(String(mkProgramStateId())), sourceSessionId: asSessionId(String(sessionId)), objective: "verify",
    workItems: [{ workItemId, creationOrder: 0, description: "verify", dependencyIds: [], affectedPaths: ["src/value.ts"] }],
    verification: [{
      obligationId,
      predicate: { kind: "operation_result", specId: "verify-spec", specVersion: 1, canonicalArgs: args, canonicalArgsDigest: planningCanonicalDigest(args) },
      freshnessScope: { kind: "workspace" },
    }],
    outputSlots: [], productionSteps: [],
  });
  const withAttempt = applyProgramTransition(initial, {
    kind: "attempt.issue", expectedProgramRevision: initial.revision,
    attempt: {
      programAttemptId: asProgramAttemptId(uuidv7()), workItemId, sessionId: asSessionId(String(sessionId)), agentGeneration: 1,
      initialExecutionBase: observations.current, expectedExecutionBase: observations.current,
    },
  });
  await admission.append([
    {
      eventId: mkEventId(), workspaceId, sessionId, programStateId: asEventProgramStateId(String(initial.programStateId)), occurredAt: new Date().toISOString(),
      type: "program.created", payload: { state: initial }, payloadSchemaVersion: 1, producer: { kind: "runtime", component: "verification-test" },
    },
    {
      eventId: mkEventId(), workspaceId, sessionId, programStateId: asEventProgramStateId(String(initial.programStateId)), occurredAt: new Date().toISOString(),
      type: "program.transitioned", payload: { state: withAttempt, transitionKind: "attempt.issue" }, payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "verification-test" },
    },
  ]);
  const broker = new CapabilityBroker(
    locked.store, admission, new CognitionGateway(locked),
    new DefaultHostPolicy({ knownTools: [capability.name], allowMutations: true }), [capability],
  );
  const coordinator = { runExclusive: <T>(work: () => Promise<T>) => work() };
  const recovery = { isClear: () => true };
  const dispatch = new ProgramDispatchServiceV1({
    store: locked.store, admission, workspaceCoordinator: coordinator, observations,
    agentGenerations: { isCurrent: () => true }, recovery,
    firstDispatchPlanning: { recheckAcceptedPlanningBase: async () => undefined },
  });
  broker.setProgramOperationAuthority(dispatch);
  const registry = new HostVerificationOperationRegistryV1([{
    specId: "verify-spec", specVersion: 1, capabilityName: capability.name,
    workspaceAccessClass: capability.workspaceAccessClass ?? (capability.isReadOnly ? "read_only" : "may_write"),
    isSuccessful: (result) => result.outcome === "succeeded" && result.result === "verified",
  }]);
  const service = new ProgramVerificationServiceV1({
    store: locked.store, admission, workspaceCoordinator: coordinator, observations, recovery, capabilityBroker: broker, operationSpecs: registry,
  });
  return { locked, admission, sessionId, initial, withAttempt, obligationId, observations, service };
}

describeLocked("Program operation_result verification", () => {
  it("admits exact Host-spec evidence and satisfaction atomically at the current base", async () => {
    const f = await setup(() => ({
      name: "verify", workspaceAccessClass: "read_only", async execute() { return { result: "verified", outcome: "succeeded" }; },
    }));
    const result = await f.service.satisfyOperationResult({
      programStateId: String(f.initial.programStateId), expectedProgramRevision: f.withAttempt.revision,
      verificationObligationId: String(f.obligationId), sessionId: f.sessionId,
    });
    expect(result.status).toBe("satisfied");
    const state = await latestState(f.locked, String(f.initial.programStateId));
    expect(isVerificationCurrent(state.verification[0]!)).toBe(true);
    expect(state.decisiveEvidence).toHaveLength(1);
    expect(state.decisiveEvidence[0]!.sourceOperationId).not.toBeNull();
    const events = [] as Array<{ type: string; payload: unknown }>;
    for await (const event of f.locked.store.replay()) events.push({ type: event.type, payload: event.payload });
    const request = events.find((event) => event.type === "operation.requested")!;
    expect((request.payload as Record<string, unknown>).programVerificationInvocation).toMatchObject({
      kind: "operation_result", specId: "verify-spec", specVersion: 1, verificationObligationId: "verify-1", subjectGeneration: 1,
    });
  });

  it("does not let a mutating verifier self-certify the generation its unknown impact invalidates", async () => {
    const f = await setup((observations) => ({
      name: "verify", workspaceAccessClass: "may_write",
      quiescence: { containmentKind: "operation_scoped_containment", proofContractId: "host-capability-promise-v1", proofContractVersion: 1 },
      async execute(_args, context) {
        observations.current = base(observations.current.observation.workspaceIdentity, 1, "after-verifier-mutation");
        const containmentInstanceId = context.quiescenceContract!.containmentInstanceId;
        return {
          result: "verified", outcome: "succeeded",
          quiescenceProof: {
            containmentInstanceId, proofContractId: "host-capability-promise-v1", proofContractVersion: 1,
            proofKind: "operation_containment_ended", evidence: { kind: "operation_scope_ended", containmentInstanceId },
          },
        };
      },
    }));
    const result = await f.service.satisfyOperationResult({
      programStateId: String(f.initial.programStateId), expectedProgramRevision: f.withAttempt.revision,
      verificationObligationId: String(f.obligationId), sessionId: f.sessionId,
    });
    expect(result.status).toBe("stale_generation");
    const state = await latestState(f.locked, String(f.initial.programStateId));
    expect(state.verification[0]!.subjectGeneration).toBe(2);
    expect(state.verification[0]!.satisfaction).toBeNull();
  });

  it("records an explicit exact-generation Host-authorized waiver without fabricating predicate evidence", async () => {
    const f = await setup(() => ({
      name: "verify", workspaceAccessClass: "read_only", async execute() { return { result: "verified" }; },
    }));
    const state = await f.service.waiveAuthorized({
      programStateId: String(f.initial.programStateId), expectedProgramRevision: f.withAttempt.revision,
      verificationObligationId: String(f.obligationId), sessionId: f.sessionId,
      actor: "application:user", source: "application-command", reason: "authorized exception",
    });
    expect(state.verification[0]!.waiver).toMatchObject({ subjectGeneration: 1, actor: "application:user", source: "application-command" });
    expect(state.verification[0]!.satisfaction).toBeNull();
    expect(state.decisiveEvidence).toHaveLength(0);
  });
});
''')
