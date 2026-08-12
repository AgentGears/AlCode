import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(relativeFromThisFile: string): string {
  return readFileSync(fileURLToPath(new URL(relativeFromThisFile, import.meta.url)), "utf8");
}

describe("Phase 0.7 context authority boundaries", () => {
  it("keeps the pure context package free of storage, Host, workspace execution, and provider authority", () => {
    const files = [
      source("../../context/src/compiler.ts"),
      source("../../context/src/frontier.ts"),
      source("../../context/src/memory.ts"),
      source("../../context/src/evaluation.ts"),
    ].join("\n");
    expect(files).not.toMatch(/@alcode\/storage/);
    expect(files).not.toMatch(/@alcode\/host-runtime/);
    expect(files).not.toMatch(/@alcode\/workspace/);
    expect(files).not.toMatch(/better-sqlite3/);
    expect(files).not.toMatch(/child_process/);
    expect(files).not.toMatch(/ModelProvider/);
  });

  it("keeps Agent and cognition extension free of context strategy and durable authority", () => {
    const worker = source("../../coding-agent/src/agent-worker.ts");
    const extension = source("../../../extensions/cognition/src/proxy-tools.ts");
    const combined = `${worker}\n${extension}`;
    expect(combined).not.toMatch(/@alcode\/storage/);
    expect(combined).not.toMatch(/@alcode\/memory/);
    expect(combined).not.toMatch(/@alcode\/reasoning/);
    expect(combined).not.toMatch(/compileGraphContext/);
    expect(combined).not.toMatch(/requestedMode/);
    expect(combined).not.toMatch(/projection_receipts/);
  });

  it("does not let context selection reinforce memory or mutate reasoning", () => {
    const compiler = source("../../context/src/compiler.ts");
    const memory = source("../../context/src/memory.ts");
    const frontier = source("../../context/src/frontier.ts");
    const combined = `${compiler}\n${memory}\n${frontier}`;
    expect(combined).not.toMatch(/recordSeen|recordUse|reinforc|consolidat/i);
    expect(combined).not.toMatch(/addNode\(|addEdge\(|reduceEvent\(|append\(/);
  });

  it("keeps deferred compaction/provider tokenization/default promotion out of Phase 0.7", () => {
    const contextPackage = [
      source("../../context/src/compiler.ts"),
      source("../../context/src/evaluation.ts"),
      source("../../context/src/types.ts"),
    ].join("\n");
    expect(contextPackage).not.toMatch(/summari[sz]ation|compaction|provider tokenizer|tiktoken/i);
    expect(source("./context-service.ts")).toContain('options.requestedMode ?? "verbatim"');
    expect(source("../../context/src/evaluation.ts")).toContain("return false");
  });

  it("classifies context receipts as audit metadata rather than task-world evidence", () => {
    const semanticClass = source("../../events/src/semantic-class.ts");
    expect(semanticClass).toContain('"context.projection_compiled"');
    expect(semanticClass).toContain('"audit_meta"');
    expect(source("./cognition-service.ts")).toContain("isContextEvidenceEventType");
  });
});
