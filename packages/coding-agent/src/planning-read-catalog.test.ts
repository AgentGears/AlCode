import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalWorkspace } from "./capabilities/local-workspace.ts";
import { createLocalPlanningReadRegistry } from "./planning-read-catalog.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alcode-planning-"));
  roots.push(root);
  const workspace = createLocalWorkspace({
    workspaceId: "workspace-planning-test",
    repositoryId: "repository-planning-test",
    root,
  });
  return { root, registry: createLocalPlanningReadRegistry(workspace) };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected object");
  return value as Record<string, unknown>;
}

describe("P-01 local planning read catalog", () => {
  it("advertises only the three bounded read-only semantic observations", async () => {
    const { registry } = await fixture();
    const catalog = registry.catalog();
    expect(catalog.reads.map((read) => read.definition.name)).toEqual([
      "list_workspace_tree",
      "read_workspace_text",
      "search_workspace_text",
    ]);
    expect(catalog.digest).toBe(registry.catalog().digest);
    expect(catalog.reads.map((read) => read.readContractId)).toEqual([
      "workspace.list_tree",
      "workspace.read_text",
      "workspace.search_text",
    ]);
    expect(JSON.stringify(catalog)).not.toMatch(/bash|write|edit|terminal/i);
  });

  it("reports complete=false instead of silently truncating tree and text observations", async () => {
    const { root, registry } = await fixture();
    await writeFile(join(root, "a.txt"), "abcdefghijk", "utf8");
    await writeFile(join(root, "b.txt"), "b", "utf8");
    await writeFile(join(root, "c.txt"), "c", "utf8");

    const tree = record((await registry.read("workspace.list_tree", 1, {
      path: ".",
      depth: 1,
      maxEntries: 2,
    })).result);
    expect(tree.complete).toBe(false);
    expect(tree.entries).toHaveLength(2);

    const text = record((await registry.read("workspace.read_text", 1, {
      path: "a.txt",
      maxBytes: 4,
    })).result);
    expect(text.complete).toBe(false);
    expect(text.byteCount).toBe(11);
  });

  it("returns deterministic bounded search results and marks overflow incomplete", async () => {
    const { root, registry } = await fixture();
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "b.txt"), "needle b\n", "utf8");
    await writeFile(join(root, "a.txt"), "needle a\n", "utf8");
    await writeFile(join(root, "nested", "c.txt"), "needle c\n", "utf8");

    const search = record((await registry.read("workspace.search_text", 1, {
      pattern: "needle",
      path: ".",
      include: "*.txt",
      maxResults: 2,
    })).result);
    expect(search.complete).toBe(false);
    expect((search.results as Array<{ path: string }>).map((match) => match.path)).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });

  it("rejects paths that escape the workspace before filesystem observation", async () => {
    const { registry } = await fixture();
    await expect(registry.read("workspace.read_text", 1, {
      path: "../outside.txt",
    })).rejects.toThrow("Planning path escapes workspace root");
    await expect(registry.read("workspace.list_tree", 1, {
      path: "../outside",
    })).rejects.toThrow("Planning path escapes workspace root");
    await expect(registry.read("workspace.search_text", 1, {
      pattern: "x",
      path: "../outside",
    })).rejects.toThrow("Planning path escapes workspace root");
  });
});
