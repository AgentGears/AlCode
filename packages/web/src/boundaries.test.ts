import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(?:ts|tsx)$/.test(path) ? [path] : [];
  });
}

describe("Phase 0.8 React ownership boundary", () => {
  it("depends on the public Application Protocol, never storage/Host/Agent authority", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const files = sourceFiles(dir).filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"));
    const source = files.map((path) => readFileSync(path, "utf8")).join("\n");
    expect(source).toContain("@alcode/application-protocol");
    expect(source).not.toMatch(/@alcode\/storage/);
    expect(source).not.toMatch(/@alcode\/host-runtime/);
    expect(source).not.toMatch(/@alcode\/agent-(?:core|protocol)/);
    expect(source).not.toMatch(/better-sqlite3|WorkspaceEventStore|CapabilityBroker|ModelProvider/);
  });
});
