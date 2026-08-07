// Unit tests for the sessions projection. Windows-runnable — uses a fake
// ProjectionTransaction, not SQLite. Proves the projection's apply() logic:
// started → insert-session with the right params; stopped requires
// changes === 1 and throws SessionStateError on a zero-row transition;
// other event types no-op. The real SQL INSERT/UPDATE behavior is proven
// by the POSIX reopen-vertical test against the actual sessions table.
//
// See docs/phase-0-spec.md §0.2 Step 9.

import { describe, expect, it } from "vitest";
import { createSessionsProjection, SessionStateError } from "./sessions-projection.ts";
import type { ProjectionTransaction, PersistedDomainEvent } from "@alcode/storage";
import type {} from "@alcode/events";

const WS = "00000000-0000-7000-8000-000000000001";

/** Fake ProjectionTransaction that records exec calls and returns scripted changes. */
function makeFakeTx() {
  const calls: { name: string; params: unknown[] }[] = [];
  let nextChanges = 1; // default: 1 row affected
  const tx: ProjectionTransaction = {
    exec(name: string, ...params: unknown[]) {
      calls.push({ name, params });
      return nextChanges;
    },
  };
  return {
    tx,
    calls,
    setNextChanges(n: number) { nextChanges = n; },
  };
}

function makeEvent(type: string, payload: unknown, seq: number): PersistedDomainEvent<string, unknown> {
  return {
    eventId: `evt-${seq}`,
    workspaceId: WS,
    sessionId: "sess-1",
    occurredAt: "2026-08-08T00:00:00.000Z",
    type,
    payload,
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "session-lifecycle" },
    sequence: seq,
    recordedAt: "2026-08-08T00:00:00.000Z",
    eventDigest: "x",
  } as PersistedDomainEvent<string, unknown>;
}

describe("createSessionsProjection — apply() logic (fake tx)", () => {
  it("classification is 'derived' (not critical)", () => {
    const proj = createSessionsProjection(WS);
    expect(proj.classification).toBe("derived");
    expect(proj.name).toBe("sessions");
    expect(proj.schemaVersion).toBe(1);
  });

  it("runtime.session.started calls insert-session with sessionId, workspaceId, occurredAt", () => {
    const fake = makeFakeTx();
    const proj = createSessionsProjection(WS);
    proj.apply(
      makeEvent("runtime.session.started", { sessionId: "sess-A" }, 1),
      fake.tx,
    );
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]!.name).toBe("insert-session");
    expect(fake.calls[0]!.params).toEqual(["sess-A", WS, "2026-08-08T00:00:00.000Z"]);
  });

  it("runtime.session.stopped calls update-session-stopped and succeeds when changes === 1", () => {
    const fake = makeFakeTx();
    const proj = createSessionsProjection(WS);
    proj.apply(
      makeEvent("runtime.session.stopped", { sessionId: "sess-A" }, 2),
      fake.tx,
    );
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]!.name).toBe("update-session-stopped");
    // params: [occurredAt, sessionId]
    expect(fake.calls[0]!.params).toEqual(["2026-08-08T00:00:00.000Z", "sess-A"]);
  });

  it("runtime.session.stopped throws SessionStateError when changes === 0 (defense in depth)", () => {
    const fake = makeFakeTx();
    fake.setNextChanges(0); // simulate: session doesn't exist or already stopped
    const proj = createSessionsProjection(WS);
    expect(() =>
      proj.apply(
        makeEvent("runtime.session.stopped", { sessionId: "sess-ghost" }, 2),
        fake.tx,
      ),
    ).toThrow(SessionStateError);
  });

  it("runtime.session.stopped throws when changes > 1 (should never happen, but caught)", () => {
    const fake = makeFakeTx();
    fake.setNextChanges(2);
    const proj = createSessionsProjection(WS);
    expect(() =>
      proj.apply(
        makeEvent("runtime.session.stopped", { sessionId: "sess-A" }, 2),
        fake.tx,
      ),
    ).toThrow(SessionStateError);
  });

  it("other event types are ignored (no exec calls)", () => {
    const fake = makeFakeTx();
    const proj = createSessionsProjection(WS);
    proj.apply(makeEvent("user.message.appended", { text: "hi" }, 1), fake.tx);
    proj.apply(makeEvent("operation.requested", { operationId: "op-1" }, 2), fake.tx);
    proj.apply(makeEvent("operation.completed", { operationId: "op-1" }, 3), fake.tx);
    expect(fake.calls.length).toBe(0);
  });
});
