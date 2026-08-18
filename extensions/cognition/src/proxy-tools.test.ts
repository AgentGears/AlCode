import { describe, expect, it } from "vitest";
import {
  createInMemoryTransportPair,
  type AgentToHostMessage,
  type HostToAgentMessage,
  type ProgramAttemptAuthorityV1,
} from "@alcode/agent-protocol";
import { createProtocolProxyTool } from "./proxy-tools.ts";

describe("protocol proxy ProgramAttempt binding", () => {
  it("echoes the exact authority captured when the inference tool was created", async () => {
    const pair = createInMemoryTransportPair<AgentToHostMessage, HostToAgentMessage>();
    let captured: Extract<AgentToHostMessage, { type: "capability.request" }> | undefined;
    pair.b.onMessage(async (message) => {
      if (message.type !== "capability.request") return;
      captured = structuredClone(message);
      await pair.b.send({
        type: "capability.result", requestId: message.requestId, sessionId: message.sessionId,
        toolCallId: message.toolCallId, toolName: message.toolName, outcome: "succeeded", result: { ok: true },
      });
    });

    const authority: ProgramAttemptAuthorityV1 = {
      programStateId: "program-a", expectedProgramRevision: 7, programAttemptId: "attempt-a",
      workItemId: "work-a", agentGeneration: 3,
    };
    const tool = createProtocolProxyTool({
      name: "inspect_program_file", sessionId: () => "session-a", transport: pair.a,
      programAttemptAuthority: authority,
    });
    authority.expectedProgramRevision = 99;
    authority.programAttemptId = "attempt-b";
    authority.agentGeneration = 4;

    await tool.execute({}, { toolCallId: "tool-call-a" });
    expect(captured?.programAttemptAuthority).toEqual({
      programStateId: "program-a", expectedProgramRevision: 7, programAttemptId: "attempt-a",
      workItemId: "work-a", agentGeneration: 3,
    });
  });
});
