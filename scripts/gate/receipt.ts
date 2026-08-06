// Gate receipt — the stable JSON schema every `pnpm gate:X.Y` emits.
// See docs/phase-0-spec.md §"Gate receipt schema".

export interface GateCheck {
  /** Stable id, e.g. "events.append.idempotent". */
  id: string;
  status: "passed" | "failed" | "skipped";
  /** Path to evidence or a short value justifying the status. */
  evidence?: string;
}

export interface GateInput {
  /** Named input, e.g. "typescript@5.6.3". */
  name: string;
  /** Content digest when applicable. */
  digest?: string;
}

export interface GateReceipt {
  /** Gate id, e.g. "0.0", "0.1A", "0.2". */
  gate: string;
  /** Overall status — "passed" only when every non-skipped check passes. */
  status: "passed" | "failed";
  /** Git commit SHA at run time (or "dirty" / "unknown"). */
  commitSha: string;
  /** ISO 8601 timestamps. */
  startedAt: string;
  completedAt: string;
  /** Runtime / toolchain versions for reproducibility. */
  runtimeVersion: string;
  packageManagerVersion: string;
  /** Named inputs (tool versions, fixture digests, etc.). */
  inputs: GateInput[];
  /** Individual check results. */
  checks: GateCheck[];
}

/** Build a receipt from collected checks; computes the overall status. */
export function buildReceipt(args: {
  gate: string;
  commitSha: string;
  startedAt: string;
  inputs?: GateInput[];
  checks: GateCheck[];
}): GateReceipt {
  const completedAt = new Date().toISOString();
  const failed = args.checks.some((c) => c.status === "failed");
  return {
    gate: args.gate,
    status: failed ? "failed" : "passed",
    commitSha: args.commitSha,
    startedAt: args.startedAt,
    completedAt,
    runtimeVersion: process.version,
    packageManagerVersion: process.env.npm_config_user_agent ?? "unknown",
    inputs: args.inputs ?? [],
    checks: args.checks,
  };
}

/** Pretty-print a receipt for terminal output. */
export function formatReceipt(r: GateReceipt): string {
  const lines: string[] = [];
  lines.push(`Gate ${r.gate}: ${r.status.toUpperCase()}`);
  lines.push(`  commit: ${r.commitSha}`);
  lines.push(`  started: ${r.startedAt}  completed: ${r.completedAt}`);
  lines.push(`  runtime: ${r.runtimeVersion}  pm: ${r.packageManagerVersion}`);
  if (r.inputs.length > 0) {
    lines.push(`  inputs:`);
    for (const i of r.inputs) {
      lines.push(`    ${i.name}${i.digest ? ` (${i.digest.slice(0, 12)})` : ""}`);
    }
  }
  lines.push(`  checks:`);
  for (const c of r.checks) {
    const mark = c.status === "passed" ? "[pass]" : c.status === "skipped" ? "[skip]" : "[FAIL]";
    lines.push(`    ${mark} ${c.id}${c.evidence ? ` — ${c.evidence}` : ""}`);
  }
  return lines.join("\n");
}
