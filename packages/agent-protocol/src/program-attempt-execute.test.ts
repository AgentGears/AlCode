import { describe, expect, it } from "vitest";
import {
  PROGRAM_EXECUTION_MESSAGE_VERSION,
  isHostToAgentMessage,
  type ProgramAttemptExecute,
} from "./index.ts";

function executeMessage(): ProgramAttemptExecute {
  return {
    type: "program.attempt.execute",
    version: PROGRAM_EXECUTION_MESSAGE_VERSION,
    requestId: "execute-1",
    sessionId: "session-1",
    authority: {
      programStateId: "program-1",
      expectedProgramRevision: 4,
      programAttemptId: "attempt-1",
      workItemId: "work-1",
      agentGeneration: 2,
    },
  };
}

describe("program.attempt.execute protocol", () => {
  it("accepts only the exact bounded Host execution authority shape", () => {
    expect(isHostToAgentMessage(executeMessage())).toBe(true);
    expect(isHostToAgentMessage({ ...executeMessage(), unexpected: true })).toBe(false);
    expect(isHostToAgentMessage({
      ...executeMessage(),
      authority: { ...executeMessage().authority, expectedProgramRevision: 0 },
    })).toBe(false);
    expect(isHostToAgentMessage({
      ...executeMessage(),
      authority: { ...executeMessage().authority, agentGeneration: 0 },
    })).toBe(false);
  });
});
