import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlanningBaseStaleError, PlanningReadError, PlanningReadRegistry } from "@alcode/host-runtime";
import {
  createSemanticPlanningReadExtension,
  type SemanticPlanningCodeIntelligence,
  type SemanticPlanningObservation,
  type SemanticPlanningQuery,
} from "./semantic-planning-read.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface FakeState {
  generation: number;
  fingerprint: string;
  symbolComplete: boolean;
  referenceComplete: boolean;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alcode-semantic-planning-"));
  roots.push(root);
  const state: FakeState = {
    generation: 0,
    fingerprint: "fingerprint-0",
    symbolComplete: true,
    referenceComplete: true,
  };

  const observe = <T>(value: T, complete: boolean): SemanticPlanningObservation<T> => ({
    workspaceId: "workspace-semantic-test",
    repositoryId: "repository-semantic-test",
    revision: {
      epoch: "epoch-1",
      generation: state.generation,
      fingerprint: state.fingerprint,
    },
    complete,
    current: true,
    observedAt: new Date().toISOString(),
    provider: { name: "deterministic-code-intelligence", version: "1" },
    value,
    diagnostics: [],
  });

  const service = {
    async query(request: SemanticPlanningQuery) {
      switch (request.type) {
        case "symbol_search":
          return observe({
            symbols: [
              {
                name: "Zeta",
                kind: "function",
                location: {
                  path: join(root, "src", "zeta.ts"),
                  start: { line: 3, column: 2 },
                  end: { line: 3, column: 8 },
                },
              },
              {
                name: "Alpha",
                location: {
                  path: join(root, "src", "alpha.ts"),
                  start: { line: 1, column: 0 },
                  end: { line: 1, column: 5 },
                },
              },
            ],
          }, state.symbolComplete);
        case "references":
          return observe({
            locations: [
              {
                path: join(root, "src", "use-b.ts"),
                start: { line: 9, column: 4 },
                end: { line: 9, column: 9 },
              },
              {
                path: join(root, "src", "use-a.ts"),
                start: { line: 2, column: 1 },
                end: { line: 2, column: 6 },
              },
            ],
          }, state.referenceComplete);
        case "diagnostics":
          return observe({
            diagnostics: [
              {
                path: join(root, "src", "broken.ts"),
                severity: "error" as const,
                message: "Type 'string' is not assignable to type 'number'.",
                range: { line: 4, column: 3, endLine: 4, endColumn: 8 },
                source: "ts",
                code: 2322,
              },
            ],
          }, false);
      }
    },
  } as SemanticPlanningCodeIntelligence;

  const extension = createSemanticPlanningReadExtension({
    root,
    workspaceId: "workspace-semantic-test",
    repositoryId: "repository-semantic-test",
    service,
  });
  const registry = new PlanningReadRegistry(
    "semantic-planning-test",
    1,
    extension.contracts,
    extension.catalog,
  );
  return { root, state, registry };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected object");
  return value as Record<string, unknown>;
}

describe("P-02 semantic CodeIntelligence planning reads", () => {
  it("advertises symbol, reference, and positive-diagnostic observations only", async () => {
    const { registry } = await fixture();
    expect(registry.catalog().reads.map((read) => read.definition.name)).toEqual([
      "find_code_references",
      "read_code_diagnostics",
      "search_code_symbols",
    ]);
    expect(registry.catalog().reads.map((read) => read.readContractId)).toEqual([
      "code.references",
      "code.diagnostics",
      "code.symbol_search",
    ]);
    expect(JSON.stringify(registry.catalog())).not.toMatch(/jsonrpc|language.server|write|edit|bash/i);
  });

  it("canonicalizes symbol/reference results and seals revision/provider provenance", async () => {
    const { registry } = await fixture();
    const tracker = registry.track("workspace-semantic-test");

    const symbols = record(await tracker.read("code.symbol_search", 1, { query: "Thing", limit: 20 }));
    const symbolValue = record(symbols.value);
    expect((symbolValue.symbols as Array<{ name: string; location: { path: string } }>).map((item) => [item.name, item.location.path])).toEqual([
      ["Alpha", "src/alpha.ts"],
      ["Zeta", "src/zeta.ts"],
    ]);

    const references = record(await tracker.read("code.references", 1, {
      path: "src/target.ts",
      line: 2,
      column: 4,
      includeDeclaration: false,
    }));
    const referenceValue = record(references.value);
    expect((referenceValue.locations as Array<{ path: string }>).map((item) => item.path)).toEqual([
      "src/use-a.ts",
      "src/use-b.ts",
    ]);

    const identity = tracker.seal();
    expect(identity.dependencies).toHaveLength(2);
    for (const dependency of identity.dependencies) {
      expect(dependency.coverageIdentity).toContain("code-intelligence-v1:workspace-semantic-test:repository-semantic-test:epoch-1:0:fingerprint-0");
      expect(dependency.providerBindingRevision).toBe("code-intelligence:deterministic-code-intelligence@1");
    }
  });

  it("fails symbol/reference reads when CodeIntelligence cannot prove completeness", async () => {
    const { state, registry } = await fixture();
    state.symbolComplete = false;
    await expect(registry.read("code.symbol_search", 1, { query: "Thing" })).rejects.toBeInstanceOf(PlanningReadError);
    state.symbolComplete = true;
    state.referenceComplete = false;
    await expect(registry.read("code.references", 1, {
      path: "src/target.ts",
      line: 0,
      column: 0,
    })).rejects.toBeInstanceOf(PlanningReadError);
  });

  it("preserves non-exhaustive diagnostics as positive current evidence", async () => {
    const { registry } = await fixture();
    const result = record((await registry.read("code.diagnostics", 1, { path: "src/broken.ts" })).result);
    expect(result.current).toBe(true);
    expect(result.complete).toBe(false);
    const value = record(result.value);
    expect(value.diagnostics).toEqual([
      expect.objectContaining({
        path: "src/broken.ts",
        severity: "error",
        code: 2322,
      }),
    ]);
    const descriptor = registry.catalog().reads.find((read) => read.readContractId === "code.diagnostics");
    expect(descriptor?.definition.description).toMatch(/never infer no diagnostics/i);
  });

  it("recheck rejects semantic evidence when the exact workspace revision changes", async () => {
    const { state, registry } = await fixture();
    const tracker = registry.track("workspace-semantic-test");
    await tracker.read("code.references", 1, { path: "src/target.ts", line: 1, column: 1 });
    const identity = tracker.seal();
    await expect(registry.recheck(identity)).resolves.toBeUndefined();

    state.generation = 1;
    state.fingerprint = "fingerprint-1";
    await expect(registry.recheck(identity)).rejects.toBeInstanceOf(PlanningBaseStaleError);
  });

  it("rejects semantic arguments and results that escape the workspace", async () => {
    const { registry } = await fixture();
    await expect(registry.read("code.references", 1, {
      path: "../outside.ts",
      line: 0,
      column: 0,
    })).rejects.toThrow(/escapes workspace root/);
  });
});
