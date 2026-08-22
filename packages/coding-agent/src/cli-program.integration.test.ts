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
          affectedPaths: [],
        }],
        verification: [],
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

async function replayTypes(home: string): Promise<string[]> {
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
    for await (const event of locked.store.replay()) types.push(event.type);
    return types;
  } finally {
    locked.close();
  }
}

describe("alcode -p Program-backed product route", () => {
  it("does not directly invoke runAgentLoop and completes through explicit CLI Application acceptance", async () => {
    expect(readFileSync(cliPath, "utf8")).not.toContain("runAgentLoop");
    const home = mkdtempSync(`${tmpdir()}/alcode-cli-program-`); homes.push(home);
    const result = runCli(home, ["-p", "hello", "--accept-program"]);
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout).toContain("Hello from ALCODE. The agent loop is running.");
    const types = await replayTypes(home);
    expect(types).toContain("program.creation.draft.sealed");
    expect(types).toContain("program.creation.draft.accepted");
    expect(types).toContain("program.created");
    expect(types).toContain("program.completed");
  }, 70_000);

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
