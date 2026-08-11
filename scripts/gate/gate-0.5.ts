// Gate 0.5 — Host runtime + durable cognition integration.
//
// Composes the closed Phase 0.4 gate, then executes only the frozen Phase 0.5
// proofs: Host-owned admission/execution, cognition roundtrips, replaceable
// Agent continuity, recovery, bounded durable work, completion authority, and
// structural ownership boundaries.

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

function evidence(result: ReturnType<typeof run>, success = "passed"): string {
  if (result.exitCode === 0) {
    const summary = result.stdout.match(/Tests\s+(\d+ passed|\d+ failed)/);
    return summary ? summary[0] : success;
  }
  return `${result.stdout}\n${result.stderr}`.trim().slice(0, 4000);
}

function vitestCheck(
  checks: GateCheck[],
  id: string,
  file: string,
  testName?: string,
): void {
  const args = ["vitest", "run", file];
  if (testName) args.push("-t", testName);
  const result = run("npx", args, { cwd: ROOT, throwOnError: false });
  checks.push({
    id,
    status: result.exitCode === 0 ? "passed" : "failed",
    evidence: evidence(result),
  });
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const sha = commitSha();
  const checks: GateCheck[] = [];

  // 0. Closed Phase 0.4 remains green unchanged.
  {
    const result = run("npx", ["tsx", "scripts/gate/gate-0.4.ts"], {
      cwd: ROOT,
      throwOnError: false,
    });
    const passed = result.exitCode === 0;
    const match = result.stdout.match(/Gate 0\.4:\s+(PASSED|FAILED)/);
    checks.push({
      id: "phase0.gate_composition",
      status: passed ? "passed" : "failed",
      evidence: match ? match[0] : (passed ? "gate:0.4 passed" : evidence(result)),
    });
  }

  // 1. Typecheck every Phase 0.5 boundary plus the two additive integration packages.
  const typechecks: Array<[string, string]> = [
    ["agent_protocol.typecheck", "packages/agent-protocol/tsconfig.json"],
    ["cognition_runtime.typecheck", "packages/cognition-runtime/tsconfig.json"],
    ["host_runtime.typecheck", "packages/host-runtime/tsconfig.json"],
    ["cognition_extension.typecheck", "extensions/cognition/tsconfig.json"],
    ["coding_agent.typecheck", "packages/coding-agent/tsconfig.json"],
    ["storage.typecheck", "packages/storage/tsconfig.json"],
    ["reasoning.typecheck", "packages/reasoning/tsconfig.json"],
  ];
  for (const [id, config] of typechecks) {
    const result = run("npx", ["tsc", "--noEmit", "-p", config], {
      cwd: ROOT,
      throwOnError: false,
    });
    checks.push({
      id,
      status: result.exitCode === 0 ? "passed" : "failed",
      evidence: result.exitCode === 0 ? "tsc clean" : evidence(result),
    });
  }

  // 2. Protocol + pure coordinator policy.
  vitestCheck(checks, "agent_protocol.tests", "packages/agent-protocol/src/protocol.test.ts");
  vitestCheck(checks, "cognition_runtime.tests", "packages/cognition-runtime/src/coordinator.test.ts");

  // 3. Canonical cognition integration and Host execution barriers.
  const hostIntegration = "packages/host-runtime/src/host-runtime.integration.test.ts";
  vitestCheck(checks, "host.permission_before_execution", hostIntegration, "denies a mutating capability");
  vitestCheck(checks, "host.operation_visibility_before_action", hostIntegration, "makes operation + action canonical");
  vitestCheck(checks, "cognition.open_investigation_batch", hostIntegration, "resolves open_investigation symbolic references");

  const cognitionIntegration = "packages/host-runtime/src/cognition-integration.test.ts";
  vitestCheck(checks, "cognition.memory_roundtrip", cognitionIntegration, "binds remember");
  vitestCheck(checks, "cognition.verification_trusted", cognitionIntegration, "unique trusted verification");
  vitestCheck(checks, "cognition.verification_untrusted", cognitionIntegration, "untrusted verification");
  vitestCheck(checks, "cognition.verification_ambiguous", cognitionIntegration, "ambiguous prospective match");

  // 4. Recovery + bounded durable work.
  const recoveryIntegration = "packages/host-runtime/src/recovery.integration.test.ts";
  vitestCheck(checks, "host.reopen_uncertain_operation", recoveryIntegration, "reopens an interrupted possibly-mutating operation");
  const workResult = run("npx", [
    "vitest", "run", recoveryIntegration, "-t",
    "retries interrupted consolidation after semantic commit",
  ], { cwd: ROOT, throwOnError: false });
  checks.push({
    id: "work.consolidation_recovery",
    status: workResult.exitCode === 0 ? "passed" : "failed",
    evidence: evidence(workResult),
  });
  checks.push({
    id: "work.exactly_once_effect",
    status: workResult.exitCode === 0 ? "passed" : "failed",
    evidence: workResult.exitCode === 0 ? "same pre-minted memory event survives retry" : evidence(workResult),
  });

  // 5. Signature replaceable-Agent process proof and protocol duplicate delivery.
  vitestCheck(
    checks,
    "agent.replacement_continuity",
    "packages/coding-agent/src/agent-replacement.integration.test.ts",
  );
  vitestCheck(
    checks,
    "protocol.duplicate_delivery",
    "packages/host-runtime/src/protocol-dedup.integration.test.ts",
  );

  // 6. Host closure authority.
  vitestCheck(
    checks,
    "completion.host_authority",
    "packages/host-runtime/src/completion.integration.test.ts",
  );

  // 7. Structural ownership/exclusion boundaries.
  const boundaries = "packages/host-runtime/src/boundaries.test.ts";
  vitestCheck(checks, "boundary.extension_is_thin", boundaries, "keeps the cognition extension thin");
  vitestCheck(checks, "boundary.agent_has_no_storage", boundaries, "keeps the replaceable Agent worker free");
  vitestCheck(checks, "boundary.no_context_compiler", boundaries, "does not introduce Phase 0.6/0.7 context compilers");

  const receipt = buildReceipt({
    gate: "0.5",
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
  const receiptPath = join(
    receiptsDir,
    `0.5-${safeSha}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(`\nreceipt: ${receiptPath}`);

  process.exit(receipt.status === "passed" ? 0 : 1);
}

main().catch((error) => {
  console.error("gate 0.5 crashed:", error);
  process.exit(2);
});
