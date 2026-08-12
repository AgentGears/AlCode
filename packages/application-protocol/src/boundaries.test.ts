import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("Phase 0.8 application-protocol ownership boundary", () => {
  it("contains no React, storage, Host runtime, provider, or Agent implementation imports", () => {
    const files = sourceFiles(new URL(".", import.meta.url).pathname).filter((path) => !path.endsWith(".test.ts"));
    const source = files.map((path) => readFileSync(path, "utf8")).join("\n");
    expect(source).not.toMatch(/@alcode\/storage/);
    expect(source).not.toMatch(/@alcode\/host-runtime/);
    expect(source).not.toMatch(/@alcode\/agent-(?:core|protocol)/);
    expect(source).not.toMatch(/from ["']react/);
    expect(source).not.toMatch(/better-sqlite3|ModelProvider|WorkspaceEventStore/);
  });
});
