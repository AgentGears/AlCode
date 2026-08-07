// Session lifecycle primitives — startDurableSession / stopDurableSession.
// See docs/phase-0-spec.md §0.2 Step 9.
//
// These own the runtime.session.started / runtime.session.stopped events and
// the synchronous materialization of the sessions projection at those
// boundaries. They live in the coding-agent layer — one layer above storage.
// They do NOT open or close the store; they receive an already-open
// LockedWorkspaceStore.
//
// Duplicate rejection: each lifecycle event carries a deterministic
// idempotencyKey keyed by the session id:
//   runtime.session.started:<sessionId>
//   runtime.session.stopped:<sessionId>
// A second start or stop for the same session has a different occurredAt
// (and therefore a different request fingerprint), so the store raises
// IdempotencyConflictError and the event never enters the canonical log.
// The sessions-table PRIMARY KEY and the changes===1 projection check are
// defense in depth, not the primary guard — because projection application
// happens after immutable append, a poison event would already be canonical
// before the projection rolled back.

import {
  mkEventId,
  mkSessionId,
  asWorkspaceId,
  type EventDraft,
  type SessionId,
} from "@alcode/events";
import type { LockedWorkspaceStore } from "@alcode/storage";

import { createSessionsProjection } from "./sessions-projection.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StartDurableSessionOptions {
  /** Explicit identity for the new session; a fresh ID is minted when omitted. */
  sessionId?: SessionId;
}

export interface StartedSession {
  sessionId: SessionId;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * Append runtime.session.started for a (new) session and synchronously catch
 * up the sessions projection so the session row is materialized before this
 * returns. Does NOT open or close the store.
 *
 * Throws IdempotencyConflictError if a session with the same id was already
 * started (different occurredAt → different fingerprint → conflict). This
 * rejects the duplicate before any event enters the canonical log.
 */
export async function startDurableSession(
  store: LockedWorkspaceStore,
  opts?: StartDurableSessionOptions,
): Promise<StartedSession> {
  const sessionId = opts?.sessionId ?? mkSessionId();
  const eventStore = store.store;
  const workspaceId = asWorkspaceId(eventStore.workspaceId);

  const draft: EventDraft<string, unknown> = {
    eventId: mkEventId(),
    idempotencyKey: `runtime.session.started:${sessionId as string}`,
    workspaceId,
    sessionId,
    occurredAt: new Date().toISOString(),
    type: "runtime.session.started",
    payload: { sessionId: sessionId as string },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "session-lifecycle" },
  };

  await eventStore.append([draft]);
  eventStore.getProjectionRunner().catchUp(createSessionsProjection(eventStore.workspaceId));

  return { sessionId };
}

/**
 * Append runtime.session.stopped for a session and synchronously catch up
 * the sessions projection so the stopped_at column is set before this
 * returns. Does NOT open or close the store.
 *
 * Throws IdempotencyConflictError if the session was already stopped
 * (different occurredAt → different fingerprint → conflict), rejecting the
 * duplicate before any event enters the canonical log.
 */
export async function stopDurableSession(
  store: LockedWorkspaceStore,
  sessionId: SessionId,
): Promise<void> {
  const eventStore = store.store;
  const workspaceId = asWorkspaceId(eventStore.workspaceId);

  const draft: EventDraft<string, unknown> = {
    eventId: mkEventId(),
    idempotencyKey: `runtime.session.stopped:${sessionId as string}`,
    workspaceId,
    sessionId,
    occurredAt: new Date().toISOString(),
    type: "runtime.session.stopped",
    payload: { sessionId: sessionId as string },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "session-lifecycle" },
  };

  await eventStore.append([draft]);
  eventStore.getProjectionRunner().catchUp(createSessionsProjection(eventStore.workspaceId));
}
