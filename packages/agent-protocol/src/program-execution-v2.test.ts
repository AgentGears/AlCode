import { describe, expect, it } from "vitest";
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

describe("A1 Program execution V2 protocol", () => {
  it("keeps A1 capabilities additive and enforces their dependencies", () => {
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

  it("discriminates V2 execute and progress messages by message version", () => {
    const execute = {
      type: "program.attempt.execute",
      version: PROGRAM_EXECUTION_V2_MESSAGE_VERSION,
      requestId: "execute-1",
      sessionId: "session-1",
      authority: authority(),
    };
    expect(isProgramAttemptExecuteV2(execute)).toBe(true);
    expect(isProgramAttemptExecuteV2({ ...execute, version: 1 })).toBe(false);

    const progress = {
      type: "program.progress",
      version: PROGRAM_EXECUTION_V2_MESSAGE_VERSION,
      requestId: "progress-1",
      sessionId: "session-1",
      authority: authority(),
      evidence: [],
      advisoryBlockers: [],
      requestAwaitingVerification: true,
    };
    expect(isProgramProgressProposalV2(progress)).toBe(true);
    expect(isProgramProgressProposalV2({ ...progress, authority: {
      programStateId: "program-1",
      expectedProgramRevision: 3,
      programAttemptId: "attempt-1",
      workItemId: "work-b",
      agentGeneration: 4,
    } })).toBe(false);
  });

  it("requires the V2 projection to agree exactly with its authority dependency receipt", () => {
    const projection = {
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
      executionBase: {},
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
    expect(isProgramAttemptProjectionV2(projection)).toBe(true);
    expect(isProgramAttemptProjectionV2({
      ...projection,
      dependencies: [{ ...projection.dependencies[0], workItemGeneration: 3 }],
    })).toBe(false);
  });
});
