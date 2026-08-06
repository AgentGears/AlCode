// Unit tests for @alcode/events. These are the Phase 0.0 invariants required
// by the gate.
import { describe, expect, it } from "vitest";
import {
  asEventId,
  asMemoryId,
  asWorkspaceId,
  asSessionId,
  assertCanonical,
  canonicalStringify,
  InMemoryEventStore,
  mkEventId,
  mkSessionId,
  mkWorkspaceId,
  sha256Canonical,
  uuidv7,
  type EventDraft,
} from "./index.ts";

describe("identity", () => {
  it("uuidv7 produces a UUID-shaped string", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("uuidv7 timestamp prefix is monotonic across spaced calls", async () => {
    // UUIDv7 orders by its 48-bit timestamp prefix; the lower 76 bits are
    // random, so two ids within the same millisecond are NOT string-ordered.
    // Verify the timestamp-prefix property: extract the first 12 hex chars
    // (48 bits) and confirm non-decreasing across calls with a delay.
    const prefix = (id: string) => id.replace(/-/g, "").slice(0, 12);
    const a = uuidv7();
    await new Promise((r) => setTimeout(r, 5));
    const b = uuidv7();
    await new Promise((r) => setTimeout(r, 5));
    const c = uuidv7();
    const pa = parseInt(prefix(a), 16);
    const pb = parseInt(prefix(b), 16);
    const pc = parseInt(prefix(c), 16);
    expect(pa).toBeLessThanOrEqual(pb);
    expect(pb).toBeLessThanOrEqual(pc);
  });

  it("brand factories reject empty / malformed input", () => {
    expect(() => asEventId("")).toThrow();
    expect(() => asEventId("not-a-uuid")).toThrow();
    expect(() => asWorkspaceId("xyz")).toThrow();
  });

  it("asMemoryId accepts <type>/<slug>.md", () => {
    expect(() => asMemoryId("lesson/foo-bar_2026.md")).not.toThrow();
    expect(() => asMemoryId("no-md-ext")).toThrow();
  });
});

describe("canonical JSON", () => {
  it("sorts object keys lexicographically", () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("is stable regardless of insertion order", () => {
    const a = canonicalStringify({ z: 1, a: { y: 2, b: 3 } });
    const b = canonicalStringify({ a: { b: 3, y: 2 }, z: 1 });
    expect(a).toBe(b);
  });

  it("rejects undefined, NaN, Infinity, functions, symbols, bigint", () => {
    expect(() => assertCanonical(undefined)).toThrow();
    expect(() => assertCanonical(NaN)).toThrow();
    expect(() => assertCanonical(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => assertCanonical(() => 0)).toThrow();
    expect(() => assertCanonical(Symbol("x"))).toThrow();
    expect(() => assertCanonical(0n)).toThrow();
  });

  it("escapes control characters and quotes", () => {
    expect(canonicalStringify('a"b\nc')).toBe('"a\\"b\\nc"');
    expect(canonicalStringify("\u0001")).toBe('"\\u0001"');
  });

  it("sha256Canonical is deterministic", async () => {
    const d1 = await sha256Canonical({ b: 1, a: 2 });
    const d2 = await sha256Canonical({ a: 2, b: 1 });
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("InMemoryEventStore", () => {
  function draft(): EventDraft<"test.event", { n: number }> {
    return {
      eventId: mkEventId(),
      workspaceId: mkWorkspaceId(),
      sessionId: mkSessionId(),
      occurredAt: "2026-08-06T00:00:00.000Z",
      type: "test.event",
      payload: { n: 1 },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "test" },
    };
  }

  it("append assigns monotonic sequence, recordedAt, and eventDigest", async () => {
    const store = new InMemoryEventStore();
    const [a, b] = await store.append([draft(), draft()]);
    expect(a.sequence).toBe(1);
    expect(b.sequence).toBe(2);
    expect(a.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(a.eventDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(a.eventDigest).not.toBe(b.eventDigest);
  });

  it("append is idempotent on eventId", async () => {
    const store = new InMemoryEventStore();
    const d = draft();
    const [first] = await store.append([d]);
    const [second] = await store.append([d]);
    expect(second.sequence).toBe(first.sequence);
    expect(second.eventId).toBe(first.eventId);
    expect(await store.headSequence()).toBe(1);
  });

  it("append is idempotent on idempotencyKey (independent index)", async () => {
    const store = new InMemoryEventStore();
    const d1: EventDraft = { ...draft(), idempotencyKey: "k1" };
    const d2: EventDraft = { ...draft(), idempotencyKey: "k1" };
    const [a] = await store.append([d1]);
    const [b] = await store.append([d2]);
    expect(b.sequence).toBe(a.sequence);
    expect(b.eventId).not.toBe(d2.eventId); // different event id
    expect(b.eventId).toBe(a.eventId); // but resolved to the existing row
    expect(await store.headSequence()).toBe(1);
  });

  it("replay yields events in ascending sequence", async () => {
    const store = new InMemoryEventStore();
    await store.append([draft(), draft(), draft()]);
    const seqs: number[] = [];
    for await (const e of store.replay()) seqs.push(e.sequence);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it("replay honors fromSequence and toSequence", async () => {
    const store = new InMemoryEventStore();
    await store.append([draft(), draft(), draft(), draft()]);
    const seqs: number[] = [];
    for await (const e of store.replay(1, 3)) seqs.push(e.sequence);
    // fromSequence=1 means sequence > 1; toSequence=3 caps at sequence <= 3.
    expect(seqs).toEqual([2, 3]);
  });

  it("append rejects non-canonical payloads", async () => {
    const store = new InMemoryEventStore();
    const d = draft() as EventDraft<string, unknown>;
    (d as unknown as { payload: unknown }).payload = { bad: undefined };
    await expect(store.append([d])).rejects.toThrow();
  });

  it("digest still verifies after append", async () => {
    const store = new InMemoryEventStore();
    const [a] = await store.append([draft()]);
    expect(await store.verifyDigest(a.eventId)).toBe(true);
  });
});
