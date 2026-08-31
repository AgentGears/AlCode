import { describe, expect, it } from "vitest";
import type { EventDraft, PersistedDomainEvent } from "@alcode/events";
import {
  asProgramAttemptId,
  asProgramRevisionId,
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  asVerificationObligationId,
  createProgramState,
  type ProgramAttempt,
  type ProgramSemanticStateV1,
  type ProgramSemanticWorkItemV1,
  type ProgramState,
  type WorkAuthorityEnvelopeV1,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { HostArtifactStore } from "./artifact-store.ts";
import {
  ProgramAdaptiveOperationalOverlayErrorV2,
  ProgramAdaptiveTerminalServiceV2,
  adaptiveAttemptInvalidatedAfterIssueV2,
  assertAdaptiveOperationalVerificationGenerationV2,
  deriveAttemptSemanticAssumptionsV2,
  validatePostSemanticProgramStateSequenceV2,
} from "./program-adaptive-operational-v2.ts";
import type { ProgramSemanticCurrentSnapshotV1 } from "./program-revision.ts";

const programStateId = asProgramStateId("018f0000-0000-7000-8000-000000000971");
const sessionId = asSessionId("018f0000-0000-4000-8000-000000000972");
const dependencyId = asProgramWorkItemId("operational-dependency");
const targetId = asProgramWorkItemId("operational-target");
const retiredId = asProgramWorkItemId("operational-retired");
const attemptId = asProgramAttemptId("operational-attempt");
const revisionId = asProgramRevisionId("operational-r1");
const verificationId = asVerificationObligationId("operational-verification");
const terminalWorkspaceId = "018f0000-0000-7000-8000-000000000973";

function envelope(): WorkAuthorityEnvelopeV1 {
  return {
    objectiveBoundaryRef: {
      programStateId,
      rootProgramRevisionId: revisionId,
      anchorWorkItemId: targetId,
    },
    allowedRepositoryRoots: ["."],
    allowedEffectClasses: ["fs.read", "fs.write"],
    allowedExternalSystems: [],
    capabilityCeiling: ["edit", "read"],
    maximumTopologyExpansion: 8,
    mandatoryVerificationIds: [],
    forbiddenChangeKinds: ["delete_repository"],
  };
}

function semanticWork(): ProgramSemanticWorkItemV1[] {
  return [{
    workItemId: dependencyId,
    creationOrder: 0,
    description: "Prepare dependency",
    dependencyIds: [],
    affectedPaths: ["src/a.ts"],
    workItemGeneration: 2,
    requirementState: "required",
    topologyState: "leaf",
    satisfactionState: "satisfied",
    parentWorkItemId: null,
    authorityEnvelope: envelope(),
  }, {
    workItemId: targetId,
    creationOrder: 1,
    description: "Execute target",
    dependencyIds: [dependencyId],
    affectedPaths: ["src/b.ts"],
    workItemGeneration: 4,
    requirementState: "required",
    topologyState: "leaf",
    satisfactionState: "pending",
    parentWorkItemId: null,
    authorityEnvelope: envelope(),
  }];
}

function semantic(): ProgramSemanticStateV1 {
  return {
    programStateId,
    currentRevision: {
      programRevisionId: revisionId,
      parentProgramRevisionId: null,
      ordinal: 1,
      changeClass: "initial",
      acceptedAtStateRevision: 5,
      admissionEventId: "operational-baseline-event",
      sourceDraftId: null,
      sourceDraftDigest: null,
    },
    workItems: semanticWork(),
    verification: [{
      obligationId: verificationId,
      predicate: { kind: "workspace_path_state", path: "src/b.ts", requiredState: "file" },
      freshnessScope: { kind: "workspace" },
      subjectGeneration: 2,
      satisfaction: null,
      waiver: null,
    }],
    verificationBindings: [{ obligationId: verificationId, subject: { kind: "program" } }],
    outputSlots: [],
    productionSteps: [],
  };
}

function rawState(revision = 6, verificationGeneration = 2): ProgramState {
  const raw = createProgramState({
    programStateId,
    sourceSessionId: sessionId,
    objective: "Operational overlay",
    workItems: [{
      workItemId: dependencyId,
      creationOrder: 0,
      description: "Prepare dependency",
      dependencyIds: [],
      affectedPaths: ["src/a.ts"],
    }, {
      workItemId: targetId,
      creationOrder: 1,
      description: "Execute target",
      dependencyIds: [dependencyId],
      affectedPaths: ["src/b.ts"],
    }],
    verification: [{
      obligationId: verificationId,
      predicate: { kind: "workspace_path_state", path: "src/b.ts", requiredState: "file" },
      freshnessScope: { kind: "workspace" },
    }],
    outputSlots: [],
    productionSteps: [],
  });
  return {
    ...raw,
    revision,
    verification: [{ ...raw.verification[0]!, subjectGeneration: verificationGeneration, satisfaction: null, waiver: null }],
  };
}

function attempt(): ProgramAttempt {
  const executionBase = {
    workspaceEffectGeneration: 3,
    observation: {
      kind: "workspace-observation-v1" as const,
      providerKind: "test",
      workspaceIdentity: "workspace-operational",
      coverageDigest: "coverage",
      stateDigest: "state",
    },
  };
  return {
    programAttemptId: attemptId,
    workItemId: targetId,
    sessionId,
    agentGeneration: 7,
    initialExecutionBase: executionBase,
    expectedExecutionBase: executionBase,
  };
}

function event(input: {
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  state?: ProgramState;
  producerComponent?: string;
}): PersistedDomainEvent<string, unknown> {
  return {
    sequence: input.sequence,
    eventId: `event-${input.sequence}`,
    workspaceId: "workspace-operational",
    sessionId: String(sessionId),
    programStateId: String(programStateId),
    occurredAt: "2026-08-27T00:00:00.000Z",
    type: input.type,
    payload: input.state === undefined ? input.payload : { state: input.state, ...input.payload },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: input.producerComponent ?? "test" },
  } as unknown as PersistedDomainEvent<string, unknown>;
}

function terminalBase() {
  return {
    workspaceEffectGeneration: 4,
    observation: {
      kind: "workspace-observation-v1" as const,
      providerKind: "test",
      workspaceIdentity: terminalWorkspaceId,
      coverageDigest: "terminal-coverage",
      stateDigest: "terminal-state",
    },
  };
}

function terminalRaw(completedWork: boolean, includeRetired = false): ProgramState {
  const raw = createProgramState({
    programStateId,
    sourceSessionId: sessionId,
    objective: "Adaptive terminal",
    workItems: [{
      workItemId: targetId,
      creationOrder: 0,
      description: "Finish adaptive work",
      dependencyIds: [],
      affectedPaths: ["src/terminal.ts"],
    }, ...(includeRetired ? [{
      workItemId: retiredId,
      creationOrder: 1,
      description: "Retired adaptive work",
      dependencyIds: [],
      affectedPaths: ["src/retired.ts"],
    }] : [])],
    verification: [],
    outputSlots: [],
    productionSteps: [],
  });
  return {
    ...raw,
    revision: 8,
    acceptedExecutionBase: terminalBase(),
    workItems: raw.workItems.map((work) => ({
      ...work,
      lifecycle: work.workItemId === targetId && completedWork ? "completed" as const : "pending" as const,
    })),
  };
}

function terminalCurrent(completedWork: boolean, includeRetired = false): ProgramSemanticCurrentSnapshotV1 {
  const terminalRevisionId = asProgramRevisionId("operational-terminal-r2");
  return {
    programStateRevision: 9,
    semanticState: {
      programStateId,
      currentRevision: {
        programRevisionId: terminalRevisionId,
        parentProgramRevisionId: revisionId,
        ordinal: 2,
        changeClass: "refinement",
        acceptedAtStateRevision: 9,
        admissionEventId: "terminal-semantic-event",
        sourceDraftId: "terminal-draft",
        sourceDraftDigest: "terminal-digest",
      },
      workItems: [{
        workItemId: targetId,
        creationOrder: 0,
        description: "Finish adaptive work",
        dependencyIds: [],
        affectedPaths: ["src/terminal.ts"],
        workItemGeneration: 2,
        requirementState: "required",
        topologyState: "leaf",
        satisfactionState: completedWork ? "satisfied" : "pending",
        parentWorkItemId: null,
        authorityEnvelope: {
          ...envelope(),
          objectiveBoundaryRef: {
            programStateId,
            rootProgramRevisionId: terminalRevisionId,
            anchorWorkItemId: targetId,
          },
        },
      }, ...(includeRetired ? [{
        workItemId: retiredId,
        creationOrder: 1,
        description: "Retired adaptive work",
        dependencyIds: [],
        affectedPaths: ["src/retired.ts"],
        workItemGeneration: 2,
        requirementState: "withdrawn" as const,
        topologyState: "leaf" as const,
        satisfactionState: "pending" as const,
        parentWorkItemId: null,
        authorityEnvelope: {
          ...envelope(),
          objectiveBoundaryRef: {
            programStateId,
            rootProgramRevisionId: terminalRevisionId,
            anchorWorkItemId: retiredId,
          },
        },
      }] : [])],
      verification: [],
      verificationBindings: [],
      outputSlots: [],
      productionSteps: [],
    },
    activeAttempt: null,
    lifecycle: "active",
    attachedSessionIds: [String(sessionId)],
  };
}

function terminalFixture(completedWork: boolean, includeRetired = false) {
  const events: PersistedDomainEvent<string, unknown>[] = [{
    sequence: 1,
    eventId: "terminal-created",
    workspaceId: terminalWorkspaceId,
    sessionId: String(sessionId),
    programStateId: String(programStateId),
    occurredAt: "2026-08-27T00:00:00.000Z",
    type: "program.created",
    payload: { state: terminalRaw(completedWork, includeRetired) },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "test" },
  } as unknown as PersistedDomainEvent<string, unknown>, {
    sequence: 2,
    eventId: "terminal-semantic-event",
    workspaceId: terminalWorkspaceId,
    sessionId: String(sessionId),
    programStateId: String(programStateId),
    occurredAt: "2026-08-27T00:00:00.500Z",
    type: "program.semantic_revision.admitted.v1",
    payload: {},
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "test" },
  } as unknown as PersistedDomainEvent<string, unknown>];
  const store = {
    workspaceId: terminalWorkspaceId,
    replay: async function* () { for (const item of events) yield item; },
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
  // Mirror the production WorkspaceEventStore descriptor that exposed the
  // prior Proxy invariant failure: replay is an exact, non-configurable method.
  Object.defineProperty(store, "replay", {
    value: store.replay,
    writable: false,
    configurable: false,
  });
  const current = terminalCurrent(completedWork, includeRetired);
  const service = new ProgramAdaptiveTerminalServiceV2({
    store,
    admission: new CanonicalAdmissionQueue(store),
    workspaceCoordinator: { runExclusive: async (work) => work() },
    observations: { observe: async () => ({ status: "complete" as const, base: terminalBase() }) },
    recovery: { isClear: () => true },
    artifactStore: { verify: async () => { throw new Error("no artifact verification expected"); } } as unknown as HostArtifactStore,
    currentState: { current: async () => structuredClone(current) },
  });
  return { events, service };
}

describe("A1 guarded adaptive operational currentness", () => {
  it("rejects a stale intermediate ProgramState even when a later adaptive snapshot advances", () => {
    const events = [
      event({ sequence: 10, type: "program.transitioned", state: rawState(5), payload: { transitionKind: "work.lifecycle.set" } }),
      event({
        sequence: 11,
        type: "program.transitioned",
        state: rawState(6),
        payload: { transitionKind: "attempt.issue" },
        producerComponent: "program-adaptive-admission-v2",
      }),
    ];
    expect(() => validatePostSemanticProgramStateSequenceV2(events, String(programStateId), 9, 5))
      .toThrow(ProgramAdaptiveOperationalOverlayErrorV2);
  });

  it("accepts new Attempt admission as the first exact post-semantic anchor", () => {
    const events = [event({
      sequence: 10,
      type: "program.transitioned",
      state: rawState(6),
      payload: { transitionKind: "attempt.issue" },
      producerComponent: "program-adaptive-admission-v2",
    })];
    expect(validatePostSemanticProgramStateSequenceV2(events, String(programStateId), 9, 5)?.state.revision).toBe(6);
  });

  it("accepts retained-Attempt progress as an exact materialization anchor", () => {
    const events = [event({
      sequence: 10,
      type: "program.transitioned",
      state: rawState(6),
      payload: { transitionKind: "evidence.add" },
      producerComponent: "program-adaptive-progress-v2",
    })];
    expect(validatePostSemanticProgramStateSequenceV2(events, String(programStateId), 9, 5)?.state.revision).toBe(6);
  });

  it("accepts in-flight mutation settlement after semantic invalidation as an exact anchor", () => {
    const events = [event({
      sequence: 10,
      type: "program.transitioned",
      state: rawState(6),
      payload: { transitionKind: "execution_base.unavailable" },
      producerComponent: "program-adaptive-settlement-v2",
    })];
    expect(validatePostSemanticProgramStateSequenceV2(events, String(programStateId), 9, 5)?.state.revision).toBe(6);
  });

  it("rejects a revision gap after an adaptive anchor", () => {
    const events = [
      event({
        sequence: 10,
        type: "program.transitioned",
        state: rawState(6),
        payload: { transitionKind: "evidence.add" },
        producerComponent: "program-adaptive-progress-v2",
      }),
      event({ sequence: 11, type: "program.transitioned", state: rawState(8), payload: { transitionKind: "work.lifecycle.set" } }),
    ];
    expect(() => validatePostSemanticProgramStateSequenceV2(events, String(programStateId), 9, 5))
      .toThrow("revision chain is not contiguous");
  });

  it("rejects verification proof older than the semantic subject but permits newer operational freshness", () => {
    expect(() => assertAdaptiveOperationalVerificationGenerationV2(semantic(), rawState(6, 1)))
      .toThrow("predates the current semantic generation");
    expect(() => assertAdaptiveOperationalVerificationGenerationV2(semantic(), rawState(6, 2))).not.toThrow();
    expect(() => assertAdaptiveOperationalVerificationGenerationV2(semantic(), rawState(6, 3))).not.toThrow();
  });

  it("derives exact issue-time generation, dependency, and envelope assumptions", () => {
    const assumptions = deriveAttemptSemanticAssumptionsV2(semantic(), attempt());
    expect(assumptions).toEqual({
      programAttemptId: attemptId,
      workItemId: targetId,
      workItemGeneration: 4,
      directDependencies: [{
        workItemId: dependencyId,
        workItemGeneration: 2,
        required: true,
        satisfiedOrDischargedAtIssue: true,
      }],
      workAuthorityEnvelope: envelope(),
    });
  });

  it("keeps semantic invalidation cumulative and unrelated revisions non-global", () => {
    const invalidated = [
      event({ sequence: 11, type: "program.semantic_revision.admitted.v1", payload: { cut: { revisionImpact: { invalidatedAttempts: [String(attemptId)] } } } }),
      event({ sequence: 12, type: "program.semantic_revision.admitted.v1", payload: { cut: { revisionImpact: { invalidatedAttempts: [] } } } }),
    ];
    expect(adaptiveAttemptInvalidatedAfterIssueV2(invalidated, String(programStateId), String(attemptId), 10)).toBe(true);
    const retained = [event({
      sequence: 11,
      type: "program.semantic_revision.admitted.v1",
      payload: { cut: { revisionImpact: { invalidatedAttempts: [], retainedAttempts: [String(attemptId)] } } },
    })];
    expect(adaptiveAttemptInvalidatedAfterIssueV2(retained, String(programStateId), String(attemptId), 10)).toBe(false);
  });

  it("materializes the exact semantic head before adaptive completion and trusts the terminal anchor", async () => {
    const fixture = terminalFixture(true);
    const result = await fixture.service.complete({
      programStateId: String(programStateId),
      expectedProgramRevision: 8,
      sessionId: sessionId as never,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("adaptive completion failed");
    expect(result.state.revision).toBe(10);
    const terminal = fixture.events.find((item) => item.type === "program.completed");
    expect(terminal?.producer).toEqual({ kind: "runtime", component: "program-adaptive-terminal-v2" });
    expect(validatePostSemanticProgramStateSequenceV2(
      fixture.events,
      String(programStateId),
      2,
      9,
    )?.state.lifecycle).toBe("completed");
  });

  it("does not let withdrawn unfinished work block adaptive terminal completion", async () => {
    const fixture = terminalFixture(true, true);
    const result = await fixture.service.complete({
      programStateId: String(programStateId),
      expectedProgramRevision: 8,
      sessionId: sessionId as never,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("adaptive completion failed");
    const retired = result.state.workItems.find((work) => work.workItemId === retiredId);
    expect(retired?.lifecycle).toBe("completed");
  });

  it("materializes the exact semantic head before adaptive cancellation and rejects the same legacy terminal event", async () => {
    const fixture = terminalFixture(false);
    const result = await fixture.service.cancel({
      programStateId: String(programStateId),
      expectedProgramRevision: 8,
      sessionId: sessionId as never,
      reason: "adaptive cancellation",
    });
    expect(result.state.revision).toBe(10);
    expect(result.state.lifecycle).toBe("cancelled");
    const terminal = fixture.events.find((item) => item.type === "program.cancelled");
    expect(terminal?.producer).toEqual({ kind: "runtime", component: "program-adaptive-terminal-v2" });
    expect(validatePostSemanticProgramStateSequenceV2(
      fixture.events,
      String(programStateId),
      2,
      9,
    )?.state.lifecycle).toBe("cancelled");

    const legacy = fixture.events.map((item) => item === terminal ? {
      ...item,
      producer: { kind: "runtime", component: "program-terminal" },
    } as PersistedDomainEvent<string, unknown> : item);
    expect(() => validatePostSemanticProgramStateSequenceV2(legacy, String(programStateId), 2, 9))
      .toThrow("not an exact adaptive materialization anchor");
  });
});
