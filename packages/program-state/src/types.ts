export type Branded<TBrand extends string> = string & { readonly __brand: TBrand };
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// Cross-domain identities are structurally compatible with @alcode/events by
// carrying the same nominal brand. The pure kernel does not depend on the
// event/storage runtime merely to name these values.
export type ProgramStateId = Branded<"ProgramStateId">;
export type SessionId = Branded<"SessionId">;
export type OperationId = Branded<"OperationId">;

export type ProgramWorkItemId = Branded<"ProgramWorkItemId">;
export type ProgramAttemptId = Branded<"ProgramAttemptId">;
export type VerificationObligationId = Branded<"VerificationObligationId">;
export type ProgramBlockerId = Branded<"ProgramBlockerId">;
export type ProgramOutputSlotId = Branded<"ProgramOutputSlotId">;
export type ProgramArtifactProductionStepId = Branded<"ProgramArtifactProductionStepId">;
export type ProgramEvidenceRefId = Branded<"ProgramEvidenceRefId">;
export type ExecutionBaseMismatchReceiptId = Branded<"ExecutionBaseMismatchReceiptId">;
export type ProgramRevisionId = Branded<"ProgramRevisionId">;

export type ProgramLifecycle = "active" | "completed" | "cancelled";
export type ProgramWorkLifecycle =
  | "pending"
  | "in_progress"
  | "awaiting_verification"
  | "blocked"
  | "completed";

/** A1 semantic state is orthogonal to the legacy execution lifecycle. */
export type ProgramRequirementState = "required" | "withdrawn" | "superseded";
export type ProgramTopologyState = "leaf" | "decomposed";
export type ProgramSatisfactionState =
  | "pending"
  | "active"
  | "blocked"
  | "awaiting_verification"
  | "satisfied";
export type ProgramChangeClass = "initial" | "refinement" | "correction" | "scope_amendment";
export type WorkItemIdentityDisposition =
  | "preserve_identity_and_advance_generation"
  | "new_identity_supersedes_old"
  | "withdraw_identity"
  | "unchanged";

export type WorkspacePathState = "file" | "directory" | "symlink" | "absent";
export type FreshnessPathMode = "exact" | "subtree";

export interface FreshnessPathEntry {
  path: string;
  mode: FreshnessPathMode;
}

export type VerificationFreshnessScopeV1 =
  | { kind: "workspace" }
  | { kind: "paths"; entries: FreshnessPathEntry[] };

export interface HostOperationSpecReferenceV1 {
  specId: string;
  specVersion: number;
  canonicalArgs: Json;
  canonicalArgsDigest: string;
}

// Compile-time sentinel only: its required `never` property makes it
// unconstructable by typed callers, while keeping the runtime validator's
// default branch type-reachable for deserialized/untyped input. Canonical
// admission still accepts exactly the three v1 predicate kinds below.
type RuntimeUntrustedVerificationPredicateSentinel = {
  kind: "__runtime_untrusted_never_admitted__";
  __runtimeOnly: never;
};

export type VerificationPredicateV1 =
  | ({ kind: "operation_result" } & HostOperationSpecReferenceV1)
  | {
      kind: "workspace_path_state";
      path: string;
      requiredState: WorkspacePathState;
    }
  | {
      kind: "artifact_present";
      outputSlotId: ProgramOutputSlotId;
    }
  | RuntimeUntrustedVerificationPredicateSentinel;

export interface ProgramWorkDefinition {
  workItemId: ProgramWorkItemId;
  creationOrder: number;
  description: string;
  dependencyIds: ProgramWorkItemId[];
  affectedPaths: string[];
}

export interface ProgramWorkItem extends ProgramWorkDefinition {
  lifecycle: ProgramWorkLifecycle;
}

/**
 * Frozen A1 mechanically comparable authority. Collection order is canonical
 * and therefore part of the durable representation.
 */
export interface WorkAuthorityEnvelopeV1 {
  objectiveBoundaryRef: {
    programStateId: ProgramStateId;
    rootProgramRevisionId: ProgramRevisionId;
    anchorWorkItemId: ProgramWorkItemId | null;
  };
  allowedRepositoryRoots: string[];
  allowedEffectClasses: string[];
  allowedExternalSystems: string[];
  capabilityCeiling: string[];
  maximumTopologyExpansion: number;
  mandatoryVerificationIds: VerificationObligationId[];
  forbiddenChangeKinds: string[];
}

/** Current semantic representation of one durable WorkItem in adaptive mode. */
export interface ProgramSemanticWorkItemV1 extends ProgramWorkDefinition {
  workItemGeneration: number;
  requirementState: ProgramRequirementState;
  topologyState: ProgramTopologyState;
  satisfactionState: ProgramSatisfactionState;
  parentWorkItemId: ProgramWorkItemId | null;
  authorityEnvelope: WorkAuthorityEnvelopeV1;
}

/** Immutable semantic-revision lineage record. */
export interface ProgramRevision {
  programRevisionId: ProgramRevisionId;
  parentProgramRevisionId: ProgramRevisionId | null;
  ordinal: number;
  changeClass: ProgramChangeClass;
  acceptedAtStateRevision: number;
  admissionEventId: string;
  sourceDraftId: string | null;
  sourceDraftDigest: string | null;
}

/**
 * Semantic subject identity is distinct from verification subjectGeneration,
 * which continues to represent proof freshness for one exact semantic subject.
 */
export type VerificationSubjectV1 =
  | { kind: "program" }
  | {
      kind: "work_item";
      workItemId: ProgramWorkItemId;
      workItemGeneration: number;
    }
  | {
      kind: "output";
      outputSlotId: ProgramOutputSlotId;
      producerWorkItemId: ProgramWorkItemId;
      producerWorkItemGeneration: number;
    };

export interface VerificationSemanticBindingV1 {
  obligationId: VerificationObligationId;
  subject: VerificationSubjectV1;
}

export interface VerificationDefinition {
  obligationId: VerificationObligationId;
  predicate: VerificationPredicateV1;
  freshnessScope: VerificationFreshnessScopeV1;
}

export interface VerificationSatisfaction {
  subjectGeneration: number;
  evidenceRefIds: ProgramEvidenceRefId[];
}

export interface VerificationWaiver {
  subjectGeneration: number;
  actor: string;
  source: string;
  reason: string;
}

export interface VerificationObligation extends VerificationDefinition {
  subjectGeneration: number;
  satisfaction: VerificationSatisfaction | null;
  waiver: VerificationWaiver | null;
}

export interface ProgramOutputSlot {
  outputSlotId: ProgramOutputSlotId;
  productionStepId: ProgramArtifactProductionStepId;
}

export interface ProgramArtifactProductionStep extends HostOperationSpecReferenceV1 {
  productionStepId: ProgramArtifactProductionStepId;
  producerWorkItemId: ProgramWorkItemId;
  outputChannel: string;
}

export interface ProgramBlocker {
  blockerId: ProgramBlockerId;
  workItemId: ProgramWorkItemId | null;
  reason: string;
  state: "open" | "resolved";
}

export interface ProgramEvidenceReference {
  evidenceRefId: ProgramEvidenceRefId;
  workItemId: ProgramWorkItemId | null;
  verificationObligationId: VerificationObligationId | null;
  sourceOperationId: OperationId | null;
  artifactRef: string | null;
  /**
   * Canonical verification-generation provenance. The Host reducer stamps the
   * exact current generation when verification-bound evidence is admitted and
   * stamps null for work-only evidence. Optional only at the proposal/input
   * boundary; canonical ProgramState validation requires an explicit value.
   */
  subjectGeneration?: number | null;
}

export interface ProgramArtifactReference {
  artifactRef: string;
  outputSlotId: ProgramOutputSlotId | null;
  productionStepId: ProgramArtifactProductionStepId | null;
}

export interface ExecutionObservationIdentity {
  kind: "workspace-observation-v1";
  providerKind: string;
  workspaceIdentity: string;
  coverageDigest: string;
  stateDigest: string;
}

export interface ProgramAttemptExecutionBase {
  workspaceEffectGeneration: number;
  observation: ExecutionObservationIdentity;
}

export interface ProgramAttempt {
  programAttemptId: ProgramAttemptId;
  workItemId: ProgramWorkItemId;
  sessionId: SessionId;
  agentGeneration: number;
  initialExecutionBase: ProgramAttemptExecutionBase;
  expectedExecutionBase: ProgramAttemptExecutionBase;
}

export type ExecutionBaseMismatchKind =
  | "observation_mismatch"
  | "causal_generation_mismatch"
  | "causal_and_observation_mismatch";

export interface ExecutionBaseMismatchReceipt {
  receiptId: ExecutionBaseMismatchReceiptId;
  programStateId: ProgramStateId;
  expectedProgramRevision: number;
  acceptedWorkspaceEffectGeneration: number;
  acceptedObservationIdentity: ExecutionObservationIdentity;
  currentWorkspaceEffectGeneration: number;
  currentObservationIdentity: ExecutionObservationIdentity;
  kind: ExecutionBaseMismatchKind;
  verificationImpactComplete: boolean;
}

export interface ProgramState {
  programStateId: ProgramStateId;
  objective: string;
  lifecycle: ProgramLifecycle;
  revision: number;
  workItems: ProgramWorkItem[];
  blockers: ProgramBlocker[];
  verification: VerificationObligation[];
  outputSlots: ProgramOutputSlot[];
  productionSteps: ProgramArtifactProductionStep[];
  decisiveEvidence: ProgramEvidenceReference[];
  artifacts: ProgramArtifactReference[];
  attachedSessionIds: SessionId[];
  activeAttempt: ProgramAttempt | null;
  acceptedExecutionBase: ProgramAttemptExecutionBase | null;
  executionBaseMismatch: ExecutionBaseMismatchReceipt | null;
  executionBaseUnavailable: boolean;
  creationPolicyRequirements: Json[];
}

export interface ProgramCreationInput {
  programStateId: ProgramStateId;
  objective: string;
  sourceSessionId: SessionId;
  workItems: ProgramWorkDefinition[];
  verification: VerificationDefinition[];
  outputSlots: ProgramOutputSlot[];
  productionSteps: ProgramArtifactProductionStep[];
  creationPolicyRequirements?: Json[];
}

export interface EligibilityFacts {
  hasActiveAttachedExecutionEpisode: boolean;
  workspaceReservationAvailable: boolean;
  recoveryClear: boolean;
  writerBarriersClear: boolean;
}

export type VerificationImpact = "disjoint" | "overlap" | "unknown";

export interface CompletionOracleFacts {
  executionBaseCurrent: boolean;
  noOutstandingProgramOperations: boolean;
  noIndeterminateEffectsOrReconciliation: boolean;
  noOutstandingWriterBarrier: boolean;
  noRetryableDurableWork: boolean;
  artifactIntegrityCurrent: boolean;
}

export type CompletionBlockReason =
  | "program_not_active"
  | "required_work_incomplete"
  | "verification_not_current"
  | "unresolved_blocker"
  | "active_attempt"
  | "execution_base_mismatch"
  | "execution_base_unavailable"
  | "execution_base_not_current"
  | "outstanding_program_operation"
  | "indeterminate_effect_or_reconciliation"
  | "outstanding_writer_barrier"
  | "retryable_durable_work"
  | "artifact_integrity_unavailable"
  | "structural_invariant_violation";

export interface CompletionOracleResult {
  eligible: boolean;
  blockedBy: CompletionBlockReason[];
}
