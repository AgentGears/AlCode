import { execFileSync } from "node:child_process";
import { buildReceipt, formatReceipt, type GateCheck } from "./receipt.ts";

const startedAt = new Date().toISOString();

function command(...args: string[]): void {
  execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
    stdio: "inherit",
    env: process.env,
  });
}

function commandWithEnv(env: Record<string, string>, ...args: string[]): void {
  execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
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
const dockerVitest = (...paths: string[]) => commandWithEnv(
  { ALCODE_A5_DOCKER_INTEGRATION: "1" },
  "exec",
  "vitest",
  "run",
  ...paths,
);
const typecheck = (workspace: string) => command("--filter", workspace, "exec", "tsc", "--noEmit", "-p", "tsconfig.json");
const checks: GateCheck[] = [];

checks.push(check(
  "a5.ac01-02-04-06-09.lifecycle-currentness",
  () => {
    typecheck("@alcode/program-state");
    typecheck("@alcode/host-runtime");
    vitest(
      "packages/program-state/src/execution-world-validation.test.ts",
      "packages/host-runtime/src/execution-world.test.ts",
      "packages/host-runtime/src/program-execution-world-binding.test.ts",
      "packages/host-runtime/src/program-adaptive-execution-world-v1.test.ts",
    );
  },
  "fresh non-reusable generation identity, policy/provider freshness, durable ProgramAttempt binding, same-bytes ABA rejection, restart projection, and Agent-independent currentness are Host-canonical",
));

checks.push(check(
  "a5.ac03-05-07-12-14.binding-observation-uncertainty",
  () => {
    vitest(
      "packages/host-runtime/src/execution-world-binding.test.ts",
      "packages/host-runtime/src/capability-broker-execution-world-race.test.ts",
      "packages/coding-agent/src/execution-provider.test.ts",
      "packages/coding-agent/src/local-execution-world-runtime.test.ts",
      "packages/coding-agent/src/execution-world-observation.test.ts",
      "packages/coding-agent/src/host-capabilities.program.test.ts",
    );
  },
  "filesystem/process/observation services remain one exact generation, admitted bindings never migrate, loss does not fabricate effect truth, and world-bound planning/verification fail closed on mismatch",
));

checks.push(check(
  "a5.ac08-10.selection-local-compatibility",
  () => {
    typecheck("@alcode/coding-agent");
    vitest("packages/coding-agent/src/product-execution-world-runtime.test.ts");
  },
  "isolated execution is explicit Application/Host configuration, unsupported provider selection fails closed, and local-trusted remains the compatibility default rather than an implicit isolation downgrade",
));

checks.push(check(
  "a5.ac11-13.physical-isolation-s02-a2",
  () => {
    if (process.platform !== "linux") {
      throw new Error("The blocking A5 physical-isolation gate requires the supported Linux Docker platform");
    }
    execFileSync("docker", ["version"], { stdio: "inherit", env: process.env });
    dockerVitest(
      "packages/coding-agent/src/docker-execution-provider.integration.test.ts",
      "packages/coding-agent/src/cli-a5-isolated-s02.integration.test.ts",
    );
  },
  "the real Docker isolated-v1 backend proves mount/env/network/resource/process-tree containment and one S02 run_code read-edit-read sequence whose A2 nested Operations plus Host verification all bind the same exact isolated generation",
));

checks.push(check(
  "a5.ac10-15.predecessor-exact-head",
  () => command("gate:a2-inference-provenance"),
  "the exact candidate head passes A2 inference provenance, which composes the permanent S02 Code Mode and complete product-agent predecessor gates",
));

const commitSha = process.env.ALCODE_GATE_SHA ?? process.env.GITHUB_SHA ?? "unknown";
const receipt = buildReceipt({
  gate: "a5-execution-provider",
  commitSha,
  startedAt,
  inputs: [
    { name: "A5 frozen AC-A5-01 through AC-A5-15" },
    { name: "A5 frozen adversarial execution-world scenarios" },
    { name: "Linux Docker isolated-v1 physical containment proof" },
    { name: "A2 -> S02 -> product-agent predecessor gate chain" },
  ],
  checks,
});
console.log(formatReceipt(receipt));
console.log(JSON.stringify(receipt, null, 2));
if (receipt.status !== "passed") process.exitCode = 1;
