// Reasoning domain events — event type names and payload contracts.
//
// The reasoning package owns these event type names and payload contracts
// per the frozen event contract. The Host owns event admission and durable
// state. The reducer reconstructs the graph from these events.

export const REASONING_EVENT_TYPES = {
  OBJECTIVE_SET: "objective.set",
  HYPOTHESIS_CREATED: "hypothesis.created",
  ASSUMPTION_RECORDED: "assumption.recorded",
  ALTERNATIVE_DEFERRED: "alternative.deferred",
  DECISION_RECORDED: "decision.recorded",
  EVIDENCE_LINKED: "evidence.linked",
  FALSIFIER_EVALUATED: "falsifier.evaluated",
  VERIFICATION_PLANNED: "verification.planned",
  ACTION_RECORDED: "action.recorded",
  EVIDENCE_RECORDED: "evidence.recorded",
  VERIFICATION_RESULT_CORRELATED: "verification.result.correlated",
} as const;

/** Map canonical ALCODE event types to reducer labels. */
export const CANONICAL_TO_REDUCER: Record<string, string> = {
  "objective.set": "objective",
  "hypothesis.created": "hypothesis",
  "assumption.recorded": "assumption",
  "alternative.deferred": "alternative",
  "decision.recorded": "decision",
  "evidence.linked": "link_evidence",
  "falsifier.evaluated": "falsifier_evaluation",
  "verification.planned": "verification_contract",
  "action.recorded": "action_recorded",
  "evidence.recorded": "evidence_recorded",
  "verification.result.correlated": "verification_result_correlated",
  "objective": "objective",
  "hypothesis": "hypothesis",
  "assumption": "assumption",
  "alternative": "alternative",
  "decision": "decision",
  "link_evidence": "link_evidence",
  "falsifier_evaluation": "falsifier_evaluation",
  "verification_contract": "verification_contract",
  "action_recorded": "action_recorded",
  "evidence_recorded": "evidence_recorded",
  "verification_result_correlated": "verification_result_correlated",
};

export interface ObjectiveSetPayload {
  nodeId: string;
  kind: string;
  label: string;
  data: Record<string, unknown>;
  confidence: number | null;
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
  forHypothesisId?: string;
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

/** Phase 0.5: Host records the prospective environmental action before execution. */
export interface ActionRecordedPayload {
  operationId: string;
  toolName: string;
  inputDigest: string;
  argsSummary?: unknown;
}

/** Phase 0.5: Host records normalized environmental evidence after execution. */
export interface EvidenceRecordedPayload {
  operationId: string;
  sourceEventId: string;
  toolName: string;
  evidenceKind: "observation" | "action_result";
  success: boolean;
  outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
  exitCode?: number | null;
  stdoutDigest?: string;
  stderrDigest?: string;
  verificationCommand?: string;
  actionId: string;
}

/** Phase 0.5: persist the conservative verification-linker result. */
export interface VerificationResultCorrelatedPayload {
  contractId: string;
  evidenceId: string;
  hypothesisId: string;
  matchStatus: "exact" | "structured";
  matchMethod: "correlation_id" | "digest" | "signature";
  outcomeTrust: "trusted" | "untrusted";
  outcome: "supports" | "contradicts" | "inconclusive" | "ambiguous";
}
