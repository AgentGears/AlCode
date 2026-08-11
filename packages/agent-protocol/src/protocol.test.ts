import { describe, expect, it } from "vitest";
import {
  AGENT_PROTOCOL_VERSION,
  createInMemoryTransportPair,
  isAgentToHostMessage,
  isHostToAgentMessage,
  type AgentToHostMessage,
  type HostToAgentMessage,
} from "./index.ts";

describe("Agent Protocol v1", () => {
  it("validates the frozen semantic message families", () => {
    expect(isAgentToHostMessage({
      type: "agent.hello",
      protocolVersion: AGENT_PROTOCOL_VERSION,
      generationId: "g1",
      capabilities: ["capability.request"],
    })).toBe(true);
    expect(isAgentToHostMessage({
      type: "capability.request",
      requestId: "r1",
      sessionId: "s1",
      toolCallId: "tc1",
      toolName: "read",
      args: { path: "README.md" },
    })).toBe(true);
    expect(isHostToAgentMessage({
      type: "session.resume",
      requestId: "r2",
      sessionId: "s1",
      workspaceId: "w1",
      reason: "agent_replaced",
    })).toBe(true);
    expect(isHostToAgentMessage({
      type: "context.provide",
      requestId: "r3",
      sessionId: "s1",
      systemPrompt: "bootstrap only",
      orientationRequired: true,
      toolNames: ["orient"],
    })).toBe(true);
  });

  it("rejects incompatible protocol versions and malformed messages", () => {
    expect(isAgentToHostMessage({ type: "agent.hello", protocolVersion: 2, generationId: "g", capabilities: [] })).toBe(false);
    expect(isAgentToHostMessage({ type: "capability.request", requestId: "r" })).toBe(false);
    expect(isHostToAgentMessage({ type: "shutdown", requestId: "r", reason: "unknown" })).toBe(false);
  });

  it("provides a transport-neutral in-memory pair", async () => {
    const pair = createInMemoryTransportPair<AgentToHostMessage, HostToAgentMessage>();
    const seen: string[] = [];
    pair.b.onMessage((message) => { seen.push(message.type); });
    await pair.a.send({
      type: "agent.hello",
      protocolVersion: AGENT_PROTOCOL_VERSION,
      generationId: "g1",
      capabilities: [],
    });
    expect(seen).toEqual(["agent.hello"]);
  });
});
