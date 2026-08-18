import { describe, expect, it } from "vitest";
import {
  PROGRAM_EXECUTION_CAPABILITY,
  PROGRAM_EXECUTION_MESSAGE_VERSION,
  isAgentToHostMessage,
  isHostToAgentMessage,
} from "./index.ts";

describe("program_execution_v1 protocol", () => {
  it("keeps the additive capability separate from program_state_v1", () => {
    expect(PROGRAM_EXECUTION_CAPABILITY).toBe("program_execution_v1");
    expect(PROGRAM_EXECUTION_MESSAGE_VERSION).toBe(1);
  });

  it("validates bounded planning reads and Program proposals", () => {
    expect(isAgentToHostMessage({
      type: "program.planning.read",
      version: 1,
      requestId: "read-1",
      sessionId: "session-1",
      planningEpisodeId: "episode-1",
      readContractId: "workspace.read.v1",
      readContractVersion: 1,
      args: { path: "src/a.ts" },
    })).toBe(true);

    const proposal = {
      objective: "Update src/a.ts",
      workItems: [],
      verification: [],
      outputSlots: [],
      productionSteps: [],
    };
    expect(isAgentToHostMessage({
      type: "program.proposal",
      version: 1,
      requestId: "proposal-1",
      sessionId: "session-1",
      planningEpisodeId: "episode-1",
      proposal,
    })).toBe(true);
    expect(isAgentToHostMessage({
      type: "program.proposal",
      version: 1,
      requestId: "proposal-2",
      sessionId: "session-1",
      planningEpisodeId: "episode-1",
      proposal: { ...proposal, programStateId: "agent-chosen" },
    })).toBe(false);
  });

  it("accepts only complete inference-bound ProgramAttempt authority", () => {
    const base = {
      type: "capability.request",
      requestId: "cap-1",
      sessionId: "session-1",
      toolCallId: "call-1",
      toolName: "read_file",
      args: { path: "src/a.ts" },
    };
    expect(isAgentToHostMessage({
      ...base,
      programAttemptAuthority: {
        programStateId: "program-1",
        expectedProgramRevision: 2,
        programAttemptId: "attempt-1",
        workItemId: "work-1",
        agentGeneration: 3,
      },
    })).toBe(true);
    expect(isAgentToHostMessage({
      ...base,
      programAttemptAuthority: {
        programStateId: "program-1",
        expectedProgramRevision: 2,
        programAttemptId: "attempt-1",
        workItemId: "work-1",
      },
    })).toBe(false);
  });

  it("validates Host planning responses", () => {
    expect(isHostToAgentMessage({
      type: "program.planning.begin",
      version: 1,
      requestId: "begin-1",
      sessionId: "session-1",
      planningEpisodeId: "episode-1",
      objective: "Update src/a.ts",
    })).toBe(true);
    expect(isHostToAgentMessage({
      type: "program.proposal.result",
      version: 1,
      requestId: "proposal-1",
      sessionId: "session-1",
      planningEpisodeId: "episode-1",
      outcome: "sealed",
    })).toBe(true);
  });
});
