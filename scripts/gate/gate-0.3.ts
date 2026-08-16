// Gate 0.3 — Phase 0.3 exit gate. See docs/phase-0-spec.md §0.3.
//
// Composes gate:0.2 (transitively gate:0.1A, gate:0.0), then adds:
//   1. @alcode/memory typecheck + tests (semantic formulas, fixtures).
//   2. Storage typecheck + tests (schema v6 migration, memory projection v2).
//   3. Current storage schema version (memory_stats table preserved).
//   4. No-detached-worker check (memory package has no process/scheduler code).
//   5. Ola differential fixture families present (5 families in semantic tests).

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
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

  // 0. Compose Phase 0.2 gate
  {
    const result = run("npx", ["tsx", "scripts/gate/gate-0.2.ts"], {
      cwd: ROOT, throwOnError: false,
    });
    const passed = result.exitCode === 0;
    const statusMatch = result.stdout.match(/Gate 0\.2:\s+(PASSED|FAILED)/);
    checks.push({
      id: "phase0.gate_composition",
      status: passed ? "passed" : "failed",
      evidence: statusMatch ? statusMatch[0] : (passed ? "gate:0.2 passed" : "gate:0.2 FAILED"),
    });
  }

  // 1. Memory + storage typecheck
  for (const pkg of ["memory", "storage"]) {
    const result = run("npx", ["tsc", "--noEmit", "-p", `packages/${pkg}/tsconfig.json`], {
      cwd: ROOT, throwOnError: false,
    });
    checks.push({
      id: `${pkg}.typecheck`,
      status: result.exitCode === 0 ? "passed" : "failed",
      evidence: result.exitCode === 0 ? "tsc clean" : `${result.stdout}\n${result.stderr}`.trim().slice(0, 200),
    });
  }

  // 2. Memory + storage tests
  for (const pkg of ["memory", "storage"]) {
    const result = run("npx", ["vitest", "run"], {
      cwd: join(ROOT, `packages/${pkg}`), throwOnError: false,
    });
    const passed = result.exitCode === 0;
    const summaryMatch = result.stdout.match(/Tests\s+(\d+ passed|\d+ failed)/);
    const failureOutput = `${result.stdout}\n${result.stderr}`.trim();
    checks.push({
      id: `${pkg}.tests`,
      status: passed ? "passed" : "failed",
      evidence: passed ? (summaryMatch ? summaryMatch[0] : "vitest pass") : failureOutput.slice(0, 4000),
    });
  }

  // 3. Current storage schema version, preserving the Phase 0.3 structures.
  {
    const result = run("npx", ["tsx", "-e", `
      import { readFileSync } from "node:fs";
      const content = readFileSync("${join(ROOT, "packages/storage/src/schema.ts").replace(/\\/g, "/")}", "utf-8");
      const match = content.match(/export const SCHEMA_VERSION = (\\d+)/);
      if (match && match[1] === "8") { console.log("SCHEMA_VERSION=8"); process.exit(0); }
      console.log("SCHEMA_VERSION=" + (match ? match[1] : "unknown")); process.exit(1);
    `], { cwd: ROOT, throwOnError: false });
    checks.push({
      id: "phase0.schema_version",
      status: result.exitCode === 0 ? "passed" : "failed",
      evidence: result.exitCode === 0 ? "SCHEMA_VERSION=8" : result.stdout.trim().slice(0, 100),
    });
  }

  // 4. No-detached-worker check — @alcode/memory must not own process/scheduler code
  {
    const result = run("npx", ["tsx", "-e", `
      import { readFileSync, readdirSync, existsSync } from "node:fs";
      import { join } from "node:path";
      const dir = "${join(ROOT, "packages/memory/src").replace(/\\/g, "/")}";
      if (!existsSync(dir)) { console.error("memory package src not found"); process.exit(1); }
      function walk(d) {
        for (const f of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, f.name);
          if (f.isDirectory()) walk(p);
          else if (f.name.endsWith(".ts")) {
            const c = readFileSync(p, "utf-8");
            if (c.includes("child_process") || c.includes("worker_threads") || c.includes("setInterval")) {
              console.error("FORBIDDEN in " + p + ": process/worker/scheduler code");
              process.exit(1);
            }
          }
        }
      }
      walk(dir);
      console.log("no detached worker code");
      process.exit(0);
    `], { cwd: ROOT, throwOnError: false });
    checks.push({
      id: "phase0.no_detached_worker",
      status: result.exitCode === 0 ? "passed" : "failed",
      evidence: result.exitCode === 0 ? "no process/worker/scheduler code in @alcode/memory" : result.stderr.slice(0, 200),
    });
  }

  // 5. Ola differential fixtures — checked-in JSON corpus + execution
  {
    // First verify the fixture JSON files exist and have oracle metadata
    const fixtureCheck = run("npx", ["tsx", "-e", `
      import { readFileSync, existsSync } from "node:fs";
      import { join } from "node:path";
      const dir = "${join(ROOT, "packages/memory/fixtures").replace(/\\/g, "/")}";
      const expected = ["strength.json", "scoring.json", "reinforcement.json", "lifecycle.json"];
      let totalCases = 0;
      for (const f of expected) {
        const p = join(dir, f);
        if (!existsSync(p)) { console.error("MISSING fixture: " + f); process.exit(1); }
        const json = JSON.parse(readFileSync(p, "utf-8"));
        if (!json.oracle || !json.oracle.source) { console.error("MISSING oracle metadata in " + f); process.exit(1); }
        totalCases += (json.cases || []).length;
      }
      console.log(totalCases + " differential cases across 3 fixture files");
      process.exit(0);
    `], { cwd: ROOT, throwOnError: false });

    if (fixtureCheck.exitCode !== 0) {
      checks.push({
        id: "phase0.differential_fixtures",
        status: "failed",
        evidence: fixtureCheck.stderr.slice(0, 200),
      });
    } else {
      // Then run the actual differential test suite
      const result = run("npx", ["vitest", "run", "src/differential.test.ts"], {
        cwd: join(ROOT, "packages/memory"), throwOnError: false,
      });
      const passed = result.exitCode === 0;
      const summaryMatch = result.stdout.match(/Tests\s+(\d+ passed|\d+ failed)/);
      const failureOutput = `${result.stdout}\n${result.stderr}`.trim();
      checks.push({
        id: "phase0.differential_fixtures",
        status: passed ? "passed" : "failed",
        evidence: passed
          ? `${fixtureCheck.stdout.trim()} — ${summaryMatch ? summaryMatch[0] : "all passed"}`
          : failureOutput.slice(0, 4000),
      });
    }
  }

  // Build receipt
  const receipt = buildReceipt({
    gate: "0.3",
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
  const receiptPath = join(receiptsDir, `0.3-${safeSha}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(`\nreceipt: ${receiptPath}`);

  process.exit(receipt.status === "passed" ? 0 : 1);
}

main().catch((e) => {
  console.error("gate 0.3 crashed:", e);
  process.exit(2);
});
