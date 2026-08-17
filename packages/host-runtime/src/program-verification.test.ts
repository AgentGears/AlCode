import { mkdtempSync, rmSync } from "node:fs";
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

class PathObservationSource {
  state: "file" | "directory" | "symlink" | "absent" = "file";
  constructor(private readonly observations: ObservationSource) {}
  observePath(_path: string) {
    return Promise.resolve({ status: "complete" as const, base: this.observations.current, pathState: this.state });
  }
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

async function setup(
  makeCapability: (observations: ObservationSource) => HostCapability,
  verificationKind: "operation" | "path" = "operation",
) {
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
      predicate: verificationKind === "operation"
        ? { kind: "operation_result", specId: "verify-spec", specVersion: 1, canonicalArgs: args, canonicalArgsDigest: planningCanonicalDigest(args) }
        : { kind: "workspace_path_state", path: "src/value.ts", requiredState: "file" },
      freshnessScope: verificationKind === "operation"
        ? { kind: "workspace" }
        : { kind: "paths", entries: [{ path: "src/value.ts", mode: "exact" }] },
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
  const pathObservations = new PathObservationSource(observations);
  const service = new ProgramVerificationServiceV1({
    store: locked.store, admission, workspaceCoordinator: coordinator, observations, pathObservations, recovery, capabilityBroker: broker, operationSpecs: registry,
  });
  return { locked, admission, sessionId, initial, withAttempt, obligationId, observations, pathObservations, service };
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


describeLocked("Program workspace_path_state verification", () => {
  it("satisfies exact path state only at the protected current execution-base cut", async () => {
    const f = await setup(() => ({
      name: "verify", workspaceAccessClass: "read_only", async execute() { return { result: "verified" }; },
    }), "path");
    const result = await f.service.satisfyWorkspacePathState({
      programStateId: String(f.initial.programStateId),
      expectedProgramRevision: f.withAttempt.revision,
      verificationObligationId: String(f.obligationId),
      sessionId: f.sessionId,
    });
    expect(result.status).toBe("satisfied");
    const state = await latestState(f.locked, String(f.initial.programStateId));
    expect(isVerificationCurrent(state.verification[0]!)).toBe(true);
    expect(state.decisiveEvidence[0]!.sourceOperationId).toBeNull();
  });

  it("treats mismatched or unknown path observation as non-satisfaction rather than absence", async () => {
    const f = await setup(() => ({
      name: "verify", workspaceAccessClass: "read_only", async execute() { return { result: "verified" }; },
    }), "path");
    f.pathObservations.state = "absent";
    const result = await f.service.satisfyWorkspacePathState({
      programStateId: String(f.initial.programStateId),
      expectedProgramRevision: f.withAttempt.revision,
      verificationObligationId: String(f.obligationId),
      sessionId: f.sessionId,
    });
    expect(result.status).toBe("not_satisfied");
    const state = await latestState(f.locked, String(f.initial.programStateId));
    expect(state.verification[0]!.satisfaction).toBeNull();
  });
});
