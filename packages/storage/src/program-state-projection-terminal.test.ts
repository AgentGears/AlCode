import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkEventId, mkProgramStateId, mkSessionId, mkWorkspaceId } from "@alcode/events";
import { openLockedWorkspaceStore } from "./index.ts";
import {
  PROGRAM_PROJECTION_NAME,
  createProgramStateProjection,
  readProgramState,
  type ProgramProjectionCodec,
} from "./program-state-projection.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

type State = {
  programStateId: string;
  revision: number;
  lifecycle: "active" | "completed" | "cancelled";
};

const codec: ProgramProjectionCodec<State> = {
  serialize: JSON.stringify,
  deserialize: (value) => JSON.parse(value) as State,
  inspect: (value) => ({
    programStateId: value.programStateId,
    revision: value.revision,
    lifecycle: value.lifecycle,
  }),
};

const describeLocked = process.platform === "win32" ? describe.skip : describe;

describeLocked("ProgramState terminal projection authority", () => {
  it("does not advance the cursor or overwrite state after the first terminal event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-terminal-"));
    const databasePath = join(dir, "workspace.sqlite");
    const lockPath = join(dir, "workspace.lock");
    const workspaceId = mkWorkspaceId();
    const sessionId = mkSessionId();
    const programStateId = mkProgramStateId();

    const runtime = await openLockedWorkspaceStore({
      databasePath,
      lockPath,
      workspaceId: String(workspaceId),
      repositoryId: "program-terminal-test",
    });
    await runtime.store.append([
      {
        eventId: mkEventId(), workspaceId, sessionId, programStateId,
        occurredAt: "2026-08-16T00:00:00.000Z", type: "program.created",
        payload: { state: { programStateId: String(programStateId), revision: 1, lifecycle: "active" } },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "program-terminal-test" },
      },
      {
        eventId: mkEventId(), workspaceId, sessionId, programStateId,
        occurredAt: "2026-08-16T00:00:01.000Z", type: "program.completed",
        payload: { state: { programStateId: String(programStateId), revision: 2, lifecycle: "completed" } },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "program-terminal-test" },
      },
      {
        eventId: mkEventId(), workspaceId, sessionId, programStateId,
        occurredAt: "2026-08-16T00:00:02.000Z", type: "program.cancelled",
        payload: { state: { programStateId: String(programStateId), revision: 3, lifecycle: "cancelled" } },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "program-terminal-test" },
      },
    ]);

    const runner = runtime.store.getProjectionRunner();
    const projection = createProgramStateProjection(String(workspaceId), codec);
    expect(() => runner.catchUp(projection)).toThrow(/already terminal/);
    expect(runner.getCursor(PROGRAM_PROJECTION_NAME).lastAppliedEventSequence).toBe(2);
    runtime.close();

    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    expect(readProgramState(db, codec, String(workspaceId), programStateId)).toMatchObject({
      revision: 2,
      lifecycle: "completed",
    });
    db.close();
  });
});
