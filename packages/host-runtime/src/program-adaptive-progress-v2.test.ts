import { describe, expect, it } from "vitest";
import type { ProgramProgressProposalV2 } from "@alcode/agent-protocol";
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
import type { ProgramAdaptiveExecutionCutV2 } from "./program-agent-v2.ts";
import { ProgramAdaptiveProgressServiceV2 } from "./program-adaptive-progress-v2.ts";
import type { ProgramSemanticCurrentSnapshotV1 } from "./program-revision.ts";

const programStateId = asProgramStateId("018f0000-0000-7000-8000-000000000991");
const sessionId = asSessionId("018f0000-0000-4000-8000-000000000992");
const workspaceId = "018f0000-0000-7000-8000-000000000993";
const workId = asProgramWorkItemId("progress-work");
const attemptId = asProgramAttemptId("progress-attempt");
const revisionId = asProgramRevisionId("progress-r2");

function envelope(): WorkAuthorityEnvelopeV1 {
  return {
    objectiveBoundaryRef: { programStateId, rootProgramRevisionId: revisionId, anchorWorkItemId: workId },
    allowedRepositoryRoots: ["."],
    allowedEffectClasses: ["fs.read", "fs.write"],
    allowedExternalSystems: [],
    capabilityCeiling: ["edit", "read"],
    maximumTopologyExpansion: 8,
    mandatoryVerificationIds: [],
    forbiddenChangeKinds: [],
  };
}

function base() {
  return {
    workspaceEffectGeneration: 2,
    observation: {
      kind: "workspace-observation-v1" as const,
      providerKind: "test",
      workspaceIdentity: workspaceId,
      coverageDigest: "coverage",
      stateDigest: "state-2",
    },
  };
}

function raw(): ProgramState {
  const created = createProgramState({
    programStateId,
    sourceSessionId: sessionId,
    objective: "Retained adaptive progress",
    workItems: [{
      workItemId: workId,
      creationOrder: 0,
      description: "Keep working",
      dependencyIds: [],
      affectedPaths: ["src/progress.ts"],
    }],
    verification: [],
    outputSlots: [],
    productionSteps: [],
  });
  return {
    ...created,
    revision: 8,
    workItems: [{ ...created.workItems[0]!, lifecycle: "in_progress" }],
    acceptedExecutionBase: base(),
    activeAttempt: {
      programAttemptId: attemptId,
      workItemId: workId,
      sessionId,
      agentGeneration: 4,
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
      parentProgramRevisionId: asProgramRevisionId("progress-r1"),
      ordinal: 2,
      changeClass: "refinement",
      acceptedAtStateRevision: 9,
      admissionEventId: "progress-r2-event",
      sourceDraftId: "progress-draft",
      sourceDraftDigest: "digest",
    },
    workItems: [{
      workItemId: workId,
      creationOrder: 0,
      description: "Keep working",
      dependencyIds: [],
      affectedPaths: ["src/progress.ts"],
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

function current(): ProgramSemanticCurrentSnapshotV1 {
  return {
    programStateRevision: 9,
    semanticState: semantic(),
    activeAttempt: {
      programAttemptId: attemptId,
      workItemId: workId,
      workItemGeneration: 1,
      directDependencies: [],
      workAuthorityEnvelope: envelope(),
    },
    lifecycle: "active",
    attachedSessionIds: [String(sessionId)],
  };
}

function fakeStore(initial: ProgramState) {
  const events: PersistedDomainEvent<string, unknown>[] = [{
    sequence: 1,
    eventId: "program-created",
    workspaceId,
    sessionId: String(sessionId),
    programStateId: String(programStateId),
    occurredAt: "2026-08-27T00:00:00.000Z",
    type: "program.created",
    payload: { state: initial },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "test" },
  } as unknown as PersistedDomainEvent<string, unknown>];
  const store = {
    workspaceId,
    replay: async function* () { for (const event of events) yield event; },
    headSequence: async () => events.length === 0 ? 0 : events[events.length - 1]!.sequence,
    append: async (drafts: readonly EventDraft<string, unknown>[]) => {
      const persisted = drafts.map((draft, index) => ({
        ...draft,
        sequence: events.length + index + 1,
      } as unknown as PersistedDomainEvent<string, unknown>));
      events.push(...persisted);
      return persisted;
    },
  } as unknown as WorkspaceEventStore;
  return { store, events };
}

function cut(snapshot: ProgramSemanticCurrentSnapshotV1): ProgramAdaptiveExecutionCutV2 {
  return {
    facts: {
      semantic: snapshot,
      runtime: {
        programAttemptId: String(attemptId),
        sessionId: String(sessionId),
        agentGeneration: 4,
        sessionActive: true,
        agentGenerationCurrent: true,
        recoveryClear: true,
        writerBarriersClear: true,
        quiescenceClear: true,
        executionBaseCurrent: true,
      },
    },
    projection: {} as never,
    operationalProgramContext: {
      programStateId: String(programStateId),
      expectedProgramRevision: 8,
      programAttemptId: String(attemptId),
      workItemId: String(workId),
      agentGeneration: 4,
    },
  };
}

function message(): ProgramProgressProposalV2 {
  return {
    type: "program.progress",
    version: 2,
    requestId: "progress-request",
    sessionId: String(sessionId),
    authority: {
      authorityVersion: 2,
      programStateId: String(programStateId),
      issuedUnderProgramRevisionId: String(revisionId),
      programAttemptId: String(attemptId),
      workItemId: String(workId),
      workItemGeneration: 1,
      dependencyReceipt: { entries: [] },
      constraintReceipt: {
        workAuthorityEnvelope: {
          objectiveBoundaryRef: {
            programStateId: String(programStateId),
            rootProgramRevisionId: String(revisionId),
            anchorWorkItemId: String(workId),
          },
          allowedRepositoryRoots: ["."],
          allowedEffectClasses: ["fs.read", "fs.write"],
          allowedExternalSystems: [],
          capabilityCeiling: ["edit", "read"],
          maximumTopologyExpansion: 8,
          mandatoryVerificationIds: [],
          forbiddenChangeKinds: [],
        },
        mandatoryConstraintIds: [],
      },
      agentGeneration: 4,
    },
    evidence: [],
    advisoryBlockers: [],
    requestAwaitingVerification: true,
  };
}

describe("A1 adaptive retained-Attempt progress", () => {
  it("rematerializes at the semantic head before recording retained progress", async () => {
    const fixture = fakeStore(raw());
    const snapshot = current();
    const service = new ProgramAdaptiveProgressServiceV2({
      store: fixture.store,
      admission: new CanonicalAdmissionQueue(fixture.store),
      currentState: { current: async () => structuredClone(snapshot) },
    });
    expect(await service.admit({ message: message(), cut: cut(snapshot) })).toEqual({ outcome: "admitted" });
    const transition = fixture.events.at(-1)!;
    expect(transition.producer).toEqual({ kind: "runtime", component: "program-adaptive-progress-v2" });
    expect((transition.payload as { state: ProgramState }).state.revision).toBe(10);
    expect((transition.payload as { state: ProgramState }).state.activeAttempt?.programAttemptId).toBe(attemptId);
    expect((transition.payload as { state: ProgramState }).state.workItems[0]?.lifecycle).toBe("awaiting_verification");
  });

  it("fails stale when the semantic head changes after the protected cut", async () => {
    const fixture = fakeStore(raw());
    const snapshot = current();
    const changed = structuredClone(snapshot);
    changed.programStateRevision = 10;
    const service = new ProgramAdaptiveProgressServiceV2({
      store: fixture.store,
      admission: new CanonicalAdmissionQueue(fixture.store),
      currentState: { current: async () => changed },
    });
    expect((await service.admit({ message: message(), cut: cut(snapshot) })).outcome).toBe("stale");
    expect(fixture.events).toHaveLength(1);
  });
});
