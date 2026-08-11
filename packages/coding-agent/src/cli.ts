#!/usr/bin/env node
// alcode CLI — Host-owned Phase 0.5 entrypoint.
//
// The durable Host path owns workspace/store/capability authority when the
// native local-runtime dependencies are available. The closed Phase 0.1A
// deterministic `-p` contract remains usable in environments that explicitly
// install with native build scripts disabled (the historical Windows CI path).

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  runAgentLoop,
  StaticExtensionHost,
  type AgentExtension,
} from "@alcode/agent-core";
import { TestModelProvider } from "./test-model-provider.ts";
import { createBashTool } from "./tools/bash.ts";

const SYSTEM_PROMPT = "You are ALCODE, a memory-native coding agent.";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

function isUnavailableNativeRuntime(error: unknown): boolean {
  const text = error instanceof Error
    ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
    : String(error);
  return text.includes("Could not locate the bindings file")
    || text.includes("better_sqlite3.node")
    || text.includes("fs_ext.node")
    || text.includes("NODE_MODULE_VERSION");
}

async function runOfflineCompatibility(prompt: string): Promise<void> {
  const extensionHost = new StaticExtensionHost();
  const bashExtension: AgentExtension = {
    name: "bash-tool",
    register(ctx) {
      ctx.registerTool(createBashTool({ workingDirectory: process.cwd() }));
    },
  };
  await extensionHost.mount([bashExtension]);

  const provider = new TestModelProvider([
    { match: "hello", text: "Hello from ALCODE. The agent loop is running." },
    { match: "*", text: "ALCODE received your prompt." },
  ]);

  await runAgentLoop(prompt, {
    systemPrompt: SYSTEM_PROMPT,
    provider,
    tools: extensionHost.getTools(),
    emit(event) {
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      const text = event.message.content.find((content) => content.type === "text");
      if (text && "text" in text && text.text) console.log(text.text);
    },
  });
}

async function runDurableHost(prompt: string): Promise<void> {
  // Keep the native Host/storage/workspace graph behind the guarded boundary.
  // Windows Phase 0.1B intentionally installs with --ignore-scripts; if those
  // native bindings are unavailable, this import/boot path may fail and the
  // caller can preserve the closed deterministic offline contract.
  const [
    { AgentSupervisor, DefaultHostPolicy, HostRuntime },
    { openLockedWorkspaceStore },
    { WorkspaceRegistry, resolveAlcodeHome },
    { createLocalWorkspace },
    { createDefaultHostCapabilities },
  ] = await Promise.all([
    import("@alcode/host-runtime"),
    import("@alcode/storage"),
    import("@alcode/workspace"),
    import("./capabilities/local-workspace.ts"),
    import("./host-capabilities.ts"),
  ]);

  const alcodeHome = resolveAlcodeHome();
  mkdirSync(alcodeHome, { recursive: true });
  const registry = new WorkspaceRegistry(alcodeHome);
  const resolution = registry.resolve(process.cwd());
  const workspaceEntry = registry.getWorkspace(resolution.workspaceId);
  if (!workspaceEntry) {
    throw new Error(`Workspace registry lost resolved workspace ${resolution.workspaceId}`);
  }
  mkdirSync(dirname(workspaceEntry.dbPath), { recursive: true });

  const workspace = createLocalWorkspace({
    workspaceId: resolution.workspaceId,
    repositoryId: resolution.repositoryId,
    root: process.cwd(),
  });
  const lockedStore = await openLockedWorkspaceStore({
    databasePath: workspaceEntry.dbPath,
    lockPath: workspaceEntry.lockPath,
    workspaceId: resolution.workspaceId,
    repositoryId: resolution.repositoryId,
  });

  const capabilities = createDefaultHostCapabilities(workspace);
  const host = new HostRuntime({
    store: lockedStore,
    capabilities,
    policy: new DefaultHostPolicy({
      knownTools: capabilities.map((capability) => capability.name),
      // Preserve the historical CLI's tool availability. User-facing
      // permission prompts are intentionally deferred beyond Phase 0.5.
      allowMutations: true,
    }),
  });
  const workerEntrypoint = fileURLToPath(new URL("./agent-worker.ts", import.meta.url));
  const supervisor = new AgentSupervisor({
    entrypoint: workerEntrypoint,
    cwd: process.cwd(),
    execArgv: ["--import", "tsx"],
  });

  let session: Awaited<ReturnType<typeof host.openOrResumeSession>> | null = null;
  try {
    await host.startup();
    session = await host.openOrResumeSession();
    const connection = await supervisor.start();

    let removeAssistantListener = () => {};
    const assistantText = new Promise<string>((resolve) => {
      removeAssistantListener = connection.transport.onMessage((message) => {
        if (message.type !== "assistant.message" || message.sessionId !== (session!.sessionId as string)) return;
        removeAssistantListener();
        resolve(message.text);
      });
    });

    await host.attachAgent(connection, session, SYSTEM_PROMPT);
    await host.sendInput(connection.transport, session.sessionId, prompt);

    const text = await withTimeout(assistantText, 15000, "assistant response");
    console.log(text);

    // The Agent's idle signal is evidence; wait until the Host has performed
    // the authoritative session stop before tearing down the runtime.
    await withTimeout((async () => {
      while (true) {
        if ((await host.sessions.getState(session!.sessionId)).stopped) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })(), 15000, "Host completion");
  } finally {
    await supervisor.shutdown("host_shutdown").catch(() => undefined);
    if (session) {
      const state = await host.sessions.getState(session.sessionId).catch(() => null);
      if (state?.started && !state.stopped) {
        await host.sessions.stop(session.sessionId, "host_shutdown").catch(() => undefined);
      }
    }
    await host.shutdown().catch(() => undefined);
  }
}

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
    process.exitCode = 1;
    return;
  }

  try {
    await runDurableHost(prompt);
  } catch (error) {
    if (!isUnavailableNativeRuntime(error)) throw error;
    await runOfflineCompatibility(prompt);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
