import {
  asProgramStateId as asEventProgramStateId,
  asSessionId,
  asWorkspaceId,
  mkEventId,
  type EventDraft,
  type PersistedDomainEvent,
} from "@alcode/events";
import {
  assertValidProgramSemanticStateV1,
  assertValidProgramState,
  type ProgramState,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import {
  ProgramSemanticBaselineControlError,
  ProgramSemanticBaselineStaleError,
  assertProgramSemanticBaselineDraftV1,
  baselineRecord,
  baselineRequireNonEmpty,
  baselineSameCanonical,
  programSemanticBaselineIdentityImpactV1,
  type ProgramSemanticBaselineCutV1,
  type ProgramSemanticBaselineDraftV1,
} from "./program-semantic-baseline-kernel.ts";

export interface ProgramSemanticBaselineDraftControlV1 {
  draft: ProgramSemanticBaselineDraftV1;
  status: "pending" | "accepted" | "invalidated";
  acceptedProgramStateRevision?: number;
  acceptedProgramRevisionId?: string;
}

export async function replayProgramBaselineEvents(
  store: WorkspaceEventStore,
): Promise<PersistedDomainEvent<string, unknown>[]> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

function isProgramStateEvent(type: string): boolean {
  return type === "program.created" || type === "program.transitioned"
    || type === "program.completed" || type === "program.cancelled";
}

export function latestLegacyProgramStateForBaseline(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
): ProgramState {
  let latest: ProgramState | undefined;
  for (const event of events) {
    if (!isProgramStateEvent(event.type) || String(event.programStateId ?? "") !== programStateId) continue;
    const state = baselineRecord(event.payload).state as ProgramState | undefined;
    if (state === undefined) throw new ProgramSemanticBaselineControlError(`${event.type} lacks payload.state`);
    assertValidProgramState(state);
    if (String(state.programStateId) !== programStateId) {
      throw new ProgramSemanticBaselineControlError(`${event.type} state identity does not match envelope`);
    }
    latest = state;
  }
  if (latest === undefined) throw new ProgramSemanticBaselineControlError(`Unknown ProgramState ${programStateId}`);
  return latest;
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

export function requireBaselineApplicationSession(
  events: readonly PersistedDomainEvent<string, unknown>[],
  state: ProgramState,
  sessionId: string,
): void {
  if (!sessionIsActive(events, sessionId)) {
    throw new ProgramSemanticBaselineStaleError(`Source session ${sessionId} is not active`);
  }
  if (!state.attachedSessionIds.some((id) => String(id) === sessionId)) {
    throw new ProgramSemanticBaselineStaleError(`Source session ${sessionId} is not attached to the Program`);
  }
}

export function sealedProgramSemanticBaselineDraftEvent(
  store: WorkspaceEventStore,
  draft: ProgramSemanticBaselineDraftV1,
): EventDraft<string, unknown> {
  return {
    eventId: mkEventId(),
    idempotencyKey: `program.semantic_baseline.draft.sealed.v1:${draft.programStateId}:${draft.draftId}`,
    correlationId: draft.draftId,
    workspaceId: asWorkspaceId(store.workspaceId),
    sessionId: asSessionId(draft.sourceSessionId),
    programStateId: asEventProgramStateId(draft.programStateId),
    occurredAt: new Date().toISOString(),
    type: "program.semantic_baseline.draft.sealed.v1",
    payload: { draft },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-semantic-baseline" },
  };
}

export function invalidateProgramSemanticBaselineDraftEvent(
  store: WorkspaceEventStore,
  draft: ProgramSemanticBaselineDraftV1,
  reason: string,
): EventDraft<string, unknown> {
  return {
    eventId: mkEventId(),
    idempotencyKey: `program.semantic_baseline.draft.invalidated.v1:${draft.draftId}`,
    correlationId: draft.draftId,
    workspaceId: asWorkspaceId(store.workspaceId),
    sessionId: asSessionId(draft.sourceSessionId),
    programStateId: asEventProgramStateId(draft.programStateId),
    occurredAt: new Date().toISOString(),
    type: "program.semantic_baseline.draft.invalidated.v1",
    payload: { draftId: draft.draftId, draftDigest: draft.draftDigest, reason },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-semantic-baseline" },
  };
}

export function reduceProgramSemanticBaselineControlsV1(
  events: readonly PersistedDomainEvent<string, unknown>[],
): Map<string, ProgramSemanticBaselineDraftControlV1> {
  const controls = new Map<string, ProgramSemanticBaselineDraftControlV1>();
  const adoptedPrograms = new Set<string>();
  for (const event of events) {
    const payload = baselineRecord(event.payload);
    if (event.type === "program.semantic_baseline.draft.sealed.v1") {
      const draft = payload.draft as ProgramSemanticBaselineDraftV1 | undefined;
      if (draft === undefined) throw new ProgramSemanticBaselineControlError("Sealed baseline event lacks draft");
      assertProgramSemanticBaselineDraftV1(draft);
      if (controls.has(draft.draftId)) throw new ProgramSemanticBaselineControlError(`Duplicate baseline draft ${draft.draftId}`);
      controls.set(draft.draftId, { draft, status: "pending" });
      continue;
    }
    if (event.type === "program.semantic_baseline.draft.invalidated.v1") {
      const draftId = String(payload.draftId ?? "");
      const control = controls.get(draftId);
      if (control === undefined || control.status !== "pending") {
        throw new ProgramSemanticBaselineControlError(`Invalidation targets non-pending baseline draft ${draftId}`);
      }
      if (String(payload.draftDigest ?? "") !== control.draft.draftDigest) {
        throw new ProgramSemanticBaselineControlError("Baseline invalidation digest mismatch");
      }
      control.status = "invalidated";
      continue;
    }
    if (event.type !== "program.semantic_baseline.adopted.v1") continue;
    const draftId = String(payload.draftId ?? "");
    const control = controls.get(draftId);
    const cut = payload.cut as ProgramSemanticBaselineCutV1 | undefined;
    if (control === undefined || control.status !== "pending" || cut === undefined) {
      throw new ProgramSemanticBaselineControlError(`Baseline adoption targets invalid draft ${draftId}`);
    }
    if (String(payload.draftDigest ?? "") !== control.draft.draftDigest
      || !baselineSameCanonical(cut, control.draft.cut)
      || String(event.eventId) !== control.draft.admissionEventId) {
      throw new ProgramSemanticBaselineControlError("Baseline adoption does not match exact sealed draft");
    }
    if (adoptedPrograms.has(control.draft.programStateId)) {
      throw new ProgramSemanticBaselineControlError(`Program ${control.draft.programStateId} has multiple baseline adoptions`);
    }
    adoptedPrograms.add(control.draft.programStateId);
    control.status = "accepted";
    control.acceptedProgramStateRevision = cut.toProgramStateRevision;
    control.acceptedProgramRevisionId = String(cut.semanticState.currentRevision.programRevisionId);
  }
  return controls;
}

export function adoptedProgramSemanticBaselineControlV1(
  controls: ReadonlyMap<string, ProgramSemanticBaselineDraftControlV1>,
  programStateId: string,
): ProgramSemanticBaselineDraftControlV1 | undefined {
  for (const control of controls.values()) {
    if (control.status === "accepted" && control.draft.programStateId === programStateId) return control;
  }
  return undefined;
}

export function pendingProgramSemanticBaselineControlV1(
  controls: ReadonlyMap<string, ProgramSemanticBaselineDraftControlV1>,
  programStateId: string,
): ProgramSemanticBaselineDraftControlV1 | undefined {
  for (const control of controls.values()) {
    if (control.status === "pending" && control.draft.programStateId === programStateId) return control;
  }
  return undefined;
}

/** Durable exact adaptive-mode identity and baseline recovery; no model inference. */
export class ProgramSemanticBaselineRegistryV1 {
  constructor(private readonly store: WorkspaceEventStore) {}

  async isAdopted(programStateId: string): Promise<boolean> {
    baselineRequireNonEmpty("programStateId", programStateId);
    const controls = reduceProgramSemanticBaselineControlsV1(await replayProgramBaselineEvents(this.store));
    return adoptedProgramSemanticBaselineControlV1(controls, programStateId) !== undefined;
  }

  async current(programStateId: string): Promise<ProgramSemanticBaselineCutV1 | undefined> {
    baselineRequireNonEmpty("programStateId", programStateId);
    const control = adoptedProgramSemanticBaselineControlV1(
      reduceProgramSemanticBaselineControlsV1(await replayProgramBaselineEvents(this.store)),
      programStateId,
    );
    if (control === undefined) return undefined;
    assertValidProgramSemanticStateV1(control.draft.cut.semanticState);
    if (!baselineSameCanonical(
      control.draft.cut.revisionImpact,
      programSemanticBaselineIdentityImpactV1(control.draft.cut.semanticState),
    )) {
      throw new ProgramSemanticBaselineControlError("Recovered baseline identity impact is invalid");
    }
    return structuredClone(control.draft.cut);
  }
}
