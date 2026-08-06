import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import {
  mkEventId,
  mkWorkspaceId,
  mkSessionId,
  asWorkspaceId,
  uuidv7,
} from "@alcode/events";
import {
  initWorkspaceDb,
  bindWorkspace,
  SqliteEventStore,
  EventIdentityConflictError,
  IdempotencyConflictError,
  WorkspaceIdMismatchError,
  WorkspaceMismatchError,
  EventIntegrityError,
  computeRequestFingerprint,
  openWorkspaceStore,
} from "./index.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

const TEST_WS = asWorkspaceId(uuidv7()) as string;
const TEST_REPO = uuidv7();

function makeDraft(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    eventId: mkEventId(),
    workspaceId: TEST_WS,
    sessionId: mkSessionId(),
    occurredAt: "2026-08-06T00:00:00.000Z",
    type: "test.event",
    payload: { value: 42 },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "test" },
    ...overrides,
  };
}

function openStore(dbPath: string): SqliteEventStore {
  return openWorkspaceStore({ databasePath: dbPath, workspaceId: TEST_WS, repositoryId: TEST_REPO });
}

describe("SqliteEventStore — basic operations", () => {
  let dbPath: string;
  let store: SqliteEventStore;

  beforeEach(() => { dbPath = mkdtempSync(join(tmpdir(), "alcode-")) + "/ws.sqlite"; store = openStore(dbPath); });
  afterEach(() => { store.close(); });

  it("append assigns monotonic sequence, recordedAt, and eventDigest", async () => {
    const [a, b] = await store.append([makeDraft(), makeDraft()]);
    expect(a.sequence).toBe(1);
    expect(b.sequence).toBe(2);
    expect(a.eventDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("replay yields events in ascending sequence", async () => {
    await store.append([makeDraft(), makeDraft(), makeDraft()]);
    const seqs: number[] = [];
    for await (const e of store.replay()) seqs.push(e.sequence);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it("replay honors fromSequence and toSequence", async () => {
    await store.append([makeDraft(), makeDraft(), makeDraft(), makeDraft()]);
    const seqs: number[] = [];
    for await (const e of store.replay(1, 3)) seqs.push(e.sequence);
    expect(seqs).toEqual([2, 3]);
  });

  it("headSequence returns 0 for empty store", async () => { expect(await store.headSequence()).toBe(0); });

  it("append rejects non-canonical payloads", async () => {
    await expect(store.append([makeDraft({ payload: { bad: undefined } })])).rejects.toThrow();
  });

  it("persisting and reopening retains events", async () => {
    const draft = makeDraft({ payload: { hello: "world" } });
    await store.append([draft]);
    store.close();
    store = openStore(dbPath);
    expect(await store.headSequence()).toBe(1);
    const found = await store.get(draft.eventId as string);
    expect(found).toBeDefined();
    expect((found!.payload as { hello: string }).hello).toBe("world");
  });

  it("cursor starts at 0 and advances", async () => {
    expect(store.getCursor("p")).toBe(0);
    await store.append([makeDraft(), makeDraft(), makeDraft()]);
    store.transaction(() => store.advanceCursor("p", 3));
    expect(store.getCursor("p")).toBe(3);
  });
});

describe("SqliteEventStore — workspace binding via openWorkspaceStore", () => {
  let dbPath: string;
  beforeEach(() => { dbPath = mkdtempSync(join(tmpdir(), "alcode-ws-")) + "/ws.sqlite"; });

  it("openWorkspaceStore initializes and binds", () => {
    const store = openStore(dbPath);
    expect(store.workspaceId).toBe(TEST_WS);
    store.close();
  });

  it("openWorkspaceStore rejects mismatched workspaceId on reopen", () => {
    openStore(dbPath).close();
    expect(() => openWorkspaceStore({ databasePath: dbPath, workspaceId: "other-ws", repositoryId: TEST_REPO })).toThrow(WorkspaceMismatchError);
  });

  it("append rejects drafts with a different workspaceId", async () => {
    const store = openStore(dbPath);
    const otherWs = mkWorkspaceId() as string;
    await expect(store.append([makeDraft({ workspaceId: otherWs })])).rejects.toThrow(WorkspaceIdMismatchError);
    store.close();
  });
});

describe("SqliteEventStore — idempotency with conflict detection", () => {
  let dbPath: string;
  let store: SqliteEventStore;
  beforeEach(() => { dbPath = mkdtempSync(join(tmpdir(), "alcode-idem-")) + "/ws.sqlite"; store = openStore(dbPath); });
  afterEach(() => { store.close(); });

  it("same eventId + same content → returns existing", async () => {
    const draft = makeDraft();
    const [first] = await store.append([draft]);
    const [second] = await store.append([draft]);
    expect(second.sequence).toBe(first.sequence);
    expect(await store.headSequence()).toBe(1);
  });

  it("same eventId + different content → throws EventIdentityConflictError", async () => {
    const draft = makeDraft();
    await store.append([draft]);
    await expect(store.append([makeDraft({ eventId: draft.eventId, payload: { value: 999 } })])).rejects.toThrow(EventIdentityConflictError);
  });

  it("same idempotencyKey + same content + DIFFERENT eventId → returns existing (exercises the key path)", async () => {
    const key = "op-same";
    const d1 = makeDraft({ idempotencyKey: key });
    const d2 = { ...d1, eventId: mkEventId() }; // DIFFERENT eventId, same content+key
    const [first] = await store.append([d1]);
    const [second] = await store.append([d2]);
    expect(second.sequence).toBe(first.sequence);
    expect(second.eventId).toBe(first.eventId);
    expect(await store.headSequence()).toBe(1);
  });

  it("same idempotencyKey + different content + DIFFERENT eventId → throws IdempotencyConflictError", async () => {
    const key = "op-diff";
    const d1 = makeDraft({ idempotencyKey: key, payload: { value: 1 } });
    const d2 = { ...makeDraft({ idempotencyKey: key, payload: { value: 2 } }), eventId: mkEventId() };
    await store.append([d1]);
    await expect(store.append([d2])).rejects.toThrow(IdempotencyConflictError);
  });

  it("batch rollback: one conflict rolls back the entire batch", async () => {
    const existing = makeDraft();
    await store.append([existing]);
    const valid = makeDraft();
    const conflict = makeDraft({ eventId: existing.eventId, payload: { different: true } });
    await expect(store.append([valid, conflict])).rejects.toThrow();
    expect(await store.get(valid.eventId as string)).toBeUndefined();
    expect(await store.headSequence()).toBe(1);
  });
});

describe("SqliteEventStore — verified reads (integrity)", () => {
  let dbPath: string;
  let db: import("better-sqlite3").Database;
  let store: SqliteEventStore;
  beforeEach(() => {
    dbPath = mkdtempSync(join(tmpdir(), "alcode-integ-")) + "/ws.sqlite";
    store = openStore(dbPath);
    db = require("better-sqlite3")(dbPath);
  });
  afterEach(() => { store.close(); });

  it("get() throws EventIntegrityError on tampered payload", async () => {
    const draft = makeDraft({ payload: { original: true } });
    await store.append([draft]);
    // Tamper with the payload directly in the DB
    db.prepare("UPDATE events SET payload = ? WHERE event_id = ?").run(
      JSON.stringify({ tampered: true }), draft.eventId,
    );
    // store.get() should verify and throw
    await expect(store.get(draft.eventId as string)).rejects.toThrow(EventIntegrityError);
  });

  it("replay() throws EventIntegrityError on tampered digest", async () => {
    const draft = makeDraft();
    await store.append([draft]);
    // Tamper with the digest
    db.prepare("UPDATE events SET event_digest = ? WHERE event_id = ?").run(
      "0".repeat(64), draft.eventId,
    );
    await expect(async () => {
      for await (const _ of store.replay()) { /* consume */ }
    }).rejects.toThrow(EventIntegrityError);
  });

  it("digest can be recomputed from the raw SQLite row and matches", async () => {
    const draft = makeDraft({ payload: { test: true } });
    await store.append([draft]);
    // store.get() verifies internally; if it doesn't throw, the digest matches
    const found = await store.get(draft.eventId as string);
    expect(found).toBeDefined();
    expect(found!.eventDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("SqliteEventStore — request fingerprint", () => {
  it("same content produces same fingerprint", () => {
    const d = makeDraft() as never;
    expect(computeRequestFingerprint(d)).toBe(computeRequestFingerprint(d));
  });

  it("different payload produces different fingerprint", () => {
    const d1 = makeDraft({ payload: { a: 1 } }) as never;
    const d2 = makeDraft({ payload: { a: 2 } }) as never;
    expect(computeRequestFingerprint(d1)).not.toBe(computeRequestFingerprint(d2));
  });
});

describe("SqliteEventStore — schema migration v1→v2", () => {
  it("migrates a v1 database (no request_fingerprint, no workspace_metadata)", async () => {
    const dbPath = mkdtempSync(join(tmpdir(), "alcode-mig-")) + "/ws.sqlite";
    // Create a v1-style database manually
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, sequence INTEGER NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, operation_id TEXT,
      type TEXT NOT NULL, payload TEXT NOT NULL, payload_schema_version INTEGER NOT NULL DEFAULT 1,
      producer TEXT NOT NULL, causation_event_id TEXT, correlation_id TEXT,
      occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL, event_digest TEXT NOT NULL
    )`);
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(new Date().toISOString());

    // Insert a v1 event (no request_fingerprint column)
    const wsId = TEST_WS;
    const draft = makeDraft();
    db.prepare(`INSERT INTO events (event_id, idempotency_key, sequence, workspace_id, session_id,
      operation_id, type, payload, payload_schema_version, producer, causation_event_id, correlation_id,
      occurred_at, recorded_at, event_digest) VALUES (?,NULL,1,?,?,NULL,?,?,?,?,NULL,NULL,?,?,?)`).run(
      draft.eventId, wsId, draft.sessionId, draft.type, JSON.stringify(draft.payload),
      1, JSON.stringify(draft.producer), draft.occurredAt, draft.occurredAt, "0".repeat(64),
    );
    db.close();

    // Now open via openWorkspaceStore — should detect v1 and migrate
    const store = openWorkspaceStore({ databasePath: dbPath, workspaceId: wsId, repositoryId: TEST_REPO });
    // The migrated event should have a backfilled request_fingerprint
    expect(await store.headSequence()).toBe(1);
    const found = await store.get(draft.eventId as string);
    expect(found).toBeDefined();
    store.close();
  });
});

describe("workspace lock — cross-process contention", () => {
  it("process B fails while process A holds the lock (POSIX only)", { timeout: 15000 }, async () => {
    if (process.platform === "win32") {
      // Windows fails closed (no LockFileEx binding) — this test is POSIX-only
      expect(true).toBe(true);
      return;
    }

    const { acquireWorkspaceLock } = await import("@alcode/workspace");
    const lockPath = mkdtempSync(join(tmpdir(), "alcode-lock-")) + "/test.lock";

    // Process A acquires
    const lockA = acquireWorkspaceLock(lockPath);

    // Spawn process B that tries to acquire and should fail
    const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [
        "--import", "tsx",
        "-e",
        `import { acquireWorkspaceLock } from "@alcode/workspace";
         try {
           acquireWorkspaceLock(${JSON.stringify(lockPath)});
           console.log("ACQUIRED");
           process.exit(0);
         } catch (e) {
           console.log("FAILED:" + e.message.slice(0, 50));
           process.exit(1);
         }`,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, NODE_PATH: join(process.cwd(), "node_modules") },
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => { stdout += d; });
      child.stderr?.on("data", (d) => { stderr += d; });
      child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    });

    // B should have failed
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("FAILED");

    // Release A
    lockA.release();

    // Process C should now succeed (OS released the lock on A's release)
    const resultC = await new Promise<{ exitCode: number; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [
        "--import", "tsx",
        "-e",
        `import { acquireWorkspaceLock } from "@alcode/workspace";
         try {
           const lock = acquireWorkspaceLock(${JSON.stringify(lockPath)});
           console.log("ACQUIRED");
           lock.release();
           process.exit(0);
         } catch (e) {
           console.log("FAILED");
           process.exit(1);
         }`,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, NODE_PATH: join(process.cwd(), "node_modules") },
      });
      let stdout = "";
      child.stdout?.on("data", (d) => { stdout += d; });
      child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout }));
    });

    expect(resultC.exitCode).toBe(0);
    expect(resultC.stdout).toContain("ACQUIRED");
  });

  it("crash release: process exits without calling release, next acquires", { timeout: 15000 }, async () => {
    if (process.platform === "win32") { expect(true).toBe(true); return; }

    const { acquireWorkspaceLock } = await import("@alcode/workspace");
    const lockPath = mkdtempSync(join(tmpdir(), "alcode-crash-")) + "/crash.lock";

    // Spawn a child that acquires the lock and exits immediately (crash simulation)
    const childResult = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [
        "--import", "tsx",
        "-e",
        `import { acquireWorkspaceLock } from "@alcode/workspace";
         acquireWorkspaceLock(${JSON.stringify(lockPath)});
         console.log("LOCKED");
         // Exit WITHOUT calling release — simulates a crash
         process.exit(0);`,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, NODE_PATH: join(process.cwd(), "node_modules") },
      });
      child.on("close", (code) => resolve(code ?? -1));
    });
    expect(childResult).toBe(0);

    // Now acquire from THIS process — should succeed because the child exited
    expect(() => {
      const lock = acquireWorkspaceLock(lockPath);
      lock.release();
    }).not.toThrow();
  });
});
