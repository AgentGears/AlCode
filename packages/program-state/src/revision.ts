import { canonicalStringify } from "./canonical.ts";
import { PROGRAM_LIMITS } from "./limits.ts";
import {
  assertRevisionImpactWithinLimit,
  assertSemanticRevisionProposalWithinLimit,
  assertValidProgramRevision,
  assertValidProgramSemanticWorkGraph,
  assertValidVerificationSemanticBindingsV1,
  isProgramSemanticRequirementComplete,
  workAuthorityEnvelopeIsEqualOrNarrower,
} from "./semantic.ts";
import { ProgramInvariantError } from "./validation-core.ts";
import type {
  ProgramArtifactProductionStep,
  ProgramAttemptId,
  ProgramChangeClass,
  ProgramOutputSlot,
  ProgramOutputSlotId,
  ProgramRevision,
  ProgramRevisionId,
  ProgramSemanticWorkItemV1,
  ProgramStateId,
  ProgramWorkItemId,
  VerificationDefinition,
  VerificationObligation,
  VerificationObligationId,
  VerificationSemanticBindingV1,
  VerificationSubjectV1,
  WorkAuthorityEnvelopeV1,
  WorkItemIdentityDisposition,
} from "./types.ts";

export interface WorkItemIdentityDecisionV1 {
  workItemId: ProgramWorkItemId;
  fromGeneration: number;
  disposition: WorkItemIdentityDisposition;
  successorWorkItemId: ProgramWorkItemId | null;
}

export interface WorkItemGenerationRefV1 {
  workItemId: ProgramWorkItemId;
  generation: number;
}

export interface WorkItemGenerationChangeV1 {
  workItemId: ProgramWorkItemId;
  fromGeneration: number;
  toGeneration: number;
  disposition: WorkItemIdentityDisposition;
  successorWorkItemId: ProgramWorkItemId | null;
}

export interface VerificationGenerationRefV1 {
  obligationId: VerificationObligationId;
  subjectGeneration: number;
  subject: VerificationSubjectV1;
}

export interface VerificationGenerationChangeV1 {
  obligationId: VerificationObligationId;
  fromSubjectGeneration: number;
  toSubjectGeneration: number;
  fromSubject: VerificationSubjectV1;
  toSubject: VerificationSubjectV1;
}

export interface ProgramOutputSemanticRefV1 {
  outputSlotId: ProgramOutputSlotId;
  productionStepId: string;
  producerWorkItemId: ProgramWorkItemId;
  producerWorkItemGeneration: number;
}

export interface ProgramOutputSemanticChangeV1 {
  outputSlotId: ProgramOutputSlotId;
  from: ProgramOutputSemanticRefV1;
  to: ProgramOutputSemanticRefV1;
}

export interface RevisionImpactV1 {
  fromProgramRevisionId: ProgramRevisionId;
  toProgramRevisionId: ProgramRevisionId;
  unchangedWorkItems: WorkItemGenerationRefV1[];
  modifiedWorkItems: WorkItemGenerationChangeV1[];
  addedWorkItems: WorkItemGenerationRefV1[];
  supersededWorkItems: WorkItemGenerationChangeV1[];
  withdrawnWorkItems: WorkItemGenerationChangeV1[];
  retainedAttempts: ProgramAttemptId[];
  invalidatedAttempts: ProgramAttemptId[];
  retainedVerification: VerificationGenerationRefV1[];
  staleVerification: VerificationGenerationChangeV1[];
  addedVerification: VerificationGenerationRefV1[];
  reboundVerification: VerificationGenerationChangeV1[];
  retiredVerification: VerificationGenerationRefV1[];
  retainedOutputs: ProgramOutputSemanticRefV1[];
  addedOutputs: ProgramOutputSemanticRefV1[];
  modifiedOutputs: ProgramOutputSemanticChangeV1[];
  retiredOutputs: ProgramOutputSemanticRefV1[];
}

export interface ProgramSemanticStateV1 {
  programStateId: ProgramStateId;
  currentRevision: ProgramRevision;
  workItems: ProgramSemanticWorkItemV1[];
  verification: VerificationObligation[];
  verificationBindings: VerificationSemanticBindingV1[];
  outputSlots: ProgramOutputSlot[];
  productionSteps: ProgramArtifactProductionStep[];
}

export interface ProgramAttemptSemanticDependencyV1 {
  workItemId: ProgramWorkItemId;
  workItemGeneration: number;
  required: true;
  satisfiedOrDischargedAtIssue: true;
}

/** Semantic assumptions only; this is deliberately not V2 execution authority. */
export interface ProgramAttemptSemanticAssumptionsV1 {
  programAttemptId: ProgramAttemptId;
  workItemId: ProgramWorkItemId;
  workItemGeneration: number;
  directDependencies: ProgramAttemptSemanticDependencyV1[];
  workAuthorityEnvelope: WorkAuthorityEnvelopeV1;
}

export interface ProgramSemanticRevisionEditV1 {
  workItems: ProgramSemanticWorkItemV1[];
  identityDecisions: WorkItemIdentityDecisionV1[];
  verification: VerificationDefinition[];
  verificationBindings: VerificationSemanticBindingV1[];
  outputSlots: ProgramOutputSlot[];
  productionSteps: ProgramArtifactProductionStep[];
}

export interface ProgramSemanticRevisionTransactionV1 {
  currentProgramStateRevision: number;
  nextRevision: ProgramRevision;
  edit: ProgramSemanticRevisionEditV1;
  activeAttempt: ProgramAttemptSemanticAssumptionsV1 | null;
}

export interface ProgramSemanticRevisionCutV1 {
  kind: "program.semantic_revision.admitted.v1";
  fromProgramStateRevision: number;
  toProgramStateRevision: number;
  fromProgramRevisionId: ProgramRevisionId;
  nextSemanticState: ProgramSemanticStateV1;
  identityDecisions: WorkItemIdentityDecisionV1[];
  attemptAssumptions: ProgramAttemptSemanticAssumptionsV1 | null;
  revisionImpact: RevisionImpactV1;
}

export interface AppliedProgramSemanticRevisionV1 {
  programStateRevision: number;
  semanticState: ProgramSemanticStateV1;
}

function fail(message: string): never {
  throw new ProgramInvariantError("structural_invariant", message);
}

function failValue(message: string): never {
  throw new ProgramInvariantError("invalid_value", message);
}

function failLimit(message: string): never {
  throw new ProgramInvariantError("limit_exceeded", message);
}

function positive(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) failValue(`${label} must be a positive safe integer`);
}

function eq(a: unknown, b: unknown): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sorted<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((a, b) => cmp(key(a), key(b)));
}

function unique<T>(label: string, values: readonly T[], key: (value: T) => string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const id = key(value);
    if (id.length === 0) failValue(`${label} id must be non-empty`);
    if (seen.has(id)) failValue(`${label} contains duplicate id ${id}`);
    seen.add(id);
  }
}

function workMap(values: readonly ProgramSemanticWorkItemV1[]): Map<string, ProgramSemanticWorkItemV1> {
  return new Map(values.map((value) => [String(value.workItemId), value]));
}

function bindingMap(values: readonly VerificationSemanticBindingV1[]): Map<string, VerificationSemanticBindingV1> {
  return new Map(values.map((value) => [String(value.obligationId), value]));
}

function definitionOf(value: VerificationObligation): VerificationDefinition {
  return { obligationId: value.obligationId, predicate: value.predicate, freshnessScope: value.freshnessScope };
}

function normalizedState(state: ProgramSemanticStateV1): ProgramSemanticStateV1 {
  return {
    ...state,
    workItems: sorted(state.workItems, (work) => String(work.workItemId)),
    verification: sorted(state.verification, (obligation) => String(obligation.obligationId)),
    verificationBindings: sorted(state.verificationBindings, (binding) => String(binding.obligationId)),
    outputSlots: sorted(state.outputSlots, (slot) => String(slot.outputSlotId)),
    productionSteps: sorted(state.productionSteps, (step) => String(step.productionStepId)),
  };
}

function normalizedEdit(edit: ProgramSemanticRevisionEditV1): ProgramSemanticRevisionEditV1 {
  return {
    workItems: sorted(edit.workItems, (work) => String(work.workItemId)),
    identityDecisions: sorted(edit.identityDecisions, (decision) => String(decision.workItemId)),
    verification: sorted(edit.verification, (definition) => String(definition.obligationId)),
    verificationBindings: sorted(edit.verificationBindings, (binding) => String(binding.obligationId)),
    outputSlots: sorted(edit.outputSlots, (slot) => String(slot.outputSlotId)),
    productionSteps: sorted(edit.productionSteps, (step) => String(step.productionStepId)),
  };
}

function outputRef(
  slot: ProgramOutputSlot,
  workItems: readonly ProgramSemanticWorkItemV1[],
  productionSteps: readonly ProgramArtifactProductionStep[],
): ProgramOutputSemanticRefV1 {
  const step = productionSteps.find((candidate) => candidate.productionStepId === slot.productionStepId);
  if (step === undefined) fail(`output ${String(slot.outputSlotId)} references unknown production step`);
  const producer = workItems.find((work) => work.workItemId === step.producerWorkItemId);
  if (producer === undefined || producer.requirementState !== "required") {
    fail(`output ${String(slot.outputSlotId)} has no current required producer`);
  }
  return {
    outputSlotId: slot.outputSlotId,
    productionStepId: String(step.productionStepId),
    producerWorkItemId: producer.workItemId,
    producerWorkItemGeneration: producer.workItemGeneration,
  };
}

function outputSemanticObject(
  slot: ProgramOutputSlot,
  workItems: readonly ProgramSemanticWorkItemV1[],
  productionSteps: readonly ProgramArtifactProductionStep[],
): { ref: ProgramOutputSemanticRefV1; step: ProgramArtifactProductionStep } {
  const step = productionSteps.find((candidate) => candidate.productionStepId === slot.productionStepId);
  if (step === undefined) fail(`output ${String(slot.outputSlotId)} references unknown production step`);
  return { ref: outputRef(slot, workItems, productionSteps), step };
}

/** Validate the complete current semantic snapshot owned by the pure A1 kernel. */
export function assertValidProgramSemanticStateV1(state: ProgramSemanticStateV1): void {
  assertValidProgramRevision(state.currentRevision);
  assertValidProgramSemanticWorkGraph(state.workItems);
  for (const work of state.workItems) {
    if (work.authorityEnvelope.objectiveBoundaryRef.programStateId !== state.programStateId) {
      fail(`work ${String(work.workItemId)} authority belongs to another ProgramState`);
    }
  }

  unique("verification", state.verification, (value) => String(value.obligationId));
  if (state.verification.length > PROGRAM_LIMITS.verificationObligations) {
    failLimit(`semantic verification exceeds ${PROGRAM_LIMITS.verificationObligations}`);
  }
  for (const obligation of state.verification) {
    positive(`verification ${String(obligation.obligationId)} subjectGeneration`, obligation.subjectGeneration);
    if (obligation.satisfaction !== null && obligation.satisfaction.subjectGeneration !== obligation.subjectGeneration) {
      fail(`verification ${String(obligation.obligationId)} satisfaction is stale`);
    }
    if (obligation.waiver !== null && obligation.waiver.subjectGeneration !== obligation.subjectGeneration) {
      fail(`verification ${String(obligation.obligationId)} waiver is stale`);
    }
  }
  const obligationIds = new Set(state.verification.map((value) => String(value.obligationId)));
  assertValidVerificationSemanticBindingsV1(
    state.verificationBindings,
    obligationIds,
    state.workItems,
    state.outputSlots,
    state.productionSteps,
  );

  unique("output slots", state.outputSlots, (value) => String(value.outputSlotId));
  unique("production steps", state.productionSteps, (value) => String(value.productionStepId));
  if (state.outputSlots.length > PROGRAM_LIMITS.outputSlots) failLimit(`output slots exceed ${PROGRAM_LIMITS.outputSlots}`);
  if (state.productionSteps.length > PROGRAM_LIMITS.productionSteps) {
    failLimit(`production steps exceed ${PROGRAM_LIMITS.productionSteps}`);
  }
  const stepIds = new Set(state.productionSteps.map((value) => String(value.productionStepId)));
  const currentWork = workMap(state.workItems);
  for (const step of state.productionSteps) {
    const producer = currentWork.get(String(step.producerWorkItemId));
    if (producer === undefined || producer.requirementState !== "required") {
      fail(`production step ${String(step.productionStepId)} references non-current producer`);
    }
  }
  for (const slot of state.outputSlots) {
    if (!stepIds.has(String(slot.productionStepId))) {
      fail(`output slot ${String(slot.outputSlotId)} references unknown production step`);
    }
    outputRef(slot, state.workItems, state.productionSteps);
  }
  canonicalStringify(state);
}

function sameExceptGenerationAndRequirement(
  previous: ProgramSemanticWorkItemV1,
  next: ProgramSemanticWorkItemV1,
): boolean {
  const a = { ...previous, workItemGeneration: 1, requirementState: "required" as const };
  const b = { ...next, workItemGeneration: 1, requirementState: "required" as const };
  return eq(a, b);
}

function assertIdentityDecisions(
  previousItems: readonly ProgramSemanticWorkItemV1[],
  nextItems: readonly ProgramSemanticWorkItemV1[],
  decisions: readonly WorkItemIdentityDecisionV1[],
): void {
  unique("identity decisions", decisions, (decision) => String(decision.workItemId));
  const previous = workMap(previousItems);
  const next = workMap(nextItems);
  const byDecision = new Map(decisions.map((decision) => [String(decision.workItemId), decision]));

  for (const old of previousItems) {
    const id = String(old.workItemId);
    const current = next.get(id);
    if (current === undefined) fail(`semantic revision cannot erase historical WorkItem ${id}`);
    if (old.requirementState !== "required") {
      if (!eq(old, current)) fail(`historical non-required WorkItem ${id} is immutable`);
      if (byDecision.has(id)) fail(`historical non-required WorkItem ${id} cannot receive an identity decision`);
      continue;
    }
    const decision = byDecision.get(id);
    if (decision === undefined) fail(`required WorkItem ${id} is missing an explicit identity disposition`);
    if (decision.fromGeneration !== old.workItemGeneration) fail(`identity decision ${id} targets stale generation`);

    switch (decision.disposition) {
      case "unchanged":
        if (decision.successorWorkItemId !== null || !eq(old, current)) {
          fail(`unchanged identity decision for ${id} does not preserve exact work state`);
        }
        break;
      case "preserve_identity_and_advance_generation":
        if (decision.successorWorkItemId !== null || current.requirementState !== "required") {
          fail(`preserved WorkItem ${id} must remain required without successor`);
        }
        if (current.workItemGeneration !== old.workItemGeneration + 1 || eq(old, current)) {
          fail(`preserved WorkItem ${id} must advance exactly one generation with a semantic change`);
        }
        break;
      case "withdraw_identity":
        if (
          decision.successorWorkItemId !== null
          || current.requirementState !== "withdrawn"
          || current.workItemGeneration !== old.workItemGeneration + 1
          || !sameExceptGenerationAndRequirement(old, current)
        ) fail(`withdrawn WorkItem ${id} may only advance generation and requirement state`);
        break;
      case "new_identity_supersedes_old": {
        if (
          decision.successorWorkItemId === null
          || current.requirementState !== "superseded"
          || current.workItemGeneration !== old.workItemGeneration + 1
          || !sameExceptGenerationAndRequirement(old, current)
        ) fail(`superseded WorkItem ${id} has an invalid old-identity transition`);
        const successorId = String(decision.successorWorkItemId);
        if (previous.has(successorId)) fail(`successor ${successorId} must be a new WorkItem identity`);
        const successor = next.get(successorId);
        if (successor === undefined || successor.requirementState !== "required" || successor.workItemGeneration !== 1) {
          fail(`successor ${successorId} must be new required generation-1 work`);
        }
        break;
      }
    }
  }

  for (const decision of decisions) {
    if (!previous.has(String(decision.workItemId))) {
      fail(`identity decision references unknown previous WorkItem ${String(decision.workItemId)}`);
    }
  }
  for (const item of nextItems) {
    if (!previous.has(String(item.workItemId)) && item.workItemGeneration !== 1) {
      fail(`new WorkItem ${String(item.workItemId)} must begin at generation 1`);
    }
  }
}

function outputsChanged(previous: ProgramSemanticStateV1, next: ProgramSemanticStateV1): Set<string> {
  const changed = new Set<string>();
  const oldSlots = new Map(previous.outputSlots.map((slot) => [String(slot.outputSlotId), slot]));
  const newSlots = new Map(next.outputSlots.map((slot) => [String(slot.outputSlotId), slot]));
  for (const [id, oldSlot] of oldSlots) {
    const newSlot = newSlots.get(id);
    if (newSlot === undefined) {
      changed.add(id);
      continue;
    }
    if (!eq(outputSemanticObject(oldSlot, previous.workItems, previous.productionSteps), outputSemanticObject(newSlot, next.workItems, next.productionSteps))) {
      changed.add(id);
    }
  }
  for (const id of newSlots.keys()) if (!oldSlots.has(id)) changed.add(id);
  return changed;
}

function deriveNextVerification(
  previous: ProgramSemanticStateV1,
  definitions: readonly VerificationDefinition[],
  bindings: readonly VerificationSemanticBindingV1[],
  nextWork: readonly ProgramSemanticWorkItemV1[],
  outputSlots: readonly ProgramOutputSlot[],
  productionSteps: readonly ProgramArtifactProductionStep[],
): VerificationObligation[] {
  unique("verification definitions", definitions, (value) => String(value.obligationId));
  unique("verification bindings", bindings, (value) => String(value.obligationId));
  const previousById = new Map(previous.verification.map((value) => [String(value.obligationId), value]));
  const previousBindings = bindingMap(previous.verificationBindings);
  const nextBindingMap = bindingMap(bindings);

  const provisional: ProgramSemanticStateV1 = normalizedState({
    programStateId: previous.programStateId,
    currentRevision: previous.currentRevision,
    workItems: [...nextWork],
    verification: [],
    verificationBindings: [...bindings],
    outputSlots: [...outputSlots],
    productionSteps: [...productionSteps],
  });
  const changedOutputs = outputsChanged(previous, provisional);

  return definitions.map((definition) => {
    const id = String(definition.obligationId);
    const old = previousById.get(id);
    const nextBinding = nextBindingMap.get(id);
    if (nextBinding === undefined) fail(`verification ${id} has no semantic binding`);
    if (old === undefined) {
      return { ...definition, subjectGeneration: 1, satisfaction: null, waiver: null };
    }
    const oldBinding = previousBindings.get(id);
    if (oldBinding === undefined) fail(`previous verification ${id} has no semantic binding`);
    const subjectChanged = !eq(oldBinding.subject, nextBinding.subject);
    const definitionChanged = !eq(definitionOf(old), definition);
    const programWide = nextBinding.subject.kind === "program";
    const outputChanged = nextBinding.subject.kind === "output" && changedOutputs.has(String(nextBinding.subject.outputSlotId));
    if (subjectChanged || definitionChanged || programWide || outputChanged) {
      return { ...definition, subjectGeneration: old.subjectGeneration + 1, satisfaction: null, waiver: null };
    }
    return old;
  });
}

function buildNextState(
  previous: ProgramSemanticStateV1,
  revision: ProgramRevision,
  editInput: ProgramSemanticRevisionEditV1,
): ProgramSemanticStateV1 {
  const edit = normalizedEdit(editInput);
  assertSemanticRevisionProposalWithinLimit(edit);
  assertValidProgramSemanticWorkGraph(edit.workItems);
  assertIdentityDecisions(previous.workItems, edit.workItems, edit.identityDecisions);
  const verification = deriveNextVerification(
    previous,
    edit.verification,
    edit.verificationBindings,
    edit.workItems,
    edit.outputSlots,
    edit.productionSteps,
  );
  const next = normalizedState({
    programStateId: previous.programStateId,
    currentRevision: revision,
    workItems: edit.workItems,
    verification,
    verificationBindings: edit.verificationBindings,
    outputSlots: edit.outputSlots,
    productionSteps: edit.productionSteps,
  });
  assertValidProgramSemanticStateV1(next);
  return next;
}

function validateAttemptAssumptions(
  state: ProgramSemanticStateV1,
  attempt: ProgramAttemptSemanticAssumptionsV1 | null,
): void {
  if (attempt === null) return;
  const byId = workMap(state.workItems);
  const work = byId.get(String(attempt.workItemId));
  if (
    work === undefined
    || work.requirementState !== "required"
    || work.topologyState !== "leaf"
    || work.satisfactionState !== "active"
    || work.workItemGeneration !== attempt.workItemGeneration
  ) fail("active Attempt assumptions do not match current target WorkItem");
  if (!eq(work.authorityEnvelope, attempt.workAuthorityEnvelope)) {
    fail("active Attempt assumptions do not match current WorkAuthorityEnvelope");
  }
  const expectedIds = [...work.dependencyIds].map(String).sort(cmp);
  const receiptIds = attempt.directDependencies.map((entry) => String(entry.workItemId));
  if (!eq(receiptIds, [...receiptIds].sort(cmp)) || !eq(expectedIds, receiptIds)) {
    fail("active Attempt semantic dependency receipt is not the exact sorted direct dependency set");
  }
  for (const entry of attempt.directDependencies) {
    const dependency = byId.get(String(entry.workItemId));
    if (
      dependency === undefined
      || dependency.requirementState !== "required"
      || dependency.workItemGeneration !== entry.workItemGeneration
      || entry.required !== true
      || entry.satisfiedOrDischargedAtIssue !== true
      || !isProgramSemanticRequirementComplete(dependency.workItemId, state.workItems)
    ) fail(`active Attempt dependency ${String(entry.workItemId)} is not current and complete`);
  }
}

function attemptRetained(next: ProgramSemanticStateV1, attempt: ProgramAttemptSemanticAssumptionsV1): boolean {
  const byId = workMap(next.workItems);
  const work = byId.get(String(attempt.workItemId));
  if (
    work === undefined
    || work.requirementState !== "required"
    || work.topologyState !== "leaf"
    || work.workItemGeneration !== attempt.workItemGeneration
    || !eq(work.authorityEnvelope, attempt.workAuthorityEnvelope)
  ) return false;
  const ids = [...work.dependencyIds].map(String).sort(cmp);
  if (!eq(ids, attempt.directDependencies.map((entry) => String(entry.workItemId)))) return false;
  return attempt.directDependencies.every((entry) => {
    const dependency = byId.get(String(entry.workItemId));
    return dependency !== undefined
      && dependency.requirementState === "required"
      && dependency.workItemGeneration === entry.workItemGeneration
      && isProgramSemanticRequirementComplete(dependency.workItemId, next.workItems);
  });
}

function workImpact(
  previous: ProgramSemanticStateV1,
  next: ProgramSemanticStateV1,
  decisions: readonly WorkItemIdentityDecisionV1[],
): Pick<RevisionImpactV1, "unchangedWorkItems" | "modifiedWorkItems" | "addedWorkItems" | "supersededWorkItems" | "withdrawnWorkItems"> {
  const nextById = workMap(next.workItems);
  const previousIds = new Set(previous.workItems.map((work) => String(work.workItemId)));
  const unchangedWorkItems: WorkItemGenerationRefV1[] = [];
  const modifiedWorkItems: WorkItemGenerationChangeV1[] = [];
  const supersededWorkItems: WorkItemGenerationChangeV1[] = [];
  const withdrawnWorkItems: WorkItemGenerationChangeV1[] = [];
  const byDecision = new Map(decisions.map((decision) => [String(decision.workItemId), decision]));

  for (const old of previous.workItems) {
    const current = nextById.get(String(old.workItemId))!;
    if (old.requirementState !== "required") {
      unchangedWorkItems.push({ workItemId: old.workItemId, generation: old.workItemGeneration });
      continue;
    }
    const decision = byDecision.get(String(old.workItemId))!;
    if (decision.disposition === "unchanged") {
      unchangedWorkItems.push({ workItemId: old.workItemId, generation: old.workItemGeneration });
      continue;
    }
    const change: WorkItemGenerationChangeV1 = {
      workItemId: old.workItemId,
      fromGeneration: old.workItemGeneration,
      toGeneration: current.workItemGeneration,
      disposition: decision.disposition,
      successorWorkItemId: decision.successorWorkItemId,
    };
    if (decision.disposition === "withdraw_identity") withdrawnWorkItems.push(change);
    else if (decision.disposition === "new_identity_supersedes_old") supersededWorkItems.push(change);
    else modifiedWorkItems.push(change);
  }
  const addedWorkItems = next.workItems
    .filter((work) => !previousIds.has(String(work.workItemId)))
    .map((work) => ({ workItemId: work.workItemId, generation: work.workItemGeneration }));
  return {
    unchangedWorkItems: sorted(unchangedWorkItems, (value) => String(value.workItemId)),
    modifiedWorkItems: sorted(modifiedWorkItems, (value) => String(value.workItemId)),
    addedWorkItems: sorted(addedWorkItems, (value) => String(value.workItemId)),
    supersededWorkItems: sorted(supersededWorkItems, (value) => String(value.workItemId)),
    withdrawnWorkItems: sorted(withdrawnWorkItems, (value) => String(value.workItemId)),
  };
}

function verificationRef(
  obligation: VerificationObligation,
  binding: VerificationSemanticBindingV1,
): VerificationGenerationRefV1 {
  return { obligationId: obligation.obligationId, subjectGeneration: obligation.subjectGeneration, subject: binding.subject };
}

function verificationImpact(
  previous: ProgramSemanticStateV1,
  next: ProgramSemanticStateV1,
): Pick<RevisionImpactV1, "retainedVerification" | "staleVerification" | "addedVerification" | "reboundVerification" | "retiredVerification"> {
  const oldById = new Map(previous.verification.map((value) => [String(value.obligationId), value]));
  const newById = new Map(next.verification.map((value) => [String(value.obligationId), value]));
  const oldBindings = bindingMap(previous.verificationBindings);
  const newBindings = bindingMap(next.verificationBindings);
  const retainedVerification: VerificationGenerationRefV1[] = [];
  const staleVerification: VerificationGenerationChangeV1[] = [];
  const addedVerification: VerificationGenerationRefV1[] = [];
  const reboundVerification: VerificationGenerationChangeV1[] = [];
  const retiredVerification: VerificationGenerationRefV1[] = [];

  for (const [id, old] of oldById) {
    const oldBinding = oldBindings.get(id)!;
    const current = newById.get(id);
    if (current === undefined) {
      retiredVerification.push(verificationRef(old, oldBinding));
      continue;
    }
    const currentBinding = newBindings.get(id)!;
    if (current.subjectGeneration === old.subjectGeneration && eq(oldBinding.subject, currentBinding.subject)) {
      retainedVerification.push(verificationRef(current, currentBinding));
      continue;
    }
    const change: VerificationGenerationChangeV1 = {
      obligationId: current.obligationId,
      fromSubjectGeneration: old.subjectGeneration,
      toSubjectGeneration: current.subjectGeneration,
      fromSubject: oldBinding.subject,
      toSubject: currentBinding.subject,
    };
    if (eq(oldBinding.subject, currentBinding.subject)) staleVerification.push(change);
    else reboundVerification.push(change);
  }
  for (const [id, current] of newById) {
    if (!oldById.has(id)) addedVerification.push(verificationRef(current, newBindings.get(id)!));
  }
  return {
    retainedVerification: sorted(retainedVerification, (value) => String(value.obligationId)),
    staleVerification: sorted(staleVerification, (value) => String(value.obligationId)),
    addedVerification: sorted(addedVerification, (value) => String(value.obligationId)),
    reboundVerification: sorted(reboundVerification, (value) => String(value.obligationId)),
    retiredVerification: sorted(retiredVerification, (value) => String(value.obligationId)),
  };
}

function outputImpact(
  previous: ProgramSemanticStateV1,
  next: ProgramSemanticStateV1,
): Pick<RevisionImpactV1, "retainedOutputs" | "addedOutputs" | "modifiedOutputs" | "retiredOutputs"> {
  const oldSlots = new Map(previous.outputSlots.map((slot) => [String(slot.outputSlotId), slot]));
  const newSlots = new Map(next.outputSlots.map((slot) => [String(slot.outputSlotId), slot]));
  const retainedOutputs: ProgramOutputSemanticRefV1[] = [];
  const addedOutputs: ProgramOutputSemanticRefV1[] = [];
  const modifiedOutputs: ProgramOutputSemanticChangeV1[] = [];
  const retiredOutputs: ProgramOutputSemanticRefV1[] = [];
  for (const [id, oldSlot] of oldSlots) {
    const oldObject = outputSemanticObject(oldSlot, previous.workItems, previous.productionSteps);
    const currentSlot = newSlots.get(id);
    if (currentSlot === undefined) {
      retiredOutputs.push(oldObject.ref);
      continue;
    }
    const currentObject = outputSemanticObject(currentSlot, next.workItems, next.productionSteps);
    if (eq(oldObject, currentObject)) retainedOutputs.push(currentObject.ref);
    else modifiedOutputs.push({ outputSlotId: currentSlot.outputSlotId, from: oldObject.ref, to: currentObject.ref });
  }
  for (const [id, slot] of newSlots) {
    if (!oldSlots.has(id)) addedOutputs.push(outputRef(slot, next.workItems, next.productionSteps));
  }
  return {
    retainedOutputs: sorted(retainedOutputs, (value) => String(value.outputSlotId)),
    addedOutputs: sorted(addedOutputs, (value) => String(value.outputSlotId)),
    modifiedOutputs: sorted(modifiedOutputs, (value) => String(value.outputSlotId)),
    retiredOutputs: sorted(retiredOutputs, (value) => String(value.outputSlotId)),
  };
}

/** Pure deterministic Host-side impact derivation for one exact semantic cut. */
export function deriveRevisionImpactV1(
  previous: ProgramSemanticStateV1,
  next: ProgramSemanticStateV1,
  decisions: readonly WorkItemIdentityDecisionV1[],
  activeAttempt: ProgramAttemptSemanticAssumptionsV1 | null,
): RevisionImpactV1 {
  assertIdentityDecisions(previous.workItems, next.workItems, decisions);
  validateAttemptAssumptions(previous, activeAttempt);
  const attempts = activeAttempt === null
    ? { retainedAttempts: [] as ProgramAttemptId[], invalidatedAttempts: [] as ProgramAttemptId[] }
    : attemptRetained(next, activeAttempt)
      ? { retainedAttempts: [activeAttempt.programAttemptId], invalidatedAttempts: [] as ProgramAttemptId[] }
      : { retainedAttempts: [] as ProgramAttemptId[], invalidatedAttempts: [activeAttempt.programAttemptId] };
  const impact: RevisionImpactV1 = {
    fromProgramRevisionId: previous.currentRevision.programRevisionId,
    toProgramRevisionId: next.currentRevision.programRevisionId,
    ...workImpact(previous, next, decisions),
    ...attempts,
    ...verificationImpact(previous, next),
    ...outputImpact(previous, next),
  };
  assertRevisionImpactWithinLimit(impact);
  return impact;
}

function arraySubset(next: readonly string[], previous: readonly string[]): boolean {
  const allowed = new Set(previous);
  return next.every((value) => allowed.has(value));
}

function provenRefinement(old: ProgramSemanticWorkItemV1, current: ProgramSemanticWorkItemV1): boolean {
  if (!workAuthorityEnvelopeIsEqualOrNarrower(current.authorityEnvelope, old.authorityEnvelope)) return false;
  if (old.description !== current.description || !eq(old.dependencyIds, current.dependencyIds) || old.parentWorkItemId !== current.parentWorkItemId) return false;
  if (!arraySubset(current.affectedPaths, old.affectedPaths)) return false;
  if (old.topologyState === "leaf" && current.topologyState === "decomposed") {
    return old.satisfactionState !== "satisfied" && current.satisfactionState !== "satisfied";
  }
  return old.topologyState === current.topologyState && old.satisfactionState === current.satisfactionState;
}

/** Conservative mechanical classifier; ambiguous semantic equivalence never grants refinement. */
export function classifyProgramSemanticRevisionV1(
  previous: ProgramSemanticStateV1,
  next: ProgramSemanticStateV1,
  decisions: readonly WorkItemIdentityDecisionV1[],
): Exclude<ProgramChangeClass, "initial"> | "unknown" {
  const previousById = workMap(previous.workItems);
  const nextById = workMap(next.workItems);
  const decisionById = new Map(decisions.map((decision) => [String(decision.workItemId), decision]));
  let changed = false;
  let correction = false;
  let scope = false;

  for (const old of previous.workItems) {
    if (old.requirementState !== "required") continue;
    const decision = decisionById.get(String(old.workItemId));
    if (decision === undefined || decision.disposition === "unchanged") continue;
    changed = true;
    const current = nextById.get(String(old.workItemId));
    if (current === undefined) return "unknown";
    if (decision.disposition === "withdraw_identity" || decision.disposition === "new_identity_supersedes_old") {
      if (old.parentWorkItemId === null) scope = true;
      else correction = true;
      continue;
    }
    if (!workAuthorityEnvelopeIsEqualOrNarrower(current.authorityEnvelope, old.authorityEnvelope)) {
      scope = true;
      continue;
    }
    if (old.satisfactionState === "satisfied" && current.topologyState === "decomposed") correction = true;
    else if (!provenRefinement(old, current)) correction = true;
  }

  for (const current of next.workItems) {
    if (previousById.has(String(current.workItemId))) continue;
    changed = true;
    if (current.parentWorkItemId === null) scope = true;
  }

  const oldVerification = new Map(previous.verification.map((value) => [String(value.obligationId), value]));
  const newVerification = new Map(next.verification.map((value) => [String(value.obligationId), value]));
  const oldBindings = bindingMap(previous.verificationBindings);
  for (const [id, old] of oldVerification) {
    const current = newVerification.get(id);
    if (current === undefined) {
      changed = true;
      const subject = oldBindings.get(id)?.subject;
      if (subject?.kind === "program") scope = true;
      else if (subject?.kind === "work_item" && nextById.get(String(subject.workItemId))?.requirementState === "required") scope = true;
      else correction = true;
      continue;
    }
    if (!eq(definitionOf(old), definitionOf(current))) {
      changed = true;
      correction = true;
    }
  }
  for (const id of newVerification.keys()) if (!oldVerification.has(id)) changed = true;

  if (!eq(previous.outputSlots, next.outputSlots) || !eq(previous.productionSteps, next.productionSteps)) {
    changed = true;
    scope = true;
  }
  if (!changed) return "unknown";
  if (scope) return "scope_amendment";
  if (correction) return "correction";
  return "refinement";
}

/** Build one complete semantic-cut payload without performing Host/Application admission. */
export function createProgramSemanticRevisionCutV1(
  previousInput: ProgramSemanticStateV1,
  transaction: ProgramSemanticRevisionTransactionV1,
): ProgramSemanticRevisionCutV1 {
  const previous = normalizedState(previousInput);
  assertValidProgramSemanticStateV1(previous);
  positive("currentProgramStateRevision", transaction.currentProgramStateRevision);
  assertValidProgramRevision(transaction.nextRevision);
  if (transaction.nextRevision.changeClass === "initial") fail("semantic revision transaction cannot create baseline revision");
  if (transaction.nextRevision.parentProgramRevisionId !== previous.currentRevision.programRevisionId) {
    fail("semantic revision targets a stale semantic parent");
  }
  if (transaction.nextRevision.ordinal !== previous.currentRevision.ordinal + 1) {
    fail("semantic revision ordinal must advance exactly once");
  }
  const toProgramStateRevision = transaction.currentProgramStateRevision + 1;
  if (transaction.nextRevision.acceptedAtStateRevision !== toProgramStateRevision) {
    fail("acceptedAtStateRevision must equal the atomic whole-state revision advance");
  }
  const edit = normalizedEdit(transaction.edit);
  const next = buildNextState(previous, transaction.nextRevision, edit);
  validateAttemptAssumptions(previous, transaction.activeAttempt);
  const classified = classifyProgramSemanticRevisionV1(previous, next, edit.identityDecisions);
  if (classified === "unknown") fail("semantic revision contains no mechanically classifiable semantic change");
  if (classified !== transaction.nextRevision.changeClass) {
    fail(`semantic revision class ${transaction.nextRevision.changeClass} does not match Host classification ${classified}`);
  }
  const revisionImpact = deriveRevisionImpactV1(previous, next, edit.identityDecisions, transaction.activeAttempt);
  return {
    kind: "program.semantic_revision.admitted.v1",
    fromProgramStateRevision: transaction.currentProgramStateRevision,
    toProgramStateRevision,
    fromProgramRevisionId: previous.currentRevision.programRevisionId,
    nextSemanticState: next,
    identityDecisions: edit.identityDecisions,
    attemptAssumptions: transaction.activeAttempt,
    revisionImpact,
  };
}

/** Replay one admitted atomic semantic cut; stale/tampered cuts fail deterministically. */
export function applyProgramSemanticRevisionCutV1(
  currentInput: ProgramSemanticStateV1,
  currentProgramStateRevision: number,
  cut: ProgramSemanticRevisionCutV1,
): AppliedProgramSemanticRevisionV1 {
  const current = normalizedState(currentInput);
  assertValidProgramSemanticStateV1(current);
  positive("currentProgramStateRevision", currentProgramStateRevision);
  if (cut.kind !== "program.semantic_revision.admitted.v1") failValue(`unsupported semantic cut kind ${String(cut.kind)}`);
  if (cut.fromProgramStateRevision !== currentProgramStateRevision) fail("semantic cut whole-state CAS revision is stale");
  if (cut.toProgramStateRevision !== cut.fromProgramStateRevision + 1) fail("semantic cut must advance whole-state revision exactly once");
  if (cut.fromProgramRevisionId !== current.currentRevision.programRevisionId) fail("semantic cut parent ProgramRevisionId is stale");

  const next = normalizedState(cut.nextSemanticState);
  assertValidProgramSemanticStateV1(next);
  if (next.programStateId !== current.programStateId) fail("semantic cut cannot change ProgramStateId");
  if (next.currentRevision.parentProgramRevisionId !== current.currentRevision.programRevisionId) {
    fail("semantic cut does not extend the current semantic head");
  }
  if (next.currentRevision.ordinal !== current.currentRevision.ordinal + 1) fail("semantic cut ordinal is not the exact successor");
  if (next.currentRevision.acceptedAtStateRevision !== cut.toProgramStateRevision) {
    fail("semantic cut ProgramRevision disagrees with atomic whole-state revision");
  }
  validateAttemptAssumptions(current, cut.attemptAssumptions);
  const impact = deriveRevisionImpactV1(current, next, cut.identityDecisions, cut.attemptAssumptions);
  if (!eq(impact, cut.revisionImpact)) fail("semantic cut RevisionImpact does not match deterministic recomputation");
  const classified = classifyProgramSemanticRevisionV1(current, next, cut.identityDecisions);
  if (classified === "unknown" || classified !== next.currentRevision.changeClass) {
    fail("semantic cut change class does not match deterministic structural classification");
  }
  return { programStateRevision: cut.toProgramStateRevision, semanticState: next };
}
