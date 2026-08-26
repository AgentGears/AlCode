import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
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
  return {
    transport,
    sent,
    isClosed: () => closed,
    deliver: (message: HostToAgentMessageV2Aware) => receive?.(structuredClone(message)),
  };
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

  it("bounds read-only context refresh when the Host cannot respond", async () => {
    const h = harness();
    const client = createAgentProtocolBridgeV2ForTransport(h.transport);
    vi.useFakeTimers();
    try {
      const contextPending = client.requestContextUpdate("session-1", new AbortController().signal);
      const contextExpectation = expect(contextPending).rejects.toThrow("Context refresh timed out");
      await vi.advanceTimersByTimeAsync(10_000);
      await contextExpectation;
    } finally {
      vi.useRealTimers();
      await client.close();
    }
  });

  it("keeps effectful capability requests pending until a correlated terminal Host result arrives", async () => {
    const h = harness();
    const client = createAgentProtocolBridgeV2ForTransport(h.transport);
    vi.useFakeTimers();
    try {
      const pending = client.requestCapability({
        sessionId: "session-1",
        toolCallId: "tool-long-running",
        toolName: "edit",
        args: { path: "src/long-running.ts" },
        programAttemptAuthority: v2Authority(),
      });
      const request = h.sent.at(-1);
      expect(request).toMatchObject({ type: "capability.request", toolCallId: "tool-long-running" });
      if (request === undefined || request.type !== "capability.request") throw new Error("capability request not sent");

      let settled = false;
      void pending.finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.resolve();
      expect(settled).toBe(false);

      h.deliver({
        type: "capability.result",
        requestId: request.requestId,
        sessionId: "session-1",
        toolCallId: "tool-long-running",
        toolName: "edit",
        outcome: "succeeded",
        operationId: "operation-long-running",
        result: { committed: true },
      });
      await expect(pending).resolves.toMatchObject({
        outcome: "succeeded",
        operationId: "operation-long-running",
      });
    } finally {
      vi.useRealTimers();
      await client.close();
    }
  });

  it("freezes only the semantic facade, not the mutable bridge lifecycle state", async () => {
    const h = harness();
    const client = createAgentProtocolBridgeV2ForTransport(h.transport);
    expect(Object.isFrozen(client)).toBe(true);
    await expect(client.close()).resolves.toBeUndefined();
    expect(h.isClosed()).toBe(true);
  });

  it("advertises semantic revision support with the complete adaptive V2 capability set", () => {
    const worker = readFileSync(new URL("./agent-worker.ts", import.meta.url), "utf8");
    expect(worker).toContain("PROGRAM_STATE_V2_CAPABILITY");
    expect(worker).toContain("PROGRAM_EXECUTION_V2_CAPABILITY");
    expect(worker).toContain("PROGRAM_REVISION_CAPABILITY");
  });
});
