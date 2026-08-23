import { execFileSync } from "node:child_process";
import { buildReceipt, formatReceipt, type GateCheck } from "./receipt.ts";

const startedAt = new Date().toISOString();
function command(...args: string[]): void {
  execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
    stdio: "inherit",
    env: process.env,
  });
}
function check(id: string, run: () => void, evidence: string): GateCheck {
  try {
    run();
    return { id, status: "passed", evidence };
  } catch (error) {
    return {
      id,
      status: "failed",
      evidence: error instanceof Error ? error.message : String(error),
    };
  }
}
const vitest = (...paths: string[]) => command("exec", "vitest", "run", ...paths);
const checks: GateCheck[] = [];

checks.push(check(
  "product-agent.compose.phase-1.1",
  () => command("gate:1.1"),
  "the exact closed Phase 1.1 product/authority gate passes before P-01-specific proofs",
));

checks.push(check(
  "product-agent.ac01.provider",
  () => vitest(
    "packages/coding-agent/src/provider-selection.test.ts",
    "packages/coding-agent/src/agent-runtime-profile.test.ts",
  ),
  "production provider selection is explicit and deterministic scripted mode is opt-in rather than a silent mock fallback",
));

checks.push(check(
  "product-agent.ac02-03.planning-reads",
  () => vitest(
    "packages/coding-agent/src/agent-protocol-planning-read.test.ts",
    "packages/coding-agent/src/planning-read-catalog.test.ts",
    "packages/host-runtime/src/planning-catalog.test.ts",
  ),
  "planning uses the privileged semantic client plus exact bounded Host catalog/tracked observations and recheckable identities",
));

checks.push(check(
  "product-agent.ac04-05.model-planning-acceptance",
  () => vitest(
    "packages/coding-agent/src/program-planner.test.ts",
    "packages/host-runtime/src/program-planning-retry.test.ts",
    "packages/coding-agent/src/cli-program.integration.test.ts",
  ),
  "bounded model planning submits proposals only; Host sealing and explicit Application acceptance remain mandatory",
));

checks.push(check(
  "product-agent.ac06.verifier",
  () => vitest(
    "packages/host-runtime/src/program-planning-verifier.test.ts",
    "packages/host-runtime/src/program-verifier-catalog.test.ts",
    "packages/coding-agent/src/verification-profile.test.ts",
  ),
  "the planning episode receives an exact Host verifier catalog, zero-verification product proposals are rejected, and real path/operation verification is Host-owned",
));

checks.push(check(
  "product-agent.ac07.attempt-driver",
  () => vitest(
    "packages/agent-protocol/src/program-attempt-execute.test.ts",
    "packages/coding-agent/src/program-attempt-context.test.ts",
    "packages/coding-agent/src/recoverable-run-queue.test.ts",
    "packages/coding-agent/src/agent-error-arbitration.test.ts",
  ),
  "Host-requested exact ProgramAttempt execution is protocol-bounded, refreshed at inference cuts, coalesced only while live, and remains re-drivable after settlement/reconnect",
));

checks.push(check(
  "product-agent.ac08.retry",
  () => vitest(
    "packages/host-runtime/src/program-execution-control.test.ts",
    "packages/host-runtime/src/program-retry-context.p01.test.ts",
  ),
  "negative Host verification retires the old Attempt, returns work pending, records bounded Host-owned failure facts, and requires fresh Attempt authority",
));

checks.push(check(
  "product-agent.ac09.successor",
  () => vitest(
    "packages/host-runtime/src/program-execution-control.test.ts",
    "packages/host-runtime/src/program-dispatch.test.ts",
  ),
  "verified work deterministically dispatches and drives dependent successor work under a fresh ProgramAttempt without new caller input",
));

checks.push(check(
  "product-agent.ac10.agent-replacement",
  () => vitest(
    "packages/coding-agent/src/agent-replacement-recovery.test.ts",
    "packages/host-runtime/src/program-agent-awaiting-replacement.p01.test.ts",
    "packages/host-runtime/src/program-replacement-recovery.p01.test.ts",
    "packages/host-runtime/src/host-agent-replacement-context.p01.test.ts",
    "packages/host-runtime/src/transcript-agent-replacement.p01.test.ts",
  ),
  "dead-generation Attempt/transcript authority is retired before replacement; certain recovery may continue and indeterminate mutation recovery blocks redispatch",
));

checks.push(check(
  "product-agent.ac11.completion-and-fences",
  () => vitest(
    "packages/host-runtime/src/program-recovery.test.ts",
    "packages/host-runtime/src/program-terminal.test.ts",
    "packages/coding-agent/src/cli-program.integration.test.ts",
  ),
  "existing execution-base/effect fences and Completion Oracle remain authoritative while the product path has explicit bounded failure/cancellation behavior",
));

checks.push(check(
  "product-agent.compose.s-01",
  () => vitest(
    "packages/agent-core/src/runtime-scope.test.ts",
    "packages/agent-core/src/agent-behavior.test.ts",
    "packages/agent-core/src/inference-lifecycle.test.ts",
    "packages/coding-agent/src/agent-runtime-profile.test.ts",
    "packages/coding-agent/src/agent-generation-closure.test.ts",
    "packages/coding-agent/src/inference-runtime.test.ts",
    "packages/coding-agent/src/agent-replacement.integration.test.ts",
  ),
  "relevant S-01 lifecycle, scoped inference, generation replacement, and Host-authority boundary proofs remain green",
));

checks.push(check(
  "product-agent.ownership",
  () => {
    command("--filter", "@alcode/agent-protocol", "typecheck");
    command("--filter", "@alcode/host-runtime", "typecheck");
    command("--filter", "@alcode/coding-agent", "typecheck");
  },
  "P-01 protocol/Host/Agent ownership boundaries typecheck as one product composition",
));

const commitSha = process.env.GITHUB_SHA ?? "unknown";
const receipt = buildReceipt({
  gate: "product-agent",
  commitSha,
  startedAt,
  inputs: [
    { name: "P-01 frozen AC-P01-01 through AC-P01-12" },
    { name: "Phase 1.1 closed gate" },
    { name: "relevant S-01 authority/lifecycle proofs" },
  ],
  checks,
});
console.log(formatReceipt(receipt));
console.log(JSON.stringify(receipt, null, 2));
if (receipt.status !== "passed") process.exitCode = 1;
