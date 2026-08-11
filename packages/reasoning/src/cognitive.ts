// Cognitive artifact types — structured payloads for reasoning nodes.
// Ported from Ouroboros cognitive.py.
//
// These are carried as node.data payloads. The graph itself is generic;
// these types define the structured content for the cognitive-system subset.

import { EvaluationState } from "./schema.ts";

// ---------------------------------------------------------------------------
// Objective — first-class node kind, carries success_criteria
// ---------------------------------------------------------------------------

export interface ObjectivePayload {
  statement: string;
  successCriteria: string | null;
  /** ID of the objective this one revises (supersedes). */
  revisesObjectiveId?: string;
}

// ---------------------------------------------------------------------------
// Hypothesis — claim with optional predictions and confidence
// ---------------------------------------------------------------------------

export interface HypothesisPayload {
  claim: string;
  predicts: string[];
  confidence: number | null;
  /** ID of the objective this hypothesis addresses. */
  objectiveId?: string;
  /** ID of the hypothesis this one supersedes. */
  supersedesHypothesisId?: string;
}

// ---------------------------------------------------------------------------
// Falsifier — a disconfirmation condition for a hypothesis
// ---------------------------------------------------------------------------

export interface FalsifierPayload {
  statement: string;
  forHypothesisId: string;
  /** @deprecated use derived EvaluationState instead */
  satisfied: boolean;
}

// ---------------------------------------------------------------------------
// Assumption — an unconfirmed/confirmed/contradicted dependency
// ---------------------------------------------------------------------------

export type AssumptionStatus = "unconfirmed" | "confirmed" | "contradicted";

export interface AssumptionPayload {
  statement: string;
  status: AssumptionStatus;
  forHypothesisId: string | null;
  inferredFrom: string[];
}

// ---------------------------------------------------------------------------
// Alternative — a deferred hypothesis
// ---------------------------------------------------------------------------

export type AlternativeStatus = "dormant" | "reactivated" | "superseded";

export interface AlternativePayload {
  label: string;
  hypothesis: string;
  deferredBecause: string;
  reactivateWhen: string | null;
  alternativeToHypothesisId: string | null;
  status: AlternativeStatus;
}

// ---------------------------------------------------------------------------
// FalsifierEvaluation — append-only evaluation of a falsifier
// ---------------------------------------------------------------------------

export interface FalsifierEvaluationPayload {
  state: EvaluationState;
  evaluatorVersion: string;
  evaluatedSequence: number;
  explanation: string;
  falsifierId: string;
  evidenceNodeIds: string[];
  /** The hypothesis this falsifier targets (for projection CONTRADICTS derivation). */
  forHypothesisId: string | null;
}

// ---------------------------------------------------------------------------
// Decision — a recorded action choice
// ---------------------------------------------------------------------------

export interface DecisionPayload {
  action: string;
  rationale: string;
  basedOn: string[];
  branchId: string;
  supersedesDecisionId: string | null;
}

// ---------------------------------------------------------------------------
// Evidence link — SUPPORTS or CONTRADICTS relation
// ---------------------------------------------------------------------------

export type EvidenceRelation = "supports" | "contradicts";

// ---------------------------------------------------------------------------
// Verification contract — prospective test plan for a hypothesis
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Match result — what happened when an action result met a contract
// ---------------------------------------------------------------------------

export interface MatchResult {
  status: string;
  method: string;
  outcomeTrust: string;
  contractId: string | null;
  reason: string;
}

// ---------------------------------------------------------------------------
// CommitHypothesisResult — surfaced falsifier ID for callers
// ---------------------------------------------------------------------------

export interface CommitHypothesisResult {
  nodeId: string;
  falsifierId: string | null;
}

// ---------------------------------------------------------------------------
// OpenInvestigationResult — atomic objective+hypothesis bundle
// ---------------------------------------------------------------------------

export interface OpenInvestigationResult {
  objectiveNodeId: string;
  hypothesisNodeId: string;
  falsifierNodeId: string | null;
}
