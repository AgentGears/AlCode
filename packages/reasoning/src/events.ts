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
  OBJECTIVE_SET: "objective.set",
  HYPOTHESIS_CREATED: "hypothesis.created",
  ASSUMPTION_RECORDED: "assumption.recorded",
  ALTERNATIVE_DEFERRED: "alternative.deferred",
  DECISION_RECORDED: "decision.recorded",
  EVIDENCE_LINKED: "evidence.linked",
  FALSIFIER_EVALUATED: "falsifier.evaluated",
  VERIFICATION_PLANNED: "verification.planned",
} as const;

/**
 * Map ALCODE canonical dotted event types to Ouroboros-compatible internal
 * reducer labels. The reducer dispatches on the internal labels; the
 * canonical durable event stream uses the dotted names.
 */
export const CANONICAL_TO_REDUCER: Record<string, string> = {
  "objective.set": "objective",
  "hypothesis.created": "hypothesis",
  "assumption.recorded": "assumption",
  "alternative.deferred": "alternative",
  "decision.recorded": "decision",
  "evidence.linked": "link_evidence",
  "falsifier.evaluated": "falsifier_evaluation",
  "verification.planned": "verification_contract",
  // Also accept undotted forms for forward compat
  "objective": "objective",
  "hypothesis": "hypothesis",
  "assumption": "assumption",
  "alternative": "alternative",
  "decision": "decision",
  "link_evidence": "link_evidence",
  "falsifier_evaluation": "falsifier_evaluation",
  "verification_contract": "verification_contract",
};

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
