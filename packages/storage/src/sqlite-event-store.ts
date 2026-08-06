// SQLite-backed EventStore. Implements the EventStore interface from
// @alcode/events against better-sqlite3.
//
// Contract (docs/event-contract.md):
//   - append assigns sequence + recordedAt + eventDigest in one transaction.
//   - Idempotent on eventId: same eventId + equivalent draft → return existing.
//                        same eventId + different draft → throw EventIdentityConflictError.
//   - Idempotent on idempotencyKey: same key + equivalent intent → return existing.
//                                 same key + different intent → throw IdempotencyConflictError.
//   - replay yields events in ascending sequence.
//
// The database is bound to exactly one workspaceId. Every draft must match.
// The store rejects drafts whose workspaceId differs from the bound identity.
//
// Transaction model (ADR 0001):
//   - Events are appended in one BEGIN IMMEDIATE transaction.
//   - Projections are applied separately (not in the append txn).
//   - Each projection maintains its own cursor.

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  type EventDraft,
  type PersistedDomainEvent,
} from "@alcode/events";
import { assertCanonical, canonicalStringify } from "@alcode/events";

const require = createRequire(import.meta.url);

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
  request_fingerprint: string;
}

/** Error: eventId reused with different immutable content. */
export class EventIdentityConflictError extends Error {
  constructor(
    public readonly eventId: string,
    public readonly existingFingerprint: string,
    public readonly newFingerprint: string,
  ) {
    super(
      `Event identity conflict: eventId ${eventId} exists with a different request fingerprint. ` +
      "The same eventId cannot be reused for different content.",
    );
    this.name = "EventIdentityConflictError";
  }
}

/** Error: idempotencyKey reused with different operation intent. */
export class IdempotencyConflictError extends Error {
  constructor(
    public readonly idempotencyKey: string,
    public readonly existingFingerprint: string,
    public readonly newFingerprint: string,
  ) {
    super(
      `Idempotency conflict: key ${idempotencyKey} exists with a different request fingerprint. ` +
      "The same key cannot be reused for a different operation intent.",
    );
    this.name = "IdempotencyConflictError";
  }
}

/** Error: draft workspaceId doesn't match the bound workspace. */
export class WorkspaceIdMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `Draft workspaceId ${actual} does not match store workspaceId ${expected}. ` +
      "Events can only be appended to their owning workspace.",
    );
    this.name = "WorkspaceIdMismatchError";
  }
}

/**
 * Compute a canonical request fingerprint for a draft. This is the immutable
 * content of the event — everything the caller controls, excluding append-
 * assigned fields (sequence, recordedAt, eventDigest).
 *
 * Used for conflict detection: if the same eventId or idempotencyKey is reused
 * but the fingerprint differs, that's a conflict, not an idempotent retry.
 */
export function computeRequestFingerprint(draft: EventDraft<string, unknown>): string {
  const fingerprintInput = {
    workspaceId: draft.workspaceId,
    sessionId: draft.sessionId,
    operationId: draft.operationId ?? null,
    type: draft.type,
    payload: draft.payload,
    payloadSchemaVersion: draft.payloadSchemaVersion,
    producer: draft.producer,
    causationEventId: draft.causationEventId ?? null,
    correlationId: draft.correlationId ?? null,
    occurredAt: draft.occurredAt,
  };
  const canonical = canonicalStringify(fingerprintInput);
  return createHash("sha256").update(canonical).digest("hex");
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

/**
 * SQLite-backed EventStore for a single workspace.
 *
 * One instance per workspace DB. The database is bound to exactly one
 * workspaceId. The caller is responsible for lifecycle (open/close).
 * The store relies on the single-writer workspace lock (ADR 0002).
 */
export class SqliteEventStore {
  private readonly db: Database.Database;
  private readonly workspaceId: string;

  /**
   * @param db               An open better-sqlite3 Database handle.
   * @param expectedWorkspaceId The workspaceId this store is bound to.
   *                             Must match the workspace_metadata row.
   */
  constructor(db: Database.Database, expectedWorkspaceId: string) {
    this.db = db;
    this.workspaceId = expectedWorkspaceId;
  }

  /**
   * Append drafts atomically. Returns persisted events with sequence,
   * recordedAt, and eventDigest assigned.
   *
   * Conflict semantics:
   *   - Same eventId, same fingerprint → return existing (idempotent).
   *   - Same eventId, different fingerprint → throw EventIdentityConflictError.
   *   - Same idempotencyKey, same fingerprint → return existing (idempotent).
   *   - Same idempotencyKey, different fingerprint → throw IdempotencyConflictError.
   *
   * @throws WorkspaceIdMismatchError if any draft's workspaceId differs.
   * @throws EventIdentityConflictError on conflicting eventId reuse.
   * @throws IdempotencyConflictError on conflicting idempotencyKey reuse.
   */
  async append(
    drafts: readonly EventDraft<string, unknown>[],
  ): Promise<PersistedDomainEvent<string, unknown>[]> {
    // Pre-validate workspaceId and canonical safety before the transaction.
    for (const draft of drafts) {
      const draftWsId = typeof draft.workspaceId === "string" ? draft.workspaceId : String(draft.workspaceId);
      if (draftWsId !== this.workspaceId) {
        throw new WorkspaceIdMismatchError(this.workspaceId, draftWsId);
      }
      assertCanonical(draft.payload);
      assertCanonical(draft.producer);
    }

    const results: PersistedDomainEvent<string, unknown>[] = [];

    const txn = this.db.transaction(() => {
      for (const draft of drafts) {
        const fingerprint = computeRequestFingerprint(draft);

        // Check eventId idempotency
        const existingById = this.db.prepare(
          "SELECT * FROM events WHERE event_id = ?",
        ).get(draft.eventId) as EventRow | undefined;

        if (existingById) {
          if (existingById.request_fingerprint !== fingerprint) {
            throw new EventIdentityConflictError(
              draft.eventId,
              existingById.request_fingerprint,
              fingerprint,
            );
          }
          results.push(rowToEvent(existingById));
          continue;
        }

        // Check idempotencyKey idempotency
        if (draft.idempotencyKey) {
          const existingByKey = this.db.prepare(
            "SELECT * FROM events WHERE idempotency_key = ?",
          ).get(draft.idempotencyKey) as EventRow | undefined;

          if (existingByKey) {
            if (existingByKey.request_fingerprint !== fingerprint) {
              throw new IdempotencyConflictError(
                draft.idempotencyKey,
                existingByKey.request_fingerprint,
                fingerprint,
              );
            }
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

        // Compute eventDigest over the canonical form without the digest field.
        const canonicalWithoutDigest = serializeForDigest(draft, sequence, recordedAt);
        const eventDigest = createHash("sha256").update(canonicalWithoutDigest).digest("hex");

        // Serialize for storage
        const producerJson = canonicalStringify(draft.producer);

        // Insert
        this.db.prepare(
          `INSERT INTO events (
            event_id, idempotency_key, sequence, workspace_id, session_id,
            operation_id, type, payload, payload_schema_version, producer,
            causation_event_id, correlation_id, occurred_at, recorded_at, event_digest,
            request_fingerprint
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          fingerprint,
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

  getCursor(projectionName: string): number {
    const row = this.db.prepare(
      "SELECT last_applied_event_sequence FROM projection_cursors WHERE projection_name = ?",
    ).get(projectionName) as { last_applied_event_sequence: number } | undefined;
    return row?.last_applied_event_sequence ?? 0;
  }

  advanceCursor(projectionName: string, sequence: number, schemaVersion = 1): void {
    this.db.prepare(
      `INSERT INTO projection_cursors (projection_name, last_applied_event_sequence, projection_schema_version)
       VALUES (?, ?, ?)
       ON CONFLICT(projection_name) DO UPDATE SET
         last_applied_event_sequence = excluded.last_applied_event_sequence,
         projection_schema_version = excluded.projection_schema_version`,
    ).run(projectionName, sequence, schemaVersion);
  }

  getUnappliedEvents(projectionName: string): EventRow[] {
    const cursor = this.getCursor(projectionName);
    return this.db.prepare(
      "SELECT * FROM events WHERE sequence > ? ORDER BY sequence",
    ).all(cursor) as EventRow[];
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}

/** Canonical form without the digest field (for digest computation). */
function serializeForDigest(draft: EventDraft<string, unknown>, sequence: number, recordedAt: string): string {
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
