import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ProgramAttemptProjectionV1 } from "@alcode/agent-protocol";
import {
  asProgramAttemptId,
  asProgramRevisionId,
  asProgramStateId,
  asProgramWorkItemId,
  type ProgramSemanticStateV1,
  type WorkAuthorityEnvelopeV1,
} from "@alcode/program-state";
import { issueProgramAttemptAuthorityV2 } from "./program-attempt-authority-v2.ts";
import type { ProgramRootOperationAuthorityV1 } from "./program-dispatch.ts";
import { ProgramAdaptiveOperationalCurrentStateSourceV2 } from "./program-adaptive-operational-v2.ts";
import {
  ProgramAdaptiveProductionCompositionErrorV1,
  ProgramAdaptiveProductionCutSourceV1,
} from "./program-adaptive-production-v1.ts";

const sessionId = "018f0000-0000-7000-8000-000000000c01";
const programStateId = asProgramStateId("018f0000-0000-7000-8000-000000000c02");
const dependencyId = asProgramWorkItemId("adaptive-production-dependency");
const workItemId = asProgramWorkItemId("adaptive-production-work");
const attemptId = asProgramAttemptId("adaptive-production-attempt");
const revisionId = asProgramRevisionId("adaptive-production-r7");

function envelope(): WorkAuthorityEnvelopeV1 {
  return {
    objectiveBoundaryRef: {
      programStateId,
      rootProgramRevisionId: revisionId,
      anchorWorkItemId: workItemId,
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

function semanticState(): ProgramSemanticStateV1 {
  return {
    programStateId,
    currentRevision: {
      programRevisionId: revisionId,
      parentProgramRevisionId: asProgramRevisionId("adaptive-production-r6"),
      ordinal: 7,
      changeClass: "refinement",
      acceptedAtStateRevision: 37,
      admissionEventId: "semantic-admission-7",
      sourceDraftId: "semantic-draft-7",
      sourceDraftDigest: "semantic-digest-7",
    },
    workItems: [
      {
        workItemId: dependencyId,
        creationOrder: 0,
        description: "Current completed dependency",
        dependencyIds: [],
        affectedPaths: ["src/dependency.ts"],
        workItemGeneration: 3,
        requirementState: "required",
        topologyState: "leaf",
        satisfactionState: "satisfied",
        parentWorkItemId: null,
        authorityEnvelope: envelope(),
      },
      {
        workItemId,
        creationOrder: 1,
        description: "Current semantic target",
        dependencyIds: [dependencyId],
        affectedPaths: ["src/current.ts"],
        workItemGeneration: 4,
        requirementState: "required",
        topologyState: "leaf",
        satisfactionState: "active",
        parentWorkItemId: null,
        authorityEnvelope: envelope(),
      },
    ],
    verification: [],
    verificationBindings: [],
    outputSlots: [],
    productionSteps: [],
  };
}

function semanticSnapshot() {
  return {
    programStateRevision: 37,
    semanticState: semanticState(),
    activeAttempt: {
      programAttemptId: attemptId,
      workItemId,
      workItemGeneration: 4,
      directDependencies: [{
        workItemId: dependencyId,
        workItemGeneration: 3,
        satisfiedOrDischargedAtIssue: true as const,
      }],
      workAuthorityEnvelope: envelope(),
    },
    lifecycle: "active" as const,
    attachedSessionIds: [sessionId],
  };
}

function legacyProjection(): ProgramAttemptProjectionV1 {
  return {
    version: 1,
    authority: {
      programStateId: String(programStateId),
      expectedProgramRevision: 21,
      programAttemptId: String(attemptId),
      workItemId: String(workItemId),
      agentGeneration: 9,
    },
    objective: "Adaptive production objective",
    work: {
      description: "Legacy operational description",
      lifecycle: "in_progress",
      dependencyIds: [String(dependencyId)],
      affectedPaths: ["src/current.ts"],
      omittedAffectedPathCount: 0,
    },
    dependencies: [{ workItemId: String(dependencyId), lifecycle: "completed" }],
    blockers: [],
    executionBase: {
      workspaceEffectGeneration: 2,
      observation: {
        kind: "workspace-observation-v1",
        providerKind: "git",
        workspaceIdentity: "workspace-adaptive-production",
        coverageDigest: "coverage-2",
        stateDigest: "state-2",
      },
    },
    verification: [],
    outputSlots: [],
    productionSteps: [],
    decisiveEvidence: [],
    artifacts: [],
    control: { executionBaseMismatch: false, executionBaseUnavailable: false },
    omissions: { verification: 0, blockers: 0, evidence: 0, artifacts: 0 },
    stopConditions: {
      attemptMustRemainCurrent: true,
      rebaseRequiredOnExecutionBaseMismatch: true,
      hostOwnsVerificationAndCompletion: true,
    },
  };
}

const coordinator = {
  async runExclusive<T>(work: () => Promise<T>): Promise<T> { return work(); },
};

function cutSource(overrides: { operationAttemptId?: string } = {}) {
  const semantic = {
    currentForSession: async () => structuredClone(semanticSnapshot()),
  } as unknown as ProgramAdaptiveOperationalCurrentStateSourceV2;
  const operations = {
    resolveCurrentOperation: async () => ({
      programStateId: String(programStateId),
      expectedProgramRevision: 21,
      programAttemptId: overrides.operationAttemptId ?? String(attemptId),
      workItemId: String(workItemId),
      agentGeneration: 9,
    }),
  } as unknown as ProgramRootOperationAuthorityV1;
  return new ProgramAdaptiveProductionCutSourceV1({
    workspaceCoordinator: coordinator,
    semantic,
    operational: {
      currentForSession: async () => ({
        hasActiveAttachedExecutionEpisode: true,
        workspaceReservationAvailable: true,
        recoveryClear: true,
        writerBarriersClear: true,
        quiescenceClear: true,
        executionBaseCurrent: true,
        openCanonicalBlockers: [],
      }),
    },
    agents: {
      currentAttemptProjection: async () => legacyProjection(),
      isCurrentConnection: () => true,
      currentAgentGeneration: () => 9,
    },
    operations,
  });
}

describe("A1 production adaptive runtime composition", () => {
  it("builds V2 authority from semantic generations while preserving the independent operational CAS lease", async () => {
    const cut = await cutSource().currentForSession(sessionId, "connection-9");
    expect(cut).toBeDefined();
    expect(cut!.operationalProgramContext.expectedProgramRevision).toBe(21);
    expect(cut!.facts.semantic.programStateRevision).toBe(37);
    expect(cut!.projection.work).toMatchObject({
      description: "Current semantic target",
      satisfactionState: "active",
      dependencyIds: [String(dependencyId)],
    });
    expect(cut!.projection.dependencies).toEqual([{
      workItemId: String(dependencyId),
      workItemGeneration: 3,
      requirementState: "required",
      satisfiedOrDischarged: true,
    }]);

    const authority = issueProgramAttemptAuthorityV2(cut!.facts);
    expect(authority).toMatchObject({
      issuedUnderProgramRevisionId: String(revisionId),
      programAttemptId: String(attemptId),
      workItemId: String(workItemId),
      workItemGeneration: 4,
      agentGeneration: 9,
    });
    expect(authority.dependencyReceipt.entries).toEqual([{
      workItemId: String(dependencyId),
      workItemGeneration: 3,
      required: true,
      satisfiedOrDischargedAtIssue: true,
    }]);
  });

  it("fails closed when raw operational ownership disagrees with semantic Attempt identity", async () => {
    await expect(cutSource({ operationAttemptId: "different-attempt" })
      .currentForSession(sessionId, "connection-9"))
      .rejects.toBeInstanceOf(ProgramAdaptiveProductionCompositionErrorV1);
  });

  it("composes around the existing V1 Host and installs a delegating adaptive operation authority", () => {
    const source = readFileSync(new URL("./program-adaptive-production-v1.ts", import.meta.url), "utf8");
    expect(source).not.toContain("new HostRuntime(");
    expect(source).toContain("fixed.host.setProgramOperationAuthority(operationAuthority);");
    expect(source).toContain("delegate: fixed.dispatch");
    expect(source).toContain("adoption: baseline");
    expect(source).toContain("attemptHistory: currentState");
    expect(source).not.toContain("revision === 1");
  });
});
