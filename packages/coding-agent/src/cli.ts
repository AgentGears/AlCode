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
import { createProgramAdaptiveProductionRuntimeV1 } from "@alcode/host-runtime/adaptive-production-v1";
import { openLockedWorkspaceStore } from "@alcode/storage";
import { WorkspaceRegistry } from "@alcode/workspace";
import { agentErrorStillTargetsLiveConnection } from "./agent-error-arbitration.ts";
import { recoverAfterAgentReplacement } from "./agent-replacement-recovery.ts";
import { createDefaultHostCapabilities } from "./host-capabilities.ts";
import { createLocalWorkspace } from "./capabilities/local-workspace.ts";
import { createLocalPlanningReadRegistry } from "./planning-read-catalog.ts";
import { createDefaultProgramVerifierConfiguration } from "./verification-profile.ts";

const SYSTEM_PROMPT = "You are ALCODE, a memory-native coding agent.";
const APPLICATION_PROTOCOL_VERSION = 1 as const;
const LOCAL_OBSERVATION_PROVIDER = "alcode-local-workspace-v1";
const LOCAL_COVERAGE_IDENTITY = "alcode-local-workspace-complete-v1";
const LOCAL_ADAPTIVE_TOPOLOGY_EXPANSION = 8;
const WAIT_TIMEOUT_MS = 20_000;
const PROGRAM_DRIVE_TIMEOUT_MS = 5 * 60_000;
const PROGRAM_REDRIVE_INTERVAL_MS = 100;
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
  const artifactStore = new HostArtifactStore({ root: join(dirname(workspaceEntry.dbPath), "artifacts") });

  const fixedRuntime = createProgramExecutionRuntimeV1({
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
    artifactStore,
  });
  const adaptiveProduct = createProgramAdaptiveProductionRuntimeV1({
    fixedTopology: fixedRuntime,
    observations,
    artifactStore,
    baselineAuthority: {
      forWorkItem: ({ programState }) => ({
        allowedRepositoryRoots: ["."],
        allowedEffectClasses: ["fs.read", "fs.write"],
        allowedExternalSystems: [],
        capabilityCeiling: capabilities.map((capability) => capability.name)
          .sort((left, right) => left.localeCompare(right, "en")),
        maximumTopologyExpansion: LOCAL_ADAPTIVE_TOPOLOGY_EXPANSION,
        mandatoryVerificationIds: programState.verification.map((item) => String(item.obligationId))
          .sort((left, right) => left.localeCompare(right, "en")),
        forbiddenChangeKinds: ["delete_repository"],
      }),
    },
  });
  const runtime = adaptiveProduct.runtime;

  const supervisor = new AgentSupervisor({
    entrypoint: fileURLToPath(new URL("./agent-worker.ts", import.meta.url)),
    cwd: root,
    execArgv: ["--import", "tsx"],
  });
  const attachedAgents: Array<Awaited<ReturnType<typeof runtime.attachAgent>>> = [];
  const unsubscribeAgentErrors: Array<() => void> = [];
  let currentConnectionGeneration = "";
  let agentError: Error | undefined;
  let completedSuccessfully = false;
  try {
    await runtime.host.startup();
    const session = await runtime.host.sessions.openOrResume();
    let connection = await supervisor.start();

    const attachConnection = async (
      nextConnection: typeof connection,
      reason: "agent_replaced" | "host_reopened" | "reattach" = "reattach",
    ): Promise<void> => {
      currentConnectionGeneration = nextConnection.generationId;
      agentError = undefined;
      unsubscribeAgentErrors.push(nextConnection.transport.onMessage((message) => {
        if (nextConnection.generationId !== currentConnectionGeneration) return;
        if (message.type === "agent.error"
            && (message.sessionId === undefined || message.sessionId === String(session.sessionId))) {
          agentError = new Error(`Agent error: ${message.message}`);
        }
      }));
      attachedAgents.push(await runtime.attachAgent(nextConnection, session, SYSTEM_PROMPT, reason));
    };

    await attachConnection(connection);
    await runtime.host.admitInput(session.sessionId, prompt);
    await fixedRuntime.beginPlanning(connection, session, prompt);
    const application = adaptiveProduct.createBaselineAdoptionApplicationService({
      start: async () => false,
      guide: async () => false,
      cancel: async () => false,
    });
    const executeAdaptiveProgram = application.executeAdaptiveProgram?.bind(application);
    if (executeAdaptiveProgram === undefined) {
      throw new Error("Adaptive Application authority is unavailable in the production runtime");
    }

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
    if (acceptance.programStateId === undefined) {
      throw new Error("Program creation acceptance did not return a ProgramState ID");
    }
    const programStateId = acceptance.programStateId;

    const readProgram = async () => {
      const snapshot = await application.getSnapshot(String(session.sessionId));
      return {
        snapshot,
        program: snapshot.programs?.find((candidate) => candidate.programStateId === programStateId),
      };
    };

    const createdProgram = (await readProgram()).program;
    if (createdProgram === undefined || createdProgram.lifecycle !== "active" || createdProgram.activeAttempt !== undefined) {
      throw new Error("New Program was not quiescent for explicit adaptive baseline adoption");
    }
    const sealedBaseline = await executeAdaptiveProgram({
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      commandId: randomUUID(),
      clientId: "alcode-cli",
      sessionId: String(session.sessionId),
      issuedAt: new Date().toISOString(),
      type: "program.semantic_baseline.seal",
      programStateId,
      expectedProgramStateRevision: createdProgram.revision,
    });
    if (sealedBaseline.decision !== "accepted"
        || sealedBaseline.draftId === undefined
        || sealedBaseline.draftDigest === undefined) {
      throw new Error(`Adaptive baseline sealing failed: ${sealedBaseline.decision}${sealedBaseline.reasonCode ? ` (${sealedBaseline.reasonCode})` : ""}`);
    }
    const adoptedBaseline = await executeAdaptiveProgram({
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      commandId: randomUUID(),
      clientId: "alcode-cli",
      sessionId: String(session.sessionId),
      issuedAt: new Date().toISOString(),
      type: "program.semantic_baseline.accept",
      programStateId,
      draftId: sealedBaseline.draftId,
      draftDigest: sealedBaseline.draftDigest,
    });
    if (adoptedBaseline.decision !== "accepted" && adoptedBaseline.decision !== "duplicate") {
      throw new Error(`Adaptive baseline acceptance failed: ${adoptedBaseline.decision}${adoptedBaseline.reasonCode ? ` (${adoptedBaseline.reasonCode})` : ""}`);
    }

    // The pre-adoption attachment is deliberately V1. Reattach the same
    // disposable Agent connection after the canonical baseline cut so routing
    // negotiates V2 authority; no active Attempt or Operation crosses this seam.
    attachedAgents.pop()?.detach();
    await attachConnection(connection, "reattach");

    const cancelActiveProgram = async (reason: string): Promise<void> => {
      for (let pass = 0; pass < 2; pass++) {
        const { program } = await readProgram();
        if (program === undefined || program.lifecycle !== "active") return;
        if (await adaptiveProduct.semanticRecovery.isAdaptive(programStateId)) {
          await adaptiveProduct.terminal.cancel({
            programStateId,
            expectedProgramRevision: program.revision,
            sessionId: session.sessionId,
            actor: "application",
            client: "alcode-cli",
            reason,
          });
          return;
        }
        const result = await application.execute({
          protocolVersion: APPLICATION_PROTOCOL_VERSION,
          commandId: randomUUID(),
          clientId: "alcode-cli",
          sessionId: String(session.sessionId),
          issuedAt: new Date().toISOString(),
          type: "program.cancel",
          programStateId,
          expectedProgramRevision: program.revision,
          reason,
        });
        if (result.decision === "accepted" || result.decision === "duplicate" || result.decision === "noop") return;
        if (result.decision !== "stale") {
          throw new Error(`Program cancellation failed: ${result.decision}${result.reasonCode ? ` (${result.reasonCode})` : ""}`);
        }
      }
      const { program } = await readProgram();
      if (program?.lifecycle === "active") throw new Error("Program remained active after bounded cancellation retries");
    };

    let terminalSnapshot: Awaited<ReturnType<typeof application.getSnapshot>> | undefined;
    const driveDeadline = Date.now() + PROGRAM_DRIVE_TIMEOUT_MS;
    try {
      while (Date.now() < driveDeadline) {
        const fatal = agentError;
        if (fatal !== undefined) {
          const sameConnectionStillLive = await agentErrorStillTargetsLiveConnection(
            supervisor,
            PROGRAM_REDRIVE_INTERVAL_MS,
          );
          if (sameConnectionStillLive) throw fatal;
          agentError = undefined;
        }

        const current = await readProgram();
        const program = current.program;
        if (program === undefined) throw new Error(`Accepted Program ${programStateId} is missing from Application snapshot`);
        if (program.lifecycle !== "active") {
          terminalSnapshot = current.snapshot;
          break;
        }

        if (supervisor.getCurrent() === null) {
          connection = await supervisor.start();
          await attachConnection(connection, "agent_replaced");
          await recoverAfterAgentReplacement(locked.store, fixedRuntime.recovery);
        }

        try {
          await runtime.requestCurrentAttemptExecution(connection, session);
        } catch (error) {
          if (supervisor.getCurrent() === null) continue;
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, PROGRAM_REDRIVE_INTERVAL_MS));
      }

      if (terminalSnapshot === undefined) {
        await cancelActiveProgram("program_drive_timeout");
        throw new Error(`Program execution exceeded the ${PROGRAM_DRIVE_TIMEOUT_MS}ms product bound and was cancelled`);
      }
    } catch (error) {
      await cancelActiveProgram("program_driver_failure").catch(() => undefined);
      const afterFailure = await readProgram();
      if (afterFailure.program !== undefined && afterFailure.program.lifecycle !== "active") {
        terminalSnapshot = afterFailure.snapshot;
      } else {
        throw error;
      }
    }

    if (terminalSnapshot === undefined) {
      throw new Error("Program driver exited without a terminal Application snapshot");
    }
    const program = terminalSnapshot.programs?.find((candidate) => candidate.programStateId === programStateId);
    if (!program || program.lifecycle !== "completed") {
      throw new Error(`Program terminated without completion: ${program?.lifecycle ?? "missing"}`);
    }
    completedSuccessfully = true;
    const assistantText = [...terminalSnapshot.transcript].reverse().find((message) => message.role === "assistant")?.text;
    if (assistantText) console.log(assistantText);
  } finally {
    for (const unsubscribe of unsubscribeAgentErrors.splice(0)) unsubscribe();
    for (const attached of attachedAgents.splice(0).reverse()) attached.detach();
    await supervisor.shutdown(completedSuccessfully ? "completed" : "cancelled").catch(() => undefined);
    locked.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
