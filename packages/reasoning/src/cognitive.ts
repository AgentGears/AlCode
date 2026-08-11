// Cognitive artifact types — structured payloads for reasoning nodes.
// Ported from Ouroboros cognitive.py.

import {
  EvaluationState,
  type MatchMethod,
  type MatchStatus,
  type OutcomeTrust,
} from "./schema.ts";

export interface ObjectivePayload {
  statement: string;
  successCriteria: string | null;
  revisesObjectiveId?: string;
}

export interface HypothesisPayload {
  claim: string;
  predicts: string[];
  confidence: number | null;
  objectiveId?: string;
  supersedesHypothesisId?: string;
}

export interface FalsifierPayload {
  statement: string;
  forHypothesisId: string;
  /** @deprecated use derived EvaluationState instead */
  satisfied: boolean;
}

export type AssumptionStatus = "unconfirmed" | "confirmed" | "contradicted";

export interface AssumptionPayload {
  statement: string;
  status: AssumptionStatus;
  forHypothesisId: string | null;
  inferredFrom: string[];
}

export type AlternativeStatus = "dormant" | "reactivated" | "superseded";

export interface AlternativePayload {
  label: string;
  hypothesis: string;
  deferredBecause: string;
  reactivateWhen: string | null;
  alternativeToHypothesisId: string | null;
  status: AlternativeStatus;
}

export interface FalsifierEvaluationPayload {
  state: EvaluationState;
  evaluatorVersion: string;
  evaluatedSequence: number;
  explanation: string;
  falsifierId: string;
  evidenceNodeIds: string[];
  forHypothesisId: string | null;
}

export interface DecisionPayload {
  action: string;
  rationale: string;
  basedOn: string[];
  branchId: string;
  supersedesDecisionId: string | null;
}

export type EvidenceRelation = "supports" | "contradicts";

export interface OperationMatcher {
  toolName: string;
  inputDigest: string;
}

export interface OutcomePredicate {
  field: string;
  operator: string;
  value: unknown;
}

export interface OutcomeExpression {
  allOf: OutcomePredicate[];
  anyOf: OutcomePredicate[];
}

export interface VerificationContractPayload {
  hypothesisId: string;
  operationMatcher: OperationMatcher;
  supportsWhen: OutcomeExpression | null;
  contradictsWhen: OutcomeExpression | null;
  description: string | null;
  expectation: string | null;
}

export interface MatchResult {
  status: MatchStatus;
  method: MatchMethod;
  outcomeTrust: OutcomeTrust;
  contractId: string | null;
  reason: string;
}

export interface CommitHypothesisResult {
  nodeId: string;
  falsifierId: string | null;
}

export interface OpenInvestigationResult {
  objectiveNodeId: string;
  hypothesisNodeId: string;
  falsifierNodeId: string | null;
}
