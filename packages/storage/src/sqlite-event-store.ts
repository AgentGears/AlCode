// SQLite-backed EventStore with verified reads and a safe open entry point.
// See docs/event-contract.md and docs/adr/0001-event-and-projection-commit-semantics.md.

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  type EventDraft,
  type PersistedDomainEvent,
  type SessionId,
  type OperationId,
  mkEventId,
  asWorkspaceId,
  asSessionId,
  asOperationId,
  asProgramStateId,
} from "@alcode/events";
import { assertCanonical, canonicalStringify } from "@alcode/events";
import {
  initWorkspaceDb,
  bindWorkspace,
  WorkspaceMismatchError,
} from "./schema.ts";
import { createOperationsProjection } from "./operations.ts";
import type { AcquiredLock } from "@alcode/workspace";
import { SecretAdmissionGate, type SecretAdmissionConfig } from "@alcode/secrets";
import { createProjectionRunner, type ProjectionRunner as ProjectionRunnerType } from "./projection.ts";

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
// Program envelope normalization
// ---------------------------------------------------------------------------

/**
 * Preserve the Phase 1 omission contract exactly:
 * - no own property means the canonical key is absent;
 * - an own property with `undefined` is invalid, not equivalent to absence;
 * - a present value must be a UUIDv7 ProgramStateId.
 */
function programStateIdFromDraft(draft: EventDraft<string, unknown>): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(draft, "programStateId")) return undefined;
  if (draft.programStateId === undefined) {
    throw new TypeError("programStateId must be omitted or contain a UUIDv7; explicit undefined is not canonical");
  }
  return String(asProgramStateId(String(draft.programStateId)));
}

// ---------------------------------------------------------------------------
// Fingerprint computation
// ---------------------------------------------------------------------------

/** Compute the canonical request fingerprint (immutable content hash). */
export function computeRequestFingerprint(draft: EventDraft<string, unknown>): string {
  const programStateId = programStateIdFromDraft(draft);
  const fpInput: Record<string, unknown> = {
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
  // New optional envelope fields must preserve historical omission. Do not
  // serialize an absent ProgramStateId as null or undefined.
  if (programStateId !== undefined) fpInput.programStateId = programStateId;
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
  const programStateId = programStateIdFromDraft(draft);
  if (programStateId !== undefined) withoutDigest.programStateId = programStateId;
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
  program_state_id: string | null;
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

  let programStateId: string | undefined;
  if (row.program_state_id !== null) {
    try {
      programStateId = String(asProgramStateId(row.program_state_id));
    } catch {
      throw new EventIntegrityError(row.event_id, "programStateId", "UUIDv7", row.program_state_id);
    }
  }

  // Reconstruct the fingerprint input from the stored fields. A historical
  // NULL program_state_id means the key did not exist and must stay omitted.
  const fpInput: Record<string, unknown> = {
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
  if (programStateId !== undefined) fpInput.programStateId = programStateId;
  const recomputedFp = createHash("sha256").update(canonicalStringify(fpInput)).digest("hex");
  if (recomputedFp !== row.request_fingerprint) {
    throw new EventIntegrityError(row.event_id, "requestFingerprint", row.request_fingerprint, recomputedFp);
  }

  // Reconstruct the digest input with the same omission rule.
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
  if (programStateId !== undefined) digestInput.programStateId = programStateId;
  if (row.causation_event_id !== null) digestInput.causationEventId = row.causation_event_id;
  if (row.correlation_id !== null) digestInput.correlationId = row.correlation_id;

  const recomputedDigest = createHash("sha256").update(canonicalStringify(digestInput)).digest("hex");
  if (recomputedDigest !== row.event_digest) {
    throw new EventIntegrityError(row.event_id, "eventDigest", row.event_digest, recomputedDigest);
  }

  // Convert to PersistedDomainEvent, preserving historical omission rather
  // than materializing programStateId as null/undefined.
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
  if (programStateId !== undefined) event.programStateId = programStateId;
  if (row.causation_event_id !== null) event.causationEventId = row.causation_event_id;
  if (row.correlation_id !== null) event.correlationId = row.correlation_id;
  return event as unknown as PersistedDomainEvent<string, unknown>;
}

// ---------------------------------------------------------------------------
// Operational interface (public) + implementation class (module-internal)
// ---------------------------------------------------------------------------

/**
 * The operational surface of a workspace event store. Callers receive this
 * interface; they cannot construct it, access the database handle, or close
 * the database independently. Use openLockedWorkspaceStore() to obtain one.
 *
 * Projection cursor mutation and generic transactions are NOT exposed.
 * Use getProjectionRunner() to obtain a constrained ProjectionRunner that
 * enforces atomic cursor+writes.
 */
/** Result of the startup recovery pass. */
export interface InterruptedOperationRecovery {
  /** Operations newly marked indeterminate/pending during THIS recovery. */
  newlyMarked: number;
  /** ALL operations with reconciliation_status='pending' (newly + pre-existing). */
  pendingOperationIds: string[];
}

export interface WorkspaceEventStore {
  readonly workspaceId: string;
  append(drafts: readonly EventDraft<string, unknown>[]): Promise<PersistedDomainEvent<string, unknown>[]>;
  replay(fromSequence?: number, toSequence?: number): AsyncIterable<PersistedDomainEvent<string, unknown>>;
  get(eventId: string): Promise<PersistedDomainEvent<string, unknown> | undefined>;
  headSequence(): Promise<number>;
  /** Get verified events after a sequence number (for projection catch-up). */
  getVerifiedEvents(fromSeq: number, limit: number): PersistedDomainEvent<string, unknown>[];
  /** Obtain the projection runner for atomic projection updates. */
  getProjectionRunner(): ProjectionRunnerType;
  /**
   * Canonical startup recovery for interrupted operations. Catches up the
   * operations projection, scans for non-terminal rows still at
   * reconciliation_status='not_required', appends operation.interrupted
   * events for each (using the original sessionId/operationId), catches up
   * again, and returns all pending operations.
   *
   * This is event-sourced: deleting and rebuilding the operations projection
   * from events reproduces the interrupted state. No direct table mutation.
   */
  recoverInterruptedOperations(): Promise<InterruptedOperationRecovery>;
}

/**
 * Module-internal implementation. NOT exported. Only openLockedWorkspaceStore
 * can instantiate it. The database handle and closeDatabase() are not
 * accessible outside this module.
 */
class SqliteEventStoreImpl implements WorkspaceEventStore {
  private readonly db: Database.Database;
  readonly workspaceId: string;
  private readonly admissionGate: SecretAdmissionGate;

  constructor(db: Database.Database, workspaceId: string, admissionGate: SecretAdmissionGate) {
    this.db = db;
    this.workspaceId = workspaceId;
    this.admissionGate = admissionGate;
  }

  async append(
    drafts: readonly EventDraft<string, unknown>[],
  ): Promise<PersistedDomainEvent<string, unknown>[]> {
    // 1. Admit ALL drafts through the secret gate BEFORE any fingerprinting or SQL.
    //    This is structurally unavoidable — append() never passes an unexamined
    //    draft to the database. If any draft fails admission, the entire batch
    //    is rejected (no partial persistence).
    const admittedDrafts: EventDraft<string, unknown>[] = [];
    for (const draft of drafts) {
      const result = this.admissionGate.admitDraft(draft as unknown as Record<string, unknown>);
      admittedDrafts.push(result.value as unknown as EventDraft<string, unknown>);
    }

    // 2. Validate workspaceId + canonical safety on the admitted drafts.
    for (const draft of admittedDrafts) {
      const draftWs = typeof draft.workspaceId === "string" ? draft.workspaceId : String(draft.workspaceId);
      if (draftWs !== this.workspaceId) {
        throw new WorkspaceIdMismatchError(this.workspaceId, draftWs);
      }
      assertCanonical(draft.payload);
      assertCanonical(draft.producer);
      // Validate the optional field even before fingerprinting/SQL so malformed
      // or explicit-undefined values fail the whole batch without persistence.
      programStateIdFromDraft(draft);
    }

    const results: PersistedDomainEvent<string, unknown>[] = [];

    const txn = this.db.transaction(() => {
      for (const draft of admittedDrafts) {
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
        const programStateId = programStateIdFromDraft(draft);

        this.db.prepare(
          `INSERT INTO events (
            event_id, idempotency_key, sequence, workspace_id, session_id,
            operation_id, program_state_id, type, payload, payload_schema_version, producer,
            causation_event_id, correlation_id, occurred_at, recorded_at, event_digest,
            request_fingerprint
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          draft.eventId,
          draft.idempotencyKey ?? null,
          sequence,
          typeof draft.workspaceId === "string" ? draft.workspaceId : String(draft.workspaceId),
          typeof draft.sessionId === "string" ? draft.sessionId : String(draft.sessionId),
          draft.operationId ? String(draft.operationId) : null,
          programStateId ?? null,
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

  /** Get verified events after a sequence number (for projection catch-up). */
  getVerifiedEvents(fromSeq: number, limit: number): PersistedDomainEvent<string, unknown>[] {
    const rows = this.db.prepare(
      "SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?",
    ).all(fromSeq, limit) as EventRow[];
    return rows.map((row) => verifyEventRow(row, this.workspaceId));
  }

  /** Obtain the projection runner for atomic projection updates. */
  getProjectionRunner(): ProjectionRunnerType {
    return createProjectionRunner(this.db, this.workspaceId, this.getVerifiedEvents.bind(this));
  }

  /**
   * Canonical startup recovery for interrupted operations.
   *
   * 1. Catch up the operations projection so all existing events are applied.
   * 2. Scan for non-terminal rows still at reconciliation_status='not_required'.
   * 3. Append operation.interrupted events for each (using the original
   *    sessionId/operationId and a deterministic admission key
   *    operation.interrupted:<operationId>).
   * 4. Catch up again so the interrupted events are applied.
   * 5. Query ALL pending operations (newly + pre-existing).
   *
   * Event-sourced: deleting and rebuilding the operations projection from
   * events reproduces the interrupted state. No direct table mutation.
   */
  async recoverInterruptedOperations(): Promise<InterruptedOperationRecovery> {
    const workspaceId = asWorkspaceId(this.workspaceId);
    const operationsProjection = createOperationsProjection(this.workspaceId);
    const runner = this.getProjectionRunner();

    // 1. Catch up operations projection.
    runner.catchUp(operationsProjection);

    // 2. Scan for recovery candidates: non-terminal + not_required.
    const candidates = this.db.prepare(
      "SELECT operation_id, session_id FROM operations " +
      "WHERE lifecycle_state IN ('requested', 'started') " +
      "AND reconciliation_status = 'not_required'",
    ).all() as Array<{ operation_id: string; session_id: string }>;

    // 3. Append operation.interrupted events for each candidate.
    if (candidates.length > 0) {
      const drafts: EventDraft<string, unknown>[] = candidates.map((c) => ({
        eventId: mkEventId(),
        idempotencyKey: `operation.interrupted:${c.operation_id}`,
        workspaceId,
        sessionId: asSessionId(c.session_id),
        operationId: asOperationId(c.operation_id),
        occurredAt: new Date().toISOString(),
        type: "operation.interrupted",
        payload: { operationId: c.operation_id },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "recovery" },
      }));
      await this.append(drafts);

      // 4. Catch up so the interrupted events are applied.
      runner.catchUp(operationsProjection);
    }

    // 5. Query ALL pending operations (newly marked + pre-existing).
    const pendingRows = this.db.prepare(
      "SELECT operation_id FROM operations WHERE reconciliation_status = 'pending' ORDER BY started_at",
    ).all() as Array<{ operation_id: string }>;

    return {
      newlyMarked: candidates.length,
      pendingOperationIds: pendingRows.map((r) => r.operation_id),
    };
  }

  /** Module-internal: closes the database handle. Only callable from openLockedWorkspaceStore's close(). */
  closeDatabase(): void { this.db.close(); }
}

// ---------------------------------------------------------------------------
// Ordered close helper (module-internal — tested via injection)
// ---------------------------------------------------------------------------

/**
 * Create a close function that enforces ordering: closeDatabase() must
 * succeed before releaseLock() is called. If closeDatabase throws, the
 * lock is NOT released. Subsequent calls are idempotent once both steps
 * complete. If closeDatabase threw on a prior call, the close function
 * can be retried.
 *
 * State machine: "open" → "database-closed" → "closed".
 */
export function createOrderedClose(
  closeDatabase: () => void,
  releaseLock: () => void,
): () => void {
  let state: "open" | "database-closed" | "closed" = "open";

  return () => {
    if (state === "closed") return;

    if (state === "open") {
      closeDatabase(); // failure propagates; state stays "open", lock NOT released
      state = "database-closed";
    }

    releaseLock();
    state = "closed";
  };
}

// ---------------------------------------------------------------------------
// Safe entry point: openLockedWorkspaceStore
// ---------------------------------------------------------------------------

/** A runtime handle that owns the lock + DB + store as one lifecycle. */
export interface LockedWorkspaceStore {
  readonly store: WorkspaceEventStore;
  /** Close the database, then release the OS lock. Call on shutdown. */
  close(): void;
}

export interface OpenLockedWorkspaceStoreOptions {
  databasePath: string;
  lockPath: string;
  workspaceId: string;
  repositoryId: string;
  /** Configured secrets for the admission gate. */
  secretConfig?: SecretAdmissionConfig;
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

    // 5. Construct secret admission gate + implementation
    const admissionGate = new SecretAdmissionGate(opts.secretConfig ?? {});
    const impl = new SqliteEventStoreImpl(db, opts.workspaceId, admissionGate);

    // Build a frozen facade with null prototype so the implementation class
    // constructor cannot be recovered via rt.store.constructor.
    const store: WorkspaceEventStore = Object.assign(Object.create(null), {
      workspaceId: impl.workspaceId,
      append: impl.append.bind(impl),
      replay: impl.replay.bind(impl),
      get: impl.get.bind(impl),
      headSequence: impl.headSequence.bind(impl),
      getVerifiedEvents: impl.getVerifiedEvents.bind(impl),
      getProjectionRunner: impl.getProjectionRunner.bind(impl),
      recoverInterruptedOperations: impl.recoverInterruptedOperations.bind(impl),
    });
    Object.freeze(store);

    // 6. Lifecycle handle with ordered close (DB before lock)
    const close = createOrderedClose(
      () => impl.closeDatabase(),
      () => lock.release(),
    );

    return {
      store,
      close,
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
