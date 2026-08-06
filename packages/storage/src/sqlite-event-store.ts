// SQLite-backed EventStore with verified reads and a safe open entry point.
// See docs/event-contract.md and docs/adr/0001-event-and-projection-commit-semantics.md.

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  type EventDraft,
  type PersistedDomainEvent,
} from "@alcode/events";
import { assertCanonical, canonicalStringify } from "@alcode/events";
import {
  initWorkspaceDb,
  bindWorkspace,
  WorkspaceMismatchError,
} from "./schema.ts";
import type { AcquiredLock } from "@alcode/workspace";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** eventId reused with different immutable content. */
export class EventIdentityConflictError extends Error {
  constructor(eventId: string, existingFp: string, newFp: string) {
    super(`Event identity conflict: eventId ${eventId} exists with a different fingerprint.`);
    this.name = "EventIdentityConflictError";
  }
}

/** idempotencyKey reused with different operation intent. */
export class IdempotencyConflictError extends Error {
  constructor(key: string, existingFp: string, newFp: string) {
    super(`Idempotency conflict: key ${key} exists with a different fingerprint.`);
    this.name = "IdempotencyConflictError";
  }
}

/** Draft workspaceId doesn't match the bound workspace. */
export class WorkspaceIdMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`Draft workspaceId ${actual} does not match store workspaceId ${expected}.`);
    this.name = "WorkspaceIdMismatchError";
  }
}

/** A persisted event's recomputed digest or fingerprint doesn't match. */
export class EventIntegrityError extends Error {
  constructor(eventId: string, field: string, expected: string, actual: string) {
    super(`Event integrity violation: ${field} mismatch for event ${eventId}. Expected ${expected.slice(0, 16)}…, got ${actual.slice(0, 16)}….`);
    this.name = "EventIntegrityError";
  }
}

// ---------------------------------------------------------------------------
// Fingerprint computation
// ---------------------------------------------------------------------------

/** Compute the canonical request fingerprint (immutable content hash). */
export function computeRequestFingerprint(draft: EventDraft<string, unknown>): string {
  const fpInput = {
    workspaceId: String(draft.workspaceId),
    sessionId: String(draft.sessionId),
    operationId: draft.operationId ? String(draft.operationId) : null,
    type: draft.type,
    payload: draft.payload,
    payloadSchemaVersion: draft.payloadSchemaVersion,
    producer: draft.producer,
    causationEventId: draft.causationEventId ? String(draft.causationEventId) : null,
    correlationId: draft.correlationId ?? null,
    occurredAt: draft.occurredAt,
  };
  return createHash("sha256").update(canonicalStringify(fpInput)).digest("hex");
}

/** Compute the event digest (full persisted event, excluding the digest field). */
function computeEventDigest(
  draft: EventDraft<string, unknown>,
  sequence: number,
  recordedAt: string,
): string {
  // Stringify branded types to plain strings (they may be materialized as
  // objects by some transpilers). The DB stores plain strings; canonical
  // serialization must match between append-time and verify-time.
  const withoutDigest: Record<string, unknown> = {
    eventId: String(draft.eventId),
    workspaceId: String(draft.workspaceId),
    sessionId: String(draft.sessionId),
    occurredAt: draft.occurredAt,
    type: draft.type,
    payload: draft.payload,
    payloadSchemaVersion: draft.payloadSchemaVersion,
    producer: draft.producer,
    sequence,
    recordedAt,
  };
  if (draft.idempotencyKey !== undefined) withoutDigest.idempotencyKey = draft.idempotencyKey;
  if (draft.operationId !== undefined) withoutDigest.operationId = String(draft.operationId);
  if (draft.causationEventId !== undefined) withoutDigest.causationEventId = String(draft.causationEventId);
  if (draft.correlationId !== undefined) withoutDigest.correlationId = draft.correlationId;
  return createHash("sha256").update(canonicalStringify(withoutDigest)).digest("hex");
}

// ---------------------------------------------------------------------------
// Row → Event with integrity verification
// ---------------------------------------------------------------------------

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

/**
 * Verify a raw DB row and convert to a PersistedDomainEvent.
 * Recomputes both the eventDigest and requestFingerprint and throws
 * EventIntegrityError on any mismatch. Also verifies workspaceId.
 */
function verifyEventRow(row: EventRow, expectedWorkspaceId: string): PersistedDomainEvent<string, unknown> {
  // Verify workspaceId
  if (row.workspace_id !== expectedWorkspaceId) {
    throw new EventIntegrityError(row.event_id, "workspaceId", expectedWorkspaceId, row.workspace_id);
  }

  // Parse stored JSON fields, wrapping malformed JSON as EventIntegrityError
  let payloadParsed: unknown;
  let producerParsed: unknown;
  try {
    payloadParsed = JSON.parse(row.payload);
    producerParsed = JSON.parse(row.producer);
  } catch {
    throw new EventIntegrityError(row.event_id, "payloadOrProducer", "valid JSON", "malformed JSON");
  }

  // Reconstruct the fingerprint input from the stored fields
  const fpInput = {
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    operationId: row.operation_id ?? null,
    type: row.type,
    payload: payloadParsed,
    payloadSchemaVersion: row.payload_schema_version,
    producer: producerParsed,
    causationEventId: row.causation_event_id ?? null,
    correlationId: row.correlation_id ?? null,
    occurredAt: row.occurred_at,
  };
  const recomputedFp = createHash("sha256").update(canonicalStringify(fpInput)).digest("hex");
  if (recomputedFp !== row.request_fingerprint) {
    throw new EventIntegrityError(row.event_id, "requestFingerprint", row.request_fingerprint, recomputedFp);
  }

  // Reconstruct the digest input
  const digestInput: Record<string, unknown> = {
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
  };
  if (row.idempotency_key !== null) digestInput.idempotencyKey = row.idempotency_key;
  if (row.operation_id !== null) digestInput.operationId = row.operation_id;
  if (row.causation_event_id !== null) digestInput.causationEventId = row.causation_event_id;
  if (row.correlation_id !== null) digestInput.correlationId = row.correlation_id;

  const recomputedDigest = createHash("sha256").update(canonicalStringify(digestInput)).digest("hex");
  if (recomputedDigest !== row.event_digest) {
    throw new EventIntegrityError(row.event_id, "eventDigest", row.event_digest, recomputedDigest);
  }

  // Convert to PersistedDomainEvent
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

// ---------------------------------------------------------------------------
// SqliteEventStore
// ---------------------------------------------------------------------------

export class SqliteEventStore {
  readonly workspaceId: string;
  private readonly db: Database.Database;

  /** Module-internal constructor. Use openLockedWorkspaceStore() instead. */
  private constructor(db: Database.Database, workspaceId: string) {
    this.db = db;
    this.workspaceId = workspaceId;
  }

  /** Internal factory — only callable from openLockedWorkspaceStore. */
  static _create(db: Database.Database, workspaceId: string): SqliteEventStore {
    return new SqliteEventStore(db, workspaceId);
  }

  async append(
    drafts: readonly EventDraft<string, unknown>[],
  ): Promise<PersistedDomainEvent<string, unknown>[]> {
    for (const draft of drafts) {
      const draftWs = typeof draft.workspaceId === "string" ? draft.workspaceId : String(draft.workspaceId);
      if (draftWs !== this.workspaceId) {
        throw new WorkspaceIdMismatchError(this.workspaceId, draftWs);
      }
      assertCanonical(draft.payload);
      assertCanonical(draft.producer);
    }

    const results: PersistedDomainEvent<string, unknown>[] = [];

    const txn = this.db.transaction(() => {
      for (const draft of drafts) {
        const fingerprint = computeRequestFingerprint(draft);

        // eventId idempotency + conflict
        const existingById = this.db.prepare(
          "SELECT * FROM events WHERE event_id = ?",
        ).get(draft.eventId) as EventRow | undefined;

        if (existingById) {
          if (existingById.request_fingerprint !== fingerprint) {
            throw new EventIdentityConflictError(draft.eventId, existingById.request_fingerprint, fingerprint);
          }
          // Also verify idempotencyKey matches — same eventId with a different
          // idempotencyKey is a conflict even if the fingerprint is the same.
          const existingKey = existingById.idempotency_key;
          const draftKey = draft.idempotencyKey ?? null;
          if (existingKey !== draftKey) {
            throw new EventIdentityConflictError(
              draft.eventId,
              existingKey ?? "null",
              draftKey ?? "null",
            );
          }
          results.push(verifyEventRow(existingById, this.workspaceId));
          continue;
        }

        // idempotencyKey idempotency + conflict
        if (draft.idempotencyKey) {
          const existingByKey = this.db.prepare(
            "SELECT * FROM events WHERE idempotency_key = ?",
          ).get(draft.idempotencyKey) as EventRow | undefined;

          if (existingByKey) {
            if (existingByKey.request_fingerprint !== fingerprint) {
              throw new IdempotencyConflictError(draft.idempotencyKey, existingByKey.request_fingerprint, fingerprint);
            }
            results.push(verifyEventRow(existingByKey, this.workspaceId));
            continue;
          }
        }

        // Assign sequence, compute digest
        const maxSeqRow = this.db.prepare(
          "SELECT MAX(sequence) as max_seq FROM events",
        ).get() as { max_seq: number | null } | undefined;
        const sequence = (maxSeqRow?.max_seq ?? 0) + 1;
        const recordedAt = new Date().toISOString();
        const eventDigest = computeEventDigest(draft, sequence, recordedAt);

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
          typeof draft.workspaceId === "string" ? draft.workspaceId : String(draft.workspaceId),
          typeof draft.sessionId === "string" ? draft.sessionId : String(draft.sessionId),
          draft.operationId ? String(draft.operationId) : null,
          draft.type,
          canonicalStringify(draft.payload),
          draft.payloadSchemaVersion,
          canonicalStringify(draft.producer),
          draft.causationEventId ? String(draft.causationEventId) : null,
          draft.correlationId ?? null,
          draft.occurredAt,
          recordedAt,
          eventDigest,
          fingerprint,
        );

        const row = this.db.prepare("SELECT * FROM events WHERE event_id = ?").get(draft.eventId) as EventRow;
        results.push(verifyEventRow(row, this.workspaceId));
      }
    });

    txn();
    return results;
  }

  async *replay(fromSequence?: number, toSequence?: number): AsyncIterable<PersistedDomainEvent<string, unknown>> {
    const start = fromSequence === undefined ? 1 : fromSequence + 1;
    const end = toSequence === undefined ? Number.MAX_SAFE_INTEGER : toSequence;
    for (const row of this.db.prepare(
      "SELECT * FROM events WHERE sequence >= ? AND sequence <= ? ORDER BY sequence",
    ).iterate(start, end) as Iterable<EventRow>) {
      yield verifyEventRow(row, this.workspaceId);
    }
  }

  async headSequence(): Promise<number> {
    const row = this.db.prepare("SELECT MAX(sequence) as max_seq FROM events").get() as { max_seq: number | null } | undefined;
    return row?.max_seq ?? 0;
  }

  async get(eventId: string): Promise<PersistedDomainEvent<string, unknown> | undefined> {
    const row = this.db.prepare("SELECT * FROM events WHERE event_id = ?").get(eventId) as EventRow | undefined;
    return row ? verifyEventRow(row, this.workspaceId) : undefined;
  }

  // --- Projection cursor helpers ---
  getCursor(name: string): number {
    const row = this.db.prepare("SELECT last_applied_event_sequence FROM projection_cursors WHERE projection_name = ?").get(name) as { last_applied_event_sequence: number } | undefined;
    return row?.last_applied_event_sequence ?? 0;
  }
  advanceCursor(name: string, seq: number, sv = 1): void {
    this.db.prepare(
      `INSERT INTO projection_cursors (projection_name, last_applied_event_sequence, projection_schema_version) VALUES (?, ?, ?)
       ON CONFLICT(projection_name) DO UPDATE SET last_applied_event_sequence = excluded.last_applied_event_sequence, projection_schema_version = excluded.projection_schema_version`,
    ).run(name, seq, sv);
  }
  getUnappliedEvents(name: string): PersistedDomainEvent<string, unknown>[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE sequence > ? ORDER BY sequence").all(this.getCursor(name)) as EventRow[];
    return rows.map((row) => verifyEventRow(row, this.workspaceId));
  }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }
  close(): void { this.db.close(); }
}

// ---------------------------------------------------------------------------
// Safe entry point: openLockedWorkspaceStore
// ---------------------------------------------------------------------------

/** A runtime handle that owns the lock + DB + store as one lifecycle. */
export interface LockedWorkspaceStore {
  readonly store: SqliteEventStore;
  /** Close the database, then release the OS lock. Call on shutdown. */
  close(): void;
}

export interface OpenLockedWorkspaceStoreOptions {
  databasePath: string;
  lockPath: string;
  workspaceId: string;
  repositoryId: string;
}

/**
 * The single safe way to open a writable EventStore.
 *
 * Lifecycle (enforced ordering):
 *   1. Acquire the OS workspace lock (flock on POSIX, fail-closed on Windows).
 *   2. Open SQLite (WAL, foreign keys, busy_timeout).
 *   3. Run migrations (initWorkspaceDb).
 *   4. Bind and verify workspace + repository identity (bindWorkspace).
 *   5. Construct the store (private constructor — only callable here).
 *
 * On any failure: close the DB if opened, release the lock, rethrow.
 * The returned handle closes the DB before releasing the lock on shutdown.
 *
 * It is impossible to construct a writable store without first proving
 * single-writer ownership and passing identity verification.
 */
export async function openLockedWorkspaceStore(
  opts: OpenLockedWorkspaceStoreOptions,
): Promise<LockedWorkspaceStore> {
  // 1. Acquire lock
  const { acquireWorkspaceLock } = await import("@alcode/workspace");
  let lock: AcquiredLock;
  try {
    lock = acquireWorkspaceLock(opts.lockPath);
  } catch (e) {
    throw e; // Lock failure — nothing to clean up
  }

  // 2. Open SQLite
  let db: Database.Database | undefined;
  try {
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    db = new Database(opts.databasePath);

    // 3. Migrate
    initWorkspaceDb(db);

    // 4. Bind + verify identity
    bindWorkspace(db, opts.workspaceId, opts.repositoryId);

    // 5. Construct store (private constructor via internal factory)
    const store = SqliteEventStore._create(db, opts.workspaceId);

    return {
      store,
      close() {
        try { store.close(); } catch { /* already closed */ }
        lock.release();
      },
    };
  } catch (e) {
    // Cleanup on failure: close DB if opened, release lock, rethrow
    if (db) {
      try { db.close(); } catch { /* already closed */ }
    }
    lock.release();
    throw e;
  }
}
