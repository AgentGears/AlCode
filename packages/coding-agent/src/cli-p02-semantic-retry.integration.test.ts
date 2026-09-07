import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
const objective = "Set exported value to 2";
const valuePath = "packages/app/src/value.ts";
const initialValue = "export const value: number = 1;\n";
const wrongValue = "export const value: string = \"wrong\";\n";
const correctedValue = "export const value: number = 2;\n";
const verifierCommand = "pnpm --filter fixture-app typecheck";

function createFixtureWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "alcode-p02-product-workspace-"));
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
      id: "p02-semantic-symbol-read",
      name: "search_code_symbols",
      arguments: { query: "value", limit: 20 },
    }],
  },
  {
    toolCalls: [{
      id: "p02-program-proposal",
      name: "submit_program_proposal",
      arguments: {
        objective,
        workItems: [{
          workItemId: "p02-work-1",
          creationOrder: 0,
          description: "Change the exported value and satisfy package typecheck",
          dependencyIds: [],
          affectedPaths: [valuePath],
        }],
        verification: [{
          obligationId: "p02-typecheck",
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

const agentScript = JSON.stringify([
  {
    toolCalls: [{
      id: "p02-first-wrong-edit",
      name: "edit",
      arguments: {
        path: valuePath,
        oldString: initialValue.trim(),
        newString: wrongValue.trim(),
      },
    }],
  },
  { text: "First attempt is ready for Host verification." },
  {
    toolCalls: [{
      id: "p02-retry-correction",
      name: "edit",
      arguments: {
        path: valuePath,
        oldString: wrongValue.trim(),
        newString: correctedValue.trim(),
      },
    }],
  },
  { text: "Corrected the value after the Host typecheck failure." },
]);

async function replay(home: string, root: string): Promise<PersistedDomainEvent<string, unknown>[]> {
  const registry = new WorkspaceRegistry(home);
  const resolved = registry.resolve(root);
  const entry = registry.getWorkspace(resolved.workspaceId);
  if (!entry) throw new Error("missing P-02 fixture workspace registry entry");
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

function diagnosticTrace(events: PersistedDomainEvent<string, unknown>[]): Array<Record<string, unknown>> {
  return events.slice(-80).map((event) => {
    const payload = maybeRecord(event.payload) ?? {};
    const base: Record<string, unknown> = {
      sequence: event.sequence,
      type: event.type,
      ...(event.operationId !== undefined ? { operationId: String(event.operationId) } : {}),
    };
    if (event.type === "program.transitioned" || event.type === "program.cancelled" || event.type === "program.completed") {
      const state = maybeRecord(payload.state);
      const activeAttempt = maybeRecord(state?.activeAttempt);
      const workItems = Array.isArray(state?.workItems) ? state.workItems : [];
      return {
        ...base,
        ...(typeof payload.transitionKind === "string" ? { transitionKind: payload.transitionKind } : {}),
        ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
        ...(state !== undefined ? {
          revision: state.revision,
          lifecycle: state.lifecycle,
          activeAttempt: activeAttempt === undefined ? null : {
            programAttemptId: activeAttempt.programAttemptId,
            workItemId: activeAttempt.workItemId,
            agentGeneration: activeAttempt.agentGeneration,
          },
          workItems: workItems.map((item) => {
            const work = maybeRecord(item) ?? {};
            return { workItemId: work.workItemId, lifecycle: work.lifecycle };
          }),
        } : {}),
      };
    }
    if (event.type === "program.verification.failed") {
      return {
        ...base,
        programAttemptId: payload.programAttemptId,
        workItemId: payload.workItemId,
        verificationObligationId: payload.verificationObligationId,
        reason: payload.reason,
        details: payload.details,
      };
    }
    const invocation = maybeRecord(payload.programVerificationInvocation);
    return {
      ...base,
      ...(typeof payload.capabilityName === "string" ? { capabilityName: payload.capabilityName } : {}),
      ...(typeof payload.outcome === "string" ? { outcome: payload.outcome } : {}),
      ...((typeof payload.exitCode === "number" || payload.exitCode === null) ? { exitCode: payload.exitCode } : {}),
      ...(invocation !== undefined ? {
        verification: {
          verificationObligationId: invocation.verificationObligationId,
          specId: invocation.specId,
          specVersion: invocation.specVersion,
        },
      } : {}),
    };
  });
}

describe("P-02 semantic planning + typed verification product vertical", () => {
  it("plans semantically, fails typed Host verification, retries on a fresh Attempt, corrects, and completes", async () => {
    const root = createFixtureWorkspace();
    const home = mkdtempSync(join(tmpdir(), "alcode-p02-product-home-"));
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
        ALCODE_AGENT_SCRIPT_SHARED_CURSOR: "1",
        ALCODE_PLANNING_SCRIPT: planningScript,
      },
      encoding: "utf8",
      timeout: 120_000,
    });

    const events = await replay(home, root);
    expect(result.error).toBeUndefined();
    expect(
      result.status,
      `${result.stderr}\n${result.stdout}\nDurable trace:\n${JSON.stringify(diagnosticTrace(events))}`,
    ).toBe(0);
    expect(readFileSync(join(root, valuePath), "utf8")).toBe(correctedValue);
    expect(result.stdout).toContain("Corrected the value after the Host typecheck failure.");

    const sealed = events.find((event) => event.type === "program.creation.draft.sealed");
    expect(sealed).toBeDefined();
    const draft = record(record(sealed!.payload).draft);
    const planningIdentity = record(draft.planningObservationIdentity);
    const dependencies = planningIdentity.dependencies as Array<Record<string, unknown>>;
    expect(dependencies.some((dependency) => dependency.readContractId === "code.symbol_search")).toBe(true);

    const proposal = record(draft.proposal);
    const verification = proposal.verification as Array<Record<string, unknown>>;
    const predicate = record(verification[0]!.predicate);
    expect(predicate).toMatchObject({
      kind: "operation_result",
      specId: "package_typecheck",
      specVersion: 1,
      canonicalArgs: { command: verifierCommand },
    });
    expect(JSON.stringify(predicate)).not.toContain('\"package\"');

    expect(events.some((event) => event.type === "program.creation.draft.accepted")).toBe(true);
    const failure = events.find((event) => event.type === "program.verification.failed");
    expect(failure).toBeDefined();
    const failurePayload = record(failure!.payload);
    expect(failurePayload).toMatchObject({
      verificationObligationId: "p02-typecheck",
      details: {
        kind: "host_verification_failure_v1",
        verifier: {
          predicateKind: "operation_result",
          specId: "package_typecheck",
          specVersion: 1,
        },
        operation: {
          exitCode: 1,
          verificationCommand: verifierCommand,
        },
      },
    });

    const attemptIssues = events.filter((event) =>
      event.type === "program.transitioned"
      && record(event.payload).transitionKind === "attempt.issue");
    const attemptIds = attemptIssues.map((event) => {
      const state = record(record(event.payload).state);
      return String(record(state.activeAttempt).programAttemptId);
    });
    expect(new Set(attemptIds).size).toBeGreaterThanOrEqual(2);
    expect(failure!.sequence).toBeLessThan(attemptIssues.at(-1)!.sequence);

    const verificationRequests = events.filter((event) => {
      if (event.type !== "operation.requested") return false;
      const invocation = record(record(event.payload).programVerificationInvocation);
      return invocation.specId === "package_typecheck";
    });
    expect(verificationRequests.length).toBeGreaterThanOrEqual(2);
    expect(events.some((event) => event.type === "program.completed")).toBe(true);
    const completion = events.find((event) => event.type === "program.completed")!;
    expect(completion.sequence).toBeGreaterThan(failure!.sequence);
  }, 130_000);
});
