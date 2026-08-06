// Workspace identity types. See docs/adr/0002-workspace-identity-and-locking.md.
//
// Four concepts that must not be conflated:
//   repositoryId    — installation-assigned UUID, stable for a registered instance
//   repositoryLineage — remote URL + history evidence, shared by related clones
//   repositoryFingerprint — mutable recognition evidence (never the primary key)
//   workspaceId     — identity for an execution/state workspace

import type { WorkspaceId } from "@alcode/events";

/** A registered repository instance (stable identity, independent of path). */
export interface RepositoryEntry {
  repositoryId: string;
  /** First-known path (for diagnostics only; path is metadata, never the key). */
  firstSeenPath: string;
  /** Remote URL if available (lineage hint, shared by clones). */
  lineage?: string;
  /** When this repository was first registered. */
  registeredAt: string;
}

/** A path alias for a repository (multiple paths can point to the same repo). */
export interface PathAlias {
  path: string;
  repositoryId: string;
  /** When this alias was recorded. */
  aliasedAt: string;
}

/** A workspace (execution/state scope associated with a repository or worktree). */
export interface WorkspaceEntry {
  workspaceId: WorkspaceId;
  repositoryId: string;
  /** DB path under ALCODE_HOME/workspaces/<workspaceId>/workspace.sqlite */
  dbPath: string;
  /** Lock file path under ALCODE_HOME/workspaces/<workspaceId>/workspace.lock */
  lockPath: string;
  createdAt: string;
}

/**
 * Resolve a filesystem path to a repository identity.
 * Recognition policy (ADR 0002):
 *   - Known path alias → use existing repositoryId, update alias.
 *   - Same-filesystem move → recognized via path alias update.
 *   - Unknown → assign a new repositoryId.
 *   - Cross-filesystem move vs clone → inherently ambiguous; requires explicit
 *     `alcode workspace link`. Content hashing never claims to distinguish.
 */
export interface WorkspaceResolution {
  workspaceId: WorkspaceId;
  repositoryId: string;
  isNewRepository: boolean;
  isNewWorkspace: boolean;
}

/** Resolve options. */
export interface ResolveOptions {
  /** Explicit repository linking (skip recognition, force-associate). */
  linkToRepositoryId?: string;
}
