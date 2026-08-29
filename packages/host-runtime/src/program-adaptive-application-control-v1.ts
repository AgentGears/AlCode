import {
  APPLICATION_PROTOCOL_VERSION,
  type ApplicationCommand,
  type ApplicationCursor,
  type ApplicationEvent,
  type ApplicationRecoveryResult,
  type ApplicationServicePort,
  type ApplicationSnapshot,
  type CommandDecision,
  type PluginCommand,
  type ProgramAdaptiveSemanticCommand,
} from "@alcode/application-protocol";
import {
  asSessionId,
  asWorkspaceId,
  mkEventId,
  type EventDraft,
  type PersistedDomainEvent,
} from "@alcode/events";
import { canonicalStringify } from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import type { ProgramApplicationCommandResultV1 } from "./program-application.ts";
import {
  ProgramRevisionControlError,
  ProgramRevisionStaleError,
  type ProgramRevisionApplicationAcceptCommandV1,
  type ProgramSemanticRevisionAcceptedResultV1,
} from "./program-revision.ts";
import {
  ProgramSemanticBaselineBlockedError,
  ProgramSemanticBaselineControlError,
  ProgramSemanticBaselineStaleError,
  type ProgramSemanticBaselineAcceptCommandV1,
  type ProgramSemanticBaselineAcceptedResultV1,
  type ProgramSemanticBaselineDraftV1,
  type ProgramSemanticBaselineSealCommandV1,
} from "./program-semantic-baseline-kernel.ts";

export type ProgramAdaptiveApplicationCommandResultV1 = ProgramApplicationCommandResultV1 & {
  programStateRevision?: number;
  programRevisionId?: string;
  draftDigest?: string;
};

export interface ProgramAdaptiveSemanticApplicationPortV1 {
  execute(command: ProgramAdaptiveSemanticCommand): Promise<ProgramAdaptiveApplicationCommandResultV1>;
}

export interface ProgramAdaptiveBaselineApplicationAuthorityV1 {
  seal(command: ProgramSemanticBaselineSealCommandV1): Promise<ProgramSemanticBaselineDraftV1>;
  accept(command: ProgramSemanticBaselineAcceptCommandV1): Promise<ProgramSemanticBaselineAcceptedResultV1>;
}

export interface ProgramAdaptiveRevisionApplicationAuthorityV1 {
  accept(command: ProgramRevisionApplicationAcceptCommandV1): Promise<ProgramSemanticRevisionAcceptedResultV1>;
}

export interface ProgramAdaptiveSemanticApplicationControlOptionsV1 {
  baseline: ProgramAdaptiveBaselineApplicationAuthorityV1;
  revision: ProgramAdaptiveRevisionApplicationAuthorityV1;
}

/**
 * Exact A1 semantic command authority. Application input never contains a
 * semantic edit, identity disposition, RevisionImpact, or ProgramRevision ID;
 * it can only request Host baseline sealing or accept an exact Host-sealed
 * draftId + draftDigest.
 */
export class ProgramAdaptiveSemanticApplicationControlV1
implements ProgramAdaptiveSemanticApplicationPortV1 {
  constructor(private readonly options: ProgramAdaptiveSemanticApplicationControlOptionsV1) {}

  async execute(command: ProgramAdaptiveSemanticCommand): Promise<ProgramAdaptiveApplicationCommandResultV1> {
    try {
      switch (command.type) {
        case "program.semantic_baseline.seal": {
          const draft = await this.options.baseline.seal({
            sourceSessionId: command.sessionId,
            programStateId: command.programStateId,
            expectedProgramStateRevision: command.expectedProgramStateRevision,
          });
          return {
            decision: "accepted",
            programStateId: draft.programStateId,
            programStateRevision: draft.fromProgramStateRevision,
            programRevisionId: draft.initialProgramRevisionId,
            draftId: draft.draftId,
            draftDigest: draft.draftDigest,
          };
        }
        case "program.semantic_baseline.accept":
          return acceptedResult(await this.options.baseline.accept({
            commandId: command.commandId,
            clientId: command.clientId,
            sourceSessionId: command.sessionId,
            programStateId: command.programStateId,
            draftId: command.draftId,
            draftDigest: command.draftDigest,
          }));
        case "program.semantic_revision.accept":
          return acceptedResult(await this.options.revision.accept({
            commandId: command.commandId,
            clientId: command.clientId,
            sourceSessionId: command.sessionId,
            programStateId: command.programStateId,
            draftId: command.draftId,
            draftDigest: command.draftDigest,
          }));
      }
    } catch (error) {
      if (error instanceof ProgramSemanticBaselineStaleError || error instanceof ProgramRevisionStaleError) {
        return { decision: "stale", reasonCode: error.name };
      }
      if (error instanceof ProgramSemanticBaselineBlockedError) {
        return {
          decision: "rejected",
          reasonCode: `semantic_baseline_blocked:${error.blockedBy.join(",")}`,
        };
      }
      if (error instanceof ProgramSemanticBaselineControlError || error instanceof ProgramRevisionControlError) {
        return { decision: "rejected", reasonCode: error.name };
      }
      throw error;
    }
  }
}

function acceptedResult(
  result: ProgramSemanticBaselineAcceptedResultV1 | ProgramSemanticRevisionAcceptedResultV1,
): ProgramAdaptiveApplicationCommandResultV1 {
  return {
    decision: result.status === "existing" ? "duplicate" : "accepted",
    programStateId: result.programStateId,
    programStateRevision: result.programStateRevision,
    programRevisionId: result.programRevisionId,
    draftId: result.draftId,
    draftDigest: result.draftDigest,
  };
}

export interface ProgramAdaptiveApplicationServiceOptionsV1 {
  store: WorkspaceEventStore;
  admission: CanonicalAdmissionQueue;
  base: ApplicationServicePort;
  semantic: ProgramAdaptiveSemanticApplicationPortV1;
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

function decisionDraft(
  store: WorkspaceEventStore,
  command: ProgramAdaptiveSemanticCommand,
  result: ProgramAdaptiveApplicationCommandResultV1,
): EventDraft<string, unknown> {
  return {
    eventId: mkEventId(),
    idempotencyKey: `application.adaptive_program.command.decided:${command.sessionId}:${command.commandId}`,
    correlationId: command.commandId,
    workspaceId: asWorkspaceId(store.workspaceId),
    sessionId: asSessionId(command.sessionId),
    occurredAt: new Date().toISOString(),
    type: "application.adaptive_program.command.decided",
    payload: {
      command: structuredClone(command),
      decision: result.decision,
      ...(result.reasonCode !== undefined ? { reasonCode: result.reasonCode } : {}),
      ...(result.programStateId !== undefined ? { programStateId: result.programStateId } : {}),
      ...(result.programStateRevision !== undefined ? { programStateRevision: result.programStateRevision } : {}),
      ...(result.programRevisionId !== undefined ? { programRevisionId: result.programRevisionId } : {}),
      ...(result.draftId !== undefined ? { draftId: result.draftId } : {}),
      ...(result.draftDigest !== undefined ? { draftDigest: result.draftDigest } : {}),
    },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-adaptive-application-v1" },
  };
}

function decisionKind(value: unknown): ProgramAdaptiveApplicationCommandResultV1["decision"] {
  if (value === "accepted" || value === "rejected" || value === "stale"
      || value === "duplicate" || value === "noop") return value;
  throw new ProgramRevisionControlError("Adaptive Application decision history contains an invalid decision kind");
}

function priorDecision(
  events: readonly PersistedDomainEvent<string, unknown>[],
  command: ProgramAdaptiveSemanticCommand,
): ProgramAdaptiveApplicationCommandResultV1 | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "application.adaptive_program.command.decided"
        || String(event.sessionId) !== command.sessionId) continue;
    if (event.producer.kind !== "runtime"
        || String(record(event.producer).component ?? "") !== "program-adaptive-application-v1") {
      throw new ProgramRevisionControlError("Adaptive Application decision history has an untrusted producer");
    }
    const payload = record(event.payload);
    const priorCommand = payload.command as ProgramAdaptiveSemanticCommand | undefined;
    if (priorCommand === undefined || priorCommand.commandId !== command.commandId) continue;
    if (canonicalStringify(priorCommand) !== canonicalStringify(command)) {
      return { decision: "stale", reasonCode: "application_command_identity_conflict" };
    }
    const prior = decisionKind(payload.decision);
    return {
      decision: prior === "accepted" ? "duplicate" : prior,
      ...(typeof payload.reasonCode === "string" ? { reasonCode: payload.reasonCode } : {}),
      ...(typeof payload.programStateId === "string" ? { programStateId: payload.programStateId } : {}),
      ...(typeof payload.programStateRevision === "number" ? { programStateRevision: payload.programStateRevision } : {}),
      ...(typeof payload.programRevisionId === "string" ? { programRevisionId: payload.programRevisionId } : {}),
      ...(typeof payload.draftId === "string" ? { draftId: payload.draftId } : {}),
      ...(typeof payload.draftDigest === "string" ? { draftDigest: payload.draftDigest } : {}),
    };
  }
  return undefined;
}

/**
 * Current production storage has one Host writer per Workspace. Share a
 * process-local Workspace serialization lane across Application service
 * instances so replay + semantic authority + durable decision recording is one
 * ordered idempotence decision. This is intentionally separate from the
 * CanonicalAdmissionQueue because semantic acceptance itself enters that queue;
 * nesting it here would deadlock a non-reentrant admission authority.
 */
const adaptiveApplicationWorkspaceTails = new WeakMap<WorkspaceEventStore, Promise<void>>();

function serializeAdaptiveApplicationWorkspace<T>(
  store: WorkspaceEventStore,
  work: () => Promise<T>,
): Promise<T> {
  const tail = adaptiveApplicationWorkspaceTails.get(store) ?? Promise.resolve();
  const run = tail.then(work, work);
  adaptiveApplicationWorkspaceTails.set(store, run.then(() => undefined, () => undefined));
  return run;
}

/**
 * Additive Application Protocol composition. Legacy execute/getSnapshot/recover
 * semantics delegate unchanged to the existing service; A1 semantic commands
 * use the dedicated optional executeAdaptiveProgram surface and gain a durable
 * Host decision record for reconnect/replay idempotence.
 */
export class ProgramAdaptiveApplicationServiceV1 implements ApplicationServicePort {
  constructor(private readonly options: ProgramAdaptiveApplicationServiceOptionsV1) {}

  execute(command: ApplicationCommand): Promise<CommandDecision> {
    return this.options.base.execute(command);
  }

  async executePlugin(command: PluginCommand): Promise<CommandDecision> {
    const executePlugin = this.options.base.executePlugin;
    if (executePlugin !== undefined) return executePlugin.call(this.options.base, command);
    const snapshot = await this.options.base.getSnapshot(command.sessionId);
    return {
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      commandId: command.commandId,
      sessionId: command.sessionId,
      decision: "rejected",
      cursor: snapshot.cursor,
      reasonCode: "plugins_not_supported",
    };
  }

  executeAdaptiveProgram(command: ProgramAdaptiveSemanticCommand): Promise<CommandDecision> {
    return serializeAdaptiveApplicationWorkspace(
      this.options.store,
      () => this.executeAdaptiveProgramSerial(command),
    );
  }

  private async executeAdaptiveProgramSerial(command: ProgramAdaptiveSemanticCommand): Promise<CommandDecision> {
    const existing = priorDecision(await replayAll(this.options.store), command);
    const result = existing ?? await this.options.semantic.execute(command);
    if (existing === undefined) {
      await this.options.admission.append([decisionDraft(this.options.store, command, result)]);
    }
    const snapshot = await this.options.base.getSnapshot(command.sessionId);
    return {
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      commandId: command.commandId,
      sessionId: command.sessionId,
      decision: result.decision,
      cursor: snapshot.cursor,
      ...(result.reasonCode !== undefined ? { reasonCode: result.reasonCode } : {}),
      ...(result.programStateId !== undefined ? { programStateId: result.programStateId } : {}),
      ...(result.programStateRevision !== undefined ? { programStateRevision: result.programStateRevision } : {}),
      ...(result.programRevisionId !== undefined ? { programRevisionId: result.programRevisionId } : {}),
      ...(result.draftId !== undefined ? { draftId: result.draftId } : {}),
      ...(result.draftDigest !== undefined ? { draftDigest: result.draftDigest } : {}),
    };
  }

  getSnapshot(sessionId: string): Promise<ApplicationSnapshot> {
    return this.options.base.getSnapshot(sessionId);
  }

  recover(sessionId: string, cursor?: ApplicationCursor): Promise<ApplicationRecoveryResult> {
    return this.options.base.recover(sessionId, cursor);
  }

  subscribe(sessionId: string, cursor: ApplicationCursor, listener: (event: ApplicationEvent) => void): () => void {
    return this.options.base.subscribe(sessionId, cursor, listener);
  }
}
