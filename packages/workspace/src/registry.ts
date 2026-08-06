// Workspace registry — manages ~/.alcode/registry.sqlite.
//
// Tables:
//   repositories — installation-assigned repositoryId, first-seen path, lineage
//   path_aliases — path → repositoryId (multiple paths per repo)
//   workspaces   — workspaceId → repositoryId, dbPath, lockPath
//
// This is the single source of truth for workspace/repository identity.
// The workspace DB (workspace.sqlite) is separate and per-workspace.

import { join, resolve, isAbsolute } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import {
  type WorkspaceId,
  asWorkspaceId,
  mkWorkspaceId,
  uuidv7,
} from "@alcode/events";

const require = createRequire(import.meta.url);
import type {
  RepositoryEntry,
  PathAlias,
  WorkspaceEntry,
  WorkspaceResolution,
  ResolveOptions,
} from "./identity.ts";

const REGISTRY_DB_NAME = "registry.sqlite";
const WORKSPACES_DIR = "workspaces";
const DB_NAME = "workspace.sqlite";
const LOCK_NAME = "workspace.lock";

/** Schema DDL for the registry database. */
const REGISTRY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS repositories (
    repository_id   TEXT PRIMARY KEY,
    first_seen_path TEXT NOT NULL,
    lineage         TEXT,
    registered_at   TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS path_aliases (
    path          TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(repository_id),
    aliased_at    TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_path_aliases_repo ON path_aliases(repository_id)`,
  `CREATE TABLE IF NOT EXISTS workspaces (
    workspace_id  TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(repository_id),
    db_path       TEXT NOT NULL,
    lock_path     TEXT NOT NULL,
    created_at    TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workspaces_repo ON workspaces(repository_id)`,
];

/**
 * The workspace registry. Owns repository identity, path aliases, and
 * workspace-to-repository association.
 *
 * The registry DB is NOT the workspace DB — the registry tracks which
 * workspaces exist and where their DBs live; the workspace DB holds events
 * and projections.
 */
export class WorkspaceRegistry {
  private readonly alcodeHome: string;

  constructor(alcodeHome?: string) {
    this.alcodeHome = alcodeHome ?? process.env.ALCODE_HOME ?? join(homedir(), ".alcode");
    mkdirSync(this.alcodeHome, { recursive: true });
    mkdirSync(join(this.alcodeHome, WORKSPACES_DIR), { recursive: true });
  }

  get registryDbPath(): string {
    return join(this.alcodeHome, REGISTRY_DB_NAME);
  }

  get workspacesDir(): string {
    return join(this.alcodeHome, WORKSPACES_DIR);
  }

  /**
   * Resolve a filesystem path to a workspace, creating repository/workspace
   * entries as needed.
   *
   * Recognition policy (ADR 0002):
   *   1. If linkToRepositoryId is provided, force-associate (explicit link).
   *   2. If the path has a known alias, use that repositoryId.
   *   3. Otherwise, assign a new repositoryId.
   *   4. Create a new workspace for this repository (or reuse if one exists).
   */
  resolve(path: string, opts?: ResolveOptions): WorkspaceResolution {
    const absPath = isAbsolute(path) ? path : resolve(path);

    // Open registry DB and ensure schema
    const db = this.openRegistry();
    let repositoryId: string;
    let isNewRepository = false;

    if (opts?.linkToRepositoryId) {
      // Explicit link — trust the caller (alcode workspace link)
      repositoryId = opts.linkToRepositoryId;
      this.ensureRepository(db, repositoryId, absPath);
      this.upsertPathAlias(db, absPath, repositoryId);
    } else {
      // Check path alias
      const alias = this.findPathAlias(db, absPath);
      if (alias) {
        repositoryId = alias.repositoryId;
      } else {
        // New repository registration
        repositoryId = uuidv7();
        isNewRepository = true;
        this.insertRepository(db, repositoryId, absPath);
        this.upsertPathAlias(db, absPath, repositoryId);
      }
    }

    // Find or create a workspace for this repository
    let workspace = this.findWorkspaceByRepo(db, repositoryId);
    let isNewWorkspace = false;
    if (!workspace) {
      const workspaceId = mkWorkspaceId();
      const wsDir = join(this.workspacesDir, workspaceId);
      mkdirSync(wsDir, { recursive: true });
      workspace = {
        workspaceId,
        repositoryId,
        dbPath: join(wsDir, DB_NAME),
        lockPath: join(wsDir, LOCK_NAME),
        createdAt: new Date().toISOString(),
      };
      this.insertWorkspace(db, workspace);
      isNewWorkspace = true;
    }

    db.close();

    return {
      workspaceId: workspace.workspaceId,
      repositoryId,
      isNewRepository,
      isNewWorkspace,
    };
  }

  /** Look up a workspace by ID. */
  getWorkspace(workspaceId: WorkspaceId): WorkspaceEntry | undefined {
    const db = this.openRegistry();
    const row = db.prepare("SELECT * FROM workspaces WHERE workspace_id = ?").get(workspaceId as string) as
      | Omit<WorkspaceEntry, "workspaceId"> & { workspace_id: string; repository_id: string; db_path: string; lock_path: string; created_at: string }
      | undefined;
    db.close();
    if (!row) return undefined;
    return {
      workspaceId: asWorkspaceId(row.workspace_id),
      repositoryId: row.repository_id,
      dbPath: row.db_path,
      lockPath: row.lock_path,
      createdAt: row.created_at,
    };
  }

  /** List all path aliases for a repository (diagnostics). */
  getPathAliases(repositoryId: string): PathAlias[] {
    const db = this.openRegistry();
    const rows = db.prepare("SELECT * FROM path_aliases WHERE repository_id = ? ORDER BY aliased_at").all(repositoryId) as
      Array<{ path: string; repository_id: string; aliased_at: string }>;
    db.close();
    return rows.map((r) => ({ path: r.path, repositoryId: r.repository_id, aliasedAt: r.aliased_at }));
  }

  /** Update a path alias (for move recognition — same repo, new path). */
  updatePathAlias(newPath: string, repositoryId: string): void {
    const absPath = isAbsolute(newPath) ? newPath : resolve(newPath);
    const db = this.openRegistry();
    this.upsertPathAlias(db, absPath, repositoryId);
    db.close();
  }

  // --- private helpers ---

  private openRegistry(): import("better-sqlite3").Database {
    // Lazy import to keep the module loadable without better-sqlite3 in some contexts.
    const Database = require("better-sqlite3");
    const db = new Database(this.registryDbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    for (const ddl of REGISTRY_SCHEMA) {
      db.exec(ddl);
    }
    return db;
  }

  private ensureRepository(db: import("better-sqlite3").Database, repositoryId: string, path: string): void {
    db.prepare(
      "INSERT OR IGNORE INTO repositories (repository_id, first_seen_path, registered_at) VALUES (?, ?, ?)",
    ).run(repositoryId, path, new Date().toISOString());
  }

  private insertRepository(db: import("better-sqlite3").Database, repositoryId: string, path: string): void {
    db.prepare(
      "INSERT INTO repositories (repository_id, first_seen_path, registered_at) VALUES (?, ?, ?)",
    ).run(repositoryId, path, new Date().toISOString());
  }

  private findPathAlias(db: import("better-sqlite3").Database, path: string): PathAlias | undefined {
    const row = db.prepare("SELECT * FROM path_aliases WHERE path = ?").get(path) as
      | { path: string; repository_id: string; aliased_at: string }
      | undefined;
    return row ? { path: row.path, repositoryId: row.repository_id, aliasedAt: row.aliased_at } : undefined;
  }

  private upsertPathAlias(db: import("better-sqlite3").Database, path: string, repositoryId: string): void {
    db.prepare(
      "INSERT INTO path_aliases (path, repository_id, aliased_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(path) DO UPDATE SET repository_id = excluded.repository_id, aliased_at = excluded.aliased_at",
    ).run(path, repositoryId, new Date().toISOString());
  }

  private findWorkspaceByRepo(db: import("better-sqlite3").Database, repositoryId: string): WorkspaceEntry | undefined {
    const row = db.prepare("SELECT * FROM workspaces WHERE repository_id = ? ORDER BY created_at DESC LIMIT 1").get(repositoryId) as
      | { workspace_id: string; repository_id: string; db_path: string; lock_path: string; created_at: string }
      | undefined;
    if (!row) return undefined;
    return {
      workspaceId: asWorkspaceId(row.workspace_id),
      repositoryId: row.repository_id,
      dbPath: row.db_path,
      lockPath: row.lock_path,
      createdAt: row.created_at,
    };
  }

  private insertWorkspace(db: import("better-sqlite3").Database, ws: WorkspaceEntry): void {
    db.prepare(
      "INSERT INTO workspaces (workspace_id, repository_id, db_path, lock_path, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(ws.workspaceId as string, ws.repositoryId, ws.dbPath, ws.lockPath, ws.createdAt);
  }
}
