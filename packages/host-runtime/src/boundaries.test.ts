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

describe("Phase 0.5 ownership boundaries", () => {
  it("keeps the cognition extension thin and free of durable/runtime authority", () => {
    const extensionDir = join(repoRoot, "extensions/cognition/src");
    const text = combined(sourceFiles(extensionDir));
    for (const forbidden of [
      "@alcode/storage",
      "@alcode/workspace",
      "@alcode/memory",
      "@alcode/reasoning",
      "better-sqlite3",
      "acquireWorkspaceLock",
    ]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).toContain("@alcode/agent-protocol");
  });

  it("keeps the replaceable Agent worker free of Host/store/workspace semantic authority", () => {
    const worker = readFileSync(join(repoRoot, "packages/coding-agent/src/agent-worker.ts"), "utf8");
    for (const forbidden of [
      "@alcode/host-runtime",
      "@alcode/storage",
      "@alcode/workspace",
      "@alcode/memory",
      "@alcode/reasoning",
      "better-sqlite3",
      "openLockedWorkspaceStore",
    ]) {
      expect(worker).not.toContain(forbidden);
    }
    expect(worker).toContain("@alcode/agent-protocol");
    expect(worker).toContain("@alcode/cognition-extension");
  });

  it("does not introduce Phase 0.6/0.7 context compilers into Phase 0.5 surfaces", () => {
    const dirs = [
      join(repoRoot, "packages/host-runtime/src"),
      join(repoRoot, "packages/cognition-runtime/src"),
      join(repoRoot, "extensions/cognition/src"),
    ];
    const text = combined(dirs.flatMap(sourceFiles));
    expect(text).not.toContain("convertToLlm");
    expect(text).not.toContain("context.projection_compiled");
    expect(text).not.toContain("ProjectionReceipt");
    expect(text).not.toContain("tokenBudget");
  });
});
