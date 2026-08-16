import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = [
  "node:fs",
  "node:child_process",
  "node:net",
  "node:http",
  "node:https",
  "better-sqlite3",
  "@alcode/storage",
  "@alcode/workspace",
  "@alcode/host-runtime",
  "@alcode/agent-protocol",
];

describe("@alcode/program-state production boundary", () => {
  it("contains no filesystem, SQLite, process, network, scheduler, or Host-runtime imports", () => {
    const productionFiles = readdirSync(SRC)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));

    for (const name of productionFiles) {
      const source = readFileSync(join(SRC, name), "utf8");
      for (const forbidden of FORBIDDEN) {
        expect(source, `${name} imports forbidden runtime ${forbidden}`).not.toContain(`from \"${forbidden}`);
        expect(source, `${name} imports forbidden runtime ${forbidden}`).not.toContain(`from '${forbidden}`);
      }
      expect(source, `${name} creates timers`).not.toContain("setInterval(");
      expect(source, `${name} creates timers`).not.toContain("setTimeout(");
    }
  });
});
