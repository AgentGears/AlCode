// Projection transaction model. See docs/adr/0001-event-and-projection-commit-semantics.md.
//
// The projection runner enforces ADR 0001's invariant: projection writes and
// cursor advancement commit atomically in the same SQLite transaction.
//
// Public API:
//   - ProjectionRunner.catchUp(projection, limit) — applies verified events
//     to a projection, advancing its cursor atomically.
//
// NOT exposed:
//   - Standalone advanceCursor (removed from WorkspaceEventStore)
//   - Generic transaction() (removed from WorkspaceEventStore)
//   - Raw better-sqlite3 handle

import type { PersistedDomainEvent } from "@alcode/events";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** A projection's classification (ADR 0001: three states). */
export type ProjectionClassification = "inline" | "critical" | "derived";

/** Cursor state for a projection. */
export interface ProjectionCursor {
  readonly projectionName: string;
  readonly lastAppliedEventSequence: number;
  readonly schemaVersion: number;
}

/** Result of a catchUp run. */
export interface ProjectionCatchUpResult {
  readonly appliedCount: number;
  readonly newCursor: ProjectionCursor;
  readonly caught: boolean; // true if no more unapplied events
}

/**
 * A constrained transaction context passed to ProjectionDefinition.apply().
 * Projections use this to write their state. The context is scoped to one
 * event and one transaction; the raw DB handle never escapes.
 */
export interface ProjectionTransaction {
  /**
   * Execute a SQL statement (INSERT/UPDATE/DELETE) within the projection's
   * transaction. Parameters are bound positionally.
   */
  exec(sql: string, ...params: unknown[]): void;

  /**
   * Query rows within the projection's transaction (SELECT).
   * Returns an array of row objects.
   */
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
}

/**
 * Definition of a projection. Projections are registered by name and
 * applied to verified events in sequence order.
 */
export interface ProjectionDefinition {
  /** Unique name (validated: [a-z0-9_-]+). */
  readonly name: string;
  /** Schema version for this projection's output tables. */
  readonly schemaVersion: number;
  /** Classification (persisted; not inferred from naming). */
  readonly classification: ProjectionClassification;
  /**
   * Apply one verified event to the projection. All writes via tx.
   * Throwing aborts the transaction — cursor does not advance.
   */
  apply(event: PersistedDomainEvent<string, unknown>, tx: ProjectionTransaction): void;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionError";
  }
}

export class CursorAheadOfHeadError extends ProjectionError {
  constructor(projectionName: string, cursor: number, head: number) {
    super(
      `Projection "${projectionName}" cursor (${cursor}) is ahead of event log head (${head}). ` +
      "This indicates corruption.",
    );
  }
}

export class SchemaVersionMismatchError extends ProjectionError {
  constructor(projectionName: string, expected: number, actual: number) {
    super(
      `Projection "${projectionName}" schema version mismatch: expected ${expected}, got ${actual}.`,
    );
  }
}

export class InvalidProjectionNameError extends ProjectionError {
  constructor(name: string) {
    super(`Invalid projection name: "${name}". Must match /^[a-z0-9_-]+$/i.`);
  }
}

// ---------------------------------------------------------------------------
// Implementation (module-internal)
// ---------------------------------------------------------------------------

const PROJECTION_NAME_RE = /^[a-z0-9_-]+$/i;

/**
 * The projection runner. Created internally by openLockedWorkspaceStore.
 * Enforces: verified reads, atomic cursor+writes, schema validation,
 * cursor-ahead detection, no escape hatches.
 */
export class ProjectionRunner {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaceId: string,
  ) {}

  /** Get the current cursor for a projection. */
  getCursor(projectionName: string): ProjectionCursor {
    this.validateName(projectionName);
    const row = this.db.prepare(
      "SELECT last_applied_event_sequence, projection_schema_version FROM projection_cursors WHERE projection_name = ?",
    ).get(projectionName) as
      | { last_applied_event_sequence: number; projection_schema_version: number }
      | undefined;
    if (!row) {
      return { projectionName, lastAppliedEventSequence: 0, schemaVersion: 0 };
    }
    return {
      projectionName,
      lastAppliedEventSequence: row.last_applied_event_sequence,
      schemaVersion: row.projection_schema_version,
    };
  }

  /**
   * Catch up a projection by applying verified events after its cursor.
   *
   * Invariants:
   *   - Events are integrity-verified (via the store's verified reads).
   *   - Cursor movement is strictly monotonic.
   *   - Cursor advances only to an event actually applied.
   *   - Projection writes and cursor advancement use the same SQLite transaction.
   *   - Failure during either stage rolls back both.
   *   - Duplicate application is safe (idempotent or PK-constrained).
   *   - Cursor ahead of head → fails closed.
   *   - Schema version mismatch → fails closed without mutations.
   */
  catchUp(
    projection: ProjectionDefinition,
    verifiedEventsProvider: (fromSeq: number, limit: number) => PersistedDomainEvent<string, unknown>[],
    limit = 1000,
  ): ProjectionCatchUpResult {
    this.validateName(projection.name);

    const cursor = this.getCursor(projection.name);

    // Schema version check
    if (cursor.schemaVersion !== 0 && cursor.schemaVersion !== projection.schemaVersion) {
      throw new SchemaVersionMismatchError(projection.name, projection.schemaVersion, cursor.schemaVersion);
    }

    // Get head sequence
    const headRow = this.db.prepare("SELECT MAX(sequence) as max_seq FROM events").get() as { max_seq: number | null } | undefined;
    const head = headRow?.max_seq ?? 0;

    // Cursor ahead of head → corruption
    if (cursor.lastAppliedEventSequence > head) {
      throw new CursorAheadOfHeadError(projection.name, cursor.lastAppliedEventSequence, head);
    }

    // Get verified events after cursor
    const events = verifiedEventsProvider(cursor.lastAppliedEventSequence, limit);
    if (events.length === 0) {
      return {
        appliedCount: 0,
        newCursor: cursor,
        caught: true,
      };
    }

    let applied = 0;
    let lastSeq = cursor.lastAppliedEventSequence;

    for (const event of events) {
      const seq = event.sequence;
      if (seq <= cursor.lastAppliedEventSequence) continue; // skip already-applied

      // One transaction per event: projection writes + cursor advance together
      this.db.transaction(() => {
        const tx: ProjectionTransaction = {
          exec: (sql: string, ...params: unknown[]) => {
            this.db.prepare(sql).run(...params);
          },
          query: <T = Record<string, unknown>>(sql: string, ...params: unknown[]) => {
            return this.db.prepare(sql).all(...params) as T[];
          },
        };

        projection.apply(event, tx);

        // Advance cursor (same transaction)
        this.db.prepare(
          `INSERT INTO projection_cursors (projection_name, last_applied_event_sequence, projection_schema_version)
           VALUES (?, ?, ?)
           ON CONFLICT(projection_name) DO UPDATE SET
             last_applied_event_sequence = excluded.last_applied_event_sequence,
             projection_schema_version = excluded.projection_schema_version`,
        ).run(projection.name, seq, projection.schemaVersion);
      })();

      applied++;
      lastSeq = seq;
    }

    // Check if more events remain
    const remaining = events.length === limit;

    return {
      appliedCount: applied,
      newCursor: {
        projectionName: projection.name,
        lastAppliedEventSequence: lastSeq,
        schemaVersion: projection.schemaVersion,
      },
      caught: !remaining,
    };
  }

  private validateName(name: string): void {
    if (!PROJECTION_NAME_RE.test(name)) {
      throw new InvalidProjectionNameError(name);
    }
  }
}
