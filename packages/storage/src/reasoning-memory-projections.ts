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
  /** Phase 0.3 extended fields (optional for v1 backward compatibility) */
  name?: string;
  confidence?: number;
  fields?: Record<string, unknown>;
  /** Event IDs that caused this memory's creation (provenance). */
  sourceEventIds?: string[];
}

export interface MemoryReinforcedPayload {
  memoryId: string;
  kind: "seen" | "used" | "consolidated";
  count: number;
  consolidationCount: number;
  strength: number;
}

export interface MemoryLifecycleEventPayload {
  memoryId: string;
  from: string;
  to: string;
}

export const memoryStatements: readonly StatementDefinition[] = [
  {
    name: "insert-memory",
    sql: `INSERT OR REPLACE INTO memories
      (memory_id, workspace_id, type, body, created_sequence, name, fields_json, confidence, source_event_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  },
  {
    name: "insert-memory-stats",
    sql: `INSERT OR REPLACE INTO memory_stats
      (memory_id, type, confidence, last_seen, last_used, seen_count,
       used_count, consolidation_count, strength, lifecycle, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  },
  {
    name: "update-memory-seen",
    sql: `UPDATE memory_stats SET seen_count = ?, last_seen = ?, updated_at = ?
      WHERE memory_id = ?`,
  },
  {
    name: "update-memory-used",
    sql: `UPDATE memory_stats SET used_count = ?, consolidation_count = ?,
      last_used = ?, strength = ?, updated_at = ?
      WHERE memory_id = ?`,
  },
  {
    name: "update-memory-lifecycle",
    sql: `UPDATE memory_stats SET lifecycle = ?, updated_at = ?
      WHERE memory_id = ?`,
  },
];

/**
 * The memory projection. Classified 'derived'. Schema v2 — handles the full
 * Phase 0.3 memory lifecycle: creation with initial stats, reinforcement
 * (seen/used/consolidated), and lifecycle transitions (archived/tombstoned/
 * deleted/restored). Rebuildable from canonical memory.* events.
 */
export function createMemoryProjection(workspaceId: string): ProjectionDefinition {
  return {
    name: "memory",
    schemaVersion: 2,
    classification: "derived",
    statements: memoryStatements,
    apply(event: PersistedDomainEvent<string, unknown>, tx: ProjectionTransaction): void {
      const occurredAt = event.occurredAt;
      const eventTime = new Date(occurredAt).getTime();

      switch (event.type) {
        case "memory.created": {
          const p = event.payload as MemoryCreatedPayload;
          // Insert immutable record with full semantic content
          tx.exec(
            "insert-memory",
            p.memoryId,
            workspaceId,
            p.type,
            p.body,
            event.sequence,
            p.name ?? null,
            p.fields ? JSON.stringify(p.fields) : null,
            p.confidence ?? null,
            p.sourceEventIds ? JSON.stringify(p.sourceEventIds) : null,
          );
          // Insert initial stats
          tx.exec(
            "insert-memory-stats",
            p.memoryId,
            p.type,
            p.confidence ?? 0.5,
            null, // last_seen
            null, // last_used
            0,    // seen_count
            0,    // used_count
            0,    // consolidation_count
            p.confidence ?? 0.5, // initial strength = confidence at creation
            "active",
            eventTime,
            eventTime,
          );
          break;
        }

        case "memory.reinforced": {
          const p = event.payload as MemoryReinforcedPayload;
          if (p.kind === "seen") {
            tx.exec("update-memory-seen", p.count, eventTime, eventTime, p.memoryId);
          } else {
            // "used" or "consolidated" — both update the same fields
            tx.exec(
              "update-memory-used",
              p.count,
              p.consolidationCount,
              eventTime,
              p.strength,
              eventTime,
              p.memoryId,
            );
          }
          break;
        }

        case "memory.archived":
        case "memory.tombstoned":
        case "memory.deleted":
        case "memory.restored": {
          const p = event.payload as MemoryLifecycleEventPayload;
          tx.exec("update-memory-lifecycle", p.to, eventTime, p.memoryId);
          break;
        }

        default:
          break;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Memory query helper (read-only)
// ---------------------------------------------------------------------------

export interface MemoryRecord {
  memoryId: string;
  workspaceId: string;
  type: string;
  body: string;
  createdSequence: number;
  name: string | null;
  fields: Record<string, unknown> | null;
  confidence: number | null;
  sourceEventIds: string[] | null;
}

export interface MemoryStatsRecord {
  memoryId: string;
  type: string;
  confidence: number;
  lastSeen: number | null;
  lastUsed: number | null;
  seenCount: number;
  usedCount: number;
  consolidationCount: number;
  strength: number;
  lifecycle: string;
  createdAt: number;
  updatedAt: number;
}

export function createMemoryQuery(db: import("better-sqlite3").Database) {
  function rowToRecord(row: Record<string, unknown>): MemoryRecord {
    let fields: Record<string, unknown> | null = null;
    if (row.fields_json) {
      try { fields = JSON.parse(row.fields_json as string); } catch { /* malformed */ }
    }
    let sourceEventIds: string[] | null = null;
    if (row.source_event_ids) {
      try { sourceEventIds = JSON.parse(row.source_event_ids as string); } catch { /* malformed */ }
    }
    return {
      memoryId: row.memory_id as string,
      workspaceId: row.workspace_id as string,
      type: row.type as string,
      body: row.body as string,
      createdSequence: row.created_sequence as number,
      name: (row.name as string | null) ?? null,
      fields,
      confidence: (row.confidence as number | null) ?? null,
      sourceEventIds,
    };
  }

  function rowToStats(row: Record<string, unknown>): MemoryStatsRecord {
    return {
      memoryId: row.memory_id as string,
      type: row.type as string,
      confidence: row.confidence as number,
      lastSeen: (row.last_seen as number | null) ?? null,
      lastUsed: (row.last_used as number | null) ?? null,
      seenCount: row.seen_count as number,
      usedCount: row.used_count as number,
      consolidationCount: row.consolidation_count as number,
      strength: row.strength as number,
      lifecycle: row.lifecycle as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
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
    getStats(memoryId: string): MemoryStatsRecord | undefined {
      const row = db.prepare("SELECT * FROM memory_stats WHERE memory_id = ?").get(memoryId);
      return row ? rowToStats(row as Record<string, unknown>) : undefined;
    },
    getAllStats(): MemoryStatsRecord[] {
      const rows = db.prepare("SELECT * FROM memory_stats ORDER BY created_at").all();
      return (rows as Record<string, unknown>[]).map(rowToStats);
    },
    getActiveStats(): MemoryStatsRecord[] {
      const rows = db.prepare("SELECT * FROM memory_stats WHERE lifecycle = 'active' ORDER BY created_at").all();
      return (rows as Record<string, unknown>[]).map(rowToStats);
    },
  };
}
