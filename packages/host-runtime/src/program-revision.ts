import {
  asEventId,
  asProgramStateId as asEventProgramStateId,
  asSessionId,
  asWorkspaceId,
  mkEventId,
  uuidv7,
  type EventDraft,
  type PersistedDomainEvent,
  type SessionId,
} from "@alcode/events";
import {
  PROGRAM_LIMITS,
  asProgramRevisionId,
  canonicalStringify,
  createProgramSemanticRevisionCutV1,
  type ProgramAttemptSemanticAssumptionsV1,
  type ProgramChangeClass,
  type ProgramSemanticRevisionCutV1,
  type ProgramSemanticRevisionEditV1,
  type ProgramSemanticStateV1,
  type RevisionImpactV1,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { planningCanonicalDigest } from "./planning-read.ts";

export const PROGRAM_SEMANTIC_REVISION_DRAFT_PROFILE = "program-semantic-revision-draft-v1" as const;

export type NonInitialProgramChangeClassV1 = Exclude<ProgramChangeClass, "initial">;

export interface ProgramSemanticCurrentSnapshotV1 {
  programStateRevision: number;
  semanticState: ProgramSemanticStateV1;
  activeAttempt: ProgramAttemptSemanticAssumptionsV1 | null;
  lifecycle: "active" | "completed" | "cancelled";
  attachedSessionIds: string[];
}

/**
 * Canonical Host projection seam. Product integration may back this with the
 * adaptive Program projection later; this slice deliberately does not convert
 * legacy ProgramState or ProgramAttempt authority in place.
 */
export interface ProgramSemanticCurrentStateSourceV1 {
  current(programStateId: string): Promise<ProgramSemanticCurrentSnapshotV1>;
}

export interface ProgramRevisionAgentProposalV1 {
  planningEpisodeId: string;
  requestId: string;
  programStateId: string;
  parentProgramRevisionId: string;
  proposedChangeClass: NonInitialProgramChangeClassV1;
  proposedEdit: ProgramSemanticRevisionEditV1;
  rationale?: string;
}

/**
 * Agent output is advisory. The Host canonicalizer owns the exact admitted
 * edit and change class; in particular Agent-supplied identity dispositions
 * are never trusted merely because they occur in proposedEdit.
 */
export interface ProgramRevisionHostCanonicalizerV1 {
  canonicalize(input: {
    current: ProgramSemanticCurrentSnapshotV1;
    proposal: ProgramRevisionAgentProposalV1;
  }): Promise<{
    changeClass: NonInitialProgramChangeClassV1;
    edit: ProgramSemanticRevisionEditV1;
  }> | {
    changeClass: NonInitialProgramChangeClassV1;
    edit: ProgramSemanticRevisionEditV1;
  };
}

export interface ProgramRevisionPlanningAgentAuthorityV1 {
  isCurrent(sessionId: string, connectionGenerationId: string, agentGeneration: number): boolean;
}

export interface ProgramRevisionPlanningBeginV1 {
  planningEpisodeId: string;
  requestId: string;
  sourceSessionId: string;
  programStateId: string;
  fromProgramStateRevision: number;
  parentProgramRevisionId: string;
  semanticState: ProgramSemanticStateV1;
}

export interface ProgramSemanticRevisionDraftV1 {
  profile: typeof PROGRAM_SEMANTIC_REVISION_DRAFT_PROFILE;
  draftId: string;
  planningEpisodeId: string;
  sourceSessionId: string;
  programStateId: string;
  fromProgramStateRevision: number;
  parentProgramRevisionId: string;
  nextProgramRevisionId: string;
  changeClass: NonInitialProgramChangeClassV1;
  admissionEventId: string;
  edit: ProgramSemanticRevisionEditV1;
  activeAttempt: ProgramAttemptSemanticAssumptionsV1 | null;
  revisionImpact: RevisionImpactV1;
  rationale?: string;
  draftDigest: string;
}

export interface ProgramSemanticRevisionAcceptedResultV1 {
  status: "admitted" | "existing";
  programStateId: string;
  programStateRevision: number;
  programRevisionId: string;
  draftId: string;
  draftDigest: string;
  cut?: ProgramSemanticRevisionCutV1;
}

export interface PublicPendingProgramRevisionV1 {
  programStateId: string;
  draftId: string;
  draftDigest: string;
  parentProgramRevisionId: string;
  nextProgramRevisionId: string;
  fromProgramStateRevision: number;
  changeClass: NonInitialProgramChangeClassV1;
  sourceSessionId: string;
  status: "pending";
}

export interface ProgramRevisionApplicationAcceptCommandV1 {
  commandId: string;
  clientId: string;
  sourceSessionId: string;
  programStateId: string;
  draftId: string;
  draftDigest: string;
}

export interface ProgramRevisionControlServiceOptionsV1 {
  store: WorkspaceEventStore;
  admission: CanonicalAdmissionQueue;
  currentState: ProgramSemanticCurrentStateSourceV1;
}

export interface ProgramRevisionPlanningServiceOptionsV1 {
  revision: ProgramRevisionControlServiceV1;
  currentState: ProgramSemanticCurrentStateSourceV1;
  agents: ProgramRevisionPlanningAgentAuthorityV1;
  canonicalizer: ProgramRevisionHostCanonicalizerV1;
}

interface DraftControlStateV1 {
  draft: ProgramSemanticRevisionDraftV1;
  status: "pending" | "accepted" | "invalidated";
  acceptedProgramStateRevision?: number;
  acceptedProgramRevisionId?: string;
}

interface ProgramRevisionPlanningEpisodeStateV1 {
  planningEpisodeId: string;
  sourceSessionId: string;
  connectionGenerationId: string;
  agentGeneration: number;
  programStateId: string;
  fromProgramStateRevision: number;
  parentProgramRevisionId: string;
  semanticState: ProgramSemanticStateV1;
  submitted: boolean;
}

const encoder = new TextEncoder();

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requireNonEmpty(label: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProgramRevisionControlError(`${label} must be a non-empty string`);
  }
}

function requirePositive(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ProgramRevisionControlError(`${label} must be a positive safe integer`);
  }
}

function canonicalBytes(value: unknown): number {
  return encoder.encode(canonicalStringify(value)).byteLength;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

function assertRationale(rationale: string | undefined): void {
  if (rationale === undefined) return;
  if (encoder.encode(rationale).byteLength > PROGRAM_LIMITS.semanticRationaleBytes) {
    throw new ProgramRevisionControlError(
      `Semantic rationale exceeds ${PROGRAM_LIMITS.semanticRationaleBytes} bytes`,
    );
  }
}

function draftBody(
  draft: Omit<ProgramSemanticRevisionDraftV1, "draftDigest">,
): Omit<ProgramSemanticRevisionDraftV1, "draftDigest"> {
  return draft;
}

function finalCutFromDraft(
  previous: ProgramSemanticStateV1,
  draft: ProgramSemanticRevisionDraftV1,
): ProgramSemanticRevisionCutV1 {
  return createProgramSemanticRevisionCutV1(previous, {
    currentProgramStateRevision: draft.fromProgramStateRevision,
    nextRevision: {
      programRevisionId: asProgramRevisionId(draft.nextProgramRevisionId),
      parentProgramRevisionId: asProgramRevisionId(draft.parentProgramRevisionId),
      ordinal: previous.currentRevision.ordinal + 1,
      changeClass: draft.changeClass,
      acceptedAtStateRevision: draft.fromProgramStateRevision + 1,
      admissionEventId: draft.admissionEventId,
      sourceDraftId: draft.draftId,
      sourceDraftDigest: draft.draftDigest,
    },
    edit: structuredClone(draft.edit),
    activeAttempt: structuredClone(draft.activeAttempt),
  });
}

export function assertProgramSemanticRevisionDraftV1(
  draft: ProgramSemanticRevisionDraftV1,
  previous?: ProgramSemanticStateV1,
): void {
  if (draft.profile !== PROGRAM_SEMANTIC_REVISION_DRAFT_PROFILE) {
    throw new ProgramRevisionControlError(`Unsupported semantic revision draft profile ${String(draft.profile)}`);
  }
  requireNonEmpty("draftId", draft.draftId);
  requireNonEmpty("planningEpisodeId", draft.planningEpisodeId);
  requireNonEmpty("sourceSessionId", draft.sourceSessionId);
  requireNonEmpty("programStateId", draft.programStateId);
  requirePositive("fromProgramStateRevision", draft.fromProgramStateRevision);
  requireNonEmpty("parentProgramRevisionId", draft.parentProgramRevisionId);
  requireNonEmpty("nextProgramRevisionId", draft.nextProgramRevisionId);
  requireNonEmpty("admissionEventId", draft.admissionEventId);
  assertRationale(draft.rationale);
  if (draft.parentProgramRevisionId === draft.nextProgramRevisionId) {
    throw new ProgramRevisionControlError("Semantic revision draft cannot reuse its parent ProgramRevisionId");
  }
  if (!(["refinement", "correction", "scope_amendment"] as const).includes(draft.changeClass)) {
    throw new ProgramRevisionControlError(`Unsupported semantic revision change class ${String(draft.changeClass)}`);
  }
  const body = {
    profile: draft.profile,
    draftId: draft.draftId,
    planningEpisodeId: draft.planningEpisodeId,
    sourceSessionId: draft.sourceSessionId,
    programStateId: draft.programStateId,
    fromProgramStateRevision: draft.fromProgramStateRevision,
    parentProgramRevisionId: draft.parentProgramRevisionId,
    nextProgramRevisionId: draft.nextProgramRevisionId,
    changeClass: draft.changeClass,
    admissionEventId: draft.admissionEventId,
    edit: draft.edit,
    activeAttempt: draft.activeAttempt,
    revisionImpact: draft.revisionImpact,
    ...(draft.rationale !== undefined ? { rationale: draft.rationale } : {}),
  } satisfies Omit<ProgramSemanticRevisionDraftV1, "draftDigest">;
  if (draft.draftDigest !== planningCanonicalDigest(draftBody(body))) {
    throw new ProgramRevisionControlError("Semantic revision draft digest mismatch");
  }
  if (canonicalBytes(draft) > PROGRAM_LIMITS.sealedPendingSemanticDraftBytes) {
    throw new ProgramRevisionControlError(
      `Sealed semantic revision draft exceeds ${PROGRAM_LIMITS.sealedPendingSemanticDraftBytes} bytes`,
    );
  }
  if (previous !== undefined) {
    if (String(previous.programStateId) !== draft.programStateId) {
      throw new ProgramRevisionControlError("Semantic revision draft belongs to another ProgramState");
    }
    if (String(previous.currentRevision.programRevisionId) !== draft.parentProgramRevisionId) {
      throw new ProgramRevisionStaleError("Semantic revision draft parent is stale");
    }
    const cut = finalCutFromDraft(previous, draft);
    if (!sameCanonical(cut.revisionImpact, draft.revisionImpact)) {
      throw new ProgramRevisionControlError("Sealed RevisionImpact does not match deterministic recomputation");
    }
  }
}

async function replayAll(store: WorkspaceEventStore): Promise<PersistedDomainEvent<string, unknown>[]> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

function sessionIsActive(events: readonly PersistedDomainEvent<string, unknown>[], sessionId: string): boolean {
  let active = false;
  for (const event of events) {
    if (String(event.sessionId) !== sessionId) continue;
    if (event.type === "runtime.session.started") active = true;
    if (event.type === "runtime.session.stopped") active = false;
  }
  return active;
}

function reduceDraftControls(
  events: readonly PersistedDomainEvent<string, unknown>[],
): Map<string, DraftControlStateV1> {
  const drafts = new Map<string, DraftControlStateV1>();
  for (const event of events) {
    const payload = record(event.payload);
    if (event.type === "program.semantic_revision.draft.sealed.v1") {
      const draft = payload.draft as ProgramSemanticRevisionDraftV1 | undefined;
      if (draft === undefined) throw new ProgramRevisionControlError("Sealed semantic revision event lacks draft");
      assertProgramSemanticRevisionDraftV1(draft);
      if (drafts.has(draft.draftId)) {
        throw new ProgramRevisionControlError(`Duplicate semantic revision draft ${draft.draftId}`);
      }
      drafts.set(draft.draftId, { draft, status: "pending" });
      continue;
    }
    if (event.type === "program.semantic_revision.draft.invalidated.v1") {
      const draftId = String(payload.draftId ?? "");
      const current = drafts.get(draftId);
      if (current === undefined || current.status !== "pending") {
        throw new ProgramRevisionControlError(`Invalidation targets non-pending semantic revision draft ${draftId}`);
      }
      if (String(payload.draftDigest ?? "") !== current.draft.draftDigest) {
        throw new ProgramRevisionControlError("Semantic revision draft invalidation digest mismatch");
      }
      current.status = "invalidated";
      continue;
    }
    if (event.type === "program.semantic_revision.admitted.v1") {
      const draftId = String(payload.draftId ?? "");
      const current = drafts.get(draftId);
      if (current === undefined || current.status !== "pending") {
        throw new ProgramRevisionControlError(`Semantic admission targets non-pending draft ${draftId}`);
      }
      const cut = payload.cut as ProgramSemanticRevisionCutV1 | undefined;
      if (cut === undefined || cut.kind !== "program.semantic_revision.admitted.v1") {
        throw new ProgramRevisionControlError("Semantic admission event lacks atomic cut payload");
      }
      if (
        String(payload.draftDigest ?? "") !== current.draft.draftDigest
        || String(cut.nextSemanticState.currentRevision.sourceDraftId ?? "") !== current.draft.draftId
        || String(cut.nextSemanticState.currentRevision.sourceDraftDigest ?? "") !== current.draft.draftDigest
        || String(cut.nextSemanticState.currentRevision.programRevisionId) !== current.draft.nextProgramRevisionId
        || String(event.eventId) !== current.draft.admissionEventId
      ) {
        throw new ProgramRevisionControlError("Semantic admission does not match exact sealed draft");
      }
      current.status = "accepted";
      current.acceptedProgramStateRevision = cut.toProgramStateRevision;
      current.acceptedProgramRevisionId = String(cut.nextSemanticState.currentRevision.programRevisionId);
    }
  }
  return drafts;
}

function latestAdmittedCut(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
): ProgramSemanticRevisionCutV1 | undefined {
  let result: ProgramSemanticRevisionCutV1 | undefined;
  for (const event of events) {
    if (event.type !== "program.semantic_revision.admitted.v1") continue;
    if (String(event.programStateId ?? "") !== programStateId) continue;
    const cut = record(event.payload).cut as ProgramSemanticRevisionCutV1 | undefined;
    if (cut === undefined) throw new ProgramRevisionControlError("Semantic admission event lacks cut");
    result = cut;
  }
  return result;
}

function pendingForProgram(
  controls: ReadonlyMap<string, DraftControlStateV1>,
  programStateId: string,
): DraftControlStateV1 | undefined {
  for (const control of controls.values()) {
    if (control.status === "pending" && control.draft.programStateId === programStateId) return control;
  }
  return undefined;
}

function assertSnapshotShape(snapshot: ProgramSemanticCurrentSnapshotV1, programStateId: string): void {
  requirePositive("current ProgramState revision", snapshot.programStateRevision);
  if (String(snapshot.semanticState.programStateId) !== programStateId) {
    throw new ProgramRevisionControlError("Current semantic projection belongs to another ProgramState");
  }
  if (snapshot.lifecycle !== "active" && snapshot.lifecycle !== "completed" && snapshot.lifecycle !== "cancelled") {
    throw new ProgramRevisionControlError(`Unsupported Program lifecycle ${String(snapshot.lifecycle)}`);
  }
}

function assertSourceReflectsLatestAdmission(
  events: readonly PersistedDomainEvent<string, unknown>[],
  snapshot: ProgramSemanticCurrentSnapshotV1,
  programStateId: string,
): void {
  const latest = latestAdmittedCut(events, programStateId);
  if (latest === undefined) return;
  if (
    snapshot.programStateRevision !== latest.toProgramStateRevision
    || !sameCanonical(snapshot.semanticState, latest.nextSemanticState)
  ) {
    throw new ProgramRevisionControlError(
      "Current semantic source has not incorporated the latest canonical semantic cut",
    );
  }
}

function requireApplicationSession(
  events: readonly PersistedDomainEvent<string, unknown>[],
  snapshot: ProgramSemanticCurrentSnapshotV1,
  sessionId: string,
): void {
  if (!sessionIsActive(events, sessionId)) {
    throw new ProgramRevisionStaleError(`Source session ${sessionId} is not active`);
  }
  if (!snapshot.attachedSessionIds.includes(sessionId)) {
    throw new ProgramRevisionStaleError(`Source session ${sessionId} is not attached to the Program`);
  }
}

function sealedDraftEvent(
  store: WorkspaceEventStore,
  sourceSessionId: SessionId,
  draft: ProgramSemanticRevisionDraftV1,
): EventDraft<string, unknown> {
  return {
    eventId: mkEventId(),
    idempotencyKey: `program.semantic_revision.draft.sealed.v1:${draft.programStateId}:${draft.draftId}`,
    correlationId: draft.planningEpisodeId,
    workspaceId: asWorkspaceId(store.workspaceId),
    sessionId: sourceSessionId,
    programStateId: asEventProgramStateId(draft.programStateId),
    occurredAt: new Date().toISOString(),
    type: "program.semantic_revision.draft.sealed.v1",
    payload: { draft },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-revision" },
  };
}

function invalidationEvent(
  store: WorkspaceEventStore,
  sourceSessionId: SessionId,
  draft: ProgramSemanticRevisionDraftV1,
  reason: string,
): EventDraft<string, unknown> {
  return {
    eventId: mkEventId(),
    idempotencyKey: `program.semantic_revision.draft.invalidated.v1:${draft.draftId}`,
    correlationId: draft.draftId,
    workspaceId: asWorkspaceId(store.workspaceId),
    sessionId: sourceSessionId,
    programStateId: asEventProgramStateId(draft.programStateId),
    occurredAt: new Date().toISOString(),
    type: "program.semantic_revision.draft.invalidated.v1",
    payload: { draftId: draft.draftId, draftDigest: draft.draftDigest, reason },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-revision" },
  };
}

export class ProgramRevisionControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramRevisionControlError";
  }
}

export class ProgramRevisionStaleError extends ProgramRevisionControlError {
  constructor(message: string) {
    super(message);
    this.name = "ProgramRevisionStaleError";
  }
}

export class ProgramRevisionControlServiceV1 {
  constructor(private readonly options: ProgramRevisionControlServiceOptionsV1) {}

  /**
   * Return a planning base serialized with semantic admissions. A planning
   * episode must never start from a projection that has not incorporated the
   * latest canonical semantic cut.
   */
  async currentPlanningBase(programStateId: string): Promise<ProgramSemanticCurrentSnapshotV1> {
    requireNonEmpty("programStateId", programStateId);
    return this.options.admission.enqueue(async () => {
      const events = await replayAll(this.options.store);
      const current = await this.options.currentState.current(programStateId);
      assertSnapshotShape(current, programStateId);
      assertSourceReflectsLatestAdmission(events, current, programStateId);
      return structuredClone(current);
    });
  }

  async sealDraft(input: {
    sourceSessionId: string;
    planningEpisodeId: string;
    programStateId: string;
    expectedProgramStateRevision: number;
    expectedParentProgramRevisionId: string;
    changeClass: NonInitialProgramChangeClassV1;
    edit: ProgramSemanticRevisionEditV1;
    rationale?: string;
    authorityGuard?: () => boolean;
  }): Promise<ProgramSemanticRevisionDraftV1> {
    requireNonEmpty("sourceSessionId", input.sourceSessionId);
    requireNonEmpty("planningEpisodeId", input.planningEpisodeId);
    requireNonEmpty("programStateId", input.programStateId);
    requireNonEmpty("expectedParentProgramRevisionId", input.expectedParentProgramRevisionId);
    requirePositive("expectedProgramStateRevision", input.expectedProgramStateRevision);
    assertRationale(input.rationale);

    const assertAuthority = (): void => {
      if (input.authorityGuard !== undefined && !input.authorityGuard()) {
        throw new ProgramRevisionStaleError("Revision-planning Agent authority became stale before draft sealing");
      }
    };

    return this.options.admission.enqueue(async () => {
      assertAuthority();
      const programStateId = input.programStateId;
      const events = await replayAll(this.options.store);
      const current = await this.options.currentState.current(programStateId);
      assertSnapshotShape(current, programStateId);
      assertSourceReflectsLatestAdmission(events, current, programStateId);
      requireApplicationSession(events, current, input.sourceSessionId);
      if (current.lifecycle !== "active") {
        throw new ProgramRevisionStaleError(`Program ${programStateId} is ${current.lifecycle}`);
      }
      if (
        current.programStateRevision !== input.expectedProgramStateRevision
        || String(current.semanticState.currentRevision.programRevisionId) !== input.expectedParentProgramRevisionId
      ) {
        throw new ProgramRevisionStaleError("Revision proposal targets a stale semantic parent or whole-state revision");
      }

      const controls = reduceDraftControls(events);
      const pending = pendingForProgram(controls, programStateId);
      if (pending !== undefined) {
        const stale = pending.draft.fromProgramStateRevision !== current.programStateRevision
          || pending.draft.parentProgramRevisionId !== String(current.semanticState.currentRevision.programRevisionId);
        if (!stale) {
          throw new ProgramRevisionControlError(`Program ${programStateId} already has a sealed pending semantic draft`);
        }
        assertAuthority();
        await this.options.store.append([
          invalidationEvent(this.options.store, asSessionId(pending.draft.sourceSessionId), pending.draft, "stale_parent"),
        ]);
      }

      const draftId = uuidv7();
      const nextProgramRevisionId = uuidv7();
      const admissionEventId = String(mkEventId());
      const placeholderDigest = "pending-draft-digest";
      const candidateCut = createProgramSemanticRevisionCutV1(current.semanticState, {
        currentProgramStateRevision: current.programStateRevision,
        nextRevision: {
          programRevisionId: asProgramRevisionId(nextProgramRevisionId),
          parentProgramRevisionId: asProgramRevisionId(input.expectedParentProgramRevisionId),
          ordinal: current.semanticState.currentRevision.ordinal + 1,
          changeClass: input.changeClass,
          acceptedAtStateRevision: current.programStateRevision + 1,
          admissionEventId,
          sourceDraftId: draftId,
          sourceDraftDigest: placeholderDigest,
        },
        edit: structuredClone(input.edit),
        activeAttempt: structuredClone(current.activeAttempt),
      });
      const body: Omit<ProgramSemanticRevisionDraftV1, "draftDigest"> = {
        profile: PROGRAM_SEMANTIC_REVISION_DRAFT_PROFILE,
        draftId,
        planningEpisodeId: input.planningEpisodeId,
        sourceSessionId: input.sourceSessionId,
        programStateId,
        fromProgramStateRevision: current.programStateRevision,
        parentProgramRevisionId: input.expectedParentProgramRevisionId,
        nextProgramRevisionId,
        changeClass: input.changeClass,
        admissionEventId,
        edit: structuredClone(input.edit),
        activeAttempt: structuredClone(current.activeAttempt),
        revisionImpact: structuredClone(candidateCut.revisionImpact),
        ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      };
      const draft: ProgramSemanticRevisionDraftV1 = {
        ...body,
        draftDigest: planningCanonicalDigest(draftBody(body)),
      };
      assertProgramSemanticRevisionDraftV1(draft, current.semanticState);
      assertAuthority();
      await this.options.store.append([
        sealedDraftEvent(this.options.store, asSessionId(input.sourceSessionId), draft),
      ]);
      return structuredClone(draft);
    });
  }

  async acceptDraft(input: ProgramRevisionApplicationAcceptCommandV1): Promise<ProgramSemanticRevisionAcceptedResultV1> {
    requireNonEmpty("commandId", input.commandId);
    requireNonEmpty("clientId", input.clientId);
    requireNonEmpty("sourceSessionId", input.sourceSessionId);
    requireNonEmpty("programStateId", input.programStateId);
    requireNonEmpty("draftId", input.draftId);
    requireNonEmpty("draftDigest", input.draftDigest);

    return this.options.admission.enqueue(async () => {
      const events = await replayAll(this.options.store);
      const control = reduceDraftControls(events).get(input.draftId);
      if (control === undefined || control.draft.programStateId !== input.programStateId) {
        throw new ProgramRevisionStaleError(`Unknown semantic revision draft ${input.draftId}`);
      }
      if (control.draft.sourceSessionId !== input.sourceSessionId) {
        throw new ProgramRevisionStaleError("Semantic revision draft is not owned by the accepting Application session");
      }
      if (control.draft.draftDigest !== input.draftDigest) {
        throw new ProgramRevisionStaleError("Semantic revision acceptance digest is stale");
      }
      if (control.status === "accepted") {
        if (control.acceptedProgramStateRevision === undefined || control.acceptedProgramRevisionId === undefined) {
          throw new ProgramRevisionControlError("Accepted semantic revision draft lacks canonical result identity");
        }
        return {
          status: "existing",
          programStateId: control.draft.programStateId,
          programStateRevision: control.acceptedProgramStateRevision,
          programRevisionId: control.acceptedProgramRevisionId,
          draftId: control.draft.draftId,
          draftDigest: control.draft.draftDigest,
        };
      }
      if (control.status !== "pending") {
        throw new ProgramRevisionStaleError(`Semantic revision draft ${input.draftId} is no longer pending`);
      }

      const draft = control.draft;
      const current = await this.options.currentState.current(input.programStateId);
      assertSnapshotShape(current, input.programStateId);
      assertSourceReflectsLatestAdmission(events, current, input.programStateId);
      const invalidateAndStale = async (reason: string, message: string): Promise<never> => {
        await this.options.store.append([
          invalidationEvent(this.options.store, asSessionId(draft.sourceSessionId), draft, reason),
        ]);
        throw new ProgramRevisionStaleError(message);
      };
      if (current.lifecycle !== "active") {
        return invalidateAndStale("program_terminal", `Program is ${current.lifecycle}`);
      }
      try {
        requireApplicationSession(events, current, input.sourceSessionId);
      } catch (error) {
        if (error instanceof ProgramRevisionStaleError) {
          return invalidateAndStale("application_session_stale", error.message);
        }
        throw error;
      }
      if (
        current.programStateRevision !== draft.fromProgramStateRevision
        || String(current.semanticState.currentRevision.programRevisionId) !== draft.parentProgramRevisionId
        || !sameCanonical(current.activeAttempt, draft.activeAttempt)
      ) {
        return invalidateAndStale("stale_parent", "Semantic revision draft parent/current execution assumptions are stale");
      }

      assertProgramSemanticRevisionDraftV1(draft, current.semanticState);
      const cut = finalCutFromDraft(current.semanticState, draft);
      if (!sameCanonical(cut.revisionImpact, draft.revisionImpact)) {
        throw new ProgramRevisionControlError("Accepted semantic cut does not match sealed RevisionImpact");
      }
      const admittedEvent: EventDraft<string, unknown> = {
        eventId: asEventId(draft.admissionEventId),
        idempotencyKey: `program.semantic_revision.admitted.v1:${draft.programStateId}:${draft.nextProgramRevisionId}`,
        correlationId: input.commandId,
        workspaceId: asWorkspaceId(this.options.store.workspaceId),
        sessionId: asSessionId(input.sourceSessionId),
        programStateId: asEventProgramStateId(input.programStateId),
        occurredAt: new Date().toISOString(),
        type: "program.semantic_revision.admitted.v1",
        payload: {
          cut,
          draftId: draft.draftId,
          draftDigest: draft.draftDigest,
          applicationCommandId: input.commandId,
          applicationClientId: input.clientId,
        },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "program-revision" },
      };
      // Exactly one canonical semantic-cut event represents accepted Program
      // meaning. There is deliberately no separate draft.accepted semantic event.
      await this.options.store.append([admittedEvent]);
      return {
        status: "admitted",
        programStateId: draft.programStateId,
        programStateRevision: cut.toProgramStateRevision,
        programRevisionId: String(cut.nextSemanticState.currentRevision.programRevisionId),
        draftId: draft.draftId,
        draftDigest: draft.draftDigest,
        cut: structuredClone(cut),
      };
    });
  }

  async pendingForSession(sourceSessionId: string): Promise<PublicPendingProgramRevisionV1[]> {
    requireNonEmpty("sourceSessionId", sourceSessionId);
    const controls = reduceDraftControls(await replayAll(this.options.store));
    return [...controls.values()]
      .filter((control) => control.status === "pending" && control.draft.sourceSessionId === sourceSessionId)
      .sort((left, right) => left.draft.draftId.localeCompare(right.draft.draftId, "en"))
      .map(({ draft }) => ({
        programStateId: draft.programStateId,
        draftId: draft.draftId,
        draftDigest: draft.draftDigest,
        parentProgramRevisionId: draft.parentProgramRevisionId,
        nextProgramRevisionId: draft.nextProgramRevisionId,
        fromProgramStateRevision: draft.fromProgramStateRevision,
        changeClass: draft.changeClass,
        sourceSessionId: draft.sourceSessionId,
        status: "pending" as const,
      }));
  }
}

/** Explicit Application authority boundary for A1 semantic meaning changes. */
export class HostProgramRevisionApplicationControlV1 {
  constructor(private readonly revision: ProgramRevisionControlServiceV1) {}

  accept(command: ProgramRevisionApplicationAcceptCommandV1): Promise<ProgramSemanticRevisionAcceptedResultV1> {
    return this.revision.acceptDraft(command);
  }

  pendingForSession(sessionId: string): Promise<PublicPendingProgramRevisionV1[]> {
    return this.revision.pendingForSession(sessionId);
  }
}

export class ProgramRevisionPlanningServiceV1 {
  private readonly episodes = new Map<string, ProgramRevisionPlanningEpisodeStateV1>();

  constructor(private readonly options: ProgramRevisionPlanningServiceOptionsV1) {}

  async begin(input: {
    sourceSessionId: string;
    connectionGenerationId: string;
    agentGeneration: number;
    programStateId: string;
  }): Promise<ProgramRevisionPlanningBeginV1> {
    requireNonEmpty("sourceSessionId", input.sourceSessionId);
    requireNonEmpty("connectionGenerationId", input.connectionGenerationId);
    requireNonEmpty("programStateId", input.programStateId);
    requirePositive("agentGeneration", input.agentGeneration);
    if (!this.options.agents.isCurrent(input.sourceSessionId, input.connectionGenerationId, input.agentGeneration)) {
      throw new ProgramRevisionStaleError("Revision-planning Agent authority is stale");
    }
    const current = await this.options.revision.currentPlanningBase(input.programStateId);
    if (!this.options.agents.isCurrent(input.sourceSessionId, input.connectionGenerationId, input.agentGeneration)) {
      throw new ProgramRevisionStaleError("Revision-planning Agent authority became stale while reading the planning base");
    }
    if (current.lifecycle !== "active") throw new ProgramRevisionStaleError(`Program is ${current.lifecycle}`);
    if (!current.attachedSessionIds.includes(input.sourceSessionId)) {
      throw new ProgramRevisionStaleError("Revision-planning session is not attached to the Program");
    }
    const planningEpisodeId = uuidv7();
    const episode: ProgramRevisionPlanningEpisodeStateV1 = {
      planningEpisodeId,
      sourceSessionId: input.sourceSessionId,
      connectionGenerationId: input.connectionGenerationId,
      agentGeneration: input.agentGeneration,
      programStateId: input.programStateId,
      fromProgramStateRevision: current.programStateRevision,
      parentProgramRevisionId: String(current.semanticState.currentRevision.programRevisionId),
      semanticState: structuredClone(current.semanticState),
      submitted: false,
    };
    this.episodes.set(planningEpisodeId, episode);
    return {
      planningEpisodeId,
      requestId: uuidv7(),
      sourceSessionId: input.sourceSessionId,
      programStateId: input.programStateId,
      fromProgramStateRevision: current.programStateRevision,
      parentProgramRevisionId: episode.parentProgramRevisionId,
      semanticState: structuredClone(current.semanticState),
    };
  }

  async submitProposal(input: {
    sourceSessionId: string;
    connectionGenerationId: string;
    agentGeneration: number;
    proposal: ProgramRevisionAgentProposalV1;
  }): Promise<ProgramSemanticRevisionDraftV1> {
    const proposal = input.proposal;
    requireNonEmpty("proposal.requestId", proposal.requestId);
    assertRationale(proposal.rationale);
    if (canonicalBytes(proposal) > PROGRAM_LIMITS.semanticRevisionProposalBytes) {
      throw new ProgramRevisionControlError(
        `Semantic revision proposal exceeds ${PROGRAM_LIMITS.semanticRevisionProposalBytes} bytes`,
      );
    }
    const episode = this.episodes.get(proposal.planningEpisodeId);
    if (
      episode === undefined
      || episode.submitted
      || episode.sourceSessionId !== input.sourceSessionId
      || episode.connectionGenerationId !== input.connectionGenerationId
      || episode.agentGeneration !== input.agentGeneration
      || proposal.programStateId !== episode.programStateId
      || proposal.parentProgramRevisionId !== episode.parentProgramRevisionId
      || !this.options.agents.isCurrent(input.sourceSessionId, input.connectionGenerationId, input.agentGeneration)
    ) {
      throw new ProgramRevisionStaleError("Revision-planning episode or Agent authority is stale");
    }
    episode.submitted = true;
    try {
      const current = await this.options.currentState.current(episode.programStateId);
      if (
        current.programStateRevision !== episode.fromProgramStateRevision
        || String(current.semanticState.currentRevision.programRevisionId) !== episode.parentProgramRevisionId
      ) {
        throw new ProgramRevisionStaleError("Revision-planning semantic parent changed before proposal sealing");
      }
      const canonical = await this.options.canonicalizer.canonicalize({
        current: structuredClone(current),
        proposal: structuredClone(proposal),
      });
      if (!this.options.agents.isCurrent(input.sourceSessionId, input.connectionGenerationId, input.agentGeneration)) {
        throw new ProgramRevisionStaleError("Revision-planning Agent authority became stale during canonicalization");
      }
      return await this.options.revision.sealDraft({
        sourceSessionId: episode.sourceSessionId,
        planningEpisodeId: episode.planningEpisodeId,
        programStateId: episode.programStateId,
        expectedProgramStateRevision: episode.fromProgramStateRevision,
        expectedParentProgramRevisionId: episode.parentProgramRevisionId,
        changeClass: canonical.changeClass,
        edit: structuredClone(canonical.edit),
        ...(proposal.rationale !== undefined ? { rationale: proposal.rationale } : {}),
        authorityGuard: () => this.options.agents.isCurrent(
          input.sourceSessionId,
          input.connectionGenerationId,
          input.agentGeneration,
        ),
      });
    } finally {
      this.episodes.delete(episode.planningEpisodeId);
    }
  }
}
