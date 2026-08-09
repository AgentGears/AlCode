// @alcode/ai — provider adapter layer.
//
// Owns: provider configuration, authentication/env resolution, provider-specific
// request conversion, stream normalization, provider errors, model metadata.
//
// Translates everything back into agent-core's ModelProvider contract:
// ModelRequest → ModelStream → ModelEvent.
//
// Default tests use mocked/deterministic transports. Live-provider smoke
// tests are opt-in (never required by default CI).
//
// See docs/adr/0005-runtime-ownership-boundaries.md §Host↔Agent.

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  /** Provider identifier (e.g. "anthropic", "openai"). */
  provider: string;
  /** Model identifier (e.g. "claude-sonnet-4-20250514"). */
  model: string;
  /** API key (from config or env). Undefined if not configured. */
  apiKey?: string;
  /** Base URL override (for proxies, Azure, etc.). */
  baseURL?: string;
  /** Max output tokens. */
  maxTokens?: number;
  /** Temperature. */
  temperature?: number;
}

// ---------------------------------------------------------------------------
// Provider resolution from environment
// ---------------------------------------------------------------------------

/**
 * Resolve provider configuration from environment variables.
 * Looks for standard env var patterns per provider.
 */
export function resolveProviderConfig(
  provider: string,
  model: string,
  overrides?: Partial<ProviderConfig>,
): ProviderConfig {
  const envKey = `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
  const envApiKey = process.env[envKey];
  const apiKey = overrides?.apiKey ?? (envApiKey && envApiKey.length > 0 ? envApiKey : undefined);

  const envBaseURL = process.env[`${provider.toUpperCase().replace(/-/g, "_")}_BASE_URL`];
  const baseURL = overrides?.baseURL ?? (envBaseURL && envBaseURL.length > 0 ? envBaseURL : undefined);

  const config: ProviderConfig = { provider, model };
  if (apiKey !== undefined) config.apiKey = apiKey;
  if (baseURL !== undefined) config.baseURL = baseURL;
  if (overrides?.maxTokens !== undefined) config.maxTokens = overrides.maxTokens;
  if (overrides?.temperature !== undefined) config.temperature = overrides.temperature;
  return config;
}

// ---------------------------------------------------------------------------
// Provider errors
// ---------------------------------------------------------------------------

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class ProviderAuthError extends ProviderError {
  constructor(provider: string, message = "Authentication failed") {
    super(message, provider, 401);
    this.name = "ProviderAuthError";
  }
}

// ---------------------------------------------------------------------------
// Mock/deterministic provider (for tests, no network)
// ---------------------------------------------------------------------------

import type {
  ModelProvider,
  ModelRequest,
  ModelStream,
  ModelEvent,
} from "@alcode/agent-core";

export interface MockResponse {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  stopReason?: "stop" | "tool_use" | "length" | "error" | "aborted";
  errorMessage?: string;
}

/**
 * A mock provider that returns scripted responses. Deterministic — no network,
 * no credentials. Used by tests and as the default when no live provider is
 * configured.
 */
export class MockProvider implements ModelProvider {
  private responses: MockResponse[];
  private callIndex = 0;

  constructor(responses: MockResponse[]) {
    this.responses = responses;
  }

  async stream(request: ModelRequest): Promise<ModelStream> {
    const response = this.responses[this.callIndex] ?? { text: "", stopReason: "stop" };
    this.callIndex++;

    const events: ModelEvent[] = [];

    if (response.errorMessage) {
      events.push({ type: "error", message: response.errorMessage });
      return streamFromEvents(events);
    }

    if (response.text) {
      events.push({ type: "text_delta", text: response.text });
    }

    if (response.toolCalls) {
      for (const tc of response.toolCalls) {
        events.push({
          type: "tool_call",
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        });
      }
    }

    events.push({
      type: "done",
      stopReason: response.stopReason ?? (response.toolCalls ? "tool_use" : "stop"),
    });

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

// ---------------------------------------------------------------------------
// Live provider smoke test (opt-in, never in default CI)
// ---------------------------------------------------------------------------

/**
 * Check whether live provider credentials are available for smoke tests.
 * Returns false in default CI (no credentials in env).
 */
export function liveCredentialsAvailable(config: ProviderConfig): boolean {
  return config.apiKey !== undefined && config.apiKey.length > 0;
}

// Live provider adapter (Anthropic)
export { AnthropicProvider } from "./anthropic-provider.ts";
