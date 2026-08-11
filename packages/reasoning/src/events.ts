// Reasoning domain events — event type names and payload contracts.
//
// The reasoning package owns these event type names and payload contracts
// per the frozen event contract. The Host owns event admission and durable
// state. The reducer reconstructs the graph from these events.
//
// Phase 0.2 established objective.set with payload v1. Phase 0.4 extends
// reasoning semantics. The preferred path is additive optional fields on
// payload v1 to preserve replay compatibility.

// ---------------------------------------------------------------------------
// Event type constants
// ---------------------------------------------------------------------------

export const REASONING_EVENT_TYPES = {
  OBJECTIVE_SET: "objective.set", // Legacy Phase 0.2 compat (handled by reducer + projection)
  OBJECTIVE: "objective",
  HYPOTHESIS: "hypothesis",
  ASSUMPTION: "assumption",
  ALTERNATIVE: "alternative",
  DECISION: "decision",
  LINK_EVIDENCE: "link_evidence",
  VERIFICATION_CONTRACT: "verification_contract",
  FALSIFIER_EVALUATION: "falsifier_evaluation",
} as const;

// ---------------------------------------------------------------------------
// Payload contracts
// ---------------------------------------------------------------------------

export interface ObjectiveSetPayload {
  nodeId: string;
  kind: string;
  label: string;
  data: Record<string, unknown>;
  confidence: number | null;
  /** Phase 0.4 extended fields */
  statement?: string;
  successCriteria?: string;
  revisesObjectiveId?: string;
}

export interface HypothesisCreatedPayload {
  claim: string;
  predicts?: string[];
  confidence?: number | null;
  objectiveId?: string;
  supersedesHypothesisId?: string;
  falsifier?: string;
}

export interface AssumptionRecordedPayload {
  statement: string;
  status?: string;
  forHypothesisId?: string;
  inferredFrom?: string[];
}

export interface AlternativeDeferredPayload {
  label: string;
  hypothesis: string;
  deferredBecause: string;
  reactivateWhen?: string;
  alternativeToHypothesisId?: string;
}

export interface DecisionRecordedPayload {
  action: string;
  rationale: string;
  basedOn?: string[];
  branchId?: string;
  supersedesDecisionId?: string;
}

export interface EvidenceLinkedPayload {
  evidenceId: string;
  targetId: string;
  relation: string;
}

export interface FalsifierEvaluatedPayload {
  falsifierId: string;
  state: string;
  evidenceNodeIds?: string[];
  explanation?: string;
  evaluatorVersion?: string;
}

export interface VerificationPlannedPayload {
  hypothesisId: string;
  toolName: string;
  inputDigest: string;
  supportsWhen?: unknown;
  contradictsWhen?: unknown;
  description?: string;
  expectation?: string;
}
