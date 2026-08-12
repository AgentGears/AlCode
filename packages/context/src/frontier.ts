import {
  EdgeKind,
  NodeKind,
  extractSequence,
  getSupersededIds,
  validateCognitiveGraph,
  type DiagnosticFinding,
  type ReasoningGraphType,
  type ReasoningNode,
} from "@alcode/reasoning";
import type { ReasoningFrontier } from "./types.ts";

export class ReasoningFrontierAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReasoningFrontierAmbiguousError";
  }
}

function bySequenceThenId(a: ReasoningNode, b: ReasoningNode): number {
  const delta = extractSequence(a.id) - extractSequence(b.id);
  return delta !== 0 ? delta : a.id.localeCompare(b.id);
}

function activeNodes(graph: ReasoningGraphType, kind: string): ReasoningNode[] {
  const superseded = getSupersededIds(graph);
  return [...graph.nodes.values()]
    .filter((node) => node.kind === kind && !superseded.has(node.id))
    .sort(bySequenceThenId);
}

function connected(graph: ReasoningGraphType, nodeId: string, ids: ReadonlySet<string>): boolean {
  for (const edge of graph.edges.values()) {
    if (edge.source === nodeId && ids.has(edge.target)) return true;
    if (edge.target === nodeId && ids.has(edge.source)) return true;
  }
  return false;
}

function hasUnscopedTaskReasoning(graph: ReasoningGraphType): boolean {
  const scopeKinds = new Set<string>([
    NodeKind.HYPOTHESIS,
    NodeKind.FALSIFIER,
    NodeKind.VERIFICATION_CONTRACT,
    NodeKind.DECISION,
    NodeKind.ASSUMPTION,
    NodeKind.ALTERNATIVE,
  ]);
  const superseded = getSupersededIds(graph);
  return [...graph.nodes.values()].some((node) => scopeKinds.has(node.kind) && !superseded.has(node.id));
}

export function deriveReasoningFrontier(
  graph: ReasoningGraphType,
  diagnostics: DiagnosticFinding[] = [],
): ReasoningFrontier {
  validateCognitiveGraph(graph);
  const objectives = activeNodes(graph, NodeKind.OBJECTIVE);
  if (objectives.length > 1) {
    throw new ReasoningFrontierAmbiguousError(`multiple active objectives: ${objectives.map((node) => node.id).join(",")}`);
  }
  if (objectives.length === 0 && hasUnscopedTaskReasoning(graph)) {
    throw new ReasoningFrontierAmbiguousError("task reasoning exists without an active objective");
  }
  const objective = objectives[0] ?? null;
  const superseded = getSupersededIds(graph);

  const hypotheses = objective
    ? [...graph.edges.values()]
        .filter((edge) => edge.kind === EdgeKind.ADDRESSES && edge.target === objective.id)
        .map((edge) => graph.nodes.get(edge.source))
        .filter((node): node is ReasoningNode => node?.kind === NodeKind.HYPOTHESIS && !superseded.has(node.id))
        .sort(bySequenceThenId)
    : [];

  const hypothesisIds = new Set(hypotheses.map((node) => node.id));

  const falsifiers = [...graph.edges.values()]
    .filter((edge) => edge.kind === EdgeKind.FALSIFIES && hypothesisIds.has(edge.target))
    .map((edge) => graph.nodes.get(edge.source))
    .filter((node): node is ReasoningNode => node?.kind === NodeKind.FALSIFIER && !superseded.has(node.id))
    .sort(bySequenceThenId);

  const consumedContracts = new Set(
    [...graph.edges.values()]
      .filter((edge) => edge.kind === EdgeKind.EXECUTES)
      .map((edge) => edge.target),
  );
  const pendingVerificationContracts = [...graph.edges.values()]
    .filter((edge) => edge.kind === EdgeKind.TESTS && hypothesisIds.has(edge.target))
    .map((edge) => graph.nodes.get(edge.source))
    .filter((node): node is ReasoningNode =>
      node?.kind === NodeKind.VERIFICATION_CONTRACT &&
      !superseded.has(node.id) &&
      !consumedContracts.has(node.id))
    .sort(bySequenceThenId);

  const decisiveEvidence = [...graph.edges.values()]
    .filter((edge) =>
      (edge.kind === EdgeKind.SUPPORTS || edge.kind === EdgeKind.CONTRADICTS) &&
      hypothesisIds.has(edge.target))
    .map((edge) => graph.nodes.get(edge.source))
    .filter((node): node is ReasoningNode => node !== undefined)
    .sort(bySequenceThenId);

  const frontierSeedIds = new Set<string>([
    ...(objective ? [objective.id] : []),
    ...hypotheses.map((node) => node.id),
    ...falsifiers.map((node) => node.id),
    ...pendingVerificationContracts.map((node) => node.id),
    ...decisiveEvidence.map((node) => node.id),
  ]);

  const decisions = activeNodes(graph, NodeKind.DECISION)
    .filter((node) => {
      const basedOn = Array.isArray(node.data.basedOn)
        ? node.data.basedOn.filter((id): id is string => typeof id === "string")
        : [];
      return basedOn.some((id) => frontierSeedIds.has(id)) || connected(graph, node.id, frontierSeedIds);
    });
  for (const id of decisions.map((node) => node.id)) frontierSeedIds.add(id);

  const assumptions = activeNodes(graph, NodeKind.ASSUMPTION)
    .filter((node) => connected(graph, node.id, frontierSeedIds));
  const alternatives = activeNodes(graph, NodeKind.ALTERNATIVE)
    .filter((node) => connected(graph, node.id, frontierSeedIds));

  const frontierIds = new Set<string>([
    ...frontierSeedIds,
    ...assumptions.map((node) => node.id),
    ...alternatives.map((node) => node.id),
  ]);

  const relevantDiagnostics = diagnostics
    .filter((finding) => {
      const ids = [...finding.subjectNodeIds, ...finding.relatedNodeIds, ...finding.pathNodeIds];
      return ids.some((id) => frontierIds.has(id));
    })
    .slice()
    .sort((a, b) => a.findingId.localeCompare(b.findingId));

  for (const finding of relevantDiagnostics) {
    for (const id of [...finding.subjectNodeIds, ...finding.relatedNodeIds, ...finding.pathNodeIds]) {
      frontierIds.add(id);
    }
  }

  return {
    objective,
    hypotheses,
    falsifiers,
    pendingVerificationContracts,
    decisions,
    decisiveEvidence,
    assumptions,
    alternatives,
    diagnostics: relevantDiagnostics,
    implicatedNodeIds: [...frontierIds].sort(),
  };
}
