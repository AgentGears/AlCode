import { describe, expect, it } from "vitest";
import type { CapabilityResult, ProgramAttemptAuthorityV1 } from "@alcode/agent-protocol";
import { createProtocolProxyTool } from "./proxy-tools.ts";
import type { CognitionCapabilityRequest } from "./host-client.ts";

describe("protocol proxy ProgramAttempt binding", () => {
  it("echoes the exact authority captured when the inference tool was created through the narrow client", async () => {
    let captured: CognitionCapabilityRequest | undefined;
    const client = {
      async requestCapability(request: CognitionCapabilityRequest): Promise<CapabilityResult> {
        captured = structuredClone(request);
        return {
          type: "capability.result",
          requestId: "bridge-owned-request",
          sessionId: request.sessionId,
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          outcome: "succeeded",
          result: { ok: true },
        };
      },
    };

    const authority: ProgramAttemptAuthorityV1 = {
      programStateId: "program-a", expectedProgramRevision: 7, programAttemptId: "attempt-a",
      workItemId: "work-a", agentGeneration: 3,
    };
    const tool = createProtocolProxyTool({
      name: "inspect_program_file", sessionId: () => "session-a", client,
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
