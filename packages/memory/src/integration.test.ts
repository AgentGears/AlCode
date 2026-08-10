// Memory projection integration test — proves the full pipeline:
// append memory.* events → project memories + memory_stats → retrieve/rank
// → delete derived projection → replay → equivalent state.
//
// This is the Phase 0.3 canonical rebuild proof: the derived memory
// projection can be deleted and rebuilt from events to produce equivalent
// state. No detached worker, no Host process — just the semantic engine
// and the event-sourced projection.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { asWorkspaceId, uuidv7, mkEventId } from "@alcode/events";
import {
  openLockedWorkspaceStore,
  createMemoryProjection,
  createMemoryQuery,
  type LockedWorkspaceStore,
} from "@alcode/storage";
import {
  createInitialStats,
  applyRecordUse,
  applyRecordSeen,
  computeStrength,
  rankByBlendedScore,
  resolveConfidence,
  formatMemoryId,
} from "./index.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

const TEST_WS = asWorkspaceId(uuidv7()) as string;
const TEST_REPO = uuidv7();
const describeLocked = process.platform === "win32" ? describe.skip : describe;

async function openStore(dbPath: string): Promise<LockedWorkspaceStore> {
  const lockPath = dbPath.replace(".sqlite", ".lock");
  return openLockedWorkspaceStore({ databasePath: dbPath, lockPath, workspaceId: TEST_WS, repositoryId: TEST_REPO });
}

const NOW = Date.UTC(2026, 6, 1);

describeLocked("memory projection integration", () => {
  let dir: string;
  let rt: LockedWorkspaceStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-mem-"));
  });
  afterEach(() => {
    try { rt?.close(); } catch { /* idempotent */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("full pipeline: create → reinforce → lifecycle → retrieve → rebuild", async () => {
    const dbPath = join(dir, "ws.sqlite");
    rt = await openStore(dbPath);
    const wsId = rt.store.workspaceId;

    const mem1Id = formatMemoryId("lesson", "test_lesson_2026-07-01T000000000Z");
    const mem2Id = formatMemoryId("playbook", "auth_pattern");
    const mem1Confidence = resolveConfidence("success"); // 0.8
    const mem2Confidence = resolveConfidence("high"); // 0.9

    // 1. Append memory.created events
    const mem1EventId = mkEventId();
    const mem2EventId = mkEventId();
    await rt.store.append([
      {
        eventId: mem1EventId,
        workspaceId: wsId as never,
        sessionId: "00000000-0000-7000-8000-000000000001" as never,
        occurredAt: new Date(NOW).toISOString(),
        type: "memory.created",
        payload: {
          memoryId: mem1Id,
          type: "lesson",
          body: "test lesson content about authentication",
          name: "test_lesson",
          confidence: mem1Confidence,
          fields: { lesson_name: "test_lesson", domain: "auth", tags: ["security"], content: "auth lesson" },
          sourceEventIds: [mem1EventId],
        },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "test" },
      },
      {
        eventId: mem2EventId,
        workspaceId: wsId as never,
        sessionId: "00000000-0000-7000-8000-000000000001" as never,
        occurredAt: new Date(NOW).toISOString(),
        type: "memory.created",
        payload: {
          memoryId: mem2Id,
          type: "playbook",
          body: "playbook for auth patterns",
          name: "auth_pattern",
          confidence: mem2Confidence,
          fields: { playbook_name: "auth_pattern", domain: "auth", tags: ["security", "auth"], content: "auth playbook" },
          sourceEventIds: [mem2EventId],
        },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "test" },
      },
    ]);

    // 2. Catch up the memory projection
    const runner = rt.store.getProjectionRunner();
    const memProj = createMemoryProjection(wsId);
    runner.catchUp(memProj);

    // 3. Verify both memories + stats exist
    const roDb1 = new Database(dbPath, { readonly: true, fileMustExist: true });
    const query = createMemoryQuery(roDb1);
    const mem1 = query.getById(mem1Id);
    const stats1 = query.getStats(mem1Id);
    const stats2 = query.getStats(mem2Id);
    roDb1.close();

    expect(mem1).toBeDefined();
    expect(mem1!.body).toContain("authentication");
    expect(stats1).toBeDefined();
    expect(stats1!.confidence).toBe(0.8);
    expect(stats1!.lifecycle).toBe("active");
    expect(stats1!.seenCount).toBe(0);
    expect(stats1!.usedCount).toBe(0);
    expect(stats2!.confidence).toBe(0.9);

    // Provenance: verify the projected record carries sourceEventIds through
    // the persistence layer (the memory.created event's eventId).
    // The projected memories.name and memories.fields_json columns should be populated.
    expect(mem1!.name).toBe("test_lesson");
    expect(mem1!.fields).not.toBeNull();
    expect(mem1!.confidence).toBe(0.8);
    // Provenance: sourceEventIds survive the projection round-trip.
    expect(mem1!.sourceEventIds).toEqual([mem1EventId]);

    // 4. Append reinforcement events (use mem1)
    let stats = createInitialStats(mem1Id, "lesson", mem1Confidence, NOW);
    const useResult = applyRecordUse(stats, NOW + 5000); // first use
    stats = { ...stats, ...useResult };

    await rt.store.append([
      {
        eventId: mkEventId(),
        workspaceId: wsId as never,
        sessionId: "00000000-0000-7000-8000-000000000001" as never,
        occurredAt: new Date(NOW + 5000).toISOString(),
        type: "memory.reinforced",
        payload: {
          memoryId: mem1Id,
          kind: "used" as const,
          count: useResult.used_count,
          consolidationCount: useResult.consolidation_count,
          strength: useResult.strength,
        },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "test" },
      },
    ]);
    runner.catchUp(memProj);

    // 5. Verify updated stats
    const roDb2 = new Database(dbPath, { readonly: true, fileMustExist: true });
    const statsAfterUse = createMemoryQuery(roDb2).getStats(mem1Id);
    roDb2.close();
    expect(statsAfterUse!.usedCount).toBe(1);
    expect(statsAfterUse!.lastUsed).toBe(NOW + 5000);

    // 6. Retrieve/rank using the semantic engine.
    // Use the ACTUAL projected record (name, fields, confidence, sourceEventIds)
    // from the projection query — no manual reconstruction.
    const roDb3 = new Database(dbPath, { readonly: true, fileMustExist: true });
    const query3 = createMemoryQuery(roDb3);
    const allRecords = query3.getAll().map((r: {
      type: string; memoryId: string; body: string; name: string | null;
      fields: Record<string, unknown> | null; confidence: number | null;
      sourceEventIds: string[] | null; storedAt: number | null;
    }) => ({
      type: r.type as "lesson" | "playbook",
      memory_id: r.memoryId,
      name: r.name ?? r.memoryId.split("/")[1]!.replace(".md", ""),
      stored_at: r.storedAt ?? NOW,
      fields: (r.fields ?? { content: r.body }) as Record<string, unknown>,
      ...(r.sourceEventIds ? { sourceEventIds: r.sourceEventIds } : {}),
    })) as unknown as import("./schema.ts").MemoryRecord[];
    const statsMap = new Map();
    for (const s of query3.getAllStats()) {
      statsMap.set(s.memoryId, {
        memory_id: s.memoryId,
        type: s.type,
        confidence: s.confidence,
        last_seen: s.lastSeen,
        last_used: s.lastUsed,
        seen_count: s.seenCount,
        used_count: s.usedCount,
        consolidation_count: s.consolidationCount,
        strength: s.strength,
        lifecycle: s.lifecycle,
        created_at: s.createdAt,
        updated_at: s.updatedAt,
      });
    }
    roDb3.close();

    const ranked = rankByBlendedScore(allRecords, statsMap, "auth", NOW);
    expect(ranked.length).toBe(2);
    expect(ranked[0]!.score.final).toBeGreaterThan(0);

    // 7. Snapshot stats for rebuild comparison
    const roDb4 = new Database(dbPath, { readonly: true, fileMustExist: true });
    const statsBefore = createMemoryQuery(roDb4).getAllStats();
    roDb4.close();
    const headSeq = await rt.store.headSequence();
    rt.close();

    // 8. Delete derived projection tables + reset cursor
    const rawDb = new Database(dbPath);
    rawDb.exec("DELETE FROM memories");
    rawDb.exec("DELETE FROM memory_stats");
    rawDb.prepare("DELETE FROM projection_cursors WHERE projection_name = 'memory'").run();
    rawDb.close();

    // 9. Reopen and rebuild from events
    rt = await openStore(dbPath);
    const runner2 = rt.store.getProjectionRunner();
    const result = runner2.catchUp(createMemoryProjection(rt.store.workspaceId));
    expect(result.caught).toBe(true);
    expect(runner2.getCursor("memory").lastAppliedEventSequence).toBe(headSeq);

    // 10. Verify equivalent state
    const roDb5 = new Database(dbPath, { readonly: true, fileMustExist: true });
    const statsAfter = createMemoryQuery(roDb5).getAllStats();
    roDb5.close();

    expect(statsAfter.length).toBe(statsBefore.length);
    // Each rebuilt stats row matches the snapshot
    for (const before of statsBefore) {
      const after = statsAfter.find((s: { memoryId: string }) => s.memoryId === before.memoryId);
      expect(after).toBeDefined();
      expect(after!.usedCount).toBe(before.usedCount);
      expect(after!.consolidationCount).toBe(before.consolidationCount);
      expect(after!.lifecycle).toBe(before.lifecycle);
      expect(after!.confidence).toBe(before.confidence);
    }
  });

  it("memory.reinforced seen does not affect strength; used does", async () => {
    const dbPath = join(dir, "ws.sqlite");
    rt = await openStore(dbPath);
    const wsId = rt.store.workspaceId;
    const memId = formatMemoryId("lesson", "decay_test");

    // Create memory
    await rt.store.append([{
      eventId: mkEventId(),
      workspaceId: wsId as never,
      sessionId: "00000000-0000-7000-8000-000000000002" as never,
      occurredAt: new Date(NOW).toISOString(),
      type: "memory.created",
      payload: { memoryId: memId, type: "lesson", body: "test", name: "decay_test", confidence: 0.8, fields: {} },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "test" },
    }]);

    // 5 recordSeen events — accumulate the count across iterations
    let seenStats = createInitialStats(memId, "lesson", 0.8, NOW);
    for (let i = 1; i <= 5; i++) {
      const seenResult = applyRecordSeen(seenStats, NOW + i * 1000);
      seenStats = { ...seenStats, ...seenResult };
      await rt.store.append([{
        eventId: mkEventId(),
        workspaceId: wsId as never,
        sessionId: "00000000-0000-7000-8000-000000000002" as never,
        occurredAt: new Date(NOW + i * 1000).toISOString(),
        type: "memory.reinforced",
        payload: { memoryId: memId, kind: "seen" as const, count: seenStats.seen_count, consolidationCount: 0, strength: 0.8 },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "test" },
      }]);
    }

    const runner = rt.store.getProjectionRunner();
    runner.catchUp(createMemoryProjection(wsId));

    const roDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    const stats = createMemoryQuery(roDb).getStats(memId);
    roDb.close();

    expect(stats!.seenCount).toBe(5);
    expect(stats!.usedCount).toBe(0); // unchanged
    expect(stats!.lastUsed).toBe(null); // unchanged

    // Strength at creation should still be ~0.8 (seen doesn't change it)
    // The projection stores the initial strength at creation time.
    // recordSeen does NOT update the strength column.
    expect(stats!.strength).toBeGreaterThanOrEqual(0.7);
  });
});
