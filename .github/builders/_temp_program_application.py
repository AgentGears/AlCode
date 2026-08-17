from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"anchor not found in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


# ---- Application Protocol: exact Program commands and bounded public read model. ----
p = Path("packages/application-protocol/src/types.ts")
s = p.read_text()
s = s.replace(
    'export interface PermissionRespondCommand extends ApplicationCommandBase { type: "permission.respond"; interactionId: string; decision: PermissionDecision; }\nexport type ApplicationCommand = InputSubmitCommand | ExecutionCancelCommand | QueuePromoteCommand | PermissionRespondCommand;\n',
    '''export interface PermissionRespondCommand extends ApplicationCommandBase { type: "permission.respond"; interactionId: string; decision: PermissionDecision; }\n\nexport interface ProgramCreationAcceptCommand extends ApplicationCommandBase { type: "program.creation.accept"; draftId: string; draftDigest: string; }\nexport interface ProgramRebaseAcceptCommand extends ApplicationCommandBase { type: "program.rebase.accept"; programStateId: string; expectedProgramRevision: number; mismatchReceiptId: string; }\nexport interface ProgramCancelCommand extends ApplicationCommandBase { type: "program.cancel"; programStateId: string; expectedProgramRevision: number; reason?: string; }\nexport interface ProgramSessionAttachCommand extends ApplicationCommandBase { type: "program.session.attach"; programStateId: string; expectedProgramRevision: number; }\nexport interface ProgramSessionDetachCommand extends ApplicationCommandBase { type: "program.session.detach"; programStateId: string; expectedProgramRevision: number; }\nexport type ProgramCommand = ProgramCreationAcceptCommand | ProgramRebaseAcceptCommand | ProgramCancelCommand | ProgramSessionAttachCommand | ProgramSessionDetachCommand;\n\nexport type ApplicationCommand = InputSubmitCommand | ExecutionCancelCommand | QueuePromoteCommand | PermissionRespondCommand | ProgramCommand;\n''',
    1,
)
s = s.replace(
    'export interface CommandDecision { protocolVersion: ApplicationProtocolVersion; commandId: ApplicationCommandId; sessionId: string; decision: CommandDecisionKind; cursor: ApplicationCursor; reasonCode?: string; admittedDisposition?: AdmittedDisposition; queueItemId?: string; targetExecutionId?: string; }\n',
    'export interface CommandDecision { protocolVersion: ApplicationProtocolVersion; commandId: ApplicationCommandId; sessionId: string; decision: CommandDecisionKind; cursor: ApplicationCursor; reasonCode?: string; admittedDisposition?: AdmittedDisposition; queueItemId?: string; targetExecutionId?: string; programStateId?: string; programRevision?: number; draftId?: string; }\n',
    1,
)
s = s.replace(
    'export interface PublicSessionState { sessionId: string; status: "active" | "stopped"; activeExecutionId?: string; }\n\nexport interface PublicPlugin',
    '''export interface PublicSessionState { sessionId: string; status: "active" | "stopped"; activeExecutionId?: string; }\n\nexport type PublicProgramLifecycle = "active" | "completed" | "cancelled";\nexport interface PublicProgramWorkItem { workItemId: string; lifecycle: "pending" | "in_progress" | "awaiting_verification" | "blocked" | "completed"; description: string; }\nexport interface PublicProgramBlocker { blockerId: string; workItemId: string | null; reason: string; }\nexport interface PublicProgramVerification { obligationId: string; kind: "operation_result" | "workspace_path_state" | "artifact_present"; subjectGeneration: number; status: "current" | "waived" | "stale"; }\nexport interface PublicProgramAttempt { programAttemptId: string; workItemId: string; sessionId: string; agentGeneration: number; }\nexport interface PublicProgramObservationIdentity { kind: "workspace-observation-v1"; providerKind: string; workspaceIdentity: string; coverageDigest: string; stateDigest: string; }\nexport interface PublicProgramMismatch { receiptId: string; currentWorkspaceEffectGeneration: number; currentObservationIdentity: PublicProgramObservationIdentity; }\nexport interface PublicProgram {\n  programStateId: string; revision: number; objective: string; lifecycle: PublicProgramLifecycle; attachedSessionIds: string[];\n  workItems: PublicProgramWorkItem[]; currentWorkItemId?: string; blockers: PublicProgramBlocker[]; verification: PublicProgramVerification[]; activeAttempt?: PublicProgramAttempt;\n  control: { rebaseRequired: boolean; executionBaseUnavailable: boolean; mismatch?: PublicProgramMismatch };\n  uncertainty: { outstandingOperations: number; indeterminateEffects: number; unresolvedReconciliation: number };\n  omissions: { workItems: number; blockers: number; verification: number; attachedSessions: number };\n}\nexport interface PublicProgramCreation { draftId: string; draftDigest: string; objective: string; sourceSessionId: string; status: "pending"; }\nexport interface PublicProgramOmissions { programs: number; pendingCreations: number; }\n\nexport interface PublicPlugin''',
    1,
)
s = s.replace(
    'export interface ApplicationSnapshot { protocolVersion: ApplicationProtocolVersion; sessionId: string; cursor: ApplicationCursor; session: PublicSessionState; transcript: PublicTranscriptMessage[]; executions: PublicForegroundExecution[]; operations: PublicOperation[]; queue: PublicQueueItem[]; pendingInteractions: PublicPermissionInteraction[]; plugins?: PublicPlugin[]; }\n',
    'export interface ApplicationSnapshot { protocolVersion: ApplicationProtocolVersion; sessionId: string; cursor: ApplicationCursor; session: PublicSessionState; transcript: PublicTranscriptMessage[]; executions: PublicForegroundExecution[]; operations: PublicOperation[]; queue: PublicQueueItem[]; pendingInteractions: PublicPermissionInteraction[]; plugins?: PublicPlugin[]; programs?: PublicProgram[]; pendingProgramCreations?: PublicProgramCreation[]; programOmissions?: PublicProgramOmissions; }\n',
    1,
)
p.write_text(s)

# Validation for exact Program commands.
p = Path("packages/application-protocol/src/validation.ts")
s = p.read_text()
s = s.replace(
    'function permissionDecision(value: unknown): PermissionDecision {\n',
    '''function positiveRevision(value: unknown): number {\n  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {\n    throw new ApplicationProtocolValidationError("expectedProgramRevision must be a positive safe integer");\n  }\n  return value;\n}\n\nfunction optionalBoundedReason(value: unknown): string | undefined {\n  if (value === undefined) return undefined;\n  const reason = requiredString(value, "reason");\n  if (reason.length > 4096) throw new ApplicationProtocolValidationError("reason exceeds 4096 characters");\n  return reason;\n}\n\nfunction permissionDecision(value: unknown): PermissionDecision {\n''',
    1,
)
anchor = '''    case "permission.respond":\n      return {\n        ...common,\n        type: "permission.respond",\n        interactionId: requiredString(input.interactionId, "interactionId"),\n        decision: permissionDecision(input.decision),\n      };\n'''
insert = anchor + '''    case "program.creation.accept":\n      return {\n        ...common,\n        type: "program.creation.accept",\n        draftId: requiredString(input.draftId, "draftId"),\n        draftDigest: requiredString(input.draftDigest, "draftDigest"),\n      };\n    case "program.rebase.accept":\n      return {\n        ...common,\n        type: "program.rebase.accept",\n        programStateId: requiredString(input.programStateId, "programStateId"),\n        expectedProgramRevision: positiveRevision(input.expectedProgramRevision),\n        mismatchReceiptId: requiredString(input.mismatchReceiptId, "mismatchReceiptId"),\n      };\n    case "program.cancel": {\n      const reason = optionalBoundedReason(input.reason);\n      return {\n        ...common,\n        type: "program.cancel",\n        programStateId: requiredString(input.programStateId, "programStateId"),\n        expectedProgramRevision: positiveRevision(input.expectedProgramRevision),\n        ...(reason !== undefined ? { reason } : {}),\n      };\n    }\n    case "program.session.attach":\n      return {\n        ...common,\n        type: "program.session.attach",\n        programStateId: requiredString(input.programStateId, "programStateId"),\n        expectedProgramRevision: positiveRevision(input.expectedProgramRevision),\n      };\n    case "program.session.detach":\n      return {\n        ...common,\n        type: "program.session.detach",\n        programStateId: requiredString(input.programStateId, "programStateId"),\n        expectedProgramRevision: positiveRevision(input.expectedProgramRevision),\n      };\n'''
if anchor not in s: raise SystemExit("validation permission anchor not found")
s = s.replace(anchor, insert, 1)
p.write_text(s)

# Exports for additive Program protocol surface.
p = Path("packages/application-protocol/src/index.ts")
s = p.read_text()
s = s.replace(
    '  type InputSubmitCommand, type ExecutionCancelCommand, type QueuePromoteCommand, type PermissionDecision, type PermissionRespondCommand, type ApplicationCommand,\n',
    '  type InputSubmitCommand, type ExecutionCancelCommand, type QueuePromoteCommand, type PermissionDecision, type PermissionRespondCommand,\n  type ProgramCreationAcceptCommand, type ProgramRebaseAcceptCommand, type ProgramCancelCommand, type ProgramSessionAttachCommand, type ProgramSessionDetachCommand, type ProgramCommand, type ApplicationCommand,\n',
    1,
)
s = s.replace(
    '  type PublicReconciliationStatus, type PublicOperation, type PublicForegroundExecution, type PublicQueueItem, type PublicPermissionInteraction, type PublicSessionState, type PublicPlugin,\n',
    '  type PublicReconciliationStatus, type PublicOperation, type PublicForegroundExecution, type PublicQueueItem, type PublicPermissionInteraction, type PublicSessionState,\n  type PublicProgramLifecycle, type PublicProgramWorkItem, type PublicProgramBlocker, type PublicProgramVerification, type PublicProgramAttempt, type PublicProgramObservationIdentity, type PublicProgramMismatch, type PublicProgram, type PublicProgramCreation, type PublicProgramOmissions, type PublicPlugin,\n',
    1,
)
p.write_text(s)

# Protocol tests.
Path("packages/application-protocol/src/program-validation.test.ts").write_text(r'''import { describe, expect, it } from "vitest";
import { ApplicationProtocolValidationError, parseApplicationCommand } from "./index.ts";

const common = {
  protocolVersion: 1 as const,
  commandId: "command-1",
  clientId: "client-1",
  sessionId: "session-1",
  issuedAt: new Date(0).toISOString(),
};

describe("Phase 1 Program Application commands", () => {
  it("parses exact creation/rebase/cancel/session commands", () => {
    expect(parseApplicationCommand({ ...common, type: "program.creation.accept", draftId: "draft-1", draftDigest: "digest-1" })).toMatchObject({ type: "program.creation.accept", draftId: "draft-1" });
    expect(parseApplicationCommand({ ...common, type: "program.rebase.accept", programStateId: "program-1", expectedProgramRevision: 4, mismatchReceiptId: "receipt-1" })).toMatchObject({ type: "program.rebase.accept", expectedProgramRevision: 4 });
    expect(parseApplicationCommand({ ...common, type: "program.cancel", programStateId: "program-1", expectedProgramRevision: 4, reason: "stop" })).toMatchObject({ type: "program.cancel", reason: "stop" });
    expect(parseApplicationCommand({ ...common, type: "program.session.attach", programStateId: "program-1", expectedProgramRevision: 4 })).toMatchObject({ type: "program.session.attach" });
    expect(parseApplicationCommand({ ...common, type: "program.session.detach", programStateId: "program-1", expectedProgramRevision: 4 })).toMatchObject({ type: "program.session.detach" });
  });

  it("rejects non-exact revisions and unbounded cancellation reasons", () => {
    expect(() => parseApplicationCommand({ ...common, type: "program.cancel", programStateId: "program-1", expectedProgramRevision: 0 })).toThrow(ApplicationProtocolValidationError);
    expect(() => parseApplicationCommand({ ...common, type: "program.cancel", programStateId: "program-1", expectedProgramRevision: 2.5 })).toThrow(ApplicationProtocolValidationError);
    expect(() => parseApplicationCommand({ ...common, type: "program.cancel", programStateId: "program-1", expectedProgramRevision: 2, reason: "x".repeat(4097) })).toThrow(/4096/);
  });
});
''')

# ---- Host Program Application control/read model. ----
Path("packages/host-runtime/src/program-application.ts").write_text(r'''import type {
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
  const verification = verificationSource.map((obligation) => ({
    obligationId: String(obligation.obligationId),
    kind: obligation.predicate.kind,
    subjectGeneration: obligation.subjectGeneration,
    status: obligation.waiver?.subjectGeneration === obligation.subjectGeneration
      ? "waived" as const
      : isVerificationCurrent(obligation) ? "current" as const : "stale" as const,
  }));
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
''')

# Export Program Application port/control.
p = Path("packages/host-runtime/src/index.ts")
s = p.read_text()
if 'from "./program-application.ts"' not in s:
    s += '''\nexport {\n  HostProgramApplicationControlV1,\n  ProgramApplicationStaleError,\n  APPLICATION_PROGRAM_PROJECTION_MAX_BYTES,\n  type ProgramCreationApplicationAuthorityV1,\n  type ProgramRebaseApplicationAuthorityV1,\n  type ProgramCancellationApplicationAuthorityV1,\n  type ProgramApplicationSnapshotV1,\n  type ProgramApplicationCommandResultV1,\n  type ProgramApplicationPortV1,\n  type HostProgramApplicationControlOptionsV1,\n} from "./program-application.ts";\n'''
p.write_text(s)

# ---- Existing HostApplicationService delegates exact Program commands and always snapshots Program truth on reconnect. ----
p = Path("packages/host-runtime/src/application-service.ts")
s = p.read_text()
s = s.replace(
    '  type PermissionDecision,\n',
    '  type PermissionDecision,\n  type ProgramCommand,\n',
    1,
)
s = s.replace(
    'import { CanonicalAdmissionQueue } from "./admission-queue.ts";\n',
    'import { CanonicalAdmissionQueue } from "./admission-queue.ts";\nimport type { ProgramApplicationPortV1 } from "./program-application.ts";\n',
    1,
)
s = s.replace(
    '  maxReplayEvents?: number;\n}',
    '  maxReplayEvents?: number;\n  program?: ProgramApplicationPortV1;\n}',
    1,
)
s = s.replace(
    '    ...(decision.targetExecutionId !== undefined ? { targetExecutionId: decision.targetExecutionId } : {}),\n',
    '    ...(decision.targetExecutionId !== undefined ? { targetExecutionId: decision.targetExecutionId } : {}),\n    ...(decision.programStateId !== undefined ? { programStateId: decision.programStateId } : {}),\n    ...(decision.programRevision !== undefined ? { programRevision: decision.programRevision } : {}),\n    ...(decision.draftId !== undefined ? { draftId: decision.draftId } : {}),\n',
    1,
)
old_snapshot = '''    return reduceApplicationEvents(initial, events);\n  }\n\n  async recover(sessionId: string, cursor?: ApplicationCursor): Promise<ApplicationRecoveryResult> {\n    const snapshot = await this.getSnapshot(sessionId);\n    if (cursor === undefined) return { mode: "snapshot", snapshot, reason: "initial" };\n    if (cursor === snapshot.cursor) return { mode: "resume", fromCursor: cursor, toCursor: cursor, events: [] };\n'''
new_snapshot = '''    const snapshot = reduceApplicationEvents(initial, events);\n    if (this.options.program === undefined) return snapshot;\n    const program = await this.options.program.getSnapshot(sessionId);\n    return { ...snapshot, ...program };\n  }\n\n  async recover(sessionId: string, cursor?: ApplicationCursor): Promise<ApplicationRecoveryResult> {\n    const snapshot = await this.getSnapshot(sessionId);\n    if (cursor === undefined) return { mode: "snapshot", snapshot, reason: "initial" };\n    // ProgramState may advance under another attached Session. Until the public\n    // stream carries a dedicated cross-session Program delta cursor, a reconnect\n    // with Program projection enabled returns the bounded current snapshot rather\n    // than pretending a session-local event resume is authoritative.\n    if (this.options.program !== undefined) {\n      return { mode: "snapshot", snapshot, reason: "history_unavailable" };\n    }\n    if (cursor === snapshot.cursor) return { mode: "resume", fromCursor: cursor, toCursor: cursor, events: [] };\n'''
if old_snapshot not in s: raise SystemExit("application snapshot/recover anchor not found")
s = s.replace(old_snapshot, new_snapshot, 1)
old_switch = '''      case "permission.respond":\n        return this.handlePermissionResponse(command);\n    }\n  }\n'''
new_switch = '''      case "permission.respond":\n        return this.handlePermissionResponse(command);\n      case "program.creation.accept":\n      case "program.rebase.accept":\n      case "program.cancel":\n      case "program.session.attach":\n      case "program.session.detach":\n        return this.handleProgramCommand(command);\n    }\n  }\n'''
if old_switch not in s: raise SystemExit("application execute switch anchor not found")
s = s.replace(old_switch, new_switch, 1)
anchor = '''  private async handleInput(command: Extract<ApplicationCommand, { type: "input.submit" }>): Promise<CommandDecision> {\n'''
method = '''  private async handleProgramCommand(command: ProgramCommand): Promise<CommandDecision> {\n    if (this.options.program === undefined) {\n      return this.finishDecision(command, "rejected", { reasonCode: "program_not_supported" });\n    }\n    const result = await this.options.program.execute(command);\n    return this.finishDecision(command, result.decision, {\n      ...(result.reasonCode !== undefined ? { reasonCode: result.reasonCode } : {}),\n      ...(result.programStateId !== undefined ? { programStateId: result.programStateId } : {}),\n      ...(result.programRevision !== undefined ? { programRevision: result.programRevision } : {}),\n      ...(result.draftId !== undefined ? { draftId: result.draftId } : {}),\n    });\n  }\n\n'''
if anchor not in s: raise SystemExit("application handleInput anchor not found")
s = s.replace(anchor, method + anchor, 1)
# Duplicate decisions must preserve Program result identity.
s = s.replace(
    '      const targetExecutionId = optionalString(payload.targetExecutionId);\n      return {\n',
    '      const targetExecutionId = optionalString(payload.targetExecutionId);\n      const programStateId = optionalString(payload.programStateId);\n      const programRevision = typeof payload.programRevision === "number" ? payload.programRevision : undefined;\n      const draftId = optionalString(payload.draftId);\n      return {\n',
    1,
)
s = s.replace(
    '        ...(targetExecutionId !== undefined ? { targetExecutionId } : {}),\n      };\n',
    '        ...(targetExecutionId !== undefined ? { targetExecutionId } : {}),\n        ...(programStateId !== undefined ? { programStateId } : {}),\n        ...(programRevision !== undefined ? { programRevision } : {}),\n        ...(draftId !== undefined ? { draftId } : {}),\n      };\n',
    1,
)
p.write_text(s)

# ---- Tests: control, cross-session snapshot, delegation, Application service reconnect semantics. ----
Path("packages/host-runtime/src/program-application.test.ts").write_text(r'''import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APPLICATION_PROTOCOL_VERSION, type ProgramCommand } from "@alcode/application-protocol";
import { asProgramStateId as asEventProgramStateId, asWorkspaceId, mkEventId, mkProgramStateId, uuidv7 } from "@alcode/events";
import { applyProgramTransition, asProgramStateId, asProgramWorkItemId, asSessionId, createProgramState, type ProgramState } from "@alcode/program-state";
import { openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { HostApplicationService } from "./application-service.ts";
import { HostProgramApplicationControlV1, APPLICATION_PROGRAM_PROJECTION_MAX_BYTES, type ProgramApplicationPortV1 } from "./program-application.ts";
import { HostSessionManager } from "./session-manager.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;
const stores: LockedWorkspaceStore[] = [];
const dirs: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) { try { store.close(); } catch {} } for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function latestState(store: LockedWorkspaceStore, id: string): Promise<ProgramState> { let latest: ProgramState | undefined; for await (const event of store.store.replay()) if (String(event.programStateId ?? "") === id && ["program.created","program.transitioned","program.completed","program.cancelled"].includes(event.type)) latest = (event.payload as { state: ProgramState }).state; if (!latest) throw new Error("missing ProgramState"); return latest; }

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "alcode-program-application-")); dirs.push(dir);
  const locked = await openLockedWorkspaceStore({ databasePath: join(dir,"workspace.sqlite"), lockPath: join(dir,"workspace.lock"), workspaceId: asWorkspaceId(uuidv7()), repositoryId: uuidv7() }); stores.push(locked);
  const admission = new CanonicalAdmissionQueue(locked.store);
  const sessions = new HostSessionManager(locked, admission);
  const sessionA = await sessions.openOrResume();
  const sessionB = await sessions.openOrResume();
  const workItemId = asProgramWorkItemId("work-1");
  const initial = createProgramState({ programStateId: asProgramStateId(String(mkProgramStateId())), sourceSessionId: asSessionId(String(sessionA.sessionId)), objective: "Durable objective", workItems: [{ workItemId, creationOrder: 0, description: "Do work", dependencyIds: [], affectedPaths: [] }], verification: [], outputSlots: [], productionSteps: [] });
  await admission.append([{ eventId: mkEventId(), workspaceId: asWorkspaceId(locked.store.workspaceId), sessionId: sessionA.sessionId, programStateId: asEventProgramStateId(String(initial.programStateId)), occurredAt: new Date().toISOString(), type: "program.created", payload: { state: initial }, payloadSchemaVersion: 1, producer: { kind: "runtime", component: "program-application-test" } }]);
  const calls: Record<string, unknown>[] = [];
  const control = new HostProgramApplicationControlV1({
    store: locked.store,
    admission,
    creation: { acceptDraft: async (input) => { calls.push({ kind: "creation", ...input }); return { status: "existing" as const, programStateId: asEventProgramStateId(String(initial.programStateId)), draftId: input.draftId, draftDigest: input.draftDigest }; } },
    dispatch: { acceptRebase: async (input) => { calls.push({ kind: "rebase", ...input }); return latestState(locked, input.programStateId); } },
    terminal: { cancel: async (input) => { calls.push({ kind: "cancel", ...input }); const state = await latestState(locked, input.programStateId); return { status: "cancelled" as const, state, duplicate: true }; } },
  });
  return { locked, admission, sessionA, sessionB, initial, workItemId, control, calls };
}

function command<T extends ProgramCommand>(sessionId: string, value: Omit<T, "protocolVersion" | "commandId" | "clientId" | "sessionId" | "issuedAt">): T {
  return { protocolVersion: APPLICATION_PROTOCOL_VERSION, commandId: uuidv7(), clientId: "client-1", sessionId, issuedAt: new Date().toISOString(), ...value } as T;
}

describeLocked("Host Program Application control", () => {
  it("attaches/detaches a second Session at exact revisions and projects current cross-session truth", async () => {
    const f = await setup();
    const attached = await f.control.execute(command(String(f.sessionB.sessionId), { type: "program.session.attach", programStateId: String(f.initial.programStateId), expectedProgramRevision: f.initial.revision }));
    expect(attached.decision).toBe("accepted");
    const afterAttach = await latestState(f.locked, String(f.initial.programStateId));
    expect(afterAttach.attachedSessionIds.map(String)).toContain(String(f.sessionB.sessionId));

    const advanced = applyProgramTransition(afterAttach, { kind: "work.lifecycle.set", expectedProgramRevision: afterAttach.revision, workItemId: f.workItemId, lifecycle: "in_progress" });
    await f.admission.append([{ eventId: mkEventId(), workspaceId: asWorkspaceId(f.locked.store.workspaceId), sessionId: f.sessionA.sessionId, programStateId: asEventProgramStateId(String(advanced.programStateId)), occurredAt: new Date().toISOString(), type: "program.transitioned", payload: { state: advanced, transitionKind: "work.lifecycle.set" }, payloadSchemaVersion: 1, producer: { kind: "runtime", component: "program-application-test" } }]);
    const snapshot = await f.control.getSnapshot(String(f.sessionB.sessionId));
    expect(snapshot.programs[0]).toMatchObject({ programStateId: String(f.initial.programStateId), revision: advanced.revision, currentWorkItemId: String(f.workItemId) });
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(APPLICATION_PROGRAM_PROJECTION_MAX_BYTES);

    const detached = await f.control.execute(command(String(f.sessionB.sessionId), { type: "program.session.detach", programStateId: String(f.initial.programStateId), expectedProgramRevision: advanced.revision }));
    expect(detached.decision).toBe("accepted");
    expect((await f.control.getSnapshot(String(f.sessionB.sessionId))).programs).toHaveLength(0);
  });

  it("delegates rebase/cancel with exact authority and records Application client provenance", async () => {
    const f = await setup();
    const rebase = await f.control.execute(command(String(f.sessionA.sessionId), { type: "program.rebase.accept", programStateId: String(f.initial.programStateId), expectedProgramRevision: f.initial.revision, mismatchReceiptId: "receipt-1" }));
    expect(rebase.decision).toBe("accepted");
    expect(f.calls[0]).toMatchObject({ kind: "rebase", expectedProgramRevision: f.initial.revision, mismatchReceiptId: "receipt-1" });
    const cancelled = await f.control.execute(command(String(f.sessionA.sessionId), { type: "program.cancel", programStateId: String(f.initial.programStateId), expectedProgramRevision: f.initial.revision, reason: "user stop" }));
    expect(cancelled.decision).toBe("duplicate");
    expect(f.calls[1]).toMatchObject({ kind: "cancel", actor: "application", client: "client-1", reason: "user stop" });
  });

  it("forces reconnect to the current Program snapshot instead of claiming session-local delta authority", async () => {
    const f = await setup();
    const fakeProgram: ProgramApplicationPortV1 = {
      execute: (cmd) => f.control.execute(cmd),
      getSnapshot: (sessionId) => f.control.getSnapshot(sessionId),
    };
    const app = new HostApplicationService({ store: f.locked.store, admission: f.admission, program: fakeProgram, agent: { start: async () => true, guide: async () => true, cancel: async () => true } });
    const first = await app.getSnapshot(String(f.sessionA.sessionId));
    expect(first.programs?.[0]?.programStateId).toBe(String(f.initial.programStateId));
    const recovered = await app.recover(String(f.sessionA.sessionId), first.cursor);
    expect(recovered.mode).toBe("snapshot");
    if (recovered.mode !== "snapshot") throw new Error("expected current snapshot");
    expect(recovered.reason).toBe("history_unavailable");
    expect(recovered.snapshot.programs?.[0]?.revision).toBe(f.initial.revision);
  });
});
''')
