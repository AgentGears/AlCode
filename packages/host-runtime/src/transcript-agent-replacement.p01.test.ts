import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asSessionId,
  asWorkspaceId,
  mkEventId,
  uuidv7,
} from "@alcode/events";
import {
  createWorkspaceReadModels,
  openLockedWorkspaceStore,
  type LockedWorkspaceStore,
} from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import {
  INTERRUPTED_TOOL_RESULT_TEXT,
  TranscriptAdmissionService,
} from "./transcript-admission.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;
const stores: LockedWorkspaceStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch {} }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describeLocked("Agent replacement transcript recovery", () => {
  it("closes dangling durable tool calls without asserting Operation outcome or effect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-transcript-replacement-"));
    dirs.push(dir);
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: asWorkspaceId(uuidv7()),
      repositoryId: uuidv7(),
    });
    stores.push(locked);
    const admission = new CanonicalAdmissionQueue(locked.store);
    const service = new TranscriptAdmissionService(locked.store, admission);
    const sessionId = asSessionId(uuidv7());
    const timestamp = Date.now();

    await admission.append([
      {
        eventId: mkEventId(),
        workspaceId: asWorkspaceId(locked.store.workspaceId),
        sessionId,
        occurredAt: new Date(timestamp).toISOString(),
        type: "user.message.appended",
        payload: { text: "run the tools", timestamp },
        payloadSchemaVersion: 1,
        producer: { kind: "user" },
      },
      {
        eventId: mkEventId(),
        workspaceId: asWorkspaceId(locked.store.workspaceId),
        sessionId,
        occurredAt: new Date(timestamp + 1).toISOString(),
        type: "assistant.message.appended",
        payload: {
          text: "",
          content: [
            { type: "toolCall", id: "call-2", name: "read_file", arguments: { path: "a" } },
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo hi" } },
          ],
          stopReason: "tool_use",
          timestamp: timestamp + 1,
        },
        payloadSchemaVersion: 1,
        producer: { kind: "model", provider: "agent:dead-generation" },
      },
    ]);

    const recovered = await service.recoverInterruptedToolResults(sessionId);
    expect(recovered).toEqual(["call-1", "call-2"]);
    expect(await service.recoverInterruptedToolResults(sessionId)).toEqual([]);

    const snapshot = await createWorkspaceReadModels(locked.store).getTranscriptSnapshot(String(sessionId));
    expect(snapshot.status).toBe("complete");
    expect(snapshot.pendingToolCallIds).toEqual([]);
    const results = snapshot.messages.filter((message) => message.role === "toolResult");
    expect(results).toHaveLength(2);
    for (const result of results) {
      if (result.role !== "toolResult") throw new Error("recovery result missing");
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: INTERRUPTED_TOOL_RESULT_TEXT }]);
    }
    expect(INTERRUPTED_TOOL_RESULT_TEXT).toContain("asserts no execution outcome or external effect");
  });
});
