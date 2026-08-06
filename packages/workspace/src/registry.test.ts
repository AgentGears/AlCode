import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceRegistry, resolveAlcodeHome } from "./index.ts";

describe("WorkspaceRegistry", () => {
  let alcodeHome: string;

  beforeEach(() => {
    alcodeHome = mkdtempSync(join(tmpdir(), "alcode-test-"));
    process.env.ALCODE_HOME = alcodeHome;
  });

  afterEach(() => {
    delete process.env.ALCODE_HOME;
    rmSync(alcodeHome, { recursive: true, force: true });
  });

  it("assigns a new repositoryId and workspaceId for a new path", () => {
    const reg = new WorkspaceRegistry();
    const result = reg.resolve("/fake/path/repo-a");
    expect(result.repositoryId).toBeTruthy();
    expect(result.workspaceId).toBeTruthy();
    expect(result.isNewRepository).toBe(true);
    expect(result.isNewWorkspace).toBe(true);
  });

  it("recognizes the same path on second resolve (returns same ids)", () => {
    const reg = new WorkspaceRegistry();
    const first = reg.resolve("/fake/path/repo-a");
    const second = reg.resolve("/fake/path/repo-a");
    expect(second.repositoryId).toBe(first.repositoryId);
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.isNewRepository).toBe(false);
    expect(second.isNewWorkspace).toBe(false);
  });

  it("creates a workspace DB directory under ALCODE_HOME", () => {
    const reg = new WorkspaceRegistry();
    const result = reg.resolve("/fake/path/repo-a");
    const ws = reg.getWorkspace(result.workspaceId);
    expect(ws).toBeDefined();
    expect(ws!.dbPath).toContain(result.workspaceId as string);
    expect(ws!.dbPath.endsWith("workspace.sqlite")).toBe(true);
    expect(ws!.lockPath.endsWith("workspace.lock")).toBe(true);
    // The directory should exist
    const wsDir = join(resolveAlcodeHome(), "workspaces", result.workspaceId as string);
    expect(existsSync(wsDir)).toBe(true);
  });

  it("assigns different repositoryIds for different paths", () => {
    const reg = new WorkspaceRegistry();
    const a = reg.resolve("/fake/path/repo-a");
    const b = reg.resolve("/fake/path/repo-b");
    expect(a.repositoryId).not.toBe(b.repositoryId);
    expect(a.workspaceId).not.toBe(b.workspaceId);
  });

  it("explicit linkToRepositoryId forces association", () => {
    const reg = new WorkspaceRegistry();
    const first = reg.resolve("/fake/path/repo-a");
    // Link a different path to the same repository
    const linked = reg.resolve("/fake/path/repo-b", {
      linkToRepositoryId: first.repositoryId,
    });
    expect(linked.repositoryId).toBe(first.repositoryId);
    expect(linked.isNewRepository).toBe(false);
  });

  it("tracks path aliases for a repository", () => {
    const reg = new WorkspaceRegistry();
    const result = reg.resolve("/fake/path/repo-a");
    const aliases = reg.getPathAliases(result.repositoryId);
    expect(aliases.length).toBe(1);
    expect(aliases[0]!.path).toBe("/fake/path/repo-a");
  });

  it("updates path alias on move (same repo, new path)", () => {
    const reg = new WorkspaceRegistry();
    const first = reg.resolve("/fake/path/repo-a");
    reg.updatePathAlias("/fake/path/moved-repo-a", first.repositoryId);
    const aliases = reg.getPathAliases(first.repositoryId);
    expect(aliases.length).toBe(2);
    // Resolving the new path returns the same repositoryId
    const moved = reg.resolve("/fake/path/moved-repo-a");
    expect(moved.repositoryId).toBe(first.repositoryId);
  });

  it("getWorkspace returns undefined for unknown workspaceId", () => {
    const reg = new WorkspaceRegistry();
    const ws = reg.getWorkspace("nonexistent" as never);
    expect(ws).toBeUndefined();
  });
});
