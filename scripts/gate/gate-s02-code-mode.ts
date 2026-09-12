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
const typecheck = (workspace: string) => command("--filter", workspace, "exec", "tsc", "--noEmit", "-p", "tsconfig.json");
const checks: GateCheck[] = [];

checks.push(check(
  "s02.ac01-03.protocol-catalog",
  () => {
    typecheck("@alcode/agent-protocol");
    vitest(
      "packages/agent-protocol/src/protocol.test.ts",
      "packages/host-runtime/src/local-orchestration-catalog-v1.test.ts",
      "packages/host-runtime/src/program-execution-runtime-v2.test.ts",
    );
  },
  "negotiated local_orchestration_v1, closed run_code binding/catalog visibility, digest participation, unsupported-Agent/non-V2 absence, and direct compatibility remain Host-authorized",
));

checks.push(check(
  "s02.ac02-03-08-10.runtime",
  () => {
    typecheck("@alcode/code-mode");
    vitest("packages/code-mode/src/code-mode.test.ts");
  },
  "fresh isolated Code Mode workers enforce the frozen source/heap/stack/compute/wall/call/concurrency/input/result bounds, no ambient APIs, no nesting, and no cross-invocation state",
));

checks.push(check(
  "s02.ac04-05.snapshot-authority",
  () => {
    typecheck("@alcode/coding-agent");
    vitest("packages/coding-agent/src/inference-runtime-s02-3.test.ts");
  },
  "run_code is interpreted only from the exact Host catalog, exposes only captured peer proxies, preserves ProgramAttempt/dynamic revisions, rejects unknown/nested names locally, and fails future stale sub-dispatches closed",
));

checks.push(check(
  "s02.ac05-07-09-10-12.adversarial",
  () => {
    typecheck("@alcode/cognition-extension");
    typecheck("@alcode/host-runtime");
    vitest(
      "packages/coding-agent/src/agent-protocol-bridge.test.ts",
      "packages/coding-agent/src/inference-runtime-s02-4.test.ts",
      "packages/coding-agent/src/inference-runtime-s02-4-replacement.test.ts",
      "packages/coding-agent/src/inference-runtime-s02-4-canonical-return.test.ts",
      "packages/host-runtime/src/program-agent-s02-4.test.ts",
      "packages/host-runtime/src/program-adaptive-operation-s02-4.test.ts",
      "packages/host-runtime/src/program-adaptive-operation-s02-4-production.test.ts",
    );
  },
  "Attempt invalidation, admitted-operation truth, distinct Host-minted mutation identities/effect generations, bounded cancellation/drain correlation, Agent replacement, and forged local returns preserve Host authority",
));

checks.push(check(
  "s02.ac13.product-round-trip",
  () => vitest("packages/coding-agent/src/cli-s02-code-mode.integration.test.ts"),
  "one scripted provider inference emits one run_code call; its local program performs mediated read-edit-read sub-dispatches before any later provider inference, then existing Host verification and Completion finish the Program",
));

checks.push(check(
  "s02.ac11-14.predecessor",
  () => command("gate:product-agent"),
  "the complete predecessor product-agent gate remains green, including the deterministic direct-tool product path required by Scenario Q",
));

const commitSha = process.env.ALCODE_GATE_SHA ?? process.env.GITHUB_SHA ?? "unknown";
const receipt = buildReceipt({
  gate: "s02-code-mode",
  commitSha,
  startedAt,
  inputs: [
    { name: "S-02 frozen AC-S02-01 through AC-S02-14" },
    { name: "S-02 frozen Scenarios A through Q" },
    { name: "P-01/P-02 product-agent predecessor gate" },
  ],
  checks,
});
console.log(formatReceipt(receipt));
console.log(JSON.stringify(receipt, null, 2));
if (receipt.status !== "passed") process.exitCode = 1;
