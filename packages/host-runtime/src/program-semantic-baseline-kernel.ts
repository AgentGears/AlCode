import type { PersistedDomainEvent } from "@alcode/events";
import {
  PROGRAM_LIMITS,
  asProgramRevisionId,
  asProgramStateId,
  assertRevisionImpactWithinLimit,
  assertValidProgramSemanticStateV1,
  canonicalStringify,
  legacyLifecycleToSatisfactionState,
  type ProgramOutputSemanticRefV1,
  type ProgramSemanticStateV1,
  type ProgramSemanticWorkItemV1,
  type ProgramState,
  type ProgramWorkItem,
  type RevisionImpactV1,
  type WorkAuthorityEnvelopeV1,
} from "@alcode/program-state";
import { reduceOperationsFromEvents } from "@alcode/storage";
import { planningCanonicalDigest } from "./planning-read.ts";

export const PROGRAM_SEMANTIC_BASELINE_DRAFT_PROFILE = "program-semantic-baseline-draft-v1" as const;

export interface ProgramLegacyBaselineAuthorityDimensionsV1 {
  allowedRepositoryRoots: readonly string[];
  allowedEffectClasses: readonly string[];
  allowedExternalSystems: readonly string[];
  capabilityCeiling: readonly string[];
  maximumTopologyExpansion: number;
  mandatoryVerificationIds: readonly string[];
  forbiddenChangeKinds: readonly string[];
}

/** Host-owned reconstruction seam; never populated from Agent/Application text. */
export interface ProgramLegacyBaselineAuthoritySourceV1 {
  forWorkItem(input: {
    programState: ProgramState;
    workItem: ProgramWorkItem;
  }): Promise<ProgramLegacyBaselineAuthorityDimensionsV1> | ProgramLegacyBaselineAuthorityDimensionsV1;
}

export interface ProgramSemanticBaselineCutV1 {
  kind: "program.semantic_baseline.adopted.v1";
  fromProgramStateRevision: number;
  toProgramStateRevision: number;
  semanticState: ProgramSemanticStateV1;
  revisionImpact: RevisionImpactV1;
}

export interface ProgramSemanticBaselineDraftV1 {
  profile: typeof PROGRAM_SEMANTIC_BASELINE_DRAFT_PROFILE;
  draftId: string;
  sourceSessionId: string;
  programStateId: string;
  fromProgramStateRevision: number;
  initialProgramRevisionId: string;
  admissionEventId: string;
  cut: ProgramSemanticBaselineCutV1;
  draftDigest: string;
}

export interface ProgramSemanticBaselineSealCommandV1 {
  sourceSessionId: string;
  programStateId: string;
  expectedProgramStateRevision: number;
}

export interface ProgramSemanticBaselineAcceptCommandV1 {
  commandId: string;
  clientId: string;
  sourceSessionId: string;
  programStateId: string;
  draftId: string;
  draftDigest: string;
}

export interface ProgramSemanticBaselineAcceptedResultV1 {
  status: "adopted" | "existing";
  programStateId: string;
  programStateRevision: number;
  programRevisionId: string;
  draftId: string;
  draftDigest: string;
  cut?: ProgramSemanticBaselineCutV1;
}

export type ProgramSemanticBaselineBlockReasonV1 =
  | "program_not_active"
  | "active_attempt"
  | "outstanding_program_operation"
  | "indeterminate_effect_or_reconciliation"
  | "writer_barrier"
  | "recovery_blocked"
  | "execution_base_mismatch"
  | "execution_base_unavailable";

export class ProgramSemanticBaselineControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramSemanticBaselineControlError";
  }
}

export class ProgramSemanticBaselineStaleError extends ProgramSemanticBaselineControlError {
  constructor(message: string) {
    super(message);
    this.name = "ProgramSemanticBaselineStaleError";
  }
}

export class ProgramSemanticBaselineBlockedError extends ProgramSemanticBaselineControlError {
  constructor(public readonly blockedBy: ProgramSemanticBaselineBlockReasonV1[]) {
    super(`Semantic baseline adoption is blocked: ${blockedBy.join(", ")}`);
    this.name = "ProgramSemanticBaselineBlockedError";
  }
}

const encoder = new TextEncoder();

export function baselineRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function baselineRequireNonEmpty(label: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProgramSemanticBaselineControlError(`${label} must be a non-empty string`);
  }
}

export function baselineRequirePositive(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ProgramSemanticBaselineControlError(`${label} must be a positive safe integer`);
  }
}

export function baselineSameCanonical(left: unknown, right: unknown): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, "en"));
}

function repositoryRootContains(root: string, path: string): boolean {
  return root === "." || path === root || path.startsWith(`${root}/`);
}

function programOperationRecords(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
) {
  const owned = new Set<string>();
  for (const event of events) {
    if (event.type !== "operation.requested" || String(event.programStateId ?? "") !== programStateId) continue;
    const operationId = String(baselineRecord(event.payload).operationId ?? event.operationId ?? "");
    if (operationId) owned.add(operationId);
  }
  return reduceOperationsFromEvents(events).filter((operation) => owned.has(operation.operationId));
}

function hasWriterBarrier(events: readonly PersistedDomainEvent<string, unknown>[]): boolean {
  const writers = new Map<string, { legacy: boolean }>();
  for (const event of events) {
    if (event.type === "operation.requested") {
      const payload = baselineRecord(event.payload);
      const operationId = String(payload.operationId ?? event.operationId ?? "");
      const access = payload.workspaceAccessClass;
      const legacy = access === undefined && payload.isReadOnly === false;
      if (operationId && access === "may_write") writers.set(operationId, { legacy: false });
      else if (operationId && legacy) writers.set(operationId, { legacy: true });
    } else if (event.type === "operation.completed") {
      const operationId = String(baselineRecord(event.payload).operationId ?? event.operationId ?? "");
      if (operationId && writers.get(operationId)?.legacy) writers.delete(operationId);
    } else if (event.type === "operation.mutation_quiesced") {
      const operationId = String(baselineRecord(event.payload).operationId ?? event.operationId ?? "");
      if (operationId) writers.delete(operationId);
    }
  }
  return writers.size > 0;
}

export function evaluateProgramSemanticBaselineQuiescenceV1(
  state: ProgramState,
  events: readonly PersistedDomainEvent<string, unknown>[],
  recoveryClear: boolean,
): ProgramSemanticBaselineBlockReasonV1[] {
  const blockedBy: ProgramSemanticBaselineBlockReasonV1[] = [];
  if (state.lifecycle !== "active") blockedBy.push("program_not_active");
  if (state.activeAttempt !== null) blockedBy.push("active_attempt");
  const operations = programOperationRecords(events, String(state.programStateId));
  if (operations.some((operation) => operation.lifecycleState !== "terminal")) {
    blockedBy.push("outstanding_program_operation");
  }
  if (operations.some((operation) => operation.effectStatus === "indeterminate"
    || operation.reconciliationStatus === "pending"
    || operation.reconciliationStatus === "unresolved")) {
    blockedBy.push("indeterminate_effect_or_reconciliation");
  }
  if (hasWriterBarrier(events)) blockedBy.push("writer_barrier");
  if (!recoveryClear) blockedBy.push("recovery_blocked");
  if (state.executionBaseMismatch !== null) blockedBy.push("execution_base_mismatch");
  if (state.executionBaseUnavailable) blockedBy.push("execution_base_unavailable");
  return blockedBy;
}

function outputRefs(state: ProgramSemanticStateV1): ProgramOutputSemanticRefV1[] {
  const work = new Map(state.workItems.map((item) => [String(item.workItemId), item]));
  const steps = new Map(state.productionSteps.map((item) => [String(item.productionStepId), item]));
  return [...state.outputSlots]
    .sort((a, b) => String(a.outputSlotId).localeCompare(String(b.outputSlotId), "en"))
    .map((slot) => {
      const step = steps.get(String(slot.productionStepId));
      const producer = step === undefined ? undefined : work.get(String(step.producerWorkItemId));
      if (step === undefined || producer === undefined) {
        throw new ProgramSemanticBaselineControlError("Baseline output has no current producer");
      }
      return {
        outputSlotId: slot.outputSlotId,
        productionStepId: String(step.productionStepId),
        producerWorkItemId: producer.workItemId,
        producerWorkItemGeneration: producer.workItemGeneration,
      };
    });
}

export function programSemanticBaselineIdentityImpactV1(state: ProgramSemanticStateV1): RevisionImpactV1 {
  const revisionId = state.currentRevision.programRevisionId;
  const bindings = new Map(state.verificationBindings.map((item) => [String(item.obligationId), item]));
  const impact: RevisionImpactV1 = {
    fromProgramRevisionId: revisionId,
    toProgramRevisionId: revisionId,
    unchangedWorkItems: [...state.workItems]
      .sort((a, b) => String(a.workItemId).localeCompare(String(b.workItemId), "en"))
      .map((work) => ({ workItemId: work.workItemId, generation: work.workItemGeneration })),
    modifiedWorkItems: [],
    addedWorkItems: [],
    supersededWorkItems: [],
    withdrawnWorkItems: [],
    retainedAttempts: [],
    invalidatedAttempts: [],
    retainedVerification: [...state.verification]
      .sort((a, b) => String(a.obligationId).localeCompare(String(b.obligationId), "en"))
      .map((obligation) => {
        const binding = bindings.get(String(obligation.obligationId));
        if (binding === undefined) throw new ProgramSemanticBaselineControlError("Baseline verification lacks subject binding");
        return {
          obligationId: obligation.obligationId,
          subjectGeneration: obligation.subjectGeneration,
          subject: structuredClone(binding.subject),
        };
      }),
    staleVerification: [],
    addedVerification: [],
    reboundVerification: [],
    retiredVerification: [],
    retainedOutputs: outputRefs(state),
    addedOutputs: [],
    modifiedOutputs: [],
    retiredOutputs: [],
  };
  assertRevisionImpactWithinLimit(impact);
  return impact;
}

export async function buildProgramSemanticBaselineCutV1(
  state: ProgramState,
  authority: ProgramLegacyBaselineAuthoritySourceV1,
  initialProgramRevisionId: string,
  admissionEventId: string,
): Promise<ProgramSemanticBaselineCutV1> {
  const verification = new Map(state.verification.map((item) => [String(item.obligationId), item]));
  const workItems: ProgramSemanticWorkItemV1[] = [];
  for (const work of [...state.workItems].sort((a, b) => String(a.workItemId).localeCompare(String(b.workItemId), "en"))) {
    const dimensions = await authority.forWorkItem({
      programState: structuredClone(state),
      workItem: structuredClone(work),
    });
    if (!Number.isSafeInteger(dimensions.maximumTopologyExpansion)
      || dimensions.maximumTopologyExpansion < 0
      || dimensions.maximumTopologyExpansion > PROGRAM_LIMITS.childrenPerDecomposition) {
      throw new ProgramSemanticBaselineControlError("Invalid Host maximumTopologyExpansion for semantic baseline");
    }
    const envelope: WorkAuthorityEnvelopeV1 = {
      objectiveBoundaryRef: {
        programStateId: state.programStateId,
        rootProgramRevisionId: asProgramRevisionId(initialProgramRevisionId),
        anchorWorkItemId: work.workItemId,
      },
      allowedRepositoryRoots: sortedUnique(dimensions.allowedRepositoryRoots),
      allowedEffectClasses: sortedUnique(dimensions.allowedEffectClasses),
      allowedExternalSystems: sortedUnique(dimensions.allowedExternalSystems),
      capabilityCeiling: sortedUnique(dimensions.capabilityCeiling),
      maximumTopologyExpansion: dimensions.maximumTopologyExpansion,
      mandatoryVerificationIds: sortedUnique(dimensions.mandatoryVerificationIds).map((id) => {
        const obligation = verification.get(id);
        if (obligation === undefined) {
          throw new ProgramSemanticBaselineControlError(`Unknown mandatory verification ${id}`);
        }
        return obligation.obligationId;
      }),
      forbiddenChangeKinds: sortedUnique(dimensions.forbiddenChangeKinds),
    };
    for (const path of work.affectedPaths) {
      if (!envelope.allowedRepositoryRoots.some((root) => repositoryRootContains(root, path))) {
        throw new ProgramSemanticBaselineControlError(
          `Baseline authority does not contain legacy affected path ${path}`,
        );
      }
    }
    workItems.push({
      workItemId: work.workItemId,
      creationOrder: work.creationOrder,
      description: work.description,
      dependencyIds: structuredClone(work.dependencyIds),
      affectedPaths: structuredClone(work.affectedPaths),
      workItemGeneration: 1,
      requirementState: "required",
      topologyState: "leaf",
      satisfactionState: legacyLifecycleToSatisfactionState(work.lifecycle),
      parentWorkItemId: null,
      authorityEnvelope: envelope,
    });
  }

  const semanticState: ProgramSemanticStateV1 = {
    programStateId: state.programStateId,
    currentRevision: {
      programRevisionId: asProgramRevisionId(initialProgramRevisionId),
      parentProgramRevisionId: null,
      ordinal: 1,
      changeClass: "initial",
      acceptedAtStateRevision: state.revision + 1,
      admissionEventId,
      sourceDraftId: null,
      sourceDraftDigest: null,
    },
    workItems,
    verification: [...state.verification]
      .sort((a, b) => String(a.obligationId).localeCompare(String(b.obligationId), "en"))
      .map((item) => structuredClone(item)),
    verificationBindings: [...state.verification]
      .sort((a, b) => String(a.obligationId).localeCompare(String(b.obligationId), "en"))
      .map((item) => ({ obligationId: item.obligationId, subject: { kind: "program" as const } })),
    outputSlots: [...state.outputSlots]
      .sort((a, b) => String(a.outputSlotId).localeCompare(String(b.outputSlotId), "en"))
      .map((item) => structuredClone(item)),
    productionSteps: [...state.productionSteps]
      .sort((a, b) => String(a.productionStepId).localeCompare(String(b.productionStepId), "en"))
      .map((item) => structuredClone(item)),
  };
  assertValidProgramSemanticStateV1(semanticState);
  return {
    kind: "program.semantic_baseline.adopted.v1",
    fromProgramStateRevision: state.revision,
    toProgramStateRevision: state.revision + 1,
    semanticState,
    revisionImpact: programSemanticBaselineIdentityImpactV1(semanticState),
  };
}

export function assertMeaningPreservingProgramSemanticBaselineV1(
  state: ProgramState,
  cut: ProgramSemanticBaselineCutV1,
): void {
  if (cut.fromProgramStateRevision !== state.revision || cut.toProgramStateRevision !== state.revision + 1) {
    throw new ProgramSemanticBaselineStaleError("Baseline cut does not target the exact ProgramState revision");
  }
  assertValidProgramSemanticStateV1(cut.semanticState);
  if (String(cut.semanticState.programStateId) !== String(state.programStateId)
    || cut.semanticState.currentRevision.acceptedAtStateRevision !== cut.toProgramStateRevision) {
    throw new ProgramSemanticBaselineControlError("Baseline semantic identity is inconsistent");
  }
  const current = new Map(cut.semanticState.workItems.map((work) => [String(work.workItemId), work]));
  if (current.size !== state.workItems.length) {
    throw new ProgramSemanticBaselineControlError("Baseline must preserve every legacy WorkItem");
  }
  for (const legacy of state.workItems) {
    const work = current.get(String(legacy.workItemId));
    if (work === undefined) throw new ProgramSemanticBaselineControlError("Baseline dropped a legacy WorkItem");
    if (!baselineSameCanonical({
      workItemId: work.workItemId,
      creationOrder: work.creationOrder,
      description: work.description,
      dependencyIds: work.dependencyIds,
      affectedPaths: work.affectedPaths,
    }, {
      workItemId: legacy.workItemId,
      creationOrder: legacy.creationOrder,
      description: legacy.description,
      dependencyIds: legacy.dependencyIds,
      affectedPaths: legacy.affectedPaths,
    }) || work.workItemGeneration !== 1 || work.requirementState !== "required"
      || work.topologyState !== "leaf" || work.parentWorkItemId !== null
      || work.satisfactionState !== legacyLifecycleToSatisfactionState(legacy.lifecycle)) {
      throw new ProgramSemanticBaselineControlError(`Baseline changes legacy WorkItem ${String(legacy.workItemId)}`);
    }
  }
  const sortedVerification = [...state.verification]
    .sort((a, b) => String(a.obligationId).localeCompare(String(b.obligationId), "en"));
  if (!baselineSameCanonical(cut.semanticState.verification, sortedVerification)
    || !cut.semanticState.verificationBindings.every((binding) => binding.subject.kind === "program")) {
    throw new ProgramSemanticBaselineControlError("Baseline changed or narrowed legacy verification");
  }
  const sortedOutputs = [...state.outputSlots]
    .sort((a, b) => String(a.outputSlotId).localeCompare(String(b.outputSlotId), "en"));
  const sortedSteps = [...state.productionSteps]
    .sort((a, b) => String(a.productionStepId).localeCompare(String(b.productionStepId), "en"));
  if (!baselineSameCanonical(cut.semanticState.outputSlots, sortedOutputs)
    || !baselineSameCanonical(cut.semanticState.productionSteps, sortedSteps)) {
    throw new ProgramSemanticBaselineControlError("Baseline changed legacy output/production semantics");
  }
  if (!baselineSameCanonical(cut.revisionImpact, programSemanticBaselineIdentityImpactV1(cut.semanticState))) {
    throw new ProgramSemanticBaselineControlError("Baseline RevisionImpact is not identity/no-op");
  }
}

export function assertProgramSemanticBaselineDraftV1(
  draft: ProgramSemanticBaselineDraftV1,
  state?: ProgramState,
): void {
  if (draft.profile !== PROGRAM_SEMANTIC_BASELINE_DRAFT_PROFILE) {
    throw new ProgramSemanticBaselineControlError("Unsupported semantic baseline draft profile");
  }
  baselineRequireNonEmpty("draftId", draft.draftId);
  baselineRequireNonEmpty("sourceSessionId", draft.sourceSessionId);
  baselineRequireNonEmpty("programStateId", draft.programStateId);
  asProgramStateId(draft.programStateId);
  baselineRequirePositive("fromProgramStateRevision", draft.fromProgramStateRevision);
  baselineRequireNonEmpty("initialProgramRevisionId", draft.initialProgramRevisionId);
  baselineRequireNonEmpty("admissionEventId", draft.admissionEventId);
  if (draft.cut.fromProgramStateRevision !== draft.fromProgramStateRevision
    || String(draft.cut.semanticState.currentRevision.programRevisionId) !== draft.initialProgramRevisionId
    || draft.cut.semanticState.currentRevision.admissionEventId !== draft.admissionEventId) {
    throw new ProgramSemanticBaselineControlError("Baseline draft identity does not match its cut");
  }
  const body: Omit<ProgramSemanticBaselineDraftV1, "draftDigest"> = {
    profile: draft.profile,
    draftId: draft.draftId,
    sourceSessionId: draft.sourceSessionId,
    programStateId: draft.programStateId,
    fromProgramStateRevision: draft.fromProgramStateRevision,
    initialProgramRevisionId: draft.initialProgramRevisionId,
    admissionEventId: draft.admissionEventId,
    cut: draft.cut,
  };
  if (draft.draftDigest !== planningCanonicalDigest(body)) {
    throw new ProgramSemanticBaselineControlError("Baseline draft digest mismatch");
  }
  if (encoder.encode(canonicalStringify(draft)).byteLength > PROGRAM_LIMITS.sealedPendingSemanticDraftBytes) {
    throw new ProgramSemanticBaselineControlError("Sealed semantic baseline draft exceeds the A1 bound");
  }
  if (state !== undefined) assertMeaningPreservingProgramSemanticBaselineV1(state, draft.cut);
}
