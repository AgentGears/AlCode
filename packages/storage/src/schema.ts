// Workspace database schema and migrations.
// See docs/phase-0-spec.md §"Storage layout" and
// docs/adr/0001-event-and-projection-commit-semantics.md.

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { canonicalStringify } from "@alcode/events";

/** Current schema version. */
export const SCHEMA_VERSION = 7;

/** DDL for fresh databases (all tables at current version). */
const WORKSPACE_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS workspace_metadata (
    singleton     INTEGER PRIMARY KEY CHECK (singleton = 1),
    workspace_id  TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    created_at    TEXT NOT NULL
  )`,
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
    event_digest          TEXT NOT NULL,
    request_fingerprint   TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_sequence ON events(sequence)`,
  `CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)`,
  `CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id)`,
  `CREATE TABLE IF NOT EXISTS projection_cursors (
    projection_name            TEXT PRIMARY KEY,
    last_applied_event_sequence INTEGER NOT NULL DEFAULT 0,
    projection_schema_version  INTEGER NOT NULL DEFAULT 1,
    classification             TEXT NOT NULL DEFAULT 'derived'
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    session_id    TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    stopped_at    TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS operations (
    operation_id          TEXT PRIMARY KEY,
    workspace_id          TEXT NOT NULL,
    session_id            TEXT NOT NULL,
    tool_name             TEXT NOT NULL,
    args                  TEXT,
    lifecycle_state       TEXT NOT NULL DEFAULT 'requested',
    execution_outcome     TEXT,
    effect_status         TEXT DEFAULT 'indeterminate',
    reconciliation_status TEXT DEFAULT 'not_required',
    started_at            TEXT,
    completed_at          TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS reasoning_nodes (
    node_id      TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    session_id   TEXT,
    kind         TEXT NOT NULL,
    label        TEXT NOT NULL,
    data         TEXT,
    confidence   REAL,
    step         INTEGER,
    created_sequence INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reasoning_edges (
    edge_id      TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    session_id   TEXT,
    source_node_id TEXT NOT NULL,
    target_node_id TEXT NOT NULL,
    kind         TEXT NOT NULL,
    data         TEXT,
    created_sequence INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS memories (
    memory_id    TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    type         TEXT NOT NULL,
    body         TEXT NOT NULL,
    created_sequence INTEGER NOT NULL,
    name         TEXT,
    fields_json  TEXT,
    confidence   REAL,
    source_event_ids TEXT,
    stored_at    INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS memory_stats (
    memory_id           TEXT PRIMARY KEY,
    type                TEXT NOT NULL,
    confidence          REAL NOT NULL,
    last_seen           INTEGER,
    last_used           INTEGER,
    seen_count          INTEGER NOT NULL DEFAULT 0,
    used_count          INTEGER NOT NULL DEFAULT 0,
    consolidation_count INTEGER NOT NULL DEFAULT 0,
    strength            REAL,
    lifecycle           TEXT NOT NULL DEFAULT 'active',
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS transcript_messages (
    event_id     TEXT PRIMARY KEY,
    sequence     INTEGER NOT NULL,
    workspace_id TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    role         TEXT NOT NULL,
    body         TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS artifacts (
    digest       TEXT PRIMARY KEY,
    path         TEXT NOT NULL,
    size         INTEGER NOT NULL,
    created_at   TEXT NOT NULL
  )`,
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
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version      INTEGER PRIMARY KEY,
    applied_at   TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS event_redactions (
    event_id     TEXT NOT NULL,
    json_pointer TEXT NOT NULL,
    replacement  TEXT NOT NULL,
    applied_at   TEXT NOT NULL,
    PRIMARY KEY (event_id, json_pointer)
  )`,
];

/**
 * Initialize the workspace database at the current schema version.
 * For a fresh database, creates all tables and records version 2.
 * For an existing database, runs migrations from the detected version.
 */
export function initWorkspaceDb(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  // Check if this is a fresh database (no schema_migrations table)
  const hasMigrations = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
  ).get() as { name: string } | undefined;

  if (!hasMigrations) {
    // Fresh database — create all tables at current version
    for (const ddl of WORKSPACE_SCHEMA) {
      db.exec(ddl);
    }
    db.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    ).run(SCHEMA_VERSION, new Date().toISOString());
    return;
  }

  // Existing database — run migrations
  const currentVersion = getSchemaVersion(db);
  if (currentVersion < 2) {
    migrateV1toV2(db);
  }
  if (getSchemaVersion(db) < 3) {
    migrateV2toV3(db);
  }
  if (getSchemaVersion(db) < 4) {
    migrateV3toV4(db);
  }
  if (getSchemaVersion(db) < 5) {
    migrateV4toV5(db);
  }
  if (getSchemaVersion(db) < 6) {
    migrateV5toV6(db);
  }
  if (getSchemaVersion(db) < 7) {
    migrateV6toV7(db);
  }
}

/** Get the current schema version from the database. */
export function getSchemaVersion(db: Database.Database): number {
  const row = db.prepare("SELECT MAX(version) as v FROM schema_migrations").get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

/**
 * Migration from schema v1 (checkpoint b338f3a) to v2.
 *
 * v1 had: events table WITHOUT request_fingerprint, no workspace_metadata.
 * v2 adds: request_fingerprint column (NOT NULL), workspace_metadata table.
 *
 * The migration:
 *   1. Adds request_fingerprint as a nullable column.
 *   2. Creates workspace_metadata.
 *   3. Discovers the workspace ID from existing events (must be unique).
 *   4. Verifies every existing event's stored event_digest matches a
 *      recomputed digest. FAILS CLOSED on mismatch (does not rewrite).
 *   5. Backfills request_fingerprint (computed, not digest).
 *   6. Rebuilds the events table to enforce NOT NULL on request_fingerprint.
 *   7. Records migration version 2.
 */
function migrateV1toV2(db: Database.Database): void {
  const migrationTxn = db.transaction(() => {
    // Step 1: Add request_fingerprint as nullable
    const hasColumn = db.prepare(
      "SELECT COUNT(*) as c FROM pragma_table_info('events') WHERE name = 'request_fingerprint'",
    ).get() as { c: number };
    if (hasColumn.c === 0) {
      db.exec("ALTER TABLE events ADD COLUMN request_fingerprint TEXT");
    }

    // Step 2: Create workspace_metadata
    db.exec(`CREATE TABLE IF NOT EXISTS workspace_metadata (
      singleton     INTEGER PRIMARY KEY CHECK (singleton = 1),
      workspace_id  TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      created_at    TEXT NOT NULL
    )`);

    // Step 3: Discover workspace IDs
    const wsIds = db.prepare("SELECT DISTINCT workspace_id FROM events").all() as Array<{ workspace_id: string }>;
    if (wsIds.length > 1) {
      throw new Error(
        `Migration v1→v2 failed: events table contains ${wsIds.length} distinct workspace IDs.`,
      );
    }
    if (wsIds.length === 1) {
      const wsId = wsIds[0]!.workspace_id;
      const existingMeta = db.prepare(
        "SELECT workspace_id FROM workspace_metadata WHERE singleton = 1",
      ).get() as { workspace_id: string } | undefined;
      if (!existingMeta) {
        db.prepare(
          "INSERT INTO workspace_metadata (singleton, workspace_id, repository_id, created_at) VALUES (1, ?, ?, ?)",
        ).run(wsId, "__migrating__", new Date().toISOString());
      }
    }

    // Step 4: VERIFY (not rewrite) each event's digest
    const rows = db.prepare(
      "SELECT event_id, workspace_id, session_id, operation_id, type, payload, " +
      "payload_schema_version, producer, causation_event_id, correlation_id, occurred_at, " +
      "sequence, recorded_at, event_digest " +
      "FROM events WHERE request_fingerprint IS NULL",
    ).all() as Array<Record<string, string | null>>;

    const updateFpStmt = db.prepare(
      "UPDATE events SET request_fingerprint = ? WHERE event_id = ?",
    );

    for (const row of rows) {
      // Verify the stored digest matches a recomputed digest
      const recomputedDigest = computeDigestFromRow(row);
      if (recomputedDigest !== row.event_digest) {
        throw new Error(
          `Migration v1→v2 failed: event ${row.event_id} has a stored digest that does not match ` +
          `its content. This indicates pre-existing corruption. The migration does not rewrite digests.`,
        );
      }
      // Backfill only request_fingerprint (the digest is already valid)
      const fp = computeFingerprintFromRow(row);
      updateFpStmt.run(fp, row.event_id);
    }

    // Step 5: Verify no NULLs remain
    const nullCount = db.prepare(
      "SELECT COUNT(*) as c FROM events WHERE request_fingerprint IS NULL",
    ).get() as { c: number };
    if (nullCount.c > 0) {
      throw new Error(`Migration v1→v2 failed: ${nullCount.c} events still have NULL request_fingerprint.`);
    }

    // Step 6: Rebuild events table to enforce NOT NULL on request_fingerprint
    // SQLite cannot ALTER COLUMN; must use the table-rebuild pattern.
    db.exec("ALTER TABLE events RENAME TO events_v1_old");
    db.exec(`CREATE TABLE events (
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
      event_digest          TEXT NOT NULL,
      request_fingerprint   TEXT NOT NULL
    )`);
    db.exec(`INSERT INTO events SELECT
      event_id, idempotency_key, sequence, workspace_id, session_id,
      operation_id, type, payload, payload_schema_version, producer,
      causation_event_id, correlation_id, occurred_at, recorded_at, event_digest,
      request_fingerprint FROM events_v1_old`);
    db.exec("DROP TABLE events_v1_old");
    db.exec("CREATE INDEX IF NOT EXISTS idx_events_sequence ON events(sequence)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id)");

    // Step 7: Record migration
    db.prepare("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(2, new Date().toISOString());
  });

  migrationTxn();
}

/**
 * Migration from schema v2 to v3.
 * Adds the `classification` column to `projection_cursors`.
 * Existing projections default to 'derived'.
 */
function migrateV2toV3(db: Database.Database): void {
  const migrationTxn = db.transaction(() => {
    // Ensure all v2 tables exist (in case a v1 DB went through v1→v2 migration
    // that only altered events but didn't create other tables)
    db.exec(`CREATE TABLE IF NOT EXISTS projection_cursors (
      projection_name            TEXT PRIMARY KEY,
      last_applied_event_sequence INTEGER NOT NULL DEFAULT 0,
      projection_schema_version  INTEGER NOT NULL DEFAULT 1
    )`);
    // Create any other missing v2 tables
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      session_id    TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      started_at    TEXT NOT NULL,
      stopped_at    TEXT
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS operations (
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
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS reasoning_nodes (
      node_id      TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      kind         TEXT NOT NULL,
      label        TEXT NOT NULL,
      data         TEXT,
      confidence   REAL,
      created_sequence INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS memories (
      memory_id    TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      type         TEXT NOT NULL,
      body         TEXT NOT NULL,
      created_sequence INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS artifacts (
      digest       TEXT PRIMARY KEY,
      path         TEXT NOT NULL,
      size         INTEGER NOT NULL,
      created_at   TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS projection_receipts (
      receipt_id          TEXT PRIMARY KEY,
      projection_mode     TEXT NOT NULL,
      compiler_version    TEXT NOT NULL,
      source_event_sequence INTEGER NOT NULL,
      token_budget        INTEGER,
      estimated_tokens    INTEGER,
      fallback_used       INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS event_redactions (
      event_id     TEXT NOT NULL,
      json_pointer TEXT NOT NULL,
      replacement  TEXT NOT NULL,
      applied_at   TEXT NOT NULL,
      PRIMARY KEY (event_id, json_pointer)
    )`);

    // Check if projection_cursors has the classification column
    const hasColumn = db.prepare(
      "SELECT COUNT(*) as c FROM pragma_table_info('projection_cursors') WHERE name = 'classification'",
    ).get() as { c: number };

    if (hasColumn.c === 0) {
      // Rebuild projection_cursors with the new column
      db.exec("ALTER TABLE projection_cursors RENAME TO projection_cursors_v2_old");
      db.exec(`CREATE TABLE projection_cursors (
        projection_name            TEXT PRIMARY KEY,
        last_applied_event_sequence INTEGER NOT NULL DEFAULT 0,
        projection_schema_version  INTEGER NOT NULL DEFAULT 1,
        classification             TEXT NOT NULL DEFAULT 'derived'
      )`);
      db.exec(`INSERT INTO projection_cursors (projection_name, last_applied_event_sequence, projection_schema_version, classification)
               SELECT projection_name, last_applied_event_sequence, projection_schema_version, 'derived'
               FROM projection_cursors_v2_old`);
      db.exec("DROP TABLE projection_cursors_v2_old");
    }

    db.prepare("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(3, new Date().toISOString());
  });

  migrationTxn();
}

/**
 * Migration from schema v3 to v4.
 * Adds `lifecycle_state` column to `operations` table.
 * Existing operations (all NULL execution_outcome) get 'requested'.
 * Operations with an execution_outcome get 'terminal'.
 */
function migrateV3toV4(db: Database.Database): void {
  const migrationTxn = db.transaction(() => {
    const hasColumn = db.prepare(
      "SELECT COUNT(*) as c FROM pragma_table_info('operations') WHERE name = 'lifecycle_state'",
    ).get() as { c: number };

    if (hasColumn.c === 0) {
      db.exec("ALTER TABLE operations ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'requested'");
      // Existing operations with a terminal outcome get 'terminal'
      db.prepare(
        "UPDATE operations SET lifecycle_state = 'terminal' WHERE execution_outcome IS NOT NULL",
      ).run();
    }

    db.prepare("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(4, new Date().toISOString());
  });

  migrationTxn();
}

/**
 * Migration from schema v4 to v5.
 * Adds the `transcript_messages` table for the critical transcript projection.
 */
function migrateV4toV5(db: Database.Database): void {
  const migrationTxn = db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS transcript_messages (
      event_id     TEXT PRIMARY KEY,
      sequence     INTEGER NOT NULL,
      workspace_id TEXT NOT NULL,
      session_id   TEXT NOT NULL,
      role         TEXT NOT NULL,
      body         TEXT NOT NULL
    )`);

    db.prepare("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(5, new Date().toISOString());
  });

  migrationTxn();
}

/**
 * Migration from schema v5 to v6.
 * Adds the `memory_stats` table for mutable memory statistics (strength,
 * usage counters, lifecycle, consolidation count) — the Ola-derived sidecar
 * that lives alongside the immutable `memories` content table.
 */
function migrateV5toV6(db: Database.Database): void {
  const migrationTxn = db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_stats (
      memory_id           TEXT PRIMARY KEY,
      type                TEXT NOT NULL,
      confidence          REAL NOT NULL,
      last_seen           INTEGER,
      last_used           INTEGER,
      seen_count          INTEGER NOT NULL DEFAULT 0,
      used_count          INTEGER NOT NULL DEFAULT 0,
      consolidation_count INTEGER NOT NULL DEFAULT 0,
      strength            REAL,
      lifecycle           TEXT NOT NULL DEFAULT 'active',
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    )`);

    // Add columns to memories for the complete semantic record (Fix 2).
    // ALTER TABLE ADD COLUMN is safe on SQLite for existing tables.
    const memoriesCols = db.prepare(
      "SELECT COUNT(*) as c FROM pragma_table_info('memories') WHERE name = 'name'",
    ).get() as { c: number };
    if (memoriesCols.c === 0) {
      db.exec("ALTER TABLE memories ADD COLUMN name TEXT");
      db.exec("ALTER TABLE memories ADD COLUMN fields_json TEXT");
      db.exec("ALTER TABLE memories ADD COLUMN confidence REAL");
      db.exec("ALTER TABLE memories ADD COLUMN source_event_ids TEXT");
      db.exec("ALTER TABLE memories ADD COLUMN stored_at INTEGER");
    }

    // Reset the memory projection cursor so it rebuilds under schema v2.
    // A v5 database has cursor schema version 1; the v2 projection declares
    // schema version 2. Without this reset, catchUp() throws
    // SchemaVersionMismatchError before replay can proceed.
    db.prepare("DELETE FROM projection_cursors WHERE projection_name = 'memory'").run();
    // Clear stale rows from the v1 projection so they don't conflict with
    // the v2 INSERT OR REPLACE during rebuild.
    db.exec("DELETE FROM memories");

    db.prepare("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(6, new Date().toISOString());
  });

  migrationTxn();
}

/**
 * Migration from schema v6 to v7.
 * Adds the `reasoning_edges` table and extends `reasoning_nodes` with
 * `session_id` and `step` columns for the Phase 0.4 reasoning projection v2.
 * Resets the reasoning projection cursor so it rebuilds under schema v2.
 */
function migrateV6toV7(db: Database.Database): void {
  const migrationTxn = db.transaction(() => {
    // Add session_id and step to reasoning_nodes if missing
    const hasSessionId = db.prepare(
      "SELECT COUNT(*) as c FROM pragma_table_info('reasoning_nodes') WHERE name = 'session_id'",
    ).get() as { c: number };
    if (hasSessionId.c === 0) {
      db.exec("ALTER TABLE reasoning_nodes ADD COLUMN session_id TEXT");
      db.exec("ALTER TABLE reasoning_nodes ADD COLUMN step INTEGER");
    }

    // Create reasoning_edges table
    db.exec(`CREATE TABLE IF NOT EXISTS reasoning_edges (
      edge_id      TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      session_id   TEXT,
      source_node_id TEXT NOT NULL,
      target_node_id TEXT NOT NULL,
      kind         TEXT NOT NULL,
      data         TEXT,
      created_sequence INTEGER NOT NULL
    )`);

    // Reset the reasoning projection cursor for schema v2 rebuild.
    // A v6 database has cursor schema version 1; the v2 projection declares
    // schema version 2. Without this reset, catchUp() throws
    // SchemaVersionMismatchError before replay can proceed.
    db.prepare("DELETE FROM projection_cursors WHERE projection_name = 'reasoning'").run();
    // Clear stale rows from the v1 projection for clean rebuild.
    db.exec("DELETE FROM reasoning_nodes");
    db.exec("DELETE FROM reasoning_edges");

    db.prepare("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(7, new Date().toISOString());
  });

  migrationTxn();
}

/** Compute a request fingerprint from raw row data (for migration backfill). */
function computeFingerprintFromRow(row: Record<string, string | null>): string {
  const fingerprintInput = {
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    operationId: row.operation_id ?? null,
    type: row.type,
    payload: JSON.parse(row.payload as string),
    payloadSchemaVersion: row.payload_schema_version ?? 1,
    producer: JSON.parse(row.producer as string),
    causationEventId: row.causation_event_id ?? null,
    correlationId: row.correlation_id ?? null,
    occurredAt: row.occurred_at,
  };
  return createHash("sha256").update(canonicalStringify(fingerprintInput)).digest("hex");
}

/** Compute an event digest from raw row data (for migration verification). */
function computeDigestFromRow(row: Record<string, string | null>): string {
  const digestInput: Record<string, unknown> = {
    eventId: row.event_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    occurredAt: row.occurred_at,
    type: row.type,
    payload: JSON.parse(row.payload as string),
    payloadSchemaVersion: row.payload_schema_version ?? 1,
    producer: JSON.parse(row.producer as string),
    sequence: row.sequence,
    recordedAt: row.recorded_at,
  };
  if (row.idempotency_key) digestInput.idempotencyKey = row.idempotency_key;
  if (row.operation_id) digestInput.operationId = row.operation_id;
  if (row.causation_event_id) digestInput.causationEventId = row.causation_event_id;
  if (row.correlation_id) digestInput.correlationId = row.correlation_id;
  return createHash("sha256").update(canonicalStringify(digestInput)).digest("hex");
}

/**
 * Bind the database to a workspaceId + repositoryId.
 * - New database: inserts the singleton row.
 * - Existing database: verifies workspaceId matches. For repositoryId:
 *   - If stored value is "__migrating__": permanently replaces it with the
 *     supplied repositoryId. This happens exactly once on the first safe open
 *     after migration. Every subsequent open must match exactly.
 *   - Otherwise: verifies exact match.
 */
export function bindWorkspace(
  db: Database.Database,
  workspaceId: string,
  repositoryId: string,
): void {
  const existing = db.prepare(
    "SELECT workspace_id, repository_id FROM workspace_metadata WHERE singleton = 1",
  ).get() as { workspace_id: string; repository_id: string } | undefined;

  if (existing) {
    if (existing.workspace_id !== workspaceId) {
      throw new WorkspaceMismatchError("workspaceId", workspaceId, existing.workspace_id);
    }
    if (existing.repository_id === "__migrating__") {
      // First safe open after migration — permanently bind the repository ID
      db.prepare(
        "UPDATE workspace_metadata SET repository_id = ? WHERE singleton = 1",
      ).run(repositoryId);
      return;
    }
    if (existing.repository_id !== repositoryId) {
      throw new WorkspaceMismatchError("repositoryId", repositoryId, existing.repository_id);
    }
    return;
  }

  db.prepare(
    "INSERT INTO workspace_metadata (singleton, workspace_id, repository_id, created_at) VALUES (1, ?, ?, ?)",
  ).run(workspaceId, repositoryId, new Date().toISOString());
}

/** Error thrown when a workspace identity mismatch is detected. */
export class WorkspaceMismatchError extends Error {
  constructor(
    public readonly field: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `Workspace ${field} mismatch: expected ${expected}, but database is bound to ${actual}.`,
    );
    this.name = "WorkspaceMismatchError";
  }
}
