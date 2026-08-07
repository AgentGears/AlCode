// Sessions projection — derived. Materializes runtime.session.started/stopped
// events into the existing sessions table (no schema migration required).
//
// Classification is 'derived', not 'critical'. ADR 0001 reserves 'critical'
// for projections that must be caught up before an operation is reported
// complete. The sessions projection deliberately lags across user messages,
// assistant messages, and operation events — it only catches up at its own
// lifecycle boundaries (startDurableSession / stopDurableSession), where the
// session row is synchronously materialized.
//
// The sessions table (session_id PRIMARY KEY) makes a duplicate
// runtime.session.started fail at the SQL layer. This is defense in depth —
// the primary duplicate guard is the idempotencyKey on the lifecycle event
// (see session-lifecycle.ts), which rejects a second attempt before the
// event enters the canonical log. runtime.session.stopped requires exactly
// one row updated (the session exists and is not yet stopped); a zero-row
// transition throws SessionStateError.
//
// See docs/phase-0-spec.md §0.2 Step 9 and docs/event-contract.md.

import type { PersistedDomainEvent } from "@alcode/events";
import type {
  ProjectionDefinition,
  ProjectionTransaction,
  StatementDefinition,
} from "@alcode/storage";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A session lifecycle event violated the state machine. */
export class SessionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionStateError";
  }
}

// ---------------------------------------------------------------------------
// Event payload types (owned by the runtime/session domain)
// ---------------------------------------------------------------------------

/** Payload for runtime.session.started. */
export interface SessionStartedPayload {
  sessionId: string;
}

/** Payload for runtime.session.stopped. */
export interface SessionStoppedPayload {
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Registered statements
// ---------------------------------------------------------------------------

export const sessionStatements: readonly StatementDefinition[] = [
  {
    name: "insert-session",
    sql: `INSERT INTO sessions (session_id, workspace_id, started_at, stopped_at)
      VALUES (?, ?, ?, NULL)`,
  },
  {
    name: "update-session-stopped",
    sql: `UPDATE sessions SET stopped_at = ?
      WHERE session_id = ? AND stopped_at IS NULL`,
  },
];

// ---------------------------------------------------------------------------
// Projection definition
// ---------------------------------------------------------------------------

/**
 * The sessions projection. Classified 'derived' — it catches up at its own
 * lifecycle boundaries, not on every operation.
 *
 * Handles two event types:
 *   runtime.session.started → INSERT (PK fails closed on duplicate session_id)
 *   runtime.session.stopped → UPDATE stopped_at (requires exactly 1 row)
 *
 * Other event types are ignored (the apply() default no-ops).
 */
export function createSessionsProjection(workspaceId: string): ProjectionDefinition {
  return {
    name: "sessions",
    schemaVersion: 1,
    classification: "derived",
    statements: sessionStatements,
    apply(event: PersistedDomainEvent<string, unknown>, tx: ProjectionTransaction): void {
      const occurredAt = event.occurredAt;

      switch (event.type) {
        case "runtime.session.started": {
          const p = event.payload as SessionStartedPayload;
          tx.exec(
            "insert-session",
            p.sessionId,
            workspaceId,
            occurredAt,
          );
          break;
        }

        case "runtime.session.stopped": {
          const p = event.payload as SessionStoppedPayload;
          const changes = tx.exec("update-session-stopped", occurredAt, p.sessionId);
          if (changes !== 1) {
            throw new SessionStateError(
              `runtime.session.stopped for ${p.sessionId}: expected 1 row updated, got ${changes}. ` +
              "Session may not exist or may already be stopped.",
            );
          }
          break;
        }

        default:
          // Other event types are ignored by this projection.
          break;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Query helpers (read-only — for tests and later session inspection)
// ---------------------------------------------------------------------------

/** A durable session record as stored in the sessions table. */
export interface SessionRecord {
  sessionId: string;
  workspaceId: string;
  startedAt: string;
  stoppedAt: string | null;
}

/**
 * Read-only query interface for session rows. Backed by a better-sqlite3
 * Database; never mutates sessions.
 */
export function createSessionQuery(db: import("better-sqlite3").Database) {
  function rowToRecord(row: Record<string, unknown>): SessionRecord {
    return {
      sessionId: row.session_id as string,
      workspaceId: row.workspace_id as string,
      startedAt: row.started_at as string,
      stoppedAt: (row.stopped_at as string | null) ?? null,
    };
  }

  return {
    getById(sessionId: string): SessionRecord | undefined {
      const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId);
      return row ? rowToRecord(row as Record<string, unknown>) : undefined;
    },
    getAll(): SessionRecord[] {
      const rows = db.prepare("SELECT * FROM sessions ORDER BY started_at").all();
      return (rows as Record<string, unknown>[]).map(rowToRecord);
    },
    getActive(): SessionRecord[] {
      const rows = db.prepare("SELECT * FROM sessions WHERE stopped_at IS NULL ORDER BY started_at").all();
      return (rows as Record<string, unknown>[]).map(rowToRecord);
    },
  };
}
