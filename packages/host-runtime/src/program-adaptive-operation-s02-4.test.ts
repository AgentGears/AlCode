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

const programStateId = asProgramStateId("018f0000-0000-7000-8000-00000000a411");
const sessionId = asSessionId("018f0000-0000-4000-8000-00000000a412");
const workspaceId = "018f0000-0000-7000-8000-00000000a413";
const operationA = "018f0000-0000-4000-8000-00000000a414";
const operationB = "018f0000-0000-4000-8000-00000000a415";
const workItemId = asProgramWorkItemId("s02-4-settlement-work");
const attemptId = asProgramAttemptId("s02-4-invalidated-attempt");
const revisionId = asProgramRevisionId("s02-4-semantic-r2");

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
      coverageDigest: "coverage-s02-4",
      stateDigest: `state-s02-4-${generation}`,
    },
  };
}

function rawProgram(): ProgramState {
  const created = createProgramState({
    programStateId,
    sourceSessionId: sessionId,
    objective: "S02-4 distinct admitted mutation settlement",
    workItems: [{
      workItemId,
      creationOrder: 0,
      description: "Perform two already-admitted mutations",
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
      parentProgramRevisionId: asProgramRevisionId("s02-4-semantic-r1"),
      ordinal: 2,
      changeClass: "correction",
      acceptedAtStateRevision: 9,
      admissionEventId: "s02-4-semantic-r2-event",
      sourceDraftId: "s02-4-draft",
      sourceDraftDigest: "s02-4-digest",
    },
    workItems: [{
      workItemId,
      creationOrder: 0,
      description: "Perform two already-admitted mutations",
      dependencyIds: [],
      affectedPaths: ["src/s02-4.ts"],
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

function invalidatedCurrent(): ProgramSemanticCurrentSnapshotV1 {
  return {
    programStateRevision: 9,
    semanticState: semanticState(),
    activeAttempt: null,
    lifecycle: "active",
    attachedSessionIds: [String(sessionId)],
  };
}

function programCreated(): PersistedDomainEvent<string, unknown> {
  return {
    sequence: 1,
    eventId: "s02-4-program-created",
    workspaceId,
    sessionId: String(sessionId),
    programStateId: String(programStateId),
    occurredAt: "2026-09-10T00:00:00.000Z",
    type: "program.created",
    payload: { state: rawProgram() },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "test" },
  } as unknown as PersistedDomainEvent<string, unknown>;
}

function requestedMutation(
  operationId: string,
  sequence: number,
  containmentInstanceId: string,
): PersistedDomainEvent<string, unknown> {
  return {
    sequence,
    eventId: `s02-4-requested-${operationId}`,
    workspaceId,
    sessionId: String(sessionId),
    operationId,
    programStateId: String(programStateId),
    occurredAt: "2026-09-10T00:00:01.000Z",
    type: "operation.requested",
    payload: {
      operationId,
      workspaceAccessClass: "may_write",
      programAttemptId: String(attemptId),
      workItemId: String(workItemId),
      agentGeneration: 5,
      quiescenceContract: {
        containment: "operation_scoped_containment",
        containmentInstanceId,
        proofContractId: "host-capability-promise-v1",
        proofContractVersion: 1,
      },
    },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "host-capability-broker" },
  } as unknown as PersistedDomainEvent<string, unknown>;
}

function fakeStore() {
  const events: PersistedDomainEvent<string, unknown>[] = [
    programCreated(),
    requestedMutation(operationA, 2, "scope-s02-4-a"),
    requestedMutation(operationB, 3, "scope-s02-4-b"),
  ];
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

function delegate(): ProgramRootOperationAuthorityV1 {
  return {
    resolveCurrentOperation: async () => null,
    appendRoutedRootOperation: async () => { throw new Error("S02-4 adaptive proof must not delegate"); },
    appendRootOperation: async () => { throw new Error("S02-4 adaptive proof must not delegate"); },
    settleProgramMutation: async () => { throw new Error("S02-4 adaptive proof must not delegate"); },
  } as ProgramRootOperationAuthorityV1;
}

function terminalDrafts(
  operationId: string,
  containmentInstanceId: string,
): EventDraft<string, unknown>[] {
  return [{
    eventId: `s02-4-completed-${operationId}` as never,
    workspaceId: workspaceId as never,
    sessionId: sessionId as never,
    operationId: operationId as never,
    programStateId: programStateId as never,
    occurredAt: "2026-09-10T00:00:02.000Z",
    type: "operation.completed",
    payload: { operationId, outcome: "succeeded", workspaceAccessClass: "may_write" },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "test" },
  }, {
    eventId: `s02-4-quiesced-${operationId}` as never,
    workspaceId: workspaceId as never,
    sessionId: sessionId as never,
    operationId: operationId as never,
    programStateId: programStateId as never,
    occurredAt: "2026-09-10T00:00:02.000Z",
    type: "operation.mutation_quiesced",
    payload: {
      operationId,
      containment: "operation_scoped_containment",
      containmentInstanceId,
      proofContractId: "host-capability-promise-v1",
      proofContractVersion: 1,
      proofKind: "operation_containment_ended",
      proofEvidenceDigest: `proof-${operationId}`,
    },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "test" },
  }];
}

const operationalContext = {
  programStateId: String(programStateId),
  expectedProgramRevision: 8,
  programAttemptId: String(attemptId),
  workItemId: String(workItemId),
  agentGeneration: 5,
};

describe("S02-4 adaptive mutation effect identity proof", () => {
  it("settles two already-admitted mutations after Attempt invalidation with distinct Operations and monotonic effect truth", async () => {
    const fixture = fakeStore();
    const authority = new ProgramAdaptiveRootOperationAuthorityV2({
      store: fixture.store,
      admission: new CanonicalAdmissionQueue(fixture.store),
      workspaceCoordinator: { runExclusive: async (work) => work() },
      observations: { observe: async () => ({ status: "complete" as const, base: executionBase() }) },
      currentState: { current: async () => structuredClone(invalidatedCurrent()) },
      agentGenerations: { isCurrent: async () => false },
      recovery: { isClear: async () => true },
      delegate: delegate(),
    });

    await authority.settleProgramMutation({
      sessionId: sessionId as never,
      operationId: operationA,
      program: operationalContext,
      quiescenceProven: true,
      buildTerminalDrafts: () => terminalDrafts(operationA, "scope-s02-4-a"),
    });
    await authority.settleProgramMutation({
      sessionId: sessionId as never,
      operationId: operationB,
      program: operationalContext,
      quiescenceProven: true,
      buildTerminalDrafts: () => terminalDrafts(operationB, "scope-s02-4-b"),
    });

    const completed = fixture.events.filter((event) => event.type === "operation.completed");
    const quiesced = fixture.events.filter((event) => event.type === "operation.mutation_quiesced");
    const effects = fixture.events.filter((event) => event.type === "workspace.effect_generation.advanced");

    expect(completed.map((event) => String(event.operationId))).toEqual([operationA, operationB]);
    expect(quiesced.map((event) => String(event.operationId))).toEqual([operationA, operationB]);
    expect(effects).toHaveLength(2);
    expect(effects.map((event) => String((event.payload as { operationId: string }).operationId)))
      .toEqual([operationA, operationB]);
    expect(effects.map((event) => (event.payload as { workspaceEffectGeneration: number }).workspaceEffectGeneration))
      .toEqual([3, 4]);
    expect(new Set(effects.map((event) => String(event.operationId))).size).toBe(2);

    const requested = fixture.events.filter((event) => event.type === "operation.requested");
    expect(requested).toHaveLength(2);
    expect(requested.every((event) =>
      String((event.payload as { programAttemptId: string }).programAttemptId) === String(attemptId)))
      .toBe(true);
  });
});
