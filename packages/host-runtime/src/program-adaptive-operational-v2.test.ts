import { describe, expect, it } from "vitest";
import type { PersistedDomainEvent } from "@alcode/events";
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
import {
  ProgramAdaptiveOperationalOverlayErrorV2,
  adaptiveAttemptInvalidatedAfterIssueV2,
  assertAdaptiveOperationalVerificationGenerationV2,
  deriveAttemptSemanticAssumptionsV2,
  validatePostSemanticProgramStateSequenceV2,
} from "./program-adaptive-operational-v2.ts";

const programStateId = asProgramStateId("018f0000-0000-7000-8000-000000000971");
const sessionId = asSessionId("018f0000-0000-4000-8000-000000000972");
const dependencyId = asProgramWorkItemId("operational-dependency");
const targetId = asProgramWorkItemId("operational-target");
const attemptId = asProgramAttemptId("operational-attempt");
const revisionId = asProgramRevisionId("operational-r1");
const verificationId = asVerificationObligationId("operational-verification");

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
      predicate: {
        kind: "workspace_path_state",
        path: "src/b.ts",
        requiredState: "file",
      },
      freshnessScope: { kind: "workspace" },
      subjectGeneration: 2,
      satisfaction: null,
      waiver: null,
    }],
    verificationBindings: [{
      obligationId: verificationId,
      subject: { kind: "program" },
    }],
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
      predicate: {
        kind: "workspace_path_state",
        path: "src/b.ts",
        requiredState: "file",
      },
      freshnessScope: { kind: "workspace" },
    }],
    outputSlots: [],
    productionSteps: [],
  });
  return {
    ...raw,
    revision,
    verification: [{
      ...raw.verification[0]!,
      subjectGeneration: verificationGeneration,
      satisfaction: null,
      waiver: null,
    }],
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
  const payload = input.state === undefined
    ? input.payload
    : { state: input.state, ...input.payload };
  return {
    sequence: input.sequence,
    eventId: `event-${input.sequence}`,
    workspaceId: "workspace-operational",
    sessionId: String(sessionId),
    programStateId: String(programStateId),
    occurredAt: "2026-08-27T00:00:00.000Z",
    type: input.type,
    payload,
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: input.producerComponent ?? "test" },
  } as unknown as PersistedDomainEvent<string, unknown>;
}

describe("A1 guarded adaptive operational currentness", () => {
  it("rejects a stale intermediate ProgramState even when a later snapshot advances", () => {
    const events = [
      event({
        sequence: 10,
        type: "program.transitioned",
        state: rawState(5),
        payload: { transitionKind: "work.lifecycle.set" },
      }),
      event({
        sequence: 11,
        type: "program.transitioned",
        state: rawState(6),
        payload: { transitionKind: "attempt.issue" },
        producerComponent: "program-adaptive-admission-v2",
      }),
    ];
    expect(() => validatePostSemanticProgramStateSequenceV2(
      events,
      String(programStateId),
      9,
      5,
    )).toThrow(ProgramAdaptiveOperationalOverlayErrorV2);
  });

  it("accepts an exact adaptive admission anchor followed by a contiguous chain", () => {
    const events = [
      event({
        sequence: 10,
        type: "program.transitioned",
        state: rawState(6),
        payload: { transitionKind: "attempt.issue" },
        producerComponent: "program-adaptive-admission-v2",
      }),
      event({
        sequence: 11,
        type: "program.transitioned",
        state: rawState(7),
        payload: { transitionKind: "work.lifecycle.set" },
      }),
    ];
    expect(validatePostSemanticProgramStateSequenceV2(
      events,
      String(programStateId),
      9,
      5,
    )?.state.revision).toBe(7);
  });

  it("rejects a revision gap after the adaptive anchor", () => {
    const events = [
      event({
        sequence: 10,
        type: "program.transitioned",
        state: rawState(6),
        payload: { transitionKind: "attempt.issue" },
        producerComponent: "program-adaptive-admission-v2",
      }),
      event({
        sequence: 11,
        type: "program.transitioned",
        state: rawState(8),
        payload: { transitionKind: "work.lifecycle.set" },
      }),
    ];
    expect(() => validatePostSemanticProgramStateSequenceV2(
      events,
      String(programStateId),
      9,
      5,
    )).toThrow("revision chain is not contiguous");
  });

  it("rejects verification proof older than the semantic subject but permits newer operational freshness", () => {
    expect(() => assertAdaptiveOperationalVerificationGenerationV2(
      semantic(),
      rawState(6, 1),
    )).toThrow("predates the current semantic generation");
    expect(() => assertAdaptiveOperationalVerificationGenerationV2(
      semantic(),
      rawState(6, 2),
    )).not.toThrow();
    expect(() => assertAdaptiveOperationalVerificationGenerationV2(
      semantic(),
      rawState(6, 3),
    )).not.toThrow();
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

  it("records semantic invalidation cumulatively across later revisions", () => {
    const events = [
      event({ sequence: 10, type: "program.transitioned", payload: { transitionKind: "attempt.issue" } }),
      event({
        sequence: 11,
        type: "program.semantic_revision.admitted.v1",
        payload: { cut: { revisionImpact: { invalidatedAttempts: [String(attemptId)] } } },
      }),
      event({
        sequence: 12,
        type: "program.semantic_revision.admitted.v1",
        payload: { cut: { revisionImpact: { invalidatedAttempts: [], retainedAttempts: [] } } },
      }),
    ];
    expect(adaptiveAttemptInvalidatedAfterIssueV2(
      events,
      String(programStateId),
      String(attemptId),
      10,
    )).toBe(true);
  });

  it("does not treat an unrelated later semantic revision as global Attempt staleness", () => {
    const events = [event({
      sequence: 11,
      type: "program.semantic_revision.admitted.v1",
      payload: { cut: { revisionImpact: { invalidatedAttempts: [], retainedAttempts: [String(attemptId)] } } },
    })];
    expect(adaptiveAttemptInvalidatedAfterIssueV2(
      events,
      String(programStateId),
      String(attemptId),
      10,
    )).toBe(false);
  });
});
