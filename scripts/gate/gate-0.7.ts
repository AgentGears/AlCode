// Gate 0.7 — Governed selective context / graph-v1.
// Composes the closed Phase 0.6 gate unchanged and emits only the frozen
// Phase 0.7 proof-family IDs from docs/phase-0.7-plan.md.

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
  checks.push({
    id,
    status: failed ? "failed" : "passed",
    evidence: failed ? evidence(failed) : success,
  });
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const sha = commitSha();
  const checks: GateCheck[] = [];

  const gate06 = run("pnpm", ["gate:0.6"], { cwd: ROOT, throwOnError: false });
  record(checks, ["phase0.gate_composition"], gate06, "closed Phase 0.6 gate passed unchanged");

  const contextTypecheck = run("pnpm", ["--filter", "@alcode/context", "typecheck"], { cwd: ROOT, throwOnError: false });
  record(checks, ["context.typecheck"], contextTypecheck, "@alcode/context typecheck clean");
  const hostTypecheck = run("pnpm", ["--filter", "@alcode/host-runtime", "typecheck"], { cwd: ROOT, throwOnError: false });
  record(checks, ["host_runtime.typecheck"], hostTypecheck, "@alcode/host-runtime typecheck clean");
  const protocolTypecheck = run("pnpm", ["--filter", "@alcode/agent-protocol", "typecheck"], { cwd: ROOT, throwOnError: false });
  record(checks, ["agent_protocol.typecheck"], protocolTypecheck, "@alcode/agent-protocol typecheck clean");
  const coreTypecheck = run("pnpm", ["--filter", "@alcode/agent-core", "typecheck"], { cwd: ROOT, throwOnError: false });
  record(checks, ["agent_core.typecheck"], coreTypecheck, "@alcode/agent-core typecheck clean");
  const codingTypecheck = run("pnpm", ["--filter", "@alcode/coding-agent", "typecheck"], { cwd: ROOT, throwOnError: false });
  record(checks, ["coding_agent.typecheck"], codingTypecheck, "@alcode/coding-agent typecheck clean");

  const contextTests = run("pnpm", ["exec", "vitest", "run", "packages/context/src/context.test.ts"], { cwd: ROOT, throwOnError: false });
  record(checks, [
    "context.tests",
    "context.workspace_digest_deterministic",
    "context.trust_classes",
    "context.source_data_not_control",
    "context.stored_injection_contained",
    "context.objective_not_control",
    "context.objective_scoped_frontier",
    "context.decision_inclusion",
    "context.falsifier_inclusion",
    "context.diagnostic_implicated_path",
    "context.unrelated_hypothesis_excluded",
    "context.transcript_current_turn",
    "context.transcript_previous_turn",
    "context.tool_pair_atomicity",
    "context.memory_positive_relevance",
    "context.memory_no_strength_only_selection",
    "context.memory_multi_anchor",
    "context.memory_no_reinforcement",
    "context.graph_hard_render_bound",
    "context.post_escape_costing",
    "context.required_overflow_fallback",
    "context.verbatim_budget_not_claimed",
    "context.receipt_bounded",
    "context.candidate_universe_digest",
    "context.request_environment_digest",
    "context.attempt_vs_delivery_cost",
  ], contextTests);

  const hostIntegration = run("pnpm", ["exec", "vitest", "run", "packages/host-runtime/src/context-integration.test.ts"], { cwd: ROOT, throwOnError: false });
  record(checks, [
    "context.stable_source_cut",
    "context.workspace_observation_provenance",
    "context.workspace_observation_failure",
    "context.dynamic_state_not_stale",
    "context.receipt_canonical",
    "context.meta_event_not_cognition",
    "context.verbatim_default",
  ], hostIntegration);

  const agentCore = run("pnpm", ["exec", "vitest", "run", "packages/agent-core/src/agent-core.test.ts"], { cwd: ROOT, throwOnError: false });
  record(checks, ["context.inference_boundary_refresh", "context.no_request_without_host_context"], agentCore);

  const receiptProjection = run("pnpm", ["exec", "vitest", "run", "packages/storage/src/context-receipt-projection.test.ts"], { cwd: ROOT, throwOnError: false });
  record(checks, ["context.receipt_projection_rebuild"], receiptProjection);

  const replacement = run("pnpm", ["exec", "vitest", "run", "packages/coding-agent/src/context-replacement.integration.test.ts"], { cwd: ROOT, throwOnError: false });
  record(checks, ["context.agent_replacement"], replacement);

  const reopen = run("pnpm", ["exec", "vitest", "run", "packages/host-runtime/src/context-reopen.integration.test.ts"], { cwd: ROOT, throwOnError: false });
  record(checks, ["context.host_reopen"], reopen);

  recordCombined(
    checks,
    "context.verbatim_fallback",
    [contextTests, hostIntegration],
    "required-overflow and workspace-failure fallback proofs passed",
  );

  const experiment = run("pnpm", ["exec", "vitest", "run", "packages/context/src/evaluation.test.ts"], { cwd: ROOT, throwOnError: false });
  record(checks, [
    "experiment.fixture_manifest_frozen",
    "experiment.isolated_pair",
    "experiment.metrics_captured",
    "experiment.graph_effective_nontrivial",
    "experiment.graph_reduces_context",
    "experiment.no_auto_promotion",
  ], experiment);

  const boundaries = run("pnpm", ["exec", "vitest", "run", "packages/host-runtime/src/context-boundaries.test.ts"], { cwd: ROOT, throwOnError: false });
  record(checks, [
    "boundary.host_owns_context",
    "boundary.agent_no_memory_search",
    "boundary.agent_no_graph_traversal",
    "boundary.no_llm_summarization",
    "boundary.no_provider_tokenizer",
    "boundary.no_input_dispatch_policy",
  ], boundaries);

  const receipt = buildReceipt({
    gate: "0.7",
    commitSha: sha,
    startedAt,
    inputs: [
      { name: "phase0.7-plan@39e4ac46715ecc67007195fe684a1e751c660b89" },
      { name: "phase0.7-preregistered-corpus@83c084a8654536cf9dc21494b1d67cc9fb6b6c90" },
    ],
    checks,
  });

  console.log(formatReceipt(receipt));
  const receiptsDir = join(ALCODE_HOME, "gate-receipts");
  mkdirSync(receiptsDir, { recursive: true });
  const safeSha = sha.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 16);
  const receiptPath = join(receiptsDir, `0.7-${safeSha}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(`\nreceipt: ${receiptPath}`);

  process.exit(receipt.status === "passed" ? 0 : 1);
}

main().catch((error) => {
  console.error("gate 0.7 crashed:", error);
  process.exit(2);
});
