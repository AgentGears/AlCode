import type {
  ProgramCommand,
  PublicProgram,
  PublicProgramCreation,
  PublicProgramOmissions,
} from "@alcode/application-protocol";
import {
  asProgramStateId as asEventProgramStateId,
  asSessionId as asEventSessionId,
  asWorkspaceId,
  mkEventId,
  type EventDraft,
  type PersistedDomainEvent,
  type SessionId as EventSessionId,
} from "@alcode/events";
import {
  ProgramRevisionConflictError,
  ProgramTransitionError,
  applyProgramTransition,
  asProgramStateId,
  asSessionId,
  isVerificationCurrent,
  type ProgramState,
} from "@alcode/program-state";
import { reduceOperationsFromEvents, type WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { ProgramCreationControlError, ProgramCreationStaleError, type ProgramCreationAcceptedResult } from "./program-creation.ts";
import { ProgramDispatchControlError, ProgramDispatchStaleError } from "./program-dispatch.ts";
import { ProgramTerminalControlError, ProgramTerminalStaleError, type ProgramCancellationResultV1 } from "./program-terminal.ts";

export const APPLICATION_PROGRAM_PROJECTION_MAX_BYTES = 256 * 1024;
const MAX_PUBLIC_PROGRAMS = 8;
const MAX_PENDING_CREATIONS = 8;
const MAX_WORK_ITEMS = 16;
const MAX_BLOCKERS = 16;
const MAX_VERIFICATION = 32;
const MAX_ATTACHED_SESSIONS = 16;
const MAX_OBJECTIVE_CHARS = 4096;
const MAX_WORK_DESCRIPTION_CHARS = 1024;
const MAX_BLOCKER_REASON_CHARS = 1024;

export interface ProgramCreationApplicationAuthorityV1 {
  acceptDraft(input: { draftId: string; draftDigest: string; commandId: string }): Promise<ProgramCreationAcceptedResult>;
}
export interface ProgramRebaseApplicationAuthorityV1 {
  acceptRebase(input: { programStateId: string; expectedProgramRevision: number; mismatchReceiptId: string; sessionId: EventSessionId }): Promise<ProgramState>;
}
export interface ProgramCancellationApplicationAuthorityV1 {
  cancel(input: { programStateId: string; expectedProgramRevision: number; sessionId: EventSessionId; actor?: string; client?: string; reason?: string }): Promise<ProgramCancellationResultV1>;
}

export interface ProgramApplicationSnapshotV1 {
  programs: PublicProgram[];
  pendingProgramCreations: PublicProgramCreation[];
  programOmissions: PublicProgramOmissions;
}

export interface ProgramApplicationCommandResultV1 {
  decision: "accepted" | "rejected" | "stale" | "duplicate" | "noop";
  reasonCode?: string;
  programStateId?: string;
  programRevision?: number;
  draftId?: string;
}

export interface ProgramApplicationPortV1 {
  execute(command: ProgramCommand): Promise<ProgramApplicationCommandResultV1>;
  getSnapshot(sessionId: string): Promise<ProgramApplicationSnapshotV1>;
}

export interface HostProgramApplicationControlOptionsV1 {
  store: WorkspaceEventStore;
  admission: CanonicalAdmissionQueue;
  creation: ProgramCreationApplicationAuthorityV1;
  dispatch: ProgramRebaseApplicationAuthorityV1;
  terminal: ProgramCancellationApplicationAuthorityV1;
}

interface DraftControl {
  draftId: string;
  draftDigest: string;
  sourceSessionId: string;
  objective: string;
  status: "pending" | "accepted" | "invalidated";
  programStateId?: string;
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

function isProgramStateEvent(type: string): boolean {
  return type === "program.created" || type === "program.transitioned" || type === "program.completed" || type === "program.cancelled";
}

function latestProgramStates(events: readonly PersistedDomainEvent<string, unknown>[]): Map<string, ProgramState> {
  const states = new Map<string, ProgramState>();
  for (const event of events) {
    if (!isProgramStateEvent(event.type) || event.programStateId === undefined) continue;
    const state = record(event.payload).state as ProgramState | undefined;
    if (state !== undefined) states.set(String(event.programStateId), state);
  }
  return states;
}

function reduceDrafts(events: readonly PersistedDomainEvent<string, unknown>[]): Map<string, DraftControl> {
  const drafts = new Map<string, DraftControl>();
  for (const event of events) {
    const payload = record(event.payload);
    if (event.type === "program.creation.draft.sealed") {
      const draft = record(payload.draft);
      const proposal = record(draft.proposal);
      const draftId = String(draft.draftId ?? "");
      if (draftId) {
        drafts.set(draftId, {
          draftId,
          draftDigest: String(draft.draftDigest ?? ""),
          sourceSessionId: String(draft.sourceSessionId ?? event.sessionId),
          objective: String(proposal.objective ?? ""),
          status: "pending",
        });
      }
      continue;
    }
    if (event.type === "program.creation.draft.accepted") {
      const draftId = String(payload.draftId ?? "");
      const current = drafts.get(draftId);
      if (current) drafts.set(draftId, { ...current, status: "accepted", programStateId: String(payload.programStateId ?? "") });
      continue;
    }
    if (event.type === "program.creation.draft.invalidated") {
      const draftId = String(payload.draftId ?? "");
      const current = drafts.get(draftId);
      if (current) drafts.set(draftId, { ...current, status: "invalidated" });
    }
  }
  return drafts;
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

function requireProgramState(events: readonly PersistedDomainEvent<string, unknown>[], programStateId: string): ProgramState {
  const state = latestProgramStates(events).get(programStateId);
  if (state === undefined) throw new ProgramApplicationStaleError(`Unknown ProgramState ${programStateId}`);
  return state;
}

function requireExactRevision(state: ProgramState, expectedProgramRevision: number): void {
  if (state.revision !== expectedProgramRevision) throw new ProgramRevisionConflictError(expectedProgramRevision, state.revision);
}

function requireAttachedActiveSession(events: readonly PersistedDomainEvent<string, unknown>[], state: ProgramState, sessionId: string): void {
  if (!sessionIsActive(events, sessionId)) throw new ProgramApplicationStaleError(`Session ${sessionId} is not active`);
  if (!state.attachedSessionIds.some((id) => String(id) === sessionId)) {
    throw new ProgramApplicationStaleError(`Session ${sessionId} is not attached to Program ${String(state.programStateId)}`);
  }
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function operationOwnership(events: readonly PersistedDomainEvent<string, unknown>[]): Map<string, string> {
  const owners = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "operation.requested" || event.programStateId === undefined) continue;
    const operationId = String(record(event.payload).operationId ?? event.operationId ?? "");
    if (operationId) owners.set(operationId, String(event.programStateId));
  }
  return owners;
}

function projectProgram(
  state: ProgramState,
  events: readonly PersistedDomainEvent<string, unknown>[],
): PublicProgram {
  const workSource = state.workItems.slice(0, MAX_WORK_ITEMS);
  const workItems = workSource.map((work) => ({
    workItemId: String(work.workItemId),
    lifecycle: work.lifecycle,
    description: clip(work.description, MAX_WORK_DESCRIPTION_CHARS),
  }));
  const blockerSource = state.blockers.filter((blocker) => blocker.state === "open").slice(0, MAX_BLOCKERS);
  const blockers = blockerSource.map((blocker) => ({
    blockerId: String(blocker.blockerId),
    workItemId: blocker.workItemId === null ? null : String(blocker.workItemId),
    reason: clip(blocker.reason, MAX_BLOCKER_REASON_CHARS),
  }));
  const verificationSource = state.verification.slice(0, MAX_VERIFICATION);
  const verification = verificationSource.map((obligation) => {
    const kind = obligation.predicate.kind;
    if (kind !== "operation_result" && kind !== "workspace_path_state" && kind !== "artifact_present") {
      throw new ProgramCreationControlError(`Unsupported canonical verification predicate ${String(kind)}`);
    }
    return {
      obligationId: String(obligation.obligationId),
      kind,
      subjectGeneration: obligation.subjectGeneration,
      status: obligation.waiver?.subjectGeneration === obligation.subjectGeneration
        ? "waived" as const
        : isVerificationCurrent(obligation) ? "current" as const : "stale" as const,
    };
  });
  const attachedSessionIds = state.attachedSessionIds.slice(0, MAX_ATTACHED_SESSIONS).map(String);
  const activeAttempt = state.activeAttempt === null ? undefined : {
    programAttemptId: String(state.activeAttempt.programAttemptId),
    workItemId: String(state.activeAttempt.workItemId),
    sessionId: String(state.activeAttempt.sessionId),
    agentGeneration: state.activeAttempt.agentGeneration,
  };
  const currentWorkItemId = activeAttempt?.workItemId ??
    state.workItems.find((work) => work.lifecycle === "in_progress" || work.lifecycle === "awaiting_verification" || work.lifecycle === "blocked")?.workItemId;

  const owners = operationOwnership(events);
  const operations = reduceOperationsFromEvents(events).filter((operation) =>
    owners.get(operation.operationId) === String(state.programStateId));
  const outstandingOperations = operations.filter((operation) => operation.lifecycleState !== "terminal").length;
  const indeterminateEffects = operations.filter((operation) => operation.effectStatus === "indeterminate").length;
  const unresolvedReconciliation = operations.filter((operation) =>
    operation.reconciliationStatus === "pending" || operation.reconciliationStatus === "unresolved").length;

  const mismatch = state.executionBaseMismatch === null ? undefined : {
    receiptId: String(state.executionBaseMismatch.receiptId),
    currentWorkspaceEffectGeneration: state.executionBaseMismatch.currentWorkspaceEffectGeneration,
    currentObservationIdentity: structuredClone(state.executionBaseMismatch.currentObservationIdentity),
  };

  return {
    programStateId: String(state.programStateId),
    revision: state.revision,
    objective: clip(state.objective, MAX_OBJECTIVE_CHARS),
    lifecycle: state.lifecycle,
    attachedSessionIds,
    workItems,
    ...(currentWorkItemId !== undefined ? { currentWorkItemId: String(currentWorkItemId) } : {}),
    blockers,
    verification,
    ...(activeAttempt !== undefined ? { activeAttempt } : {}),
    control: {
      rebaseRequired: state.executionBaseMismatch !== null,
      executionBaseUnavailable: state.executionBaseUnavailable,
      ...(mismatch !== undefined ? { mismatch } : {}),
    },
    uncertainty: { outstandingOperations, indeterminateEffects, unresolvedReconciliation },
    omissions: {
      workItems: Math.max(0, state.workItems.length - workItems.length),
      blockers: Math.max(0, state.blockers.filter((blocker) => blocker.state === "open").length - blockers.length),
      verification: Math.max(0, state.verification.length - verification.length),
      attachedSessions: Math.max(0, state.attachedSessionIds.length - attachedSessionIds.length),
    },
  };
}

function transitionDraft(
  store: WorkspaceEventStore,
  sessionId: EventSessionId,
  state: ProgramState,
  transitionKind: string,
  commandId: string,
): EventDraft<string, unknown> {
  return {
    eventId: mkEventId(),
    idempotencyKey: `program.transitioned:${String(state.programStateId)}:${state.revision}`,
    correlationId: commandId,
    workspaceId: asWorkspaceId(store.workspaceId),
    sessionId,
    programStateId: asEventProgramStateId(String(state.programStateId)),
    occurredAt: new Date().toISOString(),
    type: "program.transitioned",
    payload: { state, transitionKind, applicationCommandId: commandId },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-application" },
  };
}

export class ProgramApplicationStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramApplicationStaleError";
  }
}

export class HostProgramApplicationControlV1 implements ProgramApplicationPortV1 {
  constructor(private readonly options: HostProgramApplicationControlOptionsV1) {}

  async execute(command: ProgramCommand): Promise<ProgramApplicationCommandResultV1> {
    try {
      switch (command.type) {
        case "program.creation.accept":
          return await this.acceptCreation(command);
        case "program.rebase.accept":
          return await this.acceptRebase(command);
        case "program.cancel":
          return await this.cancel(command);
        case "program.session.attach":
          return await this.changeAttachment(command, true);
        case "program.session.detach":
          return await this.changeAttachment(command, false);
      }
    } catch (error) {
      if (error instanceof ProgramApplicationStaleError || error instanceof ProgramRevisionConflictError ||
          error instanceof ProgramCreationStaleError || error instanceof ProgramDispatchStaleError ||
          error instanceof ProgramTerminalStaleError) {
        return { decision: "stale", reasonCode: error.name };
      }
      if (error instanceof ProgramTransitionError || error instanceof ProgramCreationControlError ||
          error instanceof ProgramDispatchControlError || error instanceof ProgramTerminalControlError) {
        return { decision: "rejected", reasonCode: error.name };
      }
      throw error;
    }
  }

  async getSnapshot(sessionId: string): Promise<ProgramApplicationSnapshotV1> {
    const events = await replayAll(this.options.store);
    const visibleSource = [...latestProgramStates(events).values()]
      .filter((state) => state.attachedSessionIds.some((id) => String(id) === sessionId))
      .sort((a, b) => String(a.programStateId).localeCompare(String(b.programStateId), "en"));
    const visiblePrograms = visibleSource.slice(0, MAX_PUBLIC_PROGRAMS).map((state) => projectProgram(state, events));
    const pendingSource = [...reduceDrafts(events).values()]
      .filter((draft) => draft.status === "pending" && draft.sourceSessionId === sessionId)
      .sort((a, b) => a.draftId.localeCompare(b.draftId, "en"));
    const pendingProgramCreations = pendingSource.slice(0, MAX_PENDING_CREATIONS).map((draft) => ({
      draftId: draft.draftId,
      draftDigest: draft.draftDigest,
      objective: clip(draft.objective, MAX_OBJECTIVE_CHARS),
      sourceSessionId: draft.sourceSessionId,
      status: "pending" as const,
    }));
    const result: ProgramApplicationSnapshotV1 = {
      programs: visiblePrograms,
      pendingProgramCreations,
      programOmissions: {
        programs: Math.max(0, visibleSource.length - visiblePrograms.length),
        pendingCreations: Math.max(0, pendingSource.length - pendingProgramCreations.length),
      },
    };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > APPLICATION_PROGRAM_PROJECTION_MAX_BYTES) {
      throw new ProgramCreationControlError(`Application Program projection exceeds ${APPLICATION_PROGRAM_PROJECTION_MAX_BYTES} bytes`);
    }
    return result;
  }

  private async acceptCreation(command: Extract<ProgramCommand, { type: "program.creation.accept" }>): Promise<ProgramApplicationCommandResultV1> {
    const events = await replayAll(this.options.store);
    const draft = reduceDrafts(events).get(command.draftId);
    if (draft === undefined || draft.sourceSessionId !== command.sessionId) {
      throw new ProgramApplicationStaleError("Program creation draft is not owned by the command session");
    }
    const result = await this.options.creation.acceptDraft({ draftId: command.draftId, draftDigest: command.draftDigest, commandId: command.commandId });
    return {
      decision: result.status === "existing" ? "duplicate" : "accepted",
      programStateId: String(result.programStateId),
      ...(result.programState !== undefined ? { programRevision: result.programState.revision } : {}),
      draftId: result.draftId,
    };
  }

  private async acceptRebase(command: Extract<ProgramCommand, { type: "program.rebase.accept" }>): Promise<ProgramApplicationCommandResultV1> {
    const events = await replayAll(this.options.store);
    const state = requireProgramState(events, String(asProgramStateId(command.programStateId)));
    requireExactRevision(state, command.expectedProgramRevision);
    requireAttachedActiveSession(events, state, command.sessionId);
    const next = await this.options.dispatch.acceptRebase({
      programStateId: command.programStateId,
      expectedProgramRevision: command.expectedProgramRevision,
      mismatchReceiptId: command.mismatchReceiptId,
      sessionId: asEventSessionId(command.sessionId),
    });
    return { decision: "accepted", programStateId: String(next.programStateId), programRevision: next.revision };
  }

  private async cancel(command: Extract<ProgramCommand, { type: "program.cancel" }>): Promise<ProgramApplicationCommandResultV1> {
    const events = await replayAll(this.options.store);
    const state = requireProgramState(events, String(asProgramStateId(command.programStateId)));
    if (state.lifecycle === "active") {
      requireExactRevision(state, command.expectedProgramRevision);
      requireAttachedActiveSession(events, state, command.sessionId);
    }
    const result = await this.options.terminal.cancel({
      programStateId: command.programStateId,
      expectedProgramRevision: command.expectedProgramRevision,
      sessionId: asEventSessionId(command.sessionId),
      actor: "application",
      client: command.clientId,
      ...(command.reason !== undefined ? { reason: command.reason } : {}),
    });
    return {
      decision: result.duplicate ? "duplicate" : "accepted",
      programStateId: String(result.state.programStateId),
      programRevision: result.state.revision,
    };
  }

  private async changeAttachment(
    command: Extract<ProgramCommand, { type: "program.session.attach" | "program.session.detach" }>,
    attach: boolean,
  ): Promise<ProgramApplicationCommandResultV1> {
    return this.options.admission.enqueue(async () => {
      const events = await replayAll(this.options.store);
      const state = requireProgramState(events, String(asProgramStateId(command.programStateId)));
      requireExactRevision(state, command.expectedProgramRevision);
      if (!sessionIsActive(events, command.sessionId)) throw new ProgramApplicationStaleError("Application session is not active");
      const next = applyProgramTransition(state, attach ? {
        kind: "session.attach",
        expectedProgramRevision: state.revision,
        sessionId: asSessionId(command.sessionId),
      } : {
        kind: "session.detach",
        expectedProgramRevision: state.revision,
        sessionId: asSessionId(command.sessionId),
      });
      if (next === state) {
        return { decision: "noop", programStateId: String(state.programStateId), programRevision: state.revision };
      }
      await this.options.store.append([
        transitionDraft(this.options.store, asEventSessionId(command.sessionId), next, attach ? "session.attach" : "session.detach", command.commandId),
      ]);
      return { decision: "accepted", programStateId: String(next.programStateId), programRevision: next.revision };
    });
  }
}
