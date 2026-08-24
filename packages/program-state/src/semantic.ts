import { canonicalStringify } from "./canonical.ts";
import { PROGRAM_LIMITS } from "./limits.ts";
import { ProgramInvariantError, assertNormalizedWorkspacePath, utf8Bytes } from "./validation-core.ts";
import type {
  ProgramArtifactProductionStep,
  ProgramChangeClass,
  ProgramOutputSlot,
  ProgramRevision,
  ProgramSatisfactionState,
  ProgramSemanticWorkItemV1,
  ProgramWorkItemId,
  ProgramWorkLifecycle,
  VerificationSemanticBindingV1,
  VerificationSubjectV1,
  WorkAuthorityEnvelopeV1,
} from "./types.ts";

function fail(message: string): never {
  throw new ProgramInvariantError("structural_invariant", message);
}

function failValue(message: string): never {
  throw new ProgramInvariantError("invalid_value", message);
}

function failLimit(message: string): never {
  throw new ProgramInvariantError("limit_exceeded", message);
}

function requirePositiveSafeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) failValue(`${label} must be a positive safe integer`);
}

function requireNonNegativeSafeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) failValue(`${label} must be a non-negative safe integer`);
}

function requireNonEmptyString(label: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) failValue(`${label} must be a non-empty string`);
}

function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertCanonicalStringCollection(
  label: string,
  values: readonly string[],
  validate?: (value: string) => void,
): void {
  let previous: string | undefined;
  for (const value of values) {
    requireNonEmptyString(`${label} entry`, value);
    validate?.(value);
    if (previous !== undefined && compareCanonicalStrings(previous, value) >= 0) {
      failValue(`${label} must be strictly sorted and deduplicated`);
    }
    previous = value;
  }
}

function assertAuthorityRepositoryRoot(root: string): void {
  if (root === ".") return;
  assertNormalizedWorkspacePath(root);
}

function repositoryRootContains(parent: string, child: string): boolean {
  if (parent === ".") return true;
  if (child === ".") return parent === ".";
  return child === parent || child.startsWith(`${parent}/`);
}

function isSubset(child: readonly string[], parent: readonly string[]): boolean {
  const parentSet = new Set(parent);
  return child.every((value) => parentSet.has(value));
}

function isSuperset(child: readonly string[], parent: readonly string[]): boolean {
  const childSet = new Set(child);
  return parent.every((value) => childSet.has(value));
}

/** Map the frozen legacy lifecycle into the A1 orthogonal satisfaction axis. */
export function legacyLifecycleToSatisfactionState(lifecycle: ProgramWorkLifecycle): ProgramSatisfactionState {
  switch (lifecycle) {
    case "pending": return "pending";
    case "in_progress": return "active";
    case "blocked": return "blocked";
    case "awaiting_verification": return "awaiting_verification";
    case "completed": return "satisfied";
  }
}

/** Validate one mechanically comparable A1 WorkAuthorityEnvelope. */
export function assertValidWorkAuthorityEnvelopeV1(envelope: WorkAuthorityEnvelopeV1): void {
  requireNonEmptyString("objectiveBoundaryRef.programStateId", String(envelope.objectiveBoundaryRef.programStateId));
  requireNonEmptyString(
    "objectiveBoundaryRef.rootProgramRevisionId",
    String(envelope.objectiveBoundaryRef.rootProgramRevisionId),
  );
  if (envelope.objectiveBoundaryRef.anchorWorkItemId !== null) {
    requireNonEmptyString(
      "objectiveBoundaryRef.anchorWorkItemId",
      String(envelope.objectiveBoundaryRef.anchorWorkItemId),
    );
  }

  assertCanonicalStringCollection("allowedRepositoryRoots", envelope.allowedRepositoryRoots, assertAuthorityRepositoryRoot);
  assertCanonicalStringCollection("allowedEffectClasses", envelope.allowedEffectClasses);
  assertCanonicalStringCollection("allowedExternalSystems", envelope.allowedExternalSystems);
  assertCanonicalStringCollection("capabilityCeiling", envelope.capabilityCeiling);
  assertCanonicalStringCollection("mandatoryVerificationIds", envelope.mandatoryVerificationIds.map(String));
  assertCanonicalStringCollection("forbiddenChangeKinds", envelope.forbiddenChangeKinds);

  requireNonNegativeSafeInteger("maximumTopologyExpansion", envelope.maximumTopologyExpansion);
  if (envelope.maximumTopologyExpansion > PROGRAM_LIMITS.workItems) {
    failLimit(`maximumTopologyExpansion exceeds ${PROGRAM_LIMITS.workItems}`);
  }

  const bytes = utf8Bytes(canonicalStringify(envelope));
  if (bytes > PROGRAM_LIMITS.workAuthorityEnvelopeBytes) {
    failLimit(`WorkAuthorityEnvelope exceeds ${PROGRAM_LIMITS.workAuthorityEnvelopeBytes} bytes; got ${bytes}`);
  }
}

/**
 * Frozen mechanical partial order. This function intentionally performs no
 * semantic/natural-language equivalence judgment.
 */
export function workAuthorityEnvelopeIsEqualOrNarrower(
  child: WorkAuthorityEnvelopeV1,
  parent: WorkAuthorityEnvelopeV1,
): boolean {
  assertValidWorkAuthorityEnvelopeV1(child);
  assertValidWorkAuthorityEnvelopeV1(parent);

  if (canonicalStringify(child.objectiveBoundaryRef) !== canonicalStringify(parent.objectiveBoundaryRef)) {
    return false;
  }
  if (!child.allowedRepositoryRoots.every((root) =>
    parent.allowedRepositoryRoots.some((parentRoot) => repositoryRootContains(parentRoot, root)))) {
    return false;
  }
  if (!isSubset(child.allowedEffectClasses, parent.allowedEffectClasses)) return false;
  if (!isSubset(child.allowedExternalSystems, parent.allowedExternalSystems)) return false;
  if (!isSubset(child.capabilityCeiling, parent.capabilityCeiling)) return false;
  if (child.maximumTopologyExpansion > parent.maximumTopologyExpansion) return false;
  if (!isSuperset(child.mandatoryVerificationIds.map(String), parent.mandatoryVerificationIds.map(String))) return false;
  if (!isSuperset(child.forbiddenChangeKinds, parent.forbiddenChangeKinds)) return false;
  return true;
}

/** Validate one immutable semantic revision lineage record. */
export function assertValidProgramRevision(revision: ProgramRevision): void {
  requireNonEmptyString("programRevisionId", String(revision.programRevisionId));
  requirePositiveSafeInteger("ProgramRevision.ordinal", revision.ordinal);
  if (revision.ordinal > PROGRAM_LIMITS.semanticProgramRevisions) {
    failLimit(`ProgramRevision.ordinal exceeds ${PROGRAM_LIMITS.semanticProgramRevisions}`);
  }
  requirePositiveSafeInteger("ProgramRevision.acceptedAtStateRevision", revision.acceptedAtStateRevision);
  requireNonEmptyString("ProgramRevision.admissionEventId", revision.admissionEventId);

  const classes: readonly ProgramChangeClass[] = ["initial", "refinement", "correction", "scope_amendment"];
  if (!classes.includes(revision.changeClass)) failValue(`Unsupported ProgramChangeClass: ${String(revision.changeClass)}`);

  if (revision.changeClass === "initial") {
    if (revision.ordinal !== 1 || revision.parentProgramRevisionId !== null) {
      fail("Initial ProgramRevision must be ordinal 1 with no parent");
    }
    if (revision.sourceDraftId !== null || revision.sourceDraftDigest !== null) {
      fail("Initial/baseline ProgramRevision must not claim a semantic draft");
    }
    return;
  }

  if (revision.ordinal <= 1 || revision.parentProgramRevisionId === null) {
    fail("Non-initial ProgramRevision requires a parent and ordinal greater than 1");
  }
  requireNonEmptyString("parentProgramRevisionId", String(revision.parentProgramRevisionId));
  if (revision.sourceDraftId === null || revision.sourceDraftDigest === null) {
    fail("Non-initial ProgramRevision requires exact source draft identity and digest");
  }
  requireNonEmptyString("sourceDraftId", revision.sourceDraftId);
  requireNonEmptyString("sourceDraftDigest", revision.sourceDraftDigest);
}

function assertSemanticWorkItemShape(work: ProgramSemanticWorkItemV1): void {
  requireNonEmptyString("workItemId", String(work.workItemId));
  requirePositiveSafeInteger(`work ${String(work.workItemId)} generation`, work.workItemGeneration);
  if (!Number.isSafeInteger(work.creationOrder) || work.creationOrder < 0) {
    failValue(`work ${String(work.workItemId)} creationOrder must be a non-negative safe integer`);
  }
  if (utf8Bytes(work.description) > PROGRAM_LIMITS.workDescriptionBytes) {
    failLimit(`work ${String(work.workItemId)} description exceeds ${PROGRAM_LIMITS.workDescriptionBytes} bytes`);
  }
  if (!["required", "withdrawn", "superseded"].includes(work.requirementState)) {
    failValue(`Unsupported requirementState for ${String(work.workItemId)}: ${String(work.requirementState)}`);
  }
  if (work.topologyState !== "leaf" && work.topologyState !== "decomposed") {
    failValue(`Unsupported topologyState for ${String(work.workItemId)}: ${String(work.topologyState)}`);
  }
  if (!["pending", "active", "blocked", "awaiting_verification", "satisfied"].includes(work.satisfactionState)) {
    failValue(`Unsupported satisfactionState for ${String(work.workItemId)}: ${String(work.satisfactionState)}`);
  }
  if (work.parentWorkItemId !== null) requireNonEmptyString("parentWorkItemId", String(work.parentWorkItemId));
  if (work.dependencyIds.length > PROGRAM_LIMITS.directDependenciesPerWorkItem) {
    failLimit(`direct dependencies for ${String(work.workItemId)} exceeds ${PROGRAM_LIMITS.directDependenciesPerWorkItem}`);
  }
  if (work.affectedPaths.length > PROGRAM_LIMITS.affectedPathsPerWorkItem) {
    failLimit(`affected paths for ${String(work.workItemId)} exceeds ${PROGRAM_LIMITS.affectedPathsPerWorkItem}`);
  }
  const paths = new Set<string>();
  for (const path of work.affectedPaths) {
    assertNormalizedWorkspacePath(path);
    if (paths.has(path)) failValue(`work ${String(work.workItemId)} has duplicate affected path ${path}`);
    paths.add(path);
  }
  assertValidWorkAuthorityEnvelopeV1(work.authorityEnvelope);
}

/**
 * Validate the current A1 semantic work graph. Historical non-required nodes
 * may remain for causal lineage; all current required topology/dependencies are
 * checked against the frozen depth/fan-out and Phase-1 graph ceilings.
 */
export function assertValidProgramSemanticWorkGraph(workItems: readonly ProgramSemanticWorkItemV1[]): void {
  if (workItems.length > PROGRAM_LIMITS.workItems) {
    failLimit(`semantic work items exceeds ${PROGRAM_LIMITS.workItems}; got ${workItems.length}`);
  }

  const byId = new Map<string, ProgramSemanticWorkItemV1>();
  for (const work of workItems) {
    assertSemanticWorkItemShape(work);
    const id = String(work.workItemId);
    if (byId.has(id)) failValue(`semantic work graph contains duplicate workItemId ${id}`);
    byId.set(id, work);
  }

  let dependencyEdges = 0;
  const currentDependencies = new Map<string, string[]>();
  for (const work of workItems) {
    const id = String(work.workItemId);
    if (work.parentWorkItemId !== null) {
      const parentId = String(work.parentWorkItemId);
      if (parentId === id) fail("A WorkItem cannot be its own decomposition parent");
      if (!byId.has(parentId)) fail(`work ${id} references unknown parent ${parentId}`);
    }

    const localDependencies = new Set<string>();
    const deps: string[] = [];
    for (const dependencyId of work.dependencyIds) {
      const depId = String(dependencyId);
      dependencyEdges += 1;
      if (depId === id) fail(`work ${id} depends on itself`);
      if (!byId.has(depId)) fail(`work ${id} references unknown dependency ${depId}`);
      if (localDependencies.has(depId)) failValue(`work ${id} repeats dependency ${depId}`);
      localDependencies.add(depId);
      if (work.requirementState === "required") {
        const dependency = byId.get(depId)!;
        if (dependency.requirementState !== "required") {
          fail(`current required work ${id} depends on non-required work ${depId}`);
        }
        deps.push(depId);
      }
    }
    if (work.requirementState === "required") currentDependencies.set(id, deps);
  }
  if (dependencyEdges > PROGRAM_LIMITS.totalDependencyEdges) {
    failLimit(`total dependency edges exceeds ${PROGRAM_LIMITS.totalDependencyEdges}; got ${dependencyEdges}`);
  }

  const parentVisiting = new Set<string>();
  const parentDepth = new Map<string, number>();
  const depthOf = (id: string): number => {
    const cached = parentDepth.get(id);
    if (cached !== undefined) return cached;
    if (parentVisiting.has(id)) fail(`decomposition topology contains a cycle at ${id}`);
    parentVisiting.add(id);
    const work = byId.get(id)!;
    let depth = 0;
    if (work.parentWorkItemId !== null) {
      const parent = byId.get(String(work.parentWorkItemId))!;
      if (work.requirementState === "required" && parent.requirementState !== "required") {
        fail(`current required work ${id} has non-required parent ${String(parent.workItemId)}`);
      }
      depth = depthOf(String(parent.workItemId)) + 1;
    }
    parentVisiting.delete(id);
    parentDepth.set(id, depth);
    if (work.requirementState === "required" && depth > PROGRAM_LIMITS.decompositionDepth) {
      failLimit(`decomposition depth exceeds ${PROGRAM_LIMITS.decompositionDepth} at ${id}; got ${depth}`);
    }
    return depth;
  };
  for (const work of workItems) depthOf(String(work.workItemId));

  const requiredChildren = new Map<string, ProgramSemanticWorkItemV1[]>();
  for (const work of workItems) {
    if (work.requirementState !== "required" || work.parentWorkItemId === null) continue;
    const parentId = String(work.parentWorkItemId);
    const children = requiredChildren.get(parentId) ?? [];
    children.push(work);
    requiredChildren.set(parentId, children);
  }

  for (const work of workItems) {
    if (work.requirementState !== "required") continue;
    const id = String(work.workItemId);
    const children = requiredChildren.get(id) ?? [];
    if (children.length > PROGRAM_LIMITS.childrenPerDecomposition) {
      failLimit(`required direct children for ${id} exceeds ${PROGRAM_LIMITS.childrenPerDecomposition}`);
    }
    if (work.topologyState === "leaf" && children.length !== 0) {
      fail(`required leaf ${id} has current required children`);
    }
    if (work.topologyState === "decomposed") {
      if (children.length === 0) fail(`required decomposed work ${id} has zero current required children`);
      if (children.length > work.authorityEnvelope.maximumTopologyExpansion) {
        fail(`required children for ${id} exceed its WorkAuthorityEnvelope maximumTopologyExpansion`);
      }
      if (work.satisfactionState === "satisfied") {
        fail(`required decomposed work ${id} cannot use leaf satisfactionState=satisfied`);
      }
      for (const child of children) {
        if (!workAuthorityEnvelopeIsEqualOrNarrower(child.authorityEnvelope, work.authorityEnvelope)) {
          fail(`child ${String(child.workItemId)} authority is not equal to or narrower than parent ${id}`);
        }
      }
    }
  }

  const dependencyVisiting = new Set<string>();
  const dependencyVisited = new Set<string>();
  const visitDependency = (id: string): void => {
    if (dependencyVisited.has(id)) return;
    if (dependencyVisiting.has(id)) fail(`current required dependency graph contains a cycle at ${id}`);
    dependencyVisiting.add(id);
    for (const depId of currentDependencies.get(id) ?? []) visitDependency(depId);
    dependencyVisiting.delete(id);
    dependencyVisited.add(id);
  };
  for (const id of currentDependencies.keys()) visitDependency(id);
}

function currentRequiredChildren(
  workItemId: ProgramWorkItemId,
  byId: ReadonlyMap<string, ProgramSemanticWorkItemV1>,
): ProgramSemanticWorkItemV1[] {
  return [...byId.values()].filter((work) =>
    work.requirementState === "required" && work.parentWorkItemId === workItemId);
}

function requirementComplete(
  work: ProgramSemanticWorkItemV1,
  byId: ReadonlyMap<string, ProgramSemanticWorkItemV1>,
  visiting: Set<string>,
): boolean {
  if (work.requirementState !== "required") return false;
  if (work.topologyState === "leaf") return work.satisfactionState === "satisfied";
  const id = String(work.workItemId);
  if (visiting.has(id)) return false;
  visiting.add(id);
  const children = currentRequiredChildren(work.workItemId, byId);
  const complete = children.length > 0 && children.every((child) => requirementComplete(child, byId, visiting));
  visiting.delete(id);
  return complete;
}

/** Frozen non-vacuous recursive discharge predicate for a decomposed parent. */
export function isProgramSemanticWorkItemDischarged(
  workItemId: ProgramWorkItemId,
  workItems: readonly ProgramSemanticWorkItemV1[],
): boolean {
  const byId = new Map(workItems.map((work) => [String(work.workItemId), work]));
  const work = byId.get(String(workItemId));
  if (work === undefined || work.requirementState !== "required" || work.topologyState !== "decomposed") return false;
  return requirementComplete(work, byId, new Set());
}

/** Leaf satisfaction or recursive decomposed-parent discharge. */
export function isProgramSemanticRequirementComplete(
  workItemId: ProgramWorkItemId,
  workItems: readonly ProgramSemanticWorkItemV1[],
): boolean {
  const byId = new Map(workItems.map((work) => [String(work.workItemId), work]));
  const work = byId.get(String(workItemId));
  return work === undefined ? false : requirementComplete(work, byId, new Set());
}

/** Structural readiness for adaptive required leaf work; Host facts remain external. */
export function deriveReadySemanticWorkItems(
  workItems: readonly ProgramSemanticWorkItemV1[],
): ProgramSemanticWorkItemV1[] {
  const byId = new Map(workItems.map((work) => [String(work.workItemId), work]));
  return workItems.filter((work) =>
    work.requirementState === "required"
    && work.topologyState === "leaf"
    && work.satisfactionState === "pending"
    && work.dependencyIds.every((dependencyId) => {
      const dependency = byId.get(String(dependencyId));
      return dependency !== undefined && requirementComplete(dependency, byId, new Set());
    }));
}

/** Whether every current required root obligation is semantically complete. */
export function allRequiredSemanticWorkComplete(workItems: readonly ProgramSemanticWorkItemV1[]): boolean {
  const roots = workItems.filter((work) => work.requirementState === "required" && work.parentWorkItemId === null);
  if (roots.length === 0) return false;
  const byId = new Map(workItems.map((work) => [String(work.workItemId), work]));
  return roots.every((root) => requirementComplete(root, byId, new Set()));
}

/** Currentness of an explicit semantic verification subject. */
export function verificationSubjectIsCurrent(
  subject: VerificationSubjectV1,
  workItems: readonly ProgramSemanticWorkItemV1[],
  outputSlots: readonly ProgramOutputSlot[] = [],
  productionSteps: readonly ProgramArtifactProductionStep[] = [],
): boolean {
  if (subject.kind === "program") return true;
  const workById = new Map(workItems.map((work) => [String(work.workItemId), work]));
  if (subject.kind === "work_item") {
    const work = workById.get(String(subject.workItemId));
    return work?.requirementState === "required" && work.workItemGeneration === subject.workItemGeneration;
  }

  const slot = outputSlots.find((candidate) => candidate.outputSlotId === subject.outputSlotId);
  if (slot === undefined) return false;
  const step = productionSteps.find((candidate) => candidate.productionStepId === slot.productionStepId);
  if (step === undefined || step.producerWorkItemId !== subject.producerWorkItemId) return false;
  const producer = workById.get(String(subject.producerWorkItemId));
  return producer?.requirementState === "required"
    && producer.workItemGeneration === subject.producerWorkItemGeneration;
}

export function assertCurrentVerificationSubjectV1(
  subject: VerificationSubjectV1,
  workItems: readonly ProgramSemanticWorkItemV1[],
  outputSlots: readonly ProgramOutputSlot[] = [],
  productionSteps: readonly ProgramArtifactProductionStep[] = [],
): void {
  if (subject.kind !== "program") {
    if (subject.kind === "work_item") requirePositiveSafeInteger("workItemGeneration", subject.workItemGeneration);
    else requirePositiveSafeInteger("producerWorkItemGeneration", subject.producerWorkItemGeneration);
  }
  if (!verificationSubjectIsCurrent(subject, workItems, outputSlots, productionSteps)) {
    fail("VerificationSubjectV1 does not identify a current semantic subject");
  }
}

export function assertValidVerificationSemanticBindingsV1(
  bindings: readonly VerificationSemanticBindingV1[],
  obligationIds: ReadonlySet<string>,
  workItems: readonly ProgramSemanticWorkItemV1[],
  outputSlots: readonly ProgramOutputSlot[] = [],
  productionSteps: readonly ProgramArtifactProductionStep[] = [],
): void {
  const seen = new Set<string>();
  for (const binding of bindings) {
    const id = String(binding.obligationId);
    requireNonEmptyString("verification semantic binding obligationId", id);
    if (seen.has(id)) failValue(`duplicate verification semantic binding for ${id}`);
    seen.add(id);
    if (!obligationIds.has(id)) fail(`verification semantic binding references unknown obligation ${id}`);
    assertCurrentVerificationSubjectV1(binding.subject, workItems, outputSlots, productionSteps);
  }
  if (seen.size !== obligationIds.size) {
    fail("adaptive verification semantics require exactly one subject binding per obligation");
  }
}

function assertCanonicalPayloadBytes(label: string, value: unknown, maximum: number): void {
  const bytes = utf8Bytes(canonicalStringify(value));
  if (bytes > maximum) failLimit(`${label} exceeds ${maximum} bytes; got ${bytes}`);
}

export function assertSemanticRevisionProposalWithinLimit(value: unknown): void {
  assertCanonicalPayloadBytes("semantic revision proposal", value, PROGRAM_LIMITS.semanticRevisionProposalBytes);
}

export function assertRevisionImpactWithinLimit(value: unknown): void {
  assertCanonicalPayloadBytes("RevisionImpact", value, PROGRAM_LIMITS.revisionImpactBytes);
}

export function assertSealedSemanticDraftWithinLimit(value: unknown): void {
  assertCanonicalPayloadBytes("sealed semantic draft", value, PROGRAM_LIMITS.sealedPendingSemanticDraftBytes);
}

export function assertSemanticRationaleWithinLimit(value: string): void {
  if (utf8Bytes(value) > PROGRAM_LIMITS.semanticRationaleBytes) {
    failLimit(`semantic rationale/diagnostic exceeds ${PROGRAM_LIMITS.semanticRationaleBytes} bytes`);
  }
}
