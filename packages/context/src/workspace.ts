import { digestOf } from "./canonical.ts";
import type { WorkspaceContextSnapshot } from "./types.ts";

export interface WorkspaceSnapshotInput {
  workspaceId: string;
  repositoryId: string;
  kind: "git" | "non_git";
  headCommit?: string;
  branch?: string;
  dirty: boolean;
  changedPaths: readonly string[];
  changedPathCount?: number;
}

export function createWorkspaceContextSnapshot(
  input: WorkspaceSnapshotInput,
  maxChangedPaths = 64,
): WorkspaceContextSnapshot {
  const allPaths = [...new Set(input.changedPaths)].sort();
  const changedPathCount = input.changedPathCount ?? allPaths.length;
  const changedPaths = allPaths.slice(0, Math.max(0, maxChangedPaths));
  const changedPathsTruncated = changedPathCount > changedPaths.length;
  const state = {
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
    kind: input.kind,
    headCommit: input.headCommit ?? null,
    branch: input.branch ?? null,
    dirty: input.dirty,
    changedPaths,
    changedPathCount,
    changedPathsTruncated,
  };
  return {
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
    kind: input.kind,
    ...(input.headCommit !== undefined ? { headCommit: input.headCommit } : {}),
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    dirty: input.dirty,
    changedPaths,
    changedPathCount,
    changedPathsTruncated,
    statusDigest: digestOf(state),
  };
}
