import { execFileSync } from "node:child_process";
import { buildReceipt, formatReceipt, type GateCheck } from "./receipt.ts";

const startedAt = new Date().toISOString();
function command(...args: string[]): void {
  execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, { stdio: "inherit", env: process.env });
}
function check(id: string, run: () => void, evidence: string): GateCheck {
  try { run(); return { id, status: "passed", evidence }; }
  catch (error) { return { id, status: "failed", evidence: error instanceof Error ? error.message : String(error) }; }
}
const vitest = (...paths: string[]) => command("exec", "vitest", "run", ...paths);
const vitestMatching = (pattern: string, ...paths: string[]) => command("exec", "vitest", "run", ...paths, "-t", pattern);
const checks: GateCheck[] = [];

checks.push(check("1.1.compose.1.0", () => command("gate:1.0"), "exact closed Phase 1.0 gate passed"));
checks.push(check("1.1.ac11-01.production-composition", () => vitest(
  "packages/host-runtime/src/program-execution-runtime.test.ts",
), "one production Program runtime composes creation, dispatch, recovery, verification, terminal, Agent, and Application authority"));
checks.push(check("1.1.ac11-02.planning-proposal", () => vitest(
  "packages/host-runtime/src/program-planning.test.ts",
  "packages/host-runtime/src/program-agent-host.integration.test.ts",
), "negotiated Agent planning bridge seals bounded Host-owned Program drafts and rejects stale/non-capable authority"));
checks.push(check("1.1.ac11-03.accept-first-dispatch", () => vitest(
  "packages/host-runtime/src/program-first-dispatch.integration.test.ts",
  "packages/host-runtime/src/program-application.test.ts",
), "exact Application acceptance creates ProgramState and synchronously schedules the first fresh Attempt"));
checks.push(check("1.1.ac11-04.attempt-execution", () => vitest(
  "packages/host-runtime/src/program-agent-host.integration.test.ts",
  "packages/host-runtime/src/program-operation-correlation.test.ts",
  "packages/coding-agent/src/host-capabilities.program.test.ts",
), "current inference-bound ProgramAttempt authority is required for Host capability execution and mutating owned tools prove exact quiescence"));
checks.push(check("1.1.ac11-05.progress-verification", () => {
  vitest("packages/host-runtime/src/program-progress.test.ts");
  vitestMatching(
    "satisfies current verification|turns verification failure|dispatches the deterministic successor",
    "packages/host-runtime/src/program-execution-control.test.ts",
  );
}, "bounded progress proposal, Host verification, work completion, retry state, and deterministic successor dispatch"));
checks.push(check("1.1.ac11-06.terminal-authority", () => vitest(
  "packages/host-runtime/src/program-idle-routing.integration.test.ts",
  "packages/host-runtime/src/program-terminal.test.ts",
), "Program-backed idle cannot fall through to legacy Session completion and only Completion Oracle owns successful terminalization"));
checks.push(check("1.1.ac11-07.product-recovery", () => vitest(
  "packages/host-runtime/src/program-product-restart.integration.test.ts",
  "packages/host-runtime/src/program-application.test.ts",
  "packages/coding-agent/src/agent-replacement.integration.test.ts",
  "packages/web/src/web.test.tsx",
), "Application/web projection, Host restart, reconnect, Session reattachment, and fresh replacement Agent authority"));
checks.push(check("1.1.ac11-08.default-cli", () => vitest(
  "packages/coding-agent/src/cli-program.integration.test.ts",
), "ordinary alcode -p uses Program-backed Host/Application route and explicit Application acceptance with offline TestModelProvider; this is Scenario A"));
checks.push(check("1.1.scenarios.B-F", () => vitest(
  "packages/host-runtime/src/program-product-restart.integration.test.ts",
  "packages/host-runtime/src/program-recovery.test.ts",
  "packages/coding-agent/src/agent-replacement.integration.test.ts",
  "packages/host-runtime/src/program-dispatch.test.ts",
  "packages/host-runtime/src/program-verification.test.ts",
  "packages/host-runtime/src/program-terminal.test.ts",
), "required Host crash/recovery, Agent replacement, divergence/rebase, verification failure/retry, and cancellation/terminal race scenarios"));
checks.push(check("1.1.ownership", () => {
  command("--filter", "@alcode/host-runtime", "typecheck");
  command("--filter", "@alcode/coding-agent", "typecheck");
  command("--filter", "@alcode/web", "typecheck");
}, "Host/Agent/Application ownership boundaries typecheck on the default product path"));

const commitSha = process.env.GITHUB_SHA ?? "unknown";
const receipt = buildReceipt({
  gate: "1.1",
  commitSha,
  startedAt,
  inputs: [
    { name: "Phase 1.1 authorized bounded contract docs/phase-1.1-plan.md" },
    { name: "Phase 1.0 closed gate" },
  ],
  checks,
});
console.log(formatReceipt(receipt));
console.log(JSON.stringify(receipt, null, 2));
if (receipt.status !== "passed") process.exitCode = 1;
