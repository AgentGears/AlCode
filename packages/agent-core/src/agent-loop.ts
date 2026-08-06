// ALCODE-owned agent loop. Implements the same core semantics as pi v0.81.1's
// agent-loop.ts (stream an assistant response, execute tool calls, loop until
// the assistant stops calling tools), but against owned contracts — no pi-ai
// dependency. The imported pi slice under ./imported/ is the reference.
//
// Differences from pi's loop (intentional simplifications for Phase 0.1A):
//   - sequential tool execution only (pi supports parallel; defer)
//   - no steering/follow-up queues (defer to when the session layer exists)
//   - hooks are via the StaticExtensionHost, not a separate LoopConfig
//   - no prepareNextTurn / shouldStopAfterTurn / transformContext (defer)
// These are deliberate Phase 0.1A scope reductions, tracked in backlog.

import type {
  AgentEvent,
  AgentEventSink,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  AssistantMessage,
  Message,
  ModelEvent,
  ModelProvider,
  TextContent,
  ToolCallContent,
  ToolResultMessage,
} from "./contracts.ts";

export interface AgentLoopOptions {
  systemPrompt: string;
  provider: ModelProvider;
  tools: AgentTool[];
  maxSteps?: number;
  emit?: AgentEventSink;
  signal?: AbortSignal;
}

/**
 * Run the agent loop with a user prompt. Returns the full transcript of
 * messages produced during the run.
 *
 * Semantics: stream the assistant → collect tool calls → execute them
 * sequentially → append tool results → re-stream → repeat until the
 * assistant returns no tool calls or maxSteps is reached.
 */
export async function runAgentLoop(
  prompt: string,
  options: AgentLoopOptions,
): Promise<AgentMessage[]> {
  const { systemPrompt, provider, tools, maxSteps = 50 } = options;
  const emit = options.emit ?? (() => {});
  const signal = options.signal;

  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
  ];

  await emit({ type: "agent_start" });

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) break;
    await emit({ type: "turn_start" });

    // Stream the assistant response.
    const assistantMessage = await streamAssistant(
      systemPrompt,
      messages as Message[],
      tools,
      provider,
      signal,
    );
    messages.push(assistantMessage);
    await emit({ type: "message_start", message: assistantMessage });
    await emit({ type: "message_end", message: assistantMessage });

    // Collect tool calls.
    const toolCalls = assistantMessage.content.filter(
      (c): c is ToolCallContent => c.type === "toolCall",
    );

    if (toolCalls.length === 0 || assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
      await emit({ type: "turn_end" });
      break;
    }

    // Execute tool calls sequentially.
    for (const tc of toolCalls) {
      if (signal?.aborted) break;
      await emit({ type: "tool_execution_start", toolCallId: tc.id, toolName: tc.name, args: tc.arguments });

      const tool = tools.find((t) => t.name === tc.name);
      let result: AgentToolResult;
      let isError: boolean;

      if (!tool) {
        result = {
          content: [{ type: "text", text: `Tool "${tc.name}" not found` }],
          details: { error: "tool_not_found" },
        };
        isError = true;
      } else {
        try {
          const ctx = signal ? { signal } : {};
          result = await tool.execute(tc.arguments, ctx);
          isError = false;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result = {
            content: [{ type: "text", text: `Tool "${tc.name}" failed: ${msg}` }],
            details: { error: msg },
          };
          isError = true;
        }
      }

      await emit({ type: "tool_execution_end", toolCallId: tc.id, toolName: tc.name, result, isError });

      const toolResult: ToolResultMessage = {
        role: "toolResult",
        toolCallId: tc.id,
        toolName: tc.name,
        content: result.content,
        isError,
        timestamp: Date.now(),
      };
      messages.push(toolResult);
    }

    await emit({ type: "turn_end" });
  }

  await emit({ type: "agent_end" });
  return messages;
}

/**
 * Stream a single assistant response from the provider. Collects text deltas
 * and tool calls, returns a complete AssistantMessage.
 */
async function streamAssistant(
  systemPrompt: string,
  messages: Message[],
  tools: AgentTool[],
  provider: ModelProvider,
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  const request: import("./contracts.ts").ModelRequest = {
    systemPrompt,
    messages,
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  };
  if (signal) request.signal = signal;
  const stream = await provider.stream(request);

  const textParts: string[] = [];
  const toolCalls: ToolCallContent[] = [];
  let stopReason: AssistantMessage["stopReason"] = "stop";
  let errorMessage: string | undefined;

  for await (const event of stream) {
    switch (event.type) {
      case "text_delta":
        textParts.push(event.text);
        break;
      case "tool_call":
        toolCalls.push({
          type: "toolCall",
          id: event.id,
          name: event.name,
          arguments: event.arguments,
        });
        break;
      case "done":
        stopReason = event.stopReason;
        errorMessage = event.errorMessage;
        break;
      case "error":
        stopReason = "error";
        errorMessage = event.message;
        break;
    }
  }

  const content: (TextContent | ToolCallContent)[] = [];
  if (textParts.length > 0) {
    content.push({ type: "text", text: textParts.join("") });
  }
  content.push(...toolCalls);

  const msg: AssistantMessage = {
    role: "assistant",
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    stopReason,
    timestamp: Date.now(),
  };
  if (errorMessage !== undefined) msg.errorMessage = errorMessage;
  return msg;
}
