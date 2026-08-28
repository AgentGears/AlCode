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

function semantic(): ProgramSemanticStateV1 {
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
      satisfactionState: "pending",
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

function fakeStore() {
  const events: PersistedDomainEvent<string, unknown>[] = [{
    sequence: 1,
    eventId: "program-created",
    workspaceId,
    sessionId: String(sessionId),
    programStateId: String(programStateId),
    occurredAt: "2026-08-27T00:00:00.000Z",
    type: "program.created",
    payload: { state: raw() },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "test" },
  } as unknown as PersistedDomainEvent<string, unknown>, requestedEvent()];
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

describe("A1 adaptive in-flight mutation settlement", () => {
  it("settles effect and quiescence truth after semantic Attempt invalidation without reassigning the effect", async () => {
    const fixture = fakeStore();
    const delegate = {
      resolveCurrentOperation: async () => null,
      appendRoutedRootOperation: async () => { throw new Error("not used"); },
      appendRootOperation: async () => { throw new Error("not used"); },
      settleProgramMutation: async () => { throw new Error("adaptive settlement must not delegate"); },
    } as unknown as ProgramRootOperationAuthorityV1;
    const service = new ProgramAdaptiveRootOperationAuthorityV2({
      store: fixture.store,
      admission: new CanonicalAdmissionQueue(fixture.store),
      workspaceCoordinator: { runExclusive: async (work) => work() },
      observations: { observe: async () => ({ status: "complete" as const, base: base(2) }) },
      currentState: { current: async () => structuredClone(current()) },
      delegate,
    });

    const result = await service.settleProgramMutation({
      sessionId: sessionId as never,
      operationId,
      program: {
        programStateId: String(programStateId),
        expectedProgramRevision: 8,
        programAttemptId: String(attemptId),
        workItemId: String(workId),
        agentGeneration: 5,
      },
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
    const delegate = {
      resolveCurrentOperation: async () => null,
      appendRoutedRootOperation: async () => { throw new Error("not used"); },
      appendRootOperation: async () => { throw new Error("not used"); },
      settleProgramMutation: async () => { throw new Error("adaptive settlement must not delegate"); },
    } as unknown as ProgramRootOperationAuthorityV1;
    const service = new ProgramAdaptiveRootOperationAuthorityV2({
      store: fixture.store,
      admission: new CanonicalAdmissionQueue(fixture.store),
      workspaceCoordinator: { runExclusive: async (work) => work() },
      observations: { observe: async () => ({ status: "complete" as const, base: base(2) }) },
      currentState: { current: async () => structuredClone(current()) },
      delegate,
    });
    const otherSessionId = asSessionId("018f0000-0000-4000-8000-0000000009a5");

    await expect(service.settleProgramMutation({
      sessionId: otherSessionId as never,
      operationId,
      program: {
        programStateId: String(programStateId),
        expectedProgramRevision: 8,
        programAttemptId: String(attemptId),
        workItemId: String(workId),
        agentGeneration: 5,
      },
      quiescenceProven: false,
      buildTerminalDrafts: () => [],
    })).rejects.toThrow("Admitted mutation ownership cannot be reassigned after semantic Attempt invalidation");

    expect(fixture.events).toHaveLength(2);
  });
});
