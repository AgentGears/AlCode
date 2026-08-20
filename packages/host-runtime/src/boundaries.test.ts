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

  it("keeps the replaceable Agent composition path free of Host/store/workspace semantic authority", () => {
    const codingAgentDir = join(repoRoot, "packages/coding-agent/src");
    const worker = readFileSync(join(codingAgentDir, "agent-worker.ts"), "utf8");
    const compositionFiles = [
      join(codingAgentDir, "agent-worker.ts"),
      join(codingAgentDir, "agent-runtime-profile.ts"),
      join(codingAgentDir, "inference-runtime.ts"),
    ];
    const composition = combined(compositionFiles);
    for (const forbidden of [
      "@alcode/host-runtime",
      "@alcode/storage",
      "@alcode/workspace",
      "@alcode/memory",
      "@alcode/reasoning",
      "better-sqlite3",
      "openLockedWorkspaceStore",
    ]) {
      expect(composition).not.toContain(forbidden);
    }
    expect(worker).toContain("@alcode/agent-protocol");
    // S-01C/S-01D deliberately delegate cognition and inference capability
    // composition out of the worker while retaining the same thin extension
    // boundary inside the replaceable Agent process.
    expect(worker).toContain("./agent-runtime-profile.ts");
    expect(worker).toContain("./inference-runtime.ts");
    expect(composition).toContain("@alcode/cognition-extension");
  });

  it("does not introduce Phase 0.6/0.7 context compilers into Phase 0.5 cognition surfaces", () => {
    // Later phases are allowed to extend the Host runtime because the Host is
    // the durable semantic authority. Preserve the Phase 0.5 exclusion where
    // it matters: cognition runtime/extension code must not acquire context
    // compilation or projection authority.
    const dirs = [
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
