import type { Message } from "@alcode/agent-core";
import type { MemoryRecord, MemoryScoreBreakdown, MemoryStats } from "@alcode/memory";
import type { DiagnosticFinding, ReasoningGraphType, ReasoningNode } from "@alcode/reasoning";

export type ContextMode = "verbatim" | "graph";
export type EffectiveContextMode = "verbatim-v1" | "graph-v1";

export type ContextTrustClass =
  | "host_control"
  | "host_observed"
  | "verified_evidence"
  | "epistemic_claim"
  | "advisory_memory"
  | "unverified_data";

export interface ContextOperation {
  operationId: string;
  lifecycleState: "requested" | "started" | "terminal";
  effectStatus?: "confirmed" | "absent" | "indeterminate" | "not_applicable";
  reconciliationStatus: "not_required" | "pending" | "resolved" | "unresolved";
  toolName?: string;
}

/** Immutable data derived from one captured canonical event cut. */
export interface ContextSourceSnapshot {
  sessionId: string;
  sourceEventSequence: number;
  messages: Message[];
  transcriptStatus: "complete" | "incomplete";
  pendingToolCallIds: string[];
  graph: ReasoningGraphType;
  diagnostics: DiagnosticFinding[];
  memories: MemoryRecord[];
  memoryStats: Map<string, MemoryStats>;
  operations: ContextOperation[];
  incompleteWorkCount: number;
  currentUserText: string;
  currentUserTimestamp: number;
}

export interface WorkspaceContextSnapshot {
  workspaceId: string;
  repositoryId: string;
  kind: "git" | "non_git";
  headCommit?: string;
  branch?: string;
  dirty: boolean;
  changedPaths: string[];
  changedPathCount: number;
  changedPathsTruncated: boolean;
  statusDigest: string;
}

export type WorkspaceObservation =
  | {
      status: "observed";
      observedAt: string;
      providerVersion: string;
      snapshot: WorkspaceContextSnapshot;
    }
  | {
      status: "failed";
      observedAt: string;
      providerVersion: string;
      reasonCode: string;
    };

export interface WorkspaceContextProvider {
  observe(): Promise<WorkspaceObservation>;
}

export interface ContextBudget {
  maxGraphRenderedChars: number;
  estimatorVersion: "chars4-v1";
}

export interface RequestEnvironment {
  baseSystemPromptDigest: string;
  toolDefinitionsDigest: string;
  compilerVersion: "graph-v1";
  policyConfigDigest: string;
}

export type MemoryAnchorKind = "current_user" | "objective" | "hypothesis";
export interface MemoryContextAnchor {
  kind: MemoryAnchorKind;
  sourceId: string;
  text: string;
}

export type CandidateFamily =
  | "workspace"
  | "objective"
  | "hypothesis"
  | "falsifier"
  | "verification"
  | "decision"
  | "diagnostic"
  | "operation"
  | "evidence"
  | "assumption"
  | "alternative"
  | "memory";

export interface ContextCandidate {
  id: string;
  family: CandidateFamily;
  trustClass: ContextTrustClass;
  required: boolean;
  sourceIds: string[];
  value: unknown;
  priority: number;
  receiptMetadata?: Record<string, unknown>;
}

export interface ContextReceiptEntry {
  id: string;
  family: CandidateFamily;
  trustClass: ContextTrustClass;
  sourceIds: string[];
  metadata?: Record<string, unknown>;
}

export interface ContextExcludedFamilySummary {
  candidateCount: number;
  excludedCount: number;
  reasonCounts: Record<string, number>;
}

export interface ContextExcludedSummary {
  transcript: ContextExcludedFamilySummary;
  reasoning: ContextExcludedFamilySummary;
  memory: ContextExcludedFamilySummary;
}

export interface SelectedMemory {
  memoryId: string;
  anchor: MemoryContextAnchor;
  score: MemoryScoreBreakdown;
  record: MemoryRecord;
}

export interface ReasoningFrontier {
  objective: ReasoningNode | null;
  hypotheses: ReasoningNode[];
  falsifiers: ReasoningNode[];
  pendingVerificationContracts: ReasoningNode[];
  decisions: ReasoningNode[];
  decisiveEvidence: ReasoningNode[];
  assumptions: ReasoningNode[];
  alternatives: ReasoningNode[];
  diagnostics: DiagnosticFinding[];
  implicatedNodeIds: string[];
}

export type ContextFallbackReason =
  | "transcript_incomplete"
  | "canonical_source_invalid"
  | "reasoning_graph_invalid"
  | "reasoning_frontier_ambiguous"
  | "workspace_observation_failed"
  | "required_budget_overflow"
  | "render_bound_violation"
  | "unsupported_context_capability"
  | "receipt_admission_failed";

export interface ContextProjectionReceipt {
  receiptVersion: "context-receipt-v1";
  source: {
    sourceEventSequence: number;
    workspaceObservation: WorkspaceObservation;
    requestEnvironmentDigest: string;
    baseSystemPromptDigest: string;
    toolDefinitionsDigest: string;
    policyConfigDigest: string;
  };
  attempt: {
    requestedMode: ContextMode;
    candidateCount: number;
    candidateUniverseDigest: string;
    requiredRenderedChars: number;
    optionalSelectedRenderedChars: number;
    graphRenderedChars?: number;
    maxGraphRenderedChars: number;
    selected: ContextReceiptEntry[];
    excludedSummary: ContextExcludedSummary;
  };
  delivery: {
    effectiveMode: EffectiveContextMode;
    deliveredRenderedChars: number;
    deliveredEstimatedTokens: number;
    messagesDigest: string;
    systemAppendixDigest: string;
    observationDigest: string;
    graphBoundSatisfied: boolean | null;
  };
  fallback: {
    used: boolean;
    reason?: ContextFallbackReason;
  };
}

export interface CompileGraphContextRequest {
  source: ContextSourceSnapshot;
  workspace: WorkspaceObservation;
  budget: ContextBudget;
  requestEnvironment: RequestEnvironment;
  /**
   * Exact rendered character cost for fixed request components that are not
   * governed by the graph hard bound (base system prompt, tool definitions,
   * and other fixed request framing). The latest canonical user message is
   * measured from `source.messages` separately by the compiler.
   */
  fixedRequestRenderedChars?: number;
}

export interface GraphCompiledContext {
  effectiveMode: "graph-v1";
  sourceEventSequence: number;
  historyMessages: Message[];
  systemAppendix: string;
  graphRenderedChars: number;
  deliveredRenderedChars: number;
  estimatedTokens: number;
  receipt: ContextProjectionReceipt;
}

export interface GraphFallback {
  effectiveMode: "verbatim-v1";
  sourceEventSequence: number;
  historyMessages: Message[];
  systemAppendix: "";
  graphRenderedChars: number;
  deliveredRenderedChars: number;
  estimatedTokens: number;
  reason: ContextFallbackReason;
  receipt: ContextProjectionReceipt;
}

export type CompileGraphContextResult = GraphCompiledContext | GraphFallback;
