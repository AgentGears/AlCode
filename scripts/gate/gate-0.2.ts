// Gate 0.2 — Phase 0.2 exit gate. See docs/phase-0-spec.md §0.2.
//
// Composes gate:0.1A (transitively gate:0.0), then adds:
//   1. Storage typecheck + tests (including crash matrix + recovery).
//   2. Coding-agent typecheck + tests (including crash-vertical integration).
//   3. The exact Phase 0.2 vertical slice (objective.set, memory.created,
//      derived projections, transcript, stop/reopen/recover/resume).
//   4. Crash matrix: five implementable boundaries + documented memory skip.
//   5. Derived rebuild equivalence.
//   6. Pre-persistence secret invariant.

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { GateCheck } from "./receipt.ts";
import { buildReceipt, formatReceipt } from "./receipt.ts";
import { run } from "./run.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ALCODE_HOME = process.env.ALCODE_HOME ?? join(homedir(), ".alcode");

function commitSha(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return dirty.length > 0 ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const sha = commitSha();
  const checks: GateCheck[] = [];

  // 0. Compose Phase 0.1A gate (transitively composes 0.0)
  {
    const result = run("npx", ["tsx", "scripts/gate/gate-0.1A.ts"], {
      cwd: ROOT, throwOnError: false,
    });
    const passed = result.exitCode === 0;
    const statusMatch = result.stdout.match(/Gate 0\.1A:\s+(PASSED|FAILED)/);
    checks.push({
      id: "phase0.gate_composition",
      status: passed ? "passed" : "failed",
      evidence: statusMatch ? statusMatch[0] : (passed ? "gate:0.1A passed" : "gate:0.1A FAILED"),
    });
  }

  // 1. Storage typecheck
  {
    const result = run("npx", ["tsc", "--noEmit", "-p", "packages/storage/tsconfig.json"], {
      cwd: ROOT, throwOnError: false,
    });
    checks.push({
      id: "storage.typecheck",
      status: result.exitCode === 0 ? "passed" : "failed",
      evidence: result.exitCode === 0 ? "tsc clean" : `${result.stdout}\n${result.stderr}`.trim().slice(0, 200),
    });
  }

  // 2. Storage tests (event store, operations, projections, crash matrix, recovery)
  {
    // Run through pnpm's workspace filter so process.cwd() remains the storage
    // package, which is part of the cross-process workspace-lock test contract.
    const result = run("pnpm", ["--filter", "@alcode/storage", "exec", "vitest", "run"], {
      cwd: ROOT, throwOnError: false,
    });
    const passed = result.exitCode === 0;
    const summaryMatch = result.stdout.match(/Tests\s+(\d+ passed|\d+ failed)/);
    const failureOutput = `${result.stdout}\n${result.stderr}`.trim();
    checks.push({
      id: "storage.tests",
      status: passed ? "passed" : "failed",
      evidence: passed ? (summaryMatch ? summaryMatch[0] : "vitest pass") : failureOutput.slice(0, 4000),
    });
  }

  // 3. Coding-agent tests (including crash-vertical integration)
  {
    const result = run("npx", ["vitest", "run", "packages/coding-agent/src"], {
      cwd: ROOT, throwOnError: false,
    });
    const passed = result.exitCode === 0;
    const summaryMatch = result.stdout.match(/Tests\s+(\d+ passed|\d+ failed)/);
    const failureOutput = `${result.stdout}\n${result.stderr}`.trim();
    checks.push({
      id: "coding-agent.tests",
      status: passed ? "passed" : "failed",
      evidence: passed ? (summaryMatch ? summaryMatch[0] : "vitest pass") : failureOutput.slice(0, 4000),
    });
  }

  // 3b. Exact Phase 0.2 vertical test — the frozen gate sequence as an explicit check
  {
    const result = run("npx", ["vitest", "run", "packages/coding-agent/src/phase-0.2-vertical.test.ts"], {
      cwd: ROOT, throwOnError: false,
    });
    const passed = result.exitCode === 0;
    const summaryMatch = result.stdout.match(/Tests\s+(\d+ passed|\d+ failed)/);
    const failureOutput = `${result.stdout}\n${result.stderr}`.trim();
    checks.push({
      id: "phase0.exact_vertical",
      status: passed ? "passed" : "failed",
      evidence: passed ? (summaryMatch ? `${summaryMatch[0]} (exact gate sequence)` : "exact vertical passed") : failureOutput.slice(0, 4000),
    });
  }

  // 4. Schema version is 5 (transcript_messages table present)
  {
    const result = run("npx", ["tsx", "-e", `
      import { readFileSync } from "node:fs";
      const content = readFileSync("${join(ROOT, "packages/storage/src/schema.ts").replace(/\\/g, "/")}", "utf-8");
      const match = content.match(/export const SCHEMA_VERSION = (\\d+)/);
      if (match && match[1] === "7") { console.log("SCHEMA_VERSION=7"); process.exit(0); }
      console.log("SCHEMA_VERSION=" + (match ? match[1] : "unknown")); process.exit(1);
    `], { cwd: ROOT, throwOnError: false });
    checks.push({
      id: "phase0.schema_version",
      status: result.exitCode === 0 ? "passed" : "failed",
      evidence: result.exitCode === 0 ? "SCHEMA_VERSION=7" : result.stdout.trim().slice(0, 100),
    });
  }

  // 5. Crash matrix — verified by the storage recovery tests + coding-agent
  //    crash-vertical tests above. Each scenario is an explicit test:
  //    - scenario 1: after append, before projection completion
  //    - scenario 2: after tool start, before result commit
  //    - scenario 3: after external mutation, before completed
  //    - scenario 4: before final commit of a turn
  //    - scenario 5: during projection update (mid-transaction)
  //    - scenario 6: during memory consolidation (DEFERRED — memory scoring
  //      not implemented in Phase 0.2; spec line 306-308 explicitly excludes
  //      scoring/full memory from this phase)
  {
    // The crash scenarios are part of the storage and coding-agent test suites.
    // We verify their presence by checking the test files exist and the suites
    // passed (checked above). This check documents the coverage explicitly.
    const recoveryTestExists = run("npx", ["tsx", "-e", `
      import { readFileSync } from "node:fs";
      const content = readFileSync("${join(ROOT, "packages/storage/src/recovery.test.ts").replace(/\\/g, "/")}", "utf-8");
      const scenarios = ["scenario 1", "scenario 2", "scenario 3", "scenario 4", "scenario 5"];
      const missing = scenarios.filter(s => !content.includes(s));
      if (missing.length > 0) { console.log("MISSING: " + missing.join(", ")); process.exit(1); }
      console.log("5 crash scenarios present + memory consolidation deferred");
      process.exit(0);
    `], { cwd: ROOT, throwOnError: false });
    checks.push({
      id: "phase0.crash_matrix",
      status: recoveryTestExists.exitCode === 0 ? "passed" : "failed",
      evidence: recoveryTestExists.exitCode === 0 ? "5 implementable boundaries + documented consolidation skip" : recoveryTestExists.stdout.trim().slice(0, 200),
    });
  }

  // 6. Canonical recovery (operation.interrupted is event-sourced)
  {
    const opsContent = run("npx", ["tsx", "-e", `
      import { readFileSync } from "node:fs";
      const content = readFileSync("${join(ROOT, "packages/storage/src/operations.ts").replace(/\\/g, "/")}", "utf-8");
      const hasInterrupted = content.includes("operation.interrupted") && content.includes("update-interrupted");
      const hasOneWay = content.includes("reconciliation_status = 'not_required'");
      if (hasInterrupted && hasOneWay) { console.log("canonical recovery present"); process.exit(0); }
      console.log("MISSING canonical recovery"); process.exit(1);
    `], { cwd: ROOT, throwOnError: false });
    checks.push({
      id: "phase0.canonical_recovery",
      status: opsContent.exitCode === 0 ? "passed" : "failed",
      evidence: opsContent.exitCode === 0 ? "operation.interrupted event-sourced, one-way not_required→pending" : opsContent.stdout.trim().slice(0, 200),
    });
  }

  // Build receipt
  const receipt = buildReceipt({
    gate: "0.2",
    commitSha: sha,
    startedAt,
    inputs: [{ name: `node@${process.version}` }],
    checks,
  });

  console.log(formatReceipt(receipt));

  const receiptsDir = join(ALCODE_HOME, "gate-receipts");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(receiptsDir, { recursive: true });
  const safeSha = sha.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 16);
  const receiptPath = join(receiptsDir, `0.2-${safeSha}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(`\nreceipt: ${receiptPath}`);

  process.exit(receipt.status === "passed" ? 0 : 1);
}

main().catch((e) => {
  console.error("gate 0.2 crashed:", e);
  process.exit(2);
});
