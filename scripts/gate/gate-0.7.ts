import { buildReceipt, emitReceipt, runCommand, truncate, type GateCheck } from "./gate-lib.ts";

const root = process.cwd();
const checks: GateCheck[] = [];
let failed = false;

function record(ids: readonly string[], result: ReturnType<typeof runCommand>): void {
  const status = result.status === 0 ? "passed" : "failed";
  for (const id of ids) {
    checks.push({ id, status, evidence: truncate(result.output) });
  }
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.output);
  }
}

const gate06 = runCommand("pnpm", ["gate:0.6"], root);
record(["phase0.gate_composition"], gate06);
if (gate06.status !== 0) {
  const receipt = buildReceipt("gate:0.7", checks, [{ name: "phase0.6-receipt", digest: gate06.output }]);
  emitReceipt(receipt);
  process.exitCode = 1;
} else {
  const typecheck = runCommand("pnpm", ["--filter", "@alcode/context", "typecheck"], root);
  record(["context.typecheck"], typecheck);

  const contextSemantics = runCommand("pnpm", ["exec", "vitest", "run", "packages/context/src/context.test.ts"], root);
  record([
    "context.deterministic_compile",
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
  ], contextSemantics);

  const agentCore = runCommand("pnpm", ["exec", "vitest", "run", "packages/agent-core/src/agent-core.test.ts"], root);
  record([
    "context.inference_boundary_refresh",
    "context.no_request_without_host_context",
  ], agentCore);

  const hostIntegration = runCommand("pnpm", ["exec", "vitest", "run", "packages/host-runtime/src/context-integration.test.ts"], root);
  record([
    "context.dynamic_state_not_stale",
    "context.stable_source_cut",
    "context.workspace_observation_provenance",
    "context.workspace_observation_failure",
    "context.receipt_canonical",
    "context.receipt_audit_meta",
    "context.verbatim_default",
  ], hostIntegration);

  const receiptProjection = runCommand("pnpm", ["exec", "vitest", "run", "packages/storage/src/context-receipt-projection.test.ts"], root);
  record(["context.receipt_projection_rebuild"], receiptProjection);

  const protocol = runCommand("pnpm", ["exec", "vitest", "run", "packages/agent-protocol/src/protocol.test.ts"], root);
  record(["context.agent_protocol_capability"], protocol);

  const replacement = runCommand("pnpm", ["exec", "vitest", "run", "packages/coding-agent/src/context-replacement.integration.test.ts"], root);
  record(["context.agent_replacement"], replacement);

  const reopen = runCommand("pnpm", ["exec", "vitest", "run", "packages/host-runtime/src/context-reopen.integration.test.ts"], root);
  record(["context.host_reopen"], reopen);

  const experiment = runCommand("pnpm", ["exec", "vitest", "run", "packages/context/src/evaluation.test.ts"], root);
  record([
    "context.experiment_fixture_manifest",
    "context.experiment_paired_isolation",
    "context.experiment_metrics_captured",
    "context.graph_path_effective",
    "context.graph_reduces_context",
    "context.no_auto_promotion",
  ], experiment);

  const boundaries = runCommand("pnpm", ["exec", "vitest", "run", "packages/host-runtime/src/context-boundaries.test.ts"], root);
  record([
    "context.boundary_agent_no_context_authority",
    "context.boundary_no_cognition_mutation",
    "context.boundary_no_generated_compaction",
    "context.boundary_no_provider_specific_tokenizer",
  ], boundaries);

  const receipt = buildReceipt("gate:0.7", checks, [
    { name: "phase0.6-receipt", digest: gate06.output },
    { name: "phase0.7-plan", digest: "docs/phase-0.7-plan.md@39e4ac46715ecc67007195fe684a1e751c660b89" },
    { name: "phase0.7-preregistered-corpus", digest: "packages/context/fixtures/phase-0.7-evaluation-manifest.json" },
  ]);
  emitReceipt(receipt);
  if (failed) process.exitCode = 1;
}
