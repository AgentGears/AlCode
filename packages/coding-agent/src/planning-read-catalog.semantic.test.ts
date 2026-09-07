import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalWorkspace } from "./capabilities/local-workspace.ts";
import { createLocalPlanningReadRegistry } from "./planning-read-catalog.ts";
import type {
  SemanticPlanningCodeIntelligence,
  SemanticPlanningObservation,
  SemanticPlanningQuery,
} from "./semantic-planning-read.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P-02 product semantic planning catalog", () => {
  it("composes semantic CodeIntelligence reads with the existing bounded filesystem catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "alcode-semantic-catalog-"));
    roots.push(root);
    const workspace = createLocalWorkspace({
      workspaceId: "workspace-semantic-catalog",
      repositoryId: "repository-semantic-catalog",
      root,
    });
    const observe = <T>(value: T, complete = true): SemanticPlanningObservation<T> => ({
      workspaceId: workspace.identity.workspaceId,
      repositoryId: workspace.identity.repositoryId,
      revision: { epoch: "epoch", generation: 0, fingerprint: "fingerprint" },
      complete,
      current: true,
      observedAt: new Date().toISOString(),
      provider: { name: "fake", version: "1" },
      value,
      diagnostics: [],
    });
    const service = {
      async query(request: SemanticPlanningQuery) {
        switch (request.type) {
          case "symbol_search": return observe({ symbols: [] });
          case "references": return observe({ locations: [] });
          case "diagnostics": return observe({ diagnostics: [] }, false);
        }
      },
    } as SemanticPlanningCodeIntelligence;

    const catalog = createLocalPlanningReadRegistry(workspace, service).catalog();
    expect(catalog.reads.map((read) => read.definition.name)).toEqual([
      "find_code_references",
      "list_workspace_tree",
      "read_code_diagnostics",
      "read_workspace_text",
      "search_code_symbols",
      "search_workspace_text",
    ]);
    expect(catalog.reads.map((read) => read.readContractId)).toEqual([
      "code.references",
      "workspace.list_tree",
      "code.diagnostics",
      "workspace.read_text",
      "code.symbol_search",
      "workspace.search_text",
    ]);
  });
});
