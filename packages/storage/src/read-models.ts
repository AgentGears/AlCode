import type Database from "better-sqlite3";
import { createOperationQuery, type OperationQuery } from "./operations.ts";
import { createTranscriptQuery } from "./transcript-projection.ts";
import { createMemoryQuery } from "./reasoning-memory-projections.ts";

export type TranscriptQuery = ReturnType<typeof createTranscriptQuery>;
export type MemoryQuery = ReturnType<typeof createMemoryQuery>;

export interface ReasoningNodeRecord {
  nodeId: string;
  workspaceId: string;
  sessionId: string | null;
  kind: string;
  label: string;
  data: Record<string, unknown>;
  confidence: number | null;
  step: number | null;
  createdSequence: number;
}

export interface ReasoningEdgeRecord {
  edgeId: string;
  workspaceId: string;
  sessionId: string | null;
  sourceNodeId: string;
  targetNodeId: string;
  kind: string;
  data: Record<string, unknown>;
  createdSequence: number;
}

export interface ReasoningProjectionSnapshot {
  sessionId: string;
  nodes: ReasoningNodeRecord[];
  edges: ReasoningEdgeRecord[];
}

export interface ReasoningQuery {
  getSessionGraph(sessionId: string): ReasoningProjectionSnapshot;
}

export interface WorkspaceReadModels {
  operations: OperationQuery;
  transcript: TranscriptQuery;
  memory: MemoryQuery;
  reasoning: ReasoningQuery;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function createReasoningQuery(db: Database.Database): ReasoningQuery {
  return {
    getSessionGraph(sessionId: string): ReasoningProjectionSnapshot {
      const nodeRows = db.prepare(
        "SELECT * FROM reasoning_nodes WHERE session_id = ? ORDER BY created_sequence, node_id",
      ).all(sessionId) as Record<string, unknown>[];
      const edgeRows = db.prepare(
        "SELECT * FROM reasoning_edges WHERE session_id = ? ORDER BY created_sequence, edge_id",
      ).all(sessionId) as Record<string, unknown>[];

      return {
        sessionId,
        nodes: nodeRows.map((row) => ({
          nodeId: row.node_id as string,
          workspaceId: row.workspace_id as string,
          sessionId: (row.session_id as string | null) ?? null,
          kind: row.kind as string,
          label: row.label as string,
          data: parseObject(row.data),
          confidence: (row.confidence as number | null) ?? null,
          step: (row.step as number | null) ?? null,
          createdSequence: row.created_sequence as number,
        })),
        edges: edgeRows.map((row) => ({
          edgeId: row.edge_id as string,
          workspaceId: row.workspace_id as string,
          sessionId: (row.session_id as string | null) ?? null,
          sourceNodeId: row.source_node_id as string,
          targetNodeId: row.target_node_id as string,
          kind: row.kind as string,
          data: parseObject(row.data),
          createdSequence: row.created_sequence as number,
        })),
      };
    },
  };
}

export function createWorkspaceReadModels(db: Database.Database): WorkspaceReadModels {
  return Object.freeze({
    operations: createOperationQuery(db),
    transcript: createTranscriptQuery(db),
    memory: createMemoryQuery(db),
    reasoning: createReasoningQuery(db),
  });
}
