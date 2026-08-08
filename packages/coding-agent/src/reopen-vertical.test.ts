// Reopen vertical test — Step 9. POSIX-only (requires the OS workspace lock).
//
// Proves the frozen Step 9 contract in two phases:
//
// Phase A — clean run + reopen/recovery (zero new events):
//   openLockedWorkspaceStore → runDurableAgent (owns start/work/stop)
//   → assert operations + sessions cursors == head → snapshot S1
//   → close → reopen same DB → assert head unchanged before anything
//   → catchUp operations (applies 0) → catchUp sessions (applies 0)
//   → prove durable equivalence to S1 (events, cursors, operation rows,
//     session row, workspace identity)
//
// Phase B — begin new session without duplicating prior state:
//   startDurableSession(session B) → assert new event at H+1
//   → assert events [1..H] identical to S1, no duplicate IDs
//   → stopDurableSession(session B) → teardown
//
// Plus two duplicate-lifecycle regressions proving head does not advance
// when a duplicate start or stop is rejected at the admission boundary.
//
// See docs/phase-0-spec.md §0.2 Step 9.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { asWorkspaceId, uuidv7, asSessionId, type PersistedDomainEvent } from "@alcode/events";
import {
  openLockedWorkspaceStore,
  createOperationsProjection,
  createOperationQuery,
  IdempotencyConflictError,
  type LockedWorkspaceStore,
} from "@alcode/storage";
import { TestModelProvider } from "./test-model-provider.ts";
import { runDurableAgent } from "./durable-agent.ts";
import { startDurableSession, stopDurableSession } from "./session-lifecycle.ts";
import { createSessionsProjection, createSessionQuery, SessionStateError } from "./sessions-projection.ts";
import type { AgentTool } from "@alcode/agent-core";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

const TEST_WS = asWorkspaceId(uuidv7()) as string;
const TEST_REPO = uuidv7();

/** Skip on Windows (no LockFileEx binding yet). */
const describeLocked = process.platform === "win32" ? describe.skip : describe;

async function openStore(dbPath: string): Promise<LockedWorkspaceStore> {
  const lockPath = dbPath.replace(".sqlite", ".lock");
  return openLockedWorkspaceStore({
    databasePath: dbPath,
    lockPath,
    workspaceId: TEST_WS,
    repositoryId: TEST_REPO,
  });
}

/** A simple deterministic tool for scripting test scenarios. */
function makeScriptedTool(name: string, result: string): AgentTool {
  return {
    name,
    description: `scripted tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: result }], details: {} };
    },
  };
}

/** Read the full event log as an array. */
async function readAllEvents(store: LockedWorkspaceStore): Promise<PersistedDomainEvent<string, unknown>[]> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const e of store.store.replay()) events.push(e);
  return events;
}

/** Read-only DB connection (WAL allows concurrent reads). Always closes. */
function readWorkspaceMeta(dbPath: string) {
  const roDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const meta = roDb.prepare("SELECT workspace_id, repository_id FROM workspace_metadata").get() as Record<string, unknown>;
    return { workspaceId: meta.workspace_id as string, repositoryId: meta.repository_id as string };
  } finally {
    roDb.close();
  }
}

/** Read operation records via a read-only connection. Always closes. */
function readOperations(dbPath: string) {
  const roDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return createOperationQuery(roDb).getByLifecycleState("terminal");
  } finally {
    roDb.close();
  }
}

/** Read session records via a read-only connection. Always closes. */
function readSessions(dbPath: string) {
  const roDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return createSessionQuery(roDb).getAll();
  } finally {
    roDb.close();
  }
}

/** Signature of an event for equivalence comparison (deterministic fields only). */
function eventSignature(e: PersistedDomainEvent<string, unknown>) {
  return {
    eventId: e.eventId,
    sequence: e.sequence,
    type: e.type,
    payload: e.payload,
    payloadSchemaVersion: e.payloadSchemaVersion,
    producer: e.producer,
    sessionId: e.sessionId,
    operationId: e.operationId,
    idempotencyKey: e.idempotencyKey,
    eventDigest: e.eventDigest,
  };
}

describeLocked("Step 9 — shutdown/reopen vertical test", () => {
  let dir: string;
  let rt: LockedWorkspaceStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-step9-"));
  });
  afterEach(() => {
    try { rt?.close(); } catch { /* idempotent */ }
    rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Phase A: clean run → reopen → durable equivalence (zero new events)
  // -------------------------------------------------------------------------

  it("Phase A: clean run + reopen produces zero new events and equivalent durable state", async () => {
    const dbPath = join(dir, "ws.sqlite");

    // --- Session A: run the production path ---
    rt = await openStore(dbPath);
    const provider = new TestModelProvider([
      { match: "run", text: "Calling echo", toolCall: { id: "tc1", name: "echo", arguments: {} } },
      { match: "*", text: "Done." },
    ]);
    await runDurableAgent("run", {
      systemPrompt: "",
      provider,
      tools: [makeScriptedTool("echo", "echoed")],
      store: rt,
    });

    // Both critical/derived projections must be at the log head after the run.
    const runner = rt.store.getProjectionRunner();
    const headA = await rt.store.headSequence();
    const opsCursorA = runner.getCursor("operations").lastAppliedEventSequence;
    const sessCursorA = runner.getCursor("sessions").lastAppliedEventSequence;
    expect(opsCursorA).toBe(headA);
    expect(sessCursorA).toBe(headA);

    // Snapshot S1: events + full operation records + session row + workspace meta.
    const eventsS1 = (await readAllEvents(rt)).map(eventSignature);
    const opsS1 = readOperations(dbPath);
    const sessionsS1 = readSessions(dbPath);
    const metaS1 = readWorkspaceMeta(dbPath);
    // Session A should be stopped (runDurableAgent owns the bracket).
    expect(sessionsS1.length).toBe(1);
    expect(sessionsS1[0]!.stoppedAt).not.toBeNull();

    rt.close();

    // --- Reopen the same workspace ---
    rt = await openStore(dbPath);

    // Head must be unchanged before any catch-up.
    const headReopened = await rt.store.headSequence();
    expect(headReopened).toBe(headA);

    // Catch up both projections. Clean shutdown → both apply 0 events.
    const runner2 = rt.store.getProjectionRunner();
    const opsResult = runner2.catchUp(createOperationsProjection(rt.store.workspaceId));
    const sessResult = runner2.catchUp(createSessionsProjection(rt.store.workspaceId));
    expect(opsResult.appliedCount).toBe(0);
    expect(sessResult.appliedCount).toBe(0);

    // Prove durable equivalence: events identical.
    const eventsReopened = (await readAllEvents(rt)).map(eventSignature);
    expect(eventsReopened).toEqual(eventsS1);

    // Prove durable equivalence: cursors at head.
    expect(runner2.getCursor("operations").lastAppliedEventSequence).toBe(headA);
    expect(runner2.getCursor("sessions").lastAppliedEventSequence).toBe(headA);

    // Prove durable equivalence: full operation records survive intact (not
    // just count — operationId, toolName, args, outcome, effectStatus,
    // reconciliationStatus, startedAt, completedAt all compared).
    const opsReopened = readOperations(dbPath);
    expect(opsReopened).toEqual(opsS1);

    // Prove durable equivalence: session row survives intact (started + stopped).
    const sessionsReopened = readSessions(dbPath);
    expect(sessionsReopened).toEqual(sessionsS1);

    // Prove durable equivalence: workspace identity identical.
    const metaReopened = readWorkspaceMeta(dbPath);
    expect(metaReopened).toEqual(metaS1);
    expect(metaReopened.workspaceId).toBe(TEST_WS);
    expect(metaReopened.repositoryId).toBe(TEST_REPO);
  });

  // -------------------------------------------------------------------------
  // Phase B: begin a new session without duplicating prior state
  // -------------------------------------------------------------------------

  it("Phase B: fresh session B appends at H+1 and does not duplicate prior events", async () => {
    const dbPath = join(dir, "ws.sqlite");

    // Session A.
    rt = await openStore(dbPath);
    const provider = new TestModelProvider([
      { match: "run", text: "Calling echo", toolCall: { id: "tc1", name: "echo", arguments: {} } },
      { match: "*", text: "Done." },
    ]);
    await runDurableAgent("run", {
      systemPrompt: "",
      provider,
      tools: [makeScriptedTool("echo", "echoed")],
      store: rt,
    });
    const headH = await rt.store.headSequence();
    // Snapshot full event signatures [1..H] for deep equivalence after reopen.
    const priorSignatures = (await readAllEvents(rt)).map(eventSignature);
    rt.close();

    // Reopen.
    rt = await openStore(dbPath);

    // Start session B.
    const sessionBSid = asSessionId(uuidv7());
    await startDurableSession(rt, { sessionId: sessionBSid });

    // New event at H+1.
    const headAfterB = await rt.store.headSequence();
    expect(headAfterB).toBe(headH + 1);

    // Events [1..H] unchanged (full signature equivalence, not just IDs).
    const allEvents = await readAllEvents(rt);
    const priorSignaturesAfter = allEvents
      .filter((e) => e.sequence <= headH)
      .map(eventSignature);
    expect(priorSignaturesAfter).toEqual(priorSignatures);

    // The new event is the session B start.
    const newEvent = allEvents.find((e) => e.sequence === headH + 1)!;
    expect(newEvent.type).toBe("runtime.session.started");
    expect((newEvent.payload as { sessionId: string }).sessionId).toBe(sessionBSid as string);

    // Stop session B before teardown so the lifecycle seam is not left open.
    await stopDurableSession(rt, sessionBSid);
  });

  // -------------------------------------------------------------------------
  // Duplicate-lifecycle regressions: head does not advance on rejection
  // -------------------------------------------------------------------------

  it("duplicate startDurableSession(same sessionId) rejects and head does not advance", async () => {
    rt = await openStore(join(dir, "ws.sqlite"));
    const sid = asSessionId(uuidv7());
    await startDurableSession(rt, { sessionId: sid });
    const headBefore = await rt.store.headSequence();

    // Second start for the same session → IdempotencyConflictError.
    await expect(startDurableSession(rt, { sessionId: sid })).rejects.toThrow(IdempotencyConflictError);

    // Head unchanged — no poison event entered the canonical log.
    const headAfter = await rt.store.headSequence();
    expect(headAfter).toBe(headBefore);
  });

  it("duplicate stopDurableSession(same sessionId) rejects and head does not advance", async () => {
    rt = await openStore(join(dir, "ws.sqlite"));
    const sid = asSessionId(uuidv7());
    await startDurableSession(rt, { sessionId: sid });
    await stopDurableSession(rt, sid);
    const headBefore = await rt.store.headSequence();

    // Second stop for the same session → IdempotencyConflictError.
    await expect(stopDurableSession(rt, sid)).rejects.toThrow(IdempotencyConflictError);

    // Head unchanged.
    const headAfter = await rt.store.headSequence();
    expect(headAfter).toBe(headBefore);
  });

  it("stopDurableSession for a never-started session rejects pre-persistence and head does not advance", async () => {
    rt = await openStore(join(dir, "ws.sqlite"));
    const headBefore = await rt.store.headSequence();
    const unknownSid = asSessionId(uuidv7());

    // Stop for a session that was never started → SessionStateError before append.
    await expect(stopDurableSession(rt, unknownSid)).rejects.toThrow(SessionStateError);

    // Head unchanged — no poison event entered the canonical log.
    const headAfter = await rt.store.headSequence();
    expect(headAfter).toBe(headBefore);

    // The sessions projection is still usable afterward (catchUp does not
    // encounter a poison stopped event it can never apply).
    const runner = rt.store.getProjectionRunner();
    const sessResult = runner.catchUp(createSessionsProjection(rt.store.workspaceId));
    expect(sessResult.caught).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Frozen-clock regression: duplicate start rejects even when occurredAt is
  // identical for both attempts. Proves the conflict is structural (per-attempt
  // correlationId), not clock-dependent.
  // -------------------------------------------------------------------------

  it("duplicate startDurableSession rejects with identical occurredAt (frozen clock)", async () => {
    rt = await openStore(join(dir, "ws.sqlite"));

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const sid = asSessionId(uuidv7());

      // First start succeeds.
      await startDurableSession(rt, { sessionId: sid });
      const head = await rt.store.headSequence();

      // Second start with the same session id — occurredAt is identical because
      // the clock is frozen. The conflict must come from the per-attempt
      // correlationId (a fingerprinted field), not the timestamp.
      await expect(
        startDurableSession(rt, { sessionId: sid }),
      ).rejects.toThrow(IdempotencyConflictError);

      // Head unchanged — no poison event entered the canonical log.
      expect(await rt.store.headSequence()).toBe(head);
    } finally {
      vi.useRealTimers();
    }
  });
});
