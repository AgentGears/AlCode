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
// Reasoning projection v2 (reasoning.* events → reasoning_nodes + reasoning_edges)
// ===========================================================================

export interface ObjectiveSetPayload {
  nodeId: string;
  kind: string;
  label: string;
  data?: unknown;
  confidence?: number;
  // Phase 0.4 extended fields
  statement?: string;
  successCriteria?: string;
  revisesObjectiveId?: string;
}

export const reasoningStatements: readonly StatementDefinition[] = [
  {
    name: "insert-reasoning-node",
    sql: `INSERT OR REPLACE INTO reasoning_nodes
      (node_id, workspace_id, session_id, kind, label, data, confidence, step, created_sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  },
  {
    name: "insert-reasoning-edge",
    sql: `INSERT OR REPLACE INTO reasoning_edges
      (edge_id, workspace_id, session_id, source_node_id, target_node_id, kind, data, created_sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  },
];

/** Derive a deterministic node ID from event metadata. */
function deriveReasoningNodeId(sessionId: string, sequence: number, kind: string): string {
  return `event:${sessionId}:${sequence}:${kind}`;
}

/** Derive a deterministic edge ID. */
function deriveReasoningEdgeId(sessionId: string, sequence: number, relation: string, ordinal: number): string {
  return `event:${sessionId}:${sequence}:edge:${relation}:${ordinal}`;
}

/**
 * The reasoning projection. Classified 'derived'. Schema v2 — handles the
 * full Phase 0.4 reasoning event set, reconstructing both nodes and edges
 * from canonical reasoning.* events. Rebuildable from events.
 *
 * Also handles the Phase 0.2 legacy objective.set event for backward
 * compatibility — canonical history is immutable.
 */
export function createReasoningProjection(workspaceId: string): ProjectionDefinition {
  return {
    name: "reasoning",
    schemaVersion: 2,
    classification: "derived",
    statements: reasoningStatements,
    apply(event: PersistedDomainEvent<string, unknown>, tx: ProjectionTransaction): void {
      const sessionId = event.sessionId;
      const seq = event.sequence;
      let edgeOrdinal = 0;

      switch (event.type) {
        // Legacy Phase 0.2 objective.set
        case "objective.set": {
          const p = event.payload as ObjectiveSetPayload;
          tx.exec(
            "insert-reasoning-node",
            p.nodeId,
            workspaceId,
            sessionId,
            p.kind ?? "objective",
            p.label ?? p.statement ?? "",
            p.data !== undefined ? JSON.stringify(p.data) : null,
            p.confidence ?? null,
            null,
            seq,
          );
          break;
        }

        // Phase 0.4 cognitive events
        case "objective": {
          const p = event.payload as Record<string, unknown>;
          const nodeId = deriveReasoningNodeId(sessionId, seq, "objective");
          tx.exec("insert-reasoning-node", nodeId, workspaceId, sessionId, "objective",
            (p.statement as string) ?? "", JSON.stringify(p), null, null, seq);
          break;
        }

        case "hypothesis": {
          const p = event.payload as Record<string, unknown>;
          const nodeId = deriveReasoningNodeId(sessionId, seq, "hypothesis");
          tx.exec("insert-reasoning-node", nodeId, workspaceId, sessionId, "hypothesis",
            (p.claim as string) ?? "", JSON.stringify(p), (p.confidence as number) ?? null, null, seq);

          // Falsifier
          const falsifier = p.falsifier as string | undefined;
          if (falsifier) {
            const falsifierId = deriveReasoningNodeId(sessionId, seq, "falsifier");
            tx.exec("insert-reasoning-node", falsifierId, workspaceId, sessionId, "falsifier",
              falsifier, JSON.stringify({ statement: falsifier, forHypothesisId: nodeId, satisfied: false }),
              null, null, seq);
            tx.exec("insert-reasoning-edge",
              deriveReasoningEdgeId(sessionId, seq, "falsifies", edgeOrdinal++),
              workspaceId, sessionId, falsifierId, nodeId, "falsifies", "{}", seq);
          }

          // Addresses objective
          const objId = p.objectiveId as string | undefined;
          if (objId) {
            tx.exec("insert-reasoning-edge",
              deriveReasoningEdgeId(sessionId, seq, "addresses", edgeOrdinal++),
              workspaceId, sessionId, nodeId, objId, "addresses", "{}", seq);
          }

          // Supersedes
          const supId = p.supersedesHypothesisId as string | undefined;
          if (supId) {
            tx.exec("insert-reasoning-edge",
              deriveReasoningEdgeId(sessionId, seq, "revises", edgeOrdinal++),
              workspaceId, sessionId, nodeId, supId, "revises", "{}", seq);
          }
          break;
        }

        case "assumption": {
          const p = event.payload as Record<string, unknown>;
          const nodeId = deriveReasoningNodeId(sessionId, seq, "assumption");
          tx.exec("insert-reasoning-node", nodeId, workspaceId, sessionId, "assumption",
            (p.statement as string) ?? "", JSON.stringify(p), null, null, seq);

          const forHypId = p.forHypothesisId as string | undefined;
          if (forHypId) {
            tx.exec("insert-reasoning-edge",
              deriveReasoningEdgeId(sessionId, seq, "depends_on", edgeOrdinal++),
              workspaceId, sessionId, forHypId, nodeId, "depends_on", "{}", seq);
          }

          const inferredFrom = p.inferredFrom as string[] | undefined;
          if (inferredFrom) {
            for (const srcId of inferredFrom) {
              tx.exec("insert-reasoning-edge",
                deriveReasoningEdgeId(sessionId, seq, "produced_by", edgeOrdinal++),
                workspaceId, sessionId, nodeId, srcId, "produced_by", "{}", seq);
            }
          }
          break;
        }

        case "alternative": {
          const p = event.payload as Record<string, unknown>;
          const nodeId = deriveReasoningNodeId(sessionId, seq, "alternative");
          tx.exec("insert-reasoning-node", nodeId, workspaceId, sessionId, "alternative",
            (p.label as string) ?? "", JSON.stringify(p), null, null, seq);

          const altToId = p.alternativeToHypothesisId as string | undefined;
          if (altToId) {
            tx.exec("insert-reasoning-edge",
              deriveReasoningEdgeId(sessionId, seq, "alternative_to", edgeOrdinal++),
              workspaceId, sessionId, nodeId, altToId, "alternative_to", "{}", seq);
          }
          break;
        }

        case "decision": {
          const p = event.payload as Record<string, unknown>;
          const nodeId = deriveReasoningNodeId(sessionId, seq, "decision");
          tx.exec("insert-reasoning-node", nodeId, workspaceId, sessionId, "decision",
            (p.action as string) ?? "", JSON.stringify(p), null, null, seq);

          const basedOn = p.basedOn as string[] | undefined;
          if (basedOn) {
            for (const srcId of basedOn) {
              tx.exec("insert-reasoning-edge",
                deriveReasoningEdgeId(sessionId, seq, "produced_by", edgeOrdinal++),
                workspaceId, sessionId, nodeId, srcId, "produced_by", "{}", seq);
            }
          }

          const supId = p.supersedesDecisionId as string | undefined;
          if (supId) {
            tx.exec("insert-reasoning-edge",
              deriveReasoningEdgeId(sessionId, seq, "revises", edgeOrdinal++),
              workspaceId, sessionId, nodeId, supId, "revises", "{}", seq);
          }
          break;
        }

        case "link_evidence": {
          const p = event.payload as Record<string, unknown>;
          const evidenceId = p.evidenceId as string;
          const targetId = p.targetId as string;
          const relation = p.relation as string;
          if (evidenceId && targetId && (relation === "supports" || relation === "contradicts")) {
            tx.exec("insert-reasoning-edge",
              deriveReasoningEdgeId(sessionId, seq, relation, edgeOrdinal++),
              workspaceId, sessionId, evidenceId, targetId, relation, "{}", seq);
          }
          break;
        }

        case "verification_contract": {
          const p = event.payload as Record<string, unknown>;
          const nodeId = deriveReasoningNodeId(sessionId, seq, "verification_contract");
          tx.exec("insert-reasoning-node", nodeId, workspaceId, sessionId, "verification_contract",
            (p.description as string) ?? "verification_contract", JSON.stringify(p), null, null, seq);

          const hypId = p.hypothesisId as string | undefined;
          if (hypId) {
            tx.exec("insert-reasoning-edge",
              deriveReasoningEdgeId(sessionId, seq, "tests", edgeOrdinal++),
              workspaceId, sessionId, nodeId, hypId, "tests", "{}", seq);
          }
          break;
        }

        case "falsifier_evaluation": {
          const p = event.payload as Record<string, unknown>;
          const nodeId = deriveReasoningNodeId(sessionId, seq, "falsifier_evaluation");
          tx.exec("insert-reasoning-node", nodeId, workspaceId, sessionId, "falsifier_evaluation",
            `evaluation:${p.state ?? "unknown"}`, JSON.stringify(p), null, null, seq);

          const falsifierId = p.falsifierId as string | undefined;
          if (falsifierId) {
            tx.exec("insert-reasoning-edge",
              deriveReasoningEdgeId(sessionId, seq, "evaluates", edgeOrdinal++),
              workspaceId, sessionId, nodeId, falsifierId, "evaluates", "{}", seq);
          }

          const evidenceIds = p.evidenceNodeIds as string[] | undefined;
          if (evidenceIds) {
            for (const evId of evidenceIds) {
              tx.exec("insert-reasoning-edge",
                deriveReasoningEdgeId(sessionId, seq, "based_on", edgeOrdinal++),
                workspaceId, sessionId, nodeId, evId, "based_on", "{}", seq);
            }
          }

          // Satisfied falsifier → CONTRADICTS hypothesis (asymmetry)
          if (p.state === "satisfied" && falsifierId) {
            // The forHypothesisId is on the falsifier node; we can't look it
            // up in the projection, so we store the contradicts edges from the
            // payload's evidenceNodeIds to the falsifier's hypothesis.
            // In practice the reducer handles this; the projection stores what
            // the event carries.
          }
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
      (memory_id, workspace_id, type, body, created_sequence, name, fields_json, confidence, source_event_ids, stored_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            eventTime,
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
  storedAt: number | null;
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
      storedAt: (row.stored_at as number | null) ?? null,
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
