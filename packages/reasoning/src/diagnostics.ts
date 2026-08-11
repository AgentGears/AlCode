// Diagnostics — structural graph detectors.
//
// Ports Ouroboros diagnostics.py faithfully. Pure read-only semantic
// functions: no SQLite, no filesystem, no process spawning.
//
// GraphView centralizes shared graph semantics. DiagnosticEngine runs 4
// detectors in a fixed order with exact suppression rules.

import { createHash } from "node:crypto";
import {
  type ReasoningNode,
  type ReasoningEdge,
  NodeKind as NK,
  EdgeKind as EK,
  DiagnosticSeverity as DS,
} from "./schema.ts";
import { type ReasoningGraph, getNodesByKind } from "./graph.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DETECTOR_VERSION = "0.10.0";

const CODE_PRIORITY: Record<string, number> = {
  contradicted_dependency: 0,
  evidence_staleness: 1,
  unsupported_conclusion: 2,
  missing_falsifier: 3,
};

const EVIDENCE_KINDS = new Set<string>([NK.OBSERVATION, NK.ACTION_RESULT]);
const MUTATION_TOOLS = new Set(["Edit", "Write"]);

// ---------------------------------------------------------------------------
// DiagnosticFinding
// ---------------------------------------------------------------------------

export interface DiagnosticFinding {
  findingId: string;
  code: string;
  severity: string;
  subjectNodeIds: readonly string[];
  relatedNodeIds: readonly string[];
  pathNodeIds: readonly string[];
  message: string;
  remediation: string | null;
  detectorVersion: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canonicalJson(obj: Record<string, unknown>): string {
  function sortDeep(v: unknown): unknown {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(sortDeep);
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      sorted[key] = sortDeep((v as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return JSON.stringify(sortDeep(obj));
}

function findingId(code: string, subjectIds: readonly string[], relatedIds: readonly string[]): string {
  const payload = canonicalJson({
    code,
    subject_ids: [...subjectIds].sort(),
    related_ids: [...relatedIds].sort(),
  });
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16);
}

function seqFromId(nodeId: string): number {
  const parts = nodeId.split(":");
  if (parts.length >= 4 && parts[0] === "event") {
    const seq = parseInt(parts[2]!, 10);
    if (!isNaN(seq)) return seq;
  }
  return 0;
}

function sortFindings(findings: DiagnosticFinding[]): DiagnosticFinding[] {
  return findings.slice().sort((a, b) => {
    const pa = CODE_PRIORITY[a.code] ?? 99;
    const pb = CODE_PRIORITY[b.code] ?? 99;
    if (pa !== pb) return pa - pb;
    const sa = a.subjectNodeIds.length > 0 ? Math.max(...a.subjectNodeIds.map(seqFromId)) : 0;
    const sb = b.subjectNodeIds.length > 0 ? Math.max(...b.subjectNodeIds.map(seqFromId)) : 0;
    if (sa !== sb) return sb - sa;
    if (a.code !== b.code) return a.code.localeCompare(b.code);
    return a.findingId.localeCompare(b.findingId);
  });
}

// ---------------------------------------------------------------------------
// GraphView — exact Ouroboros port
// ---------------------------------------------------------------------------

export class GraphView {
  private readonly graph: ReasoningGraph;
  private readonly incomingMap: Map<string, ReasoningEdge[]>;
  private readonly outgoingMap: Map<string, ReasoningEdge[]>;
  private supersededCache: Set<string> | null = null;

  constructor(graph: ReasoningGraph) {
    this.graph = graph;
    this.incomingMap = new Map();
    this.outgoingMap = new Map();
    for (const edge of graph.edges.values()) {
      const inList = this.incomingMap.get(edge.target) ?? [];
      inList.push(edge);
      this.incomingMap.set(edge.target, inList);
      const outList = this.outgoingMap.get(edge.source) ?? [];
      outList.push(edge);
      this.outgoingMap.set(edge.source, outList);
    }
  }

  incoming(nodeId: string, kind?: string): ReasoningEdge[] {
    const edges = this.incomingMap.get(nodeId) ?? [];
    return kind ? edges.filter((e) => e.kind === kind) : edges;
  }

  outgoing(nodeId: string, kind?: string): ReasoningEdge[] {
    const edges = this.outgoingMap.get(nodeId) ?? [];
    return kind ? edges.filter((e) => e.kind === kind) : edges;
  }

  node(nodeId: string): ReasoningNode | undefined {
    return this.graph.nodes.get(nodeId);
  }

  supersededIds(): Set<string> {
    if (this.supersededCache !== null) return this.supersededCache;
    const result = new Set<string>();
    for (const edge of this.graph.edges.values()) {
      if (edge.kind !== EK.REVISES) continue;
      const target = this.graph.nodes.get(edge.target);
      const source = this.graph.nodes.get(edge.source);
      if (target && source && target.kind === source.kind) {
        result.add(edge.target);
      }
    }
    this.supersededCache = result;
    return result;
  }

  isActive(nodeId: string): boolean {
    return !this.supersededIds().has(nodeId);
  }

  /** Return all nodes in the graph (read-only accessor for detectors). */
  allNodes(): ReasoningNode[] {
    return [...this.graph.nodes.values()];
  }

  activeNodes(kind: string): ReasoningNode[] {
    return getNodesByKind(this.graph, kind as NK).filter((n) => this.isActive(n.id));
  }

  isEvidence(nodeId: string): boolean {
    const node = this.graph.nodes.get(nodeId);
    return node !== undefined && EVIDENCE_KINDS.has(node.kind);
  }

  isAcceptedEvidence(nodeId: string): boolean {
    const node = this.graph.nodes.get(nodeId);
    if (!node) return false;
    if (node.kind === NK.OBSERVATION) return true;
    if (node.kind === NK.ACTION_RESULT) return node.data.success !== false;
    return false;
  }

  isExplicitlyContradicted(nodeId: string): boolean {
    const node = this.graph.nodes.get(nodeId);
    if (!node) return false;
    if (node.data.status === "contradicted") return true;
    for (const edge of this.incoming(nodeId, EK.CONTRADICTS)) {
      if (this.isEvidence(edge.source)) return true;
    }
    return false;
  }

  contradictionEdges(nodeId: string): ReasoningEdge[] {
    return this.incoming(nodeId, EK.CONTRADICTS).filter((e) => this.isEvidence(e.source));
  }

  hasPostContradictionReaffirmation(
    subjectId: string, contradictionSeq: number, contradictedAssumptionId?: string,
  ): boolean {
    if (!this.isActive(subjectId)) return true;

    const validTargets = new Set<string>([subjectId]);
    if (contradictedAssumptionId) {
      validTargets.add(contradictedAssumptionId);
      for (const node of this.graph.nodes.values()) {
        if (node.kind === NK.HYPOTHESIS) {
          for (const edge of this.outgoing(node.id, EK.DEPENDS_ON)) {
            if (edge.target === contradictedAssumptionId) validTargets.add(node.id);
          }
        }
      }
    }

    for (const targetId of validTargets) {
      for (const edge of this.incoming(targetId, EK.SUPPORTS)) {
        const source = this.graph.nodes.get(edge.source);
        if (source && this.isEvidence(source.id) && seqFromId(source.id) > contradictionSeq) return true;
      }
    }

    for (const edge of this.incoming(subjectId)) {
      const source = this.graph.nodes.get(edge.source);
      if (source && source.kind === NK.CHECK && seqFromId(source.id) > contradictionSeq) return true;
    }
    return false;
  }

  hasFalsifier(hypothesisId: string): boolean {
    return this.incoming(hypothesisId, EK.FALSIFIES).length > 0;
  }

  isMatureHypothesis(hypothesisId: string): boolean {
    if (this.incoming(hypothesisId, EK.SUPPORTS).some((e) => this.isEvidence(e.source))) return true;
    for (const edge of this.incoming(hypothesisId, EK.PRODUCED_BY)) {
      const source = this.graph.nodes.get(edge.source);
      if (source && source.kind === NK.DECISION) return true;
    }
    if (this.outgoing(hypothesisId, EK.DEPENDS_ON).length > 0) return true;
    if (this.incoming(hypothesisId, EK.ALTERNATIVE_TO).length > 0) return true;
    return false;
  }

  shortestEvidencePath(startId: string): readonly string[] | null {
    const queue: Array<{ id: string; path: string[] }> = [{ id: startId, path: [startId] }];
    const visited = new Set<string>([startId]);
    const qualifyingPaths: string[][] = [];

    while (queue.length > 0) {
      const { id: currentId, path } = queue.shift()!;
      if (currentId !== startId && this.isAcceptedEvidence(currentId)) {
        qualifyingPaths.push(path);
        continue;
      }
      for (const edge of this.outgoing(currentId, EK.PRODUCED_BY)) {
        if (!visited.has(edge.target)) {
          visited.add(edge.target);
          queue.push({ id: edge.target, path: [...path, edge.target] });
        }
      }
      for (const edge of this.incoming(currentId, EK.SUPPORTS)) {
        if (!visited.has(edge.source)) {
          visited.add(edge.source);
          queue.push({ id: edge.source, path: [...path, edge.source] });
        }
      }
      for (const edge of this.outgoing(currentId, EK.DEPENDS_ON)) {
        if (!visited.has(edge.target)) {
          visited.add(edge.target);
          queue.push({ id: edge.target, path: [...path, edge.target] });
        }
      }
    }

    if (qualifyingPaths.length === 0) return null;
    qualifyingPaths.sort((a, b) => a.length - b.length || a.join("\0").localeCompare(b.join("\0")));
    return qualifyingPaths[0]!;
  }

  hasAnyEvidencePath(startId: string): boolean {
    return this.shortestEvidencePath(startId) !== null;
  }
}

// ---------------------------------------------------------------------------
// DiagnosticEngine
// ---------------------------------------------------------------------------

export class DiagnosticEngine {
  diagnose(
    graph: ReasoningGraph,
    sessionId: string,
    throughSequence: number,
    limit: number = 100,
    includeInfo: boolean = true,
  ): { sessionId: string; throughSequence: number; findings: DiagnosticFinding[]; omittedCount: number; truncated: boolean } {
    const view = new GraphView(graph);

    const staleFindings = this.evidenceStaleness(view, throughSequence);
    const staleSubjects = new Set<string>(
      staleFindings.filter((f) => f.subjectNodeIds.length > 0).map((f) => f.subjectNodeIds[0]!),
    );

    const unsupported = this.unsupportedConclusion(view, throughSequence, staleSubjects);
    const contradicted = this.contradictedDependency(view, throughSequence);
    const missingFals = this.missingFalsifier(view, throughSequence);

    let findings = [...unsupported, ...contradicted, ...staleFindings, ...missingFals];

    // Dedup by findingId
    const seen = new Set<string>();
    const unique: DiagnosticFinding[] = [];
    for (const f of findings) {
      if (!seen.has(f.findingId)) { seen.add(f.findingId); unique.push(f); }
    }

    const sorted = sortFindings(unique);
    const filtered = includeInfo ? sorted : sorted.filter((f) => f.severity !== DS.INFO);
    const omitted = Math.max(0, filtered.length - limit);

    return {
      sessionId, throughSequence,
      findings: filtered.slice(0, limit),
      omittedCount: omitted,
      truncated: omitted > 0,
    };
  }

  private makeFinding(
    code: string, subjectIds: readonly string[], relatedIds: readonly string[],
    pathIds: readonly string[], message: string, remediation: string, throughSeq: number,
  ): DiagnosticFinding {
    void throughSeq;
    return {
      findingId: findingId(code, subjectIds, relatedIds),
      code, severity: DS.WARNING,
      subjectNodeIds: subjectIds, relatedNodeIds: relatedIds, pathNodeIds: pathIds,
      message, remediation, detectorVersion: DETECTOR_VERSION,
    };
  }

  private unsupportedConclusion(view: GraphView, throughSeq: number, staleSubjects: Set<string>): DiagnosticFinding[] {
    const results: DiagnosticFinding[] = [];
    for (const node of view.activeNodes(NK.DECISION)) {
      if (staleSubjects.has(node.id)) continue;
      if (view.shortestEvidencePath(node.id) !== null) continue;
      const producedBy = view.outgoing(node.id, EK.PRODUCED_BY);
      if (producedBy.length === 0) {
        results.push(this.makeFinding(
          "unsupported_conclusion", [node.id], [], [node.id],
          `Decision '${node.label.slice(0, 60)}' has no recorded basis.`,
          "Record what evidence or reasoning this decision was based on.", throughSeq));
      } else {
        const basisIds = producedBy.map((e) => e.target);
        results.push(this.makeFinding(
          "unsupported_conclusion", [node.id], basisIds, [node.id, ...basisIds],
          `Decision '${node.label.slice(0, 60)}' has no recorded evidence path to an observation or result.`,
          "Link evidence (observations or test results) that supports this decision.", throughSeq));
      }
    }
    return results;
  }

  private contradictedDependency(view: GraphView, throughSeq: number): DiagnosticFinding[] {
    const results: DiagnosticFinding[] = [];
    for (const decision of view.activeNodes(NK.DECISION)) {
      const contradicted: string[] = [];
      for (const edge of view.outgoing(decision.id, EK.PRODUCED_BY)) {
        const basis = view.node(edge.target);
        if (!basis) continue;
        if (basis.kind === NK.ASSUMPTION && view.isExplicitlyContradicted(basis.id)) {
          const contraEdges = view.contradictionEdges(basis.id);
          const cSeq = contraEdges.length > 0 ? Math.max(...contraEdges.map((e) => seqFromId(e.source))) : seqFromId(basis.id);
          if (!view.hasPostContradictionReaffirmation(decision.id, cSeq, basis.id)) contradicted.push(basis.id);
        } else if (basis.kind === NK.HYPOTHESIS) {
          for (const depEdge of view.outgoing(basis.id, EK.DEPENDS_ON)) {
            const depNode = view.node(depEdge.target);
            if (depNode && depNode.kind === NK.ASSUMPTION && view.isExplicitlyContradicted(depNode.id)) {
              const contraEdges = view.contradictionEdges(depNode.id);
              const cSeq = contraEdges.length > 0 ? Math.max(...contraEdges.map((e) => seqFromId(e.source))) : seqFromId(depNode.id);
              if (!view.hasPostContradictionReaffirmation(decision.id, cSeq, depNode.id)) contradicted.push(depNode.id);
            }
          }
        }
      }
      if (contradicted.length > 0) {
        const unique = [...new Set(contradicted)].sort();
        results.push(this.makeFinding(
          "contradicted_dependency", [decision.id], unique, [decision.id, ...unique],
          `Decision '${decision.label.slice(0, 60)}' depends on ${unique.length} explicitly contradicted assumption(s).`,
          "Re-evaluate the dependent artifact, replace the assumption, record a justified reaffirmation, or invalidate the branch.", throughSeq));
      }
    }
    return results;
  }

  private evidenceStaleness(view: GraphView, throughSeq: number): DiagnosticFinding[] {
    const results: DiagnosticFinding[] = [];
    for (const decision of view.activeNodes(NK.DECISION)) {
      const evidenceNodes: ReasoningNode[] = [];
      for (const edge of view.outgoing(decision.id, EK.PRODUCED_BY)) {
        const basis = view.node(edge.target);
        if (basis && view.isEvidence(basis.id)) evidenceNodes.push(basis);
      }
      if (evidenceNodes.length === 0) continue;

      // Find mutation ACTION nodes (tool_name in {Edit, Write})
      const actionMutations: ReasoningNode[] = [];
      for (const n of view.allNodes()) {
        if (n.kind === NK.ACTION && MUTATION_TOOLS.has(n.data.tool_name as string)) actionMutations.push(n);
      }
      if (actionMutations.length === 0) continue;

      const latestEv = evidenceNodes.reduce((a, b) => seqFromId(b.id) > seqFromId(a.id) ? b : a);
      const latestEvSeq = seqFromId(latestEv.id);
      const mutAfter = actionMutations.filter((m) => seqFromId(m.id) > latestEvSeq);
      if (mutAfter.length === 0) continue;

      const latestMut = mutAfter.reduce((a, b) => seqFromId(b.id) > seqFromId(a.id) ? b : a);
      const latestMutSeq = seqFromId(latestMut.id);

      let reverified = evidenceNodes.some(
        (ev) => seqFromId(ev.id) > latestMutSeq && ev.data.verification_command && ev.data.success !== false);
      for (const n of view.allNodes()) {
        if (n.kind === NK.ACTION_RESULT && seqFromId(n.id) > latestMutSeq && n.data.verification_command && n.data.success !== false) {
          reverified = true; break;
        }
      }

      if (!reverified) {
        results.push(this.makeFinding(
          "evidence_staleness", [decision.id], [latestEv.id, latestMut.id],
          [decision.id, latestEv.id, latestMut.id],
          `Decision '${decision.label.slice(0, 60)}' relies on verification (seq ${latestEvSeq}) predating a mutation (seq ${latestMutSeq}).`,
          "Re-run verification against the current input state or withdraw the conclusion.", throughSeq));
      }
    }
    return results;
  }

  private missingFalsifier(view: GraphView, throughSeq: number): DiagnosticFinding[] {
    const results: DiagnosticFinding[] = [];
    for (const hyp of view.activeNodes(NK.HYPOTHESIS)) {
      if (!view.isMatureHypothesis(hyp.id)) continue;
      if (view.hasFalsifier(hyp.id)) continue;
      results.push(this.makeFinding(
        "missing_falsifier", [hyp.id], [], [hyp.id],
        `Hypothesis '${hyp.label.slice(0, 60)}' has no falsifier.`,
        "Record an observation, test result, or condition that would cause the hypothesis to be rejected.", throughSeq));
    }
    return results;
  }
}
