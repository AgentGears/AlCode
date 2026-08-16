import type { Event, ProgramStateId } from "@alcode/events";
import type { ProjectionDefinition, SqliteDatabase } from "./projection.ts";

export const PROGRAM_PROJECTION_NAME = "program-state";
export const PROGRAM_PROJECTION_SCHEMA_VERSION = 1;

/**
 * Storage owns projection mechanics only. Program semantics stay in the pure
 * @alcode/program-state package and are injected by the Host composition root.
 */
export interface ProgramProjectionSemantics<TState = unknown> {
  create(creation: unknown): TState;
  transition(state: TState, transition: unknown): TState;
  serialize(state: TState): string;
  deserialize(serialized: string): TState;
  inspect(state: TState): {
    programStateId: string;
    revision: number;
    lifecycle: "active" | "completed" | "cancelled";
  };
}

export interface ProgramCreatedPayloadV1 {
  creation: unknown;
}

export interface ProgramTransitionedPayloadV1 {
  transition: unknown;
}

function requireProgramStateId(event: Event): ProgramStateId {
  if (event.programStateId === undefined) {
    throw new Error(`${event.type} requires envelope.programStateId`);
  }
  return event.programStateId;
}

function persistState<TState>(
  db: SqliteDatabase,
  semantics: ProgramProjectionSemantics<TState>,
  state: TState,
  event: Event,
  createdSequence: number,
): void {
  const inspected = semantics.inspect(state);
  if (inspected.programStateId !== String(requireProgramStateId(event))) {
    throw new Error("Program projection state identity does not match event envelope");
  }
  if (!Number.isSafeInteger(inspected.revision) || inspected.revision < 1) {
    throw new Error("Program projection revision must be a positive safe integer");
  }

  db.prepare(`
    INSERT INTO program_states (
      program_state_id, workspace_id, revision, lifecycle, state_json,
      created_sequence, updated_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(program_state_id) DO UPDATE SET
      revision = excluded.revision,
      lifecycle = excluded.lifecycle,
      state_json = excluded.state_json,
      updated_sequence = excluded.updated_sequence
  `).run(
    inspected.programStateId,
    String(event.workspaceId),
    inspected.revision,
    inspected.lifecycle,
    semantics.serialize(state),
    createdSequence,
    event.sequence,
  );
}

function applyProgramEvent<TState>(
  db: SqliteDatabase,
  semantics: ProgramProjectionSemantics<TState>,
  event: Event,
): void {
  const programStateId = String(requireProgramStateId(event));

  if (event.type === "program.created") {
    const payload = event.payload as ProgramCreatedPayloadV1;
    if (payload === null || typeof payload !== "object" || !("creation" in payload)) {
      throw new Error("program.created missing creation payload");
    }
    const existing = db.prepare(
      "SELECT program_state_id FROM program_states WHERE program_state_id = ?",
    ).get(programStateId);
    if (existing !== undefined) {
      throw new Error(`duplicate canonical program.created for ${programStateId}`);
    }
    const state = semantics.create(payload.creation);
    persistState(db, semantics, state, event, event.sequence);
    return;
  }

  if (event.type === "program.transitioned") {
    const payload = event.payload as ProgramTransitionedPayloadV1;
    if (payload === null || typeof payload !== "object" || !("transition" in payload)) {
      throw new Error("program.transitioned missing transition payload");
    }
    const row = db.prepare(
      "SELECT workspace_id, state_json, created_sequence FROM program_states WHERE program_state_id = ?",
    ).get(programStateId) as {
      workspace_id: string;
      state_json: string;
      created_sequence: number;
    } | undefined;
    if (row === undefined) {
      throw new Error(`program.transitioned references unknown ProgramStateId ${programStateId}`);
    }
    if (row.workspace_id !== String(event.workspaceId)) {
      throw new Error("program.transitioned Workspace does not match projected Program Workspace");
    }
    const current = semantics.deserialize(row.state_json);
    const inspectedCurrent = semantics.inspect(current);
    if (inspectedCurrent.programStateId !== programStateId) {
      throw new Error("Stored Program projection identity does not match row key");
    }
    const next = semantics.transition(current, payload.transition);
    persistState(db, semantics, next, event, row.created_sequence);
  }
}

export function createProgramStateProjection<TState>(
  workspaceId: string,
  semantics: ProgramProjectionSemantics<TState>,
): ProjectionDefinition {
  return {
    name: PROGRAM_PROJECTION_NAME,
    schemaVersion: PROGRAM_PROJECTION_SCHEMA_VERSION,
    classification: "derived",
    init(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS program_states (
          program_state_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','completed','cancelled')),
          state_json TEXT NOT NULL,
          created_sequence INTEGER NOT NULL,
          updated_sequence INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_program_states_workspace_lifecycle
          ON program_states(workspace_id, lifecycle, updated_sequence);
      `);
    },
    apply(db, event) {
      if (String(event.workspaceId) !== workspaceId) return;
      if (event.type !== "program.created" && event.type !== "program.transitioned") return;
      applyProgramEvent(db, semantics, event);
    },
  };
}

export function readProgramState<TState>(
  db: SqliteDatabase,
  semantics: ProgramProjectionSemantics<TState>,
  programStateId: ProgramStateId | string,
): TState | null {
  const row = db.prepare(
    "SELECT state_json FROM program_states WHERE program_state_id = ?",
  ).get(String(programStateId)) as { state_json: string } | undefined;
  return row === undefined ? null : semantics.deserialize(row.state_json);
}

export function listProgramStates<TState>(
  db: SqliteDatabase,
  semantics: ProgramProjectionSemantics<TState>,
  workspaceId: string,
): TState[] {
  const rows = db.prepare(
    "SELECT state_json FROM program_states WHERE workspace_id = ? ORDER BY updated_sequence, program_state_id",
  ).all(workspaceId) as Array<{ state_json: string }>;
  return rows.map((row) => semantics.deserialize(row.state_json));
}
