import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { asSessionId, asWorkspaceId, mkEventId, uuidv7 } from "@alcode/events";
import {
  createTranscriptProjection,
  openLockedWorkspaceStore,
  type LockedWorkspaceStore,
} from "./index.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

describeLocked("Phase 0.6 transcript projection rebuild", () => {
  let dir = "";
  let locked: LockedWorkspaceStore | null = null;

  afterEach(() => {
    try { locked?.close(); } catch { /* already closed */ }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("rebuilds user/assistant/toolResult rows from canonical rich transcript events", async () => {
    dir = mkdtempSync(join(tmpdir(), "alcode-transcript-rebuild-"));
    const databasePath = join(dir, "workspace.sqlite");
    const lockPath = join(dir, "workspace.lock");
    const workspaceId = asWorkspaceId(uuidv7());
    const repositoryId = uuidv7();
    const sessionId = asSessionId(uuidv7());

    locked = await openLockedWorkspaceStore({ databasePath, lockPath, workspaceId, repositoryId });
    await locked.store.append([
      {
        eventId: mkEventId(), workspaceId, sessionId,
        occurredAt: "2026-08-12T00:00:00.001Z", type: "user.message.appended",
        payload: { text: "U", timestamp: 1 }, payloadSchemaVersion: 1, producer: { kind: "user" },
      },
      {
        eventId: mkEventId(), workspaceId, sessionId,
        occurredAt: "2026-08-12T00:00:00.002Z", type: "assistant.message.appended",
        payload: {
          text: "A",
          content: [
            { type: "text", text: "A" },
            { type: "toolCall", id: "T1", name: "read", arguments: { path: "x" } },
          ],
          stopReason: "tool_use",
          timestamp: 2,
        },
        payloadSchemaVersion: 1,
        producer: { kind: "model", provider: "test" },
      },
      {
        eventId: mkEventId(), workspaceId, sessionId,
        occurredAt: "2026-08-12T00:00:00.003Z", type: "tool.result.appended",
        payload: {
          toolCallId: "T1", toolName: "read",
          content: [{ type: "text", text: "R" }], isError: false, timestamp: 3,
        },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "test" },
      },
    ]);
    locked.store.getProjectionRunner().catchUp(createTranscriptProjection(workspaceId));
    locked.close();
    locked = null;

    let db = new Database(databasePath);
    const original = db.prepare("SELECT role, body FROM transcript_messages ORDER BY sequence").all();
    expect(original).toEqual([
      { role: "user", body: "U" },
      { role: "assistant", body: "A" },
      { role: "toolResult", body: "R" },
    ]);
    db.prepare("DELETE FROM transcript_messages").run();
    db.prepare("DELETE FROM projection_cursors WHERE projection_name = 'transcript'").run();
    db.close();

    locked = await openLockedWorkspaceStore({ databasePath, lockPath, workspaceId, repositoryId });
    const replay = locked.store.getProjectionRunner().catchUp(createTranscriptProjection(workspaceId));
    expect(replay.caught).toBe(true);
    locked.close();
    locked = null;

    db = new Database(databasePath);
    const rebuilt = db.prepare("SELECT role, body FROM transcript_messages ORDER BY sequence").all();
    db.close();
    expect(rebuilt).toEqual(original);
  });
});
