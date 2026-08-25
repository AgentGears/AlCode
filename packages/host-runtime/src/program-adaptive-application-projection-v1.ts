import type { PublicProgram } from "@alcode/application-protocol";
import { PROGRAM_LIMITS, canonicalStringify, type ProgramSemanticWorkItemV1, type RevisionImpactV1 } from "@alcode/program-state";
import type {
  ProgramApplicationCommandResultV1,
  ProgramApplicationPortV1,
  ProgramApplicationSnapshotV1,
} from "./program-application.ts";
import {
  ProgramSemanticRecoveryRegistryV1,
  type ProgramSemanticRecoverySnapshotV1,
} from "./program-semantic-recovery-v1.ts";

const MAX_PUBLIC_SEMANTIC_WORK_ITEMS = 32;
const MAX_AUTHORITY_LIST_ENTRIES = 16;
const MAX_IMPACT_IDS = 32;

export class ProgramAdaptiveApplicationProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramAdaptiveApplicationProjectionError";
  }
}

export interface ProgramAdaptiveAuthoritySummaryV1 {
  objectiveBoundaryRef: {
    rootProgramRevisionId: string;
    anchorWorkItemId: string | null;
  };
  allowedRepositoryRoots: string[];
  allowedEffectClasses: string[];
  allowedExternalSystems: string[];
  capabilityCeiling: string[];
  maximumTopologyExpansion: number;
  mandatoryVerificationIds: string[];
  forbiddenChangeKinds: string[];
  omissions: {
    allowedRepositoryRoots: number;
    allowedEffectClasses: number;
    allowedExternalSystems: number;
    capabilityCeiling: number;
    mandatoryVerificationIds: number;
    forbiddenChangeKinds: number;
  };
}

export interface ProgramAdaptivePublicWorkItemV1 {
  workItemId: string;
  workItemGeneration: number;
  requirementState: ProgramSemanticWorkItemV1["requirementState"];
  topologyState: ProgramSemanticWorkItemV1["topologyState"];
  satisfactionState: ProgramSemanticWorkItemV1["satisfactionState"];
  parentWorkItemId: string | null;
  authority: ProgramAdaptiveAuthoritySummaryV1;
}

export interface ProgramAdaptiveRevisionImpactSummaryV1 {
  retainedAttemptIds: string[];
  invalidatedAttemptIds: string[];
  modifiedWorkItemIds: string[];
  addedWorkItemIds: string[];
  supersededWorkItemIds: string[];
  withdrawnWorkItemIds: string[];
  staleVerificationIds: string[];
  reboundVerificationIds: string[];
  modifiedOutputSlotIds: string[];
  omissions: Record<string, number>;
}

export interface ProgramAdaptiveApplicationProjectionV1 {
  version: 1;
  programStateId: string;
  /** Whole-state revision at which the displayed semantic head was admitted. */
  semanticHeadAcceptedAtStateRevision: number;
  currentProgramRevisionId: string;
  currentProgramRevisionOrdinal: number;
  changeClass: string;
  workItems: ProgramAdaptivePublicWorkItemV1[];
  pendingSemanticDraft: null | {
    draftId: string;
    draftDigest: string;
    parentProgramRevisionId: string;
    nextProgramRevisionId: string;
    fromProgramStateRevision: number;
    changeClass: string;
  };
  latestRevisionImpact: ProgramAdaptiveRevisionImpactSummaryV1;
  currentAttemptDisposition: {
    retainedAttemptIds: string[];
    invalidatedAttemptIds: string[];
  };
  omissions: { workItems: number };
}

export type PublicProgramWithAdaptiveSemanticsV1 = PublicProgram & {
  adaptiveSemantic?: ProgramAdaptiveApplicationProjectionV1;
};

export interface ProgramAdaptiveApplicationSnapshotV1 extends Omit<ProgramApplicationSnapshotV1, "programs"> {
  programs: PublicProgramWithAdaptiveSemanticsV1[];
}

function clipList(values: readonly string[]): { values: string[]; omitted: number } {
  return {
    values: values.slice(0, MAX_AUTHORITY_LIST_ENTRIES),
    omitted: Math.max(0, values.length - MAX_AUTHORITY_LIST_ENTRIES),
  };
}

function authority(work: ProgramSemanticWorkItemV1): ProgramAdaptiveAuthoritySummaryV1 {
  const envelope = work.authorityEnvelope;
  const roots = clipList(envelope.allowedRepositoryRoots);
  const effects = clipList(envelope.allowedEffectClasses);
  const external = clipList(envelope.allowedExternalSystems);
  const capabilities = clipList(envelope.capabilityCeiling);
  const verification = clipList(envelope.mandatoryVerificationIds.map(String));
  const forbidden = clipList(envelope.forbiddenChangeKinds);
  return {
    objectiveBoundaryRef: {
      rootProgramRevisionId: String(envelope.objectiveBoundaryRef.rootProgramRevisionId),
      anchorWorkItemId: envelope.objectiveBoundaryRef.anchorWorkItemId === null
        ? null
        : String(envelope.objectiveBoundaryRef.anchorWorkItemId),
    },
    allowedRepositoryRoots: roots.values,
    allowedEffectClasses: effects.values,
    allowedExternalSystems: external.values,
    capabilityCeiling: capabilities.values,
    maximumTopologyExpansion: envelope.maximumTopologyExpansion,
    mandatoryVerificationIds: verification.values,
    forbiddenChangeKinds: forbidden.values,
    omissions: {
      allowedRepositoryRoots: roots.omitted,
      allowedEffectClasses: effects.omitted,
      allowedExternalSystems: external.omitted,
      capabilityCeiling: capabilities.omitted,
      mandatoryVerificationIds: verification.omitted,
      forbiddenChangeKinds: forbidden.omitted,
    },
  };
}

function publicWorkItem(work: ProgramSemanticWorkItemV1): ProgramAdaptivePublicWorkItemV1 {
  return {
    workItemId: String(work.workItemId),
    workItemGeneration: work.workItemGeneration,
    requirementState: work.requirementState,
    topologyState: work.topologyState,
    satisfactionState: work.satisfactionState,
    parentWorkItemId: work.parentWorkItemId === null ? null : String(work.parentWorkItemId),
    authority: authority(work),
  };
}

function impactIds<T>(values: readonly T[], id: (value: T) => string): { values: string[]; omitted: number } {
  const mapped = values.map(id).sort((a, b) => a.localeCompare(b, "en"));
  return { values: mapped.slice(0, MAX_IMPACT_IDS), omitted: Math.max(0, mapped.length - MAX_IMPACT_IDS) };
}

function impactSummary(impact: RevisionImpactV1): ProgramAdaptiveRevisionImpactSummaryV1 {
  const retained = impactIds(impact.retainedAttempts, String);
  const invalidated = impactIds(impact.invalidatedAttempts, String);
  const modified = impactIds(impact.modifiedWorkItems, (item) => String(item.workItemId));
  const added = impactIds(impact.addedWorkItems, (item) => String(item.workItemId));
  const superseded = impactIds(impact.supersededWorkItems, (item) => String(item.workItemId));
  const withdrawn = impactIds(impact.withdrawnWorkItems, (item) => String(item.workItemId));
  const staleVerification = impactIds(impact.staleVerification, (item) => String(item.obligationId));
  const reboundVerification = impactIds(impact.reboundVerification, (item) => String(item.obligationId));
  const modifiedOutputs = impactIds(impact.modifiedOutputs, (item) => String(item.outputSlotId));
  return {
    retainedAttemptIds: retained.values,
    invalidatedAttemptIds: invalidated.values,
    modifiedWorkItemIds: modified.values,
    addedWorkItemIds: added.values,
    supersededWorkItemIds: superseded.values,
    withdrawnWorkItemIds: withdrawn.values,
    staleVerificationIds: staleVerification.values,
    reboundVerificationIds: reboundVerification.values,
    modifiedOutputSlotIds: modifiedOutputs.values,
    omissions: {
      retainedAttemptIds: retained.omitted,
      invalidatedAttemptIds: invalidated.omitted,
      modifiedWorkItemIds: modified.omitted,
      addedWorkItemIds: added.omitted,
      supersededWorkItemIds: superseded.omitted,
      withdrawnWorkItemIds: withdrawn.omitted,
      staleVerificationIds: staleVerification.omitted,
      reboundVerificationIds: reboundVerification.omitted,
      modifiedOutputSlotIds: modifiedOutputs.omitted,
    },
  };
}

const projectionEncoder = new TextEncoder();
function projectionBytes(value: unknown): number {
  return projectionEncoder.encode(canonicalStringify(value)).byteLength;
}

function snapshotBytes(value: unknown): number {
  return projectionEncoder.encode(JSON.stringify(value)).byteLength;
}

export function projectAdaptiveProgramForApplicationV1(
  recovered: ProgramSemanticRecoverySnapshotV1,
): ProgramAdaptiveApplicationProjectionV1 {
  const semantic = recovered.semanticState;
  const pending = recovered.pendingDraft;
  const projection: ProgramAdaptiveApplicationProjectionV1 = {
    version: 1,
    programStateId: recovered.programStateId,
    semanticHeadAcceptedAtStateRevision: recovered.programStateRevision,
    currentProgramRevisionId: String(semantic.currentRevision.programRevisionId),
    currentProgramRevisionOrdinal: semantic.currentRevision.ordinal,
    changeClass: semantic.currentRevision.changeClass,
    workItems: [],
    pendingSemanticDraft: pending === null ? null : {
      draftId: pending.draftId,
      draftDigest: pending.draftDigest,
      parentProgramRevisionId: pending.parentProgramRevisionId,
      nextProgramRevisionId: pending.nextProgramRevisionId,
      fromProgramStateRevision: pending.fromProgramStateRevision,
      changeClass: pending.changeClass,
    },
    latestRevisionImpact: impactSummary(recovered.latestRevisionImpact),
    currentAttemptDisposition: {
      retainedAttemptIds: [...recovered.latestAttemptDisposition.retainedAttemptIds],
      invalidatedAttemptIds: [...recovered.latestAttemptDisposition.invalidatedAttemptIds],
    },
    omissions: { workItems: semantic.workItems.length },
  };

  if (projectionBytes(projection) > PROGRAM_LIMITS.applicationProgramProjectionBytes) {
    throw new ProgramAdaptiveApplicationProjectionError(
      `Adaptive Application Program projection base exceeds ${PROGRAM_LIMITS.applicationProgramProjectionBytes} bytes`,
    );
  }

  const maximumWorkItems = Math.min(semantic.workItems.length, MAX_PUBLIC_SEMANTIC_WORK_ITEMS);
  for (let index = 0; index < maximumWorkItems; index += 1) {
    const work = semantic.workItems[index];
    if (work === undefined) break;
    projection.workItems.push(publicWorkItem(work));
    projection.omissions.workItems = semantic.workItems.length - projection.workItems.length;
    if (projectionBytes(projection) <= PROGRAM_LIMITS.applicationProgramProjectionBytes) continue;
    projection.workItems.pop();
    projection.omissions.workItems = semantic.workItems.length - projection.workItems.length;
    break;
  }

  if (projectionBytes(projection) > PROGRAM_LIMITS.applicationProgramProjectionBytes) {
    throw new ProgramAdaptiveApplicationProjectionError(
      `Adaptive Application Program projection exceeds ${PROGRAM_LIMITS.applicationProgramProjectionBytes} bytes`,
    );
  }
  return projection;
}

/**
 * Projection wrapper only. Production selection/composition remains an A1-6C
 * responsibility; non-adopted Programs are returned byte-for-byte as V1 data.
 */
export class ProgramAdaptiveApplicationPortV1 implements ProgramApplicationPortV1 {
  constructor(
    private readonly base: ProgramApplicationPortV1,
    private readonly recovery: ProgramSemanticRecoveryRegistryV1,
  ) {}

  execute(command: Parameters<ProgramApplicationPortV1["execute"]>[0]): Promise<ProgramApplicationCommandResultV1> {
    return this.base.execute(command);
  }

  async getSnapshot(sessionId: string): Promise<ProgramApplicationSnapshotV1> {
    return this.getAdaptiveSnapshot(sessionId);
  }

  async getAdaptiveSnapshot(sessionId: string): Promise<ProgramAdaptiveApplicationSnapshotV1> {
    const base = await this.base.getSnapshot(sessionId);
    if (snapshotBytes(base) > PROGRAM_LIMITS.applicationProgramProjectionBytes) {
      throw new ProgramAdaptiveApplicationProjectionError(
        `Base Application Program snapshot exceeds ${PROGRAM_LIMITS.applicationProgramProjectionBytes} bytes`,
      );
    }

    const programs: PublicProgramWithAdaptiveSemanticsV1[] = [];
    const semanticWorkTotals = new Map<string, number>();
    for (const program of base.programs) {
      const original = structuredClone(program);
      const recovered = await this.recovery.current(program.programStateId);
      if (recovered === undefined) {
        programs.push(original);
        continue;
      }

      let adaptive: ProgramAdaptiveApplicationProjectionV1;
      try {
        adaptive = projectAdaptiveProgramForApplicationV1(recovered);
      } catch (error) {
        if (error instanceof ProgramAdaptiveApplicationProjectionError) {
          // A valid base Application snapshot must remain available even when
          // an adaptive subtree cannot fit its own bounded public projection.
          programs.push(original);
          continue;
        }
        throw error;
      }

      semanticWorkTotals.set(program.programStateId, recovered.semanticState.workItems.length);
      programs.push({
        ...original,
        // Existing public `revision` keeps whole-state CAS meaning. A
        // semantic cut itself advances that revision even before 6C wires
        // a unified operational projection source.
        revision: Math.max(program.revision, recovered.programStateRevision),
        adaptiveSemantic: adaptive,
      });
    }
    const snapshot: ProgramAdaptiveApplicationSnapshotV1 = { ...base, programs };

    // The frozen limit applies to the complete Application snapshot, not to
    // each semantic subtree independently. Remove semantic WorkItems from a
    // deterministic suffix first. If the base snapshot leaves no room even
    // for fixed adaptive metadata, omit complete adaptive subtrees from the
    // same deterministic suffix and restore the exact base Program instead of
    // making a previously valid Application snapshot unavailable. Fixed
    // semantic metadata is never partially emitted because partial impact or
    // disposition data could be mistaken for canonical truth.
    while (snapshotBytes(snapshot) > PROGRAM_LIMITS.applicationProgramProjectionBytes) {
      let changed = false;
      for (let index = programs.length - 1; index >= 0; index -= 1) {
        const program = programs[index];
        const adaptive = program?.adaptiveSemantic;
        if (program === undefined || adaptive === undefined || adaptive.workItems.length === 0) continue;
        adaptive.workItems.pop();
        const total = semanticWorkTotals.get(program.programStateId);
        if (total === undefined) {
          throw new ProgramAdaptiveApplicationProjectionError("Adaptive Application projection lost semantic WorkItem accounting");
        }
        adaptive.omissions.workItems = total - adaptive.workItems.length;
        changed = true;
        break;
      }
      if (changed) continue;

      for (let index = programs.length - 1; index >= 0; index -= 1) {
        const program = programs[index];
        if (program?.adaptiveSemantic === undefined) continue;
        const original = base.programs[index];
        if (original === undefined || original.programStateId !== program.programStateId) {
          throw new ProgramAdaptiveApplicationProjectionError("Adaptive Application projection lost base Program alignment");
        }
        programs[index] = structuredClone(original);
        semanticWorkTotals.delete(program.programStateId);
        changed = true;
        break;
      }
      if (changed) continue;

      // Reaching this branch means the base port itself returned a snapshot
      // over the shared limit, which is a base projection contract failure.
      throw new ProgramAdaptiveApplicationProjectionError(
        `Base Application Program snapshot exceeds ${PROGRAM_LIMITS.applicationProgramProjectionBytes} bytes`,
      );
    }
    return snapshot;
  }
}
