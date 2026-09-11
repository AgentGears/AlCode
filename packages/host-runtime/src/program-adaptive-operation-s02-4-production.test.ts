import { describe, expect, it } from "vitest";
import {
  asProgramAttemptId,
  asProgramRevisionId,
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  createProgramState,
  type ProgramSemanticStateV1,
  type ProgramState,
  type WorkAuthorityEnvelopeV1,
} from "@alcode/program-state";
import type { EventDraft, PersistedDomainEvent } from "@alcode/events";
import type { WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { CapabilityBroker, type HostCapability } from "./capability-broker.ts";
import type { CognitionGateway } from "./cognition-gateway.ts";
import { DefaultHostPolicy } from "./policy.ts";
import { ProgramAdaptiveRootOperationAuthorityV2 } from "./program-adaptive-operation-v2.ts";
import type { ProgramRootOperationAuthorityV1 } from "./program-dispatch.ts";
import type { ProgramSemanticCurrentSnapshotV1 } from "./program-revision.ts";

const workspaceId = "018f0000-0000-7000-8000-00000000b401";
const sessionId = asSessionId("018f0000-0000-4000-8000-00000000b402");
const programStateId = asProgramStateId("018f0000-0000-7000-8000-00000000b403");
const workItemId = asProgramWorkItemId("s02-4-production-mutation-work");
const attemptId = asProgramAttemptId("s02-4-production-attempt");
const revisionId = asProgramRevisionId("s02-4-production-r1");

function envelope(): WorkAuthorityEnvelopeV1 {
  return {
    objectiveBoundaryRef: {
      programStateId,
      rootProgramRevisionId: revisionId,
      anchorWorkItemId: workItemId,
    },
    allowedRepositoryRoots: ["."],
    allowedEffectClasses: ["fs.write"],
    allowedExternalSystems: [],
    capabilityCeiling: ["mutate"],
    maximumTopologyExpansion: 0,
    mandatoryVerificationIds: [],
    forbiddenChangeKinds: [],
  };
}

function executionBase(generation = 2) {
  return {
    workspaceEffectGeneration: generation,
    observation: {
      kind: "workspace-observation-v1" as const,
      providerKind: "test",
      workspaceIdentity: workspaceId,
      coverageDigest: "coverage-s02-4-production",
      stateDigest: "state-s02-4-production",
    },
  };
}

function rawProgram(): ProgramState {
  const created = createProgramState({
    programStateId,
    sourceSessionId: sessionId,
    objective: "Prove production mutation Operation identity",
    workItems: [{
      workItemId,
      creationOrder: 0,
      description: "Perform multiple mediated mutations",
      dependencyIds: [],
      affectedPaths: ["src/s02-4.ts"],
    }],
    verification: [],
    outputSlots: [],
    productionSteps: [],
  });
  return {
    ...created,
    revision: 8,
    workItems: [{ ...created.workItems[0]!, lifecycle: "in_progress" }],
    acceptedExecutionBase: executionBase(),
    activeAttempt: {
      programAttemptId: attemptId,
      workItemId,
      sessionId,
      agentGeneration: 5,
      initialExecutionBase: executionBase(),
      expectedExecutionBase: executionBase(),
    },
  };
}

function semanticState(): ProgramSemanticStateV1 {
  return {
    programStateId,
    currentRevision: {
      programRevisionId: revisionId,
      parentProgramRevisionId: null,
      ordinal: 1,
      changeClass: "initial",
      acceptedAtStateRevision: 8,
      admissionEventId: "s02-4-production-semantic-r1",
      sourceDraftId: null,
      sourceDraftDigest: null,
    },
    workItems: [{
      workItemId,
      creationOrder: 0,
      description: "Perform multiple mediated mutations",
      dependencyIds: [],
      affectedPaths: ["src/s02-4.ts"],
      workItemGeneration: 1,
      requirementState: "required",
      topologyState: "leaf",
      satisfactionState: "active",
      parentWorkItemId: null,
      authorityEnvelope: envelope(),
    }],
    verification: [],
    verificationBindings: [],
    outputSlots: [],
    productionSteps: [],
  };
}

function fakeStore() {
  const events: PersistedDomainEvent<string, unknown>[] = [{
    sequence: 1,
    eventId: "s02-4-production-session-started",
    workspaceId,
    sessionId: String(sessionId),
    occurredAt: "2026-09-10T00:00:00.000Z",
    type: "runtime.session.started",
    payload: { sessionId: String(sessionId) },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "test" },
  } as unknown as PersistedDomainEvent<string, unknown>, {
    sequence: 2,
    eventId: "s02-4-production-program-created",
    workspaceId,
    sessionId: String(sessionId),
    programStateId: String(programStateId),
    occurredAt: "2026-09-10T00:00:01.000Z",
    type: "program.created",
    payload: { state: rawProgram() },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "test" },
  } as unknown as PersistedDomainEvent<string, unknown>];
  const runner = { catchUp() {} };
  const store = {
    workspaceId,
    replay: async function* () { for (const event of events) yield event; },
    headSequence: async () => events.at(-1)?.sequence ?? 0,
    append: async (drafts: readonly EventDraft<string, unknown>[]) => {
      const head = events.at(-1)?.sequence ?? 0;
      const persisted = drafts.map((draft, index) => ({
        ...draft,
        sequence: head + index + 1,
      } as unknown as PersistedDomainEvent<string, unknown>));
      events.push(...persisted);
      return persisted;
    },
    getProjectionRunner: () => runner,
  } as unknown as WorkspaceEventStore;
  return { store, events };
}

function latestRaw(events: readonly PersistedDomainEvent<string, unknown>[]): ProgramState {
  const event = [...events].reverse().find((candidate) =>
    (candidate.type === "program.created" || candidate.type === "program.transitioned")
    && String(candidate.programStateId ?? "") === String(programStateId));
  if (event === undefined) throw new Error("missing ProgramState event");
  return (event.payload as { state: ProgramState }).state;
}

function delegate(): ProgramRootOperationAuthorityV1 {
  return {
    resolveCurrentOperation: async () => null,
    appendRoutedRootOperation: async () => { throw new Error("production adaptive proof must not delegate"); },
    appendRootOperation: async () => { throw new Error("production adaptive proof must not delegate"); },
    settleProgramMutation: async () => { throw new Error("production adaptive proof must not delegate"); },
  } as ProgramRootOperationAuthorityV1;
}

function cognition(): CognitionGateway {
  return {
    matchVerification: async () => ({
      match: {} as never,
      inputDigest: "s02-4-production-input-digest",
      actionSignature: "s02-4-production-action-signature",
    }),
    evaluateVerification: async () => null,
  } as unknown as CognitionGateway;
}

function mutationCapability(): HostCapability {
  return {
    name: "mutate",
    workspaceAccessClass: "may_write",
    quiescence: {
      containmentKind: "operation_scoped_containment",
      proofContractId: "host-capability-promise-v1",
      proofContractVersion: 1,
    },
    async execute(args, context) {
      const contract = context.quiescenceContract;
      if (contract === undefined) throw new Error("mutation lacked Host quiescence contract");
      return {
        result: { args, settled: true },
        outcome: "succeeded",
        quiescenceProof: {
          containmentInstanceId: contract.containmentInstanceId,
          proofContractId: contract.proofContractId,
          proofContractVersion: contract.proofContractVersion,
          proofKind: "operation_containment_ended",
          evidence: {
            kind: "operation_scope_ended",
            containmentInstanceId: contract.containmentInstanceId,
          },
        },
      };
    },
  };
}

function currentSnapshot(events: readonly PersistedDomainEvent<string, unknown>[]): ProgramSemanticCurrentSnapshotV1 {
  const raw = latestRaw(events);
  return {
    programStateRevision: raw.revision,
    semanticState: semanticState(),
    activeAttempt: {
      programAttemptId: attemptId,
      workItemId,
      workItemGeneration: 1,
      directDependencies: [],
      workAuthorityEnvelope: envelope(),
    },
    lifecycle: "active",
    attachedSessionIds: [String(sessionId)],
  };
}

describe("S02-4 production mutation Operation identity proof", () => {
  it("assigns a fresh Host Operation to each sequential mediated mutation and preserves monotonic effect truth", async () => {
    const fixture = fakeStore();
    const admission = new CanonicalAdmissionQueue(fixture.store);
    const authority = new ProgramAdaptiveRootOperationAuthorityV2({
      store: fixture.store,
      admission,
      workspaceCoordinator: { runExclusive: async (work) => work() },
      observations: { observe: async () => ({ status: "complete" as const, base: executionBase() }) },
      currentState: { current: async () => structuredClone(currentSnapshot(fixture.events)) },
      agentGenerations: { isCurrent: async () => true },
      recovery: { isClear: async () => true },
      delegate: delegate(),
    });
    const broker = new CapabilityBroker(
      fixture.store,
      admission,
      cognition(),
      new DefaultHostPolicy({ knownTools: ["mutate"], allowMutations: true }),
      [mutationCapability()],
    );
    broker.setProgramOperationAuthority(authority);

    const executeMutation = async (toolCallId: string, path: string) => {
      const raw = latestRaw(fixture.events);
      return broker.execute({
        sessionId,
        toolCallId,
        toolName: "mutate",
        args: { path },
        program: {
          programStateId: String(programStateId),
          expectedProgramRevision: raw.revision,
          programAttemptId: String(attemptId),
          workItemId: String(workItemId),
          agentGeneration: 5,
        },
      });
    };

    const first = await executeMutation("outer-s02-4:local:1", "src/a.ts");
    const second = await executeMutation("outer-s02-4:local:2", "src/b.ts");

    expect(first).toMatchObject({ outcome: "succeeded" });
    expect(second).toMatchObject({ outcome: "succeeded" });
    expect(first.operationId).toBeDefined();
    expect(second.operationId).toBeDefined();
    expect(second.operationId).not.toBe(first.operationId);

    const requested = fixture.events.filter((event) => event.type === "operation.requested");
    expect(requested.map((event) => String(event.operationId)))
      .toEqual([String(first.operationId), String(second.operationId)]);
    expect(requested.every((event) =>
      (event.payload as { programAttemptId?: string }).programAttemptId === String(attemptId)))
      .toBe(true);

    const quiesced = fixture.events.filter((event) => event.type === "operation.mutation_quiesced");
    expect(quiesced.map((event) => String(event.operationId)))
      .toEqual([String(first.operationId), String(second.operationId)]);

    const effects = fixture.events.filter((event) => event.type === "workspace.effect_generation.advanced");
    expect(effects.map((event) => String(event.operationId)))
      .toEqual([String(first.operationId), String(second.operationId)]);
    expect(effects.map((event) =>
      (event.payload as { workspaceEffectGeneration: number }).workspaceEffectGeneration))
      .toEqual([3, 4]);
    expect(new Set(effects.map((event) => String(event.operationId))).size).toBe(2);
  });
});
