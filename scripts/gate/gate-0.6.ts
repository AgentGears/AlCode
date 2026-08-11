// Gate 0.6 — Durable verbatim context reconstruction.
//
// Composes the closed Phase 0.5 gate, then executes only the frozen Phase 0.6
// proofs: canonical rich transcript semantics, Host-acknowledged admission,
// pi convertToLlm parity, stable-head reconstruction, incomplete-history
// fail-closed behavior, Host+Agent restart continuity, and context boundaries.

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
    return summary ? summary[0] : (result.stdout.trim().slice(0, 500) || success);
  }
  return `${result.stdout}\n${result.stderr}`.trim().slice(0, 4000);
}

function vitestCheck(
  checks: GateCheck[],
  id: string,
  file: string,
  testName?: string,
): GateCheck {
  const args = ["vitest", "run", file];
  if (testName) args.push("-t", testName);
  const result = run("npx", args, { cwd: ROOT, throwOnError: false });
  const check: GateCheck = {
    id,
    status: result.exitCode === 0 ? "passed" : "failed",
    evidence: evidence(result),
  };
  checks.push(check);
  return check;
}

function aliasCheck(checks: GateCheck[], id: string, sources: readonly GateCheck[], evidenceText: string): GateCheck {
  const passed = sources.every((source) => source.status === "passed");
  const check: GateCheck = {
    id,
    status: passed ? "passed" : "failed",
    evidence: passed ? evidenceText : `depends on: ${sources.map((source) => `${source.id}=${source.status}`).join(", ")}`,
  };
  checks.push(check);
  return check;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const sha = commitSha();
  const checks: GateCheck[] = [];

  // 0. The closed Phase 0.5 foundation remains green unchanged.
  {
    const result = run("npx", ["tsx", "scripts/gate/gate-0.5.ts"], { cwd: ROOT, throwOnError: false });
    const match = result.stdout.match(/Gate 0\.5:\s+(PASSED|FAILED)/);
    checks.push({
      id: "phase0.gate_composition",
      status: result.exitCode === 0 ? "passed" : "failed",
      evidence: match ? match[0] : evidence(result),
    });
  }

  // 1. Phase 0.6 public/runtime surfaces typecheck.
  const typechecks: Array<[string, string]> = [
    ["transcript.typecheck", "packages/transcript/tsconfig.json"],
    ["agent_protocol.typecheck", "packages/agent-protocol/tsconfig.json"],
    ["agent_core.typecheck", "packages/agent-core/tsconfig.json"],
    ["host_runtime.typecheck", "packages/host-runtime/tsconfig.json"],
    ["coding_agent.typecheck", "packages/coding-agent/tsconfig.json"],
  ];
  for (const [id, config] of typechecks) {
    const result = run("npx", ["tsc", "--noEmit", "-p", config], { cwd: ROOT, throwOnError: false });
    checks.push({ id, status: result.exitCode === 0 ? "passed" : "failed", evidence: result.exitCode === 0 ? "tsc clean" : evidence(result) });
  }

  // 2. Transcript semantics and pinned pi parity oracle.
  const transcriptTests = vitestCheck(checks, "transcript.tests", "packages/transcript/src/transcript.test.ts");
  void transcriptTests;

  {
    const result = run("npx", ["tsx", "scripts/import-pi.ts", "verify"], { cwd: ROOT, throwOnError: false });
    checks.push({
      id: "pi.verbatim_oracle",
      status: result.exitCode === 0 ? "passed" : "failed",
      evidence: evidence(result, "pinned pi context oracle verified"),
    });
  }

  const parityFile = "packages/transcript/src/pi-parity.test.ts";
  const verbatimUser = vitestCheck(checks, "verbatim.user", parityFile, "matches user text");
  const verbatimAssistant = vitestCheck(checks, "verbatim.assistant", parityFile, "matches assistant text");
  const verbatimToolCall = vitestCheck(checks, "verbatim.tool_call", parityFile, "matches assistant tool-call-only");
  const verbatimToolResult = vitestCheck(checks, "verbatim.tool_result", parityFile, "matches successful and failed tool results");
  const verbatimMultiTurn = vitestCheck(checks, "verbatim.multi_turn", parityFile, "matches a complete multi-turn conversation");
  void verbatimUser; void verbatimAssistant; void verbatimToolCall; void verbatimToolResult; void verbatimMultiTurn;

  // 3. Canonical transcript roundtrip, validation, completeness, and idempotency.
  const hostTranscript = "packages/host-runtime/src/transcript-0.6.integration.test.ts";
  const preappend = vitestCheck(checks, "transcript.preappend_validation", hostTranscript, "validates transcript semantics before canonical append");
  aliasCheck(checks, "transcript.rich_text_consistency", [preappend], "rich assistant text must equal concatenated text content before canonical append");

  const pairing = vitestCheck(checks, "transcript.tool_pairing", hostTranscript, "deduplicates the same transcript delivery");
  aliasCheck(checks, "transcript.canonical_roundtrip", [pairing], "canonical user/assistant/toolResult events reduce to the exact transcript message sequence");
  aliasCheck(checks, "transcript.duplicate_delivery", [pairing], "same generation + requestId resolves to one canonical transcript event");

  const closeReopen = vitestCheck(checks, "transcript.close_reopen", hostTranscript, "reconstructs the same message prefix after store close/reopen");
  const projectionRebuild = vitestCheck(checks, "transcript.projection_rebuild", "packages/storage/src/transcript-rebuild.test.ts");
  void closeReopen; void projectionRebuild;

  // 4. Admission ACK is the model-boundary durability barrier; tool identity is preserved end to end.
  const barrier = vitestCheck(checks, "transcript.admission_ack", "packages/coding-agent/src/transcript-admission-barrier.test.ts");
  aliasCheck(checks, "context.durable_admission_barrier", [barrier], "assistant and tool-result message_end await Host durable transcript ACK");
  aliasCheck(checks, "context.no_request_before_ack", [barrier], "no tool execution or subsequent ModelProvider.stream crosses an unacknowledged transcript message");
  aliasCheck(checks, "identity.tool_call_end_to_end", [barrier, pairing], "provider tool-call ID remains the capability and tool-result correlation identity");

  // 5. Stable source sequence and incomplete-history fail-closed semantics.
  const stableHead = vitestCheck(checks, "context.stable_source_sequence", "packages/host-runtime/src/transcript-stable-head.test.ts");
  void stableHead;
  const orphan = vitestCheck(checks, "context.orphan_reconstruction", hostTranscript, "reconstructs an orphan exactly but blocks continuation");
  aliasCheck(checks, "context.orphan_continuation_blocked", [orphan], "incomplete transcript rejects new input/model continuation");
  aliasCheck(checks, "context.no_synthetic_tool_result", [orphan], "orphan history remains incomplete without fabricated tool results");

  // 6. Negotiation, legacy fidelity, and disposable Agent history.
  const capability = vitestCheck(checks, "protocol.rich_transcript_capability", hostTranscript, "requires durable transcript capability");
  void capability;
  const legacy = vitestCheck(checks, "legacy.text_only_reconstruction", "packages/transcript/src/transcript.test.ts", "reports legacy text-only fidelity");
  aliasCheck(checks, "legacy.fidelity_reported", [legacy], "legacy text-only reconstruction explicitly reports reduced fidelity");
  const hydrated = vitestCheck(checks, "context.no_ephemeral_history", "packages/agent-core/src/agent-core.test.ts", "supplies the durable prefix unchanged");

  // 7. Signature proof: canonical append before missing ACK, then replace both Host and Agent, hydrate, and continue.
  const restart = vitestCheck(checks, "context.host_reopen", "packages/coding-agent/src/verbatim-restart.integration.test.ts");
  aliasCheck(checks, "context.agent_replacement", [restart], "replacement Agent starts empty and receives the same canonical verbatim prefix");
  aliasCheck(checks, "context.continuation", [restart, hydrated], "replacement Host/Agent continues with the durable prefix plus the next canonical user input");

  // 8. Frozen 0.6 exclusions/authority boundaries.
  const boundaryFile = "packages/host-runtime/src/context-boundaries-0.6.test.ts";
  vitestCheck(checks, "boundary.host_owns_context", boundaryFile, "keeps verbatim compilation under Host authority");
  vitestCheck(checks, "boundary.agent_has_no_transcript_store", boundaryFile, "keeps the replaceable Agent free of a durable transcript store");
  vitestCheck(checks, "boundary.no_graph_selection", boundaryFile, "does not introduce graph-distilled context selection");
  vitestCheck(checks, "boundary.no_compaction", boundaryFile, "does not add compaction");
  vitestCheck(checks, "boundary.no_provider_specific_transform", boundaryFile, "does not port provider-specific transformMessages");

  const receipt = buildReceipt({
    gate: "0.6",
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
  const receiptPath = join(receiptsDir, `0.6-${safeSha}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(`\nreceipt: ${receiptPath}`);

  process.exit(receipt.status === "passed" ? 0 : 1);
}

main().catch((error) => {
  console.error("gate 0.6 crashed:", error);
  process.exit(2);
});
