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
  PROGRAM_PROJECTION_SCHEMA_VERSION,
  createProgramStateProjection,
  listProgramStates,
  readProgramState,
  type ProgramProjectionCodec,
} from "./program-state-projection.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

type TestProgramState = {
  programStateId: string;
  revision: number;
  lifecycle: "active" | "completed" | "cancelled";
  value: number;
};

const codec: ProgramProjectionCodec<TestProgramState> = {
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

function state(
  programStateId: ProgramStateId,
  revision: number,
  lifecycle: TestProgramState["lifecycle"],
  value: number,
): TestProgramState {
  return { programStateId: String(programStateId), revision, lifecycle, value };
}

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
      payload: { state: state(programStateId, 1, "active", 10) },
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
      payload: { state: state(programStateId, 2, "active", 15) },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "program-projection-test" },
    },
    {
      eventId: mkEventId(),
      workspaceId,
      sessionId,
      programStateId,
      occurredAt: "2026-08-16T00:00:02.000Z",
      type: "program.completed",
      payload: { state: state(programStateId, 3, "completed", 15) },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "program-projection-test" },
    },
  ]);
}

const describeLocked = process.platform === "win32" ? describe.skip : describe;

describeLocked("ProgramState projection", () => {
  it("projects canonical snapshots including terminal completion, survives reopen, and rebuilds exactly", async () => {
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

    const projection = createProgramStateProjection(String(workspaceId), codec);
    const firstCatchUp = runtime.store.getProjectionRunner().catchUp(projection);
    expect(firstCatchUp.appliedCount).toBe(3);

    let db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const first = readProgramState(db, codec, programStateId);
    expect(first).toMatchObject({
      programStateId: String(programStateId),
      workspaceId: String(workspaceId),
      revision: 3,
      lifecycle: "completed",
      state: state(programStateId, 3, "completed", 15),
    });
    expect(first!.createdSequence).toBeLessThan(first!.updatedSequence);
    expect(listProgramStates(db, codec, String(workspaceId))).toEqual([first]);
    db.close();
    runtime.close();

    runtime = await openLockedWorkspaceStore({
      databasePath: dbPath,
      lockPath,
      workspaceId: String(workspaceId),
      repositoryId: "program-projection-test",
    });
    const reopenedCatchUp = runtime.store.getProjectionRunner().catchUp(
      createProgramStateProjection(String(workspaceId), codec),
    );
    expect(reopenedCatchUp.appliedCount).toBe(0);
    runtime.close();

    db = new Database(dbPath);
    db.exec("DROP TABLE program_states");
    db.prepare("DELETE FROM projection_cursors WHERE projection_name = ?").run(PROGRAM_PROJECTION_NAME);
    db.close();

    runtime = await openLockedWorkspaceStore({
      databasePath: dbPath,
      lockPath,
      workspaceId: String(workspaceId),
      repositoryId: "program-projection-test",
    });
    const rebuilt = runtime.store.getProjectionRunner().catchUp(
      createProgramStateProjection(String(workspaceId), codec),
    );
    expect(rebuilt.appliedCount).toBe(3);
    runtime.close();

    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const afterRebuild = readProgramState(db, codec, programStateId);
    expect(afterRebuild).toEqual(first);
    db.close();
  });

  it("projects canonical cancellation as terminal Program state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-projection-cancel-"));
    const dbPath = join(dir, "workspace.sqlite");
    const lockPath = join(dir, "workspace.lock");
    const workspaceId = mkWorkspaceId();
    const sessionId = mkSessionId();
    const programStateId = mkProgramStateId();

    const runtime = await openLockedWorkspaceStore({
      databasePath: dbPath,
      lockPath,
      workspaceId: String(workspaceId),
      repositoryId: "program-projection-test",
    });
    await runtime.store.append([
      {
        eventId: mkEventId(), workspaceId, sessionId, programStateId,
        occurredAt: "2026-08-16T00:00:00.000Z", type: "program.created",
        payload: { state: state(programStateId, 1, "active", 1) }, payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "program-projection-test" },
      },
      {
        eventId: mkEventId(), workspaceId, sessionId, programStateId,
        occurredAt: "2026-08-16T00:00:01.000Z", type: "program.cancelled",
        payload: { state: state(programStateId, 2, "cancelled", 1) }, payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "program-projection-test" },
      },
    ]);
    runtime.store.getProjectionRunner().catchUp(createProgramStateProjection(String(workspaceId), codec));
    runtime.close();

    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    expect(readProgramState(db, codec, programStateId)?.lifecycle).toBe("cancelled");
    db.close();
  });

  it("creates derived schema and persists projection metadata even when canonical history is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-projection-empty-"));
    const dbPath = join(dir, "workspace.sqlite");
    const lockPath = join(dir, "workspace.lock");
    const workspaceId = mkWorkspaceId();

    const runtime = await openLockedWorkspaceStore({
      databasePath: dbPath,
      lockPath,
      workspaceId: String(workspaceId),
      repositoryId: "program-projection-test",
    });
    const runner = runtime.store.getProjectionRunner();
    const result = runner.catchUp(createProgramStateProjection(String(workspaceId), codec));
    expect(result.appliedCount).toBe(0);
    expect(result.newCursor).toEqual({
      projectionName: PROGRAM_PROJECTION_NAME,
      lastAppliedEventSequence: 0,
      schemaVersion: PROGRAM_PROJECTION_SCHEMA_VERSION,
      classification: "derived",
    });
    expect(runner.getCursor(PROGRAM_PROJECTION_NAME)).toEqual(result.newCursor);
    runtime.close();

    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    expect(listProgramStates(db, codec, String(workspaceId))).toEqual([]);
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
        eventId: mkEventId(), workspaceId, sessionId, programStateId,
        occurredAt: "2026-08-16T00:00:00.000Z", type: "program.created",
        payload: { state: state(otherProgramStateId, 1, "active", 1) }, payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "program-projection-test" },
      },
    ]);

    expect(() => runtime.store.getProjectionRunner().catchUp(
      createProgramStateProjection(String(workspaceId), codec),
    )).toThrow(/identity does not match event envelope/);
    runtime.close();
  });

  it("fails closed on non-contiguous canonical Program revisions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-projection-gap-"));
    const dbPath = join(dir, "workspace.sqlite");
    const lockPath = join(dir, "workspace.lock");
    const workspaceId = mkWorkspaceId();
    const sessionId = mkSessionId();
    const programStateId = mkProgramStateId();

    const runtime = await openLockedWorkspaceStore({
      databasePath: dbPath,
      lockPath,
      workspaceId: String(workspaceId),
      repositoryId: "program-projection-test",
    });
    await runtime.store.append([
      {
        eventId: mkEventId(), workspaceId, sessionId, programStateId,
        occurredAt: "2026-08-16T00:00:00.000Z", type: "program.created",
        payload: { state: state(programStateId, 1, "active", 1) }, payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "program-projection-test" },
      },
      {
        eventId: mkEventId(), workspaceId, sessionId, programStateId,
        occurredAt: "2026-08-16T00:00:01.000Z", type: "program.transitioned",
        payload: { state: state(programStateId, 3, "active", 2) }, payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "program-projection-test" },
      },
    ]);

    expect(() => runtime.store.getProjectionRunner().catchUp(
      createProgramStateProjection(String(workspaceId), codec),
    )).toThrow(/non-contiguous/);
    runtime.close();
  });

  it("fails a mismatched projection Workspace without consuming the cursor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-projection-workspace-"));
    const dbPath = join(dir, "workspace.sqlite");
    const lockPath = join(dir, "workspace.lock");
    const workspaceId = mkWorkspaceId();
    const otherWorkspaceId = mkWorkspaceId();
    const sessionId = mkSessionId();
    const programStateId = mkProgramStateId();

    const runtime = await openLockedWorkspaceStore({
      databasePath: dbPath,
      lockPath,
      workspaceId: String(workspaceId),
      repositoryId: "program-projection-test",
    });
    await runtime.store.append([
      {
        eventId: mkEventId(), workspaceId, sessionId, programStateId,
        occurredAt: "2026-08-16T00:00:00.000Z", type: "program.created",
        payload: { state: state(programStateId, 1, "active", 1) }, payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "program-projection-test" },
      },
    ]);

    const runner = runtime.store.getProjectionRunner();
    expect(() => runner.catchUp(
      createProgramStateProjection(String(otherWorkspaceId), codec),
    )).toThrow(/does not match event Workspace/);
    expect(runner.getCursor(PROGRAM_PROJECTION_NAME).lastAppliedEventSequence).toBe(0);

    const correct = runner.catchUp(createProgramStateProjection(String(workspaceId), codec));
    expect(correct.appliedCount).toBe(1);
    runtime.close();
  });
});
