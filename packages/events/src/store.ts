// Event store interface — the append/replay contract from
// docs/event-contract.md §"Append and replay contract".
//
// Phase 0.0 ships only this interface and an in-memory implementation for
// tests. The SQLite-backed implementation arrives in Phase 0.2 (it is gated
// on workspace resolution and the OS lock from ADR 0002, which belong to 0.2).

import type { PersistedDomainEvent, EventDraft } from "./envelope.ts";

/**
 * Append-only event log keyed by workspace.
 *
 * Contract:
 *   - `append` assigns `sequence` (monotonic per workspace) and `recordedAt`,
 *     computes `eventDigest`, persists in one transaction, and returns the
 *     assigned events.
 *   - `append` is idempotent on `eventId`: re-appending an event whose
 *     `eventId` already exists is a no-op (returns the existing row).
 *   - `append` is idempotent on `idempotencyKey`: an appended event whose key
 *     is already present is a no-op (returns the existing row). `eventId` and
 *     `idempotencyKey` are independently indexed.
 *   - `replay` yields events in ascending `sequence`.
 */
export interface EventStore {
  /**
   * Append drafts. Returns the persisted form (with `sequence`, `recordedAt`,
   * `eventDigest` assigned). The drafts' payloads must be canonical-JSON-safe;
   * the store rejects (throws) on unsafe values.
   */
  append(
    events: readonly EventDraft<string, unknown>[],
  ): Promise<PersistedDomainEvent<string, unknown>[]>;

  /**
   * Yield events with `sequence > fromSequence` (inclusive of `fromSequence`
   * when undefined → all events) and `sequence <= toSequence` (when defined),
   * in ascending order.
   */
  replay(
    fromSequence?: number,
    toSequence?: number,
  ): AsyncIterable<PersistedDomainEvent<string, unknown>>;

  /** The highest assigned sequence, or 0 if empty. Used by projection cursors. */
  headSequence(): Promise<number>;

  /** Look up an event by id (returns undefined if not present). */
  get(eventId: string): Promise<PersistedDomainEvent<string, unknown> | undefined>;
}

/**
 * Result of attempting to append a single draft. Used by callers that want
 * to know whether an event was newly written or was an idempotent no-op.
 */
export type AppendResult =
  | { status: "appended"; event: PersistedDomainEvent<string, unknown> }
  | { status: "deduplicated"; event: PersistedDomainEvent<string, unknown> };
