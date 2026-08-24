import { describe, expect, it } from "vitest";
import {
  type AgentToHostMessageV2Aware,
  type HostToAgentMessageV2Aware,
  type ProgramAttemptAuthorityV1,
  type ProgramAttemptAuthorityV2,
  type ProtocolTransport,
} from "@alcode/agent-protocol";
import { createAgentProtocolBridgeV2ForTransport } from "./agent-protocol-bridge-v2.ts";

function v1Authority(): ProgramAttemptAuthorityV1 {
  return {
    programStateId: "program-v1",
    expectedProgramRevision: 7,
    programAttemptId: "attempt-v1",
    workItemId: "work-v1",
    agentGeneration: 2,
  };
}

function v2Authority(): ProgramAttemptAuthorityV2 {
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

function harness() {
  const sent: AgentToHostMessageV2Aware[] = [];
  let receive: ((message: HostToAgentMessageV2Aware) => void) | undefined;
  let closed = false;
  const transport: ProtocolTransport<AgentToHostMessageV2Aware, HostToAgentMessageV2Aware> = {
    async send(message) {
      sent.push(structuredClone(message));
      if (message.type === "program.progress") {
        const version = message.version;
        queueMicrotask(() => receive?.({
          type: "program.progress.result",
          version,
          requestId: message.requestId,
          sessionId: message.sessionId,
          outcome: "admitted",
          ...(version === 1 ? { programRevision: 7 } : { programRevisionId: "semantic-r2" }),
        } as HostToAgentMessageV2Aware));
      }
    },
    onMessage(handler) {
      receive = handler;
      return () => { if (receive === handler) receive = undefined; };
    },
    async close() { closed = true; },
  };
  return { transport, sent, isClosed: () => closed };
}

describe("A1 transitional Agent protocol bridge", () => {
  it("sends V1 progress for V1 authority and V2 progress for V2 authority", async () => {
    const h = harness();
    const client = createAgentProtocolBridgeV2ForTransport(h.transport);

    const first = await client.submitProgramProgress({
      sessionId: "session-1",
      authority: v1Authority(),
      evidence: [],
      advisoryBlockers: [],
      requestAwaitingVerification: true,
    });
    expect(first.version).toBe(1);
    expect(h.sent.at(-1)).toMatchObject({ type: "program.progress", version: 1 });

    const second = await client.submitProgramProgress({
      sessionId: "session-1",
      authority: v2Authority(),
      evidence: [],
      advisoryBlockers: [],
      requestAwaitingVerification: true,
    });
    expect(second.version).toBe(2);
    expect(h.sent.at(-1)).toMatchObject({ type: "program.progress", version: 2 });
  });

  it("freezes only the semantic facade, not the mutable bridge lifecycle state", async () => {
    const h = harness();
    const client = createAgentProtocolBridgeV2ForTransport(h.transport);
    expect(Object.isFrozen(client)).toBe(true);
    await expect(client.close()).resolves.toBeUndefined();
    expect(h.isClosed()).toBe(true);
  });
});
