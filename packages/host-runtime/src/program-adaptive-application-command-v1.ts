import type { ProgramCommand } from "@alcode/application-protocol";
import {
  asProgramStateId as asEventProgramStateId,
  asSessionId as asEventSessionId,
  asWorkspaceId,
  mkEventId,
  type EventDraft,
  type PersistedDomainEvent,
} from "@alcode/events";
import {
  ProgramRevisionConflictError,
  ProgramTransitionError,
  applyProgramTransition,
  asProgramStateId,
  asSessionId,
  assertValidProgramState,
  type ProgramState,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import { materializeAdaptiveMutationSettlementProgramStateV2 } from "./program-adaptive-admission-v2.ts";
import type {
  ProgramApplicationCommandResultV1,
  ProgramApplicationPortV1,
  ProgramApplicationSnapshotV1,
} from "./program-application.ts";
import {
  ProgramDispatchControlError,
  ProgramDispatchServiceV1,
  ProgramDispatchStaleError,
  type ProgramDispatchServiceOptionsV1,
} from "./program-dispatch.ts";
import {
  ProgramAdaptiveTerminalServiceV2,
  type ProgramAdaptiveTerminalServiceOptionsV2,
} from "./program-adaptive-operational-v2.ts";
import type { ProgramSemanticCurrentStateSourceV1 } from "./program-revision.ts";
import { ProgramSemanticRecoveryRegistryV1 } from "./program-semantic-recovery-v1.ts";
import {
  ProgramTerminalControlError,
  ProgramTerminalStaleError,
} from "./program-terminal.ts";

type AdaptiveMutableProgramCommandV1 = Exclude<ProgramCommand, { type: "program.creation.accept" }>;

export class ProgramAdaptiveApplicationCommandControlErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramAdaptiveApplicationCommandControlErrorV1";
  }
}

export class ProgramAdaptiveApplicationCommandStaleErrorV1 extends ProgramAdaptiveApplicationCommandControlErrorV1 {
  constructor(message: string) {
    super(message);
    this.name = "ProgramAdaptiveApplicationCommandStaleErrorV1";
  }
}

export interface ProgramAdaptiveApplicationCommandAuthorityV1 {
  execute(command: AdaptiveMutableProgramCommandV1): Promise<ProgramApplicationCommandResultV1>;
}

export interface HostProgramAdaptiveApplicationCommandAuthorityOptionsV1 {
  store: WorkspaceEventStore;
  currentState: ProgramSemanticCurrentStateSourceV1;
  terminalOptions: ProgramAdaptiveTerminalServiceOptionsV2;
  dispatchOptions: ProgramDispatchServiceOptionsV1;
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
  return type === "program.created" || type === "program.transitioned"
    || type === "program.completed" || type === "program.cancelled";
}

function latestProgramStateEvent(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
): { event: PersistedDomainEvent<string, unknown>; state: ProgramState } {
  let latest: { event: PersistedDomainEvent<string, unknown>; state: ProgramState } | undefined;
  for (const event of events) {
    if (!isProgramStateEvent(event.type) || String(event.programStateId ?? "") !== programStateId) continue;
    const state = record(event.payload).state as ProgramState | undefined;
    if (state === undefined) {
      throw new ProgramAdaptiveApplicationCommandControlErrorV1(`${event.type} lacks payload.state`);
    }
    assertValidProgramState(state);
    if (String(state.programStateId) !== programStateId) {
      throw new ProgramAdaptiveApplicationCommandControlErrorV1(
        `${event.type} ProgramState identity disagrees with its envelope`,
      );
    }
    latest = { event, state };
  }
  if (latest === undefined) {
    throw new ProgramAdaptiveApplicationCommandStaleErrorV1(`Unknown ProgramState ${programStateId}`);
  }
  return latest;
}

function sessionIsActive(
  events: readonly PersistedDomainEvent<string, unknown>[],
  sessionId: string,
): boolean {
  let active = false;
  for (const event of events) {
    if (String(event.sessionId ?? "") !== sessionId) continue;
    if (event.type === "runtime.session.started") active = true;
    if (event.type === "runtime.session.stopped") active = false;
  }
  return active;
}

function requireCurrentRevision(
  expectedProgramRevision: number,
  currentProgramRevision: number,
): void {
  if (expectedProgramRevision !== currentProgramRevision) {
    throw new ProgramRevisionConflictError(expectedProgramRevision, currentProgramRevision);
  }
}

function requireAttachedActiveSession(
  events: readonly PersistedDomainEvent<string, unknown>[],
  state: Awaited<ReturnType<ProgramSemanticCurrentStateSourceV1["current"]>>,
  sessionId: string,
): void {
  if (!sessionIsActive(events, sessionId)) {
    throw new ProgramAdaptiveApplicationCommandStaleErrorV1(`Session ${sessionId} is not active`);
  }
  if (!state.attachedSessionIds.includes(sessionId)) {
    throw new ProgramAdaptiveApplicationCommandStaleErrorV1(
      `Session ${sessionId} is not attached to Program ${String(state.semanticState.programStateId)}`,
    );
  }
}

function rewriteAdaptiveRebaseDrafts(
  drafts: readonly EventDraft<string, unknown>[],
): EventDraft<string, unknown>[] {
  return drafts.map((draft) => {
    if (draft.producer.kind !== "runtime"
        || record(draft.producer).component !== "program-dispatch"
        || draft.type !== "program.transitioned"
        || record(draft.payload).transitionKind !== "execution_base.rebase_accept") {
      return draft;
    }
    return {
      ...draft,
      producer: { kind: "runtime", component: "program-adaptive-rebase-v2" },
    } as EventDraft<string, unknown>;
  });
}

function adaptiveRebaseStore(
  options: HostProgramAdaptiveApplicationCommandAuthorityOptionsV1,
  programStateId: string,
  expectedProgramRevision: number,
): WorkspaceEventStore {
  const replay = async function* (): AsyncGenerator<PersistedDomainEvent<string, unknown>> {
    const events = await replayAll(options.store);
    const raw = latestProgramStateEvent(events, programStateId);
    const current = await options.currentState.current(programStateId);
    requireCurrentRevision(expectedProgramRevision, current.programStateRevision);
    const materialized = materializeAdaptiveMutationSettlementProgramStateV2(raw.state, current);
    if (materialized.revision !== expectedProgramRevision || materialized.revision < raw.state.revision) {
      throw new ProgramDispatchStaleError("Adaptive rebase materialization did not preserve exact currentness");
    }
    for (const event of events) {
      if (event.sequence !== raw.event.sequence) {
        yield event;
        continue;
      }
      yield {
        ...event,
        payload: { ...record(event.payload), state: structuredClone(materialized) },
      } as PersistedDomainEvent<string, unknown>;
    }
  };

  // The canonical store can expose replay/append as non-configurable own
  // properties. Proxy an empty view target so adaptive overrides do not violate
  // JavaScript Proxy invariants; delegate every other member to the real store.
  return new Proxy({} as WorkspaceEventStore, {
    get(_target, property) {
      if (property === "replay") return () => replay();
      if (property === "append") {
        return (drafts: readonly EventDraft<string, unknown>[]) =>
          options.store.append(rewriteAdaptiveRebaseDrafts(drafts));
      }
      const value = Reflect.get(options.store, property, options.store) as unknown;
      return typeof value === "function" ? value.bind(options.store) : value;
    },
  }) as WorkspaceEventStore;
}

function adaptiveApplicationTransitionDraft(
  store: WorkspaceEventStore,
  command: Extract<ProgramCommand, { type: "program.session.attach" | "program.session.detach" }>,
  state: ProgramState,
  transitionKind: "session.attach" | "session.detach",
): EventDraft<string, unknown> {
  return {
    eventId: mkEventId(),
    idempotencyKey: `program.transitioned:${String(state.programStateId)}:${state.revision}`,
    correlationId: command.commandId,
    workspaceId: asWorkspaceId(store.workspaceId),
    sessionId: asEventSessionId(command.sessionId),
    programStateId: asEventProgramStateId(String(state.programStateId)),
    occurredAt: new Date().toISOString(),
    type: "program.transitioned",
    payload: { state, transitionKind, applicationCommandId: command.commandId },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-adaptive-application-v1" },
  };
}

/**
 * Adaptive authority for legacy Application Program commands after semantic
 * adoption. It preserves the public whole-state CAS while presenting exact
 * semantic currentness to the frozen V1 terminal/rebase transitions.
 */
export class HostProgramAdaptiveApplicationCommandAuthorityV1
implements ProgramAdaptiveApplicationCommandAuthorityV1 {
  constructor(private readonly options: HostProgramAdaptiveApplicationCommandAuthorityOptionsV1) {}

  async execute(command: AdaptiveMutableProgramCommandV1): Promise<ProgramApplicationCommandResultV1> {
    switch (command.type) {
      case "program.rebase.accept":
        return this.acceptRebase(command);
      case "program.cancel":
        return this.cancel(command);
      case "program.session.attach":
        return this.changeAttachment(command, true);
      case "program.session.detach":
        return this.changeAttachment(command, false);
    }
  }

  private async acceptRebase(
    command: Extract<ProgramCommand, { type: "program.rebase.accept" }>,
  ): Promise<ProgramApplicationCommandResultV1> {
    const programStateId = String(asProgramStateId(command.programStateId));
    const events = await replayAll(this.options.store);
    const current = await this.options.currentState.current(programStateId);
    requireCurrentRevision(command.expectedProgramRevision, current.programStateRevision);
    if (current.lifecycle !== "active") {
      throw new ProgramAdaptiveApplicationCommandStaleErrorV1("Rebase requires an active adaptive Program");
    }
    requireAttachedActiveSession(events, current, command.sessionId);

    const dispatch = new ProgramDispatchServiceV1({
      ...this.options.dispatchOptions,
      store: adaptiveRebaseStore(
        this.options,
        programStateId,
        command.expectedProgramRevision,
      ),
    });
    const next = await dispatch.acceptRebase({
      programStateId,
      expectedProgramRevision: command.expectedProgramRevision,
      mismatchReceiptId: command.mismatchReceiptId,
      sessionId: asEventSessionId(command.sessionId),
    });
    return {
      decision: "accepted",
      programStateId: String(next.programStateId),
      programRevision: next.revision,
    };
  }

  private async cancel(
    command: Extract<ProgramCommand, { type: "program.cancel" }>,
  ): Promise<ProgramApplicationCommandResultV1> {
    const programStateId = String(asProgramStateId(command.programStateId));
    const events = await replayAll(this.options.store);
    const raw = latestProgramStateEvent(events, programStateId);
    const current = await this.options.currentState.current(programStateId);
    if (current.lifecycle === "cancelled") {
      return {
        decision: "duplicate",
        programStateId,
        programRevision: raw.state.revision,
      };
    }
    if (current.lifecycle === "completed") {
      throw new ProgramTerminalStaleError("Program already completed");
    }
    requireCurrentRevision(command.expectedProgramRevision, current.programStateRevision);
    requireAttachedActiveSession(events, current, command.sessionId);

    const guardedCurrentState: ProgramSemanticCurrentStateSourceV1 = {
      current: async (targetProgramStateId: string) => {
        const sampled = await this.options.currentState.current(targetProgramStateId);
        requireCurrentRevision(command.expectedProgramRevision, sampled.programStateRevision);
        return sampled;
      },
    };
    const terminal = new ProgramAdaptiveTerminalServiceV2({
      ...this.options.terminalOptions,
      currentState: guardedCurrentState,
    });
    const result = await terminal.cancel({
      programStateId,
      expectedProgramRevision: raw.state.revision,
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
    return this.options.terminalOptions.admission.enqueue(async () => {
      const events = await replayAll(this.options.store);
      if (!sessionIsActive(events, command.sessionId)) {
        throw new ProgramAdaptiveApplicationCommandStaleErrorV1(
          `Session ${command.sessionId} is not active`,
        );
      }
      const programStateId = String(asProgramStateId(command.programStateId));
      const current = await this.options.currentState.current(programStateId);
      requireCurrentRevision(command.expectedProgramRevision, current.programStateRevision);
      const raw = latestProgramStateEvent(events, programStateId);
      const materialized = materializeAdaptiveMutationSettlementProgramStateV2(raw.state, current);
      if (materialized.revision !== command.expectedProgramRevision || materialized.revision < raw.state.revision) {
        throw new ProgramAdaptiveApplicationCommandStaleErrorV1(
          "Adaptive attachment materialization did not preserve exact currentness",
        );
      }
      const transitionKind = attach ? "session.attach" as const : "session.detach" as const;
      const next = applyProgramTransition(materialized, attach ? {
        kind: "session.attach",
        expectedProgramRevision: materialized.revision,
        sessionId: asSessionId(command.sessionId),
      } : {
        kind: "session.detach",
        expectedProgramRevision: materialized.revision,
        sessionId: asSessionId(command.sessionId),
      });
      if (next === materialized) {
        return {
          decision: "noop",
          programStateId,
          programRevision: materialized.revision,
        } as const;
      }
      const persisted = await this.options.store.append([
        adaptiveApplicationTransitionDraft(this.options.store, command, next, transitionKind),
      ]);
      if (persisted.length !== 1) {
        throw new ProgramAdaptiveApplicationCommandControlErrorV1(
          "Adaptive Application attachment admission failed",
        );
      }
      return {
        decision: "accepted",
        programStateId,
        programRevision: next.revision,
      } as const;
    });
  }
}

/**
 * Routing wrapper around the projection port. Commands for non-adopted Programs
 * remain byte-for-byte delegated to V1; post-adoption mutating commands are
 * forced through semantic-aware Host authority.
 */
export class ProgramAdaptiveApplicationCommandPortV1 implements ProgramApplicationPortV1 {
  constructor(
    private readonly base: ProgramApplicationPortV1,
    private readonly recovery: ProgramSemanticRecoveryRegistryV1,
    private readonly adaptive: ProgramAdaptiveApplicationCommandAuthorityV1,
  ) {}

  async execute(command: ProgramCommand): Promise<ProgramApplicationCommandResultV1> {
    if (command.type === "program.creation.accept") return this.base.execute(command);
    if (!await this.recovery.isAdaptive(command.programStateId)) return this.base.execute(command);

    try {
      return await this.adaptive.execute(command);
    } catch (error) {
      if (error instanceof ProgramRevisionConflictError
          || error instanceof ProgramDispatchStaleError
          || error instanceof ProgramTerminalStaleError
          || error instanceof ProgramAdaptiveApplicationCommandStaleErrorV1) {
        return { decision: "stale", reasonCode: error.name };
      }
      if (error instanceof ProgramTransitionError
          || error instanceof ProgramDispatchControlError
          || error instanceof ProgramTerminalControlError
          || error instanceof ProgramAdaptiveApplicationCommandControlErrorV1) {
        return { decision: "rejected", reasonCode: error.name };
      }
      throw error;
    }
  }

  getSnapshot(sessionId: string): Promise<ProgramApplicationSnapshotV1> {
    return this.base.getSnapshot(sessionId);
  }
}
