// Reducer — deterministic event→graph reduction.
//
// The same event stream always produces the same graph, including node and
// edge identities. This is the load-bearing contract for replay/idempotence.
//
// ID scheme:
//   node_id: event:{session_id}:{sequence}:{node_type}
//   edge_id: event:{session_id}:{sequence}:edge:{relation}:{ordinal}
//
// Ported from Ouroboros reducer.py. The reducer never mutates the graph
// directly in production — the Host appends semantic events, and this
// reducer reconstructs the graph deterministically from the event stream.

import {
  type ReasoningGraph,
  addNode,
  addEdge,
  getNode,
} from "./graph.ts";
import {
  NodeKind as NK,
  EdgeKind as EK,
  type ReasoningNode,
  type ReasoningEdge,
} from "./schema.ts";
import type {
  ObjectivePayload,
  HypothesisPayload,
  AssumptionPayload,
  AlternativePayload,
  DecisionPayload,
  FalsifierEvaluationPayload,
  VerificationContractPayload,
} from "./cognitive.ts";

// ---------------------------------------------------------------------------
// Reduction index — tracks what has been applied for idempotence
// ---------------------------------------------------------------------------

export interface ReductionIndex {
  /** Set of node IDs already created (idempotence). */
  nodeIds: Set<string>;
  /** Set of edge IDs already created (idempotence). */
  edgeIds: Set<string>;
  /** Contracts indexed by (toolName, inputDigest) → contract node IDs. */
  pendingContracts: Map<string, string[]>;
  /** Contracts already consumed by an EXECUTES edge. */
  consumedContracts: Set<string>;
}

export function createReductionIndex(): ReductionIndex {
  return {
    nodeIds: new Set(),
    edgeIds: new Set(),
    pendingContracts: new Map(),
    consumedContracts: new Set(),
  };
}

// ---------------------------------------------------------------------------
// ID derivation
// ---------------------------------------------------------------------------

export function deriveNodeId(sessionId: string, sequence: number, nodeType: string): string {
  return `event:${sessionId}:${sequence}:${nodeType}`;
}

export function deriveEdgeId(
  sessionId: string,
  sequence: number,
  relation: string,
  ordinal: number,
): string {
  return `event:${sessionId}:${sequence}:edge:${relation}:${ordinal}`;
}

// ---------------------------------------------------------------------------
// Event types (the semantic events the reducer processes)
// ---------------------------------------------------------------------------

export type ReasoningEventType =
  | "objective"
  | "hypothesis"
  | "assumption"
  | "alternative"
  | "decision"
  | "link_evidence"
  | "verification_contract"
  | "falsifier_evaluation"
  | "objective.set"; // Legacy Phase 0.2 compat

export interface ReasoningEvent {
  type: ReasoningEventType | string;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Reduction — apply a single event to the graph
// ---------------------------------------------------------------------------

interface ReductionContext {
  graph: ReasoningGraph;
  sessionId: string;
  sequence: number;
  idx: ReductionIndex;
}

function addNodeIfAbsent(ctx: ReductionContext, node: ReasoningNode): void {
  if (ctx.idx.nodeIds.has(node.id)) return;
  ctx.idx.nodeIds.add(node.id);
  addNode(ctx.graph, node);
}

function addEdgeIfAbsent(ctx: ReductionContext, edge: ReasoningEdge): void {
  if (ctx.idx.edgeIds.has(edge.id)) return;
  ctx.idx.edgeIds.add(edge.id);
  addEdge(ctx.graph, edge);
}

function labelFromPayload(payload: Record<string, unknown>): string {
  return (payload.statement as string) ??
    (payload.claim as string) ??
    (payload.action as string) ??
    (payload.label as string) ??
    (payload.hypothesis as string) ??
    "";
}

/**
 * Reduce a single semantic event into the graph.
 * Idempotent: applying the same event twice produces the same graph.
 */
export function reduceEvent(
  graph: ReasoningGraph,
  sessionId: string,
  sequence: number,
  eventType: string,
  payload: Record<string, unknown>,
  idx: ReductionIndex = createReductionIndex(),
): void {
  const ctx: ReductionContext = { graph, sessionId, sequence, idx };

  switch (eventType) {
    case "objective":
    case "objective.set":
      reduceObjective(ctx, payload);
      break;
    case "hypothesis":
      reduceHypothesis(ctx, payload);
      break;
    case "assumption":
      reduceAssumption(ctx, payload);
      break;
    case "alternative":
      reduceAlternative(ctx, payload);
      break;
    case "decision":
      reduceDecision(ctx, payload);
      break;
    case "link_evidence":
      reduceLinkEvidence(ctx, payload);
      break;
    case "verification_contract":
      reduceVerificationContract(ctx, payload);
      break;
    case "falsifier_evaluation":
      reduceFalsifierEvaluation(ctx, payload);
      break;
    default:
      // Unknown event types are silently ignored (forward-compatible).
      break;
  }
}

// ---------------------------------------------------------------------------
// Individual reducers
// ---------------------------------------------------------------------------

function reduceObjective(ctx: ReductionContext, payload: Record<string, unknown>): void {
  const nodeId = deriveNodeId(ctx.sessionId, ctx.sequence, NK.OBJECTIVE);
  const node: ReasoningNode = {
    id: nodeId,
    kind: NK.OBJECTIVE,
    label: (payload.statement as string) ?? "",
    data: { ...payload },
    confidence: null,
    step: null,
  };
  addNodeIfAbsent(ctx, node);

  // Auto-revise: link to previous objective if revisesObjectiveId is set
  const revisesId = payload.revisesObjectiveId as string | undefined;
  if (revisesId && getNode(ctx.graph, revisesId)) {
    const edgeId = deriveEdgeId(ctx.sessionId, ctx.sequence, EK.REVISES, 0);
    addEdgeIfAbsent(ctx, {
      id: edgeId,
      source: nodeId,
      target: revisesId,
      kind: EK.REVISES,
      data: {},
    });
  }

  // Legacy objective.set compat: store as reasoning node with kind=objective
  // and minimal payload (nodeId, kind, label, data, confidence)
  if (payload.nodeId && typeof payload.nodeId === "string") {
    // Phase 0.2 minimal objective.set event — already handled above
  }
}

function reduceHypothesis(ctx: ReductionContext, payload: Record<string, unknown>): void {
  const nodeId = deriveNodeId(ctx.sessionId, ctx.sequence, NK.HYPOTHESIS);
  const confidence = payload.confidence as number | null ?? null;
  const node: ReasoningNode = {
    id: nodeId,
    kind: NK.HYPOTHESIS,
    label: (payload.claim as string) ?? "",
    data: { ...payload },
    confidence,
    step: null,
  };
  addNodeIfAbsent(ctx, node);

  let edgeOrdinal = 0;

  // Falsifier
  const falsifierStatement = payload.falsifier as string | undefined;
  if (falsifierStatement && falsifierStatement.length > 0) {
    const falsifierId = deriveNodeId(ctx.sessionId, ctx.sequence, NK.FALSIFIER);
    const falsifierNode: ReasoningNode = {
      id: falsifierId,
      kind: NK.FALSIFIER,
      label: falsifierStatement,
      data: { statement: falsifierStatement, forHypothesisId: nodeId, satisfied: false },
      confidence: null,
      step: null,
    };
    addNodeIfAbsent(ctx, falsifierNode);

    const falsifiesEdge = deriveEdgeId(ctx.sessionId, ctx.sequence, EK.FALSIFIES, edgeOrdinal++);
    addEdgeIfAbsent(ctx, {
      id: falsifiesEdge,
      source: falsifierId,
      target: nodeId,
      kind: EK.FALSIFIES,
      data: {},
    });
  }

  // Addresses objective
  const objectiveId = payload.objectiveId as string | undefined;
  if (objectiveId && getNode(ctx.graph, objectiveId)) {
    const addressesEdge = deriveEdgeId(ctx.sessionId, ctx.sequence, EK.ADDRESSES, edgeOrdinal++);
    addEdgeIfAbsent(ctx, {
      id: addressesEdge,
      source: nodeId,
      target: objectiveId,
      kind: EK.ADDRESSES,
      data: {},
    });
  }

  // Supersedes hypothesis
  const supersedesId = payload.supersedesHypothesisId as string | undefined;
  if (supersedesId && getNode(ctx.graph, supersedesId)) {
    const revisesEdge = deriveEdgeId(ctx.sessionId, ctx.sequence, EK.REVISES, edgeOrdinal++);
    addEdgeIfAbsent(ctx, {
      id: revisesEdge,
      source: nodeId,
      target: supersedesId,
      kind: EK.REVISES,
      data: {},
    });
  }
}

function reduceAssumption(ctx: ReductionContext, payload: Record<string, unknown>): void {
  const nodeId = deriveNodeId(ctx.sessionId, ctx.sequence, NK.ASSUMPTION);
  const node: ReasoningNode = {
    id: nodeId,
    kind: NK.ASSUMPTION,
    label: (payload.statement as string) ?? "",
    data: { ...payload },
    confidence: null,
    step: null,
  };
  addNodeIfAbsent(ctx, node);

  let edgeOrdinal = 0;

  const forHypId = payload.forHypothesisId as string | undefined;
  if (forHypId && getNode(ctx.graph, forHypId)) {
    addEdgeIfAbsent(ctx, {
      id: deriveEdgeId(ctx.sessionId, ctx.sequence, EK.DEPENDS_ON, edgeOrdinal++),
      source: forHypId,
      target: nodeId,
      kind: EK.DEPENDS_ON,
      data: {},
    });
  }

  const inferredFrom = payload.inferredFrom as string[] | undefined;
  if (inferredFrom) {
    for (const srcId of inferredFrom) {
      if (getNode(ctx.graph, srcId)) {
        addEdgeIfAbsent(ctx, {
          id: deriveEdgeId(ctx.sessionId, ctx.sequence, EK.PRODUCED_BY, edgeOrdinal++),
          source: nodeId,
          target: srcId,
          kind: EK.PRODUCED_BY,
          data: {},
        });
      }
    }
  }
}

function reduceAlternative(ctx: ReductionContext, payload: Record<string, unknown>): void {
  const nodeId = deriveNodeId(ctx.sessionId, ctx.sequence, NK.ALTERNATIVE);
  const node: ReasoningNode = {
    id: nodeId,
    kind: NK.ALTERNATIVE,
    label: (payload.label as string) ?? "",
    data: { ...payload },
    confidence: null,
    step: null,
  };
  addNodeIfAbsent(ctx, node);

  const altToId = payload.alternativeToHypothesisId as string | undefined;
  if (altToId && getNode(ctx.graph, altToId)) {
    addEdgeIfAbsent(ctx, {
      id: deriveEdgeId(ctx.sessionId, ctx.sequence, EK.ALTERNATIVE_TO, 0),
      source: nodeId,
      target: altToId,
      kind: EK.ALTERNATIVE_TO,
      data: {},
    });
  }
}

function reduceDecision(ctx: ReductionContext, payload: Record<string, unknown>): void {
  const nodeId = deriveNodeId(ctx.sessionId, ctx.sequence, NK.DECISION);
  const node: ReasoningNode = {
    id: nodeId,
    kind: NK.DECISION,
    label: (payload.action as string) ?? "",
    data: { ...payload },
    confidence: null,
    step: null,
  };
  addNodeIfAbsent(ctx, node);

  let edgeOrdinal = 0;

  const basedOn = payload.basedOn as string[] | undefined;
  if (basedOn) {
    for (const srcId of basedOn) {
      if (getNode(ctx.graph, srcId)) {
        addEdgeIfAbsent(ctx, {
          id: deriveEdgeId(ctx.sessionId, ctx.sequence, EK.PRODUCED_BY, edgeOrdinal++),
          source: nodeId,
          target: srcId,
          kind: EK.PRODUCED_BY,
          data: {},
        });
      }
    }
  }

  const supersedesId = payload.supersedesDecisionId as string | undefined;
  if (supersedesId && getNode(ctx.graph, supersedesId)) {
    addEdgeIfAbsent(ctx, {
      id: deriveEdgeId(ctx.sessionId, ctx.sequence, EK.REVISES, edgeOrdinal++),
      source: nodeId,
      target: supersedesId,
      kind: EK.REVISES,
      data: {},
    });
  }
}

function reduceLinkEvidence(ctx: ReductionContext, payload: Record<string, unknown>): void {
  const evidenceId = payload.evidenceId as string | undefined;
  const targetId = payload.targetId as string | undefined;
  const relation = payload.relation as string | undefined;

  if (!evidenceId || !targetId || !relation) return;
  if (relation !== "supports" && relation !== "contradicts") return;
  if (!getNode(ctx.graph, evidenceId) || !getNode(ctx.graph, targetId)) return;

  addEdgeIfAbsent(ctx, {
    id: deriveEdgeId(ctx.sessionId, ctx.sequence, relation, 0),
    source: evidenceId,
    target: targetId,
    kind: relation === "supports" ? EK.SUPPORTS : EK.CONTRADICTS,
    data: {},
  });
}

function reduceVerificationContract(ctx: ReductionContext, payload: Record<string, unknown>): void {
  const nodeId = deriveNodeId(ctx.sessionId, ctx.sequence, NK.VERIFICATION_CONTRACT);
  const node: ReasoningNode = {
    id: nodeId,
    kind: NK.VERIFICATION_CONTRACT,
    label: (payload.description as string) ?? "verification_contract",
    data: { ...payload },
    confidence: null,
    step: null,
  };
  addNodeIfAbsent(ctx, node);

  const hypId = payload.hypothesisId as string | undefined;
  if (hypId && getNode(ctx.graph, hypId)) {
    addEdgeIfAbsent(ctx, {
      id: deriveEdgeId(ctx.sessionId, ctx.sequence, EK.TESTS, 0),
      source: nodeId,
      target: hypId,
      kind: EK.TESTS,
      data: {},
    });
  }

  // Index for matching
  const matcher = payload.operationMatcher as { toolName: string; inputDigest: string } | undefined;
  if (matcher) {
    const key = `${matcher.toolName}:${matcher.inputDigest}`;
    const existing = ctx.idx.pendingContracts.get(key) ?? [];
    existing.push(nodeId);
    ctx.idx.pendingContracts.set(key, existing);
  }
}

function reduceFalsifierEvaluation(ctx: ReductionContext, payload: Record<string, unknown>): void {
  const nodeId = deriveNodeId(ctx.sessionId, ctx.sequence, NK.FALSIFIER_EVALUATION);
  const node: ReasoningNode = {
    id: nodeId,
    kind: NK.FALSIFIER_EVALUATION,
    label: `evaluation:${payload.state ?? "unknown"}`,
    data: { ...payload },
    confidence: null,
    step: null,
  };
  addNodeIfAbsent(ctx, node);

  let edgeOrdinal = 0;

  const falsifierId = payload.falsifierId as string | undefined;
  if (falsifierId && getNode(ctx.graph, falsifierId)) {
    addEdgeIfAbsent(ctx, {
      id: deriveEdgeId(ctx.sessionId, ctx.sequence, EK.EVALUATES, edgeOrdinal++),
      source: nodeId,
      target: falsifierId,
      kind: EK.EVALUATES,
      data: {},
    });
  }

  const evidenceIds = payload.evidenceNodeIds as string[] | undefined;
  if (evidenceIds) {
    for (const evId of evidenceIds) {
      if (getNode(ctx.graph, evId)) {
        addEdgeIfAbsent(ctx, {
          id: deriveEdgeId(ctx.sessionId, ctx.sequence, EK.BASED_ON, edgeOrdinal++),
          source: nodeId,
          target: evId,
          kind: EK.BASED_ON,
          data: {},
        });
      }
    }
  }

  // Critical asymmetry (0.13): if state == "satisfied" and the falsifier has
  // a forHypothesisId, auto-create CONTRADICTS edges from evidence to hypothesis.
  // A "refuted" falsifier does NOT auto-create SUPPORTS edges.
  const state = payload.state as string | undefined;
  if (state === "satisfied" && falsifierId) {
    const falsifier = getNode(ctx.graph, falsifierId);
    const forHypId = falsifier?.data.forHypothesisId as string | undefined;
    if (forHypId && getNode(ctx.graph, forHypId) && evidenceIds) {
      for (const evId of evidenceIds) {
        if (getNode(ctx.graph, evId)) {
          addEdgeIfAbsent(ctx, {
            id: deriveEdgeId(ctx.sessionId, ctx.sequence, EK.CONTRADICTS, edgeOrdinal++),
            source: evId,
            target: forHypId,
            kind: EK.CONTRADICTS,
            data: { auto_derived: true },
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Full stream reduction — rebuild graph from a list of events
// ---------------------------------------------------------------------------

export interface StreamEvent {
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Rebuild a graph from a stream of semantic events.
 * Deterministic: the same event stream always produces the same graph.
 */
export function reduceStream(
  sessionId: string,
  events: StreamEvent[],
): ReasoningGraph {
  const graph = createReasoningGraphInternal();
  const idx = createReductionIndex();

  for (const event of events) {
    reduceEvent(graph, sessionId, event.sequence, event.type, event.payload, idx);
  }

  return graph;
}

// Internal import to avoid circular dependency in barrel
function createReasoningGraphInternal(): ReasoningGraph {
  return { nodes: new Map(), edges: new Map() };
}
