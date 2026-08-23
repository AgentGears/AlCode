import { describe, expect, it } from "vitest";
import type { ProgramAttemptProjectionV1 } from "@alcode/agent-protocol";
import {
  PROGRAM_EXECUTION_PROMPT,
  renderProgramAttemptContext,
} from "./program-attempt-context.ts";

function projection(): ProgramAttemptProjectionV1 {
  return {
    version: 1,
    authority: {
      programStateId: "program-1",
      expectedProgramRevision: 4,
      programAttemptId: "attempt-2",
      workItemId: "work-1",
      agentGeneration: 3,
    },
    objective: "Fix the failing implementation",
    work: {
      description: "Correct the implementation",
      lifecycle: "in_progress",
      dependencyIds: [],
      affectedPaths: ["src/index.ts"],
      omittedAffectedPathCount: 0,
    },
    dependencies: [],
    blockers: [],
    executionBase: {
      workspaceEffectGeneration: 1,
      observation: {
        kind: "workspace-observation-v1",
        providerKind: "test",
        workspaceIdentity: "workspace-1",
        coverageDigest: "coverage-1",
        stateDigest: "state-1",
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

describe("ProgramAttempt refreshed inference context", () => {
  it("keeps the Host execution directive in refreshed system context", () => {
    const rendered = renderProgramAttemptContext("base-system", projection(), true);
    expect(rendered).toContain("attempt-2");
    expect(rendered).toContain(PROGRAM_EXECUTION_PROMPT);
    expect(rendered).toContain("valid only while the exact Host-projected Attempt remains current");
  });

  it("does not add an execution directive for a non-execution refresh", () => {
    const rendered = renderProgramAttemptContext("base-system", projection(), false);
    expect(rendered).toContain("attempt-2");
    expect(rendered).not.toContain(PROGRAM_EXECUTION_PROMPT);
  });
});
