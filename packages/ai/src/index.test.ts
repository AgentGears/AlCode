// Tests for @alcode/ai — mock provider and config resolution.
// No network, no credentials required.

import { describe, expect, it } from "vitest";
import { MockProvider, resolveProviderConfig, liveCredentialsAvailable, ProviderError } from "./index.ts";
import type { ModelRequest, Message } from "@alcode/agent-core";

function makeRequest(): ModelRequest {
  return {
    systemPrompt: "",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }] as readonly Message[],
    tools: [],
  };
}

describe("MockProvider", () => {
  it("streams a text response", async () => {
    const provider = new MockProvider([{ text: "hello" }]);
    const stream = await provider.stream(makeRequest());
    const events = [];
    for await (const e of stream) events.push(e);

    expect(events[0]).toEqual({ type: "text_delta", text: "hello" });
    expect(events[1]).toEqual({ type: "done", stopReason: "stop" });
  });

  it("streams a tool call response", async () => {
    const provider = new MockProvider([
      { text: "calling", toolCalls: [{ id: "tc1", name: "bash", arguments: { command: "echo hi" } }] },
    ]);
    const stream = await provider.stream(makeRequest());
    const events = [];
    for await (const e of stream) events.push(e);

    expect(events[0]).toEqual({ type: "text_delta", text: "calling" });
    expect(events[1]).toEqual({ type: "tool_call", id: "tc1", name: "bash", arguments: { command: "echo hi" } });
    expect(events[2]).toEqual({ type: "done", stopReason: "tool_use" });
  });

  it("streams an error", async () => {
    const provider = new MockProvider([{ errorMessage: "rate limited" }]);
    const stream = await provider.stream(makeRequest());
    const events = [];
    for await (const e of stream) events.push(e);

    expect(events[0]).toEqual({ type: "error", message: "rate limited" });
  });

  it("returns empty response when responses are exhausted", async () => {
    const provider = new MockProvider([]);
    const stream = await provider.stream(makeRequest());
    const events = [];
    for await (const e of stream) events.push(e);

    expect(events[0]).toEqual({ type: "done", stopReason: "stop" });
  });
});

describe("resolveProviderConfig", () => {
  it("resolves API key from env var", () => {
    const oldVal = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    try {
      const config = resolveProviderConfig("anthropic", "claude-sonnet-4-20250514");
      expect(config.provider).toBe("anthropic");
      expect(config.model).toBe("claude-sonnet-4-20250514");
      expect(config.apiKey).toBe("sk-test-key");
    } finally {
      if (oldVal === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = oldVal;
    }
  });

  it("returns undefined apiKey when env is not set", () => {
    const oldVal = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const config = resolveProviderConfig("openai", "gpt-4");
      expect(config.apiKey).toBeUndefined();
    } finally {
      if (oldVal !== undefined) process.env.OPENAI_API_KEY = oldVal;
    }
  });

  it("honors overrides over env", () => {
    process.env.TESTPROV_API_KEY = "env-key";
    try {
      const config = resolveProviderConfig("testprov", "m1", { apiKey: "override-key" });
      expect(config.apiKey).toBe("override-key");
    } finally {
      delete process.env.TESTPROV_API_KEY;
    }
  });
});

describe("liveCredentialsAvailable", () => {
  it("returns false when no API key", () => {
    expect(liveCredentialsAvailable({ provider: "test", model: "m1" })).toBe(false);
  });

  it("returns true when API key is set", () => {
    expect(liveCredentialsAvailable({ provider: "test", model: "m1", apiKey: "sk-x" })).toBe(true);
  });
});

describe("ProviderError", () => {
  it("carries provider and status", () => {
    const err = new ProviderError("bad request", "anthropic", 400);
    expect(err.provider).toBe("anthropic");
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe("bad request");
  });
});
