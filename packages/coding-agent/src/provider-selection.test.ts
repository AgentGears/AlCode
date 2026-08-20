import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider, ProviderAuthError } from "@alcode/ai";
import { createProductionModelProvider } from "./provider-selection.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("P-01 production provider selection", () => {
  it("constructs the configured Anthropic provider without a network call", () => {
    vi.stubEnv("ALCODE_PROVIDER", "anthropic");
    vi.stubEnv("ALCODE_MODEL", "claude-test-model");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");

    expect(createProductionModelProvider()).toBeInstanceOf(AnthropicProvider);
  });

  it("fails explicitly when the production provider is not configured", () => {
    vi.stubEnv("ALCODE_PROVIDER", "");
    vi.stubEnv("ALCODE_MODEL", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    expect(() => createProductionModelProvider()).toThrow(
      "Production model provider is not configured. Set ALCODE_PROVIDER.",
    );
  });

  it("fails explicitly when the production model is not configured", () => {
    vi.stubEnv("ALCODE_PROVIDER", "anthropic");
    vi.stubEnv("ALCODE_MODEL", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");

    expect(() => createProductionModelProvider()).toThrow(
      "Production model is not configured. Set ALCODE_MODEL.",
    );
  });

  it("fails explicitly when Anthropic credentials are missing", () => {
    vi.stubEnv("ALCODE_PROVIDER", "anthropic");
    vi.stubEnv("ALCODE_MODEL", "claude-test-model");
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    expect(() => createProductionModelProvider()).toThrow(ProviderAuthError);
    expect(() => createProductionModelProvider()).toThrow(
      "No API key configured for Anthropic provider. Set ANTHROPIC_API_KEY.",
    );
  });

  it("rejects unsupported production providers instead of falling back to a mock", () => {
    vi.stubEnv("ALCODE_PROVIDER", "unknown-provider");
    vi.stubEnv("ALCODE_MODEL", "some-model");

    expect(() => createProductionModelProvider()).toThrow(
      "Unsupported production model provider: unknown-provider",
    );
  });
});
