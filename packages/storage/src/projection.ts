// Projection transaction model. See docs/adr/0001-event-and-projection-commit-semantics.md.
//
// Enforced guarantees:
//   - ProjectionRunner is a frozen null-prototype facade (no db, no constructor)
//   - catchUp() takes no event provider — verified reads are bound internally
//   - Projection SQL is pre-registered; no caller-supplied arbitrary SQL
//   - ProjectionTransaction is invalidated after apply() returns or throws
//   - Classification is persisted (schema v3) and authoritative
//   - catchUp() rejects inline classifications
//   - caught is determined by cursor vs head, not batch size

import type { PersistedDomainEvent } from "@alcode/events";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ProjectionClassification = "inline" | "critical" | "derived";

export interface ProjectionCursor {
  readonly projectionName: string;
  readonly lastAppliedEventSequence: number;
  readonly schemaVersion: number;
  readonly classification: ProjectionClassification;
}

export interface ProjectionCatchUpResult {
  readonly appliedCount: number;
  readonly newCursor: ProjectionCursor;
  readonly caught: boolean;
}

/**
 * A constrained projection mutation interface. Projections receive this
 * during apply(); it is invalidated immediately after apply() returns or
 * throws. Only pre-registered statement names are accepted — no arbitrary SQL.
 */
export interface ProjectionTransaction {
  /**
   * Execute a registered statement by name with positional params.
   * Returns the number of rows affected (better-sqlite3's `changes`).
   * Throws if the statement name is not registered or the transaction is
   * no longer active.
   */
  exec(statementName: string, ...params: unknown[]): number;
}

/**
 * Statement registration for a projection. Statements are SQL templates
 * associated with a projection. Reserved tables (events, projection_cursors,
 * workspace_metadata, schema_migrations, event_redactions) are rejected at
 * registration time.
 */
export interface StatementDefinition {
  readonly name: string;
  readonly sql: string;
}

export interface ProjectionDefinition {
  readonly name: string;
  readonly schemaVersion: number;
  readonly classification: ProjectionClassification;
  /**
   * Optional idempotent projection-owned setup statements. These are validated
   * against the same reserved-table boundary as mutation statements and run
   * before event reads/statement compilation on every catchUp(). This lets a
   * derived projection own rebuildable tables without exposing the database or
   * arbitrary SQL to projection code.
   */
  readonly setupStatements?: readonly StatementDefinition[];
  /** Pre-registered statements the projection may use from apply(). */
  readonly statements: readonly StatementDefinition[];
  apply(event: PersistedDomainEvent<string, unknown>, tx: ProjectionTransaction): void;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ProjectionError extends Error {
  constructor(message: string) { super(message); this.name = "ProjectionError"; }
}

export class CursorAheadOfHeadError extends ProjectionError {
  constructor(name: string, cursor: number, head: number) {
    super(`Projection "${name}" cursor (${cursor}) ahead of head (${head}). Corruption.`);
  }
}

export class SchemaVersionMismatchError extends ProjectionError {
  constructor(name: string, expected: number, actual: number) {
    super(`Projection "${name}" schema mismatch: expected ${expected}, got ${actual}.`);
  }
}

export class ClassificationMismatchError extends ProjectionError {
  constructor(name: string, expected: string, actual: string) {
    super(`Projection "${name}" classification mismatch: expected ${expected}, got ${actual}.`);
  }
}

export class InlineProjectionInRunnerError extends ProjectionError {
  constructor(name: string) {
    super(`Projection "${name}" is classified inline; inline projections cannot use the replay runner.`);
  }
}

export class InvalidProjectionNameError extends ProjectionError {
  constructor(name: string) {
    super(`Invalid projection name: "${name}". Must match /^[a-z0-9_-]+$/i.`);
  }
}

export class UnregisteredStatementError extends ProjectionError {
  constructor(statementName: string) {
    super(`Unregistered statement: "${statementName}". Only pre-registered statements may be used.`);
  }
}

export class InactiveTransactionError extends ProjectionError {
  constructor() {
    super("Projection transaction is no longer active.");
  }
}

export class ReservedTableInStatementError extends ProjectionError {
  constructor(statementName: string, tableName: string) {
    super(`Statement "${statementName}" touches reserved table "${tableName}". Projections may not mutate reserved tables.`);
  }
}

// ---------------------------------------------------------------------------
// Reserved tables (projections may NOT touch these)
// ---------------------------------------------------------------------------

const RESERVED_TABLES = ["events", "projection_cursors", "workspace_metadata", "schema_migrations", "event_redactions"];
const RESERVED_TABLE_RE = new RegExp(`\\b(${RESERVED_TABLES.join("|")})\\b`, "i");
const PROJECTION_NAME_RE = /^[a-z0-9_-]+$/i;

// ---------------------------------------------------------------------------
// Implementation (module-internal)
// ---------------------------------------------------------------------------

/**
 * Create a constrained, lifetime-scoped ProjectionTransaction.
 *
 * The transaction:
 *   - Accepts only pre-registered statement names
 *   - Rejects all SQL touching reserved tables (checked at registration)
 *   - Is invalidated after apply() returns or throws (via a flag)
 */
function createTransaction(
  db: Database.Database,
  statements: Map<string, Database.Statement>,
): { tx: ProjectionTransaction; invalidate: () => void } {
  let active = true;

  return {
    tx: Object.freeze(Object.create(null, {
      exec: {
        value: (statementName: string, ...params: unknown[]) => {
          if (!active) throw new InactiveTransactionError();
          const stmt = statements.get(statementName);
          if (!stmt) throw new UnregisteredStatementError(statementName);
          return stmt.run(...params).changes;
        },
        enumerable: true,
      },
    })),
    invalidate: () => { active = false; },
  };
}

/** Validate statement definitions: reject SQL touching reserved tables. */
function validateStatements(statements: readonly StatementDefinition[]): void {
  const names = new Set<string>();
  for (const s of statements) {
    if (!s.name || names.has(s.name)) {
      throw new ProjectionError(`Projection statement names must be non-empty and unique: "${s.name}"`);
    }
    names.add(s.name);
    if (RESERVED_TABLE_RE.test(s.sql)) {
      const match = s.sql.match(RESERVED_TABLE_RE);
      throw new ReservedTableInStatementError(s.name, match?.[1] ?? "unknown");
    }
  }
}

/** Run static, idempotent setup statements before regular statement compile. */
function runSetupStatements(
  db: Database.Database,
  statements: readonly StatementDefinition[],
): void {
  validateStatements(statements);
  if (statements.length === 0) return;
  db.transaction(() => {
    for (const statement of statements) {
      db.prepare(statement.sql).run();
    }
  })();
}

/** Compile and cache statements. */
function compileStatements(
  db: Database.Database,
  statements: readonly StatementDefinition[],
): Map<string, Database.Statement> {
  validateStatements(statements);
  const map = new Map<string, Database.Statement>();
  for (const s of statements) {
    map.set(s.name, db.prepare(s.sql));
  }
  return map;
}

/**
 * Module-internal runner implementation. NOT exported. Only accessible via
 * the frozen facade returned by createProjectionRunner().
 */
class ProjectionRunnerImpl {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
    private readonly verifiedReads: (fromSeq: number, limit: number) => PersistedDomainEvent<string, unknown>[],
  ) {}

  getCursor(projectionName: string): ProjectionCursor {
    if (!PROJECTION_NAME_RE.test(projectionName)) throw new InvalidProjectionNameError(projectionName);
    const row = this.db.prepare(
      "SELECT last_applied_event_sequence, projection_schema_version, classification FROM projection_cursors WHERE projection_name = ?",
    ).get(projectionName) as
      | { last_applied_event_sequence: number; projection_schema_version: number; classification: string }
      | undefined;
    if (!row) {
      return { projectionName, lastAppliedEventSequence: 0, schemaVersion: 0, classification: "derived" };
    }
    return {
      projectionName,
      lastAppliedEventSequence: row.last_applied_event_sequence,
      schemaVersion: row.projection_schema_version,
      classification: row.classification as ProjectionClassification,
    };
  }

  catchUp(projection: ProjectionDefinition, limit = 1000): ProjectionCatchUpResult {
    if (!PROJECTION_NAME_RE.test(projection.name)) throw new InvalidProjectionNameError(projection.name);
    if (projection.classification === "inline") throw new InlineProjectionInRunnerError(projection.name);

    const cursor = this.getCursor(projection.name);

    // Schema version check
    if (cursor.schemaVersion !== 0 && cursor.schemaVersion !== projection.schemaVersion) {
      throw new SchemaVersionMismatchError(projection.name, projection.schemaVersion, cursor.schemaVersion);
    }

    // Classification check (if already registered)
    if (cursor.schemaVersion !== 0 && cursor.classification !== projection.classification) {
      throw new ClassificationMismatchError(projection.name, projection.classification, cursor.classification);
    }

    // Head check
    const headRow = this.db.prepare("SELECT MAX(sequence) as max_seq FROM events").get() as { max_seq: number | null } | undefined;
    const head = headRow?.max_seq ?? 0;
    if (cursor.lastAppliedEventSequence > head) {
      throw new CursorAheadOfHeadError(projection.name, cursor.lastAppliedEventSequence, head);
    }

    // Projection-owned tables/indexes are established before regular statements
    // are compiled so prepared writes may safely target them. Setup is static,
    // idempotent, and subject to the same reserved-table boundary.
    runSetupStatements(this.db, projection.setupStatements ?? []);

    // Get verified events (bound internally — no caller-supplied provider)
    const events = this.verifiedReads(cursor.lastAppliedEventSequence, limit);
    if (events.length === 0) {
      return { appliedCount: 0, newCursor: cursor, caught: true };
    }

    // Compile statements for this projection (cached internally)
    const statements = compileStatements(this.db, projection.statements);

    let applied = 0;
    let lastSeq = cursor.lastAppliedEventSequence;

    for (const event of events) {
      const seq = event.sequence;
      if (seq <= cursor.lastAppliedEventSequence) continue;

      this.db.transaction(() => {
        const { tx, invalidate } = createTransaction(this.db, statements);
        try {
          projection.apply(event, tx);
        } finally {
          invalidate();
        }

        this.db.prepare(
          `INSERT INTO projection_cursors (projection_name, last_applied_event_sequence, projection_schema_version, classification)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(projection_name) DO UPDATE SET
             last_applied_event_sequence = excluded.last_applied_event_sequence,
             projection_schema_version = excluded.projection_schema_version,
             classification = excluded.classification`,
        ).run(projection.name, seq, projection.schemaVersion, projection.classification);
      })();

      applied++;
      lastSeq = seq;
    }

    // Determine caught: cursor vs head (not batch size vs limit)
    const caught = lastSeq >= head;

    return {
      appliedCount: applied,
      newCursor: {
        projectionName: projection.name,
        lastAppliedEventSequence: lastSeq,
        schemaVersion: projection.schemaVersion,
        classification: projection.classification,
      },
      caught,
    };
  }
}

// ---------------------------------------------------------------------------
// Public facade type + factory
// ---------------------------------------------------------------------------

/** The public ProjectionRunner surface. No db, no constructor, no provider. */
export interface ProjectionRunner {
  getCursor(projectionName: string): ProjectionCursor;
  catchUp(projection: ProjectionDefinition, limit?: number): ProjectionCatchUpResult;
}

/**
 * Create a frozen, null-prototype ProjectionRunner facade.
 * The implementation class, database handle, and verified-reads function
 * are all captured in closures — inaccessible at runtime.
 */
export function createProjectionRunner(
  db: Database.Database,
  workspaceId: string,
  verifiedReads: (fromSeq: number, limit: number) => PersistedDomainEvent<string, unknown>[],
): ProjectionRunner {
  const impl = new ProjectionRunnerImpl(db, workspaceId, verifiedReads);
  return Object.freeze(Object.assign(Object.create(null), {
    getCursor: impl.getCursor.bind(impl),
    catchUp: impl.catchUp.bind(impl),
  }));
}
