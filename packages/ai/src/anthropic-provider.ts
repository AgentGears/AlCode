// Owned Anthropic Messages API adapter.
//
// Implements the ModelProvider contract from @alcode/agent-core against the
// Anthropic Messages API (POST /v1/messages with SSE streaming).
//
// This is a fresh TypeScript implementation using fetch(). It does not import
// any pi code. The protocol facts are derived from the Anthropic API docs and
// the pi reference implementation (see packages/agent-core/src/imported/ai/).
//
// See docs/adr/0005-runtime-ownership-boundaries.md §Host↔Agent.

import type {
  ModelProvider,
  ModelRequest,
  ModelStream,
  ModelEvent,
  Message,
  ToolDefinition,
} from "@alcode/agent-core";
import { ProviderError, type ProviderConfig } from "./index.ts";

// ---------------------------------------------------------------------------
// Anthropic request types (owned, not imported)
// ---------------------------------------------------------------------------

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface AnthropicRequestBody {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  stream: true;
  system?: string;
  temperature?: number;
  tools?: AnthropicTool[];
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

function sanitizeToolId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertMessages(messages: readonly Message[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const textParts = msg.content.filter((c) => c.type === "text");
      const text = textParts.map((c) => (c as { text: string }).text).join("");
      result.push({ role: "user", content: text });
    } else if (msg.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      for (const c of msg.content) {
        if (c.type === "text") {
          blocks.push({ type: "text", text: (c as { text: string }).text });
        } else if (c.type === "toolCall") {
          const tc = c as { id: string; name: string; arguments: Record<string, unknown> };
          blocks.push({
            type: "tool_use",
            id: sanitizeToolId(tc.id),
            name: tc.name,
            input: tc.arguments,
          });
        }
      }
      result.push({ role: "assistant", content: blocks });
    } else if (msg.role === "toolResult") {
      const tr = msg as { toolCallId: string; content: Array<{ type: string; text?: string }>; isError: boolean };
      const text = tr.content.map((c) => c.text ?? "").join("");
      result.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: sanitizeToolId(tr.toolCallId),
          content: text,
          ...(tr.isError ? { is_error: true } : {}),
        }],
      });
    }
  }

  return result;
}

function convertTools(tools: readonly ToolDefinition[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: "object" as const,
      properties: t.inputSchema.properties,
      ...(t.inputSchema.required ? { required: t.inputSchema.required } : {}),
    },
  }));
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

interface SseEvent {
  event: string;
  data: string;
}

async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let currentData = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line === "") {
          if (currentData) {
            yield { event: currentEvent || "message", data: currentData };
          }
          currentEvent = "";
          currentData = "";
        } else if (line.startsWith(":")) {
          // Comment — ignore
        } else if (line.startsWith("event:")) {
          currentEvent = line.substring(6).trim();
        } else if (line.startsWith("data:")) {
          const data = line.substring(5).trim();
          currentData = currentData ? currentData + "\n" + data : data;
        }
      }
    }

    if (currentData) {
      yield { event: currentEvent || "message", data: currentData };
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Stop reason mapping
// ---------------------------------------------------------------------------

type MappedStopReason = "stop" | "length" | "tool_use" | "error" | "aborted";

function mapStopReason(reason: string): MappedStopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_use";
    case "refusal":
    case "sensitive":
      return "error";
    default:
      return "stop";
  }
}

// ---------------------------------------------------------------------------
// AnthropicProvider — live ModelProvider implementation
// ---------------------------------------------------------------------------

/** Tracks a tool-use block as its JSON input streams in incrementally. */
interface PendingToolCall {
  id: string;
  name: string;
  partialJson: string;
}

/**
 * A live Anthropic Messages API provider. Implements ModelProvider via fetch()
 * and SSE stream parsing. Requires an API key (from config or ANTHROPIC_API_KEY).
 *
 * No pi dependency. The adapter translates ModelRequest → Anthropic Messages
 * API request, parses the SSE response into ModelEvents (text deltas, tool
 * calls, done/stop-reason), and handles errors via ProviderError.
 */
export class AnthropicProvider implements ModelProvider {
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async stream(request: ModelRequest): Promise<ModelStream> {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new ProviderError("No API key configured for Anthropic provider", "anthropic", 401);
    }

    const baseURL = this.config.baseURL ?? "https://api.anthropic.com";
    const url = `${baseURL}/v1/messages`;
    const isOAuth = apiKey.includes("sk-ant-oat");

    const body: AnthropicRequestBody = {
      model: this.config.model,
      messages: convertMessages(request.messages),
      max_tokens: this.config.maxTokens ?? 8192,
      stream: true,
    };

    if (request.systemPrompt) body.system = request.systemPrompt;
    if (this.config.temperature !== undefined) body.temperature = this.config.temperature;
    if (request.tools.length > 0) body.tools = convertTools(request.tools);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      accept: "application/json",
    };

    if (isOAuth) headers["authorization"] = `Bearer ${apiKey}`;
    else headers["x-api-key"] = apiKey;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (e) {
      if (request.signal?.aborted) {
        return streamFromEvents([{ type: "done", stopReason: "aborted" }]);
      }
      throw new ProviderError(
        `Network error: ${e instanceof Error ? e.message : String(e)}`,
        "anthropic",
      );
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "unknown error");
      throw new ProviderError(
        `Anthropic API error (${response.status}): ${errorBody.slice(0, 500)}`,
        "anthropic",
        response.status,
      );
    }

    if (!response.body) {
      throw new ProviderError("No response body from Anthropic API", "anthropic");
    }

    // Single-pass SSE parse: collect ModelEvents as we go.
    const events: ModelEvent[] = [];
    const pendingTools = new Map<number, PendingToolCall>();
    let sawMessageStart = false;
    let sawMessageStop = false;
    let stopReason: MappedStopReason = "stop";

    for await (const sse of parseSseStream(response.body)) {
      if (sse.event === "error") {
        throw new ProviderError(`Anthropic stream error: ${sse.data}`, "anthropic");
      }

      let data: Record<string, unknown>;
      try { data = JSON.parse(sse.data); } catch { continue; }

      switch (sse.event) {
        case "message_start":
          sawMessageStart = true;
          break;

        case "content_block_start": {
          const idx = data.index as number;
          const block = data.content_block as { type: string; id?: string; name?: string; text?: string };
          if (block?.type === "text" && block.text) {
            events.push({ type: "text_delta", text: block.text });
          } else if (block?.type === "tool_use" && block.id && block.name) {
            pendingTools.set(idx, { id: block.id, name: block.name, partialJson: "" });
          }
          break;
        }

        case "content_block_delta": {
          const delta = data.delta as { type: string; text?: string; partial_json?: string };
          if (delta?.type === "text_delta" && delta.text) {
            events.push({ type: "text_delta", text: delta.text });
          } else if (delta?.type === "input_json_delta" && delta.partial_json) {
            const idx = data.index as number;
            const pending = pendingTools.get(idx);
            if (pending) pending.partialJson += delta.partial_json;
          }
          break;
        }

        case "content_block_stop": {
          const idx = data.index as number;
          const pending = pendingTools.get(idx);
          if (pending) {
            let args: Record<string, unknown> = {};
            if (pending.partialJson) {
              try { args = JSON.parse(pending.partialJson); } catch { /* keep empty */ }
            }
            events.push({
              type: "tool_call",
              id: pending.id,
              name: pending.name,
              arguments: args,
            });
            pendingTools.delete(idx);
          }
          break;
        }

        case "message_delta": {
          const delta = data.delta as { stop_reason?: string };
          if (delta?.stop_reason) stopReason = mapStopReason(delta.stop_reason);
          break;
        }

        case "message_stop":
          sawMessageStop = true;
          break;
      }
    }

    if (sawMessageStart && !sawMessageStop) {
      throw new ProviderError("Anthropic stream ended before message_stop", "anthropic");
    }

    events.push({ type: "done", stopReason });
    return streamFromEvents(events);
  }
}

// ---------------------------------------------------------------------------
// Stream helper
// ---------------------------------------------------------------------------

function streamFromEvents(events: ModelEvent[]): ModelStream {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next(): Promise<IteratorResult<ModelEvent>> {
          if (i < events.length) {
            return Promise.resolve({ value: events[i++]!, done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}
