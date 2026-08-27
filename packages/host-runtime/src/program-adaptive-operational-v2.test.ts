import { describe, expect, it } from "vitest";
import type { PersistedDomainEvent } from "@alcode/events";
import {
  asProgramAttemptId,
  asProgramRevisionId,
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  createProgramState,
  type ProgramAttempt,
  type ProgramSemanticStateV1,
  type ProgramSemanticWorkItemV1,
  type WorkAuthorityEnvelopeV1,
} from "@alcode/program-state";
import {
  ProgramAdaptiveOperationalOverlayErrorV2,
  adaptiveAttemptInvalidatedAfterIssueV2,
  deriveAttemptSemanticAssumptionsV2,
  overlayAdaptiveSemanticOperationalFieldsV2,
} from "./program-adaptive-operational-v2.ts";

const programStateId = asProgramStateId("018f0000-0000-7000-8000-000000000971");
const sessionId = asSessionId("018f0000-0000-4000-8000-000000000972");
const dependencyId = asProgramWorkItemId("operational-dependency");
const targetId = asProgramWorkItemId("operational-target");
const attemptId = asProgramAttemptId("operational-attempt");
const revisionId = asProgramRevisionId("operational-r1");

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
    satisfactionState: "active",
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
    verification: [],
    verificationBindings: [],
    outputSlots: [],
    productionSteps: [],
  };
}

function rawState() {
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
    verification: [],
    outputSlots: [],
    productionSteps: [],
  });
  return {
    ...raw,
    revision: 6,
    workItems: raw.workItems.map((work) => ({
      ...work,
      lifecycle: work.workItemId === dependencyId ? "completed" as const : "awaiting_verification" as const,
    })),
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
  payload: unknown;
}): PersistedDomainEvent<string, unknown> {
  return {
    sequence: input.sequence,
    eventId: `event-${input.sequence}`,
    workspaceId: "workspace-operational",
    sessionId: String(sessionId),
    programStateId: String(programStateId),
    occurredAt: "2026-08-27T00:00:00.000Z",
    type: input.type,
    payload: input.payload,
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "test" },
  } as unknown as PersistedDomainEvent<string, unknown>;
}

describe("A1 adaptive operational overlay", () => {
  it("projects post-semantic operational lifecycle without changing semantic generations", () => {
    const projected = overlayAdaptiveSemanticOperationalFieldsV2(semantic(), rawState(), true);
    expect(projected.workItems[0]?.workItemGeneration).toBe(2);
    expect(projected.workItems[0]?.satisfactionState).toBe("satisfied");
    expect(projected.workItems[1]?.workItemGeneration).toBe(4);
    expect(projected.workItems[1]?.satisfactionState).toBe("awaiting_verification");
  });

  it("does not overlay a pre-head operational snapshot", () => {
    const projected = overlayAdaptiveSemanticOperationalFieldsV2(semantic(), rawState(), false);
    expect(projected.workItems[1]?.satisfactionState).toBe("active");
  });

  it("fails closed when a post-head operational snapshot carries stale semantic structure", () => {
    const raw = rawState();
    raw.workItems[1] = { ...raw.workItems[1]!, description: "stale target" };
    expect(() => overlayAdaptiveSemanticOperationalFieldsV2(semantic(), raw, true))
      .toThrow(ProgramAdaptiveOperationalOverlayErrorV2);
  });

  it("derives exact issue-time generation, dependency, and envelope assumptions", () => {
    const issueState = semantic();
    issueState.workItems[1] = { ...issueState.workItems[1]!, satisfactionState: "pending" };
    const assumptions = deriveAttemptSemanticAssumptionsV2(issueState, attempt());
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

  it("records semantic invalidation cumulatively across later retained revisions", () => {
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
