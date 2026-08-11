import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { asWorkspaceId, mkEventId, uuidv7 } from "@alcode/events";
import { createWorkspaceReadModels, openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import { HostRuntime } from "./host.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

describeLocked("Phase 0.6 stable transcript source head", () => {
  let dir = "";
  let locked: LockedWorkspaceStore | null = null;

  afterEach(() => {
    try { locked?.close(); } catch { /* already closed */ }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reports one snapshotted canonical head while filtering non-transcript events from messages", async () => {
    dir = mkdtempSync(join(tmpdir(), "alcode-transcript-head-"));
    const workspaceId = asWorkspaceId(uuidv7());
    locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId,
      repositoryId: uuidv7(),
    });
    const host = new HostRuntime({ store: locked, capabilities: [] });
    await host.startup();
    const session = await host.openOrResumeSession();
    await host.admitInput(session.sessionId, "only transcript message");
    await host.admission.append([{
      eventId: mkEventId(),
      workspaceId,
      sessionId: session.sessionId,
      occurredAt: new Date().toISOString(),
      type: "runtime.criterion.evidence",
      payload: { evidenceType: "stable-head", data: null, generationId: "test" },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "test" },
    }]);

    const expectedHead = await locked.store.headSequence();
    const snapshot = await createWorkspaceReadModels(locked.store).getTranscriptSnapshot(session.sessionId as string);
    expect(snapshot.sourceEventSequence).toBe(expectedHead);
    expect(snapshot.messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "only transcript message" }],
      }),
    ]);
  });
});
