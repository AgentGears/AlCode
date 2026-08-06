import { describe, expect, it } from "vitest";
import {
  runAgentLoop,
  StaticExtensionHost,
  type AgentExtension,
  type AgentTool,
} from "./index.ts";

describe("agent-core contracts and loop", () => {
  it("runAgentLoop executes a single-turn conversation with no tools", async () => {
    // Minimal offline provider stub
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

    expect(messages.length).toBe(2); // user + assistant
    const assistant = messages[1]!;
    expect(assistant).toHaveProperty("role", "assistant");
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
