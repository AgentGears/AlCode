import { describe, expect, it } from "vitest";
import {
  runAgentLoop,
  StaticExtensionHost,
  type AgentExtension,
  type AgentTool,
  type Message,
  type ModelRequest,
} from "./index.ts";

describe("agent-core contracts and loop", () => {
  it("runAgentLoop executes a single-turn conversation with no tools", async () => {
    const provider = {
      async stream() {
        const events = [
          { type: "text_delta", text: "hello back" },
          { type: "done", stopReason: "stop" as const },
        ];
        return {
          [Symbol.asyncIterator]() {
            let i = 0;
            return {
              next: () =>
                i < events.length
                  ? Promise.resolve({ value: events[i++]!, done: false })
                  : Promise.resolve({ value: undefined, done: true }),
            };
          },
        };
      },
    };

    const messages = await runAgentLoop("hello", {
      systemPrompt: "",
      provider: provider as never,
      tools: [],
    });

    expect(messages.length).toBe(2);
    const assistant = messages[1]!;
    expect(assistant).toHaveProperty("role", "assistant");
  });

  it("supplies the durable prefix unchanged to the first ModelRequest and does not mutate the caller array", async () => {
    const initialMessages: readonly Message[] = Object.freeze([
      { role: "user", content: [{ type: "text", text: "U1" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "A1" }], stopReason: "stop", timestamp: 2 },
    ]);
    const before = structuredClone(initialMessages);
    const requests: ModelRequest[] = [];
    const provider = {
      async stream(request: ModelRequest) {
        requests.push(structuredClone({
          systemPrompt: request.systemPrompt,
          messages: request.messages,
          tools: request.tools,
        }) as ModelRequest);
        const events = [
          { type: "text_delta" as const, text: "A2" },
          { type: "done" as const, stopReason: "stop" as const },
        ];
        return {
          [Symbol.asyncIterator]() {
            let i = 0;
            return {
              async next() {
                const value = events[i++];
                return value === undefined ? { value: undefined, done: true } : { value, done: false };
              },
            };
          },
        };
      },
    };

    const messages = await runAgentLoop("U2", {
      systemPrompt: "system",
      provider,
      tools: [],
      initialMessages,
      promptTimestamp: 3,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages).toEqual([
      ...before,
      { role: "user", content: [{ type: "text", text: "U2" }], timestamp: 3 },
    ]);
    expect(initialMessages).toEqual(before);
    expect(messages.slice(0, before.length)).toEqual(before);
  });

  it("StaticExtensionHost collects tools from extensions", async () => {
    const host = new StaticExtensionHost();
    const tool: AgentTool = {
      name: "test",
      description: "test tool",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        return { content: [{ type: "text", text: "ok" }], details: {} };
      },
    };
    const ext: AgentExtension = {
      name: "test-ext",
      register(ctx) { ctx.registerTool(tool); },
    };
    await host.mount([ext]);
    expect(host.getTools().length).toBe(1);
    expect(host.getTools()[0]!.name).toBe("test");
  });
});
