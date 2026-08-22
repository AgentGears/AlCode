#!/usr/bin/env node
// alcode CLI — default Program-backed local coding entrypoint.

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, readlink, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  AgentSupervisor,
  DefaultHostPolicy,
  HostArtifactStore,
  createProgramExecutionRuntimeV1,
  type ProgramExecutionObservationSourceV1,
} from "@alcode/host-runtime";
import { openLockedWorkspaceStore } from "@alcode/storage";
import { WorkspaceRegistry } from "@alcode/workspace";
import { createDefaultHostCapabilities } from "./host-capabilities.ts";
import { createLocalWorkspace } from "./capabilities/local-workspace.ts";
import { createLocalPlanningReadRegistry } from "./planning-read-catalog.ts";
import { createDefaultProgramVerifierConfiguration } from "./verification-profile.ts";

const SYSTEM_PROMPT = "You are ALCODE, a memory-native coding agent.";
const APPLICATION_PROTOCOL_VERSION = 1 as const;
const LOCAL_OBSERVATION_PROVIDER = "alcode-local-workspace-v1";
const LOCAL_COVERAGE_IDENTITY = "alcode-local-workspace-complete-v1";
const WAIT_TIMEOUT_MS = 20_000;
const FALLBACK_MAX_ENTRIES = 20_000;
const FALLBACK_MAX_BYTES = 64 * 1024 * 1024;

async function fallbackWorkspaceDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  let entriesSeen = 0;
  let bytesSeen = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      if (prefix === "" && entry.name === ".git") continue;
      entriesSeen += 1;
      if (entriesSeen > FALLBACK_MAX_ENTRIES) throw new Error("workspace observation entry bound exceeded");
      const absolute = join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        hash.update(`L\0${relative}\0${await readlink(absolute)}\0`);
      } else if (stat.isDirectory()) {
        hash.update(`D\0${relative}\0`);
        await walk(absolute, relative);
      } else if (stat.isFile()) {
        const bytes = await readFile(absolute);
        bytesSeen += bytes.byteLength;
        if (bytesSeen > FALLBACK_MAX_BYTES) throw new Error("workspace observation byte bound exceeded");
        hash.update(`F\0${relative}\0${bytes.byteLength}\0`);
        hash.update(bytes);
      } else {
        hash.update(`O\0${relative}\0${stat.mode}\0`);
      }
    }
  };
  await walk(root, "");
  return hash.digest("hex");
}

async function workspaceStateDigest(root: string): Promise<string> {
  try {
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const status = execFileSync("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return createHash("sha256").update("git-head-status-v1\0").update(head).update("\0").update(status).digest("hex");
  } catch {
    return fallbackWorkspaceDigest(root);
  }
}

async function waitFor<T>(description: string, read: () => Promise<T | undefined>, agentError: () => Error | undefined): Promise<T> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const error = agentError();
    if (error) throw error;
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function confirmProgram(objective: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Program creation requires explicit Application acceptance. Re-run with --accept-program for non-interactive execution.");
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(`Accept Program \"${objective}\"? [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      prompt: { type: "string", short: "p" },
      "accept-program": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const prompt = values.prompt;
  if (!prompt) {
    console.error("Usage: alcode -p \"<prompt>\" [--accept-program]");
    process.exitCode = 1;
    return;
  }

  const root = process.cwd();
  const registry = new WorkspaceRegistry();
  const resolution = registry.resolve(root);
  const workspaceEntry = registry.getWorkspace(resolution.workspaceId);
  if (!workspaceEntry) throw new Error(`Workspace ${resolution.workspaceId} is missing from the registry`);
  const locked = await openLockedWorkspaceStore({
    databasePath: workspaceEntry.dbPath,
    lockPath: workspaceEntry.lockPath,
    workspaceId: String(workspaceEntry.workspaceId),
    repositoryId: workspaceEntry.repositoryId,
  });
  const workspace = createLocalWorkspace({
    workspaceId: String(workspaceEntry.workspaceId),
    repositoryId: workspaceEntry.repositoryId,
    root,
  });
  const capabilities = createDefaultHostCapabilities(workspace);

  const observations: ProgramExecutionObservationSourceV1 = {
    observe: async () => {
      try {
        let workspaceEffectGeneration = 0;
        for await (const event of locked.store.replay()) {
          if (event.type !== "workspace.effect_generation.advanced") continue;
          const value = (event.payload as { workspaceEffectGeneration?: unknown }).workspaceEffectGeneration;
          if (typeof value === "number" && Number.isSafeInteger(value) && value >= workspaceEffectGeneration) {
            workspaceEffectGeneration = value;
          }
        }
        return {
          status: "complete",
          base: {
            workspaceEffectGeneration,
            observation: {
              kind: "workspace-observation-v1",
              providerKind: LOCAL_OBSERVATION_PROVIDER,
              workspaceIdentity: locked.store.workspaceId,
              coverageDigest: LOCAL_COVERAGE_IDENTITY,
              stateDigest: await workspaceStateDigest(root),
            },
          },
        } as const;
      } catch (error) {
        return { status: "unknown", reason: error instanceof Error ? error.message : String(error) } as const;
      }
    },
  };

  const verifierConfiguration = createDefaultProgramVerifierConfiguration({
    root,
    capabilities,
    observations,
  });

  const runtime = createProgramExecutionRuntimeV1({
    host: {
      store: locked,
      capabilities,
      policy: new DefaultHostPolicy({ knownTools: capabilities.map((capability) => capability.name), allowMutations: true }),
    },
    planningReads: createLocalPlanningReadRegistry(workspace),
    creationPolicy: {
      current: () => ({ generation: "alcode-cli-policy-v1", digest: "alcode-cli-policy-v1", requirements: [] }),
    },
    executionObservationProfiles: {
      current: () => ({ profileId: "workspace-observation-v1", profileVersion: 1, coverageIdentity: LOCAL_COVERAGE_IDENTITY }),
      validate: () => undefined,
    },
    observations,
    pathObservations: verifierConfiguration.pathObservations,
    operationSpecs: verifierConfiguration.operationSpecs,
    verifierCatalog: verifierConfiguration.verifierCatalog,
    artifactStore: new HostArtifactStore({ root: join(dirname(workspaceEntry.dbPath), "artifacts") }),
  });

  const supervisor = new AgentSupervisor({
    entrypoint: fileURLToPath(new URL("./agent-worker.ts", import.meta.url)),
    cwd: root,
    execArgv: ["--import", "tsx"],
  });
  let attached: Awaited<ReturnType<typeof runtime.attachAgent>> | undefined;
  let agentError: Error | undefined;
  let unsubscribeAgentErrors: (() => void) | undefined;
  try {
    await runtime.host.startup();
    const session = await runtime.host.sessions.openOrResume();
    const connection = await supervisor.start();
    unsubscribeAgentErrors = connection.transport.onMessage((message) => {
      if (message.type === "agent.error" && (message.sessionId === undefined || message.sessionId === String(session.sessionId))) {
        agentError = new Error(`Agent error: ${message.message}`);
      }
    });
    attached = await runtime.attachAgent(connection, session, SYSTEM_PROMPT);
    const admitted = await runtime.host.admitInput(session.sessionId, prompt);
    await runtime.beginPlanning(connection, session, prompt);
    const application = runtime.createApplicationService({
      start: async () => false,
      guide: async () => false,
      cancel: async () => false,
    });

    const pending = await waitFor(
      "a sealed Program creation draft",
      async () => (await application.getSnapshot(String(session.sessionId))).pendingProgramCreations?.[0],
      () => agentError,
    );
    const acceptedByApplication = values["accept-program"] === true || await confirmProgram(pending.objective);
    if (!acceptedByApplication) {
      console.error("Program creation was not accepted.");
      process.exitCode = 1;
      return;
    }

    const acceptance = await application.execute({
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      commandId: randomUUID(),
      clientId: "alcode-cli",
      sessionId: String(session.sessionId),
      issuedAt: new Date().toISOString(),
      type: "program.creation.accept",
      draftId: pending.draftId,
      draftDigest: pending.draftDigest,
    });
    if (acceptance.decision !== "accepted" && acceptance.decision !== "duplicate") {
      throw new Error(`Program creation acceptance failed: ${acceptance.decision}${acceptance.reasonCode ? ` (${acceptance.reasonCode})` : ""}`);
    }

    await waitFor(
      "the first ProgramAttempt",
      async () => {
        const program = (await application.getSnapshot(String(session.sessionId))).programs?.[0];
        return program?.activeAttempt ? program : undefined;
      },
      () => agentError,
    );

    await connection.transport.send({
      type: "input.admitted",
      requestId: randomUUID(),
      sessionId: String(session.sessionId),
      text: prompt,
      timestamp: admitted.timestamp,
    });

    const terminalSnapshot = await waitFor(
      "Program terminal state",
      async () => {
        const snapshot = await application.getSnapshot(String(session.sessionId));
        const program = snapshot.programs?.[0];
        return program && program.lifecycle !== "active" ? snapshot : undefined;
      },
      () => agentError,
    );
    const program = terminalSnapshot.programs?.[0];
    if (!program || program.lifecycle !== "completed") {
      throw new Error(`Program terminated without completion: ${program?.lifecycle ?? "missing"}`);
    }
    const assistantText = [...terminalSnapshot.transcript].reverse().find((message) => message.role === "assistant")?.text;
    if (assistantText) console.log(assistantText);
  } finally {
    unsubscribeAgentErrors?.();
    attached?.detach();
    await supervisor.shutdown(process.exitCode ? "cancelled" : "completed").catch(() => undefined);
    locked.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
