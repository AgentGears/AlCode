import {
  asProgramStateId as asEventProgramStateId,
  asSessionId,
  asWorkspaceId,
  mkEventId,
  mkProgramStateId,
  uuidv7,
  type EventDraft,
  type PersistedDomainEvent,
  type ProgramStateId as EventProgramStateId,
  type SessionId,
} from "@alcode/events";
import {
  asProgramStateId,
  canonicalStringify,
  createProgramState,
  type Json,
  type ProgramCreationInput,
  type ProgramState,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import {
  PlanningBaseStaleError,
  PlanningReadRegistry,
  assertPlanningObservationIdentity,
  planningCanonicalDigest,
  type PlanningObservationIdentityV1,
} from "./planning-read.ts";

export const PROGRAM_CREATION_DRAFT_PROFILE = "program-creation-draft-v1" as const;
export const PROGRAM_CREATION_DRAFT_MAX_BYTES = 4 * 1024 * 1024;

export interface ExecutionObservationProfileIdentityV1 {
  profileId: string;
  profileVersion: number;
  coverageIdentity: string;
}

export interface ProgramCreationPolicySnapshotV1 {
  generation: string;
  digest: string;
  requirements: Json[];
}

export interface ProgramCreationProposalV1 {
  objective: string;
  workItems: ProgramCreationInput["workItems"];
  verification: ProgramCreationInput["verification"];
  outputSlots: ProgramCreationInput["outputSlots"];
  productionSteps: ProgramCreationInput["productionSteps"];
}

export interface ProgramObjectiveProvenanceV1 {
  kind: "application-objective-v1";
  sourceSessionId: string;
  sourceEventId?: string;
  objectiveDigest: string;
}

export interface ProgramCreationDraftV1 {
  profile: typeof PROGRAM_CREATION_DRAFT_PROFILE;
  draftId: string;
  reservedProgramStateId: string;
  sourceSessionId: string;
  objectiveProvenance: ProgramObjectiveProvenanceV1;
  planningObservationIdentity: PlanningObservationIdentityV1;
  proposal: ProgramCreationProposalV1;
  executionObservationProfile: ExecutionObservationProfileIdentityV1;
  policy: ProgramCreationPolicySnapshotV1;
  draftDigest: string;
}

export interface ProgramCreationProvenanceV1 {
  draftId: string;
  draftDigest: string;
  objectiveProvenance: ProgramObjectiveProvenanceV1;
  acceptedPlanningBase: PlanningObservationIdentityV1;
  executionObservationProfile: ExecutionObservationProfileIdentityV1;
  policy: ProgramCreationPolicySnapshotV1;
}

export interface ProgramCreationAcceptedResult {
  status: "created" | "existing";
  programStateId: EventProgramStateId;
  draftId: string;
  draftDigest: string;
  programState?: ProgramState;
}

export interface ProgramCreationPolicySourceV1 {
  current(): Promise<ProgramCreationPolicySnapshotV1> | ProgramCreationPolicySnapshotV1;
}

export interface ExecutionObservationProfileAuthorityV1 {
  current(): Promise<ExecutionObservationProfileIdentityV1> | ExecutionObservationProfileIdentityV1;
  validate(
    profile: ExecutionObservationProfileIdentityV1,
    proposal: ProgramCreationProposalV1,
  ): Promise<void> | void;
}

/** Required bridge to the Host Workspace mutation coordinator. */
export interface PlanningReadBarrierV1 {
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
}

export interface ProgramCreationServiceOptionsV1 {
  store: WorkspaceEventStore;
  admission: CanonicalAdmissionQueue;
  planningReads: PlanningReadRegistry;
  planningBarrier: PlanningReadBarrierV1;
  policy: ProgramCreationPolicySourceV1;
  executionObservationProfiles: ExecutionObservationProfileAuthorityV1;
}

export class ProgramCreationControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramCreationControlError";
  }
}

export class ProgramCreationStaleError extends ProgramCreationControlError {
  constructor(message: string) {
    super(message);
    this.name = "ProgramCreationStaleError";
  }
}

const encoder = new TextEncoder();

function requireNonEmpty(label: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProgramCreationControlError(`${label} must be a non-empty string`);
  }
}

function requirePositiveVersion(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProgramCreationControlError(`${label} must be a positive safe integer`);
  }
}

function draftBody(draft: Omit<ProgramCreationDraftV1, "draftDigest">): Omit<ProgramCreationDraftV1, "draftDigest"> {
  return draft;
}

function assertPolicySnapshot(policy: ProgramCreationPolicySnapshotV1): void {
  requireNonEmpty("policy.generation", policy.generation);
  requireNonEmpty("policy.digest", policy.digest);
  canonicalStringify(policy.requirements);
}

function assertExecutionProfile(profile: ExecutionObservationProfileIdentityV1): void {
  requireNonEmpty("executionObservationProfile.profileId", profile.profileId);
  requirePositiveVersion("executionObservationProfile.profileVersion", profile.profileVersion);
  requireNonEmpty("executionObservationProfile.coverageIdentity", profile.coverageIdentity);
}

export function assertProgramCreationDraft(draft: ProgramCreationDraftV1): void {
  if (draft.profile !== PROGRAM_CREATION_DRAFT_PROFILE) {
    throw new ProgramCreationControlError(`Unsupported Program creation draft profile ${String(draft.profile)}`);
  }
  requireNonEmpty("draftId", draft.draftId);
  asProgramStateId(draft.reservedProgramStateId);
  asSessionId(draft.sourceSessionId);
  if (draft.objectiveProvenance.kind !== "application-objective-v1") {
    throw new ProgramCreationControlError("Unsupported objective provenance kind");
  }
  if (draft.objectiveProvenance.sourceSessionId !== draft.sourceSessionId) {
    throw new ProgramCreationControlError("Objective provenance source session does not match draft source session");
  }
  if (draft.objectiveProvenance.objectiveDigest !== planningCanonicalDigest(draft.proposal.objective)) {
    throw new ProgramCreationControlError("Objective provenance digest mismatch");
  }
  assertPlanningObservationIdentity(draft.planningObservationIdentity);
  assertPolicySnapshot(draft.policy);
  assertExecutionProfile(draft.executionObservationProfile);

  createProgramState({
    programStateId: asProgramStateId(draft.reservedProgramStateId),
    sourceSessionId: draft.sourceSessionId as ProgramCreationInput["sourceSessionId"],
    objective: draft.proposal.objective,
    workItems: draft.proposal.workItems,
    verification: draft.proposal.verification,
    outputSlots: draft.proposal.outputSlots,
    productionSteps: draft.proposal.productionSteps,
    creationPolicyRequirements: draft.policy.requirements,
  });

  const expectedDigest = planningCanonicalDigest(draftBody({
    profile: draft.profile,
    draftId: draft.draftId,
    reservedProgramStateId: draft.reservedProgramStateId,
    sourceSessionId: draft.sourceSessionId,
    objectiveProvenance: draft.objectiveProvenance,
    planningObservationIdentity: draft.planningObservationIdentity,
    proposal: draft.proposal,
    executionObservationProfile: draft.executionObservationProfile,
    policy: draft.policy,
  }));
  if (draft.draftDigest !== expectedDigest) {
    throw new ProgramCreationControlError("Program creation draft digest mismatch");
  }
  if (encoder.encode(canonicalStringify(draft)).byteLength > PROGRAM_CREATION_DRAFT_MAX_BYTES) {
    throw new ProgramCreationControlError(
      `Program creation draft exceeds ${PROGRAM_CREATION_DRAFT_MAX_BYTES} canonical bytes`,
    );
  }
}

interface DraftControlState {
  draft: ProgramCreationDraftV1;
  status: "pending" | "accepted" | "invalidated";
  acceptedProgramStateId?: string;
  acceptedCommandId?: string;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function replayAll(store: WorkspaceEventStore): Promise<PersistedDomainEvent<string, unknown>[]> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

function sessionIsActive(events: readonly PersistedDomainEvent<string, unknown>[], sessionId: string): boolean {
  let started = false;
  let stopped = false;
  for (const event of events) {
    if (String(event.sessionId) !== sessionId) continue;
    if (event.type === "runtime.session.started") started = true;
    if (event.type === "runtime.session.stopped") stopped = true;
  }
  return started && !stopped;
}

function reduceDraftControls(
  events: readonly PersistedDomainEvent<string, unknown>[],
): Map<string, DraftControlState> {
  const drafts = new Map<string, DraftControlState>();
  for (const event of events) {
    const payload = record(event.payload);
    if (event.type === "program.creation.draft.sealed") {
      const draft = payload.draft as ProgramCreationDraftV1 | undefined;
      if (draft === undefined) throw new ProgramCreationControlError("Sealed creation event lacks draft");
      assertProgramCreationDraft(draft);
      if (drafts.has(draft.draftId)) {
        throw new ProgramCreationControlError(`Duplicate canonical Program creation draft ${draft.draftId}`);
      }
      drafts.set(draft.draftId, { draft, status: "pending" });
      continue;
    }
    if (event.type === "program.creation.draft.accepted") {
      const draftId = String(payload.draftId ?? "");
      const state = drafts.get(draftId);
      if (state === undefined || state.status !== "pending") {
        throw new ProgramCreationControlError(`Acceptance targets non-pending creation draft ${draftId}`);
      }
      state.status = "accepted";
      state.acceptedProgramStateId = String(payload.programStateId ?? "");
      state.acceptedCommandId = String(payload.commandId ?? "");
      continue;
    }
    if (event.type === "program.creation.draft.invalidated") {
      const draftId = String(payload.draftId ?? "");
      const state = drafts.get(draftId);
      if (state === undefined || state.status !== "pending") {
        throw new ProgramCreationControlError(`Invalidation targets non-pending creation draft ${draftId}`);
      }
      state.status = "invalidated";
    }
  }
  return drafts;
}

function sessionHasCreationBinding(
  events: readonly PersistedDomainEvent<string, unknown>[],
  sessionId: string,
): boolean {
  const controls = reduceDraftControls(events);
  for (const control of controls.values()) {
    if (
      control.draft.sourceSessionId === sessionId &&
      (control.status === "pending" || control.status === "accepted")
    ) {
      return true;
    }
  }

  for (const event of events) {
    if (event.type !== "program.created") continue;
    const state = record(record(event.payload).state);
    const attached = state.attachedSessionIds;
    if (Array.isArray(attached) && attached.some((value) => String(value) === sessionId)) {
      return true;
    }
  }
  return false;
}

function creationDraftEvent(
  store: WorkspaceEventStore,
  sessionId: SessionId,
  draft: ProgramCreationDraftV1,
): EventDraft<string, unknown> {
  return {
    eventId: mkEventId(),
    idempotencyKey: `program.creation.draft.sealed:${draft.draftId}`,
    correlationId: draft.draftId,
    workspaceId: asWorkspaceId(store.workspaceId),
    sessionId,
    occurredAt: new Date().toISOString(),
    type: "program.creation.draft.sealed",
    payload: { draft },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-creation" },
  };
}

function buildProgramState(draft: ProgramCreationDraftV1): ProgramState {
  return createProgramState({
    programStateId: asProgramStateId(draft.reservedProgramStateId),
    sourceSessionId: draft.sourceSessionId as ProgramCreationInput["sourceSessionId"],
    objective: draft.proposal.objective,
    workItems: draft.proposal.workItems,
    verification: draft.proposal.verification,
    outputSlots: draft.proposal.outputSlots,
    productionSteps: draft.proposal.productionSteps,
    creationPolicyRequirements: draft.policy.requirements,
  });
}

function sameCanonical(a: unknown, b: unknown): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}

export class ProgramCreationServiceV1 {
  constructor(private readonly options: ProgramCreationServiceOptionsV1) {}

  async sealDraft(input: {
    sourceSessionId: SessionId;
    proposal: ProgramCreationProposalV1;
    planningObservationIdentity: PlanningObservationIdentityV1;
    sourceObjectiveEventId?: string;
  }): Promise<ProgramCreationDraftV1> {
    assertPlanningObservationIdentity(input.planningObservationIdentity);
    if (input.planningObservationIdentity.workspaceIdentity !== this.options.store.workspaceId) {
      throw new ProgramCreationControlError("Planning identity belongs to another Workspace");
    }

    return this.options.admission.enqueue(async () => {
      const events = await replayAll(this.options.store);
      const sourceSessionId = String(input.sourceSessionId);
      if (!sessionIsActive(events, sourceSessionId)) {
        throw new ProgramCreationStaleError(`Source session ${sourceSessionId} is not active`);
      }
      if (sessionHasCreationBinding(events, sourceSessionId)) {
        throw new ProgramCreationControlError(
          `Source session ${sourceSessionId} already has a pending or accepted Program binding`,
        );
      }

      const policy = await this.options.policy.current();
      assertPolicySnapshot(policy);
      const executionObservationProfile = await this.options.executionObservationProfiles.current();
      assertExecutionProfile(executionObservationProfile);
      await this.options.executionObservationProfiles.validate(executionObservationProfile, input.proposal);

      const draftId = uuidv7();
      const reservedProgramStateId = String(mkProgramStateId());
      const objectiveProvenance: ProgramObjectiveProvenanceV1 = {
        kind: "application-objective-v1",
        sourceSessionId,
        ...(input.sourceObjectiveEventId !== undefined ? { sourceEventId: input.sourceObjectiveEventId } : {}),
        objectiveDigest: planningCanonicalDigest(input.proposal.objective),
      };
      const body: Omit<ProgramCreationDraftV1, "draftDigest"> = {
        profile: PROGRAM_CREATION_DRAFT_PROFILE,
        draftId,
        reservedProgramStateId,
        sourceSessionId,
        objectiveProvenance,
        planningObservationIdentity: input.planningObservationIdentity,
        proposal: input.proposal,
        executionObservationProfile,
        policy,
      };
      const draft: ProgramCreationDraftV1 = {
        ...body,
        draftDigest: planningCanonicalDigest(draftBody(body)),
      };
      assertProgramCreationDraft(draft);
      await this.options.store.append([creationDraftEvent(this.options.store, input.sourceSessionId, draft)]);
      return draft;
    });
  }

  async acceptDraft(input: {
    draftId: string;
    draftDigest: string;
    commandId: string;
  }): Promise<ProgramCreationAcceptedResult> {
    requireNonEmpty("draftId", input.draftId);
    requireNonEmpty("draftDigest", input.draftDigest);
    requireNonEmpty("commandId", input.commandId);

    return this.options.planningBarrier.runExclusive(() =>
      this.options.admission.enqueue(async () => {
        const events = await replayAll(this.options.store);
        const control = reduceDraftControls(events).get(input.draftId);
        if (control === undefined) {
          throw new ProgramCreationStaleError(`Unknown Program creation draft ${input.draftId}`);
        }
        if (control.draft.draftDigest !== input.draftDigest) {
          throw new ProgramCreationStaleError("Program creation acceptance digest is stale");
        }
        if (control.status === "accepted") {
          if (!control.acceptedProgramStateId) {
            throw new ProgramCreationControlError("Accepted creation draft lacks ProgramStateId");
          }
          return {
            status: "existing",
            programStateId: asEventProgramStateId(control.acceptedProgramStateId),
            draftId: control.draft.draftId,
            draftDigest: control.draft.draftDigest,
          };
        }
        if (control.status !== "pending") {
          throw new ProgramCreationStaleError(`Program creation draft ${input.draftId} is no longer pending`);
        }
        const draft = control.draft;
        assertProgramCreationDraft(draft);
        if (!sessionIsActive(events, draft.sourceSessionId)) {
          throw new ProgramCreationStaleError(`Source session ${draft.sourceSessionId} stopped before acceptance`);
        }

        const currentPolicy = await this.options.policy.current();
        assertPolicySnapshot(currentPolicy);
        if (!sameCanonical(currentPolicy, draft.policy)) {
          throw new ProgramCreationStaleError("Creation policy changed after draft sealing");
        }
        const currentExecutionProfile = await this.options.executionObservationProfiles.current();
        assertExecutionProfile(currentExecutionProfile);
        if (!sameCanonical(currentExecutionProfile, draft.executionObservationProfile)) {
          throw new ProgramCreationStaleError("Execution observation profile changed after draft sealing");
        }
        await this.options.executionObservationProfiles.validate(currentExecutionProfile, draft.proposal);

        try {
          await this.options.planningReads.recheck(draft.planningObservationIdentity);
        } catch (error) {
          if (error instanceof PlanningBaseStaleError) {
            throw new ProgramCreationStaleError(error.message);
          }
          throw error;
        }

        const state = buildProgramState(draft);
        const eventProgramStateId = asEventProgramStateId(draft.reservedProgramStateId);
        const sourceSessionId = asSessionId(draft.sourceSessionId);
        const occurredAt = new Date().toISOString();
        const provenance: ProgramCreationProvenanceV1 = {
          draftId: draft.draftId,
          draftDigest: draft.draftDigest,
          objectiveProvenance: draft.objectiveProvenance,
          acceptedPlanningBase: draft.planningObservationIdentity,
          executionObservationProfile: draft.executionObservationProfile,
          policy: draft.policy,
        };
        const drafts: EventDraft<string, unknown>[] = [
          {
            eventId: mkEventId(),
            idempotencyKey: `program.creation.draft.accepted:${draft.draftId}`,
            correlationId: input.commandId,
            workspaceId: asWorkspaceId(this.options.store.workspaceId),
            sessionId: sourceSessionId,
            programStateId: eventProgramStateId,
            occurredAt,
            type: "program.creation.draft.accepted",
            payload: {
              draftId: draft.draftId,
              draftDigest: draft.draftDigest,
              commandId: input.commandId,
              programStateId: draft.reservedProgramStateId,
            },
            payloadSchemaVersion: 1,
            producer: { kind: "runtime", component: "program-creation" },
          },
          {
            eventId: mkEventId(),
            idempotencyKey: `program.created:${draft.reservedProgramStateId}`,
            correlationId: input.commandId,
            workspaceId: asWorkspaceId(this.options.store.workspaceId),
            sessionId: sourceSessionId,
            programStateId: eventProgramStateId,
            occurredAt,
            type: "program.created",
            payload: { state, creation: provenance },
            payloadSchemaVersion: 1,
            producer: { kind: "runtime", component: "program-creation" },
          },
        ];
        await this.options.store.append(drafts);
        return {
          status: "created",
          programStateId: eventProgramStateId,
          draftId: draft.draftId,
          draftDigest: draft.draftDigest,
          programState: state,
        };
      }),
    );
  }

  async recheckAcceptedPlanningBase(programStateId: EventProgramStateId): Promise<void> {
    await this.options.planningBarrier.runExclusive(async () => {
      const events = await replayAll(this.options.store);
      const created = events.find(
        (event) => event.type === "program.created" && String(event.programStateId ?? "") === String(programStateId),
      );
      if (created === undefined) {
        throw new ProgramCreationControlError(`Unknown ProgramState ${String(programStateId)}`);
      }
      const creation = record(created.payload).creation as ProgramCreationProvenanceV1 | undefined;
      if (creation === undefined) {
        throw new ProgramCreationControlError(`Program ${String(programStateId)} lacks creation provenance`);
      }
      assertPlanningObservationIdentity(creation.acceptedPlanningBase);
      if (creation.acceptedPlanningBase.workspaceIdentity !== this.options.store.workspaceId) {
        throw new ProgramCreationControlError("Accepted planning base belongs to another Workspace");
      }
      await this.options.planningReads.recheck(creation.acceptedPlanningBase);
    });
  }
}

export async function buildPendingCreationInvalidations(
  store: WorkspaceEventStore,
  sessionId: SessionId,
  occurredAt: string,
): Promise<EventDraft<string, unknown>[]> {
  const events = await replayAll(store);
  const controls = reduceDraftControls(events);
  const drafts: EventDraft<string, unknown>[] = [];
  for (const control of controls.values()) {
    if (control.status !== "pending" || control.draft.sourceSessionId !== String(sessionId)) continue;
    drafts.push({
      eventId: mkEventId(),
      idempotencyKey: `program.creation.draft.invalidated:${control.draft.draftId}`,
      correlationId: control.draft.draftId,
      workspaceId: asWorkspaceId(store.workspaceId),
      sessionId,
      occurredAt,
      type: "program.creation.draft.invalidated",
      payload: {
        draftId: control.draft.draftId,
        draftDigest: control.draft.draftDigest,
        reason: "source_session_stopped",
      },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "program-creation" },
    });
  }
  return drafts;
}
