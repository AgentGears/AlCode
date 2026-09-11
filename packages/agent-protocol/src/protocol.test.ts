import { describe, expect, it } from "vitest";
import {
  AGENT_PROTOCOL_VERSION,
  DURABLE_TRANSCRIPT_CAPABILITY,
  GRAPH_CONTEXT_CAPABILITY,
  DYNAMIC_CAPABILITY_BINDING_CAPABILITY,
  AGENT_LOCAL_CODE_MODE_BINDING_KIND,
  LOCAL_ORCHESTRATION_CAPABILITY,
  RUN_CODE_TOOL_DEFINITION,
  RUN_CODE_TOOL_NAME,
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

  it("validates durable transcript capability, rich messages, ACK and verbatim envelope", () => {
    expect(isAgentToHostMessage({
      type: "agent.hello",
      protocolVersion: AGENT_PROTOCOL_VERSION,
      generationId: "g1",
      capabilities: [DURABLE_TRANSCRIPT_CAPABILITY],
    })).toBe(true);
    expect(isAgentToHostMessage({
      type: "assistant.message",
      requestId: "r-a",
      sessionId: "s1",
      text: "checking",
      content: [
        { type: "text", text: "checking" },
        { type: "toolCall", id: "T1", name: "read", arguments: { path: "README.md" } },
      ],
      stopReason: "tool_use",
      timestamp: 42,
    })).toBe(true);
    expect(isAgentToHostMessage({
      type: "tool.result",
      requestId: "r-t",
      sessionId: "s1",
      toolCallId: "T1",
      toolName: "read",
      content: [{ type: "text", text: "contents" }],
      isError: false,
      timestamp: 43,
    })).toBe(true);
    expect(isHostToAgentMessage({
      type: "transcript.admitted",
      requestId: "r-a",
      sessionId: "s1",
      eventId: "e1",
      sequence: 9,
    })).toBe(true);
    expect(isHostToAgentMessage({
      type: "context.provide",
      requestId: "r-context",
      sessionId: "s1",
      systemPrompt: "runtime prompt",
      orientationRequired: true,
      toolNames: ["read"],
      verbatim: {
        compilerVersion: "verbatim-v1",
        sourceEventSequence: 9,
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
        status: "complete",
        pendingToolCallIds: [],
        fidelity: "exact",
      },
    })).toBe(true);
  });

  it("validates graph capability and requires a durable receipt identity on each inference update", () => {
    expect(GRAPH_CONTEXT_CAPABILITY).toBe("graph_context_v1");
    expect(isAgentToHostMessage({
      type: "context.refresh.request",
      requestId: "ctx-1",
      sessionId: "s1",
    })).toBe(true);
    expect(isHostToAgentMessage({
      type: "context.update",
      requestId: "ctx-1",
      sessionId: "s1",
      receiptId: "receipt-1",
      effectiveMode: "graph-v1",
      sourceEventSequence: 12,
      systemPrompt: "host-authorized",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
    })).toBe(true);
    expect(isHostToAgentMessage({
      type: "context.update",
      requestId: "ctx-1",
      sessionId: "s1",
      effectiveMode: "graph-v1",
      sourceEventSequence: 12,
      systemPrompt: "host-authorized",
      messages: [],
    })).toBe(false);
  });

  it("validates dynamic capability negotiation, inference catalog and revision echo", () => {
    expect(DYNAMIC_CAPABILITY_BINDING_CAPABILITY).toBe("dynamic_capability_binding_v1");
    expect(isAgentToHostMessage({
      type: "agent.hello",
      protocolVersion: AGENT_PROTOCOL_VERSION,
      generationId: "g1",
      capabilities: [DYNAMIC_CAPABILITY_BINDING_CAPABILITY],
    })).toBe(true);
    expect(isHostToAgentMessage({
      type: "context.update",
      requestId: "ctx-dynamic",
      sessionId: "s1",
      receiptId: "receipt-dynamic",
      effectiveMode: "verbatim-v1",
      sourceEventSequence: 13,
      systemPrompt: "host-authorized",
      messages: [],
      toolCatalog: {
        digest: "digest-1",
        tools: [{
          definition: {
            name: "mcp__server__lookup",
            description: "Lookup",
            inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
          },
          binding: { kind: "dynamic", revision: "provider:g17" },
          isReadOnly: false,
        }],
      },
    })).toBe(true);
    expect(isAgentToHostMessage({
      type: "capability.request",
      requestId: "call-1",
      sessionId: "s1",
      toolCallId: "tc-dynamic",
      toolName: "mcp__server__lookup",
      args: { q: "x" },
      expectedCapabilityRevision: "provider:g17",
    })).toBe(true);
    expect(isAgentToHostMessage({
      type: "capability.request",
      requestId: "call-2",
      sessionId: "s1",
      toolCallId: "tc-dynamic",
      toolName: "mcp__server__lookup",
      args: {},
      expectedCapabilityRevision: 17,
    })).toBe(false);
  });

  it("validates the frozen S-02 local orchestration catalog contract without executing code", () => {
    expect(LOCAL_ORCHESTRATION_CAPABILITY).toBe("local_orchestration_v1");
    expect(AGENT_LOCAL_CODE_MODE_BINDING_KIND).toBe("agent_local_code_mode_v1");
    expect(RUN_CODE_TOOL_NAME).toBe("run_code");
    expect(Object.keys(RUN_CODE_TOOL_DEFINITION.inputSchema.properties)).toEqual(["code"]);
    expect(RUN_CODE_TOOL_DEFINITION.inputSchema.required).toEqual(["code"]);

    expect(isAgentToHostMessage({
      type: "agent.hello",
      protocolVersion: AGENT_PROTOCOL_VERSION,
      generationId: "g-s02",
      capabilities: [LOCAL_ORCHESTRATION_CAPABILITY],
    })).toBe(true);

    const update = {
      type: "context.update",
      requestId: "ctx-s02",
      sessionId: "s1",
      receiptId: "receipt-s02",
      effectiveMode: "verbatim-v1",
      sourceEventSequence: 14,
      systemPrompt: "host-authorized",
      messages: [],
      toolCatalog: {
        digest: "digest-s02",
        tools: [{
          definition: RUN_CODE_TOOL_DEFINITION,
          binding: { kind: AGENT_LOCAL_CODE_MODE_BINDING_KIND },
          isReadOnly: false,
        }],
      },
    } as const;
    expect(isHostToAgentMessage(update)).toBe(true);
    expect(isHostToAgentMessage({
      ...update,
      toolCatalog: {
        ...update.toolCatalog,
        tools: [{
          ...update.toolCatalog.tools[0],
          binding: { kind: AGENT_LOCAL_CODE_MODE_BINDING_KIND, handler: "arbitrary" },
        }],
      },
    })).toBe(false);
    expect(isHostToAgentMessage({
      ...update,
      toolCatalog: {
        ...update.toolCatalog,
        tools: [{
          ...update.toolCatalog.tools[0],
          definition: { ...RUN_CODE_TOOL_DEFINITION, name: "arbitrary_local_tool" },
        }],
      },
    })).toBe(false);
    expect(isHostToAgentMessage({
      ...update,
      toolCatalog: {
        ...update.toolCatalog,
        tools: [{
          ...update.toolCatalog.tools[0],
          definition: {
            ...RUN_CODE_TOOL_DEFINITION,
            inputSchema: { type: "object", properties: {}, required: [] },
          },
        }],
      },
    })).toBe(false);
    expect(isHostToAgentMessage({
      ...update,
      toolCatalog: {
        ...update.toolCatalog,
        tools: [{ ...update.toolCatalog.tools[0], isReadOnly: true }],
      },
    })).toBe(false);
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
