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
const checks: GateCheck[] = [];

checks.push(check("1.0.compose.0.9", () => command("gate:0.9"), "exact closed Phase 0.9 gate passed"));
checks.push(check("1.0.identity.program-state", () => vitest(
  "packages/storage/src/program-state-envelope.test.ts",
), "ProgramStateId envelope/index/history compatibility"));
checks.push(check("1.0.program.reducer", () => vitest(
  "packages/program-state/src",
), "pure bounded ProgramState reducer, revision algebra, eligibility, limits, and invariants"));
checks.push(check("1.0.program.rebuild", () => vitest(
  "packages/storage/src/program-state-projection.test.ts",
  "packages/storage/src/program-state-projection-terminal.test.ts",
), "deterministic Program projection rebuild and terminal parity"));
checks.push(check("1.0.program.creation", () => vitest(
  "packages/host-runtime/src/planning-read.test.ts",
  "packages/host-runtime/src/program-creation.test.ts",
  "packages/host-runtime/src/program-creation-binding.test.ts",
), "tracked planning provenance, exact draft acceptance, first-dispatch bridge, and creation races"));
checks.push(check("1.0.program.session-binding", () => vitest(
  "packages/host-runtime/src/program-creation-binding.test.ts",
  "packages/host-runtime/src/program-application.test.ts",
), "cross-session attachment, one-Program session binding, stop/accept control, and exact Application commands"));
checks.push(check("1.0.program.revision-attempt-freshness", () => vitest(
  "packages/host-runtime/src/program-dispatch.test.ts",
  "packages/host-runtime/src/program-agent.test.ts",
), "exact Program revision, AttemptId, work/session, and Agent-generation freshness"));
checks.push(check("1.0.program.execution-base", () => vitest(
  "packages/host-runtime/src/program-dispatch.test.ts",
  "packages/host-runtime/src/program-operation-correlation.test.ts",
), "protected execution observations, G/O mismatch, rebase, and mutation settlement"));
checks.push(check("1.0.program.dag", () => vitest(
  "packages/program-state/src",
), "bounded acyclic required-work topology and deterministic eligibility"));
checks.push(check("1.0.program.scheduler", () => vitest(
  "packages/host-runtime/src/program-dispatch.test.ts",
), "Workspace-domain single-attempt scheduling and dispatch blocking conditions"));
checks.push(check("1.0.program.operation-correlation", () => vitest(
  "packages/host-runtime/src/program-operation-correlation.test.ts",
), "P/A/O root ownership, historical access/quiescence contracts, and generation settlement"));
checks.push(check("1.0.program.uncertainty", () => vitest(
  "packages/host-runtime/src/program-operation-correlation.test.ts",
  "packages/host-runtime/src/program-recovery.test.ts",
), "indeterminate effects, durable writer barriers, quiescence, and reconciliation"));
checks.push(check("1.0.program.verification-freshness", () => vitest(
  "packages/host-runtime/src/program-verification.test.ts",
  "packages/host-runtime/src/artifact-store.test.ts",
), "closed verification predicates, generation invalidation, path/artifact binding, waivers, and integrity"));
checks.push(check("1.0.program.completion-linearization", () => vitest(
  "packages/host-runtime/src/program-terminal.test.ts",
), "Host Completion Oracle, protected terminal observation, cancellation races, and unique terminal truth"));
checks.push(check("1.0.program.recovery-barrier", () => vitest(
  "packages/host-runtime/src/program-recovery.test.ts",
), "reopen recovery barrier, historical quiescence, orphan Attempt interruption, and fresh-base catch-up"));
checks.push(check("1.0.agent.program-state", () => vitest(
  "packages/agent-protocol/src/program-state-protocol.test.ts",
  "packages/host-runtime/src/program-agent.test.ts",
  "packages/host-runtime/src/program-agent-host.integration.test.ts",
  "packages/coding-agent/src",
), "negotiated bounded AttemptProjection and replaceable coding-Agent consumption"));
checks.push(check("1.0.application.program-projection", () => vitest(
  "packages/application-protocol/src/program-validation.test.ts",
  "packages/host-runtime/src/program-application.test.ts",
), "bounded authoritative public Program projection and exact Host-owned controls"));
checks.push(check("1.0.scenario.A", () => vitest(
  "packages/host-runtime/src/program-creation.test.ts",
  "packages/host-runtime/src/program-creation-binding.test.ts",
  "packages/host-runtime/src/program-dispatch.test.ts",
), "Scenario A: exact creation, stop/idle race, single consumption, planning recheck, first dispatch"));
checks.push(check("1.0.scenario.B", () => vitest(
  "packages/host-runtime/src/program-recovery.test.ts",
  "packages/host-runtime/src/program-application.test.ts",
  "packages/host-runtime/src/program-dispatch.test.ts",
  "packages/host-runtime/src/program-terminal.test.ts",
), "Scenario B: reopen, later-session attachment, recovery barrier, continuation, completion"));
checks.push(check("1.0.scenario.C", () => vitest(
  "packages/host-runtime/src/program-dispatch.test.ts",
  "packages/host-runtime/src/program-agent.test.ts",
), "Scenario C: stale Attempt/revision/Agent-generation ABA rejection"));
checks.push(check("1.0.scenario.D", () => vitest(
  "packages/host-runtime/src/program-dispatch.test.ts",
  "packages/host-runtime/src/program-verification.test.ts",
), "Scenario D: legitimate mutation, external divergence, verification impact, exact rebase"));
checks.push(check("1.0.scenario.E", () => vitest(
  "packages/host-runtime/src/program-operation-correlation.test.ts",
  "packages/host-runtime/src/program-recovery.test.ts",
), "Scenario E: indeterminate mutation, durable writer barrier, recovery/quiescence/reconciliation"));
checks.push(check("1.0.scenario.F", () => vitest(
  "packages/host-runtime/src/program-verification.test.ts",
  "packages/host-runtime/src/program-terminal.test.ts",
  "packages/host-runtime/src/artifact-store.test.ts",
), "Scenario F: verification generation invalidation and artifact identity/provenance"));
checks.push(check("1.0.scenario.G", () => vitest(
  "packages/host-runtime/src/program-terminal.test.ts",
), "Scenario G: cancellation/completion terminal linearization"));
checks.push(check("1.0.scenario.H", () => vitest(
  "packages/storage/src/program-state-envelope.test.ts",
  "packages/storage/src/program-state-projection.test.ts",
  "packages/storage/src/program-state-projection-terminal.test.ts",
  "packages/host-runtime/src/program-recovery.test.ts",
), "Scenario H: rebuild, historical envelope compatibility, migration, and idempotency"));
checks.push(check("1.0.ownership", () => {
  command("--filter", "@alcode/program-state", "typecheck");
  command("--filter", "@alcode/storage", "typecheck");
  command("--filter", "@alcode/agent-protocol", "typecheck");
  command("--filter", "@alcode/application-protocol", "typecheck");
  command("--filter", "@alcode/host-runtime", "typecheck");
  command("--filter", "@alcode/coding-agent", "typecheck");
  vitest(
    "packages/program-state/src/boundaries.test.ts",
    "packages/application-protocol/src/boundaries.test.ts",
    "packages/host-runtime/src/boundaries.test.ts",
  );
}, "Phase 1 package typechecks and Host/Agent/Application ownership boundaries"));

const commitSha = process.env.GITHUB_SHA ?? "unknown";
const receipt = buildReceipt({
  gate: "1.0",
  commitSha,
  startedAt,
  inputs: [
    { name: "Phase 1.0 frozen contract main@5588c6782fe896d496970a1855eae7d30c58ec38" },
    { name: "Phase 0.9 closed gate" },
  ],
  checks,
});
console.log(formatReceipt(receipt));
console.log(JSON.stringify(receipt, null, 2));
if (receipt.status !== "passed") process.exitCode = 1;
