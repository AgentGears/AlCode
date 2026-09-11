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

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const require = createRequire(import.meta.url);
const tsxImport = pathToFileURL(require.resolve("tsx")).href;
const objective = "Set exported value to 2 using bounded local orchestration";
const valuePath = "packages/app/src/value.ts";
const initialValue = "export const value: number = 1;\n";
const correctedValue = "export const value: number = 2;\n";
const outerRunCodeCallId = "s02-product-run-code";

function createFixtureWorkspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "alcode-s02-product-workspace-")));
  roots.push(root);
  mkdirSync(join(root, "packages", "app", "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true }, null, 2));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, target: "ES2022", module: "ESNext" },
    include: ["packages/**/*.ts"],
  }, null, 2));
  writeFileSync(join(root, "packages", "app", "package.json"), JSON.stringify({
    name: "fixture-app",
    private: true,
    scripts: { typecheck: "node verify.cjs" },
  }, null, 2));
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
      id: "s02-planning-symbol-read",
      name: "search_code_symbols",
      arguments: { query: "value", limit: 20 },
    }],
  },
  {
    toolCalls: [{
      id: "s02-program-proposal",
      name: "submit_program_proposal",
      arguments: {
        objective,
        workItems: [{
          workItemId: "s02-work-1",
          creationOrder: 0,
          description: "Change the exported value through Code Mode and satisfy package typecheck",
          dependencyIds: [],
          affectedPaths: [valuePath],
        }],
        verification: [{
          obligationId: "s02-typecheck",
          verifier: { specId: "package_typecheck", specVersion: 1 },
          args: { package: "fixture-app" },
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
  { text: "Local orchestration completed; ready for Host verification." },
]);

async function replay(home: string, root: string): Promise<PersistedDomainEvent<string, unknown>[]> {
  const registry = new WorkspaceRegistry(home);
  const resolved = registry.resolve(root);
  const entry = registry.getWorkspace(resolved.workspaceId);
  if (!entry) throw new Error("missing S02 product fixture workspace registry entry");
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

function diagnosticTrace(events: PersistedDomainEvent<string, unknown>[]): string {
  return events.slice(-100).map((event) => {
    const payload = maybeRecord(event.payload) ?? {};
    return JSON.stringify({
      sequence: event.sequence,
      type: event.type,
      ...(event.operationId !== undefined ? { operationId: String(event.operationId) } : {}),
      ...(typeof payload.transitionKind === "string" ? { transitionKind: payload.transitionKind } : {}),
      ...(typeof payload.toolName === "string" ? { toolName: payload.toolName } : {}),
      ...(typeof payload.toolCallId === "string" ? { toolCallId: payload.toolCallId } : {}),
    });
  }).join("\n");
}

describe("S02-5 Code Mode product vertical", () => {
  it("uses one run_code inference to perform read-edit-read Host sub-dispatches, then verifies and completes", async () => {
    const root = createFixtureWorkspace();
    const home = mkdtempSync(join(tmpdir(), "alcode-s02-product-home-"));
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
        ALCODE_AGENT_SCRIPT: agentScript,
        ALCODE_AGENT_SCRIPT_DURABLE_CURSOR: "1",
        ALCODE_PLANNING_SCRIPT: planningScript,
      },
      encoding: "utf8",
      timeout: 25_000,
    });

    const events = await replay(home, root);
    const trace = diagnosticTrace(events);
    expect(result.error, `${result.stderr}\n${result.stdout}\nDurable trace:\n${trace}`).toBeUndefined();
    expect(result.status, `${result.stderr}\n${result.stdout}\nDurable trace:\n${trace}`).toBe(0);
    expect(readFileSync(join(root, valuePath), "utf8")).toBe(correctedValue);
    expect(result.stdout).toContain("Local orchestration completed; ready for Host verification.");

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
    expect(subdispatches).toHaveLength(3);
    expect(subdispatches.every((event) => event.operationId !== undefined)).toBe(true);
    expect(new Set(subdispatches.map((event) => String(event.operationId))).size).toBe(3);
    expect(localWindow.some((event) => event.type === "assistant.message.appended")).toBe(false);
    expect(events.some((event) => operationCapabilityName(event) === "run_code")).toBe(false);

    const editRequest = subdispatches.find((event) => operationCapabilityName(event) === "edit");
    expect(editRequest?.operationId).toBeDefined();
    const effectAdvance = events.find((event) =>
      event.type === "workspace.effect_generation.advanced"
      && event.sequence > editRequest!.sequence
      && event.sequence < runCodeResult!.sequence);
    expect(effectAdvance, trace).toBeDefined();

    const laterAssistant = events.find((event) => {
      if (event.type !== "assistant.message.appended" || event.sequence <= runCodeResult!.sequence) return false;
      return String(record(event.payload).text ?? "").includes("Local orchestration completed");
    });
    expect(laterAssistant, trace).toBeDefined();

    const attemptIssues = events.filter((event) =>
      event.type === "program.transitioned" && record(event.payload).transitionKind === "attempt.issue");
    expect(attemptIssues).toHaveLength(1);

    const verificationRequest = events.find((event) => {
      if (event.type !== "operation.requested") return false;
      const invocation = maybeRecord(record(event.payload).programVerificationInvocation);
      return invocation?.specId === "package_typecheck";
    });
    expect(verificationRequest, trace).toBeDefined();
    const invocation = record(record(verificationRequest!.payload).programVerificationInvocation);
    expect(invocation).toMatchObject({ specId: "package_typecheck", specVersion: 1 });
    expect(verificationRequest!.sequence).toBeGreaterThan(runCodeResult!.sequence);

    const completion = events.find((event) => event.type === "program.completed");
    expect(completion, trace).toBeDefined();
    expect(completion!.sequence).toBeGreaterThan(verificationRequest!.sequence);
    expect(events.some((event) => event.type === "program.verification.failed")).toBe(false);
  }, 130_000);
});
