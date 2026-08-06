// Adapter: wraps @alcode/test-provider's TestProvider into the
// @alcode/agent-core ModelProvider interface.

import { TestProvider, type CannedResponse } from "@alcode/test-provider";
import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ModelStream,
} from "@alcode/agent-core";

/**
 * A canned model response. Either plain text or a tool call.
 * Used by TestModelProvider to script deterministic agent behavior.
 */
export interface CannedModelResponse {
  /** Matched against the last user message text (substring). "*" = default. */
  match: string;
  /** Plain text to return. */
  text?: string;
  /** A tool call to emit instead of (or alongside) text. */
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
}

/**
 * An offline, deterministic ModelProvider backed by canned responses.
 * Never touches the network. Used by tests and the CLI `-p` path.
 */
export class TestModelProvider implements ModelProvider {
  private readonly inner: TestProvider;
  private callCount = 0;
  constructor(private readonly responses: CannedModelResponse[]) {
    // Convert to the flat TestProvider format for plain-text matches.
    const flat: CannedResponse[] = responses
      .filter((r) => r.text !== undefined)
      .map((r) => ({ match: r.match, text: r.text! }));
    this.inner = new TestProvider({ responses: flat.length > 0 ? flat : [{ match: "*", text: "" }] });
  }

  async stream(request: ModelRequest): Promise<ModelStream> {
    // Find the last user message to match against.
    const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
    const prompt = lastUser?.content?.find((c) => c.type === "text");
    const promptText = (prompt as { text?: string } | undefined)?.text ?? "";

    // On the first call, match against the prompt text (may return a tool call).
    // On subsequent calls (after tool results), skip responses that already
    // emitted a tool call — otherwise the same tool call repeats forever.
    this.callCount++;
    let matched: CannedModelResponse | undefined;
    for (const r of this.responses) {
      if (this.callCount > 1 && r.toolCall) continue; // skip tool-call responses after first turn
      if (r.match === "*" || promptText.includes(r.match)) {
        matched = r;
        break;
      }
    }
    if (!matched) {
      // Fallback to inner TestProvider for plain text.
      const text = await this.inner.complete(promptText);
      return streamFromEvents([{ type: "text_delta", text }, { type: "done", stopReason: "stop" }]);
    }

    const events: ModelEvent[] = [];
    if (matched.text) events.push({ type: "text_delta", text: matched.text });
    if (matched.toolCall) {
      events.push({ type: "tool_call", id: matched.toolCall.id, name: matched.toolCall.name, arguments: matched.toolCall.arguments });
    }
    events.push({ type: "done", stopReason: matched.toolCall ? "tool_use" : "stop" });
    return streamFromEvents(events);
  }
}

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
