import type { PersistedDomainEvent } from "@alcode/events";
import {
  applyProgramSemanticRevisionCutV1,
  assertValidProgramSemanticStateV1,
  canonicalStringify,
  type ProgramAttemptSemanticAssumptionsV1,
  type ProgramChangeClass,
  type ProgramSemanticRevisionCutV1,
  type ProgramSemanticStateV1,
  type RevisionImpactV1,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import {
  programSemanticBaselineIdentityImpactV1,
} from "./program-semantic-baseline-kernel.ts";
import {
  adoptedProgramSemanticBaselineControlV1,
  reduceProgramSemanticBaselineControlsV1,
  replayProgramBaselineEvents,
} from "./program-semantic-baseline-replay.ts";
import {
  assertProgramSemanticRevisionDraftV1,
  createProgramSemanticRevisionCutFromDraftV1,
  type ProgramSemanticCurrentSnapshotV1,
  type ProgramSemanticCurrentStateSourceV1,
  type ProgramSemanticRevisionDraftV1,
  type PublicPendingProgramRevisionV1,
} from "./program-revision.ts";

const PROGRAM_SEMANTIC_CURRENTNESS_STABILITY_ATTEMPTS = 4;

export class ProgramSemanticRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramSemanticRecoveryError";
  }
}

export interface ProgramSemanticRevisionLineageEntryV1 {
  programRevisionId: string;
  parentProgramRevisionId: string | null;
  ordinal: number;
  changeClass: ProgramChangeClass;
  acceptedAtStateRevision: number;
  admissionEventId: string;
}

export interface ProgramSemanticRecoveredDraftV1 {
  draftId: string;
  draftDigest: string;
  sourceSessionId: string;
  parentProgramRevisionId: string;
  nextProgramRevisionId: string;
  fromProgramStateRevision: number;
  changeClass: Exclude<ProgramChangeClass, "initial">;
  status: "pending" | "accepted" | "invalidated";
}

export interface ProgramSemanticAttemptRevisionDispositionV1 {
  retainedAttemptIds: string[];
  invalidatedAttemptIds: string[];
}

export interface ProgramSemanticRecoverySnapshotV1 {
  programStateId: string;
  sourceEventSequence: number;
  /** Whole-state CAS revision at which the recovered semantic head was admitted. */
  programStateRevision: number;
  semanticState: ProgramSemanticStateV1;
  lineage: ProgramSemanticRevisionLineageEntryV1[];
  drafts: ProgramSemanticRecoveredDraftV1[];
  pendingDraft: PublicPendingProgramRevisionV1 | null;
  latestRevisionImpact: RevisionImpactV1;
  latestAttemptDisposition: ProgramSemanticAttemptRevisionDispositionV1;
}

interface DraftReplayState {
  draft: ProgramSemanticRevisionDraftV1;
  status: "pending" | "accepted" | "invalidated";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

function lineageEntry(state: ProgramSemanticStateV1): ProgramSemanticRevisionLineageEntryV1 {
  const revision = state.currentRevision;
  return {
    programRevisionId: String(revision.programRevisionId),
    parentProgramRevisionId: revision.parentProgramRevisionId === null ? null : String(revision.parentProgramRevisionId),
    ordinal: revision.ordinal,
    changeClass: revision.changeClass,
    acceptedAtStateRevision: revision.acceptedAtStateRevision,
    admissionEventId: revision.admissionEventId,
  };
}

function baselineControlEventsForProgram(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
): PersistedDomainEvent<string, unknown>[] {
  const targetDraftIds = new Set<string>();

  // Discover target baseline drafts first so later control events can be
  // correlated to their sealed semantic owner before envelope scoping.
  for (const event of events) {
    if (event.type !== "program.semantic_baseline.draft.sealed.v1") continue;
    const draft = record(record(event.payload).draft);
    const draftId = String(draft.draftId ?? "");
    const draftProgramStateId = String(draft.programStateId ?? "");
    const envelopeProgramStateId = String(event.programStateId ?? "");
    const draftTargetsProgram = draftProgramStateId === programStateId;
    const envelopeTargetsProgram = envelopeProgramStateId === programStateId;
    if (!draftTargetsProgram && !envelopeTargetsProgram) continue;
    if (!draftTargetsProgram || !envelopeTargetsProgram || draftProgramStateId !== envelopeProgramStateId) {
      throw new ProgramSemanticRecoveryError(
        "Sealed semantic baseline draft ProgramState identity disagrees with its canonical event envelope",
      );
    }
    if (draftId) targetDraftIds.add(draftId);
  }

  const scoped: PersistedDomainEvent<string, unknown>[] = [];
  for (const event of events) {
    if (!event.type.startsWith("program.semantic_baseline.")) continue;
    const payload = record(event.payload);
    const envelopeProgramStateId = String(event.programStateId ?? "");
    const envelopeTargetsProgram = envelopeProgramStateId === programStateId;

    if (event.type === "program.semantic_baseline.draft.sealed.v1") {
      const draft = record(payload.draft);
      const draftProgramStateId = String(draft.programStateId ?? "");
      const draftTargetsProgram = draftProgramStateId === programStateId;
      if (!draftTargetsProgram && !envelopeTargetsProgram) continue;
      scoped.push(event);
      continue;
    }

    if (event.type === "program.semantic_baseline.draft.invalidated.v1"
        || event.type === "program.semantic_baseline.adopted.v1") {
      const draftId = String(payload.draftId ?? "");
      const draftTargetsProgram = targetDraftIds.has(draftId);
      let embeddedTargetsProgram = false;
      let embeddedProgramStateId = "";
      if (event.type === "program.semantic_baseline.adopted.v1") {
        embeddedProgramStateId = String(record(record(payload.cut).semanticState).programStateId ?? "");
        embeddedTargetsProgram = embeddedProgramStateId === programStateId;
      }
      if (!draftTargetsProgram && !envelopeTargetsProgram && !embeddedTargetsProgram) continue;
      if (!draftTargetsProgram
          || !envelopeTargetsProgram
          || (embeddedProgramStateId !== "" && embeddedProgramStateId !== programStateId)) {
        throw new ProgramSemanticRecoveryError(
          "Semantic baseline control ProgramState identity disagrees with its sealed draft and canonical event envelope",
        );
      }
      scoped.push(event);
      continue;
    }

    if (envelopeTargetsProgram) scoped.push(event);
  }
  return scoped;
}

function replayDrafts(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
): Map<string, DraftReplayState> {
  const states = new Map<string, DraftReplayState>();
  for (const event of events) {
    const payload = record(event.payload);
    if (event.type === "program.semantic_revision.draft.sealed.v1") {
      const shallowDraft = record(payload.draft);
      const embeddedProgramStateId = String(shallowDraft.programStateId ?? "");
      const envelopeProgramStateId = String(event.programStateId ?? "");
      const draftTargetsProgram = embeddedProgramStateId === programStateId;
      const envelopeTargetsProgram = envelopeProgramStateId === programStateId;
      if (!draftTargetsProgram && !envelopeTargetsProgram) continue;

      const draft = payload.draft as ProgramSemanticRevisionDraftV1 | undefined;
      if (draft === undefined) throw new ProgramSemanticRecoveryError("Sealed semantic revision event lacks draft");
      assertProgramSemanticRevisionDraftV1(draft);
      if (!draftTargetsProgram || !envelopeTargetsProgram || envelopeProgramStateId !== draft.programStateId) {
        throw new ProgramSemanticRecoveryError(
          "Sealed semantic revision draft ProgramState identity disagrees with its canonical event envelope",
        );
      }
      if (states.has(draft.draftId)) throw new ProgramSemanticRecoveryError(`Duplicate semantic revision draft ${draft.draftId}`);
      states.set(draft.draftId, { draft, status: "pending" });
      continue;
    }
    if (event.type !== "program.semantic_revision.draft.invalidated.v1"
        && event.type !== "program.semantic_revision.admitted.v1") continue;
    const envelopeProgramStateId = String(event.programStateId ?? "");
    const draftId = String(payload.draftId ?? "");
    const state = states.get(draftId);
    if (state === undefined) {
      if (envelopeProgramStateId !== programStateId) continue;
      throw new ProgramSemanticRecoveryError(`${event.type} targets non-pending semantic revision draft ${draftId}`);
    }
    if (envelopeProgramStateId !== programStateId || envelopeProgramStateId !== state.draft.programStateId) {
      throw new ProgramSemanticRecoveryError(
        `${event.type} ProgramState identity disagrees with its sealed draft event envelope`,
      );
    }
    if (state.status !== "pending") {
      throw new ProgramSemanticRecoveryError(`${event.type} targets non-pending semantic revision draft ${draftId}`);
    }
    if (String(payload.draftDigest ?? "") !== state.draft.draftDigest) {
      throw new ProgramSemanticRecoveryError(`${event.type} draft digest mismatch`);
    }
    if (event.type === "program.semantic_revision.draft.invalidated.v1") {
      state.status = "invalidated";
      continue;
    }
    const cut = payload.cut as ProgramSemanticRevisionCutV1 | undefined;
    if (cut === undefined
        || String(event.eventId) !== state.draft.admissionEventId
        || String(cut.nextSemanticState.currentRevision.sourceDraftId ?? "") !== state.draft.draftId
        || String(cut.nextSemanticState.currentRevision.sourceDraftDigest ?? "") !== state.draft.draftDigest
        || String(cut.nextSemanticState.currentRevision.programRevisionId) !== state.draft.nextProgramRevisionId) {
      throw new ProgramSemanticRecoveryError("Semantic admission does not match its sealed draft");
    }
    state.status = "accepted";
  }
  return states;
}

function publicDraft(state: DraftReplayState): ProgramSemanticRecoveredDraftV1 {
  const draft = state.draft;
  return {
    draftId: draft.draftId,
    draftDigest: draft.draftDigest,
    sourceSessionId: draft.sourceSessionId,
    parentProgramRevisionId: draft.parentProgramRevisionId,
    nextProgramRevisionId: draft.nextProgramRevisionId,
    fromProgramStateRevision: draft.fromProgramStateRevision,
    changeClass: draft.changeClass,
    status: state.status,
  };
}

function pendingPublicDraft(states: ReadonlyMap<string, DraftReplayState>): PublicPendingProgramRevisionV1 | null {
  const pending = [...states.values()].filter((state) => state.status === "pending");
  if (pending.length > 1) throw new ProgramSemanticRecoveryError("Program has multiple pending semantic revision drafts");
  const state = pending[0];
  if (state === undefined) return null;
  const draft = state.draft;
  return {
    programStateId: draft.programStateId,
    draftId: draft.draftId,
    draftDigest: draft.draftDigest,
    parentProgramRevisionId: draft.parentProgramRevisionId,
    nextProgramRevisionId: draft.nextProgramRevisionId,
    fromProgramStateRevision: draft.fromProgramStateRevision,
    changeClass: draft.changeClass,
    sourceSessionId: draft.sourceSessionId,
    status: "pending",
  };
}

export function recoverProgramSemanticStateV1(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
): ProgramSemanticRecoverySnapshotV1 | undefined {
  const baselineEvents = baselineControlEventsForProgram(events, programStateId);
  const baselineControls = reduceProgramSemanticBaselineControlsV1(baselineEvents);
  const baseline = adoptedProgramSemanticBaselineControlV1(baselineControls, programStateId);
  const revisionEvents = events.filter((event) =>
    String(event.programStateId ?? "") === programStateId && event.type.startsWith("program.semantic_revision."));
  if (baseline === undefined) {
    if (revisionEvents.length > 0) throw new ProgramSemanticRecoveryError("Semantic revision history exists without an adopted baseline");
    return undefined;
  }

  const baselineEvent = baselineEvents.find((event) => event.type === "program.semantic_baseline.adopted.v1"
    && String(event.programStateId ?? "") === programStateId
    && String(record(event.payload).draftId ?? "") === baseline.draft.draftId);
  if (baselineEvent === undefined) throw new ProgramSemanticRecoveryError("Adopted baseline control has no canonical adoption event");
  if (revisionEvents.some((event) => event.sequence <= baselineEvent.sequence)) {
    throw new ProgramSemanticRecoveryError("Semantic revision control history precedes explicit baseline adoption");
  }

  let programStateRevision = baseline.draft.cut.toProgramStateRevision;
  let semanticState = structuredClone(baseline.draft.cut.semanticState);
  assertValidProgramSemanticStateV1(semanticState);
  const baselineIdentityImpact = programSemanticBaselineIdentityImpactV1(semanticState);
  if (!sameCanonical(baseline.draft.cut.revisionImpact, baselineIdentityImpact)) {
    throw new ProgramSemanticRecoveryError("Adopted semantic baseline does not carry the deterministic identity RevisionImpact");
  }
  let latestImpact = structuredClone(baselineIdentityImpact);
  const lineage: ProgramSemanticRevisionLineageEntryV1[] = [lineageEntry(semanticState)];
  const drafts = replayDrafts(events, programStateId);

  for (const event of events) {
    if (event.sequence <= baselineEvent.sequence
        || event.type !== "program.semantic_revision.admitted.v1"
        || String(event.programStateId ?? "") !== programStateId) continue;
    const payload = record(event.payload);
    const cut = payload.cut as ProgramSemanticRevisionCutV1 | undefined;
    if (cut === undefined) throw new ProgramSemanticRecoveryError("Semantic admission event lacks cut");
    if (String(event.eventId) !== cut.nextSemanticState.currentRevision.admissionEventId) {
      throw new ProgramSemanticRecoveryError("Semantic admission event identity disagrees with ProgramRevision lineage");
    }
    if (cut.fromProgramStateRevision < programStateRevision) {
      throw new ProgramSemanticRecoveryError("Semantic admission whole-state base predates the recovered semantic head");
    }
    const draftId = String(payload.draftId ?? "");
    const draftState = drafts.get(draftId);
    if (draftState === undefined || draftState.status !== "accepted") {
      throw new ProgramSemanticRecoveryError(`Semantic admission has no accepted sealed draft ${draftId}`);
    }
    assertProgramSemanticRevisionDraftV1(draftState.draft, semanticState);
    const expectedCut = createProgramSemanticRevisionCutFromDraftV1(semanticState, draftState.draft);
    if (!sameCanonical(expectedCut, cut)) {
      throw new ProgramSemanticRecoveryError("Semantic admission cut does not equal the exact digest-sealed draft cut");
    }
    // Operational/control events may advance the whole-state revision between
    // semantic admissions without changing semantic meaning. The sealed draft
    // records the exact operational CAS base for this cut, so replay validates
    // that base monotonically and applies the cut against it.
    const applied = applyProgramSemanticRevisionCutV1(semanticState, cut.fromProgramStateRevision, cut);
    semanticState = applied.semanticState;
    programStateRevision = applied.programStateRevision;
    latestImpact = structuredClone(cut.revisionImpact);
    lineage.push(lineageEntry(semanticState));
  }

  const pendingDraft = pendingPublicDraft(drafts);
  if (pendingDraft !== null && (
    pendingDraft.fromProgramStateRevision < programStateRevision
    || pendingDraft.parentProgramRevisionId !== String(semanticState.currentRevision.programRevisionId)
  )) {
    throw new ProgramSemanticRecoveryError("Pending semantic revision draft targets a stale recovered semantic head");
  }

  return {
    programStateId,
    sourceEventSequence: events.at(-1)?.sequence ?? 0,
    programStateRevision,
    semanticState: structuredClone(semanticState),
    lineage,
    drafts: [...drafts.values()].map(publicDraft).sort((a, b) => a.draftId.localeCompare(b.draftId, "en")),
    pendingDraft,
    latestRevisionImpact: latestImpact,
    latestAttemptDisposition: {
      retainedAttemptIds: latestImpact.retainedAttempts.map(String),
      invalidatedAttemptIds: latestImpact.invalidatedAttempts.map(String),
    },
  };
}

/** Event-only adaptive semantic recovery. It never invokes an Agent or model. */
export class ProgramSemanticRecoveryRegistryV1 {
  constructor(private readonly store: WorkspaceEventStore) {}

  async current(programStateId: string): Promise<ProgramSemanticRecoverySnapshotV1 | undefined> {
    if (!programStateId) throw new ProgramSemanticRecoveryError("programStateId is required");
    return recoverProgramSemanticStateV1(await replayProgramBaselineEvents(this.store), programStateId);
  }

  async isAdaptive(programStateId: string): Promise<boolean> {
    return (await this.current(programStateId)) !== undefined;
  }
}

export interface ProgramSemanticOperationalCurrentnessV1 {
  /** Exact current whole-state CAS revision, including operational/control churn. */
  programStateRevision: number;
  lifecycle: "active" | "completed" | "cancelled";
  attachedSessionIds: string[];
  activeAttempt: ProgramAttemptSemanticAssumptionsV1 | null;
}

/**
 * Operational authority is a separate canonical axis. 6B composes it with the
 * event-recovered semantic head without inferring Attempt state from semantics.
 */
export interface ProgramSemanticOperationalCurrentnessSourceV1 {
  current(programStateId: string): Promise<ProgramSemanticOperationalCurrentnessV1>;
}

export class ProgramSemanticRecoveredCurrentStateSourceV1 implements ProgramSemanticCurrentStateSourceV1 {
  constructor(
    private readonly recovery: ProgramSemanticRecoveryRegistryV1,
    private readonly operational: ProgramSemanticOperationalCurrentnessSourceV1,
  ) {}

  async current(programStateId: string): Promise<ProgramSemanticCurrentSnapshotV1> {
    for (let attempt = 0; attempt < PROGRAM_SEMANTIC_CURRENTNESS_STABILITY_ATTEMPTS; attempt += 1) {
      const semanticBefore = await this.recovery.current(programStateId);
      if (semanticBefore === undefined) {
        throw new ProgramSemanticRecoveryError(`Program ${programStateId} has not adopted adaptive semantics`);
      }
      const operational = await this.operational.current(programStateId);
      if (!Number.isSafeInteger(operational.programStateRevision) || operational.programStateRevision < 1) {
        throw new ProgramSemanticRecoveryError("Operational currentness lacks a positive whole-state revision");
      }
      const semanticAfter = await this.recovery.current(programStateId);
      if (semanticAfter === undefined) {
        throw new ProgramSemanticRecoveryError(`Program ${programStateId} lost adaptive semantic recovery during currentness composition`);
      }

      const semanticHeadStable = semanticBefore.programStateRevision === semanticAfter.programStateRevision
        && sameCanonical(semanticBefore.semanticState, semanticAfter.semanticState);
      if (!semanticHeadStable || operational.programStateRevision < semanticAfter.programStateRevision) continue;

      return {
        programStateRevision: operational.programStateRevision,
        semanticState: structuredClone(semanticAfter.semanticState),
        activeAttempt: structuredClone(operational.activeAttempt),
        lifecycle: operational.lifecycle,
        attachedSessionIds: [...operational.attachedSessionIds],
      };
    }
    throw new ProgramSemanticRecoveryError(
      "Semantic and operational currentness could not be composed at a stable semantic head",
    );
  }
}
