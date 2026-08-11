import { describe, expect, it } from "vitest";
import {
  runAgentLoop,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
  type ModelStream,
} from "@alcode/agent-core";
import {
  createInMemoryTransportPair,
  type AgentToHostMessage,
  type HostToAgentMessage,
} from "@alcode/agent-protocol";
import {
  createAgentEventForwarder,
  createProtocolProxyTool,
} from "@alcode/cognition-extension";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

function stream(events: ModelEvent[]): ModelStream {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next(): Promise<IteratorResult<ModelEvent>> {
          const value = events[index++];
          return value === undefined ? { value: undefined, done: true } : { value, done: false };
        },
      };
    },
  };
}

describe("Phase 0.6 durable transcript admission barrier", () => {
  it("does not execute a tool before assistant ACK or issue the next model request before tool-result ACK", async () => {
    const pair = createInMemoryTransportPair<AgentToHostMessage, HostToAgentMessage>();
    const assistantAck = deferred();
    const toolResultAck = deferred();
    const assistantSeen = deferred();
    const toolResultSeen = deferred();

    let providerCalls = 0;
    let capabilityRequests = 0;
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async stream(request) {
        requests.push(structuredClone({
          systemPrompt: request.systemPrompt,
          messages: request.messages,
          tools: request.tools,
        }) as ModelRequest);
        providerCalls++;
        if (providerCalls === 1) {
          return stream([
            { type: "tool_call", id: "T1", name: "read", arguments: { path: "README.md" } },
            { type: "done", stopReason: "tool_use" },
          ]);
        }
        return stream([
          { type: "text_delta", text: "done" },
          { type: "done", stopReason: "stop" },
        ]);
      },
    };

    pair.b.onMessage(async (message) => {
      switch (message.type) {
        case "assistant.message": {
          const hasToolCall = message.content?.some((block) => block.type === "toolCall") ?? false;
          if (hasToolCall) {
            assistantSeen.resolve();
            await assistantAck.promise;
          }
          await pair.b.send({
            type: "transcript.admitted",
            requestId: message.requestId,
            sessionId: message.sessionId,
            eventId: `assistant-${message.requestId}`,
            sequence: hasToolCall ? 2 : 4,
          });
          break;
        }
        case "capability.request":
          capabilityRequests++;
          expect(message.toolCallId).toBe("T1");
          await pair.b.send({
            type: "capability.result",
            requestId: message.requestId,
            sessionId: message.sessionId,
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            operationId: "O1",
            outcome: "succeeded",
            result: { text: "contents" },
          });
          break;
        case "tool.result":
          expect(message.toolCallId).toBe("T1");
          toolResultSeen.resolve();
          await toolResultAck.promise;
          await pair.b.send({
            type: "transcript.admitted",
            requestId: message.requestId,
            sessionId: message.sessionId,
            eventId: `tool-${message.requestId}`,
            sequence: 3,
          });
          break;
        default:
          break;
      }
    });

    const tool = createProtocolProxyTool({
      name: "read",
      sessionId: () => "s1",
      transport: pair.a,
    });

    const run = runAgentLoop("inspect", {
      systemPrompt: "test",
      provider,
      tools: [tool],
      promptTimestamp: 1,
      emit: createAgentEventForwarder(pair.a, () => "s1", true),
    });

    await assistantSeen.promise;
    expect(providerCalls).toBe(1);
    expect(capabilityRequests).toBe(0);

    assistantAck.resolve();
    await toolResultSeen.promise;
    expect(capabilityRequests).toBe(1);
    expect(providerCalls).toBe(1);

    toolResultAck.resolve();
    await run;

    expect(providerCalls).toBe(2);
    expect(requests[1]?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "inspect" }], timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "T1", name: "read", arguments: { path: "README.md" } }],
        stopReason: "tool_use",
        timestamp: expect.any(Number),
      },
      {
        role: "toolResult",
        toolCallId: "T1",
        toolName: "read",
        content: [{ type: "text", text: JSON.stringify({ text: "contents" }) }],
        isError: false,
        timestamp: expect.any(Number),
      },
    ]);
  });
});
