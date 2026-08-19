import { describe, expect, it, vi } from "vitest";
import {
  createInMemoryTransportPair,
  type AgentToHostMessage,
  type HostToAgentMessage,
  type ProgramAttemptAuthorityV1,
} from "@alcode/agent-protocol";
import {
  AgentProtocolBridgeClosedError,
  createAgentProtocolBridgeForTransport,
} from "./agent-protocol-bridge.ts";

const authority: ProgramAttemptAuthorityV1 = {
  programStateId: "program-a",
  expectedProgramRevision: 7,
  programAttemptId: "attempt-a",
  workItemId: "work-a",
  agentGeneration: 3,
};

describe("privileged Agent protocol bridge", () => {
  it("settles context only on exact semantic identity and ignores same-request-id mismatches", async () => {
    const pair = createInMemoryTransportPair<AgentToHostMessage, HostToAgentMessage>();
    const bridge = createAgentProtocolBridgeForTransport(pair.a);
    pair.b.onMessage(async (message) => {
      if (message.type !== "context.refresh.request") return;
      await pair.b.send({
        type: "context.update",
        requestId: message.requestId,
        sessionId: "wrong-session",
        receiptId: "wrong",
        effectiveMode: "graph-v1",
        sourceEventSequence: 1,
        systemPrompt: "wrong",
        messages: [],
      });
      await pair.b.send({
        type: "context.update",
        requestId: message.requestId,
        sessionId: message.sessionId,
        receiptId: "right",
        effectiveMode: "graph-v1",
        sourceEventSequence: 2,
        systemPrompt: "right",
        messages: [],
      });
    });

    const update = await bridge.requestContextUpdate("session-a", new AbortController().signal);
    expect(update.receiptId).toBe("right");
    expect(update.systemPrompt).toBe("right");
    await bridge.close();
  });

  it("cancels context correlation and does not let a late response revive the request", async () => {
    const pair = createInMemoryTransportPair<AgentToHostMessage, HostToAgentMessage>();
    const bridge = createAgentProtocolBridgeForTransport(pair.a);
    let captured: Extract<AgentToHostMessage, { type: "context.refresh.request" }> | undefined;
    pair.b.onMessage((message) => {
      if (message.type === "context.refresh.request") captured = message;
    });

    const controller = new AbortController();
    const pending = bridge.requestContextUpdate("session-a", controller.signal);
    await Promise.resolve();
    controller.abort(new Error("cancel context"));
    await expect(pending).rejects.toThrow("cancel context");
    expect(captured).toBeDefined();

    await pair.b.send({
      type: "context.update",
      requestId: captured!.requestId,
      sessionId: "session-a",
      receiptId: "late",
      effectiveMode: "graph-v1",
      sourceEventSequence: 3,
      systemPrompt: "late",
      messages: [],
    });
    await bridge.close();
  });

  it("preserves Program, capability, transcript, idle, hello, and diagnostics wire semantics behind narrow methods", async () => {
    const pair = createInMemoryTransportPair<AgentToHostMessage, HostToAgentMessage>();
    const bridge = createAgentProtocolBridgeForTransport(pair.a);
    const seen: AgentToHostMessage[] = [];
    pair.b.onMessage(async (message) => {
      seen.push(structuredClone(message));
      switch (message.type) {
        case "program.proposal":
          await pair.b.send({
            type: "program.proposal.result", version: 1, requestId: message.requestId,
            sessionId: message.sessionId, planningEpisodeId: message.planningEpisodeId, outcome: "sealed",
          });
          break;
        case "program.progress":
          await pair.b.send({
            type: "program.progress.result", version: 1, requestId: message.requestId,
            sessionId: message.sessionId, outcome: "admitted", programStateId: "program-a", programRevision: 8,
          });
          break;
        case "capability.request":
          await pair.b.send({
            type: "capability.result", requestId: message.requestId, sessionId: message.sessionId,
            toolCallId: message.toolCallId, toolName: message.toolName, outcome: "succeeded", result: { ok: true },
          });
          break;
        case "assistant.message":
        case "tool.result":
          if (message.type === "assistant.message" && message.content === undefined) break;
          await pair.b.send({
            type: "transcript.admitted", requestId: message.requestId, sessionId: message.sessionId,
            eventId: `event-${seen.length}`, sequence: seen.length,
          });
          break;
        default:
          break;
      }
    });

    await bridge.announceHello("generation-a", ["capability.request"]);
    await bridge.submitProgramProposal({
      sessionId: "session-a", planningEpisodeId: "planning-a",
      proposal: { objective: "ship", workItems: [], verification: [], outputSlots: [], productionSteps: [] },
    });
    await bridge.submitProgramProgress({
      sessionId: "session-a", authority, evidence: [], advisoryBlockers: [], requestAwaitingVerification: true,
    });
    await bridge.requestCapability({
      sessionId: "session-a", toolCallId: "tool-call-a", toolName: "read", args: { path: "x" },
      expectedCapabilityRevision: "rev-a", programAttemptAuthority: authority,
    });
    await bridge.recordAssistant({
      sessionId: "session-a", text: "durable", content: [{ type: "text", text: "durable" }],
      stopReason: "stop", timestamp: 10, durable: true,
    });
    await bridge.recordAssistant({
      sessionId: "session-a", text: "legacy", content: [{ type: "text", text: "legacy" }],
      stopReason: "stop", timestamp: 11, durable: false,
    });
    await bridge.recordToolResult({
      sessionId: "session-a", toolCallId: "tool-call-a", toolName: "read",
      content: [{ type: "text", text: "ok" }], isError: false, timestamp: 12,
    });
    await bridge.reportIdle({ sessionId: "session-a", reason: "stop" });
    await bridge.reportError("diagnostic", "session-a");

    expect(seen.find((message) => message.type === "agent.hello")).toMatchObject({
      type: "agent.hello", protocolVersion: 1, generationId: "generation-a", capabilities: ["capability.request"],
    });
    expect(seen.find((message) => message.type === "program.proposal")).toMatchObject({
      type: "program.proposal", version: 1, sessionId: "session-a", planningEpisodeId: "planning-a",
      proposal: { objective: "ship" },
    });
    expect(seen.find((message) => message.type === "program.progress")).toMatchObject({
      type: "program.progress", version: 1, sessionId: "session-a", authority,
      evidence: [], advisoryBlockers: [], requestAwaitingVerification: true,
    });
    expect(seen.find((message) => message.type === "capability.request")).toMatchObject({
      type: "capability.request", sessionId: "session-a", toolCallId: "tool-call-a", toolName: "read",
      args: { path: "x" }, expectedCapabilityRevision: "rev-a", programAttemptAuthority: authority,
    });
    const assistants = seen.filter((message) => message.type === "assistant.message");
    expect(assistants[0]).toMatchObject({
      type: "assistant.message", sessionId: "session-a", text: "durable",
      content: [{ type: "text", text: "durable" }], stopReason: "stop", timestamp: 10,
    });
    expect(assistants[1]).toMatchObject({
      type: "assistant.message", sessionId: "session-a", text: "legacy",
    });
    expect("content" in assistants[1]!).toBe(false);
    expect(seen.find((message) => message.type === "tool.result")).toMatchObject({
      type: "tool.result", sessionId: "session-a", toolCallId: "tool-call-a", toolName: "read",
      content: [{ type: "text", text: "ok" }], isError: false, timestamp: 12,
    });
    expect(seen.find((message) => message.type === "agent.idle")).toMatchObject({
      type: "agent.idle", sessionId: "session-a", reason: "stop",
    });
    expect(seen.find((message) => message.type === "agent.error")).toMatchObject({
      type: "agent.error", sessionId: "session-a", message: "diagnostic",
    });
    await bridge.close();
  });

  it("keeps the existing 10 second Program proposal and progress response timeouts", async () => {
    vi.useFakeTimers();
    try {
      const pair = createInMemoryTransportPair<AgentToHostMessage, HostToAgentMessage>();
      const bridge = createAgentProtocolBridgeForTransport(pair.a);
      pair.b.onMessage(() => undefined);
      const proposal = bridge.submitProgramProposal({
        sessionId: "session-a", planningEpisodeId: "planning-a",
        proposal: { objective: "ship", workItems: [], verification: [], outputSlots: [], productionSteps: [] },
      });
      const progress = bridge.submitProgramProgress({
        sessionId: "session-a", authority, evidence: [], advisoryBlockers: [], requestAwaitingVerification: true,
      });
      const proposalAssertion = expect(proposal).rejects.toThrow("Program proposal timed out");
      const progressAssertion = expect(progress).rejects.toThrow("Program progress proposal timed out");
      await vi.advanceTimersByTimeAsync(9_999);
      await vi.advanceTimersByTimeAsync(1);
      await proposalAssertion;
      await progressAssertion;
      await bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes unmatched Host control messages through the privileged dispatcher", async () => {
    const pair = createInMemoryTransportPair<AgentToHostMessage, HostToAgentMessage>();
    const bridge = createAgentProtocolBridgeForTransport(pair.a);
    const seen: string[] = [];
    bridge.onHostMessage((message) => { seen.push(message.type); });
    await pair.b.send({
      type: "session.open", requestId: "open-a", sessionId: "session-a", workspaceId: "workspace-a",
    });
    expect(seen).toEqual(["session.open"]);
    await bridge.close();
  });

  it("close rejects outstanding requests and prevents new semantic sends", async () => {
    const pair = createInMemoryTransportPair<AgentToHostMessage, HostToAgentMessage>();
    const bridge = createAgentProtocolBridgeForTransport(pair.a);
    pair.b.onMessage(() => undefined);
    const pending = bridge.requestCapability({
      sessionId: "session-a", toolCallId: "tool-call-a", toolName: "read", args: {},
    });
    const assertion = expect(pending).rejects.toBeInstanceOf(AgentProtocolBridgeClosedError);
    await Promise.resolve();
    await bridge.close();
    await assertion;
    await expect(bridge.reportIdle({ sessionId: "session-a", reason: "stop" })).rejects.toBeInstanceOf(AgentProtocolBridgeClosedError);
  });
});
