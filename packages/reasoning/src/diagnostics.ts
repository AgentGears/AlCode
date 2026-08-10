// Diagnostics — structural defect detection over the reasoning graph.
//
// Ports Ouroboros diagnostics.py. Pure semantic functions: no SQLite, no
// filesystem, no process spawning.
//
// Four detectors run over active nodes:
//   1. unsupported_conclusion   — active DECISION with no accepted evidence path
//   2. contradicted_dependency  — active DECISION based on a contradicted ASSUMPTION
//   3. evidence_staleness       — active DECISION with stale evidence
//   4. missing_falsifier        — active mature HYPOTHESIS with no FALSIFIES
//
// All emit warning severity. Findings dedup by findingId and sort by
// (code priority, -subjectSeq, code, findingId).
//
// GraphView centralizes shared semantics so all detectors see the same
// active/evidence/contradiction picture.

import {
  NodeKind as NK,
  EdgeKind as EK,
  EvaluationState as ES,
  DiagnosticSeverity,
  DiagnosticCode,
  type DiagnosticSeverity as DiagnosticSeverityType,
  type DiagnosticCode as DiagnosticCodeType,
  type ReasoningNode,
  type ReasoningEdge,
} from "./schema.ts";
import {
  type ReasoningGraph,
  getSupersededIds,
  getNodesByKind,
  extractSequence,
} from "./graph.ts";
import type { AssumptionPayload } from "./cognitive.ts";

// ---------------------------------------------------------------------------
// Detector version
// ---------------------------------------------------------------------------

export const DETECTOR_VERSION = "0.10.0";

// ---------------------------------------------------------------------------
// DiagnosticFinding
// ---------------------------------------------------------------------------

export type AnyDiagnosticCode =
  | typeof DiagnosticCode.UNSUPPORTED_CONCLUSION
  | typeof DiagnosticCode.CONTRADICTED_DEPENDENCY
  | typeof DiagnosticCode.EVIDENCE_STALENESS
  | typeof DiagnosticCode.MISSING_FALSIFIER;

export interface DiagnosticFinding {
  /** Deterministic hash of (code + sorted subject/related IDs). */
  findingId: string;
  code: AnyDiagnosticCode;
  severity: typeof DiagnosticSeverity.WARNING;
  subjectNodeIds: string[];
  relatedNodeIds: string[];
  pathNodeIds: string[];
  message: string;
  remediation: string;
  detectorVersion: typeof DETECTOR_VERSION;
}

// ---------------------------------------------------------------------------
// Code priority for stable sorting
// ---------------------------------------------------------------------------

const CODE_PRIORITY: Record<AnyDiagnosticCode, number> = {
  [DiagnosticCode.CONTRADICTED_DEPENDENCY]: 0,
  [DiagnosticCode.EVIDENCE_STALENESS]: 1,
  [DiagnosticCode.UNSUPPORTED_CONCLUSION]: 2,
  [DiagnosticCode.MISSING_FALSIFIER]: 3,
};

// ---------------------------------------------------------------------------
// Deterministic finding ID
// ---------------------------------------------------------------------------

/**
 * Deterministic hash for a finding. Combines the code and the sorted
 * subject + related IDs so the same defect always hashes the same,
 * regardless of iteration order.
 */
function makeFindingId(
  code: AnyDiagnosticCode,
  subjectNodeIds: readonly string[],
  relatedNodeIds: readonly string[],
): string {
  const subject = [...subjectNodeIds].sort().join(",");
  const related = [...relatedNodeIds].sort().join(",");
  const key = `${code}|${subject}|${related}`;
  // FNV-1a 32-bit over the key bytes, expressed as zero-padded hex.
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `diag:${code}:${hash.toString(16).padStart(8, "0")}`;
}

// ---------------------------------------------------------------------------
// GraphView — shared graph semantics
// ---------------------------------------------------------------------------

/**
 * Read-only semantic view over a ReasoningGraph.
 *
 * Centralizes the predicates all detectors share (active, accepted evidence,
 * contradiction, falsifier maturity, evidence-path reachability) so a change
 * in semantics changes one place.
 */
export class GraphView {
  /** The underlying graph. Public-read for detectors that need raw access. */
  readonly graph: ReasoningGraph;
  private readonly superseded: Set<string>;

  constructor(graph: ReasoningGraph) {
    this.graph = graph;
    this.superseded = getSupersededIds(graph);
  }

  // --- predicates --------------------------------------------------------

  /** A node is active iff it is not superseded by a same-kind REVISES. */
  isActive(nodeId: string): boolean {
    return !this.superseded.has(nodeId);
  }

  /**
   * Evidence is "accepted" when:
   *   - OBSERVATION: always (observations are trusted inputs)
   *   - ACTION_RESULT: unless data.success === false
   *   - anything else: not evidence
   */
  isAcceptedEvidence(nodeId: string): boolean {
    const node = this.graph.nodes.get(nodeId);
    if (!node) return false;
    if (node.kind === NK.OBSERVATION) return true;
    if (node.kind === NK.ACTION_RESULT) return node.data.success !== false;
    return false;
  }

  /** True if this node is the target of a CONTRADICTS edge. */
  isExplicitlyContradicted(nodeId: string): boolean {
    for (const edge of this.graph.edges.values()) {
      if (edge.kind === EK.CONTRADICTS && edge.target === nodeId) return true;
    }
    return false;
  }

  /** True if this node has at least one incoming FALSIFIES edge. */
  hasFalsifier(nodeId: string): boolean {
    for (const edge of this.graph.edges.values()) {
      if (edge.kind === EK.FALSIFIES && edge.target === nodeId) return true;
    }
    return false;
  }

  /**
   * A HYPOTHESIS is "mature" when it is active AND carries at least one
   * prediction (a claim the agent has committed to testing) AND at least one
   * of its falsifiers — if any — has been evaluated to a non-unevaluated
   * state. A hypothesis with no falsifier yet can still be mature by
   * predictions; the missing_falsifier detector exists precisely to flag
   * mature hypotheses that lack a falsifier.
   *
   * Concretely: active HYPOTHESIS with `predicts.length > 0`.
   * The "evaluated falsifier" gate is applied separately where relevant.
   */
  isMatureHypothesis(nodeId: string): boolean {
    const node = this.graph.nodes.get(nodeId);
    if (!node || node.kind !== NK.HYPOTHESIS) return false;
    if (!this.isActive(nodeId)) return false;
    const predicts = node.data.predicts;
    return Array.isArray(predicts) && predicts.length > 0;
  }

  /**
   * True if the node has a falsifier that has been evaluated to a
   * non-unevaluated state (satisfied / refuted / inconclusive / superseded).
   */
  hasEvaluatedFalsifier(nodeId: string): boolean {
    for (const edge of this.graph.edges.values()) {
      if (edge.kind !== EK.FALSIFIES || edge.target !== nodeId) continue;
      // edge.source is the falsifier; look for an EVALUATES edge into it.
      for (const evalEdge of this.graph.edges.values()) {
        if (
          evalEdge.kind === EK.EVALUATES &&
          evalEdge.target === edge.source
        ) {
          const evalNode = this.graph.nodes.get(evalEdge.source);
          const state = evalNode?.data.state as string | undefined;
          if (state !== undefined && state !== ES.UNEVALUATED) return true;
        }
      }
    }
    return false;
  }

  /**
   * Shortest evidence-path length from any accepted evidence node to `target`
   * via SUPPORTS edges. Returns Infinity if unreachable.
   *
   * Traversed source→target: an edge `A -SUPPORTS-> B` is one hop; BFS
   * expands outward from each evidence seed over outgoing SUPPORTS edges
   * until it reaches the target.
   */
  shortestEvidencePath(target: string): number {
    const seeds: string[] = [];
    for (const node of this.graph.nodes.values()) {
      if (this.isAcceptedEvidence(node.id)) seeds.push(node.id);
    }
    if (seeds.length === 0) return Infinity;
    if (seeds.includes(target)) return 0;

    const visited = new Set<string>(seeds);
    const queue: Array<{ id: string; dist: number }> = seeds.map((id) => ({ id, dist: 0 }));
    let head = 0;
    while (head < queue.length) {
      const entry = queue[head]!;
      head += 1;
      for (const edge of this.graph.edges.values()) {
        if (edge.kind !== EK.SUPPORTS) continue;
        if (edge.source !== entry.id) continue;
        const next = edge.target;
        if (next === target) return entry.dist + 1;
        if (!visited.has(next)) {
          visited.add(next);
          queue.push({ id: next, dist: entry.dist + 1 });
        }
      }
    }
    return Infinity;
  }

  // --- raw accessors used by detectors -----------------------------------

  /** Direct node lookup. */
  node(nodeId: string): ReasoningNode | undefined {
    return this.graph.nodes.get(nodeId);
  }

  /** Sequence number for stable tie-breaking. Falls back to 0. */
  sequence(nodeId: string): number {
    return extractSequence(nodeId);
  }

  /** All active DECISION nodes. */
  activeDecisions(): ReasoningNode[] {
    return getNodesByKind(this.graph, NK.DECISION).filter((n) => this.isActive(n.id));
  }

  /** All active HYPOTHESIS nodes. */
  activeHypotheses(): ReasoningNode[] {
    return getNodesByKind(this.graph, NK.HYPOTHESIS).filter((n) => this.isActive(n.id));
  }

  /** Incoming edges of a given kind targeting `nodeId`. */
  incoming(nodeId: string, kind: ReasoningEdge["kind"]): ReasoningEdge[] {
    const out: ReasoningEdge[] = [];
    for (const edge of this.graph.edges.values()) {
      if (edge.kind === kind && edge.target === nodeId) out.push(edge);
    }
    return out;
  }

  /** Outgoing edges of a given kind from `nodeId`. */
  outgoing(nodeId: string, kind: ReasoningEdge["kind"]): ReasoningEdge[] {
    const out: ReasoningEdge[] = [];
    for (const edge of this.graph.edges.values()) {
      if (edge.kind === kind && edge.source === nodeId) out.push(edge);
    }
    return out;
  }

  /** Outgoing PRODUCED_BY targets — the "based-on" relation for DECISION. */
  basedOn(nodeId: string): string[] {
    return this.outgoing(nodeId, EK.PRODUCED_BY).map((e) => e.target);
  }

  /** All ACTION_RESULT nodes (used by the staleness detector). */
  actionResults(): ReasoningNode[] {
    return getNodesByKind(this.graph, NK.ACTION_RESULT);
  }
}

// ---------------------------------------------------------------------------
// DiagnosticEngine
// ---------------------------------------------------------------------------

/**
 * Runs the four Phase 0.4 detectors over a graph, dedups by findingId, and
 * returns findings sorted by (code priority, -subjectSeq, code, findingId).
 *
 * The engine is stateless: the same graph always yields the same findings.
 */
export class DiagnosticEngine {
  /** Run all detectors and return sorted, deduplicated findings. */
  diagnose(graph: ReasoningGraph): DiagnosticFinding[] {
    const view = new GraphView(graph);
    const findings = new Map<string, DiagnosticFinding>();

    const add = (f: DiagnosticFinding): void => {
      // Dedup by findingId; first one wins (IDs are deterministic).
      if (!findings.has(f.findingId)) findings.set(f.findingId, f);
    };

    for (const f of this.detectUnsupportedConclusion(view)) add(f);
    for (const f of this.detectContradictedDependency(view)) add(f);
    for (const f of this.detectEvidenceStaleness(view)) add(f);
    for (const f of this.detectMissingFalsifier(view)) add(f);

    return this.sort(findings);
  }

  // --- detector 1: unsupported_conclusion --------------------------------

  /**
   * An active DECISION is an "unsupported conclusion" when no accepted
   * evidence reaches it through SUPPORTS edges (directly or transitively).
   *
   * Evidence reaches a DECISION when there is a SUPPORTS path from accepted
   * evidence (OBSERVATION, or ACTION_RESULT with success !== false) to the
   * decision node. Decisions are most often supported via intermediate
   * hypotheses, so the SUPPORTS subgraph is walked in full.
   */
  detectUnsupportedConclusion(view: GraphView): DiagnosticFinding[] {
    const findings: DiagnosticFinding[] = [];
    for (const decision of view.activeDecisions()) {
      const dist = view.shortestEvidencePath(decision.id);
      if (!Number.isFinite(dist)) {
        findings.push(
          this.finding(
            DiagnosticCode.UNSUPPORTED_CONCLUSION,
            [decision.id],
            [],
            [],
            `Decision "${labelOf(decision)}" has no accepted evidence path`,
            "Link accepted evidence (OBSERVATION or successful ACTION_RESULT) via SUPPORTS to this decision or a hypothesis it depends on.",
          ),
        );
      }
    }
    return findings;
  }

  // --- detector 2: contradicted_dependency -------------------------------

  /**
   * An active DECISION whose basis (PRODUCED_BY targets) includes a
   * contradicted ASSUMPTION.
   *
   * An assumption is "contradicted" when its payload status is
   * "contradicted" OR it is the explicit target of a CONTRADICTS edge.
   *
   * Suppression: if the DECISION was reaffirmed *after* the contradiction
   * surfaced (decision sequence > latest contradicting source sequence),
   * the finding is suppressed — the agent already re-justified the decision
   * knowing about the contradiction.
   */
  detectContradictedDependency(view: GraphView): DiagnosticFinding[] {
    const findings: DiagnosticFinding[] = [];
    for (const decision of view.activeDecisions()) {
      const basis = view.basedOn(decision.id);
      for (const basisId of basis) {
        const basisNode = view.node(basisId);
        if (!basisNode || basisNode.kind !== NK.ASSUMPTION) continue;
        if (!isAssumptionContradicted(view, basisNode)) continue;

        if (reaffirmedAfterContradiction(view, decision.id, basisId)) continue;

        findings.push(
          this.finding(
            DiagnosticCode.CONTRADICTED_DEPENDENCY,
            [decision.id],
            [basisId],
            [basisId],
            `Decision "${labelOf(decision)}" depends on contradicted assumption "${labelOf(basisNode)}"`,
            "Re-justify the decision without the contradicted assumption, or revise the assumption.",
          ),
        );
      }
    }
    return findings;
  }

  // --- detector 3: evidence_staleness ------------------------------------

  /**
   * An active DECISION with stale evidence: its supporting evidence predates
   * a mutation (an ACTION_RESULT that changed state) and has not been
   * re-verified since.
   *
   * Heuristic (frozen):
   *   - supporters = direct SUPPORTS sources of the decision that are
   *     accepted evidence.
   *   - If there are no accepted-evidence supporters, skip (handled by the
   *     unsupported_conclusion detector instead).
   *   - latestEvidenceSeq = max sequence among accepted-evidence supporters.
   *   - mutation = the highest-sequence ACTION_RESULT whose sequence is
   *     greater than latestEvidenceSeq.
   *   - If a mutation exists and no supporter has sequence >= mutation's
   *     sequence (no re-verification), the evidence is stale.
   */
  detectEvidenceStaleness(view: GraphView): DiagnosticFinding[] {
    const findings: DiagnosticFinding[] = [];
    for (const decision of view.activeDecisions()) {
      const supporters = view
        .incoming(decision.id, EK.SUPPORTS)
        .map((e) => e.source)
        .filter((id) => view.isAcceptedEvidence(id));
      if (supporters.length === 0) continue;

      const evidenceSeqs = supporters.map((id) => view.sequence(id));
      const latestEvidenceSeq = Math.max(...evidenceSeqs);

      // Find the latest mutation after the evidence.
      let mutationId: string | null = null;
      let mutationSeq = -1;
      for (const ar of view.actionResults()) {
        const seq = view.sequence(ar.id);
        if (seq > latestEvidenceSeq && seq > mutationSeq) {
          mutationSeq = seq;
          mutationId = ar.id;
        }
      }
      if (mutationId === null) continue;

      // Re-verified iff some supporter's sequence >= mutation's sequence.
      const reverified = supporters.some((id) => view.sequence(id) >= mutationSeq);
      if (reverified) continue;

      findings.push(
        this.finding(
          DiagnosticCode.EVIDENCE_STALENESS,
          [decision.id],
          [mutationId],
          supporters,
          `Decision "${labelOf(decision)}" relies on evidence (seq<=${latestEvidenceSeq}) predating mutation "${mutationId}" (seq ${mutationSeq})`,
          "Re-run the verification that produced the supporting evidence against the current state.",
        ),
      );
    }
    return findings;
  }

  // --- detector 4: missing_falsifier -------------------------------------

  /**
   * An active mature HYPOTHESIS with no incoming FALSIFIES edge.
   * "Mature" = active + carries predictions (GraphView.isMatureHypothesis).
   *
   * This detector surfaces hypotheses that have been developed enough to
   * deserve a falsifier but never got one committed.
   */
  detectMissingFalsifier(view: GraphView): DiagnosticFinding[] {
    const findings: DiagnosticFinding[] = [];
    for (const hyp of view.activeHypotheses()) {
      if (!view.isMatureHypothesis(hyp.id)) continue;
      if (view.hasFalsifier(hyp.id)) continue;
      findings.push(
        this.finding(
          DiagnosticCode.MISSING_FALSIFIER,
          [hyp.id],
          [],
          [],
          `Mature hypothesis "${labelOf(hyp)}" has no falsifier`,
          "Commit a falsifier (a condition that would disconfirm this hypothesis) and link it via FALSIFIES.",
        ),
      );
    }
    return findings;
  }

  // --- finding construction & sorting ------------------------------------

  private finding(
    code: AnyDiagnosticCode,
    subjectNodeIds: string[],
    relatedNodeIds: string[],
    pathNodeIds: string[],
    message: string,
    remediation: string,
  ): DiagnosticFinding {
    return {
      findingId: makeFindingId(code, subjectNodeIds, relatedNodeIds),
      code,
      severity: DiagnosticSeverity.WARNING,
      subjectNodeIds,
      relatedNodeIds,
      pathNodeIds,
      message,
      remediation,
      detectorVersion: DETECTOR_VERSION,
    };
  }

  private sort(findings: Map<string, DiagnosticFinding>): DiagnosticFinding[] {
    const list = [...findings.values()];
    list.sort((a, b) => {
      const pa = CODE_PRIORITY[a.code] ?? 99;
      const pb = CODE_PRIORITY[b.code] ?? 99;
      if (pa !== pb) return pa - pb;
      // Within the same code, newest subject first (descending sequence).
      const sa = subjectSequence(a);
      const sb = subjectSequence(b);
      if (sa !== sb) return sb - sa;
      if (a.code !== b.code) return a.code < b.code ? -1 : 1;
      return a.findingId < b.findingId ? -1 : a.findingId > b.findingId ? 1 : 0;
    });
    return list;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function labelOf(node: ReasoningNode): string {
  return node.label || node.id;
}

/** Best-effort sequence extraction from the first subject node of a finding. */
function subjectSequence(f: DiagnosticFinding): number {
  if (f.subjectNodeIds.length === 0) return 0;
  return extractSequence(f.subjectNodeIds[0]!);
}

/**
 * True if the decision was (re)recorded after the latest contradicting
 * evidence for the assumption, i.e. the agent has already reaffirmed it.
 */
function reaffirmedAfterContradiction(
  view: GraphView,
  decisionId: string,
  assumptionId: string,
): boolean {
  const decisionSeq = view.sequence(decisionId);
  let latestContradictionSeq = -1;
  for (const edge of view.incoming(assumptionId, EK.CONTRADICTS)) {
    // The contradicting evidence is the edge source.
    const srcSeq = view.sequence(edge.source);
    if (srcSeq > latestContradictionSeq) latestContradictionSeq = srcSeq;
    // Also consider the edge's own derived sequence (when it was emitted).
    const edgeSeq = view.sequence(edge.id);
    if (edgeSeq > latestContradictionSeq) latestContradictionSeq = edgeSeq;
  }
  if (latestContradictionSeq < 0) return false;
  return decisionSeq > latestContradictionSeq;
}

/**
 * An assumption is contradicted when its payload status is "contradicted"
 * OR it is the explicit target of a CONTRADICTS edge.
 */
function isAssumptionContradicted(view: GraphView, node: ReasoningNode): boolean {
  const status = node.data.status as AssumptionPayload["status"] | undefined;
  if (status === "contradicted") return true;
  return view.isExplicitlyContradicted(node.id);
}

// Re-export severity/code type aliases for callers that want a single site.
export type { DiagnosticSeverityType, DiagnosticCodeType };
