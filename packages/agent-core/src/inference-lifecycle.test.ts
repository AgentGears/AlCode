import { describe, expect, it } from "vitest";
import { runAgentLoop, type AgentTool, type ModelEvent, type ModelRequest, type ModelStream } from "./index.ts";

function stream(events: readonly ModelEvent[]): ModelStream {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next(): Promise<IteratorResult<ModelEvent>> {
          const value = events[i++];
          return value === undefined
            ? { value: undefined, done: true }
            : { value, done: false };
        },
      };
    },
  };
}

describe("inference lifecycle seam", () => {
  it("closes one inference lifecycle after its tool calls settle and before the next refresh", async () => {
    const order: string[] = [];
    let providerCalls = 0;
    let refreshCalls = 0;
    const provider = {
      async stream(_request: ModelRequest): Promise<ModelStream> {
        providerCalls++;
        order.push(`provider-${providerCalls}`);
        return providerCalls === 1
          ? stream([
              { type: "tool_call", id: "T1", name: "inspect", arguments: {} },
              { type: "done", stopReason: "tool_use" },
            ])
          : stream([{ type: "done", stopReason: "stop" }]);
      },
    };
    const tool: AgentTool = {
      name: "inspect",
      description: "inspect",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        order.push("tool-1");
        return { content: [{ type: "text", text: "ok" }], details: {} };
      },
    };

    await runAgentLoop("go", {
      systemPrompt: "system",
      provider,
      tools: [tool],
      beforeInference: async (local) => {
        refreshCalls++;
        order.push(`before-${refreshCalls}`);
        return local;
      },
      afterInference: async () => {
        order.push(`after-${refreshCalls}`);
      },
    });

    expect(order).toEqual([
      "before-1",
      "provider-1",
      "tool-1",
      "after-1",
      "before-2",
      "provider-2",
      "after-2",
    ]);
  });

  it("runs lifecycle cleanup when provider inference throws", async () => {
    let cleaned = 0;
    await expect(runAgentLoop("fail", {
      systemPrompt: "system",
      tools: [],
      provider: {
        async stream(): Promise<ModelStream> {
          throw new Error("provider failed");
        },
      },
      beforeInference: async (local) => local,
      afterInference: async () => { cleaned++; },
    })).rejects.toThrow("provider failed");
    expect(cleaned).toBe(1);
  });
});
