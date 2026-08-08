// Unit tests for session-lifecycle primitives. Windows-runnable — uses a fake
// store, not SQLite or the OS lock. Proves event shape, producer, idempotency
// key, that the lifecycle functions don't open/close the store, and that the
// caller-supplied sessionId is honored. Real SQLite INSERT/UPDATE behavior is
// proven by the POSIX reopen-vertical test.
//
// See docs/phase-0-spec.md §0.2 Step 9.

import { describe, expect, it } from "vitest";
import { asWorkspaceId, type EventDraft } from "@alcode/events";
import { startDurableSession, stopDurableSession } from "./session-lifecycle.ts";
import { SessionStateError } from "./sessions-projection.ts";
import type { LockedWorkspaceStore } from "@alcode/storage";

const WS = asWorkspaceId("00000000-0000-7000-8000-000000000001") as string;

/** Fake store: records appended drafts, exposes a no-op projection runner,
 * and supports replay() so the pre-persistence sessionWasStarted check works. */
function makeFakeStore() {
  const appended: EventDraft<string, unknown>[] = [];
  let closeCalled = false;
  const fakeStore = {
    workspaceId: WS,
    async append(drafts: readonly EventDraft<string, unknown>[]) {
      appended.push(...drafts);
      return drafts.map((d, i) => ({ ...d, sequence: appended.length - drafts.length + i + 1, recordedAt: "now", eventDigest: "x" }));
    },
    async *replay() {
      for (const d of appended) {
        yield { ...d, sequence: 1, recordedAt: "now", eventDigest: "x" } as never;
      }
    },
    getProjectionRunner() {
      return {
        getCursor: () => ({ projectionName: "sessions", lastAppliedEventSequence: appended.length, schemaVersion: 1, classification: "derived" as const }),
        catchUp: () => ({ appliedCount: appended.length, newCursor: { projectionName: "sessions", lastAppliedEventSequence: appended.length, schemaVersion: 1, classification: "derived" as const }, caught: true }),
      };
    },
  };
  const handle: LockedWorkspaceStore = {
    store: fakeStore as never,
    close() { closeCalled = true; },
  };
  return { handle, snapshot: () => appended, wasClosed: () => closeCalled };
}

describe("startDurableSession", () => {
  it("appends runtime.session.started with correct shape, producer, and idempotencyKey", async () => {
    const fake = makeFakeStore();
    const { sessionId } = await startDurableSession(fake.handle, {
      sessionId: "00000000-0000-7000-8000-00000000000A" as never,
    });

    expect(sessionId).toBe("00000000-0000-7000-8000-00000000000A");
    const snap = fake.snapshot();
    expect(snap.length).toBe(1);
    const d = snap[0]!;
    expect(d.type).toBe("runtime.session.started");
    expect(d.idempotencyKey).toBe("runtime.session.started:00000000-0000-7000-8000-00000000000A");
    expect(d.payload).toEqual({ sessionId: "00000000-0000-7000-8000-00000000000A" });
    expect(d.payloadSchemaVersion).toBe(1);
    expect(d.producer).toEqual({ kind: "runtime", component: "session-lifecycle" });
    expect(d.workspaceId).toBe(WS);
    expect(d.sessionId).toBe("00000000-0000-7000-8000-00000000000A");
    expect(d.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // B1: per-invocation correlationId makes the fingerprint clock-independent.
    expect(d.correlationId).toBeDefined();
    expect(d.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/); // UUIDv7
  });

  it("mints a fresh sessionId when none is provided", async () => {
    const fake = makeFakeStore();
    const { sessionId } = await startDurableSession(fake.handle);
    const d = fake.snapshot()[0]!;
    expect(sessionId).toBe(d.sessionId);
    expect(d.idempotencyKey).toBe(`runtime.session.started:${sessionId as string}`);
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/); // UUIDv7
  });

  it("does NOT close the store handle", async () => {
    const fake = makeFakeStore();
    await startDurableSession(fake.handle);
    expect(fake.wasClosed()).toBe(false);
  });
});

describe("stopDurableSession", () => {
  it("appends runtime.session.stopped with correct shape, producer, and idempotencyKey", async () => {
    const fake = makeFakeStore();
    const sid = "00000000-0000-7000-8000-00000000000B" as never;
    await startDurableSession(fake.handle, { sessionId: sid });
    await stopDurableSession(fake.handle, sid);

    // The stopped event is the second appended draft.
    const snap = fake.snapshot();
    const stopped = snap.find((d) => d.type === "runtime.session.stopped")!;
    expect(stopped.idempotencyKey).toBe("runtime.session.stopped:00000000-0000-7000-8000-00000000000B");
    expect(stopped.payload).toEqual({ sessionId: "00000000-0000-7000-8000-00000000000B" });
    expect(stopped.payloadSchemaVersion).toBe(1);
    expect(stopped.producer).toEqual({ kind: "runtime", component: "session-lifecycle" });
    expect(stopped.sessionId).toBe(sid);
  });

  it("does NOT close the store handle", async () => {
    const fake = makeFakeStore();
    const sid = "00000000-0000-7000-8000-00000000000C" as never;
    await startDurableSession(fake.handle, { sessionId: sid });
    await stopDurableSession(fake.handle, sid);
    expect(fake.wasClosed()).toBe(false);
  });

  it("throws SessionStateError and appends nothing when the session was never started", async () => {
    const fake = makeFakeStore();
    const sid = "00000000-0000-7000-8000-00000000000G" as never;
    await expect(stopDurableSession(fake.handle, sid)).rejects.toThrow(SessionStateError);
    // No event appended.
    expect(fake.snapshot().length).toBe(0);
  });
});

describe("start/stop idempotency keys are deterministic per session id", () => {
  it("the same sessionId always produces the same started/stopped idempotency keys", async () => {
    const fakeA = makeFakeStore();
    const fakeB = makeFakeStore();
    const sid = "00000000-0000-7000-8000-00000000000D" as never;
    await startDurableSession(fakeA.handle, { sessionId: sid });
    await startDurableSession(fakeB.handle, { sessionId: sid });
    // Both calls use the same idempotencyKey — the second would conflict at
    // the real store because occurredAt differs → different fingerprint.
    expect(fakeA.snapshot()[0]!.idempotencyKey).toBe(fakeB.snapshot()[0]!.idempotencyKey);
  });
});
