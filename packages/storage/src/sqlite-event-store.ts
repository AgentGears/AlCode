// SQLite-backed EventStore. Implements the EventStore interface from
// @alcode/events against better-sqlite3.
//
// Contract (docs/event-contract.md):
//   - append assigns sequence + recordedAt + eventDigest in one transaction.
//   - Idempotent on eventId (re-append returns existing row).
//   - Idempotent on idempotencyKey (independently indexed).
//   - replay yields events in ascending sequence.
//
// Transaction model (ADR 0001):
//   - Events are appended in one BEGIN IMMEDIATE transaction.
//   - Projections are applied separately (not in the append txn).
//   - Each projection maintains its own cursor.

import type Database from "better-sqlite3";
import {
  type EventDraft,
  type PersistedDomainEvent,
} from "@alcode/events";
import {
  assertCanonical,
  canonicalStringify,
} from "@alcode/events";

/** Row shape in the events table. */
interface EventRow {
  event_id: string;
  idempotency_key: string | null;
  sequence: number;
  workspace_id: string;
  session_id: string;
  operation_id: string | null;
  type: string;
  payload: string;
  payload_schema_version: number;
  producer: string;
  causation_event_id: string | null;
  correlation_id: string | null;
  occurred_at: string;
  recorded_at: string;
  event_digest: string;
}

/** Convert a DB row to a PersistedDomainEvent. */
function rowToEvent(row: EventRow): PersistedDomainEvent<string, unknown> {
  const event: Record<string, unknown> = {
    eventId: row.event_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    occurredAt: row.occurred_at,
    type: row.type,
    payload: JSON.parse(row.payload),
    payloadSchemaVersion: row.payload_schema_version,
    producer: JSON.parse(row.producer),
    sequence: row.sequence,
    recordedAt: row.recorded_at,
    eventDigest: row.event_digest,
  };
  if (row.idempotency_key !== null) event.idempotencyKey = row.idempotency_key;
  if (row.operation_id !== null) event.operationId = row.operation_id;
  if (row.causation_event_id !== null) event.causationEventId = row.causation_event_id;
  if (row.correlation_id !== null) event.correlationId = row.correlation_id;
  return event as unknown as PersistedDomainEvent<string, unknown>;
}

/** Canonical form without the digest field (for digest computation). */
function serializeForDigest(draft: EventDraft, sequence: number, recordedAt: string): string {
  const withoutDigest: Record<string, unknown> = {
    eventId: draft.eventId,
    workspaceId: draft.workspaceId,
    sessionId: draft.sessionId,
    occurredAt: draft.occurredAt,
    type: draft.type,
    payload: draft.payload,
    payloadSchemaVersion: draft.payloadSchemaVersion,
    producer: draft.producer,
    sequence,
    recordedAt,
  };
  if (draft.idempotencyKey !== undefined) withoutDigest.idempotencyKey = draft.idempotencyKey;
  if (draft.operationId !== undefined) withoutDigest.operationId = draft.operationId;
  if (draft.causationEventId !== undefined) withoutDigest.causationEventId = draft.causationEventId;
  if (draft.correlationId !== undefined) withoutDigest.correlationId = draft.correlationId;
  return canonicalStringify(withoutDigest);
}

/**
 * SQLite-backed EventStore for a single workspace.
 *
 * One instance per workspace DB. The caller is responsible for lifecycle
 * (open/close). The store is NOT thread-safe — it relies on the single-writer
 * workspace lock (ADR 0002).
 */
export class SqliteEventStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Append drafts atomically. Returns persisted events with sequence,
   * recordedAt, and eventDigest assigned.
   *
   * Idempotent on eventId and idempotencyKey (independently indexed).
   */
  async append(
    drafts: readonly EventDraft<string, unknown>[],
  ): Promise<PersistedDomainEvent<string, unknown>[]> {
    const results: PersistedDomainEvent<string, unknown>[] = [];

    const txn = this.db.transaction(() => {
      for (const draft of drafts) {
        // Validate canonical-JSON-safety
        assertCanonical(draft.payload);
        assertCanonical(draft.producer);

        // Check eventId idempotency
        const existingById = this.db.prepare(
          "SELECT * FROM events WHERE event_id = ?",
        ).get(draft.eventId) as EventRow | undefined;
        if (existingById) {
          results.push(rowToEvent(existingById));
          continue;
        }

        // Check idempotencyKey idempotency
        if (draft.idempotencyKey) {
          const existingByKey = this.db.prepare(
            "SELECT * FROM events WHERE idempotency_key = ?",
          ).get(draft.idempotencyKey) as EventRow | undefined;
          if (existingByKey) {
            results.push(rowToEvent(existingByKey));
            continue;
          }
        }

        // Assign sequence (monotonic)
        const maxSeqRow = this.db.prepare(
          "SELECT MAX(sequence) as max_seq FROM events",
        ).get() as { max_seq: number | null } | undefined;
        const sequence = (maxSeqRow?.max_seq ?? 0) + 1;
        const recordedAt = new Date().toISOString();

        // Compute digest
        const canonicalWithoutDigest = serializeForDigest(draft, sequence, recordedAt);
        // Synchronous digest: use the canonical text directly with sha256
        const { createHash } = require("node:crypto") as { createHash: typeof import("node:crypto").createHash };
        const eventDigest = createHash("sha256").update(canonicalWithoutDigest).digest("hex");

        // Serialize producer for storage
        const producerJson = canonicalStringify(draft.producer);

        // Insert
        this.db.prepare(
          `INSERT INTO events (
            event_id, idempotency_key, sequence, workspace_id, session_id,
            operation_id, type, payload, payload_schema_version, producer,
            causation_event_id, correlation_id, occurred_at, recorded_at, event_digest
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          draft.eventId,
          draft.idempotencyKey ?? null,
          sequence,
          draft.workspaceId as string,
          draft.sessionId as string,
          draft.operationId ? (draft.operationId as string) : null,
          draft.type,
          canonicalStringify(draft.payload),
          draft.payloadSchemaVersion,
          producerJson,
          draft.causationEventId ? (draft.causationEventId as string) : null,
          draft.correlationId ?? null,
          draft.occurredAt,
          recordedAt,
          eventDigest,
        );

        // Read back to construct the persisted event
        const row = this.db.prepare(
          "SELECT * FROM events WHERE event_id = ?",
        ).get(draft.eventId) as EventRow;
        results.push(rowToEvent(row));
      }
    });

    txn();
    return results;
  }

  /** Yield events in ascending sequence, optionally bounded. */
  async *replay(
    fromSequence?: number,
    toSequence?: number,
  ): AsyncIterable<PersistedDomainEvent<string, unknown>> {
    const start = fromSequence === undefined ? 1 : fromSequence + 1;
    const end = toSequence === undefined ? Number.MAX_SAFE_INTEGER : toSequence;

    const stmt = this.db.prepare(
      "SELECT * FROM events WHERE sequence >= ? AND sequence <= ? ORDER BY sequence",
    );
    for (const row of stmt.iterate(start, end) as Iterable<EventRow>) {
      yield rowToEvent(row);
    }
  }

  /** The highest assigned sequence, or 0 if empty. */
  async headSequence(): Promise<number> {
    const row = this.db.prepare(
      "SELECT MAX(sequence) as max_seq FROM events",
    ).get() as { max_seq: number | null } | undefined;
    return row?.max_seq ?? 0;
  }

  /** Look up by eventId. */
  async get(eventId: string): Promise<PersistedDomainEvent<string, unknown> | undefined> {
    const row = this.db.prepare(
      "SELECT * FROM events WHERE event_id = ?",
    ).get(eventId) as EventRow | undefined;
    return row ? rowToEvent(row) : undefined;
  }

  // --- Projection cursor helpers (ADR 0001) ---

  /** Get a projection's cursor (last applied event sequence). 0 if never applied. */
  getCursor(projectionName: string): number {
    const row = this.db.prepare(
      "SELECT last_applied_event_sequence FROM projection_cursors WHERE projection_name = ?",
    ).get(projectionName) as { last_applied_event_sequence: number } | undefined;
    return row?.last_applied_event_sequence ?? 0;
  }

  /** Advance a projection's cursor. Call within the same txn as projection writes. */
  advanceCursor(projectionName: string, sequence: number, schemaVersion = 1): void {
    this.db.prepare(
      `INSERT INTO projection_cursors (projection_name, last_applied_event_sequence, projection_schema_version)
       VALUES (?, ?, ?)
       ON CONFLICT(projection_name) DO UPDATE SET
         last_applied_event_sequence = excluded.last_applied_event_sequence,
         projection_schema_version = excluded.projection_schema_version`,
    ).run(projectionName, sequence, schemaVersion);
  }

  /** Get events that a projection hasn't applied yet (sequence > cursor). */
  getUnappliedEvents(projectionName: string): EventRow[] {
    const cursor = this.getCursor(projectionName);
    return this.db.prepare(
      "SELECT * FROM events WHERE sequence > ? ORDER BY sequence",
    ).all(cursor) as EventRow[];
  }

  /** Execute a function within a transaction. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Close the underlying DB connection. */
  close(): void {
    this.db.close();
  }
}
