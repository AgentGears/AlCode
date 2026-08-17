import { describe, expect, it } from "vitest";
import {
  PROGRAM_STATE_CAPABILITY,
  isAgentToHostMessage,
  isHostToAgentMessage,
} from "./index.ts";

function projection() {
  return {
    version: 1 as const,
    authority: {
      programStateId: "program-1",
      expectedProgramRevision: 4,
      programAttemptId: "attempt-1",
      workItemId: "work-1",
      agentGeneration: 2,
    },
    objective: "Finish the Program",
    work: {
      description: "Implement the current slice",
      lifecycle: "in_progress",
      dependencyIds: [],
      affectedPaths: ["src/a.ts"],
      omittedAffectedPathCount: 0,
    },
    dependencies: [],
    blockers: [],
    executionBase: {
      workspaceEffectGeneration: 1,
      observation: {
        kind: "workspace-observation-v1" as const,
        providerKind: "git",
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
      attemptMustRemainCurrent: true as const,
      rebaseRequiredOnExecutionBaseMismatch: true as const,
      hostOwnsVerificationAndCompletion: true as const,
    },
  };
}

describe("ProgramState Agent Protocol", () => {
  it("freezes the negotiated capability spelling and validates a bounded AttemptProjection", () => {
    expect(PROGRAM_STATE_CAPABILITY).toBe("program_state_v1");
    expect(isAgentToHostMessage({
      type: "agent.hello",
      protocolVersion: 1,
      generationId: "agent-generation",
      capabilities: [PROGRAM_STATE_CAPABILITY],
    })).toBe(true);
    expect(isHostToAgentMessage({
      type: "context.update",
      requestId: "context-1",
      sessionId: "session-1",
      receiptId: "receipt-1",
      effectiveMode: "verbatim-v1",
      sourceEventSequence: 10,
      systemPrompt: "host-authorized",
      messages: [],
      programAttempt: projection(),
    })).toBe(true);
  });

  it("rejects malformed Program authority inside a ContextUpdate", () => {
    const valid = projection();
    expect(isHostToAgentMessage({
      type: "context.update",
      requestId: "context-1",
      sessionId: "session-1",
      receiptId: "receipt-1",
      effectiveMode: "verbatim-v1",
      sourceEventSequence: 10,
      systemPrompt: "host-authorized",
      messages: [],
      programAttempt: {
        ...valid,
        authority: { ...valid.authority, agentGeneration: "2" },
      },
    })).toBe(false);
  });
});
