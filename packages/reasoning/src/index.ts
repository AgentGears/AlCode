// @alcode/reasoning — the Ouroboros-equivalent reasoning semantic engine.
// Owns semantics only; Host owns admission, durability, execution and lifecycle.

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

export type {
  ReasoningTransitionIntent,
  ReasoningBatchIntent,
} from "./operations.ts";

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

export {
  REASONING_INTEGRATION_EVENT_TYPES,
  normalizeToolNameForReasoning,
  reduceIntegrationEvent,
} from "./integration.ts";

export {
  BranchCritic,
  DEFAULT_CRITIC_WEIGHTS,
  fromState,
  type CriticWeights,
  type BranchSignals,
  type BranchCritique,
  type WeightedTerm,
} from "./critic.ts";

export {
  DeterministicBranchIdFactory,
  RuleBasedBranchGenerator,
  GraftPolicy,
  type BranchIdFactory,
  type BranchCandidate,
  type GraftDecision,
} from "./branching.ts";

export {
  DiagnosticEngine,
  GraphView,
  DETECTOR_VERSION,
  type DiagnosticFinding,
} from "./diagnostics.ts";

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

export {
  REASONING_EVENT_TYPES,
  CANONICAL_TO_REDUCER,
  type ObjectiveSetPayload,
  type HypothesisCreatedPayload,
  type AssumptionRecordedPayload,
  type AlternativeDeferredPayload,
  type DecisionRecordedPayload,
  type EvidenceLinkedPayload,
  type FalsifierEvaluatedPayload,
  type VerificationPlannedPayload,
  type ActionRecordedPayload,
  type EvidenceRecordedPayload,
  type VerificationResultCorrelatedPayload,
} from "./events.ts";
