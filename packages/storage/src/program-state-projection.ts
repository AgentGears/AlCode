import type { PersistedDomainEvent, ProgramStateId } from "@alcode/events";
import type Database from "better-sqlite3";
import type {
  ProjectionDefinition,
  ProjectionTransaction,
  StatementDefinition,
} from "./projection.ts";

export const PROGRAM_PROJECTION_NAME = "program-state";
export const PROGRAM_PROJECTION_SCHEMA_VERSION = 1;

export interface ProgramProjectionCodec<TState = unknown> {
  serialize(state: TState): string;
  deserialize(serialized: string): TState;
  inspect(state: TState): {
    programStateId: string;
    revision: number;
    lifecycle: "active" | "completed" | "cancelled";
  };
}

export interface ProgramStateEventPayloadV1<TState = unknown> { state: TState; }
export interface ProjectedProgramRecord<TState> {
  programStateId: string;
  workspaceId: string;
  revision: number;
  lifecycle: "active" | "completed" | "cancelled";
  state: TState;
  createdSequence: number;
  updatedSequence: number;
}

const setupStatements: readonly StatementDefinition[] = [
  {
    name: "create-program-states",
    sql: `CREATE TABLE IF NOT EXISTS program_states (
      program_state_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','completed','cancelled')),
      state_json TEXT NOT NULL,
      created_sequence INTEGER NOT NULL CHECK(created_sequence >= 1),
      updated_sequence INTEGER NOT NULL CHECK(updated_sequence >= created_sequence)
    )`,
  },
  {
    name: "index-program-states-workspace-lifecycle",
    sql: `CREATE INDEX IF NOT EXISTS idx_program_states_workspace_lifecycle
      ON program_states(workspace_id, lifecycle, updated_sequence, program_state_id)`,
  },
];

const statements: readonly StatementDefinition[] = [
  {
    name: "insert-program-state",
    sql: `INSERT INTO program_states (
      program_state_id, workspace_id, revision, lifecycle, state_json,
      created_sequence, updated_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  },
  {
    name: "advance-program-state",
    sql: `UPDATE program_states
      SET revision = ?, lifecycle = ?, state_json = ?, updated_sequence = ?
      WHERE program_state_id = ? AND workspace_id = ? AND revision = ?`,
  },
];

function requireProgramStateId(event: PersistedDomainEvent<string, unknown>): ProgramStateId {
  if (event.programStateId === undefined) throw new Error(`${event.type} requires envelope.programStateId`);
  return event.programStateId;
}

function requirePayloadState<TState>(event: PersistedDomainEvent<string, unknown>): TState {
  const payload = event.payload as Partial<ProgramStateEventPayloadV1<TState>> | null;
  if (payload === null || typeof payload !== "object" || !("state" in payload)) {
    throw new Error(`${event.type} requires payload.state`);
  }
  return payload.state as TState;
}

function inspectAndValidate<TState>(
  event: PersistedDomainEvent<string, unknown>,
  codec: ProgramProjectionCodec<TState>,
  state: TState,
): ReturnType<ProgramProjectionCodec<TState>["inspect"]> {
  const inspected = codec.inspect(state);
  if (inspected.programStateId !== String(requireProgramStateId(event))) {
    throw new Error("Program projection state identity does not match event envelope");
  }
  if (!Number.isSafeInteger(inspected.revision) || inspected.revision < 1) {
    throw new Error("Program projection revision must be a positive safe integer");
  }
  if (inspected.lifecycle !== "active" && inspected.lifecycle !== "completed" && inspected.lifecycle !== "cancelled") {
    throw new Error(`Unsupported Program lifecycle ${String(inspected.lifecycle)}`);
  }
  const serialized = codec.serialize(state);
  if (typeof serialized !== "string" || serialized.length === 0) {
    throw new Error("Program projection codec must serialize to a non-empty string");
  }
  return inspected;
}

function isProgramStateEvent(type: string): boolean {
  return type === "program.created" || type === "program.transitioned" ||
    type === "program.completed" || type === "program.cancelled";
}

function assertLifecycleMatchesEvent(
  eventType: string,
  lifecycle: "active" | "completed" | "cancelled",
): void {
  if (eventType === "program.created" && lifecycle !== "active") {
    throw new Error("program.created must project an active Program");
  }
  if (eventType === "program.transitioned" && lifecycle !== "active") {
    throw new Error("program.transitioned cannot replace canonical Program terminal events");
  }
  if (eventType === "program.completed" && lifecycle !== "completed") {
    throw new Error("program.completed must project lifecycle completed");
  }
  if (eventType === "program.cancelled" && lifecycle !== "cancelled") {
    throw new Error("program.cancelled must project lifecycle cancelled");
  }
}

function applyProgramEvent<TState>(
  workspaceId: string,
  codec: ProgramProjectionCodec<TState>,
  event: PersistedDomainEvent<string, unknown>,
  tx: ProjectionTransaction,
): void {
  if (String(event.workspaceId) !== workspaceId) {
    throw new Error(`Program projection Workspace ${workspaceId} does not match event Workspace ${String(event.workspaceId)}`);
  }
  if (!isProgramStateEvent(event.type)) return;

  const state = requirePayloadState<TState>(event);
  const inspected = inspectAndValidate(event, codec, state);
  assertLifecycleMatchesEvent(event.type, inspected.lifecycle);
  const serialized = codec.serialize(state);
  const programStateId = inspected.programStateId;

  if (event.type === "program.created") {
    if (inspected.revision !== 1) throw new Error("program.created must project Program revision 1");
    const changes = tx.exec(
      "insert-program-state",
      programStateId, workspaceId, inspected.revision, inspected.lifecycle,
      serialized, event.sequence, event.sequence,
    );
    if (changes !== 1) throw new Error(`program.created did not create exactly one ProgramState ${programStateId}`);
    return;
  }

  if (inspected.revision <= 1) throw new Error(`${event.type} must advance beyond Program revision 1`);
  const expectedPreviousRevision = inspected.revision - 1;
  const changes = tx.exec(
    "advance-program-state",
    inspected.revision, inspected.lifecycle, serialized, event.sequence,
    programStateId, workspaceId, expectedPreviousRevision,
  );
  if (changes !== 1) {
    throw new Error(
      `${event.type} cannot advance ${programStateId} from expected revision ${expectedPreviousRevision}; ` +
      "the Program is unknown, belongs to another Workspace, or canonical revision history is non-contiguous",
    );
  }
}

export function createProgramStateProjection<TState>(
  workspaceId: string,
  codec: ProgramProjectionCodec<TState>,
): ProjectionDefinition {
  if (workspaceId.length === 0) throw new Error("Program projection requires a Workspace identity");
  return {
    name: PROGRAM_PROJECTION_NAME,
    schemaVersion: PROGRAM_PROJECTION_SCHEMA_VERSION,
    classification: "derived",
    setupStatements,
    statements,
    apply(event, tx) { applyProgramEvent(workspaceId, codec, event, tx); },
  };
}

function readRow<TState>(
  codec: ProgramProjectionCodec<TState>,
  row: {
    program_state_id: string;
    workspace_id: string;
    revision: number;
    lifecycle: "active" | "completed" | "cancelled";
    state_json: string;
    created_sequence: number;
    updated_sequence: number;
  },
): ProjectedProgramRecord<TState> {
  const state = codec.deserialize(row.state_json);
  const inspected = codec.inspect(state);
  if (inspected.programStateId !== row.program_state_id || inspected.revision !== row.revision || inspected.lifecycle !== row.lifecycle) {
    throw new Error(`Program projection row/state mismatch for ${row.program_state_id}`);
  }
  return {
    programStateId: row.program_state_id,
    workspaceId: row.workspace_id,
    revision: row.revision,
    lifecycle: row.lifecycle,
    state,
    createdSequence: row.created_sequence,
    updatedSequence: row.updated_sequence,
  };
}

/**
 * Direct reads are Workspace-scoped even though a workspace database normally
 * contains one Workspace. Keeping the Workspace predicate in SQL makes the
 * helper consistent with projection writes and fails closed under manual DB
 * corruption or future storage-layout changes.
 */
export function readProgramState<TState>(
  db: Database.Database,
  codec: ProgramProjectionCodec<TState>,
  workspaceId: string,
  programStateId: ProgramStateId | string,
): ProjectedProgramRecord<TState> | null {
  const row = db.prepare(
    `SELECT program_state_id, workspace_id, revision, lifecycle, state_json,
      created_sequence, updated_sequence
     FROM program_states WHERE program_state_id = ? AND workspace_id = ?`,
  ).get(String(programStateId), workspaceId) as {
    program_state_id: string;
    workspace_id: string;
    revision: number;
    lifecycle: "active" | "completed" | "cancelled";
    state_json: string;
    created_sequence: number;
    updated_sequence: number;
  } | undefined;
  return row === undefined ? null : readRow(codec, row);
}

export function listProgramStates<TState>(
  db: Database.Database,
  codec: ProgramProjectionCodec<TState>,
  workspaceId: string,
): ProjectedProgramRecord<TState>[] {
  const rows = db.prepare(
    `SELECT program_state_id, workspace_id, revision, lifecycle, state_json,
      created_sequence, updated_sequence
     FROM program_states
     WHERE workspace_id = ?
     ORDER BY updated_sequence, program_state_id`,
  ).all(workspaceId) as Array<{
    program_state_id: string;
    workspace_id: string;
    revision: number;
    lifecycle: "active" | "completed" | "cancelled";
    state_json: string;
    created_sequence: number;
    updated_sequence: number;
  }>;
  return rows.map((row) => readRow(codec, row));
}
