// Gate 0.0 — Phase 0.0 exit gate. See docs/phase-0-spec.md §0.0.
//
// Verifies the executable foundation:
//   - workspace config files exist
//   - licensing files exist
//   - ADRs 0001-0004 exist
//   - threat-model.md and operation-recovery.md exist
//   - packages/events typechecks
//   - packages/events tests pass
//   - event-contract.md, constitution.md, rules.md exist
//
// Emits a GateReceipt to stdout and writes it to
//   $ALCODE_HOME/gate-receipts/0.0-<commitSha>-<ts>.json
// Exit code 0 on pass, 1 on fail.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { GateCheck } from "./receipt.ts";
import { buildReceipt, formatReceipt } from "./receipt.ts";
import { run, checkPath } from "./run.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ALCODE_HOME = process.env.ALCODE_HOME ?? join(homedir(), ".alcode");

function commitSha(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
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

  // --- Structural checks: required workspace files ---
  const requiredFiles: Array<[string, string]> = [
    ["docs/constitution.md", "constitution"],
    ["docs/rules.md", "hard rules"],
    ["docs/event-contract.md", "event contract"],
    ["docs/non-goals.md", "non-goals"],
    ["docs/backlog.md", "backlog"],
    ["docs/threat-model.md", "threat model"],
    ["docs/operation-recovery.md", "operation recovery"],
    ["docs/adr/0001-event-and-projection-commit-semantics.md", "ADR 0001"],
    ["docs/adr/0002-workspace-identity-and-locking.md", "ADR 0002"],
    ["docs/adr/0003-tool-operation-uncertainty-and-recovery.md", "ADR 0003"],
    ["docs/adr/0004-secret-admission-and-erasure.md", "ADR 0004"],
    ["LICENSE", "license"],
    ["THIRD_PARTY_NOTICES.md", "third-party notices"],
    ["package.json", "workspace package.json"],
    ["pnpm-workspace.yaml", "pnpm workspace config"],
    ["tsconfig.base.json", "base tsconfig"],
  ];

  for (const [rel, label] of requiredFiles) {
    const present = checkPath(join(ROOT, rel));
    checks.push({
      id: `workspace.${label.replace(/\s+/g, "_")}.present`,
      status: present ? "passed" : "failed",
      evidence: rel,
    });
  }

  // --- packages/events typechecks ---
  {
    const result = run(
      "npx",
      ["tsc", "--noEmit", "-p", "packages/events/tsconfig.json"],
      { cwd: ROOT, throwOnError: false },
    );
    checks.push({
      id: "events.typecheck",
      status: result.exitCode === 0 ? "passed" : "failed",
      evidence: result.exitCode === 0 ? "tsc clean" : `${result.stderr.slice(0, 200)}`,
    });
  }

  // --- packages/events tests pass ---
  {
    const result = run(
      "npx",
      ["vitest", "run", "--root", "packages/events/src"],
      { cwd: ROOT, throwOnError: false },
    );
    // vitest exits 0 on all-pass, 1 on any failure.
    const passed = result.exitCode === 0;
    // Extract the test count summary line if present.
    const summaryMatch = result.stdout.match(/Tests\s+(\d+ passed|\d+ failed)/);
    checks.push({
      id: "events.tests",
      status: passed ? "passed" : "failed",
      evidence: summaryMatch ? summaryMatch[0] : (passed ? "vitest pass" : `${result.stderr.slice(0, 200)}`),
    });
  }

  // --- packages/test-provider typechecks ---
  {
    const result = run(
      "npx",
      ["tsc", "--noEmit", "-p", "packages/test-provider/tsconfig.json"],
      { cwd: ROOT, throwOnError: false },
    );
    checks.push({
      id: "test-provider.typecheck",
      status: result.exitCode === 0 ? "passed" : "failed",
      evidence: result.exitCode === 0 ? "tsc clean" : `${result.stderr.slice(0, 200)}`,
    });
  }

  // --- packages/test-provider tests pass ---
  {
    const result = run(
      "npx",
      ["vitest", "run", "--root", "packages/test-provider/src"],
      { cwd: ROOT, throwOnError: false },
    );
    const passed = result.exitCode === 0;
    const summaryMatch = result.stdout.match(/Tests\s+(\d+ passed|\d+ failed)/);
    checks.push({
      id: "test-provider.tests",
      status: passed ? "passed" : "failed",
      evidence: summaryMatch ? summaryMatch[0] : (passed ? "vitest pass" : `${result.stderr.slice(0, 200)}`),
    });
  }

  // --- Build the receipt ---
  const receipt = buildReceipt({
    gate: "0.0",
    commitSha: sha,
    startedAt,
    inputs: [
      { name: `node@${process.version}` },
      { name: `pnpm@${process.env.npm_config_user_agent ?? "unknown"}` },
    ],
    checks,
  });

  // --- Emit ---
  console.log(formatReceipt(receipt));

  const receiptsDir = join(ALCODE_HOME, "gate-receipts");
  mkdirSync(receiptsDir, { recursive: true });
  const safeSha = sha.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 16);
  const receiptPath = join(
    receiptsDir,
    `0.0-${safeSha}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(`\nreceipt: ${receiptPath}`);

  process.exit(receipt.status === "passed" ? 0 : 1);
}

main().catch((e) => {
  console.error("gate 0.0 crashed:", e);
  process.exit(2);
});

// Suppress unused-import warning for networkInterfaces (kept for future
// multi-instance lock diagnostics).
void networkInterfaces;
