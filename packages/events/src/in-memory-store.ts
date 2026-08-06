// In-memory EventStore implementation. Used for Phase 0.0 tests and the gate
// runner; the SQLite-backed store arrives in Phase 0.2 (gated on workspace
// resolution + the OS lock from ADR 0002).

import type { EventDraft } from "./envelope.ts";
import type { PersistedDomainEvent } from "./envelope.ts";
import type { EventStore } from "./store.ts";
import { assertCanonical, canonicalStringify, sha256Canonical, sha256CanonicalText } from "./serialize.ts";

interface StoredRow {
  event: PersistedDomainEvent<string, unknown>;
  /** Canonical JSON of the event sans `eventDigest`, used for digest compute. */
  canonicalWithoutDigest: string;
}

export class InMemoryEventStore implements EventStore {
  private readonly rows: StoredRow[] = [];
  private readonly byEventId = new Map<string, StoredRow>();
  private readonly byIdempotencyKey = new Map<string, StoredRow>();

  async append(
    drafts: readonly EventDraft<string, unknown>[],
  ): Promise<PersistedDomainEvent<string, unknown>[]> {
    const out: PersistedDomainEvent<string, unknown>[] = [];

    for (const draft of drafts) {
      // Validate canonical-JSON-safety before any mutation.
      assertCanonical(draft.payload);

      // Idempotency on eventId.
      const existingById = this.byEventId.get(draft.eventId);
      if (existingById !== undefined) {
        out.push(existingById.event);
        continue;
      }

      // Idempotency on idempotencyKey (independently indexed).
      if (draft.idempotencyKey !== undefined) {
        const existingByKey = this.byIdempotencyKey.get(draft.idempotencyKey);
        if (existingByKey !== undefined) {
          out.push(existingByKey.event);
          continue;
        }
      }

      const sequence = this.rows.length + 1;
      const recordedAt = new Date().toISOString();

      // Compute eventDigest over the canonical JSON of the persisted event,
      // excluding `eventDigest`. We serialize without it and hash the result.
      const persistedWithoutDigest: Omit<PersistedDomainEvent, "eventDigest"> = {
        ...draft,
        sequence,
        recordedAt,
      };
      const canonicalWithoutDigest = canonicalStringify(
        persistedWithoutDigest as unknown,
      );
      const eventDigest = await sha256Canonical(persistedWithoutDigest);

      const event: PersistedDomainEvent<string, unknown> = {
        ...(draft as EventDraft<string, unknown>),
        sequence,
        recordedAt,
        eventDigest,
      };
      const row: StoredRow = { event, canonicalWithoutDigest };
      this.rows.push(row);
      this.byEventId.set(draft.eventId, row);
      if (draft.idempotencyKey !== undefined) {
        this.byIdempotencyKey.set(draft.idempotencyKey, row);
      }
      out.push(event);
    }

    return out;
  }

  async *replay(
    fromSequence?: number,
    toSequence?: number,
  ): AsyncIterable<PersistedDomainEvent<string, unknown>> {
    const start = fromSequence === undefined ? 1 : fromSequence + 1;
    const end = toSequence === undefined ? Number.POSITIVE_INFINITY : toSequence;
    for (const row of this.rows) {
      if (row.event.sequence < start) continue;
      if (row.event.sequence > end) break;
      yield row.event;
    }
  }

  async headSequence(): Promise<number> {
    return this.rows.length;
  }

  async get(
    eventId: string,
  ): Promise<PersistedDomainEvent<string, unknown> | undefined> {
    return this.byEventId.get(eventId)?.event;
  }

  /**
   * Test-only helper: verify a row's stored digest still matches its content.
   * The canonical-without-digest text is stored at append time so we can
   * re-hash exactly what `append` hashed (avoiding any reconstruction that
   * would re-introduce or omit fields).
   */
  async verifyDigest(eventId: string): Promise<boolean> {
    const row = this.byEventId.get(eventId);
    if (row === undefined) return false;
    const expected = await sha256CanonicalText(row.canonicalWithoutDigest);
    return expected === row.event.eventDigest;
  }
}
