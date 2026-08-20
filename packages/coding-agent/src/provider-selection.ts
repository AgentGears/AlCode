import type { ModelProvider } from "@alcode/agent-core";
import {
  AnthropicProvider,
  ProviderAuthError,
  resolveProviderConfig,
} from "@alcode/ai";

function requiredEnvironment(name: string, purpose: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  throw new Error(`${purpose} is not configured. Set ${name}.`);
}

/**
 * Resolve the Agent-local production provider. Deterministic scripted execution
 * is owned by the caller/profile and never falls through to this function.
 */
export function createProductionModelProvider(): ModelProvider {
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
