import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mkEventId,
  mkProgramStateId,
  mkSessionId,
  mkWorkspaceId,
  type ProgramStateId,
} from "@alcode/events";
import { openLockedWorkspaceStore } from "./index.ts";
import {
  PROGRAM_PROJECTION_NAME,
  createProgramStateProjection,
  listProgramStates,
  readProgramState,
  type ProgramProjectionSemantics,
} from "./program-state-projection.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

type TestProgramState = {
  programStateId: string;
  revision: number;
  lifecycle: "active" | "completed" | "cancelled";
  value: number;
};

type TestCreation = { programStateId: string; value: number };
type TestTransition =
  | { kind: "increment"; expectedProgramRevision: number; by: number }
  | { kind: "complete"; expectedProgramRevision: number };

const semantics: ProgramProjectionSemantics<TestProgramState> = {
  create(raw) {
    const creation = raw as TestCreation;
    return {
      programStateId: creation.programStateId,
      revision: 1,
      lifecycle: "active",
      value: creation.value,
    };
  },
  transition(state, raw) {
    const transition = raw as TestTransition;
    if (transition.expectedProgramRevision !== state.revision) {
      throw new Error(`revision conflict: expected ${transition.expectedProgramRevision}, current ${state.revision}`);
    }
    if (state.lifecycle !== "active") throw new Error("Program is terminal");
    if (transition.kind === "increment") {
      return { ...state, revision: state.revision + 1, value: state.value + transition.by };
    }
    if (transition.kind === "complete") {
      return { ...state, revision: state.revision + 1, lifecycle: "completed" };
    }
    throw new Error("unsupported transition");
  },
  serialize(state) {
    return JSON.stringify(state);
  },
  deserialize(serialized) {
    return JSON.parse(serialized) as TestProgramState;
  },
  inspect(state) {
    return {
      programStateId: state.programStateId,
      revision: state.revision,
      lifecycle: state.lifecycle,
    };
  },
};

async function appendProgramHistory(
  store: Awaited<ReturnType<typeof openLockedWorkspaceStore>>["store"],
  workspaceId: ReturnType<typeof mkWorkspaceId>,
  sessionId: ReturnType<typeof mkSessionId>,
  programStateId: ProgramStateId,
): Promise<void> {
  await store.append([
    {
      eventId: mkEventId(),
      workspaceId,
      sessionId,
      programStateId,
      occurredAt: "2026-08-16T00:00:00.000Z",
      type: "program.created",
      payload: { creation: { programStateId: String(programStateId), value: 10 } },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "program-projection-test" },
    },
    {
      eventId: mkEventId(),
      workspaceId,
      sessionId,
      programStateId,
      occurredAt: "2026-08-16T00:00:01.000Z",
      type: "program.transitioned",
      payload: { transition: { kind: "increment", expectedProgramRevision: 1, by: 5 } },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "program-projection-test" },
    },
    {
      eventId: mkEventId(),
      workspaceId,
      sessionId,
      programStateId,
      occurredAt: "2026-08-16T00:00:02.000Z",
      type: "program.transitioned",
      payload: { transition: { kind: "complete", expectedProgramRevision: 2 } },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "program-projection-test" },
    },
  ]);
}

const describeLocked = process.platform === "win32" ? describe.skip : describe;

describeLocked("ProgramState projection", () => {
  it("projects canonical Program events, survives reopen, and rebuilds exactly from history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-projection-"));
    const dbPath = join(dir, "workspace.sqlite");
    const lockPath = join(dir, "workspace.lock");
    const workspaceId = mkWorkspaceId();
    const sessionId = mkSessionId();
    const programStateId = mkProgramStateId();

    let runtime = await openLockedWorkspaceStore({
      databasePath: dbPath,
      lockPath,
      workspaceId: String(workspaceId),
      repositoryId: "program-projection-test",
    });
    await appendProgramHistory(runtime.store, workspaceId, sessionId, programStateId);

    const projection = createProgramStateProjection(String(workspaceId), semantics);
    const firstCatchUp = runtime.store.getProjectionRunner().catchUp(projection);
    expect(firstCatchUp.appliedCount).toBe(3);

    let db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const first = readProgramState(db, semantics, programStateId);
    expect(first).toEqual({
      programStateId: String(programStateId),
      revision: 3,
      lifecycle: "completed",
      value: 15,
    });
    expect(listProgramStates(db, semantics, String(workspaceId))).toEqual([first]);
    db.close();
    runtime.close();

    runtime = await openLockedWorkspaceStore({
      databasePath: dbPath,
      lockPath,
      workspaceId: String(workspaceId),
      repositoryId: "program-projection-test",
    });
    const reopenedCatchUp = runtime.store.getProjectionRunner().catchUp(
      createProgramStateProjection(String(workspaceId), semantics),
    );
    expect(reopenedCatchUp.appliedCount).toBe(0);
    runtime.close();

    db = new Database(dbPath);
    db.exec("DELETE FROM program_states");
    db.prepare("DELETE FROM projection_cursors WHERE projection_name = ?").run(PROGRAM_PROJECTION_NAME);
    db.close();

    runtime = await openLockedWorkspaceStore({
      databasePath: dbPath,
      lockPath,
      workspaceId: String(workspaceId),
      repositoryId: "program-projection-test",
    });
    const rebuilt = runtime.store.getProjectionRunner().catchUp(
      createProgramStateProjection(String(workspaceId), semantics),
    );
    expect(rebuilt.appliedCount).toBe(3);
    runtime.close();

    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const afterRebuild = readProgramState(db, semantics, programStateId);
    expect(afterRebuild).toEqual(first);
    db.close();
  });

  it("fails rebuild if canonical creation identity disagrees with the envelope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-projection-invalid-"));
    const dbPath = join(dir, "workspace.sqlite");
    const lockPath = join(dir, "workspace.lock");
    const workspaceId = mkWorkspaceId();
    const sessionId = mkSessionId();
    const programStateId = mkProgramStateId();
    const otherProgramStateId = mkProgramStateId();

    const runtime = await openLockedWorkspaceStore({
      databasePath: dbPath,
      lockPath,
      workspaceId: String(workspaceId),
      repositoryId: "program-projection-test",
    });
    await runtime.store.append([
      {
        eventId: mkEventId(),
        workspaceId,
        sessionId,
        programStateId,
        occurredAt: "2026-08-16T00:00:00.000Z",
        type: "program.created",
        payload: { creation: { programStateId: String(otherProgramStateId), value: 1 } },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "program-projection-test" },
      },
    ]);

    expect(() => runtime.store.getProjectionRunner().catchUp(
      createProgramStateProjection(String(workspaceId), semantics),
    )).toThrow(/identity does not match event envelope/);
    runtime.close();
  });
});
