#!/usr/bin/env node
// alcode CLI — Host-owned Phase 0.5 entrypoint.
//
// The CLI now boots the durable Host control plane, resolves/locks the current
// workspace, starts a replaceable Agent child process, and exposes coding tools
// to that Agent only as Host-backed protocol proxies. The default provider in
// the Agent remains the closed Phase 0.1A deterministic offline provider.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  AgentSupervisor,
  DefaultHostPolicy,
  HostRuntime,
} from "@alcode/host-runtime";
import { openLockedWorkspaceStore } from "@alcode/storage";
import { WorkspaceRegistry, resolveAlcodeHome } from "@alcode/workspace";
import { createLocalWorkspace } from "./capabilities/local-workspace.ts";
import { createDefaultHostCapabilities } from "./host-capabilities.ts";

const SYSTEM_PROMPT = "You are ALCODE, a memory-native coding agent.";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
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

  let sessionId: Awaited<ReturnType<typeof host.openOrResumeSession>>["sessionId"] | null = null;
  try {
    await host.startup();
    const session = await host.openOrResumeSession();
    sessionId = session.sessionId;
    const connection = await supervisor.start();

    let removeAssistantListener = () => {};
    const assistantText = new Promise<string>((resolve) => {
      removeAssistantListener = connection.transport.onMessage((message) => {
        if (message.type !== "assistant.message" || message.sessionId !== (session.sessionId as string)) return;
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
        if ((await host.sessions.getState(session.sessionId)).stopped) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })(), 15000, "Host completion");
  } finally {
    await supervisor.shutdown("host_shutdown").catch(() => undefined);
    if (sessionId) {
      const state = await host.sessions.getState(sessionId).catch(() => null);
      if (state?.started && !state.stopped) {
        await host.sessions.stop(sessionId, "host_shutdown").catch(() => undefined);
      }
    }
    await host.shutdown().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
