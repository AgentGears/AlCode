// Reasoning projection integration proofs — v6→v7 migration, close/reopen,
// delete/rebuild equivalence.
//
// POSIX-only (requires OS workspace lock).
// These prove:
//   1. A v6 DB with caught-up reasoning projection upgrades to v7 correctly
//   2. Canonical reasoning events project, close, reopen, catch up, equivalent
//   3. Delete derived graph + cursor → replay → equivalent

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { asWorkspaceId, uuidv7, mkEventId, canonicalStringify } from "@alcode/events";
import {
  openLockedWorkspaceStore,
  createReasoningProjection,
  type LockedWorkspaceStore,
} from "./index.ts";
import { getSchemaVersion } from "./schema.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

const TEST_WS = asWorkspaceId(uuidv7()) as string;
const TEST_REPO = uuidv7();
const describeLocked = process.platform === "win32" ? describe.skip : describe;

async function openStore(dbPath: string): Promise<LockedWorkspaceStore> {
  const lockPath = dbPath.replace(".sqlite", ".lock");
  return openLockedWorkspaceStore({
    databasePath: dbPath, lockPath, workspaceId: TEST_WS, repositoryId: TEST_REPO,
  });
}

const SESSION = "reasoning-integration-session";

describeLocked("reasoning projection integration proofs", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-reasoning-int-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("schema v7 fresh DB has reasoning_edges table and reasoning_nodes has session_id + step", async () => {
    const dbPath = join(dir, "ws.sqlite");
    const rt = await openStore(dbPath);
    rt.close();

    const roDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      expect(getSchemaVersion(roDb)).toBe(7);

      const hasEdges = roDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='reasoning_edges'",
      ).get();
      expect(hasEdges).toBeDefined();

      const hasSessionId = roDb.prepare(
        "SELECT COUNT(*) as c FROM pragma_table_info('reasoning_nodes') WHERE name = 'session_id'",
      ).get() as { c: number };
      expect(hasSessionId.c).toBe(1);

      const hasStep = roDb.prepare(
        "SELECT COUNT(*) as c FROM pragma_table_info('reasoning_nodes') WHERE name = 'step'",
      ).get() as { c: number };
      expect(hasStep.c).toBe(1);
    } finally {
      roDb.close();
    }
  });

  it("v6→v7 migration: caught-up reasoning cursor invalidated, derived graph rebuilt", async () => {
    const dbPath = join(dir, "ws_migrate.sqlite");

    // Step 1: Manually create a v6 database with old reasoning schema
    const rawDb = new Database(dbPath);
    rawDb.pragma("journal_mode = WAL");
    rawDb.pragma("foreign_keys = ON");
    // Create v1 reasoning_nodes (no session_id, no step)
    rawDb.exec(`CREATE TABLE IF NOT EXISTS reasoning_nodes (
      node_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL,
      label TEXT NOT NULL, data TEXT, confidence REAL, created_sequence INTEGER NOT NULL
    )`);
    // Create v6 schema_migrations
    rawDb.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    rawDb.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (6, ?)").run(new Date().toISOString());
    // Insert a stale v1 reasoning node
    rawDb.prepare(
      "INSERT INTO reasoning_nodes (node_id, workspace_id, kind, label, data, confidence, created_sequence) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("stale-obj-1", TEST_WS, "objective", "old objective", "{}", 1.0, 1);
    // Insert a caught-up reasoning cursor at schemaVersion 1
    rawDb.exec(`CREATE TABLE IF NOT EXISTS projection_cursors (
      projection_name TEXT PRIMARY KEY, last_applied_event_sequence INTEGER NOT NULL DEFAULT 0,
      projection_schema_version INTEGER NOT NULL DEFAULT 1, classification TEXT NOT NULL DEFAULT 'derived'
    )`);
    rawDb.prepare(
      "INSERT INTO projection_cursors (projection_name, last_applied_event_sequence, projection_schema_version, classification) VALUES (?, ?, ?, ?)",
    ).run("reasoning", 1, 1, "derived");
    // Create workspace_metadata (required by bindWorkspace)
    rawDb.exec(`CREATE TABLE IF NOT EXISTS workspace_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      workspace_id TEXT NOT NULL, repository_id TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
    rawDb.prepare(
      "INSERT INTO workspace_metadata (singleton, workspace_id, repository_id, created_at) VALUES (1, ?, ?, ?)",
    ).run(TEST_WS, TEST_REPO, new Date().toISOString());
    // Create events table with a real legacy objective.set canonical event
    rawDb.exec(`CREATE TABLE events (
      event_id TEXT PRIMARY KEY, idempotency_key TEXT, sequence INTEGER NOT NULL,
      workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, operation_id TEXT,
      type TEXT NOT NULL, payload TEXT NOT NULL, payload_schema_version INTEGER NOT NULL,
      producer TEXT NOT NULL, causation_event_id TEXT, correlation_id TEXT,
      occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL, event_digest TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL
    )`);
    // Insert a real canonical legacy objective.set event. Its integrity fields
    // must be constructed exactly as the Phase 0.2 event store verifies them.
    const legacyPayloadObject = {
      nodeId: "legacy-obj-1", kind: "objective", label: "original objective",
      data: { statement: "fix the bug" }, confidence: 0.9,
    };
    const legacyPayload = JSON.stringify(legacyPayloadObject);
    const legacyProducer = { kind: "runtime", component: "test" };
    const legacyOccurredAt = "2026-01-01T00:00:00.000Z";
    const legacyRecordedAt = "2026-01-01T00:00:00.000Z";
    const { createHash } = await import("node:crypto");
    const fingerprintInput = {
      workspaceId: TEST_WS,
      sessionId: "legacy-session",
      operationId: null,
      type: "objective.set",
      payload: legacyPayloadObject,
      payloadSchemaVersion: 1,
      producer: legacyProducer,
      causationEventId: null,
      correlationId: null,
      occurredAt: legacyOccurredAt,
    };
    const fingerprint = createHash("sha256")
      .update(canonicalStringify(fingerprintInput))
      .digest("hex");
    const eventDigestInput = {
      eventId: "legacy-evt-1",
      workspaceId: TEST_WS,
      sessionId: "legacy-session",
      occurredAt: legacyOccurredAt,
      type: "objective.set",
      payload: legacyPayloadObject,
      payloadSchemaVersion: 1,
      producer: legacyProducer,
      sequence: 1,
      recordedAt: legacyRecordedAt,
    };
    const eventDigest = createHash("sha256")
      .update(canonicalStringify(eventDigestInput))
      .digest("hex");
    rawDb.prepare(
      "INSERT INTO events (event_id, idempotency_key, sequence, workspace_id, session_id, operation_id, type, payload, payload_schema_version, producer, causation_event_id, correlation_id, occurred_at, recorded_at, event_digest, request_fingerprint) VALUES (?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)",
    ).run("legacy-evt-1", 1, TEST_WS, "legacy-session", "objective.set", legacyPayload, 1,
      JSON.stringify(legacyProducer), legacyOccurredAt, legacyRecordedAt, eventDigest, fingerprint);
    rawDb.close();

    // Step 2: Open via openLockedWorkspaceStore — this triggers v6→v7 migration
    const rt = await openStore(dbPath);

    // Step 3: Verify migration results
    const roDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      expect(getSchemaVersion(roDb)).toBe(7);
      const hasEdges = roDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='reasoning_edges'",
      ).get();
      expect(hasEdges).toBeDefined();
      const hasSessionId = roDb.prepare(
        "SELECT COUNT(*) as c FROM pragma_table_info('reasoning_nodes') WHERE name = 'session_id'",
      ).get() as { c: number };
      expect(hasSessionId.c).toBe(1);
      // Stale v1 reasoning nodes were cleared
      const staleCount = (roDb.prepare("SELECT COUNT(*) as c FROM reasoning_nodes").get() as { c: number }).c;
      expect(staleCount).toBe(0);
      // Reasoning cursor was invalidated
      const cursor = roDb.prepare(
        "SELECT * FROM projection_cursors WHERE projection_name = 'reasoning'",
      ).get();
      expect(cursor).toBeUndefined();
    } finally {
      roDb.close();
    }

    // Step 4: Catch up the reasoning projection under v2 — replays the real event
    const runner = rt.store.getProjectionRunner();
    const result = runner.catchUp(createReasoningProjection(TEST_WS));
    expect(result.caught).toBe(true);
    expect(result.appliedCount).toBe(1);

    // Step 5: Verify the legacy objective was restored with its original identity
    const roDb2 = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const restored = roDb2.prepare("SELECT * FROM reasoning_nodes WHERE node_id = ?").get("legacy-obj-1");
      expect(restored).toBeDefined();
      expect((restored as Record<string, unknown>).kind).toBe("objective");
      expect((restored as Record<string, unknown>).label).toBe("original objective");
      expect((restored as Record<string, unknown>).confidence).toBe(0.9);
    } finally {
      roDb2.close();
    }

    rt.close();
  });

  it("append canonical reasoning events → project → close/reopen → catch up → equivalent graph", async () => {
    const dbPath = join(dir, "ws.sqlite");
    const wsId = TEST_WS;
    const sid = SESSION;

    // Session 1: append events + project
    let rt = await openStore(dbPath);
    await rt.store.append([
      {
        eventId: mkEventId(),
        workspaceId: wsId as never,
        sessionId: sid as never,
        occurredAt: new Date().toISOString(),
        type: "objective.set",
        payload: { nodeId: "n1", kind: "objective", label: "fix the bug", data: { statement: "fix the bug" }, confidence: 1.0 },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "test" },
      },
      {
        eventId: mkEventId(),
        workspaceId: wsId as never,
        sessionId: sid as never,
        occurredAt: new Date().toISOString(),
        type: "hypothesis.created",
        payload: {
          claim: "null pointer", falsifier: "no crash",
          objectiveId: "n1",
        },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "test" },
      },
    ]);

    const proj = createReasoningProjection(wsId);
    const runner = rt.store.getProjectionRunner();
    runner.catchUp(proj);

    // Verify nodes + edges exist
    const roDb1 = new Database(dbPath, { readonly: true, fileMustExist: true });
    const nodeCount1 = (roDb1.prepare("SELECT COUNT(*) as c FROM reasoning_nodes").get() as { c: number }).c;
    const edgeCount1 = (roDb1.prepare("SELECT COUNT(*) as c FROM reasoning_edges").get() as { c: number }).c;
    roDb1.close();

    expect(nodeCount1).toBeGreaterThan(0);
    expect(edgeCount1).toBeGreaterThan(0);

    // Snapshot cursor
    const cursor1 = runner.getCursor("reasoning").lastAppliedEventSequence;
    const headSeq = await rt.store.headSequence();
    rt.close();

    // Session 2: reopen, catch up
    rt = await openStore(dbPath);
    const runner2 = rt.store.getProjectionRunner();
    const result = runner2.catchUp(createReasoningProjection(wsId));
    expect(result.caught).toBe(true);

    const roDb2 = new Database(dbPath, { readonly: true, fileMustExist: true });
    const nodeCount2 = (roDb2.prepare("SELECT COUNT(*) as c FROM reasoning_nodes").get() as { c: number }).c;
    const edgeCount2 = (roDb2.prepare("SELECT COUNT(*) as c FROM reasoning_edges").get() as { c: number }).c;
    roDb2.close();

    // Equivalent state
    expect(nodeCount2).toBe(nodeCount1);
    expect(edgeCount2).toBe(edgeCount1);
    expect(runner2.getCursor("reasoning").lastAppliedEventSequence).toBe(cursor1);
    rt.close();
  });

  it("delete derived reasoning graph + cursor → replay → equivalent", async () => {
    const dbPath = join(dir, "ws.sqlite");
    const wsId = TEST_WS;
    const sid = SESSION;

    // Build + project
    let rt = await openStore(dbPath);
    await rt.store.append([
      {
        eventId: mkEventId(),
        workspaceId: wsId as never,
        sessionId: sid as never,
        occurredAt: new Date().toISOString(),
        type: "objective.set",
        payload: { nodeId: "n1", kind: "objective", label: "obj", data: {}, confidence: 1.0 },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "test" },
      },
      {
        eventId: mkEventId(),
        workspaceId: wsId as never,
        sessionId: sid as never,
        occurredAt: new Date().toISOString(),
        type: "hypothesis.created",
        payload: { claim: "hyp", objectiveId: "n1" },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "test" },
      },
    ]);

    const proj = createReasoningProjection(wsId);
    rt.store.getProjectionRunner().catchUp(proj);

    const roDb1 = new Database(dbPath, { readonly: true, fileMustExist: true });
    const nodeCount1 = (roDb1.prepare("SELECT COUNT(*) as c FROM reasoning_nodes").get() as { c: number }).c;
    const edgeCount1 = (roDb1.prepare("SELECT COUNT(*) as c FROM reasoning_edges").get() as { c: number }).c;
    roDb1.close();
    rt.close();

    // Delete derived tables + cursor
    const rawDb = new Database(dbPath);
    rawDb.exec("DELETE FROM reasoning_nodes");
    rawDb.exec("DELETE FROM reasoning_edges");
    rawDb.prepare("DELETE FROM projection_cursors WHERE projection_name = 'reasoning'").run();
    rawDb.close();

    // Reopen and rebuild
    rt = await openStore(dbPath);
    const result = rt.store.getProjectionRunner().catchUp(createReasoningProjection(wsId));
    expect(result.caught).toBe(true);

    const roDb2 = new Database(dbPath, { readonly: true, fileMustExist: true });
    const nodeCount2 = (roDb2.prepare("SELECT COUNT(*) as c FROM reasoning_nodes").get() as { c: number }).c;
    const edgeCount2 = (roDb2.prepare("SELECT COUNT(*) as c FROM reasoning_edges").get() as { c: number }).c;
    roDb2.close();

    expect(nodeCount2).toBe(nodeCount1);
    expect(edgeCount2).toBe(edgeCount1);
    rt.close();
  });
});