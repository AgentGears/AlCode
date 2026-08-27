import { describe, expect, it } from "vitest";
import {
  asProgramAttemptId,
  asProgramRevisionId,
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  asVerificationObligationId,
  createProgramState,
  type ProgramSemanticStateV1,
  type ProgramState,
  type WorkAuthorityEnvelopeV1,
} from "@alcode/program-state";
import {
  materializeAdaptiveOperationalProgramStateV2,
} from "./program-adaptive-admission-v2.ts";
import type { ProgramSemanticCurrentSnapshotV1 } from "./program-revision.ts";

const programStateId = asProgramStateId("018f0000-0000-7000-8000-000000000981");
const sessionId = asSessionId("018f0000-0000-4000-8000-000000000982");
const workId = asProgramWorkItemId("admission-work");
const attemptId = asProgramAttemptId("admission-old-attempt");
const revisionId = asProgramRevisionId("admission-r2");
const verificationId = asVerificationObligationId("admission-verification");

function envelope(): WorkAuthorityEnvelopeV1 {
  return {
    objectiveBoundaryRef: {
      programStateId,
      rootProgramRevisionId: revisionId,
      anchorWorkItemId: workId,
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

function executionBase(workspaceEffectGeneration = 4) {
  return {
    workspaceEffectGeneration,
    observation: {
      kind: "workspace-observation-v1" as const,
      providerKind: "test",
      workspaceIdentity: "workspace-admission",
      coverageDigest: "coverage",
      stateDigest: `state-${workspaceEffectGeneration}`,
    },
  };
}

function rawState(): ProgramState {
  const raw = createProgramState({
    programStateId,
    sourceSessionId: sessionId,
    objective: "Adaptive admission",
    workItems: [{
      workItemId: workId,
      creationOrder: 0,
      description: "Execute adaptive work",
      dependencyIds: [],
      affectedPaths: ["src/a.ts"],
    }],
    verification: [{
      obligationId: verificationId,
      predicate: {
        kind: "workspace_path_state",
        path: "src/a.ts",
        requiredState: "file",
      },
      freshnessScope: { kind: "workspace" },
    }],
    outputSlots: [],
    productionSteps: [],
  });
  const base = executionBase(3);
  return {
    ...raw,
    revision: 8,
    acceptedExecutionBase: base,
    workItems: [{ ...raw.workItems[0]!, lifecycle: "completed" }],
    verification: [{
      ...raw.verification[0]!,
      subjectGeneration: 1,
      satisfaction: null,
      waiver: null,
    }],
    activeAttempt: {
      programAttemptId: attemptId,
      workItemId: workId,
      sessionId,
      agentGeneration: 4,
      initialExecutionBase: base,
      expectedExecutionBase: base,
    },
  };
}

function semanticState(): ProgramSemanticStateV1 {
  return {
    programStateId,
    currentRevision: {
      programRevisionId: revisionId,
      parentProgramRevisionId: asProgramRevisionId("admission-r1"),
      ordinal: 2,
      changeClass: "correction",
      acceptedAtStateRevision: 9,
      admissionEventId: "admission-r2-event",
      sourceDraftId: "admission-r2-draft",
      sourceDraftDigest: "digest",
    },
    workItems: [{
      workItemId: workId,
      creationOrder: 0,
      description: "Execute adaptive work",
      dependencyIds: [],
      affectedPaths: ["src/a.ts"],
      workItemGeneration: 2,
      requirementState: "required",
      topologyState: "leaf",
      satisfactionState: "pending",
      parentWorkItemId: null,
      authorityEnvelope: envelope(),
    }],
    verification: [{
      obligationId: verificationId,
      predicate: {
        kind: "workspace_path_state",
        path: "src/a.ts",
        requiredState: "file",
      },
      freshnessScope: { kind: "workspace" },
      subjectGeneration: 2,
      satisfaction: null,
      waiver: null,
    }],
    verificationBindings: [{
      obligationId: verificationId,
      subject: {
        kind: "work_item",
        workItemId: workId,
        workItemGeneration: 2,
      },
    }],
    outputSlots: [],
    productionSteps: [],
  };
}

function current(): ProgramSemanticCurrentSnapshotV1 {
  return {
    programStateRevision: 9,
    semanticState: semanticState(),
    activeAttempt: null,
    lifecycle: "active",
    attachedSessionIds: [String(sessionId)],
  };
}

describe("A1 adaptive Attempt admission materialization", () => {
  it("materializes current semantic work instead of resurrecting an invalidated prior generation", () => {
    const next = materializeAdaptiveOperationalProgramStateV2(rawState(), current(), executionBase(4));
    expect(next.revision).toBe(9);
    expect(next.activeAttempt).toBeNull();
    expect(next.workItems).toEqual([
      expect.objectContaining({
        workItemId: workId,
        lifecycle: "pending",
      }),
    ]);
    expect(next.acceptedExecutionBase).toEqual(executionBase(4));
  });

  it("materializes the current verification generation and clears stale raw semantics", () => {
    const next = materializeAdaptiveOperationalProgramStateV2(rawState(), current(), executionBase(4));
    expect(next.verification).toEqual([
      expect.objectContaining({
        obligationId: verificationId,
        subjectGeneration: 2,
        satisfaction: null,
        waiver: null,
      }),
    ]);
  });
});
