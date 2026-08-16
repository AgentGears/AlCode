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

export interface ProjectionTransaction {
  exec(statementName: string, ...params: unknown[]): number;
}

export interface StatementDefinition {
  readonly name: string;
  readonly sql: string;
}

export interface ProjectionDefinition {
  readonly name: string;
  readonly schemaVersion: number;
  readonly classification: ProjectionClassification;
  /**
   * Optional idempotent, projection-owned setup statements. They run only when
   * the projection is first registered (cursor schemaVersion === 0), in the
   * same transaction that records schema/classification metadata. Existing
   * projections may omit this field; omission is handled explicitly.
   */
  readonly setupStatements?: readonly StatementDefinition[];
  readonly statements: readonly StatementDefinition[];
  apply(event: PersistedDomainEvent<string, unknown>, tx: ProjectionTransaction): void;
}

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

const RESERVED_TABLES = ["events", "projection_cursors", "workspace_metadata", "schema_migrations", "event_redactions"];
const RESERVED_TABLE_RE = new RegExp(`\\b(${RESERVED_TABLES.join("|")})\\b`, "i");
const PROJECTION_NAME_RE = /^[a-z0-9_-]+$/i;

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

function applySetupStatements(db: Database.Database, statements: readonly StatementDefinition[]): void {
  validateStatements(statements);
  for (const statement of statements) db.prepare(statement.sql).run();
}

function compileStatements(
  db: Database.Database,
  statements: readonly StatementDefinition[],
): Map<string, Database.Statement> {
  validateStatements(statements);
  const map = new Map<string, Database.Statement>();
  for (const s of statements) map.set(s.name, db.prepare(s.sql));
  return map;
}

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
    if (!row) return { projectionName, lastAppliedEventSequence: 0, schemaVersion: 0, classification: "derived" };
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

    let cursor = this.getCursor(projection.name);
    if (cursor.schemaVersion !== 0 && cursor.schemaVersion !== projection.schemaVersion) {
      throw new SchemaVersionMismatchError(projection.name, projection.schemaVersion, cursor.schemaVersion);
    }
    if (cursor.schemaVersion !== 0 && cursor.classification !== projection.classification) {
      throw new ClassificationMismatchError(projection.name, projection.classification, cursor.classification);
    }

    const headRow = this.db.prepare("SELECT MAX(sequence) as max_seq FROM events").get() as { max_seq: number | null } | undefined;
    const head = headRow?.max_seq ?? 0;
    if (cursor.lastAppliedEventSequence > head) {
      throw new CursorAheadOfHeadError(projection.name, cursor.lastAppliedEventSequence, head);
    }

    // `setupStatements` is optional for backward compatibility. Never iterate
    // an omitted value. When present, setup runs exactly on first registration,
    // atomically with the projection metadata row.
    const setup = projection.setupStatements;
    if (cursor.schemaVersion === 0 && setup !== undefined) {
      this.db.transaction(() => {
        applySetupStatements(this.db, setup);
        this.db.prepare(
          `INSERT INTO projection_cursors (
            projection_name, last_applied_event_sequence, projection_schema_version, classification
          ) VALUES (?, 0, ?, ?)`,
        ).run(projection.name, projection.schemaVersion, projection.classification);
      })();
      cursor = {
        projectionName: projection.name,
        lastAppliedEventSequence: 0,
        schemaVersion: projection.schemaVersion,
        classification: projection.classification,
      };
    }

    const events = this.verifiedReads(cursor.lastAppliedEventSequence, limit);
    for (const event of events) {
      if (String(event.workspaceId) !== this.workspaceId) {
        throw new ProjectionError(
          `Verified projection event Workspace ${String(event.workspaceId)} does not match runner Workspace ${this.workspaceId}`,
        );
      }
    }
    if (events.length === 0) return { appliedCount: 0, newCursor: cursor, caught: true };

    const statements = compileStatements(this.db, projection.statements);
    let applied = 0;
    let lastSeq = cursor.lastAppliedEventSequence;

    for (const event of events) {
      const seq = event.sequence;
      if (seq <= cursor.lastAppliedEventSequence) continue;
      this.db.transaction(() => {
        const { tx, invalidate } = createTransaction(this.db, statements);
        try { projection.apply(event, tx); } finally { invalidate(); }
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

export interface ProjectionRunner {
  getCursor(projectionName: string): ProjectionCursor;
  catchUp(projection: ProjectionDefinition, limit?: number): ProjectionCatchUpResult;
}

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
