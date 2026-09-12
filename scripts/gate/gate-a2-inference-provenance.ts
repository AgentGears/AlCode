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
  "a2.ac01-05-09-11.epoch-provider-uncertainty",
  () => {
    typecheck("@alcode/agent-core");
    typecheck("@alcode/agent-protocol");
    typecheck("@alcode/ai");
    typecheck("@alcode/host-runtime");
    vitest(
      "packages/agent-core/src/inference-lifecycle.test.ts",
      "packages/ai/src/index.test.ts",
      "packages/host-runtime/src/inference-provenance-a2.test.ts",
    );
  },
  "fresh Host epochs, exact provider descriptors, prepared-before-inference lifecycle, uncertainty preservation, provider-neutral fixtures, replacement cuts, and canonical replay rebuild are proven without remote-provider attestation",
));

checks.push(check(
  "a2.ac05-07.agent-causal-routing",
  () => {
    typecheck("@alcode/cognition-extension");
    typecheck("@alcode/coding-agent");
    vitest(
      "packages/coding-agent/src/inference-runtime-a2.test.ts",
      "packages/coding-agent/src/inference-runtime.test.ts",
      "packages/coding-agent/src/inference-runtime-s02-4.test.ts",
    );
  },
  "durable prepare/terminal hooks and direct plus Code Mode inference causality propagate one exact epoch with explicit parentToolCallId/localSubcallIndex rather than reconstructed string parentage",
));

checks.push(check(
  "a2.ac06-10.host-authority-fences",
  () => {
    vitest(
      "packages/coding-agent/src/agent-replacement.integration.test.ts",
      "packages/host-runtime/src/program-agent-s02-4.test.ts",
      "packages/host-runtime/src/program-adaptive-operation-s02-4.test.ts",
      "packages/host-runtime/src/program-execution-runtime-v2.test.ts",
    );
  },
  "stale ProgramAttempt authority, Agent replacement, capability routing, adaptive execution and already-admitted Host Operation truth remain decisive independently of inference provenance",
));

checks.push(check(
  "a2.ac12.predecessor-code-mode-product",
  () => command("gate:s02-code-mode"),
  "the exact candidate head passes the permanent S02 Code Mode gate, which composes the complete product-agent predecessor gate",
));

const commitSha = process.env.ALCODE_GATE_SHA ?? process.env.GITHUB_SHA ?? "unknown";
const receipt = buildReceipt({
  gate: "a2-inference-provenance",
  commitSha,
  startedAt,
  inputs: [
    { name: "A2/S-04 frozen AC-A2-01 through AC-A2-12" },
    { name: "A2/S-04 frozen inference-provenance scenarios" },
    { name: "S02 Code Mode + product-agent predecessor gates" },
  ],
  checks,
});
console.log(formatReceipt(receipt));
console.log(JSON.stringify(receipt, null, 2));
if (receipt.status !== "passed") process.exitCode = 1;
