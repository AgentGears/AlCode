// Minimal reasoning and memory projections — derived. These are the
// Phase 0.2 cognition placeholders: a single objective node and a single
// memory record, satisfying the exact-gate sequence's reasoning/memory steps
// without any scoring, graph semantics, or Ola/Ouroboros port.
//
// See docs/phase-0-spec.md §0.2 Step 10.

import type { PersistedDomainEvent } from "@alcode/events";
import type {
  ProjectionDefinition,
  ProjectionTransaction,
  StatementDefinition,
} from "./projection.ts";

// ===========================================================================
// Reasoning projection (objective.set → reasoning_nodes)
// ===========================================================================

export interface ObjectiveSetPayload {
  nodeId: string;
  kind: string;
  label: string;
  data?: unknown;
  confidence?: number;
}

export const reasoningStatements: readonly StatementDefinition[] = [
  {
    name: "insert-reasoning-node",
    sql: `INSERT OR REPLACE INTO reasoning_nodes
      (node_id, workspace_id, kind, label, data, confidence, created_sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
  },
];

/**
 * The reasoning projection. Classified 'derived'. Handles objective.set by
 * inserting a single objective node. Minimal — no graph edges or scoring.
 */
export function createReasoningProjection(workspaceId: string): ProjectionDefinition {
  return {
    name: "reasoning",
    schemaVersion: 1,
    classification: "derived",
    statements: reasoningStatements,
    apply(event: PersistedDomainEvent<string, unknown>, tx: ProjectionTransaction): void {
      switch (event.type) {
        case "objective.set": {
          const p = event.payload as ObjectiveSetPayload;
          tx.exec(
            "insert-reasoning-node",
            p.nodeId,
            workspaceId,
            p.kind,
            p.label,
            p.data !== undefined ? JSON.stringify(p.data) : null,
            p.confidence ?? null,
            event.sequence,
          );
          break;
        }

        default:
          break;
      }
    },
  };
}

// ===========================================================================
// Memory projection (memory.created → memories)
// ===========================================================================

export interface MemoryCreatedPayload {
  memoryId: string;
  type: string;
  body: string;
}

export const memoryStatements: readonly StatementDefinition[] = [
  {
    name: "insert-memory",
    sql: `INSERT OR REPLACE INTO memories
      (memory_id, workspace_id, type, body, created_sequence)
      VALUES (?, ?, ?, ?, ?)`,
  },
];

/**
 * The memory projection. Classified 'derived'. Handles memory.created by
 * inserting a single memory record. Minimal — no scoring or consolidation.
 */
export function createMemoryProjection(workspaceId: string): ProjectionDefinition {
  return {
    name: "memory",
    schemaVersion: 1,
    classification: "derived",
    statements: memoryStatements,
    apply(event: PersistedDomainEvent<string, unknown>, tx: ProjectionTransaction): void {
      switch (event.type) {
        case "memory.created": {
          const p = event.payload as MemoryCreatedPayload;
          tx.exec(
            "insert-memory",
            p.memoryId,
            workspaceId,
            p.type,
            p.body,
            event.sequence,
          );
          break;
        }

        default:
          break;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Memory query helper (read-only — for the "create/retrieve one memory" gate step)
// ---------------------------------------------------------------------------

export interface MemoryRecord {
  memoryId: string;
  workspaceId: string;
  type: string;
  body: string;
  createdSequence: number;
}

export function createMemoryQuery(db: import("better-sqlite3").Database) {
  function rowToRecord(row: Record<string, unknown>): MemoryRecord {
    return {
      memoryId: row.memory_id as string,
      workspaceId: row.workspace_id as string,
      type: row.type as string,
      body: row.body as string,
      createdSequence: row.created_sequence as number,
    };
  }

  return {
    getById(memoryId: string): MemoryRecord | undefined {
      const row = db.prepare("SELECT * FROM memories WHERE memory_id = ?").get(memoryId);
      return row ? rowToRecord(row as Record<string, unknown>) : undefined;
    },
    getAll(): MemoryRecord[] {
      const rows = db.prepare("SELECT * FROM memories ORDER BY created_sequence").all();
      return (rows as Record<string, unknown>[]).map(rowToRecord);
    },
  };
}
