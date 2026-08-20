import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ModelStream,
} from "@alcode/agent-core";
import {
  AnthropicProvider,
  ProviderAuthError,
  resolveProviderConfig,
} from "@alcode/ai";

interface ScriptedTurn {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  stopReason?: "stop" | "length" | "tool_use" | "error" | "aborted";
  errorMessage?: string;
}

class ScriptedWorkerProvider implements ModelProvider {
  private index = 0;

  constructor(private readonly turns: readonly ScriptedTurn[]) {}

  async stream(_request: ModelRequest): Promise<ModelStream> {
    const turn = this.turns[this.index++] ?? {
      text: "ALCODE Agent is idle.",
      stopReason: "stop" as const,
    };
    const events: ModelEvent[] = [];
    if (turn.text !== undefined) events.push({ type: "text_delta", text: turn.text });
    for (const call of turn.toolCalls ?? []) {
      events.push({
        type: "tool_call",
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      });
    }
    events.push({
      type: "done",
      stopReason: turn.stopReason ?? ((turn.toolCalls?.length ?? 0) > 0 ? "tool_use" : "stop"),
      ...(turn.errorMessage !== undefined ? { errorMessage: turn.errorMessage } : {}),
    });
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
}

function requiredEnvironment(name: string, purpose: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  throw new Error(`${purpose} is not configured. Set ${name}.`);
}

/**
 * Resolve the Agent-local model provider for the production coding path.
 *
 * Deterministic execution is opt-in through ALCODE_AGENT_SCRIPT. Otherwise a
 * production invocation must name its provider and model explicitly. There is
 * deliberately no fallback to TestModelProvider or any other mock provider.
 */
export function createConfiguredModelProvider(): ModelProvider {
  const script = process.env.ALCODE_AGENT_SCRIPT;
  if (script) {
    const parsed = JSON.parse(script) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("ALCODE_AGENT_SCRIPT must be a JSON array");
    }
    return new ScriptedWorkerProvider(parsed as ScriptedTurn[]);
  }

  const provider = requiredEnvironment(
    "ALCODE_PROVIDER",
    "Production model provider",
  ).toLowerCase();
  const model = requiredEnvironment(
    "ALCODE_MODEL",
    "Production model",
  );

  switch (provider) {
    case "anthropic": {
      const config = resolveProviderConfig(provider, model);
      if (!config.apiKey) {
        throw new ProviderAuthError(
          provider,
          "No API key configured for Anthropic provider. Set ANTHROPIC_API_KEY.",
        );
      }
      return new AnthropicProvider(config);
    }
    default:
      throw new Error(`Unsupported production model provider: ${provider}`);
  }
}
