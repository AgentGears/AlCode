import { describe, expect, it } from "vitest";
import { AGENT_PROTOCOL_VERSION } from "./messages.ts";
import { isAgentToHostMessage, isHostToAgentMessage } from "./validation.ts";
import {
  PROGRAM_EXECUTION_V2_CAPABILITY,
  PROGRAM_EXECUTION_V2_MESSAGE_VERSION,
  PROGRAM_REVISION_CAPABILITY,
  PROGRAM_STATE_V2_CAPABILITY,
  assertProgramV2CapabilityDependencies,
  isProgramAttemptAuthorityV2,
  isProgramAttemptExecuteV2,
  isProgramAttemptProjectionV2,
  isProgramProgressProposalV2,
  type ProgramAttemptAuthorityV2,
} from "./program-execution-v2.ts";

function authority(): ProgramAttemptAuthorityV2 {
  return {
    authorityVersion: 2,
    programStateId: "program-1",
    issuedUnderProgramRevisionId: "semantic-r1",
    programAttemptId: "attempt-1",
    workItemId: "work-b",
    workItemGeneration: 3,
    dependencyReceipt: {
      entries: [{
        workItemId: "work-a",
        workItemGeneration: 2,
        required: true,
        satisfiedOrDischargedAtIssue: true,
      }],
    },
    constraintReceipt: {
      workAuthorityEnvelope: {
        objectiveBoundaryRef: {
          programStateId: "program-1",
          rootProgramRevisionId: "semantic-r1",
          anchorWorkItemId: "work-b",
        },
        allowedRepositoryRoots: ["."],
        allowedEffectClasses: ["fs.read", "fs.write"],
        allowedExternalSystems: [],
        capabilityCeiling: ["edit", "read"],
        maximumTopologyExpansion: 8,
        mandatoryVerificationIds: [],
        forbiddenChangeKinds: ["delete_repository"],
      },
      mandatoryConstraintIds: [],
    },
    agentGeneration: 4,
  };
}

function execute() {
  return {
    type: "program.attempt.execute" as const,
    version: PROGRAM_EXECUTION_V2_MESSAGE_VERSION,
    requestId: "execute-1",
    sessionId: "session-1",
    authority: authority(),
  };
}

function progress() {
  return {
    type: "program.progress" as const,
    version: PROGRAM_EXECUTION_V2_MESSAGE_VERSION,
    requestId: "progress-1",
    sessionId: "session-1",
    authority: authority(),
    evidence: [],
    advisoryBlockers: [],
    requestAwaitingVerification: true,
  };
}

function projection() {
  return {
    version: 2,
    authority: authority(),
    objective: "Ship the adaptive Program",
    work: {
      description: "Implement work B",
      requirementState: "required",
      topologyState: "leaf",
      satisfactionState: "active",
      dependencyIds: ["work-a"],
      affectedPaths: ["src/b.ts"],
      omittedAffectedPathCount: 0,
    },
    dependencies: [{
      workItemId: "work-a",
      workItemGeneration: 2,
      requirementState: "required",
      satisfiedOrDischarged: true,
    }],
    executionBase: {
      workspaceEffectGeneration: 5,
      observation: {
        kind: "workspace-observation-v1",
        providerKind: "git",
        workspaceIdentity: "workspace-1",
        coverageDigest: "coverage-1",
        stateDigest: "state-1",
      },
    },
    blockers: [],
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

describe("A1 Program execution V2 protocol", () => {
  it("keeps the base protocol at v1 and makes A1 capabilities additive", () => {
    expect(AGENT_PROTOCOL_VERSION).toBe(1);
    expect(() => assertProgramV2CapabilityDependencies([
      PROGRAM_STATE_V2_CAPABILITY,
      PROGRAM_EXECUTION_V2_CAPABILITY,
      PROGRAM_REVISION_CAPABILITY,
    ])).not.toThrow();
    expect(() => assertProgramV2CapabilityDependencies([PROGRAM_EXECUTION_V2_CAPABILITY]))
      .toThrow(`${PROGRAM_EXECUTION_V2_CAPABILITY} requires ${PROGRAM_STATE_V2_CAPABILITY}`);
    expect(() => assertProgramV2CapabilityDependencies([PROGRAM_REVISION_CAPABILITY]))
      .toThrow(`${PROGRAM_REVISION_CAPABILITY} requires ${PROGRAM_STATE_V2_CAPABILITY}`);
  });

  it("accepts only the exact V2 authority shape", () => {
    expect(isProgramAttemptAuthorityV2(authority())).toBe(true);
    expect(isProgramAttemptAuthorityV2({ ...authority(), expectedProgramRevision: 7 })).toBe(false);
    expect(isProgramAttemptAuthorityV2({ ...authority(), authorityVersion: 1 })).toBe(false);
    expect(isProgramAttemptAuthorityV2({
      ...authority(),
      dependencyReceipt: {
        entries: [
          { workItemId: "work-z", workItemGeneration: 1, required: true, satisfiedOrDischargedAtIssue: true },
          { workItemId: "work-a", workItemGeneration: 1, required: true, satisfiedOrDischargedAtIssue: true },
        ],
      },
    })).toBe(false);
  });

  it("discriminates V2 execute/progress while legacy global transport remains V1-only", () => {
    expect(isProgramAttemptExecuteV2(execute())).toBe(true);
    expect(isProgramAttemptExecuteV2({ ...execute(), version: 1 })).toBe(false);
    expect(isProgramProgressProposalV2(progress())).toBe(true);
    expect(isProgramProgressProposalV2({ ...progress(), authority: {
      programStateId: "program-1",
      expectedProgramRevision: 3,
      programAttemptId: "attempt-1",
      workItemId: "work-b",
      agentGeneration: 4,
    } })).toBe(false);

    expect(isHostToAgentMessage(execute())).toBe(false);
    expect(isAgentToHostMessage(progress())).toBe(false);
  });

  it("requires the whole bounded V2 projection envelope and exact dependency receipt agreement", () => {
    const value = projection();
    expect(isProgramAttemptProjectionV2(value)).toBe(true);
    expect(isProgramAttemptProjectionV2({
      ...value,
      dependencies: [{ ...value.dependencies[0], workItemGeneration: 3 }],
    })).toBe(false);
    const { control: _control, ...missingControl } = value;
    expect(isProgramAttemptProjectionV2(missingControl)).toBe(false);
    expect(isProgramAttemptProjectionV2({
      ...value,
      executionBase: { workspaceEffectGeneration: -1, observation: value.executionBase.observation },
    })).toBe(false);
  });
});
