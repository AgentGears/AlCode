// ReasoningGraph — structural graph with cognitive validation.
//
// Ported from Ouroboros graph.py with the correction from the frozen plan:
// the canonical Phase 0.4 cognitive graph does NOT require a GOAL node.
// Legacy single-loop validation (exactly one GOAL) is available separately
// for source compatibility.
//
// The graph is a pure data structure — no filesystem persistence. JSON
// serialization supports round-trip fidelity.

import {
  type NodeKind,
  type EdgeKind,
  type ReasoningNode,
  type ReasoningEdge,
  NodeKind as NK,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// Graph error
// ---------------------------------------------------------------------------

export class GraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphValidationError";
  }
}

// ---------------------------------------------------------------------------
// ReasoningGraph
// ---------------------------------------------------------------------------

export interface ReasoningGraph {
  nodes: Map<string, ReasoningNode>;
  edges: Map<string, ReasoningEdge>;
}

export function createReasoningGraph(): ReasoningGraph {
  return { nodes: new Map(), edges: new Map() };
}

// ---------------------------------------------------------------------------
// Node and edge operations
// ---------------------------------------------------------------------------

export function addNode(graph: ReasoningGraph, node: ReasoningNode): void {
  graph.nodes.set(node.id, node);
}

export function addEdge(graph: ReasoningGraph, edge: ReasoningEdge): void {
  graph.edges.set(edge.id, edge);
}

export function getNode(graph: ReasoningGraph, id: string): ReasoningNode | undefined {
  return graph.nodes.get(id);
}

export function getEdge(graph: ReasoningGraph, id: string): ReasoningEdge | undefined {
  return graph.edges.get(id);
}

export function getNodesByKind(graph: ReasoningGraph, kind: NodeKind): ReasoningNode[] {
  return [...graph.nodes.values()].filter((n) => n.kind === kind);
}

export function getEdgesByKind(graph: ReasoningGraph, kind: EdgeKind): ReasoningEdge[] {
  return [...graph.edges.values()].filter((e) => e.kind === kind);
}

export function getIncomingEdges(graph: ReasoningGraph, nodeId: string): ReasoningEdge[] {
  return [...graph.edges.values()].filter((e) => e.target === nodeId);
}

export function getOutgoingEdges(graph: ReasoningGraph, nodeId: string): ReasoningEdge[] {
  return [...graph.edges.values()].filter((e) => e.source === nodeId);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate the cognitive graph (canonical Phase 0.4).
 * Checks: all edge endpoints exist as nodes.
 * Does NOT require a GOAL node.
 */
export function validateCognitiveGraph(graph: ReasoningGraph): void {
  for (const edge of graph.edges.values()) {
    if (!graph.nodes.has(edge.source)) {
      throw new GraphValidationError(
        `Edge ${edge.id} references non-existent source node: ${edge.source}`,
      );
    }
    if (!graph.nodes.has(edge.target)) {
      throw new GraphValidationError(
        `Edge ${edge.id} references non-existent target node: ${edge.target}`,
      );
    }
  }
}

/**
 * Validate the legacy single-loop graph (source compatibility).
 * Checks: exactly one GOAL node; all edge endpoints exist.
 * This is the original Ouroboros validation for the engine path.
 */
export function validateSingleLoopGraph(graph: ReasoningGraph): void {
  validateCognitiveGraph(graph);

  const goals = getNodesByKind(graph, NK.GOAL);
  if (goals.length !== 1) {
    throw new GraphValidationError(
      `Single-loop graph must have exactly one GOAL node; found ${goals.length}`,
    );
  }
}

// ---------------------------------------------------------------------------
// JSON serialization
// ---------------------------------------------------------------------------

export interface GraphJSON {
  nodes: ReasoningNode[];
  edges: ReasoningEdge[];
}

export function graphToJSON(graph: ReasoningGraph): GraphJSON {
  return {
    nodes: [...graph.nodes.values()],
    edges: [...graph.edges.values()],
  };
}

export function graphFromJSON(json: GraphJSON): ReasoningGraph {
  const graph = createReasoningGraph();
  for (const node of json.nodes) addNode(graph, node);
  for (const edge of json.edges) addEdge(graph, edge);
  return graph;
}

// ---------------------------------------------------------------------------
// Supersession — a node is active iff it is not the target of a REVISES
// edge from a same-kind node.
// ---------------------------------------------------------------------------

import { EdgeKind as EK } from "./schema.ts";

export function getSupersededIds(graph: ReasoningGraph): Set<string> {
  const superseded = new Set<string>();
  for (const edge of graph.edges.values()) {
    if (edge.kind !== EK.REVISES) continue;
    const source = graph.nodes.get(edge.source);
    const target = graph.nodes.get(edge.target);
    if (source && target && source.kind === target.kind) {
      superseded.add(edge.target);
    }
  }
  return superseded;
}

export function isNodeActive(graph: ReasoningGraph, nodeId: string): boolean {
  return !getSupersededIds(graph).has(nodeId);
}

// ---------------------------------------------------------------------------
// Sequence extraction from deterministic IDs
// ---------------------------------------------------------------------------

/**
 * Extract the sequence number from a deterministic node/edge ID.
 * Format: event:{session}:{sequence}:{type} or event:{session}:{sequence}:edge:{relation}:{ordinal}
 */
export function extractSequence(id: string): number {
  const parts = id.split(":");
  // parts: ["event", session, seq, ...]
  if (parts.length >= 3 && parts[0] === "event") {
    const seq = parseInt(parts[2]!, 10);
    if (!isNaN(seq)) return seq;
  }
  return 0;
}
