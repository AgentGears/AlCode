// Workspace database schema. See docs/phase-0-spec.md §"Storage layout" and
// docs/adr/0001-event-and-projection-commit-semantics.md.
//
// One SQLite database per workspace. WAL mode. Foreign keys on.
// BEGIN IMMEDIATE transactions. Immutable event IDs. Monotonic per-workspace
// event sequence.

import type Database from "better-sqlite3";

/** Schema version for migrations. */
export const SCHEMA_VERSION = 1;

/** DDL statements for the workspace database. */
const WORKSPACE_SCHEMA: string[] = [
  // --- Events (the append-only event log — historical truth) ---
  `CREATE TABLE IF NOT EXISTS events (
    event_id              TEXT PRIMARY KEY,
    idempotency_key       TEXT UNIQUE,
    sequence              INTEGER NOT NULL UNIQUE,
    workspace_id          TEXT NOT NULL,
    session_id            TEXT NOT NULL,
    operation_id          TEXT,
    type                  TEXT NOT NULL,
    payload               TEXT NOT NULL,
    payload_schema_version INTEGER NOT NULL DEFAULT 1,
    producer              TEXT NOT NULL,
    causation_event_id    TEXT,
    correlation_id        TEXT,
    occurred_at           TEXT NOT NULL,
    recorded_at           TEXT NOT NULL,
    event_digest          TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_sequence ON events(sequence)`,
  `CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)`,
  `CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id)`,

  // --- Projection cursors (ADR 0001: each projection tracks its position) ---
  `CREATE TABLE IF NOT EXISTS projection_cursors (
    projection_name            TEXT PRIMARY KEY,
    last_applied_event_sequence INTEGER NOT NULL DEFAULT 0,
    projection_schema_version  INTEGER NOT NULL DEFAULT 1
  )`,

  // --- Sessions ---
  `CREATE TABLE IF NOT EXISTS sessions (
    session_id    TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    stopped_at    TEXT
  )`,

  // --- Operations (ADR 0003: outcome × status × reconciliation) ---
  `CREATE TABLE IF NOT EXISTS operations (
    operation_id          TEXT PRIMARY KEY,
    workspace_id          TEXT NOT NULL,
    session_id            TEXT NOT NULL,
    tool_name             TEXT NOT NULL,
    args                  TEXT,
    execution_outcome     TEXT,
    effect_status         TEXT DEFAULT 'indeterminate',
    reconciliation_status TEXT DEFAULT 'not_required',
    started_at            TEXT,
    completed_at          TEXT
  )`,

  // --- Minimal reasoning projection (Phase 0.2: objective nodes only) ---
  `CREATE TABLE IF NOT EXISTS reasoning_nodes (
    node_id      TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    kind         TEXT NOT NULL,
    label        TEXT NOT NULL,
    data         TEXT,
    confidence   REAL,
    created_sequence INTEGER NOT NULL
  )`,

  // --- Minimal memory projection (Phase 0.2: single records, no scoring) ---
  `CREATE TABLE IF NOT EXISTS memories (
    memory_id    TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    type         TEXT NOT NULL,
    body         TEXT NOT NULL,
    created_sequence INTEGER NOT NULL
  )`,

  // --- Artifacts (content-addressed references) ---
  `CREATE TABLE IF NOT EXISTS artifacts (
    digest       TEXT PRIMARY KEY,
    path         TEXT NOT NULL,
    size         INTEGER NOT NULL,
    created_at   TEXT NOT NULL
  )`,

  // --- Projection receipts (Phase 0.7: context compiler receipts) ---
  `CREATE TABLE IF NOT EXISTS projection_receipts (
    receipt_id          TEXT PRIMARY KEY,
    projection_mode     TEXT NOT NULL,
    compiler_version    TEXT NOT NULL,
    source_event_sequence INTEGER NOT NULL,
    token_budget        INTEGER,
    estimated_tokens    INTEGER,
    fallback_used       INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL
  )`,

  // --- Schema migrations ---
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version      INTEGER PRIMARY KEY,
    applied_at   TEXT NOT NULL
  )`,

  // --- Secret redaction sidecar (ADR 0004: incident handling) ---
  `CREATE TABLE IF NOT EXISTS event_redactions (
    event_id     TEXT NOT NULL,
    json_pointer TEXT NOT NULL,
    replacement  TEXT NOT NULL,
    applied_at   TEXT NOT NULL,
    PRIMARY KEY (event_id, json_pointer)
  )`,
];

/**
 * Initialize the workspace database: set pragmas, create tables, record
 * the schema migration.
 */
export function initWorkspaceDb(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  for (const ddl of WORKSPACE_SCHEMA) {
    db.exec(ddl);
  }

  // Record the schema migration if not already present
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  ).run(SCHEMA_VERSION, new Date().toISOString());
}

/** Get the current schema version from the database. */
export function getSchemaVersion(db: Database.Database): number {
  const row = db.prepare("SELECT MAX(version) as v FROM schema_migrations").get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}
