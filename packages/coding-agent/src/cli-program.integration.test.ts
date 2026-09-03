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

interface DiagnosticEvent {
  sequence: number;
  type: string;
  payload: unknown;
}

async function replayEvents(home: string): Promise<DiagnosticEvent[]> {
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
    const events: DiagnosticEvent[] = [];
    for await (const event of locked.store.replay()) {
      events.push({ sequence: event.sequence, type: event.type, payload: event.payload });
    }
    return events;
  } finally {
    locked.close();
  }
}

async function replayTypes(home: string): Promise<string[]> {
  return (await replayEvents(home)).map((event) => event.type);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function compactAttempt(value: unknown): unknown {
  if (value === null) return null;
  const attempt = record(value);
  if (attempt === undefined) return value;
  return {
    programAttemptId: attempt.programAttemptId,
    workItemId: attempt.workItemId,
    sessionId: attempt.sessionId,
    agentGeneration: attempt.agentGeneration,
  };
}

function compactWorkItems(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    const work = record(item);
    if (work === undefined) return item;
    return {
      workItemId: work.workItemId,
      lifecycle: work.lifecycle,
      satisfactionState: work.satisfactionState,
      requirementState: work.requirementState,
      topologyState: work.topologyState,
      workItemGeneration: work.workItemGeneration,
    };
  });
}

function compactVerification(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    const verification = record(item);
    if (verification === undefined) return item;
    return {
      obligationId: verification.obligationId,
      subjectGeneration: verification.subjectGeneration,
      satisfied: verification.satisfaction !== null && verification.satisfaction !== undefined,
      waived: verification.waiver !== null && verification.waiver !== undefined,
    };
  });
}

function compactProgramState(payload: unknown): string {
  const payloadRecord = record(payload);
  const state = record(payloadRecord?.state);
  if (state === undefined) return "<no payload.state>";
  return JSON.stringify({
    revision: state.revision,
    lifecycle: state.lifecycle,
    activeAttempt: compactAttempt(state.activeAttempt),
    workItems: compactWorkItems(state.workItems),
    verification: compactVerification(state.verification),
    acceptedExecutionBase: state.acceptedExecutionBase === null ? null : "present",
    executionBaseMismatch: state.executionBaseMismatch === null ? null : "present",
    executionBaseUnavailable: state.executionBaseUnavailable,
  });
}

async function timeoutDiagnosis(home: string): Promise<string> {
  try {
    const events = await replayEvents(home);
    const types = events.map((event) => event.type);
    const tail = types.slice(-48).join(" -> ");
    const programStates = events
      .filter((event) => event.type === "program.created"
        || event.type === "program.transitioned"
        || event.type === "program.completed"
        || event.type === "program.cancelled")
      .map((event) => `${event.sequence}:${event.type}:${compactProgramState(event.payload)}`)
      .join("\n");
    return [
      `durable program.completed=${types.includes("program.completed")}`,
      `durable event-count=${types.length}`,
      `durable event-tail=${tail || "<empty>"}`,
      `durable program-state-history=\n${programStates || "<none>"}`,
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
