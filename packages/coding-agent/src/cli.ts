#!/usr/bin/env node
// alcode CLI — Phase 0.1A entrypoint.
//
// Usage:
//   alcode -p "hello"
//
// Uses the offline TestModelProvider (no network, no API keys). The bash
// tool is available and scoped to the current working directory. A static
// extension host is mounted to prove the seam.

import { parseArgs } from "node:util";
import { runAgentLoop, StaticExtensionHost, type AgentExtension } from "@alcode/agent-core";
import { TestModelProvider } from "./test-model-provider.ts";
import { createBashTool } from "./tools/bash.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      prompt: { type: "string", short: "p" },
    },
    allowPositionals: false,
  });

  const prompt = values.prompt;
  if (!prompt) {
    console.error("Usage: alcode -p \"<prompt>\"");
    process.exit(1);
  }

  // --- Static extension host ---
  const host = new StaticExtensionHost();

  // A minimal extension that registers the bash tool.
  const bashExtension: AgentExtension = {
    name: "bash-tool",
    register(ctx) {
      ctx.registerTool(
        createBashTool({ workingDirectory: process.cwd() }),
      );
    },
  };

  await host.mount([bashExtension]);

  // --- Offline provider ---
  const provider = new TestModelProvider([
    { match: "hello", text: "Hello from ALCODE. The agent loop is running." },
    { match: "*", text: "ALCODE received your prompt." },
  ]);

  // --- Run ---
  const messages = await runAgentLoop(prompt, {
    systemPrompt: "You are ALCODE, a memory-native coding agent.",
    provider,
    tools: host.getTools(),
    emit(event) {
      if (event.type === "message_end" && event.message.role === "assistant") {
        const text = event.message.content.find((c) => c.type === "text");
        if (text && "text" in text && text.text) {
          console.log(text.text);
        }
      }
    },
  });

  // Suppress unused-warning; messages are available for future durable integration.
  void messages;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
