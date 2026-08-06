// @alcode/test-provider — an offline, deterministic fake LLM provider for CI
// and tests. Never touches the network. See docs/phase-0-spec.md §0.1A.
//
// This is the minimal surface needed for Phase 0.0/0.1A. The real provider
// abstraction (Phase 0.1B) will define a richer interface; for now we ship
// the contract that lets `alcode -p "hello"` run without API keys.

/**
 * A single canned response keyed by a prompt substring (or "*" for default).
 * Tests configure these to make assertions deterministic.
 */
export interface CannedResponse {
  /** Matched against the prompt (case-sensitive substring). "*" = default. */
  match: string;
  /** The text the provider returns. */
  text: string;
}

export interface TestProviderConfig {
  /** Ordered list of canned responses; first match wins. "*" matches any. */
  responses: CannedResponse[];
  /** Optional latency simulation in ms. 0 by default (CI-friendly). */
  latencyMs?: number;
}

/**
 * The fake provider. `complete()` returns the first matching canned response
 * or throws if none matches and no default ("*") is configured.
 *
 * Determinism: the same config + prompt always yields the same text. No
 * randomness, no network, no clock dependence.
 */
export class TestProvider {
  constructor(private readonly config: TestProviderConfig) {}

  async complete(prompt: string): Promise<string> {
    if (this.config.latencyMs && this.config.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.config.latencyMs));
    }
    for (const r of this.config.responses) {
      if (r.match === "*" || prompt.includes(r.match)) {
        return r.text;
      }
    }
    throw new Error(
      `TestProvider: no canned response matches prompt (and no "*" default). ` +
        `Prompt was: "${prompt.slice(0, 60)}${prompt.length > 60 ? "…" : ""}"`,
    );
  }

  /** A provider that always returns the given text. */
  static constant(text: string): TestProvider {
    return new TestProvider({ responses: [{ match: "*", text }] });
  }
}
