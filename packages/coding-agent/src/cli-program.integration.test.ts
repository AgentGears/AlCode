import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openLockedWorkspaceStore } from "@alcode/storage";
import { WorkspaceRegistry } from "@alcode/workspace";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const acceptedCliDiagnosticRepetitions = 8;
const deterministicAgentScript = JSON.stringify([
  { text: "Hello from ALCODE. The agent loop is running." },
]);
const deterministicPlanningScript = JSON.stringify([
  {
    toolCalls: [{
      id: "planning-proposal-1",
      name: "submit_program_proposal",
      arguments: {
        objective: "hello",
        workItems: [{
          workItemId: "work-1",
          creationOrder: 0,
          description: "hello",
          dependencyIds: [],
          affectedPaths: ["package.json"],
        }],
        verification: [{
          obligationId: "verify-package-json",
          verifier: { specId: "workspace_path_state", specVersion: 1 },
          args: { path: "package.json", requiredState: "file" },
          freshnessScope: { kind: "workspace" },
        }],
        outputSlots: [],
        productionSteps: [],
      },
    }],
  },
]);

function runCli(home: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ALCODE_HOME: home,
      ALCODE_AGENT_SCRIPT: deterministicAgentScript,
      ALCODE_PLANNING_SCRIPT: deterministicPlanningScript,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
}

function boundedPayload(payload: unknown): string {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) return String(payload);
  return serialized.length <= 1_200 ? serialized : `${serialized.slice(0, 1_200)}…`;
}

async function replaySnapshot(home: string): Promise<{ types: string[]; events: string[] }> {
  const registry = new WorkspaceRegistry(home);
  const resolved = registry.resolve(repoRoot);
  const entry = registry.getWorkspace(resolved.workspaceId);
  if (!entry) throw new Error("missing workspace registry entry");
  const locked = await openLockedWorkspaceStore({
    databasePath: entry.dbPath,
    lockPath: entry.lockPath,
    workspaceId: entry.workspaceId,
    repositoryId: entry.repositoryId,
  });
  try {
    const types: string[] = [];
    const events: string[] = [];
    for await (const event of locked.store.replay()) {
      types.push(event.type);
      events.push([
        `#${event.sequence}`,
        event.type,
        `session=${event.sessionId}`,
        `program=${event.programStateId ?? "-"}`,
        `operation=${event.operationId ?? "-"}`,
        `payload=${boundedPayload(event.payload)}`,
      ].join(" "));
    }
    return { types, events };
  } finally {
    locked.close();
  }
}

async function replayTypes(home: string): Promise<string[]> {
  return (await replaySnapshot(home)).types;
}

async function timeoutDiagnosis(home: string): Promise<string> {
  try {
    const snapshot = await replaySnapshot(home);
    const typeTail = snapshot.types.slice(-48).join(" -> ");
    const eventTail = snapshot.events.slice(-24).join("\n");
    return [
      `durable program.completed=${snapshot.types.includes("program.completed")}`,
      `durable event-count=${snapshot.types.length}`,
      `durable event-tail=${typeTail || "<empty>"}`,
      "durable event-detail:",
      eventTail || "<empty>",
    ].join("\n");
  } catch (error) {
    return `durable replay failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

describe("alcode -p Program-backed product route", () => {
  it("does not directly invoke runAgentLoop and completes through explicit CLI Application acceptance", async () => {
    expect(readFileSync(cliPath, "utf8")).not.toContain("runAgentLoop");
    for (let repetition = 1; repetition <= acceptedCliDiagnosticRepetitions; repetition++) {
      const home = mkdtempSync(`${tmpdir()}/alcode-cli-program-`); homes.push(home);
      const result = runCli(home, ["-p", "hello", "--accept-program"]);
      if (result.error !== undefined) {
        const diagnosis = await timeoutDiagnosis(home);
        throw new Error([
          `accepted CLI repetition ${repetition}/${acceptedCliDiagnosticRepetitions} failed: ${result.error.message}`,
          diagnosis,
          `stdout=${result.stdout || "<empty>"}`,
          `stderr=${result.stderr || "<empty>"}`,
        ].join("\n"));
      }
      expect(result.status, `repetition ${repetition}\n${result.stderr}\n${result.stdout}`).toBe(0);
      expect(result.stdout).toContain("Hello from ALCODE. The agent loop is running.");
      const types = await replayTypes(home);
      expect(types).toContain("program.creation.draft.sealed");
      expect(types).toContain("program.creation.draft.accepted");
      expect(types).toContain("program.created");
      expect(types).toContain("program.completed");
    }
  }, 180_000);

  it("does not silently self-approve a Program when non-interactive acceptance is absent", async () => {
    const home = mkdtempSync(`${tmpdir()}/alcode-cli-program-no-accept-`); homes.push(home);
    const result = runCli(home, ["-p", "hello"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--accept-program");
    const types = await replayTypes(home);
    expect(types).toContain("program.creation.draft.sealed");
    expect(types).not.toContain("program.creation.draft.accepted");
    expect(types).not.toContain("program.created");
  }, 70_000);
});
