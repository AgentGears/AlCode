import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asSessionId, asWorkspaceId, mkEventId, uuidv7 } from "@alcode/events";
import {
  createContextReceiptProjection,
  createContextReceiptQuery,
  openLockedWorkspaceStore,
  type LockedWorkspaceStore,
} from "./index.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

describeLocked("Phase 0.7 context receipt projection", () => {
  let dir: string;
  let locked: LockedWorkspaceStore | null;
  let databasePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-context-receipt-"));
    databasePath = join(dir, "workspace.sqlite");
    locked = null;
  });

  afterEach(() => {
    try { locked?.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  it("materializes a non-critical summary and rebuilds it equivalently from the canonical receipt", async () => {
    const workspaceId = asWorkspaceId(uuidv7());
    const sessionId = asSessionId(uuidv7());
    locked = await openLockedWorkspaceStore({
      databasePath,
      lockPath: join(dir, "workspace.lock"),
      workspaceId,
      repositoryId: uuidv7(),
    });

    await locked.store.append([{
      eventId: mkEventId(),
      workspaceId,
      sessionId,
      occurredAt: "2026-08-12T02:00:00.000Z",
      type: "context.projection_compiled",
      payload: {
        receiptId: "receipt-1",
        requestedMode: "graph",
        effectiveMode: "graph-v1",
        compilerVersion: "graph-v1",
        source: { sourceEventSequence: 7 },
        attempt: {
          requestedMode: "graph",
          maxGraphRenderedChars: 4096,
        },
        delivery: {
          effectiveMode: "graph-v1",
          deliveredEstimatedTokens: 512,
        },
        fallback: { used: false },
      },
      payloadSchemaVersion: 1,
      producer: { kind: "projection", projectionName: "host-context" },
    }]);

    const runner = locked.store.getProjectionRunner();
    const projection = createContextReceiptProjection();
    const result = runner.catchUp(projection);
    expect(result.caught).toBe(true);
    expect(runner.getCursor("context_receipts").classification).toBe("derived");

    const db = new Database(databasePath);
    try {
      const query = createContextReceiptQuery(db);
      const before = query.getAll();
      expect(before).toEqual([{
        receiptId: "receipt-1",
        projectionMode: "graph",
        compilerVersion: "graph-v1",
        sourceEventSequence: 7,
        tokenBudget: 4096,
        estimatedTokens: 512,
        fallbackUsed: false,
        createdAt: "2026-08-12T02:00:00.000Z",
      }]);

      db.prepare("DELETE FROM projection_receipts").run();
      db.prepare("DELETE FROM projection_cursors WHERE projection_name = ?").run("context_receipts");
      expect(query.getAll()).toEqual([]);

      const rebuilt = runner.catchUp(projection);
      expect(rebuilt.caught).toBe(true);
      expect(query.getAll()).toEqual(before);
    } finally {
      db.close();
    }
  });
});
