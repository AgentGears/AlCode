import { describe, expect, it } from "vitest";
import type { EventDraft, PersistedDomainEvent } from "@alcode/events";
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
import type { WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { ProgramAdaptiveRootOperationAuthorityV2 } from "./program-adaptive-operation-v2.ts";
import type { ProgramRootOperationAuthorityV1 } from "./program-dispatch.ts";
import type { ProgramSemanticCurrentSnapshotV1 } from "./program-revision.ts";

const programStateId = asProgramStateId("018f0000-0000-7000-8000-0000000009a1");
const sessionId = asSessionId("018f0000-0000-4000-8000-0000000009a2");
const workspaceId = "018f0000-0000-7000-8000-0000000009a3";
const operationId = "018f0000-0000-4000-8000-0000000009a4";
const workId = asProgramWorkItemId("settlement-work");
const attemptId = asProgramAttemptId("settlement-invalidated-attempt");
const revisionId = asProgramRevisionId("settlement-r2");

function envelope(): WorkAuthorityEnvelopeV1 {
  return {
    objectiveBoundaryRef: { programStateId, rootProgramRevisionId: revisionId, anchorWorkItemId: workId },
    allowedRepositoryRoots: ["."],
    allowedEffectClasses: ["fs.write"],
    allowedExternalSystems: [],
    capabilityCeiling: ["edit"],
    maximumTopologyExpansion: 8,
    mandatoryVerificationIds: [],
    forbiddenChangeKinds: [],
  };
}

function base(generation = 2) {
  return {
    workspaceEffectGeneration: generation,
    observation: {
      kind: "workspace-observation-v1" as const,
      providerKind: "test",
      workspaceIdentity: workspaceId,
      coverageDigest: "coverage",
      stateDigest: `state-${generation}`,
    },
  };
}

function raw(): ProgramState {
  const state = createProgramState({
    programStateId,
    sourceSessionId: sessionId,
    objective: "Settle invalidated mutation",
    workItems: [{
      workItemId: workId,
      creationOrder: 0,
      description: "Mutate workspace",
      dependencyIds: [],
      affectedPaths: ["src/settlement.ts"],
    }],
    verification: [],
    outputSlots: [],
    productionSteps: [],
  });
  return {
    ...state,
    revision: 8,
    workItems: [{ ...state.workItems[0]!, lifecycle: "in_progress" }],
    acceptedExecutionBase: base(),
    activeAttempt: {
      programAttemptId: attemptId,
      workItemId: workId,
      sessionId,
      agentGeneration: 5,
      initialExecutionBase: base(),
      expectedExecutionBase: base(),
    },
  };
}

function semantic(satisfactionState: "pending" | "active" = "pending"): ProgramSemanticStateV1 {
  return {
    programStateId,
    currentRevision: {
      programRevisionId: revisionId,
      parentProgramRevisionId: asProgramRevisionId("settlement-r1"),
      ordinal: 2,
      changeClass: "correction",
      acceptedAtStateRevision: 9,
      admissionEventId: "settlement-r2-event",
      sourceDraftId: "settlement-draft",
      sourceDraftDigest: "digest",
    },
    workItems: [{
      workItemId: workId,
      creationOrder: 0,
      description: "Mutate workspace",
      dependencyIds: [],
      affectedPaths: ["src/settlement.ts"],
      workItemGeneration: 2,
      requirementState: "required",
      topologyState: "leaf",
      satisfactionState,
      parentWorkItemId: null,
      authorityEnvelope: envelope(),
    }],
    verification: [],
    verificationBindings: [],
    outputSlots: [],
    productionSteps: [],
  };
}

function current(): ProgramSemanticCurrentSnapshotV1 {
  return {
    programStateRevision: 9,
    semanticState: semantic(),
    activeAttempt: null,
    lifecycle: "active",
    attachedSessionIds: [String(sessionId)],
  };
}

function retainedCurrent(): ProgramSemanticCurrentSnapshotV1 {
  return {
    programStateRevision: 9,
    semanticState: semantic("active"),
    activeAttempt: {
      programAttemptId: attemptId,
      workItemId: workId,
      workItemGeneration: 2,
      directDependencies: [],
      workAuthorityEnvelope: envelope(),
    },
    lifecycle: "active",
    attachedSessionIds: [String(sessionId)],
  };
}

function requestedEvent(): PersistedDomainEvent<string, unknown> {
  return {
    sequence: 2,
    eventId: "operation-requested",
    workspaceId,
    sessionId: String(sessionId),
    operationId,
    programStateId: String(programStateId),
    occurredAt: "2026-08-27T00:00:00.000Z",
    type: "operation.requested",
    payload: {
      operationId,
      workspaceAccessClass: "may_write",
      programAttemptId: String(attemptId),
      workItemId: String(workId),
      agentGeneration: 5,
      quiescenceContract: {
        containment: "operation_scoped_containment",
        containmentInstanceId: "scope-1",
        proofContractId: "host-capability-promise-v1",
        proofContractVersion: 1,
      },
    },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "host-capability-broker" },
  } as unknown as PersistedDomainEvent<string, unknown>;
}

function programCreated(sequence = 1): PersistedDomainEvent<string, unknown> {
  return {
    sequence,
    eventId: "program-created",
    workspaceId,
    sessionId: String(sessionId),
    programStateId: String(programStateId),
    occurredAt: "2026-08-27T00:00:00.000Z",
    type: "program.created",
    payload: { state: raw() },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "test" },
  } as unknown as PersistedDomainEvent<string, unknown>;
}

function sessionStarted(): PersistedDomainEvent<string, unknown> {
  return {
    sequence: 1,
    eventId: "session-started",
    workspaceId,
    sessionId: String(sessionId),
    occurredAt: "2026-08-27T00:00:00.000Z",
    type: "runtime.session.started",
    payload: {},
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "test" },
  } as unknown as PersistedDomainEvent<string, unknown>;
}

function fakeStore(initial?: readonly PersistedDomainEvent<string, unknown>[]) {
  const events: PersistedDomainEvent<string, unknown>[] = initial === undefined
    ? [programCreated(), requestedEvent()]
    : [...initial];
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
  } as unknown as WorkspaceEventStore;
  return { store, events };
}

function delegate(overrides: Partial<ProgramRootOperationAuthorityV1> = {}): ProgramRootOperationAuthorityV1 {
  return {
    resolveCurrentOperation: async () => null,
    appendRoutedRootOperation: async () => { throw new Error("adaptive admission must not delegate"); },
    appendRootOperation: async () => { throw new Error("adaptive admission must not delegate"); },
    settleProgramMutation: async () => { throw new Error("adaptive settlement must not delegate"); },
    ...overrides,
  } as ProgramRootOperationAuthorityV1;
}

function service(
  fixture: ReturnType<typeof fakeStore>,
  currentState: () => Promise<ProgramSemanticCurrentSnapshotV1>,
  authority = delegate(),
) {
  return new ProgramAdaptiveRootOperationAuthorityV2({
    store: fixture.store,
    admission: new CanonicalAdmissionQueue(fixture.store),
    workspaceCoordinator: { runExclusive: async (work) => work() },
    observations: { observe: async () => ({ status: "complete" as const, base: base(2) }) },
    currentState: { current: currentState },
    agentGenerations: { isCurrent: async () => true },
    recovery: { isClear: async () => true },
    delegate: authority,
  });
}

function readOnlyRequestedDraft(): EventDraft<string, unknown> {
  return {
    eventId: "new-operation-requested" as never,
    workspaceId: workspaceId as never,
    sessionId: sessionId as never,
    operationId: operationId as never,
    occurredAt: "2026-08-27T00:00:02.000Z",
    type: "operation.requested",
    payload: { operationId, workspaceAccessClass: "read_only", isReadOnly: true },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "host-capability-broker" },
  };
}

const operationalContext = {
  programStateId: String(programStateId),
  expectedProgramRevision: 8,
  programAttemptId: String(attemptId),
  workItemId: String(workId),
  agentGeneration: 5,
};

describe("A1 adaptive Program operation authority", () => {
  it("settles effect and quiescence truth after semantic Attempt invalidation without reassigning the effect", async () => {
    const fixture = fakeStore();
    const authority = service(fixture, async () => structuredClone(current()));

    const result = await authority.settleProgramMutation({
      sessionId: sessionId as never,
      operationId,
      program: operationalContext,
      quiescenceProven: true,
      buildTerminalDrafts: () => [{
        eventId: "completed-event" as never,
        workspaceId: workspaceId as never,
        sessionId: sessionId as never,
        operationId: operationId as never,
        programStateId: programStateId as never,
        occurredAt: "2026-08-27T00:00:01.000Z",
        type: "operation.completed",
        payload: { operationId, outcome: "succeeded", workspaceAccessClass: "may_write" },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "test" },
      }, {
        eventId: "quiesced-event" as never,
        workspaceId: workspaceId as never,
        sessionId: sessionId as never,
        operationId: operationId as never,
        programStateId: programStateId as never,
        occurredAt: "2026-08-27T00:00:01.000Z",
        type: "operation.mutation_quiesced",
        payload: {
          operationId,
          containment: "operation_scoped_containment",
          containmentInstanceId: "scope-1",
          proofContractId: "host-capability-promise-v1",
          proofContractVersion: 1,
          proofKind: "operation_containment_ended",
          proofEvidenceDigest: "proof-digest",
        },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "test" },
      }],
    });

    expect(fixture.events.some((event) => event.type === "operation.completed")).toBe(true);
    expect(fixture.events.some((event) => event.type === "operation.mutation_quiesced")).toBe(true);
    const effect = fixture.events.find((event) => event.type === "workspace.effect_generation.advanced");
    expect((effect?.payload as { workspaceEffectGeneration: number }).workspaceEffectGeneration).toBe(3);
    const transition = fixture.events.find((event) =>
      event.type === "program.transitioned"
      && event.producer.kind === "runtime"
      && event.producer.component === "program-adaptive-settlement-v2");
    expect(transition).toBeDefined();
    expect((transition!.payload as { state: ProgramState }).state.revision).toBe(10);
    expect((transition!.payload as { state: ProgramState }).state.activeAttempt).toBeNull();
    expect((transition!.payload as { state: ProgramState }).state.executionBaseUnavailable).toBe(true);
    expect(result.state?.activeAttempt).toBeNull();
  });

  it("rejects settlement from a Session that did not request the admitted mutation", async () => {
    const fixture = fakeStore();
    const authority = service(fixture, async () => structuredClone(current()));
    const otherSessionId = asSessionId("018f0000-0000-4000-8000-0000000009a5");

    await expect(authority.settleProgramMutation({
      sessionId: otherSessionId as never,
      operationId,
      program: operationalContext,
      quiescenceProven: false,
      buildTerminalDrafts: () => [],
    })).rejects.toThrow("Admitted mutation ownership cannot be reassigned after semantic Attempt invalidation");

    expect(fixture.events).toHaveLength(2);
  });

  it("admits a retained Attempt operation only after semantic currentness is rechecked in canonical admission", async () => {
    const fixture = fakeStore([sessionStarted(), programCreated(2)]);
    const authority = service(fixture, async () => structuredClone(retainedCurrent()));

    const result = await authority.appendRoutedRootOperation({
      sessionId: sessionId as never,
      operationId,
      workspaceAccessClass: "read_only",
      program: operationalContext,
      drafts: [readOnlyRequestedDraft()],
    });

    expect(result.status).toBe("appended");
    expect(result.program).toEqual(operationalContext);
    const requested = fixture.events.at(-1)!;
    expect(requested.type).toBe("operation.requested");
    expect(requested.programStateId).toBe(String(programStateId));
    expect(requested.payload).toMatchObject({
      programAttemptId: String(attemptId),
      workItemId: String(workId),
      agentGeneration: 5,
      expectedProgramRevision: 8,
    });
  });

  it("rejects operation admission when a semantic cut invalidates the Attempt between the preliminary check and canonical append", async () => {
    const fixture = fakeStore([sessionStarted(), programCreated(2)]);
    let reads = 0;
    const authority = service(fixture, async () => {
      reads += 1;
      return structuredClone(reads === 1 ? retainedCurrent() : current());
    });

    await expect(authority.appendRoutedRootOperation({
      sessionId: sessionId as never,
      operationId,
      workspaceAccessClass: "read_only",
      program: operationalContext,
      drafts: [readOnlyRequestedDraft()],
    })).rejects.toThrow("invalidated by semantic currentness");

    expect(reads).toBe(2);
    expect(fixture.events).toHaveLength(2);
  });

  it("does not resolve a semantically invalidated raw Attempt as current operation authority", async () => {
    const fixture = fakeStore([sessionStarted(), programCreated(2)]);
    const authority = service(
      fixture,
      async () => structuredClone(current()),
      delegate({ resolveCurrentOperation: async () => structuredClone(operationalContext) }),
    );

    await expect(authority.resolveCurrentOperation(sessionId as never)).resolves.toBeNull();
  });
});
