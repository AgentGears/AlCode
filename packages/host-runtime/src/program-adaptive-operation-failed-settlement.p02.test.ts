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

const programStateId = asProgramStateId("018f0000-0000-7000-8000-00000000fa01");
const sessionId = asSessionId("018f0000-0000-4000-8000-00000000fa02");
const workspaceId = "018f0000-0000-7000-8000-00000000fa03";
const operationId = "018f0000-0000-4000-8000-00000000fa04";
const workItemId = asProgramWorkItemId("p02-failed-settlement-work");
const attemptId = asProgramAttemptId("p02-failed-settlement-attempt");
const revisionId = asProgramRevisionId("p02-failed-settlement-r1");

function executionBase() {
  return {
    workspaceEffectGeneration: 2,
    observation: {
      kind: "workspace-observation-v1" as const,
      providerKind: "p02-test",
      workspaceIdentity: workspaceId,
      coverageDigest: "coverage-p02-failed-settlement",
      stateDigest: "state-p02-failed-settlement",
    },
  };
}

function authorityEnvelope(): WorkAuthorityEnvelopeV1 {
  return {
    objectiveBoundaryRef: {
      programStateId,
      rootProgramRevisionId: revisionId,
      anchorWorkItemId: workItemId,
    },
    allowedRepositoryRoots: ["."],
    allowedEffectClasses: ["fs.write"],
    allowedExternalSystems: [],
    capabilityCeiling: ["bash"],
    maximumTopologyExpansion: 8,
    mandatoryVerificationIds: [],
    forbiddenChangeKinds: [],
  };
}

function rawState(): ProgramState {
  const initial = createProgramState({
    programStateId,
    sourceSessionId: sessionId,
    objective: "Persist failed verifier terminal truth before retry",
    workItems: [{
      workItemId,
      creationOrder: 0,
      description: "Run a verifier that exits non-zero",
      dependencyIds: [],
      affectedPaths: ["src/value.ts"],
    }],
    verification: [],
    outputSlots: [],
    productionSteps: [],
  });
  return {
    ...initial,
    revision: 5,
    acceptedExecutionBase: executionBase(),
    workItems: [{ ...initial.workItems[0]!, lifecycle: "awaiting_verification" }],
    activeAttempt: {
      programAttemptId: attemptId,
      workItemId,
      sessionId,
      agentGeneration: 2,
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
      acceptedAtStateRevision: 6,
      admissionEventId: "p02-failed-settlement-semantic",
      sourceDraftId: null,
      sourceDraftDigest: null,
    },
    workItems: [{
      workItemId,
      creationOrder: 0,
      description: "Run a verifier that exits non-zero",
      dependencyIds: [],
      affectedPaths: ["src/value.ts"],
      workItemGeneration: 1,
      requirementState: "required",
      topologyState: "leaf",
      satisfactionState: "awaiting_verification",
      parentWorkItemId: null,
      authorityEnvelope: authorityEnvelope(),
    }],
    verification: [],
    verificationBindings: [],
    outputSlots: [],
    productionSteps: [],
  };
}

function currentState(): ProgramSemanticCurrentSnapshotV1 {
  return {
    programStateRevision: 6,
    semanticState: semanticState(),
    activeAttempt: {
      programAttemptId: attemptId,
      workItemId,
      workItemGeneration: 1,
      directDependencies: [],
      workAuthorityEnvelope: authorityEnvelope(),
    },
    lifecycle: "active",
    attachedSessionIds: [String(sessionId)],
  };
}

function programCreated(): PersistedDomainEvent<string, unknown> {
  return {
    sequence: 1,
    eventId: "p02-failed-settlement-program",
    workspaceId,
    sessionId: String(sessionId),
    programStateId: String(programStateId),
    occurredAt: "2026-09-07T00:00:00.000Z",
    type: "program.created",
    payload: { state: rawState() },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "test" },
  } as unknown as PersistedDomainEvent<string, unknown>;
}

function operationRequested(): PersistedDomainEvent<string, unknown> {
  return {
    sequence: 2,
    eventId: "p02-failed-settlement-requested",
    workspaceId,
    sessionId: String(sessionId),
    operationId,
    programStateId: String(programStateId),
    occurredAt: "2026-09-07T00:00:01.000Z",
    type: "operation.requested",
    payload: {
      operationId,
      toolName: "bash",
      workspaceAccessClass: "may_write",
      programAttemptId: String(attemptId),
      workItemId: String(workItemId),
      agentGeneration: 2,
      quiescenceContract: {
        containment: "operation_scoped_containment",
        containmentInstanceId: "p02-verifier-scope",
        proofContractId: "host-capability-promise-v1",
        proofContractVersion: 1,
      },
    },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "host-capability-broker" },
  } as unknown as PersistedDomainEvent<string, unknown>;
}

function fixture() {
  const events: PersistedDomainEvent<string, unknown>[] = [programCreated(), operationRequested()];
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
  const delegate = {
    resolveCurrentOperation: async () => null,
    appendRoutedRootOperation: async () => { throw new Error("unexpected delegate admission"); },
    appendRootOperation: async () => { throw new Error("unexpected delegate admission"); },
    settleProgramMutation: async () => { throw new Error("unexpected delegate settlement"); },
  } as ProgramRootOperationAuthorityV1;
  const authority = new ProgramAdaptiveRootOperationAuthorityV2({
    store,
    admission: new CanonicalAdmissionQueue(store),
    workspaceCoordinator: { runExclusive: async <T>(work: () => Promise<T>) => work() },
    observations: { observe: async () => ({ status: "complete" as const, base: executionBase() }) },
    currentState: { current: async () => structuredClone(currentState()) },
    agentGenerations: { isCurrent: async () => true },
    recovery: { isClear: async () => true },
    delegate,
  });
  return { authority, events };
}

function terminalDrafts(): EventDraft<string, unknown>[] {
  return [{
    eventId: "p02-failed-settlement-completed" as never,
    workspaceId: workspaceId as never,
    sessionId: sessionId as never,
    operationId: operationId as never,
    programStateId: programStateId as never,
    occurredAt: "2026-09-07T00:00:02.000Z",
    type: "operation.completed",
    payload: { operationId, outcome: "failed", workspaceAccessClass: "may_write" },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "host-capability-broker" },
  }, {
    eventId: "p02-failed-settlement-quiesced" as never,
    workspaceId: workspaceId as never,
    sessionId: sessionId as never,
    operationId: operationId as never,
    programStateId: programStateId as never,
    occurredAt: "2026-09-07T00:00:02.000Z",
    type: "operation.mutation_quiesced",
    payload: {
      operationId,
      containment: "operation_scoped_containment",
      containmentInstanceId: "p02-verifier-scope",
      proofContractId: "host-capability-promise-v1",
      proofContractVersion: 1,
      proofKind: "operation_containment_ended",
      proofEvidenceDigest: "p02-failed-settlement-proof",
    },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "host-capability-broker" },
  }];
}

describe("P-02 failed adaptive verifier settlement", () => {
  it("persists terminal failed/quiescent Operation truth before making the execution base unavailable", async () => {
    const { authority, events } = fixture();

    const result = await authority.settleProgramMutation({
      sessionId: sessionId as never,
      operationId,
      program: {
        programStateId: String(programStateId),
        expectedProgramRevision: 5,
        programAttemptId: String(attemptId),
        workItemId: String(workItemId),
        agentGeneration: 2,
      },
      quiescenceProven: true,
      buildTerminalDrafts: () => terminalDrafts(),
    });

    expect(events.some((event) => event.type === "operation.completed")).toBe(true);
    expect(events.some((event) => event.type === "operation.mutation_quiesced")).toBe(true);
    expect(events.some((event) => event.type === "workspace.effect_generation.advanced")).toBe(false);

    const transition = events.find((event) =>
      event.type === "program.transitioned"
      && (event.payload as { transitionKind?: string }).transitionKind === "execution_base.unavailable");
    expect(transition).toBeDefined();
    const state = (transition!.payload as { state: ProgramState }).state;
    expect(state.activeAttempt).toBeNull();
    expect(state.executionBaseUnavailable).toBe(true);
    expect(state.workItems[0]?.lifecycle).toBe("awaiting_verification");
    expect(result.state?.executionBaseUnavailable).toBe(true);
  });
});
