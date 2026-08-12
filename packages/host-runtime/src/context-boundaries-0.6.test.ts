import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => join(dir, name));
}

function combined(files: string[]): string {
  return files.map((file) => readFileSync(file, "utf8")).join("\n");
}

describe("Phase 0.6 context ownership boundaries", () => {
  it("keeps verbatim compilation under Host authority", () => {
    const host = readFileSync(join(repoRoot, "packages/host-runtime/src/verbatim-context.ts"), "utf8");
    expect(host).toContain("compileVerbatimContext");
    const worker = readFileSync(join(repoRoot, "packages/coding-agent/src/agent-worker.ts"), "utf8");
    expect(worker).not.toContain("compileVerbatimContext");
  });

  it("keeps the replaceable Agent free of a durable transcript store", () => {
    const worker = readFileSync(join(repoRoot, "packages/coding-agent/src/agent-worker.ts"), "utf8");
    for (const forbidden of [
      "@alcode/storage",
      "@alcode/transcript",
      "better-sqlite3",
      "openLockedWorkspaceStore",
      "transcript_messages",
      "writeFileSync",
      "appendFileSync",
    ]) {
      expect(worker).not.toContain(forbidden);
    }
    expect(worker).toContain("history: Message[]");
  });

  it("does not introduce graph-distilled context selection into transcript/cognition surfaces", () => {
    // Phase 0.7 may extend the Host-owned compiler with graph selection. The
    // Phase 0.6 ownership boundary remains that transcript/cognition surfaces
    // do not acquire that semantic authority.
    const dirs = [
      join(repoRoot, "packages/transcript/src"),
      join(repoRoot, "extensions/cognition/src"),
    ];
    const text = combined(dirs.flatMap(sourceFiles));
    for (const forbidden of [
      "graph-v1",
      "graph-distilled",
      "ProjectionReceipt",
      "context.projection_compiled",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("does not add compaction, summarization, or token-budget strategy", () => {
    const dirs = [join(repoRoot, "packages/host-runtime/src"), join(repoRoot, "packages/transcript/src")];
    const text = combined(dirs.flatMap(sourceFiles));
    for (const forbidden of ["tokenBudget", "compactionSummary", "branchSummary", "summarizeContext"] ) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("does not port provider-specific transformMessages into the Host/compiler", () => {
    const hostText = combined(sourceFiles(join(repoRoot, "packages/host-runtime/src")));
    const transcriptText = combined(sourceFiles(join(repoRoot, "packages/transcript/src")));
    expect(hostText).not.toContain("transformMessages");
    expect(transcriptText).not.toContain("transformMessages");
  });
});
