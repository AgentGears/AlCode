// Reasoning vocabulary — complete 23 NodeKinds + 18 EdgeKinds ported from
// Ouroboros artifacts.py for source compatibility and graph round-trip
// fidelity.
//
// Phase 0.4 implements behavior only for the reasoning-core subset.
// Presence of PatchPlan, PatchResult, SkillCandidate, Standardization, etc.
// does not authorize porting patch execution, skills, or standardization
// subsystems.
//
// See docs/phase-0.4-exclusion-rationale.md.

// ---------------------------------------------------------------------------
// NodeKind — 23 kinds (exact string values from Ouroboros)
// ---------------------------------------------------------------------------

export const NodeKind = {
  GOAL: "goal",
  ASSUMPTION: "assumption",
  HYPOTHESIS: "hypothesis",
  PLAN: "plan",
  OBSERVATION: "observation",
  ORIENTATION: "orientation",
  DECISION: "decision",
  ACTION: "action",
  ACTION_RESULT: "action_result",
  CHECK: "check",
  CRITIQUE: "critique",
  BRANCH_TRANSITION: "branch_transition",
  PATCH_PLAN: "patch_plan",
  PATCH_RESULT: "patch_result",
  SKILL_CANDIDATE: "skill_candidate",
  REFLECTION: "reflection",
  STANDARDIZATION: "standardization",
  ESCALATION: "escalation",
  OBJECTIVE: "objective",
  ALTERNATIVE: "alternative",
  FALSIFIER: "falsifier",
  VERIFICATION_CONTRACT: "verification_contract",
  FALSIFIER_EVALUATION: "falsifier_evaluation",
} as const;

export type NodeKind = (typeof NodeKind)[keyof typeof NodeKind];

/** All valid NodeKind string values. */
export const ALL_NODE_KINDS: readonly NodeKind[] = Object.values(NodeKind);

// ---------------------------------------------------------------------------
// EdgeKind — 18 kinds (exact string values from Ouroboros)
// ---------------------------------------------------------------------------

export const EdgeKind = {
  DEPENDS_ON: "depends_on",
  SUPPORTS: "supports",
  CONTRADICTS: "contradicts",
  PRODUCED_BY: "produced_by",
  SELECTED_OVER: "selected_over",
  FAILED_DUE_TO: "failed_due_to",
  GRAFTED_FROM: "grafted_from",
  REVISES: "revises",
  TRIGGERS: "triggers",
  TAGS: "tags",
  GENERALIZES_TO: "generalizes_to",
  ALTERNATIVE_TO: "alternative_to",
  FALSIFIES: "falsifies",
  ADDRESSES: "addresses",
  TESTS: "tests",
  EXECUTES: "executes",
  EVALUATES: "evaluates",
  BASED_ON: "based_on",
} as const;

export type EdgeKind = (typeof EdgeKind)[keyof typeof EdgeKind];

/** All valid EdgeKind string values. */
export const ALL_EDGE_KINDS: readonly EdgeKind[] = Object.values(EdgeKind);

// ---------------------------------------------------------------------------
// Node and Edge (structural, generic)
// ---------------------------------------------------------------------------

export interface ReasoningNode {
  id: string;
  kind: NodeKind;
  label: string;
  data: Record<string, unknown>;
  confidence: number | null;
  step: number | null;
}

export interface ReasoningEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// EvaluationState (falsifier lifecycle)
// ---------------------------------------------------------------------------

export const EvaluationState = {
  UNEVALUATED: "unevaluated",
  SATISFIED: "satisfied",
  REFUTED: "refuted",
  INCONCLUSIVE: "inconclusive",
  SUPERSEDED: "superseded",
} as const;

export type EvaluationState = (typeof EvaluationState)[keyof typeof EvaluationState];

// ---------------------------------------------------------------------------
// Verdict / RootCause (loop artifacts)
// ---------------------------------------------------------------------------

export const Verdict = {
  PASS: "pass",
  FAIL: "fail",
} as const;

export type Verdict = (typeof Verdict)[keyof typeof Verdict];

export const RootCause = {
  GOAL: "goal",
  PLAN: "plan",
  EXECUTION: "execution",
  ENVIRONMENT: "environment",
  UNKNOWN: "unknown",
} as const;

export type RootCause = (typeof RootCause)[keyof typeof RootCause];

// ---------------------------------------------------------------------------
// Branch status
// ---------------------------------------------------------------------------

export const BranchStatus = {
  ACTIVE: "active",
  PRUNED: "pruned",
  COMPLETE: "complete",
  ESCALATED: "escalated",
} as const;

export type BranchStatus = (typeof BranchStatus)[keyof typeof BranchStatus];

// ---------------------------------------------------------------------------
// Critic recommendation
// ---------------------------------------------------------------------------

export const CriticRecommendation = {
  CONTINUE: "continue",
  WATCH: "watch",
  GRAFT: "graft",
  PRUNE: "prune",
} as const;

export type CriticRecommendation = (typeof CriticRecommendation)[keyof typeof CriticRecommendation];

// ---------------------------------------------------------------------------
// Diagnostic types
// ---------------------------------------------------------------------------

export const DiagnosticSeverity = {
  INFO: "info",
  WARNING: "warning",
  ERROR: "error",
} as const;

export type DiagnosticSeverity = (typeof DiagnosticSeverity)[keyof typeof DiagnosticSeverity];

export const DiagnosticCode = {
  UNSUPPORTED_CONCLUSION: "unsupported_conclusion",
  CONTRADICTED_DEPENDENCY: "contradicted_dependency",
  EVIDENCE_STALENESS: "evidence_staleness",
  MISSING_FALSIFIER: "missing_falsifier",
} as const;

export type DiagnosticCode = (typeof DiagnosticCode)[keyof typeof DiagnosticCode];

// ---------------------------------------------------------------------------
// Evidence classification
// ---------------------------------------------------------------------------

export const EVIDENCE_KINDS: readonly NodeKind[] = [
  NodeKind.OBSERVATION,
  NodeKind.ACTION_RESULT,
];

/** Kinds that can be evidence targets (link_evidence). */
export const EVIDENCE_TARGET_KINDS: readonly NodeKind[] = [
  NodeKind.HYPOTHESIS,
  NodeKind.ASSUMPTION,
  NodeKind.FALSIFIER,
];

// ---------------------------------------------------------------------------
// Verification types
// ---------------------------------------------------------------------------

export const OutcomeField = {
  EXIT_CODE: "exit_code",
  IS_FAILURE: "is_failure",
  STDOUT: "stdout",
  STDERR: "stderr",
  STDOUT_DIGEST: "stdout_digest",
  STDERR_DIGEST: "stderr_digest",
} as const;

export type OutcomeField = (typeof OutcomeField)[keyof typeof OutcomeField];

export const OutcomeOperator = {
  EQUALS: "equals",
  NOT_EQUALS: "not_equals",
  CONTAINS: "contains",
  DIGEST_EQUALS: "digest_equals",
} as const;

export type OutcomeOperator = (typeof OutcomeOperator)[keyof typeof OutcomeOperator];

export const VerificationOutcome = {
  SUPPORTS: "supports",
  CONTRADICTS: "contradicts",
  INCONCLUSIVE: "inconclusive",
  AMBIGUOUS: "ambiguous",
} as const;

export type VerificationOutcome = (typeof VerificationOutcome)[keyof typeof VerificationOutcome];

export const MatchStatus = {
  EXACT: "exact",
  STRUCTURED: "structured",
  AMBIGUOUS: "ambiguous",
  UNMATCHED: "unmatched",
} as const;

export type MatchStatus = (typeof MatchStatus)[keyof typeof MatchStatus];

export const MatchMethod = {
  CORRELATION_ID: "correlation_id",
  DIGEST: "digest",
  SIGNATURE: "signature",
  NONE: "none",
} as const;

export type MatchMethod = (typeof MatchMethod)[keyof typeof MatchMethod];

export const OutcomeTrust = {
  TRUSTED: "trusted",
  UNTRUSTED: "untrusted",
} as const;

export type OutcomeTrust = (typeof OutcomeTrust)[keyof typeof OutcomeTrust];
