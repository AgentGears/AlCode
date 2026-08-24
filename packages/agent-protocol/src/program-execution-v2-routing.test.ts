import { describe, expect, it } from "vitest";
import {
  isAgentToHostMessage,
  isHostToAgentMessage,
  isAgentToHostMessageV2Aware,
  isHostToAgentMessageV2Aware,
  type ProgramAttemptAuthorityV2,
} from "./index.ts";

function authority(): ProgramAttemptAuthorityV2 {
  return {
    authorityVersion: 2,
    programStateId: "program-v2",
    issuedUnderProgramRevisionId: "semantic-r1",
    programAttemptId: "attempt-v2",
    workItemId: "work-v2",
    workItemGeneration: 3,
    dependencyReceipt: { entries: [] },
    constraintReceipt: {
      workAuthorityEnvelope: {
        objectiveBoundaryRef: {
          programStateId: "program-v2",
          rootProgramRevisionId: "semantic-r1",
          anchorWorkItemId: "work-v2",
        },
        allowedRepositoryRoots: ["."],
        allowedEffectClasses: ["fs.read"],
        allowedExternalSystems: [],
        capabilityCeiling: ["read"],
        maximumTopologyExpansion: 8,
        mandatoryVerificationIds: [],
        forbiddenChangeKinds: [],
      },
      mandatoryConstraintIds: [],
    },
    agentGeneration: 2,
  };
}

describe("A1 negotiated V2 routing envelope", () => {
  it("keeps the base protocol V1 validator unchanged while the V2-aware transport admits exact V2 execute", () => {
    const execute = {
      type: "program.attempt.execute",
      version: 2,
      requestId: "execute-v2",
      sessionId: "session-v2",
      authority: authority(),
    };
    expect(isHostToAgentMessage(execute)).toBe(false);
    expect(isHostToAgentMessageV2Aware(execute)).toBe(true);

    expect(isHostToAgentMessage({
      type: "host.hello",
      protocolVersion: 1,
      hostInstanceId: "host-v1",
    })).toBe(true);
    expect(isHostToAgentMessageV2Aware({
      type: "host.hello",
      protocolVersion: 1,
      hostInstanceId: "host-v1",
    })).toBe(true);
  });

  it("admits V2 progress and capability authority only through the V2-aware envelope", () => {
    const progress = {
      type: "program.progress",
      version: 2,
      requestId: "progress-v2",
      sessionId: "session-v2",
      authority: authority(),
      evidence: [],
      advisoryBlockers: [],
      requestAwaitingVerification: true,
    };
    expect(isAgentToHostMessage(progress)).toBe(false);
    expect(isAgentToHostMessageV2Aware(progress)).toBe(true);

    const capability = {
      type: "capability.request",
      requestId: "cap-v2",
      sessionId: "session-v2",
      toolCallId: "call-v2",
      toolName: "read",
      args: { path: "src/index.ts" },
      programAttemptAuthority: authority(),
    };
    expect(isAgentToHostMessage(capability)).toBe(false);
    expect(isAgentToHostMessageV2Aware(capability)).toBe(true);
  });
});
