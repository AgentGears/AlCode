// @alcode/reasoning — the Ouroboros-equivalent reasoning semantic engine.
//
// Owns: graph semantics, cognitive artifacts, deterministic reduction,
// critic behavior, branching/grafting, diagnostics, falsifiers, and
// verification semantics.
//
// Does NOT own: event admission, SQLite, agent-tool APIs, environmental
// execution, scheduling, governance, or context compilation.
//
// See docs/adr/0005-runtime-ownership-boundaries.md §Host↔Reasoning.
// See docs/phase-0.4-exclusion-rationale.md.

// Vocabulary
export {
  NodeKind,
  EdgeKind,
  EvaluationState,
  Verdict,
  RootCause,
  BranchStatus,
  CriticRecommendation,
  DiagnosticSeverity,
  DiagnosticCode,
  OutcomeField,
  OutcomeOperator,
  VerificationOutcome,
  MatchStatus,
  MatchMethod,
  OutcomeTrust,
  ALL_NODE_KINDS,
  ALL_EDGE_KINDS,
  EVIDENCE_KINDS,
  EVIDENCE_TARGET_KINDS,
  type NodeKind as NodeKindType,
  type EdgeKind as EdgeKindType,
  type EvaluationState as EvaluationStateType,
  type Verdict as VerdictType,
  type RootCause as RootCauseType,
  type BranchStatus as BranchStatusType,
  type CriticRecommendation as CriticRecommendationType,
  type DiagnosticSeverity as DiagnosticSeverityType,
  type DiagnosticCode as DiagnosticCodeType,
  type OutcomeField as OutcomeFieldType,
  type OutcomeOperator as OutcomeOperatorType,
  type VerificationOutcome as VerificationOutcomeType,
  type MatchStatus as MatchStatusType,
  type MatchMethod as MatchMethodType,
  type OutcomeTrust as OutcomeTrustType,
  type ReasoningNode,
  type ReasoningEdge,
} from "./schema.ts";

// Cognitive types
export type {
  ObjectivePayload,
  HypothesisPayload,
  FalsifierPayload,
  AssumptionPayload,
  AssumptionStatus,
  AlternativePayload,
  AlternativeStatus,
  FalsifierEvaluationPayload,
  DecisionPayload,
  EvidenceRelation,
  VerificationContractPayload,
  OperationMatcher,
  OutcomePredicate,
  OutcomeExpression,
  MatchResult,
  CommitHypothesisResult,
  OpenInvestigationResult,
} from "./cognitive.ts";

// Transition intents
export type {
  ReasoningTransitionIntent,
  ReasoningBatchIntent,
} from "./operations.ts";

// Graph
export {
  GraphValidationError,
  createReasoningGraph,
  addNode,
  addEdge,
  getNode,
  getEdge,
  getNodesByKind,
  getEdgesByKind,
  getIncomingEdges,
  getOutgoingEdges,
  validateCognitiveGraph,
  validateSingleLoopGraph,
  graphToJSON,
  graphFromJSON,
  getSupersededIds,
  isNodeActive,
  extractSequence,
  type ReasoningGraph as ReasoningGraphType,
  type GraphJSON,
} from "./graph.ts";

// Cognitive operations
export {
  ReasoningValidationError,
  set_objective,
  commit_hypothesis,
  record_assumption,
  defer_alternative,
  record_decision,
  link_evidence,
  evaluate_falsifier,
  plan_verification,
  open_investigation,
  canonicalInputDigest,
} from "./cognitive-operations.ts";

// Reducer
export {
  createReductionIndex,
  reduceEvent,
  reduceStream,
  deriveNodeId,
  deriveEdgeId,
  type ReductionIndex,
  type ReasoningEventType,
  type ReasoningEvent,
  type StreamEvent,
} from "./reducer.ts";

// Critic
export {
  BranchCritic,
  DEFAULT_CRITIC_WEIGHTS,
  fromState,
  type CriticWeights,
  type BranchSignals,
  type BranchCritique,
  type WeightedTerm,
} from "./critic.ts";

// Branching
export {
  DeterministicBranchIdFactory,
  RuleBasedBranchGenerator,
  GraftPolicy,
  type BranchIdFactory,
  type BranchCandidate,
  type GraftDecision,
} from "./branching.ts";

// Diagnostics
export {
  DiagnosticEngine,
  GraphView,
  DETECTOR_VERSION,
  type DiagnosticFinding,
} from "./diagnostics.ts";

// Verification
export {
  VerificationLinker,
  indexPendingContracts,
  resolveContractPayload,
  resolveContractTrust,
  matchesPredicate,
  matchesOutcomeExpression,
  canonicalDigestOf,
  canonicalSignature,
} from "./verification.ts";

// Domain events
export {
  REASONING_EVENT_TYPES,
  type ObjectiveSetPayload,
  type HypothesisCreatedPayload,
  type AssumptionRecordedPayload,
  type AlternativeDeferredPayload,
  type DecisionRecordedPayload,
  type EvidenceLinkedPayload,
  type FalsifierEvaluatedPayload,
  type VerificationPlannedPayload,
} from "./events.ts";
