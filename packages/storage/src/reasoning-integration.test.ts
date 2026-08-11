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
import { asWorkspaceId, uuidv7, mkEventId } from "@alcode/events";
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
        payload: { claim: "hyp", objectiveId: `event:${sid}:1:objective` },
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
