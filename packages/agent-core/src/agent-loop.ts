// ALCODE-owned agent loop. Implements the same core semantics as pi v0.81.1's
// agent-loop.ts against owned contracts.

import type {
  AgentEventSink,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  ToolExecutionOutcome,
  AssistantMessage,
  Message,
  ModelProvider,
  ModelProviderObservation,
  TextContent,
  ToolCallContent,
  ToolResultMessage,
} from "./contracts.ts";

export interface InferenceContext {
  systemPrompt: string;
  messages: readonly Message[];
  /** Exact Host-authorized tools for this provider inference when refreshed. */
  tools?: readonly AgentTool[];
  /** Host-minted A2 causal identity; provenance only, never execution authority. */
  inferenceEpochId?: string;
}

export interface InferenceLifecycleResult {
  inferenceEpochId?: string;
  outcome: "completed" | "provider_error" | "aborted";
  stopReason?: AssistantMessage["stopReason"];
  providerObservation?: ModelProviderObservation;
}

export interface AgentLoopOptions {
  systemPrompt: string;
  provider: ModelProvider;
  tools: AgentTool[];
  maxSteps?: number;
  emit?: AgentEventSink;
  signal?: AbortSignal;
  /** Disposable durable-prefix cache supplied by the Host. Never mutated in place. */
  initialMessages?: readonly Message[];
  /** Canonical timestamp for the newly admitted user prompt. */
  promptTimestamp?: number;
  /**
   * Host-authority seam. When present, this is awaited immediately before
   * every provider inference, including subsequent tool-loop requests. The
   * returned system/messages/tools shape that one ModelRequest and the tool
   * calls formed by it; local Agent history remains disposable.
   */
  beforeInference?: (local: InferenceContext) => Promise<InferenceContext>;
  /**
   * Ephemeral inference-lifecycle seam. When present, this is awaited after
   * the provider inference and all tool calls formed by it settle, including
   * exceptional provider/tool-event paths. It owns no execution authority.
   */
  afterInference?: (result: InferenceLifecycleResult) => void | Promise<void>;
}

export async function runAgentLoop(
  prompt: string,
  options: AgentLoopOptions,
): Promise<AgentMessage[]> {
  const { systemPrompt, provider, tools, maxSteps = 50 } = options;
  const emit = options.emit ?? (() => {});
  const signal = options.signal;

  const messages: AgentMessage[] = [
    ...(options.initialMessages ?? []).map((message) => structuredClone(message)),
    {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: options.promptTimestamp ?? Date.now(),
    },
  ];

  await emit({ type: "agent_start" });

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) break;

    const localInference: InferenceContext = {
      systemPrompt,
      messages: (messages as Message[]).map((message) => structuredClone(message)),
      tools,
    };
    let authorized: InferenceContext;
    try {
      authorized = options.beforeInference
        ? await options.beforeInference(localInference)
        : localInference;
    } catch (error) {
      if (signal?.aborted) break;
      throw error;
    }

    const inferenceEpochId = authorized.inferenceEpochId;
    await emit({
      type: "turn_start",
      ...(inferenceEpochId !== undefined ? { inferenceEpochId } : {}),
    });

    if (signal?.aborted) {
      await options.afterInference?.({
        ...(inferenceEpochId !== undefined ? { inferenceEpochId } : {}),
        outcome: "aborted",
      });
      await emit({
        type: "turn_end",
        ...(inferenceEpochId !== undefined ? { inferenceEpochId } : {}),
      });
      break;
    }

    let finishAfterTurn = false;
    let lifecycle: InferenceLifecycleResult = {
      ...(inferenceEpochId !== undefined ? { inferenceEpochId } : {}),
      outcome: "provider_error",
    };
    try {
      const authorizedTools = authorized.tools ? [...authorized.tools] : tools;

      const streamed = await streamAssistant(
        authorized.systemPrompt,
        [...authorized.messages].map((message) => structuredClone(message)),
        authorizedTools,
        provider,
        signal,
      );
      const assistantMessage = streamed.message;
      lifecycle = {
        ...(inferenceEpochId !== undefined ? { inferenceEpochId } : {}),
        outcome: assistantMessage.stopReason === "aborted"
          ? "aborted"
          : assistantMessage.stopReason === "error" ? "provider_error" : "completed",
        stopReason: assistantMessage.stopReason,
        ...(streamed.providerObservation !== undefined
          ? { providerObservation: structuredClone(streamed.providerObservation) }
          : {}),
      };

      messages.push(assistantMessage);
      await emit({
        type: "message_start",
        message: assistantMessage,
        ...(inferenceEpochId !== undefined ? { inferenceEpochId } : {}),
      });
      await emit({
        type: "message_end",
        message: assistantMessage,
        ...(inferenceEpochId !== undefined ? { inferenceEpochId } : {}),
      });

      const toolCalls = assistantMessage.content.filter(
        (c): c is ToolCallContent => c.type === "toolCall",
      );

      if (toolCalls.length === 0 || assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
        finishAfterTurn = true;
      } else {
        for (const tc of toolCalls) {
          if (signal?.aborted) {
            lifecycle = { ...lifecycle, outcome: "aborted" };
            break;
          }
          await emit({
            type: "tool_execution_start",
            toolCallId: tc.id,
            toolName: tc.name,
            args: tc.arguments,
            ...(inferenceEpochId !== undefined ? { inferenceEpochId } : {}),
          });

          const tool = authorizedTools.find((t) => t.name === tc.name);
          let result: AgentToolResult;
          let isError: boolean;
          let outcome: ToolExecutionOutcome;

          if (!tool) {
            result = {
              content: [{ type: "text", text: `Tool "${tc.name}" not found in the Host-authorized inference catalog` }],
              details: { error: "tool_not_authorized_for_inference" },
            };
            isError = true;
            outcome = "failed";
          } else {
            try {
              const ctx = {
                ...(signal ? { signal } : {}),
                toolCallId: tc.id,
                ...(inferenceEpochId !== undefined ? { inferenceEpochId } : {}),
              };
              result = await tool.execute(tc.arguments, ctx);
              isError = false;
              outcome = result.executionOutcome ?? "succeeded";
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              result = {
                content: [{ type: "text", text: `Tool "${tc.name}" failed: ${msg}` }],
                details: { error: msg },
              };
              isError = true;
              outcome = "failed";
            }
          }

          await emit({
            type: "tool_execution_end",
            toolCallId: tc.id,
            toolName: tc.name,
            result,
            isError,
            outcome,
            ...(inferenceEpochId !== undefined ? { inferenceEpochId } : {}),
          });

          const toolResult: ToolResultMessage = {
            role: "toolResult",
            toolCallId: tc.id,
            toolName: tc.name,
            content: result.content,
            isError,
            timestamp: Date.now(),
          };
          messages.push(toolResult);
          await emit({
            type: "message_start",
            message: toolResult,
            ...(inferenceEpochId !== undefined ? { inferenceEpochId } : {}),
          });
          await emit({
            type: "message_end",
            message: toolResult,
            ...(inferenceEpochId !== undefined ? { inferenceEpochId } : {}),
          });
        }
      }
    } catch (error) {
      lifecycle = {
        ...lifecycle,
        outcome: signal?.aborted ? "aborted" : "provider_error",
      };
      throw error;
    } finally {
      await options.afterInference?.(lifecycle);
    }

    await emit({
      type: "turn_end",
      ...(inferenceEpochId !== undefined ? { inferenceEpochId } : {}),
    });
    if (finishAfterTurn) break;
  }

  await emit({ type: "agent_end" });
  return messages;
}

async function streamAssistant(
  systemPrompt: string,
  messages: Message[],
  tools: AgentTool[],
  provider: ModelProvider,
  signal?: AbortSignal,
): Promise<{ message: AssistantMessage; providerObservation?: ModelProviderObservation }> {
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
        toolCalls.push({ type: "toolCall", id: event.id, name: event.name, arguments: event.arguments });
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
  if (textParts.length > 0) content.push({ type: "text", text: textParts.join("") });
  content.push(...toolCalls);

  const msg: AssistantMessage = {
    role: "assistant",
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    stopReason,
    timestamp: Date.now(),
  };
  if (errorMessage !== undefined) msg.errorMessage = errorMessage;
  return {
    message: msg,
    ...(stream.providerObservation !== undefined
      ? { providerObservation: structuredClone(stream.providerObservation) }
      : {}),
  };
}
