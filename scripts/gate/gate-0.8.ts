// Gate 0.8 — Host-owned Application Protocol + React Experience Plane.
// Composes the closed Phase 0.7 gate unchanged and emits only the frozen
// Phase 0.8 proof-family IDs from docs/phase-0.8-plan.md.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { GateCheck } from "./receipt.ts";
import { buildReceipt, formatReceipt } from "./receipt.ts";
import { run, type RunResult } from "./run.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ALCODE_HOME = process.env.ALCODE_HOME ?? join(homedir(), ".alcode");

function commitSha(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return dirty.length > 0 ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

function evidence(result: RunResult, success = "passed"): string {
  if (result.exitCode === 0) {
    const summary = result.stdout.match(/Tests\s+(\d+ passed|\d+ failed)/);
    return summary ? summary[0] : (result.stdout.trim().slice(0, 500) || success);
  }
  return `${result.stdout}\n${result.stderr}`.trim().slice(0, 4000);
}

function record(checks: GateCheck[], ids: readonly string[], result: RunResult, success?: string): void {
  const status = result.exitCode === 0 ? "passed" : "failed";
  const detail = evidence(result, success);
  for (const id of ids) checks.push({ id, status, evidence: detail });
}

function recordCombined(checks: GateCheck[], id: string, results: readonly RunResult[], success: string): void {
  const failed = results.find((result) => result.exitCode !== 0);
  checks.push({ id, status: failed ? "failed" : "passed", evidence: failed ? evidence(failed) : success });
}

function workflowAnnotation(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").slice(0, 8000);
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const sha = commitSha();
  const checks: GateCheck[] = [];

  const gate07 = run("pnpm", ["gate:0.7"], { cwd: ROOT, throwOnError: false });
  record(checks, ["0.8.compose.0.7"], gate07, "closed Phase 0.7 gate passed unchanged");

  const protocolTypecheck = run("pnpm", ["--filter", "@alcode/application-protocol", "typecheck"], { cwd: ROOT, throwOnError: false });
  record(checks, ["0.8.protocol.contract"], protocolTypecheck, "@alcode/application-protocol typecheck clean");
  const hostTypecheck = run("pnpm", ["--filter", "@alcode/host-runtime", "typecheck"], { cwd: ROOT, throwOnError: false });
  record(checks, ["0.8.host.public-projection"], hostTypecheck, "@alcode/host-runtime typecheck clean");
  const webTypecheck = run("pnpm", ["--filter", "@alcode/web", "typecheck"], { cwd: ROOT, throwOnError: false });
  record(checks, ["0.8.web.typecheck"], webTypecheck, "@alcode/web typecheck clean");

  const protocolTests = run("pnpm", ["exec", "vitest", "run",
    "packages/application-protocol/src/validation.test.ts",
    "packages/application-protocol/src/reducer.test.ts",
  ], { cwd: ROOT, throwOnError: false });
  record(checks, [
    "0.8.protocol.validation",
    "0.8.protocol.cursor-chain",
  ], protocolTests);

  const hostTests = run("pnpm", ["exec", "vitest", "run", "packages/host-runtime/src/application-service.integration.test.ts"], { cwd: ROOT, throwOnError: false });
  record(checks, [
    "0.8.command.idempotence",
    "0.8.admission.routing",
    "0.8.queue.ordering",
    "0.8.cancel.stale-target",
    "0.8.reconnect.resume",
    "0.8.permission.interaction",
  ], hostTests);

  const webTests = run("pnpm", ["exec", "vitest", "run", "packages/web/src/web.test.tsx"], { cwd: ROOT, throwOnError: false });
  record(checks, [
    "0.8.react.rendering",
    "0.8.detach.not-cancel",
    "0.8.uncertainty.presentation",
  ], webTests);

  const boundaryTests = run("pnpm", ["exec", "vitest", "run",
    "packages/application-protocol/src/boundaries.test.ts",
    "packages/web/src/boundaries.test.ts",
  ], { cwd: ROOT, throwOnError: false });
  record(checks, ["0.8.ownership"], boundaryTests);

  recordCombined(
    checks,
    "0.8.cancel.detach",
    [hostTests, webTests],
    "explicit target-sensitive cancel and disconnect-without-cancel proofs passed",
  );

  const receipt = buildReceipt({
    gate: "0.8",
    commitSha: sha,
    startedAt,
    inputs: [
      { name: "docs/phase-0.8-plan.md" },
      { name: "docs/research/phase-0.8-decisions.md" },
      { name: "docs/research/phase-0.8-pressure-test.md" },
    ],
    checks,
  });

  console.log(formatReceipt(receipt));
  const receiptsDir = join(ALCODE_HOME, "gate-receipts");
  mkdirSync(receiptsDir, { recursive: true });
  const safeSha = sha.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 16);
  const receiptPath = join(receiptsDir, `0.8-${safeSha}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(`\nreceipt: ${receiptPath}`);

  if (receipt.status === "failed" && process.env.GITHUB_ACTIONS === "true") {
    for (const check of receipt.checks.filter((item) => item.status === "failed")) {
      console.log(`::error title=${workflowAnnotation(check.id)}::${workflowAnnotation(check.evidence ?? "check failed")}`);
    }
  }

  process.exit(receipt.status === "passed" ? 0 : 1);
}

main().catch((error) => {
  console.error("gate 0.8 crashed:", error);
  process.exit(2);
});
