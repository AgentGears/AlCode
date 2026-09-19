import { describe, expect, it } from "vitest";
import type { ProgramAttemptExecutionBaseV1 } from "./messages.ts";
import {
  isProgramAttemptProjectionV2,
  type ProgramAttemptAuthorityV2,
  type ProgramAttemptProjectionV2,
} from "./program-execution-v2.ts";

function authority(): ProgramAttemptAuthorityV2 {
  return {
    authorityVersion: 2,
    programStateId: "program-a5",
    issuedUnderProgramRevisionId: "revision-a5",
    programAttemptId: "attempt-a5",
    workItemId: "work-a5",
    workItemGeneration: 1,
    dependencyReceipt: { entries: [] },
    constraintReceipt: {
      workAuthorityEnvelope: {
        objectiveBoundaryRef: {
          programStateId: "program-a5",
          rootProgramRevisionId: "revision-a5",
          anchorWorkItemId: "work-a5",
        },
        allowedRepositoryRoots: ["."],
        allowedEffectClasses: ["fs.write"],
        allowedExternalSystems: [],
        capabilityCeiling: ["edit"],
        maximumTopologyExpansion: 0,
        mandatoryVerificationIds: [],
        forbiddenChangeKinds: [],
      },
      mandatoryConstraintIds: [],
    },
    agentGeneration: 1,
  };
}

function executionBase(): ProgramAttemptExecutionBaseV1 {
  return {
    workspaceEffectGeneration: 7,
    observation: {
      kind: "workspace-observation-v1",
      providerKind: "execution-world",
      workspaceIdentity: "workspace-a5",
      coverageDigest: "coverage-a5",
      stateDigest: "state-a5",
      executionWorld: {
        workspaceId: "workspace-a5",
        providerKind: "local",
        executionWorldGenerationId: "world-g0",
        providerDescriptorDigest: "provider-digest",
        effectivePolicyDigest: "policy-digest",
      },
    },
  };
}

function projection(base: ProgramAttemptExecutionBaseV1 = executionBase()): ProgramAttemptProjectionV2 {
  return {
    version: 2,
    authority: authority(),
    objective: "Preserve the exact A5 execution world across the Agent protocol boundary",
    work: {
      description: "Perform world-bound work",
      requirementState: "required",
      topologyState: "leaf",
      satisfactionState: "active",
      dependencyIds: [],
      affectedPaths: ["src/value.ts"],
      omittedAffectedPathCount: 0,
    },
    dependencies: [],
    blockers: [],
    executionBase: base,
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

describe("A5 Program execution-world protocol projection", () => {
  it("preserves the exact execution-world generation identity in a valid V2 Attempt projection", () => {
    const value = projection();
    expect(isProgramAttemptProjectionV2(value)).toBe(true);
    expect(value.executionBase.observation.executionWorld).toEqual({
      workspaceId: "workspace-a5",
      providerKind: "local",
      executionWorldGenerationId: "world-g0",
      providerDescriptorDigest: "provider-digest",
      effectivePolicyDigest: "policy-digest",
    });
  });

  it("rejects malformed or widened execution-world evidence instead of accepting ambiguous provenance", () => {
    const missingDigest = structuredClone(projection()) as unknown as Record<string, unknown>;
    const missingExecutionBase = missingDigest.executionBase as Record<string, unknown>;
    const missingObservation = missingExecutionBase.observation as Record<string, unknown>;
    const missingWorld = missingObservation.executionWorld as Record<string, unknown>;
    delete missingWorld.effectivePolicyDigest;
    expect(isProgramAttemptProjectionV2(missingDigest)).toBe(false);

    const widened = structuredClone(projection()) as unknown as Record<string, unknown>;
    const widenedExecutionBase = widened.executionBase as Record<string, unknown>;
    const widenedObservation = widenedExecutionBase.observation as Record<string, unknown>;
    const widenedWorld = widenedObservation.executionWorld as Record<string, unknown>;
    widenedWorld.unexpected = "not-canonical";
    expect(isProgramAttemptProjectionV2(widened)).toBe(false);
  });
});
