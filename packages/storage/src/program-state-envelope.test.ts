import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EventDraft,
  asProgramStateId,
  canonicalStringify,
  mkEventId,
  mkProgramStateId,
  mkSessionId,
  mkWorkspaceId,
} from "@alcode/events";
import {
  computeRequestFingerprint,
  openLockedWorkspaceStore,
  SCHEMA_VERSION,
} from "./index.ts";
import { bindWorkspace, initWorkspaceDb } from "./schema.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

function makeDraft(
  workspaceId = mkWorkspaceId(),
  overrides: Partial<EventDraft<string, unknown>> = {},
): EventDraft<string, unknown> {
  return {
    eventId: mkEventId(),
    workspaceId,
    sessionId: mkSessionId(),
    occurredAt: "2026-08-16T00:00:00.000Z",
    type: "test.phase1.envelope",
    payload: { value: 1 },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "phase-1.0-test" },
    ...overrides,
  };
}

function legacyDigest(
  draft: EventDraft<string, unknown>,
  sequence: number,
  recordedAt: string,
): string {
  const input: Record<string, unknown> = {
    eventId: String(draft.eventId),
    workspaceId: String(draft.workspaceId),
    sessionId: String(draft.sessionId),
    occurredAt: draft.occurredAt,
    type: draft.type,
    payload: draft.payload,
    payloadSchemaVersion: draft.payloadSchemaVersion,
    producer: draft.producer,
    sequence,
    recordedAt,
  };
  if (draft.idempotencyKey !== undefined) input.idempotencyKey = draft.idempotencyKey;
  if (draft.operationId !== undefined) input.operationId = String(draft.operationId);
  if (draft.causationEventId !== undefined) input.causationEventId = String(draft.causationEventId);
  if (draft.correlationId !== undefined) input.correlationId = draft.correlationId;
  return createHash("sha256").update(canonicalStringify(input)).digest("hex");
}

function legacyFingerprint(draft: EventDraft<string, unknown>): string {
  const input = {
    workspaceId: String(draft.workspaceId),
    sessionId: String(draft.sessionId),
    operationId: draft.operationId ? String(draft.operationId) : null,
    type: draft.type,
    payload: draft.payload,
    payloadSchemaVersion: draft.payloadSchemaVersion,
    producer: draft.producer,
    causationEventId: draft.causationEventId ? String(draft.causationEventId) : null,
    correlationId: draft.correlationId ?? null,
    occurredAt: draft.occurredAt,
  };
  return createHash("sha256").update(canonicalStringify(input)).digest("hex");
}

describe("Phase 1.0 ProgramStateId envelope compatibility", () => {
  it("generates a real UUIDv7 ProgramStateId", () => {
    const before = Date.now();
    const id = mkProgramStateId();
    const after = Date.now();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const timestampMs = Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
    expect(timestampMs).toBeGreaterThanOrEqual(before);
    expect(timestampMs).toBeLessThanOrEqual(after);
  });

  it("rejects a non-v7 UUID as ProgramStateId", () => {
    expect(() => asProgramStateId("00000000-0000-4000-8000-000000000000")).toThrow(/UUIDv7/);
  });

  it("keeps a legacy request fingerprint byte-identical when programStateId is omitted", () => {
    const draft = makeDraft();
    expect(computeRequestFingerprint(draft)).toBe(legacyFingerprint(draft));

    const withProgram = { ...draft, programStateId: mkProgramStateId() };
    expect(computeRequestFingerprint(withProgram)).not.toBe(legacyFingerprint(draft));
  });

  it("persists and verifies a present ProgramStateId", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-envelope-"));
    const dbPath = join(dir, "ws.sqlite");
    const lockPath = join(dir, "ws.lock");
    const workspaceId = mkWorkspaceId();
    const repositoryId = "phase-1-repository";
    const programStateId = mkProgramStateId();
    const draft = makeDraft(workspaceId, { programStateId });

    const runtime = await openLockedWorkspaceStore({
      databasePath: dbPath,
      lockPath,
      workspaceId: String(workspaceId),
      repositoryId,
    });
    const [persisted] = await runtime.store.append([draft]);
    expect(persisted.programStateId).toBe(programStateId);
    runtime.close();

    const db = new Database(dbPath);
    const row = db.prepare(
      "SELECT program_state_id, event_digest, request_fingerprint FROM events WHERE event_id = ?",
    ).get(draft.eventId) as {
      program_state_id: string | null;
      event_digest: string;
      request_fingerprint: string;
    };
    expect(row.program_state_id).toBe(programStateId);
    expect(row.event_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(row.request_fingerprint).toBe(computeRequestFingerprint(draft));
    db.close();

    const reopened = await openLockedWorkspaceStore({
      databasePath: dbPath,
      lockPath,
      workspaceId: String(workspaceId),
      repositoryId,
    });
    const replayed = await reopened.store.get(String(draft.eventId));
    expect(replayed?.programStateId).toBe(programStateId);
    reopened.close();
  });

  it("rejects explicit undefined instead of materializing it as absence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-undefined-"));
    const dbPath = join(dir, "ws.sqlite");
    const lockPath = join(dir, "ws.lock");
    const workspaceId = mkWorkspaceId();
    const runtime = await openLockedWorkspaceStore({
      databasePath: dbPath,
      lockPath,
      workspaceId: String(workspaceId),
      repositoryId: "phase-1-repository",
    });
    const draft = makeDraft(workspaceId) as EventDraft<string, unknown> & { programStateId?: unknown };
    Object.defineProperty(draft, "programStateId", { value: undefined, enumerable: true });

    await expect(runtime.store.append([draft as EventDraft<string, unknown>])).rejects.toThrow(/explicit undefined/);
    expect(await runtime.store.headSequence()).toBe(0);
    runtime.close();
  });

  it("migrates v7 history without changing digest/fingerprint or inventing the Program key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-v7-"));
    const dbPath = join(dir, "ws.sqlite");
    const lockPath = join(dir, "ws.lock");
    const workspaceId = mkWorkspaceId();
    const repositoryId = "phase-1-repository";
    const draft = makeDraft(workspaceId);
    const recordedAt = "2026-08-16T00:00:01.000Z";
    const digest = legacyDigest(draft, 1, recordedAt);
    const fingerprint = legacyFingerprint(draft);

    const db = new Database(dbPath);
    initWorkspaceDb(db);
    bindWorkspace(db, String(workspaceId), repositoryId);
    db.exec("DROP INDEX idx_events_program_state");
    db.exec("ALTER TABLE events DROP COLUMN program_state_id");
    db.prepare("DELETE FROM schema_migrations").run();
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (7, ?)").run(recordedAt);
    db.prepare(`INSERT INTO events (
      event_id, idempotency_key, sequence, workspace_id, session_id, operation_id,
      type, payload, payload_schema_version, producer, causation_event_id,
      correlation_id, occurred_at, recorded_at, event_digest, request_fingerprint
    ) VALUES (?, NULL, 1, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`)
      .run(
        draft.eventId,
        workspaceId,
        draft.sessionId,
        draft.type,
        canonicalStringify(draft.payload),
        draft.payloadSchemaVersion,
        canonicalStringify(draft.producer),
        draft.occurredAt,
        recordedAt,
        digest,
        fingerprint,
      );
    db.close();

    const runtime = await openLockedWorkspaceStore({
      databasePath: dbPath,
      lockPath,
      workspaceId: String(workspaceId),
      repositoryId,
    });
    const found = await runtime.store.get(String(draft.eventId));
    expect(found).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(found, "programStateId")).toBe(false);
    expect(found!.eventDigest).toBe(digest);
    runtime.close();

    const migrated = new Database(dbPath);
    const row = migrated.prepare(
      "SELECT program_state_id, event_digest, request_fingerprint FROM events WHERE event_id = ?",
    ).get(draft.eventId) as {
      program_state_id: string | null;
      event_digest: string;
      request_fingerprint: string;
    };
    expect(row.program_state_id).toBeNull();
    expect(row.event_digest).toBe(digest);
    expect(row.request_fingerprint).toBe(fingerprint);
    const version = migrated.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
    expect(version.version).toBe(SCHEMA_VERSION);
    migrated.close();
  });

  it("preserves omission through the v1 fingerprint-backfill/table-copy migration path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-v1-"));
    const dbPath = join(dir, "ws.sqlite");
    const lockPath = join(dir, "ws.lock");
    const workspaceId = mkWorkspaceId();
    const repositoryId = "phase-1-repository";
    const draft = makeDraft(workspaceId);
    const recordedAt = "2026-08-16T00:00:02.000Z";
    const digest = legacyDigest(draft, 1, recordedAt);
    const fingerprint = legacyFingerprint(draft);

    const db = new Database(dbPath);
    db.exec(`CREATE TABLE events (
      event_id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, sequence INTEGER NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, operation_id TEXT,
      type TEXT NOT NULL, payload TEXT NOT NULL, payload_schema_version INTEGER NOT NULL DEFAULT 1,
      producer TEXT NOT NULL, causation_event_id TEXT, correlation_id TEXT,
      occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL, event_digest TEXT NOT NULL
    )`);
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(recordedAt);
    db.prepare(`INSERT INTO events (
      event_id, idempotency_key, sequence, workspace_id, session_id, operation_id,
      type, payload, payload_schema_version, producer, causation_event_id,
      correlation_id, occurred_at, recorded_at, event_digest
    ) VALUES (?, NULL, 1, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`)
      .run(
        draft.eventId,
        workspaceId,
        draft.sessionId,
        draft.type,
        canonicalStringify(draft.payload),
        draft.payloadSchemaVersion,
        canonicalStringify(draft.producer),
        draft.occurredAt,
        recordedAt,
        digest,
      );
    db.close();

    const runtime = await openLockedWorkspaceStore({
      databasePath: dbPath,
      lockPath,
      workspaceId: String(workspaceId),
      repositoryId,
    });
    const found = await runtime.store.get(String(draft.eventId));
    expect(found).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(found, "programStateId")).toBe(false);
    expect(found!.eventDigest).toBe(digest);
    runtime.close();

    const migrated = new Database(dbPath);
    const row = migrated.prepare(
      "SELECT program_state_id, event_digest, request_fingerprint FROM events WHERE event_id = ?",
    ).get(draft.eventId) as {
      program_state_id: string | null;
      event_digest: string;
      request_fingerprint: string;
    };
    expect(row.program_state_id).toBeNull();
    expect(row.event_digest).toBe(digest);
    expect(row.request_fingerprint).toBe(fingerprint);
    migrated.close();
  });
});
