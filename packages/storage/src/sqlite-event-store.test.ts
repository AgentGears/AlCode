import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkEventId,
  mkWorkspaceId,
  mkSessionId,
  asWorkspaceId,
  uuidv7,
  canonicalStringify,
} from "@alcode/events";
import {
  type WorkspaceEventStore,
  EventIdentityConflictError,
  IdempotencyConflictError,
  WorkspaceIdMismatchError,
  WorkspaceMismatchError,
  EventIntegrityError,
  computeRequestFingerprint,
  openLockedWorkspaceStore,
  type LockedWorkspaceStore,
} from "./index.ts";
import { createOrderedClose } from "./sqlite-event-store.ts";
// Internal imports (not from public barrel): used only by migration tests
import { initWorkspaceDb, bindWorkspace } from "./schema.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

const TEST_WS = asWorkspaceId(uuidv7()) as string;
const TEST_REPO = uuidv7();

/** Skip tests that require workspace locking on Windows (no LockFileEx binding yet). */
const describeLocked = process.platform === "win32" ? describe.skip : describe;

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

/** Open a locked store with lock + DB in a temp dir. */
async function openStore(dbPath: string): Promise<LockedWorkspaceStore> {
  const lockPath = dbPath.replace(".sqlite", ".lock");
  return openLockedWorkspaceStore({ databasePath: dbPath, lockPath, workspaceId: TEST_WS, repositoryId: TEST_REPO });
}

describeLocked("SqliteEventStore — basic operations", () => {
  let dir: string;
  let rt: LockedWorkspaceStore;
  let store: WorkspaceEventStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "alcode-"));
    rt = await openStore(join(dir, "ws.sqlite"));
    store = rt.store;
  });
  afterEach(() => { rt.close(); });

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
    rt.close();
    rt = await openStore(join(dir, "ws.sqlite"));
    store = rt.store;
    expect(await store.headSequence()).toBe(1);
    const found = await store.get(draft.eventId as string);
    expect(found).toBeDefined();
    expect((found!.payload as { hello: string }).hello).toBe("world");
  });

  it("getVerifiedEvents returns verified events after a sequence", async () => {
    await store.append([makeDraft(), makeDraft(), makeDraft(), makeDraft()]);
    const events = store.getVerifiedEvents(2, 10);
    expect(events.length).toBe(2);
    expect(events[0]).toHaveProperty("sequence");
    expect(events[0]).toHaveProperty("eventDigest");
  });
});

describeLocked("SqliteEventStore — workspace binding via openLockedWorkspaceStore", () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "alcode-ws-")); });

  it("openLockedWorkspaceStore initializes and binds", async () => {
    const rt = await openStore(join(dir, "ws.sqlite"));
    expect(rt.store.workspaceId).toBe(TEST_WS);
    rt.close();
  });

  it("openLockedWorkspaceStore rejects mismatched workspaceId on reopen", async () => {
    const dbPath = join(dir, "ws.sqlite");
    const lockPath = join(dir, "ws.lock");
    (await openLockedWorkspaceStore({ databasePath: dbPath, lockPath, workspaceId: TEST_WS, repositoryId: TEST_REPO })).close();
    await expect(openLockedWorkspaceStore({ databasePath: dbPath, lockPath, workspaceId: "other-ws", repositoryId: TEST_REPO })).rejects.toThrow(WorkspaceMismatchError);
  });

  it("append rejects drafts with a different workspaceId", async () => {
    const rt = await openStore(join(dir, "ws.sqlite"));
    const otherWs = mkWorkspaceId() as string;
    await expect(rt.store.append([makeDraft({ workspaceId: otherWs })])).rejects.toThrow(WorkspaceIdMismatchError);
    rt.close();
  });
});

describeLocked("SqliteEventStore — idempotency with conflict detection", () => {
  let dir: string;
  let rt: LockedWorkspaceStore;
  let store: WorkspaceEventStore;

  beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), "alcode-idem-")); rt = await openStore(join(dir, "ws.sqlite")); store = rt.store; });
  afterEach(() => { rt.close(); });

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

  it("same eventId + same content + DIFFERENT idempotencyKey → throws EventIdentityConflictError", async () => {
    const draft = makeDraft();
    await store.append([draft]);
    await expect(store.append([{ ...draft, idempotencyKey: "new-key" }])).rejects.toThrow(EventIdentityConflictError);
  });

  it("same idempotencyKey + same content + DIFFERENT eventId → returns existing (key path)", async () => {
    const key = "op-same";
    const d1 = makeDraft({ idempotencyKey: key });
    const d2 = { ...d1, eventId: mkEventId() };
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

describeLocked("SqliteEventStore — verified reads (integrity)", () => {
  let dir: string;
  let rt: LockedWorkspaceStore;
  let store: WorkspaceEventStore;
  let db: import("better-sqlite3").Database;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "alcode-integ-"));
    rt = await openStore(join(dir, "ws.sqlite"));
    store = rt.store;
  });
  afterEach(() => { rt.close(); });

  it("get() throws EventIntegrityError on tampered payload", async () => {
    const draft = makeDraft({ payload: { original: true } });
    await store.append([draft]);
    // Access DB directly (bypass the store) to tamper
    db = Database(join(dir, "ws.sqlite"));
    db.prepare("UPDATE events SET payload = ? WHERE event_id = ?").run(JSON.stringify({ tampered: true }), draft.eventId);
    await expect(store.get(draft.eventId as string)).rejects.toThrow(EventIntegrityError);
    db.close();
  });

  it("replay() throws EventIntegrityError on tampered digest", async () => {
    const draft = makeDraft();
    await store.append([draft]);
    db = Database(join(dir, "ws.sqlite"));
    db.prepare("UPDATE events SET event_digest = ? WHERE event_id = ?").run("0".repeat(64), draft.eventId);
    db.close();
    await expect(async () => {
      for await (const _ of store.replay()) { void _; }
    }).rejects.toThrow(EventIntegrityError);
  });

  it("get() on a clean event returns the event (digest matches)", async () => {
    const draft = makeDraft({ payload: { test: true } });
    await store.append([draft]);
    const found = await store.get(draft.eventId as string);
    expect(found).toBeDefined();
    expect(found!.eventDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describeLocked("SqliteEventStore — schema migration v1→v2", () => {
  it("migrates a v1 database with a valid digest (verifies, not rewrites)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-mig-"));
    const dbPath = join(dir, "ws.sqlite");
    const lockPath = join(dir, "ws.lock");

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

    // Insert a v1 event with a REAL digest (computed from the same algorithm)
    const wsId = TEST_WS;
    const eventId = mkEventId() as string;
    const sessionId = mkSessionId() as string;
    const occurredAt = "2026-08-06T00:00:00.000Z";
    const recordedAt = "2026-08-06T00:00:00.000Z";
    const payload = { value: 42 };
    const producer = { kind: "runtime", component: "test" };

    const digestInput = {
      eventId, workspaceId: wsId, sessionId, occurredAt,
      type: "test.event", payload, payloadSchemaVersion: 1, producer,
      sequence: 1, recordedAt,
    };
    const realDigest = createHash("sha256").update(canonicalStringify(digestInput)).digest("hex");

    db.prepare(`INSERT INTO events (event_id, idempotency_key, sequence, workspace_id, session_id,
      operation_id, type, payload, payload_schema_version, producer, causation_event_id, correlation_id,
      occurred_at, recorded_at, event_digest) VALUES (?,NULL,1,?,?,NULL,?,?,?,?,NULL,NULL,?,?,?)`).run(
      eventId, wsId, sessionId, "test.event", JSON.stringify(payload), 1, JSON.stringify(producer),
      occurredAt, recordedAt, realDigest,
    );
    db.close();

    // Now open via openLockedWorkspaceStore — should migrate v1→v2
    const rt = await openLockedWorkspaceStore({ databasePath: dbPath, lockPath, workspaceId: wsId, repositoryId: TEST_REPO });
    expect(await rt.store.headSequence()).toBe(1);
    const found = await rt.store.get(eventId);
    expect(found).toBeDefined();

    // Verify repository_id was permanently bound (not "__migrating__")
    const db2 = new Database(dbPath);
    const meta = db2.prepare("SELECT repository_id FROM workspace_metadata WHERE singleton = 1").get() as { repository_id: string };
    expect(meta.repository_id).toBe(TEST_REPO);
    db2.close();

    rt.close();
  });

  it("migration fails closed on corrupted v1 digest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-mig-corrupt-"));
    const dbPath = join(dir, "ws.sqlite");
    const lockPath = join(dir, "ws.lock");

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

    // Insert a v1 event with a FAKE digest (does not match content)
    db.prepare(`INSERT INTO events (event_id, idempotency_key, sequence, workspace_id, session_id,
      operation_id, type, payload, payload_schema_version, producer, causation_event_id, correlation_id,
      occurred_at, recorded_at, event_digest) VALUES (?,NULL,1,?,?,NULL,?,?,?,?,NULL,NULL,?,?,?)`).run(
      "fake-event-id", TEST_WS, "fake-session", "test.event",
      JSON.stringify({ value: 1 }), 1, JSON.stringify({ kind: "runtime", component: "test" }),
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "0".repeat(64),
    );
    db.close();

    // Migration should fail because the digest doesn't match
    await expect(openLockedWorkspaceStore({
      databasePath: dbPath, lockPath, workspaceId: TEST_WS, repositoryId: TEST_REPO,
    })).rejects.toThrow(/does not match/);
  });
});

describe("workspace lock — cross-process contention", () => {
  it("process B fails while process A holds the lock (POSIX only)", { timeout: 15000 }, async () => {
    if (process.platform === "win32") { expect(true).toBe(true); return; }

    const { acquireWorkspaceLock } = await import("@alcode/workspace");
    const lockPath = join(mkdtempSync(join(tmpdir(), "alcode-lock-")), "test.lock");
    const lockA = acquireWorkspaceLock(lockPath);

    const result = await new Promise<{ exitCode: number; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "-e",
        `import { acquireWorkspaceLock } from "@alcode/workspace";
         try { acquireWorkspaceLock(${JSON.stringify(lockPath)}); console.log("ACQUIRED"); process.exit(0); }
         catch { console.log("FAILED"); process.exit(1); }`,
      ], { cwd: process.cwd(), env: { ...process.env, NODE_PATH: join(process.cwd(), "node_modules") } });
      let stdout = "";
      child.stdout?.on("data", (d) => { stdout += d; });
      child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout }));
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("FAILED");
    lockA.release();

    const resultC = await new Promise<{ exitCode: number; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "-e",
        `import { acquireWorkspaceLock } from "@alcode/workspace";
         try { const l = acquireWorkspaceLock(${JSON.stringify(lockPath)}); console.log("ACQUIRED"); l.release(); process.exit(0); }
         catch { console.log("FAILED"); process.exit(1); }`,
      ], { cwd: process.cwd(), env: { ...process.env, NODE_PATH: join(process.cwd(), "node_modules") } });
      let stdout = "";
      child.stdout?.on("data", (d) => { stdout += d; });
      child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout }));
    });
    expect(resultC.exitCode).toBe(0);
    expect(resultC.stdout).toContain("ACQUIRED");
  });

  it("crash release: child exits without release, parent acquires", { timeout: 15000 }, async () => {
    if (process.platform === "win32") { expect(true).toBe(true); return; }

    const { acquireWorkspaceLock } = await import("@alcode/workspace");
    const lockPath = join(mkdtempSync(join(tmpdir(), "alcode-crash-")), "crash.lock");

    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "-e",
        `import { acquireWorkspaceLock } from "@alcode/workspace";
         acquireWorkspaceLock(${JSON.stringify(lockPath)}); console.log("LOCKED"); process.exit(0);`,
      ], { cwd: process.cwd(), env: { ...process.env, NODE_PATH: join(process.cwd(), "node_modules") } });
      child.on("close", () => resolve());
    });

    expect(() => {
      const lock = acquireWorkspaceLock(lockPath);
      lock.release();
    }).not.toThrow();
  });
});

describe("openLockedWorkspaceStore — enforced lifecycle", () => {
  const describeLocked2 = process.platform === "win32" ? describe.skip : describe;

  describeLocked2("open → second fails → close → reopen", () => {
    let dir: string;

    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "alcode-life-")); });

    it("first handle opens successfully", async () => {
      const rt = await openLockedWorkspaceStore({
        databasePath: join(dir, "ws.sqlite"), lockPath: join(dir, "ws.lock"),
        workspaceId: TEST_WS, repositoryId: TEST_REPO,
      });
      expect(rt.store.workspaceId).toBe(TEST_WS);
      rt.close();
    });

    it("second handle cannot open while first is live", async () => {
      const rt1 = await openLockedWorkspaceStore({
        databasePath: join(dir, "ws.sqlite"), lockPath: join(dir, "ws.lock"),
        workspaceId: TEST_WS, repositoryId: TEST_REPO,
      });
      await expect(openLockedWorkspaceStore({
        databasePath: join(dir, "ws.sqlite"), lockPath: join(dir, "ws.lock"),
        workspaceId: TEST_WS, repositoryId: TEST_REPO,
      })).rejects.toThrow(/lock/);
      rt1.close();
    });

    it("close() closes SQLite and releases lock; new handle opens", async () => {
      const rt1 = await openLockedWorkspaceStore({
        databasePath: join(dir, "ws.sqlite"), lockPath: join(dir, "ws.lock"),
        workspaceId: TEST_WS, repositoryId: TEST_REPO,
      });
      await rt1.store.append([makeDraft()]);
      expect(await rt1.store.headSequence()).toBe(1);
      rt1.close();

      // A new handle can open immediately
      const rt2 = await openLockedWorkspaceStore({
        databasePath: join(dir, "ws.sqlite"), lockPath: join(dir, "ws.lock"),
        workspaceId: TEST_WS, repositoryId: TEST_REPO,
      });
      expect(await rt2.store.headSequence()).toBe(1); // data persisted
      rt2.close();
    });

    it("public package surface has no constructor accepting a raw database", async () => {
      // The WorkspaceEventStore is an interface, not a class. There is no
      // exported constructor or factory that takes a Database handle.
      // Verify the exported names do not include the implementation class.
      const mod = await import("./index.ts");
      expect((mod as Record<string, unknown>).SqliteEventStoreImpl).toBeUndefined();
      expect((mod as Record<string, unknown>).SqliteEventStore).toBeUndefined();
      expect(typeof mod.openLockedWorkspaceStore).toBe("function");
    });

    it("store facade does not expose the implementation constructor", async () => {
      const rt = await openLockedWorkspaceStore({
        databasePath: join(dir, "ws.sqlite"), lockPath: join(dir, "ws.lock"),
        workspaceId: TEST_WS, repositoryId: TEST_REPO,
      });
      // With Object.create(null), there is no .constructor on the facade
      expect((rt.store as object).constructor).toBeUndefined();
      rt.close();
    });

    it("initWorkspaceDb and bindWorkspace are NOT exported from the public barrel", async () => {
      const mod = await import("./index.ts");
      expect((mod as Record<string, unknown>).initWorkspaceDb).toBeUndefined();
      expect((mod as Record<string, unknown>).bindWorkspace).toBeUndefined();
    });
  });

  describeLocked2("normal close is idempotent", () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "alcode-close-")); });

    it("repeated close() calls are no-ops after the first", async () => {
      const rt = await openLockedWorkspaceStore({
        databasePath: join(dir, "ws.sqlite"), lockPath: join(dir, "ws.lock"),
        workspaceId: TEST_WS, repositoryId: TEST_REPO,
      });
      rt.close();
      expect(() => rt.close()).not.toThrow();
      expect(() => rt.close()).not.toThrow();
    });
  });
});

describe("createOrderedClose — injected failure contract", () => {
  // These tests are platform-independent (no locks, no SQLite).
  // They prove the state-machine ordering: DB close must succeed
  // before the lock releases.

  it("DB close failure propagates and lock is NOT released", () => {
    let failClose = true;
    let releaseCount = 0;

    const close = createOrderedClose(
      () => { if (failClose) throw new Error("injected close failure"); },
      () => { releaseCount++; },
    );

    expect(close).toThrow("injected close failure");
    expect(releaseCount).toBe(0);
  });

  it("retry after failure: success releases lock", () => {
    let failClose = true;
    let releaseCount = 0;

    const close = createOrderedClose(
      () => { if (failClose) throw new Error("injected close failure"); },
      () => { releaseCount++; },
    );

    // First attempt fails
    expect(close).toThrow("injected close failure");
    expect(releaseCount).toBe(0);

    // Retry: close now succeeds
    failClose = false;
    expect(close).not.toThrow();
    expect(releaseCount).toBe(1);
  });

  it("idempotent: repeated close after success is a no-op", () => {
    let releaseCount = 0;

    const close = createOrderedClose(
      () => {},
      () => { releaseCount++; },
    );

    close();
    expect(releaseCount).toBe(1);

    close();
    expect(releaseCount).toBe(1); // no additional releases
  });
});

// ---------------------------------------------------------------------------
// Step 5: Secret admission integration tests
// ---------------------------------------------------------------------------

const FAKE_GITHUB_TOKEN = "ghp_" + "A".repeat(36);
const FAKE_AWS_KEY = "AKIA" + "B".repeat(16);

describeLocked("SqliteEventStore — secret admission in append()", () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "alcode-sec-")); });

  it("secret in payload is redacted before persistence", async () => {
    const dbPath = join(dir, "ws.sqlite");
    const lockPath = join(dir, "ws.lock");
    const rt = await openLockedWorkspaceStore({
      databasePath: dbPath, lockPath, workspaceId: TEST_WS, repositoryId: TEST_REPO,
    });

    const draft = makeDraft({ payload: { token: FAKE_GITHUB_TOKEN } });
    await rt.store.append([draft]);
    rt.close();

    // Query the DB directly — no secret bytes should exist
    const db = Database(dbPath);
    const row = db.prepare("SELECT payload FROM events WHERE event_id = ?").get(draft.eventId) as { payload: string };
    db.close();
    expect(row.payload).not.toContain(FAKE_GITHUB_TOKEN);
    expect(row.payload).not.toContain("ghp_");
    expect(row.payload).toContain("secretref:");
  });

  it("secret in identifier field is rejected (no persistence)", async () => {
    const dbPath = join(dir, "ws2.sqlite");
    const lockPath = join(dir, "ws2.lock");
    const rt = await openLockedWorkspaceStore({
      databasePath: dbPath, lockPath, workspaceId: TEST_WS, repositoryId: TEST_REPO,
    });

    const draft = makeDraft({ idempotencyKey: FAKE_GITHUB_TOKEN });
    await expect(rt.store.append([draft])).rejects.toThrow(/Secret admission/);
    expect(await rt.store.headSequence()).toBe(0); // nothing persisted
    rt.close();
  });

  it("mixed batch: secret rejection prevents all drafts from persisting", async () => {
    const dbPath = join(dir, "ws3.sqlite");
    const lockPath = join(dir, "ws3.lock");
    const rt = await openLockedWorkspaceStore({
      databasePath: dbPath, lockPath, workspaceId: TEST_WS, repositoryId: TEST_REPO,
    });

    const safeDraft = makeDraft({ payload: { value: "safe" } });
    const secretDraft = makeDraft({ idempotencyKey: FAKE_GITHUB_TOKEN });
    await expect(rt.store.append([safeDraft, secretDraft])).rejects.toThrow(/Secret admission/);
    expect(await rt.store.headSequence()).toBe(0); // nothing persisted at all
    rt.close();
  });

  it("reopen and replay returns only admitted payloads", async () => {
    const dbPath = join(dir, "ws4.sqlite");
    const lockPath = join(dir, "ws4.lock");
    const opts = { databasePath: dbPath, lockPath, workspaceId: TEST_WS, repositoryId: TEST_REPO };

    const rt1 = await openLockedWorkspaceStore(opts);
    const draft = makeDraft({ payload: { token: FAKE_GITHUB_TOKEN, safe: "hello" } });
    await rt1.store.append([draft]);
    rt1.close();

    // Reopen
    const rt2 = await openLockedWorkspaceStore(opts);
    const found = await rt2.store.get(draft.eventId as string);
    expect(found).toBeDefined();
    const payload = found!.payload as { token: string; safe: string };
    expect(payload.token).toContain("secretref:");
    expect(payload.safe).toBe("hello");
    rt2.close();
  });

  it("raw DB + WAL bytes contain no secret after append (while open)", async () => {
    const dbPath = join(dir, "ws5.sqlite");
    const lockPath = join(dir, "ws5.lock");
    const configuredVal = "my-configured-secret-12345678";
    const rt = await openLockedWorkspaceStore({
      databasePath: dbPath, lockPath, workspaceId: TEST_WS, repositoryId: TEST_REPO,
      secretConfig: { configuredSecrets: [{ name: "TEST", value: configuredVal }] },
    });

    // Append multiple secrets (structured + embedded configured)
    await rt.store.append([
      makeDraft({ payload: { token: FAKE_GITHUB_TOKEN, key: FAKE_AWS_KEY, text: `Bearer ${configuredVal}` } }),
    ]);

    // While the store is still open, byte-scan the DB and WAL files
    const { readFileSync, existsSync } = await import("node:fs");
    const walPath = dbPath + "-wal";
    const shmPath = dbPath + "-shm";
    // Assert WAL exists while store is open (we claim active-WAL scan)
    expect(existsSync(walPath)).toBe(true);
    const filesToScan = [dbPath, walPath, shmPath].filter(existsSync);
    for (const f of filesToScan) {
      const bytes = readFileSync(f);
      expect(bytes.includes(Buffer.from(FAKE_GITHUB_TOKEN, "utf8"))).toBe(false);
      expect(bytes.includes(Buffer.from("ghp_", "utf8"))).toBe(false);
      expect(bytes.includes(Buffer.from(FAKE_AWS_KEY, "utf8"))).toBe(false);
      expect(bytes.includes(Buffer.from("AKIA", "utf8"))).toBe(false);
      expect(bytes.includes(Buffer.from(configuredVal, "utf8"))).toBe(false);
    }

    rt.close();

    // After close (checkpoint), scan the main DB again
    if (existsSync(dbPath)) {
      const bytes = readFileSync(dbPath);
      expect(bytes.includes(Buffer.from(FAKE_GITHUB_TOKEN, "utf8"))).toBe(false);
      expect(bytes.includes(Buffer.from(configuredVal, "utf8"))).toBe(false);
    }
  });

  it("adversarial batch: payload secrets admitted (redacted) + safe content persisted", async () => {
    const dbPath = join(dir, "ws6.sqlite");
    const lockPath = join(dir, "ws6.lock");
    const configuredVal = "another-configured-secret-abcdefgh";
    const rt = await openLockedWorkspaceStore({
      databasePath: dbPath, lockPath, workspaceId: TEST_WS, repositoryId: TEST_REPO,
      secretConfig: { configuredSecrets: [{ name: "TEST", value: configuredVal }] },
    });

    const safeDraft = makeDraft({ payload: { value: "safe" } });
    const secretPayloadDraft = makeDraft({
      payload: { text: `${FAKE_GITHUB_TOKEN} and ${FAKE_AWS_KEY} Bearer ${configuredVal}` },
    });

    // Payload secrets are admitted (redacted), not rejected — both drafts persist
    const results = await rt.store.append([safeDraft, secretPayloadDraft]);
    expect(results.length).toBe(2);
    expect(await rt.store.headSequence()).toBe(2);

    // Verify the safe draft is unchanged
    const safeFound = await rt.store.get(safeDraft.eventId as string);
    expect((safeFound!.payload as { value: string }).value).toBe("safe");

    // Verify the secret payload draft is redacted
    const secretFound = await rt.store.get(secretPayloadDraft.eventId as string);
    const secretPayload = secretFound!.payload as { text: string };
    expect(secretPayload.text).not.toContain(FAKE_GITHUB_TOKEN);
    expect(secretPayload.text).not.toContain(FAKE_AWS_KEY);
    expect(secretPayload.text).not.toContain(configuredVal);
    expect(secretPayload.text).toContain("secretref:");

    rt.close();

    // Byte-scan the closed DB
    const { readFileSync, existsSync } = await import("node:fs");
    if (existsSync(dbPath)) {
      const bytes = readFileSync(dbPath);
      expect(bytes.includes(Buffer.from(FAKE_GITHUB_TOKEN, "utf8"))).toBe(false);
      expect(bytes.includes(Buffer.from(configuredVal, "utf8"))).toBe(false);
    }
  });

  it("adversarial: batch with secret in identifier → zero persisted", async () => {
    const dbPath = join(dir, "ws7.sqlite");
    const lockPath = join(dir, "ws7.lock");
    const rt = await openLockedWorkspaceStore({
      databasePath: dbPath, lockPath, workspaceId: TEST_WS, repositoryId: TEST_REPO,
    });

    const safeDraft = makeDraft({ payload: { value: "safe" } });
    const secretDraft = makeDraft({ idempotencyKey: FAKE_GITHUB_TOKEN });

    await expect(rt.store.append([safeDraft, secretDraft])).rejects.toThrow(/Secret admission/);
    expect(await rt.store.headSequence()).toBe(0);

    // Verify safe draft was NOT persisted
    const found = await rt.store.get(safeDraft.eventId as string);
    expect(found).toBeUndefined();

    rt.close();
  });

  it("admitted payload secrets: all raw bytes clean after batch", async () => {
    const dbPath = join(dir, "ws8.sqlite");
    const lockPath = join(dir, "ws8.lock");
    const rt = await openLockedWorkspaceStore({
      databasePath: dbPath, lockPath, workspaceId: TEST_WS, repositoryId: TEST_REPO,
    });

    // Batch with multiple secret types in payload (should be admitted, not rejected)
    const draft = makeDraft({
      payload: {
        github: FAKE_GITHUB_TOKEN,
        aws: FAKE_AWS_KEY,
        mixed: `${FAKE_GITHUB_TOKEN} text ${FAKE_AWS_KEY}`,
      },
    });

    const [admitted] = await rt.store.append([draft]);
    expect(admitted).toBeDefined();
    rt.close();

    // Byte-scan the closed DB
    const { readFileSync, existsSync } = await import("node:fs");
    if (existsSync(dbPath)) {
      const bytes = readFileSync(dbPath);
      expect(bytes.includes(Buffer.from(FAKE_GITHUB_TOKEN, "utf8"))).toBe(false);
      expect(bytes.includes(Buffer.from("ghp_", "utf8"))).toBe(false);
      expect(bytes.includes(Buffer.from(FAKE_AWS_KEY, "utf8"))).toBe(false);
      expect(bytes.includes(Buffer.from("AKIA", "utf8"))).toBe(false);
      expect(bytes.includes(Buffer.from("secretref:", "utf8"))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Step 6: Projection transaction model tests
// ---------------------------------------------------------------------------

import {
  type ProjectionDefinition,
  type ProjectionCursor,
  CursorAheadOfHeadError,
  SchemaVersionMismatchError,
  InvalidProjectionNameError,
  ClassificationMismatchError,
  InlineProjectionInRunnerError,
  InactiveTransactionError,
  UnregisteredStatementError,
  ReservedTableInStatementError,
} from "./index.ts";

describeLocked("ProjectionRunner — enforced encapsulation", () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "alcode-proj-")); });

  async function setupWithEvents(count: number) {
    const rt = await openStore(join(dir, "ws.sqlite"));
    const drafts = [];
    for (let i = 0; i < count; i++) {
      drafts.push(makeDraft({ payload: { index: i } }));
    }
    await rt.store.append(drafts);
    return rt;
  }

  const memStmt = {
    name: "upsert-memory",
    sql: "INSERT OR REPLACE INTO memories (memory_id, workspace_id, type, body, created_sequence) VALUES (?, ?, ?, ?, ?)",
  };

  function makeProjection(name: string, opts?: Partial<ProjectionDefinition>): ProjectionDefinition {
    return {
      name,
      schemaVersion: 1,
      classification: "derived",
      statements: [memStmt],
      apply(event, tx) {
        tx.exec("upsert-memory", `proj-${event.sequence}`, TEST_WS, "test", "{}", event.sequence);
      },
      ...opts,
    };
  }

  // 1. Successful apply commits projection state and cursor together
  it("1: successful apply commits both state and cursor", async () => {
    const rt = await setupWithEvents(3);
    const runner = rt.store.getProjectionRunner();
    const result = runner.catchUp(makeProjection("test-proj"));
    expect(result.appliedCount).toBe(3);
    expect(result.newCursor.lastAppliedEventSequence).toBe(3);
    expect(runner.getCursor("test-proj").lastAppliedEventSequence).toBe(3);
    rt.close();
  });

  // 2. Throw during apply rolls back both state and cursor
  it("2: throw during apply rolls back both", async () => {
    const rt = await setupWithEvents(2);
    const runner = rt.store.getProjectionRunner();
    const proj = makeProjection("throw-proj", {
      apply(event, tx) {
        tx.exec("upsert-memory", `throw-${event.sequence}`, TEST_WS, "test", "{}", event.sequence);
        throw new Error("injected failure");
      },
    });
    expect(() => runner.catchUp(proj)).toThrow("injected failure");
    expect(runner.getCursor("throw-proj").lastAppliedEventSequence).toBe(0);
    rt.close();
  });

  // 3. Retry from unchanged cursor succeeds
  it("3: retry from unchanged cursor succeeds", async () => {
    const rt = await setupWithEvents(2);
    const runner = rt.store.getProjectionRunner();
    let failOnSeq = 2;
    const proj = makeProjection("retry-proj", {
      apply(event, tx) {
        if (event.sequence === failOnSeq) throw new Error("retry-me");
        tx.exec("upsert-memory", `retry-${event.sequence}`, TEST_WS, "test", "{}", event.sequence);
      },
    });
    expect(() => runner.catchUp(proj)).toThrow("retry-me");
    expect(runner.getCursor("retry-proj").lastAppliedEventSequence).toBe(1);
    failOnSeq = -1;
    const result = runner.catchUp(proj);
    expect(result.appliedCount).toBe(1);
    expect(result.newCursor.lastAppliedEventSequence).toBe(2);
    rt.close();
  });

  // 4. Two projections advance independently
  it("4: two projections advance independently", async () => {
    const rt = await setupWithEvents(3);
    const runner = rt.store.getProjectionRunner();
    runner.catchUp(makeProjection("proj-a"), 2);
    runner.catchUp(makeProjection("proj-b"));
    expect(runner.getCursor("proj-a").lastAppliedEventSequence).toBe(2);
    expect(runner.getCursor("proj-b").lastAppliedEventSequence).toBe(3);
    rt.close();
  });

  // 5. Failing projection does not affect another's cursor
  it("5: failing projection does not affect another", async () => {
    const rt = await setupWithEvents(2);
    const runner = rt.store.getProjectionRunner();
    runner.catchUp(makeProjection("good-proj"));
    expect(runner.getCursor("good-proj").lastAppliedEventSequence).toBe(2);
    const badProj = makeProjection("bad-proj", { apply() { throw new Error("always"); } });
    expect(() => runner.catchUp(badProj)).toThrow();
    expect(runner.getCursor("good-proj").lastAppliedEventSequence).toBe(2);
    rt.close();
  });

  // 6. Lagging cursor catches up in order
  it("6: lagging cursor catches up in order", async () => {
    const rt = await setupWithEvents(5);
    const runner = rt.store.getProjectionRunner();
    let result = runner.catchUp(makeProjection("catchup-proj"), 2);
    expect(result.appliedCount).toBe(2);
    expect(result.newCursor.lastAppliedEventSequence).toBe(2);
    result = runner.catchUp(makeProjection("catchup-proj"), 10);
    expect(result.appliedCount).toBe(3);
    expect(result.newCursor.lastAppliedEventSequence).toBe(5);
    expect(result.caught).toBe(true);
    rt.close();
  });

  // 7. Cursor ahead of head fails closed
  it("7: cursor ahead of head fails closed", async () => {
    const rt = await setupWithEvents(3);
    const runner = rt.store.getProjectionRunner();
    const db = Database(join(dir, "ws.sqlite"));
    db.prepare(
      "INSERT INTO projection_cursors (projection_name, last_applied_event_sequence, projection_schema_version, classification) VALUES (?, ?, ?, ?)",
    ).run("ahead-proj", 99, 1, "derived");
    db.close();
    expect(() => runner.catchUp(makeProjection("ahead-proj"))).toThrow(CursorAheadOfHeadError);
    rt.close();
  });

  // 8. Schema version mismatch fails closed
  it("8: schema version mismatch fails closed", async () => {
    const rt = await setupWithEvents(1);
    const runner = rt.store.getProjectionRunner();
    runner.catchUp(makeProjection("sv-proj"));
    const v2Proj = makeProjection("sv-proj", { schemaVersion: 2 });
    expect(() => runner.catchUp(v2Proj)).toThrow(SchemaVersionMismatchError);
    rt.close();
  });

  // 9. Reapplication is idempotent
  it("9: reapplication is idempotent (no duplicates)", async () => {
    const rt = await setupWithEvents(3);
    const runner = rt.store.getProjectionRunner();
    runner.catchUp(makeProjection("idem-proj"));
    const result = runner.catchUp(makeProjection("idem-proj"));
    expect(result.appliedCount).toBe(0);
    expect(result.caught).toBe(true);
    const db = Database(join(dir, "ws.sqlite"));
    const count = db.prepare("SELECT COUNT(*) as c FROM memories WHERE type = 'test'").get() as { c: number };
    db.close();
    expect(count.c).toBe(3);
    rt.close();
  });

  // 10. Invalid projection name fails
  it("10: invalid projection name fails", async () => {
    const rt = await setupWithEvents(1);
    const runner = rt.store.getProjectionRunner();
    expect(() => runner.catchUp(makeProjection("bad name"))).toThrow(InvalidProjectionNameError);
    rt.close();
  });

  // 11. Public surface has no escape hatches
  it("11: store has no advanceCursor or transaction", async () => {
    const rt = await setupWithEvents(1);
    const store = rt.store as unknown as Record<string, unknown>;
    expect(store.advanceCursor).toBeUndefined();
    expect(store.transaction).toBeUndefined();
    rt.close();
  });

  // 12. New projection cursor starts at 0
  it("12: new projection cursor starts at 0", async () => {
    const rt = await setupWithEvents(1);
    const runner = rt.store.getProjectionRunner();
    const cursor = runner.getCursor("never-applied");
    expect(cursor.lastAppliedEventSequence).toBe(0);
    rt.close();
  });

  // 13. Returned runner has null prototype, no constructor, no db
  it("13: runner facade has null prototype and no constructor", async () => {
    const rt = await setupWithEvents(1);
    const runner = rt.store.getProjectionRunner();
    expect(Object.getPrototypeOf(runner)).toBe(null);
    expect((runner as object).constructor).toBeUndefined();
    expect((runner as Record<string, unknown>).db).toBeUndefined();
    rt.close();
  });

  // 14. catchUp takes no event provider argument
  it("14: catchUp signature has no provider parameter", async () => {
    const rt = await setupWithEvents(1);
    const runner = rt.store.getProjectionRunner();
    // The method exists and takes (projection, limit?) — no provider
    expect(runner.catchUp.length).toBeLessThanOrEqual(2);
    rt.close();
  });

  // 15. Unregistered statement name is rejected
  it("15: unregistered statement name is rejected", async () => {
    const rt = await setupWithEvents(1);
    const runner = rt.store.getProjectionRunner();
    const proj = makeProjection("unreg-proj", {
      statements: [memStmt],
      apply(_event, tx) {
        tx.exec("evil-statement", "whatever");
      },
    });
    expect(() => runner.catchUp(proj)).toThrow(UnregisteredStatementError);
    rt.close();
  });

  // 16. Reserved table in statement is rejected at registration
  it("16: reserved table in statement is rejected", async () => {
    const rt = await setupWithEvents(1);
    const runner = rt.store.getProjectionRunner();
    const proj = makeProjection("reserved-proj", {
      statements: [
        memStmt,
        { name: "evil", sql: "DELETE FROM events" },
      ],
      apply(_event, tx) {
        tx.exec("evil");
      },
    });
    expect(() => runner.catchUp(proj)).toThrow(ReservedTableInStatementError);
    rt.close();
  });

  // 17. Captured transaction throws after apply exits
  it("17: captured tx throws after apply exits", async () => {
    const rt = await setupWithEvents(1);
    const runner = rt.store.getProjectionRunner();
    let escapedTx: { exec: (name: string, ...params: unknown[]) => void } | undefined;
    const proj = makeProjection("escape-proj", {
      apply(_event, tx) {
        escapedTx = tx;
      },
    });
    runner.catchUp(proj);
    // Attempt to use the escaped tx
    expect(() => escapedTx!.exec("upsert-memory", "x", "y", "z", "{}", 1)).toThrow(InactiveTransactionError);
    rt.close();
  });

  // 18. Classification is persisted and survives reopen
  it("18: classification persisted and survives reopen", async () => {
    const rt = await setupWithEvents(1);
    const runner = rt.store.getProjectionRunner();
    const proj = makeProjection("class-proj", { classification: "critical" });
    runner.catchUp(proj);
    rt.close();

    const rt2 = await openStore(join(dir, "ws.sqlite"));
    const runner2 = rt2.store.getProjectionRunner();
    const cursor = runner2.getCursor("class-proj");
    expect(cursor.classification).toBe("critical");
    rt2.close();
  });

  // 19. Classification mismatch fails
  it("19: classification mismatch fails", async () => {
    const rt = await setupWithEvents(1);
    const runner = rt.store.getProjectionRunner();
    runner.catchUp(makeProjection("mismatch-proj", { classification: "critical" }));
    expect(() => runner.catchUp(makeProjection("mismatch-proj", { classification: "derived" }))).toThrow(ClassificationMismatchError);
    rt.close();
  });

  // 20. Inline classification rejected by runner
  it("20: inline projection rejected by runner", async () => {
    const rt = await setupWithEvents(1);
    const runner = rt.store.getProjectionRunner();
    const proj = makeProjection("inline-proj", { classification: "inline" as "critical" | "derived" });
    expect(() => runner.catchUp(proj)).toThrow(InlineProjectionInRunnerError);
    rt.close();
  });

  // 21. Exactly limit remaining events ending at head → caught: true
  it("21: exactly limit events at head returns caught: true", async () => {
    const rt = await setupWithEvents(3);
    const runner = rt.store.getProjectionRunner();
    const result = runner.catchUp(makeProjection("exact-proj"), 3); // exactly 3 events, limit=3
    expect(result.appliedCount).toBe(3);
    expect(result.caught).toBe(true); // cursor at head, not batch-size-limited
    rt.close();
  });
});
