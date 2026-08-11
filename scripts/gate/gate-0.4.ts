// Gate 0.4 — Phase 0.4 exit gate.
//
// Composes gate:0.3, then verifies @alcode/reasoning typecheck/tests,
// schema v7, reasoning projection v2 rebuild, differential fixtures,
// and no-detached-worker.

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

  // 0. Compose gate:0.3
  {
    const result = run("npx", ["tsx", "scripts/gate/gate-0.3.ts"], {
      cwd: ROOT, throwOnError: false,
    });
    const passed = result.exitCode === 0;
    const statusMatch = result.stdout.match(/Gate 0\.3:\s+(PASSED|FAILED)/);
    checks.push({
      id: "phase0.gate_composition",
      status: passed ? "passed" : "failed",
      evidence: statusMatch ? statusMatch[0] : (passed ? "gate:0.3 passed" : "gate:0.3 FAILED"),
    });
  }

  // 1. Reasoning + storage typecheck
  for (const pkg of ["reasoning", "storage"]) {
    const result = run("npx", ["tsc", "--noEmit", "-p", `packages/${pkg}/tsconfig.json`], {
      cwd: ROOT, throwOnError: false,
    });
    checks.push({
      id: `${pkg}.typecheck`,
      status: result.exitCode === 0 ? "passed" : "failed",
      evidence: result.exitCode === 0 ? "tsc clean" : `${result.stdout}\n${result.stderr}`.trim().slice(0, 200),
    });
  }

  // 2. Reasoning tests (including differential fixtures)
  {
    const result = run("npx", ["vitest", "run"], {
      cwd: join(ROOT, "packages/reasoning"), throwOnError: false,
    });
    const passed = result.exitCode === 0;
    const summaryMatch = result.stdout.match(/Tests\s+(\d+ passed|\d+ failed)/);
    const failureOutput = `${result.stdout}\n${result.stderr}`.trim();
    checks.push({
      id: "reasoning.tests",
      status: passed ? "passed" : "failed",
      evidence: passed ? (summaryMatch ? summaryMatch[0] : "vitest pass") : failureOutput.slice(0, 4000),
    });
  }

  // 3. Storage tests
  {
    const result = run("npx", ["vitest", "run"], {
      cwd: join(ROOT, "packages/storage"), throwOnError: false,
    });
    const passed = result.exitCode === 0;
    const summaryMatch = result.stdout.match(/Tests\s+(\d+ passed|\d+ failed)/);
    checks.push({
      id: "storage.tests",
      status: passed ? "passed" : "failed",
      evidence: passed ? (summaryMatch ? summaryMatch[0] : "vitest pass") : `${result.stdout}\n${result.stderr}`.trim().slice(0, 4000),
    });
  }

  // 4. Schema version is 7
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

  // 5. No-detached-worker check
  {
    const result = run("npx", ["tsx", "-e", `
      import { readFileSync, readdirSync, existsSync } from "node:fs";
      import { join } from "node:path";
      const dir = "${join(ROOT, "packages/reasoning/src").replace(/\\/g, "/")}";
      if (!existsSync(dir)) { console.error("reasoning package src not found"); process.exit(1); }
      function walk(d) {
        for (const f of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, f.name);
          if (f.isDirectory()) walk(p);
          else if (f.name.endsWith(".ts") && !f.name.endsWith(".test.ts")) {
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
      evidence: result.exitCode === 0 ? "no process/worker/scheduler code in @alcode/reasoning" : result.stderr.slice(0, 200),
    });
  }

  // 6. Differential fixtures present and executed
  {
    const fixtureCheck = run("npx", ["tsx", "-e", `
      import { readFileSync, existsSync } from "node:fs";
      import { join } from "node:path";
      const dir = "${join(ROOT, "packages/reasoning/fixtures").replace(/\\/g, "/")}";
      const expected = ["normal-flow.json", "replay-duplicate.json", "event-prefix.json", "falsifier.json"];
      let totalCases = 0;
      for (const f of expected) {
        const p = join(dir, f);
        if (!existsSync(p)) { console.error("MISSING fixture: " + f); process.exit(1); }
        const json = JSON.parse(readFileSync(p, "utf-8"));
        totalCases += (json.cases || []).length;
      }
      console.log(totalCases + " differential cases across 4 fixture files");
      process.exit(0);
    `], { cwd: ROOT, throwOnError: false });

    if (fixtureCheck.exitCode !== 0) {
      checks.push({
        id: "phase0.differential_fixtures",
        status: "failed",
        evidence: fixtureCheck.stderr.slice(0, 200),
      });
    } else {
      const result = run("npx", ["vitest", "run", "src/differential.test.ts"], {
        cwd: join(ROOT, "packages/reasoning"), throwOnError: false,
      });
      const passed = result.exitCode === 0;
      const summaryMatch = result.stdout.match(/Tests\s+(\d+ passed|\d+ failed)/);
      checks.push({
        id: "phase0.differential_fixtures",
        status: passed ? "passed" : "failed",
        evidence: passed
          ? `${fixtureCheck.stdout.trim()} — ${summaryMatch ? summaryMatch[0] : "all passed"}`
          : `${result.stdout}\n${result.stderr}`.trim().slice(0, 4000),
      });
    }
  }

  // Build receipt
  const receipt = buildReceipt({
    gate: "0.4",
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
  const receiptPath = join(receiptsDir, `0.4-${safeSha}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(`\nreceipt: ${receiptPath}`);

  process.exit(receipt.status === "passed" ? 0 : 1);
}

main().catch((e) => {
  console.error("gate 0.4 crashed:", e);
  process.exit(2);
});
