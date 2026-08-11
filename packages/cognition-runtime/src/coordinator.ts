import {
  applyRecordSeen,
  applyRecordUse,
  rankByBlendedScore,
  type MemoryRecord,
  type MemoryStats,
  type RetrievalQueryContext,
  type ScoredMemory,
} from "@alcode/memory";
import {
  DiagnosticEngine,
  EdgeKind,
  NodeKind,
  getIncomingEdges,
  getNodesByKind,
  isNodeActive,
  type DiagnosticFinding,
  type ReasoningGraphType,
  type ReasoningNode,
} from "@alcode/reasoning";

export interface CognitionOperationSummary {
  operationId: string;
  lifecycleState: "requested" | "started" | "terminal";
  reconciliationStatus: "not_required" | "pending" | "resolved" | "unresolved";
}

export interface CognitionSnapshot {
  sessionId: string;
  sourceEventSequence: number;
  graph: ReasoningGraphType;
  memories: MemoryRecord[];
  memoryStats: Map<string, MemoryStats>;
  operations: CognitionOperationSummary[];
  incompleteWorkCount: number;
}

export interface Orientation {
  sourceEventSequence: number;
  activeObjective: ReasoningNode | null;
  activeHypotheses: ReasoningNode[];
  assumptions: ReasoningNode[];
  alternatives: ReasoningNode[];
  pendingVerificationContracts: ReasoningNode[];
  evidence: ReasoningNode[];
  diagnostics: DiagnosticFinding[];
  pendingOperations: CognitionOperationSummary[];
}

export interface SearchRecallDecision {
  mode: "search";
  results: ScoredMemory[];
  reinforceSeenMemoryIds: string[];
}

export interface DirectRecallDecision {
  mode: "direct";
  record: MemoryRecord | null;
  reinforcement: {
    memoryId: string;
    usedCount: number;
    consolidationCount: number;
    strength: number;
    isConsolidation: boolean;
  } | null;
}

export interface CompletionAssessment {
  allowed: boolean;
  blockingReasons: string[];
  blockingFindingIds: string[];
}

const BLOCKING_DIAGNOSTICS = new Set([
  "contradicted_dependency",
  "evidence_staleness",
  "unsupported_conclusion",
]);

function activeNodes(snapshot: CognitionSnapshot, kind: string): ReasoningNode[] {
  return [...snapshot.graph.nodes.values()].filter(
    (node) => node.kind === kind && isNodeActive(snapshot.graph, node.id),
  );
}

function contractConsumed(snapshot: CognitionSnapshot, contractId: string): boolean {
  // Closed Phase 0.4 semantics persist EXECUTES as result/evidence → contract.
  return getIncomingEdges(snapshot.graph, contractId).some((edge) => edge.kind === EdgeKind.EXECUTES);
}

export class CognitionCoordinator {
  private readonly diagnostics = new DiagnosticEngine();

  orient(snapshot: CognitionSnapshot): Orientation {
    const objectives = activeNodes(snapshot, NodeKind.OBJECTIVE);
    const activeObjective = objectives.length > 0 ? objectives[objectives.length - 1]! : null;
    const contracts = activeNodes(snapshot, NodeKind.VERIFICATION_CONTRACT);
    const pendingVerificationContracts = contracts.filter((node) => !contractConsumed(snapshot, node.id));
    const evidence = [
      ...getNodesByKind(snapshot.graph, NodeKind.OBSERVATION),
      ...getNodesByKind(snapshot.graph, NodeKind.ACTION_RESULT),
    ];
    const diagnosticResult = this.diagnostics.diagnose(
      snapshot.graph,
      snapshot.sessionId,
      snapshot.sourceEventSequence,
    );

    return {
      sourceEventSequence: snapshot.sourceEventSequence,
      activeObjective,
      activeHypotheses: activeNodes(snapshot, NodeKind.HYPOTHESIS),
      assumptions: activeNodes(snapshot, NodeKind.ASSUMPTION),
      alternatives: activeNodes(snapshot, NodeKind.ALTERNATIVE),
      pendingVerificationContracts,
      evidence,
      diagnostics: diagnosticResult.findings,
      pendingOperations: snapshot.operations.filter(
        (operation) => operation.lifecycleState !== "terminal" || operation.reconciliationStatus === "pending",
      ),
    };
  }

  recallSearch(
    snapshot: CognitionSnapshot,
    query: string,
    now: number,
    options?: { limit?: number; queryContext?: RetrievalQueryContext },
  ): SearchRecallDecision {
    const results = rankByBlendedScore(snapshot.memories, snapshot.memoryStats, query, now, options);
    return {
      mode: "search",
      results,
      reinforceSeenMemoryIds: results.map((result) => result.record.memory_id),
    };
  }

  recallDirect(snapshot: CognitionSnapshot, memoryId: string, now: number): DirectRecallDecision {
    const record = snapshot.memories.find((memory) => memory.memory_id === memoryId) ?? null;
    const stats = snapshot.memoryStats.get(memoryId);
    if (!record || !stats || stats.lifecycle !== "active") {
      return { mode: "direct", record, reinforcement: null };
    }

    const updated = applyRecordUse(stats, now, "direct-recall");
    return {
      mode: "direct",
      record,
      reinforcement: {
        memoryId,
        usedCount: updated.used_count,
        consolidationCount: updated.consolidation_count,
        strength: updated.strength,
        isConsolidation: updated.isConsolidation,
      },
    };
  }

  seenReinforcement(stats: MemoryStats, now: number): { seenCount: number; lastSeen: number } {
    const updated = applyRecordSeen(stats, now);
    return { seenCount: updated.seen_count, lastSeen: updated.last_seen };
  }

  assessCompletion(snapshot: CognitionSnapshot, agentIdle: boolean): CompletionAssessment {
    const orientation = this.orient(snapshot);
    const blockingReasons: string[] = [];
    const blockingFindings = orientation.diagnostics.filter((finding) => BLOCKING_DIAGNOSTICS.has(finding.code));

    if (!agentIdle) blockingReasons.push("agent_not_idle");
    if (orientation.pendingOperations.length > 0) blockingReasons.push("pending_operation");
    if (orientation.pendingVerificationContracts.length > 0) blockingReasons.push("pending_verification_contract");
    if (blockingFindings.length > 0) blockingReasons.push("blocking_diagnostic");
    if (snapshot.incompleteWorkCount > 0) blockingReasons.push("incomplete_durable_work");

    return {
      allowed: blockingReasons.length === 0,
      blockingReasons,
      blockingFindingIds: blockingFindings.map((finding) => finding.findingId),
    };
  }
}
