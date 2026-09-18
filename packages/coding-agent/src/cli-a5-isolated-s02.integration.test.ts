import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { PersistedDomainEvent } from "@alcode/events";
import { openLockedWorkspaceStore } from "@alcode/storage";
import { WorkspaceRegistry } from "@alcode/workspace";

const enabled = process.platform === "linux" && process.env.ALCODE_A5_DOCKER_INTEGRATION === "1";
const describeDocker = enabled ? describe : describe.skip;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const require = createRequire(import.meta.url);
const tsxImport = pathToFileURL(require.resolve("tsx")).href;
const objective = "Set exported value to 2 through isolated Code Mode sub-dispatches";
const valuePath = "packages/app/src/value.ts";
const initialValue = "export const value: number = 1;\n";
const correctedValue = "export const value: number = 2;\n";
const outerRunCodeCallId = "a5-isolated-run-code";

function createFixtureWorkspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "alcode-a5-isolated-s02-workspace-")));
  roots.push(root);
  mkdirSync(join(root, "packages", "app", "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true }, null, 2));
  writeFileSync(join(root, "packages", "app", "verify.cjs"), [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const source = fs.readFileSync(path.join(__dirname, 'src/value.ts'), 'utf8');",
    `if (!source.includes(${JSON.stringify(correctedValue.trim())})) {`,
    "  console.error('expected exported numeric value 2');",
    "  process.exitCode = 1;",
    "}",
  ].join("\n"));
  writeFileSync(join(root, valuePath), initialValue);
  return root;
}

const planningScript = JSON.stringify([
  {
    toolCalls: [{
      id: "a5-planning-text-read",
      name: "search_workspace_text",
      arguments: { pattern: "value", path: "packages/app/src", include: "*.ts", maxResults: 20 },
    }],
  },
  {
    toolCalls: [{
      id: "a5-program-proposal",
      name: "submit_program_proposal",
      arguments: {
        objective,
        workItems: [{
          workItemId: "a5-work-1",
          creationOrder: 0,
          description: "Change the exported value through isolated Code Mode and satisfy exact-world verification",
          dependencyIds: [],
          affectedPaths: [valuePath],
        }],
        verification: [{
          obligationId: "a5-command-verify",
          verifier: { specId: "command_exit_zero", specVersion: 1 },
          args: { command: "node packages/app/verify.cjs" },
          freshnessScope: { kind: "workspace" },
        }],
        outputSlots: [],
        productionSteps: [],
      },
    }],
  },
]);

const localProgram = [
  `await tools.read({ path: ${JSON.stringify(valuePath)} });`,
  `await tools.edit({ path: ${JSON.stringify(valuePath)}, oldString: ${JSON.stringify(initialValue.trim())}, newString: ${JSON.stringify(correctedValue.trim())} });`,
  `await tools.read({ path: ${JSON.stringify(valuePath)} });`,
  'return { sequence: ["read", "edit", "read"], readyForHostVerification: true };',
].join("\n");

const agentScript = JSON.stringify([
  {
    toolCalls: [{
      id: outerRunCodeCallId,
      name: "run_code",
      arguments: { code: localProgram },
    }],
  },
  { text: "Isolated local orchestration completed; ready for Host verification." },
]);

async function replay(home: string, root: string): Promise<PersistedDomainEvent<string, unknown>[]> {
  const registry = new WorkspaceRegistry(home);
  const resolved = registry.resolve(root);
  const entry = registry.getWorkspace(resolved.workspaceId);
  if (!entry) throw new Error("missing A5 isolated product fixture workspace registry entry");
  const locked = await openLockedWorkspaceStore({
    databasePath: entry.dbPath,
    lockPath: entry.lockPath,
    workspaceId: entry.workspaceId,
    repositoryId: entry.repositoryId,
  });
  try {
    const events: PersistedDomainEvent<string, unknown>[] = [];
    for await (const event of locked.store.replay()) events.push(event);
    return events;
  } finally {
    locked.close();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected record");
  return value as Record<string, unknown>;
}

function maybeRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function assistantCallsTool(event: PersistedDomainEvent<string, unknown>, toolName: string, toolCallId: string): boolean {
  if (event.type !== "assistant.message.appended") return false;
  const content = record(event.payload).content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const item = maybeRecord(block);
    return item?.type === "toolCall" && item.name === toolName && item.id === toolCallId;
  });
}

function operationCapabilityName(event: PersistedDomainEvent<string, unknown>): string | undefined {
  if (event.type !== "operation.requested") return undefined;
  const toolName = record(event.payload).toolName;
  return typeof toolName === "string" ? toolName : undefined;
}

function executionWorld(event: PersistedDomainEvent<string, unknown>): Record<string, unknown> | undefined {
  return maybeRecord(record(event.payload).executionWorld);
}

function diagnosticTrace(events: PersistedDomainEvent<string, unknown>[]): string {
  return events.slice(-140).map((event) => {
    const payload = maybeRecord(event.payload) ?? {};
    const world = maybeRecord(payload.executionWorld);
    return JSON.stringify({
      sequence: event.sequence,
      type: event.type,
      ...(event.operationId !== undefined ? { operationId: String(event.operationId) } : {}),
      ...(typeof payload.transitionKind === "string" ? { transitionKind: payload.transitionKind } : {}),
      ...(typeof payload.toolName === "string" ? { toolName: payload.toolName } : {}),
      ...(typeof payload.toolCallId === "string" ? { toolCallId: payload.toolCallId } : {}),
      ...(typeof payload.parentToolCallId === "string" ? { parentToolCallId: payload.parentToolCallId } : {}),
      ...(typeof payload.localSubcallIndex === "number" ? { localSubcallIndex: payload.localSubcallIndex } : {}),
      ...(typeof world?.executionWorldGenerationId === "string"
        ? { executionWorldGenerationId: world.executionWorldGenerationId }
        : {}),
    });
  }).join("\n");
}

describeDocker("A5 isolated-v1 S02/A2 product composition", () => {
  it("routes run_code read-edit-read subcalls and Host verification through one exact isolated generation", async () => {
    const root = createFixtureWorkspace();
    const home = mkdtempSync(join(tmpdir(), "alcode-a5-isolated-s02-home-"));
    roots.push(home);

    const result = spawnSync(process.execPath, [
      "--import",
      tsxImport,
      cliPath,
      "-p",
      objective,
      "--accept-program",
    ], {
      cwd: root,
      env: {
        ...process.env,
        ALCODE_HOME: home,
        ALCODE_EXECUTION_PROVIDER: "isolated-v1",
        ALCODE_AGENT_SCRIPT: agentScript,
        ALCODE_AGENT_SCRIPT_DURABLE_CURSOR: "1",
        ALCODE_PLANNING_SCRIPT: planningScript,
      },
      encoding: "utf8",
      timeout: 5 * 60_000,
    });

    const events = await replay(home, root);
    const trace = diagnosticTrace(events);
    expect(result.error, `${result.stderr}\n${result.stdout}\nDurable trace:\n${trace}`).toBeUndefined();
    expect(result.status, `${result.stderr}\n${result.stdout}\nDurable trace:\n${trace}`).toBe(0);
    expect(readFileSync(join(root, valuePath), "utf8")).toBe(correctedValue);
    expect(result.stdout).toContain("Isolated local orchestration completed; ready for Host verification.");

    const runCodeAssistant = events.find((event) => assistantCallsTool(event, "run_code", outerRunCodeCallId));
    expect(runCodeAssistant, trace).toBeDefined();
    const runCodeResult = events.find((event) => {
      if (event.type !== "tool.result.appended") return false;
      const payload = record(event.payload);
      return payload.toolCallId === outerRunCodeCallId && payload.toolName === "run_code";
    });
    expect(runCodeResult, trace).toBeDefined();
    expect(runCodeAssistant!.sequence).toBeLessThan(runCodeResult!.sequence);

    const localWindow = events.filter((event) =>
      event.sequence > runCodeAssistant!.sequence && event.sequence < runCodeResult!.sequence);
    const subdispatches = localWindow.filter((event) => operationCapabilityName(event) !== undefined);
    expect(subdispatches.map(operationCapabilityName), trace).toEqual(["read", "edit", "read"]);
    expect(events.some((event) => operationCapabilityName(event) === "run_code")).toBe(false);

    const worlds = subdispatches.map((event) => executionWorld(event));
    expect(worlds.every((world) => world?.providerKind === "isolated-v1"), trace).toBe(true);
    const generationIds = worlds.map((world) => String(world?.executionWorldGenerationId ?? ""));
    expect(generationIds.every((generationId) => generationId.length > 0), trace).toBe(true);
    expect(new Set(generationIds).size, trace).toBe(1);
    const generationId = generationIds[0]!;

    const nestedPayloads = subdispatches.map((event) => record(event.payload));
    expect(nestedPayloads.map((payload) => payload.parentToolCallId), trace)
      .toEqual([outerRunCodeCallId, outerRunCodeCallId, outerRunCodeCallId]);
    expect(nestedPayloads.map((payload) => payload.localSubcallIndex), trace).toEqual([0, 1, 2]);
    const inferenceEpochIds = nestedPayloads.map((payload) => payload.inferenceEpochId);
    expect(inferenceEpochIds.every((value) => typeof value === "string" && value.length > 0), trace).toBe(true);
    expect(new Set(inferenceEpochIds).size, trace).toBe(1);

    const attemptBinding = events.find((event) => event.type === "program.attempt.execution_world.bound");
    expect(attemptBinding, trace).toBeDefined();
    expect(executionWorld(attemptBinding!)?.executionWorldGenerationId, trace).toBe(generationId);
    expect(executionWorld(attemptBinding!)?.providerKind, trace).toBe("isolated-v1");

    const verificationRequest = events.find((event) => {
      if (event.type !== "operation.requested") return false;
      const invocation = maybeRecord(record(event.payload).programVerificationInvocation);
      return invocation?.specId === "command_exit_zero";
    });
    expect(verificationRequest, trace).toBeDefined();
    expect(verificationRequest!.sequence).toBeGreaterThan(runCodeResult!.sequence);
    expect(executionWorld(verificationRequest!)?.executionWorldGenerationId, trace).toBe(generationId);
    expect(executionWorld(verificationRequest!)?.providerKind, trace).toBe("isolated-v1");

    const activation = events.find((event) => {
      if (event.type !== "execution.world.activation.prepared") return false;
      const identity = maybeRecord(record(event.payload).identity);
      return identity?.executionWorldGenerationId === generationId && identity?.providerKind === "isolated-v1";
    });
    expect(activation, trace).toBeDefined();
    const closure = events.find((event) =>
      event.type === "execution.world.closure.observed"
      && record(event.payload).executionWorldGenerationId === generationId);
    expect(closure, trace).toBeDefined();

    const completion = events.find((event) => event.type === "program.completed");
    expect(completion, trace).toBeDefined();
    expect(completion!.sequence).toBeGreaterThan(verificationRequest!.sequence);
    expect(events.some((event) => event.type === "program.verification.failed")).toBe(false);
  }, 10 * 60_000);
});
