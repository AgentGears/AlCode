import type { ProgramCommand } from "@alcode/application-protocol";
import {
  ProgramRevisionConflictError,
  assertValidProgramState,
  compareWorkSelectionOrder,
  deriveReadyWorkItems,
  type ProgramState,
} from "@alcode/program-state";
import type { PersistedDomainEvent, SessionId } from "@alcode/events";
import type { WorkspaceEventStore } from "@alcode/storage";
import {
  ProgramDispatchStaleError,
  type ProgramDispatchResult,
  type ProgramDispatchServiceV1,
} from "./program-dispatch.ts";
import { PlanningBaseStaleError } from "./planning-read.ts";
import type {
  ProgramApplicationCommandResultV1,
  ProgramApplicationPortV1,
  ProgramApplicationSnapshotV1,
} from "./program-application.ts";

export interface ProgramExecutionAgentGenerationSourceV1 {
  currentAgentGeneration(sessionId: string): number | null;
}

export type ProgramExecutionScheduleResultV1 = ProgramDispatchResult
  | { status: "already_started"; state: ProgramState }
  | { status: "program_not_active"; state: ProgramState }
  | { status: "no_ready_work"; state: ProgramState };

export interface ProgramExecutionSchedulerOptionsV1 {
  store: WorkspaceEventStore;
  dispatch: ProgramDispatchServiceV1;
  agents: ProgramExecutionAgentGenerationSourceV1;
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

function currentState(events: readonly PersistedDomainEvent<string, unknown>[], programStateId: string): ProgramState {
  let state: ProgramState | undefined;
  for (const event of events) {
    if (String(event.programStateId ?? "") !== programStateId) continue;
    if (event.type !== "program.created" && event.type !== "program.transitioned"
        && event.type !== "program.completed" && event.type !== "program.cancelled") continue;
    const candidate = record(event.payload).state as ProgramState | undefined;
    if (candidate !== undefined) state = candidate;
  }
  if (state === undefined) throw new ProgramDispatchStaleError(`Unknown ProgramState ${programStateId}`);
  assertValidProgramState(state);
  return state;
}

/**
 * Event-driven Program scheduler used by the supported Phase 1.1 product path.
 * It never queues, polls, retries, or owns durable state. Each call derives one
 * deterministic structurally-ready work item, then delegates every operational
 * admission check to ProgramDispatchServiceV1.
 */
export class ProgramExecutionSchedulerV1 {
  constructor(private readonly options: ProgramExecutionSchedulerOptionsV1) {}

  async dispatchNext(input: {
    programStateId: string;
    sessionId: SessionId;
    firstDispatchOnly?: boolean;
  }): Promise<ProgramExecutionScheduleResultV1> {
    const state = currentState(await replayAll(this.options.store), input.programStateId);
    if (state.lifecycle !== "active") return { status: "program_not_active", state };
    if (input.firstDispatchOnly === true
        && (state.acceptedExecutionBase !== null || state.activeAttempt !== null || state.revision !== 1)) {
      return { status: "already_started", state };
    }
    if (state.activeAttempt !== null) return { status: "already_started", state };

    const ready = deriveReadyWorkItems(state).sort(compareWorkSelectionOrder);
    const work = ready[0];
    if (work === undefined) return { status: "no_ready_work", state };

    const agentGeneration = this.options.agents.currentAgentGeneration(String(input.sessionId));
    if (agentGeneration === null) return { status: "agent_generation_stale" };

    return this.options.dispatch.issueAttempt({
      programStateId: input.programStateId,
      expectedProgramRevision: state.revision,
      workItemId: String(work.workItemId),
      sessionId: input.sessionId,
      agentGeneration,
    });
  }
}

/**
 * Product Application adapter: exact creation acceptance remains owned by the
 * existing Host Program Application control; only after that decision does the
 * Host attempt the synchronous first dispatch. A failed dispatch never rolls
 * back or rewrites creation acceptance.
 */
export class ProgramExecutionApplicationPortV1 implements ProgramApplicationPortV1 {
  constructor(
    private readonly program: ProgramApplicationPortV1,
    private readonly scheduler: ProgramExecutionSchedulerV1,
  ) {}

  async execute(command: ProgramCommand): Promise<ProgramApplicationCommandResultV1> {
    const result = await this.program.execute(command);
    if (command.type !== "program.creation.accept"
        || (result.decision !== "accepted" && result.decision !== "duplicate")
        || result.programStateId === undefined) {
      return result;
    }

    try {
      const scheduled = await this.scheduler.dispatchNext({
        programStateId: result.programStateId,
        sessionId: command.sessionId as SessionId,
        firstDispatchOnly: true,
      });
      if ("state" in scheduled) {
        return { ...result, programRevision: scheduled.state.revision };
      }
      return result;
    } catch (error) {
      // Creation acceptance is already canonical at this point. Expected
      // freshness races fail the first dispatch closed but must not transmute a
      // successful Application acceptance into a false rejection or rollback.
      if (error instanceof PlanningBaseStaleError
          || error instanceof ProgramRevisionConflictError
          || error instanceof ProgramDispatchStaleError) {
        return { ...result, reasonCode: "first_dispatch_stale" };
      }
      throw error;
    }
  }

  getSnapshot(sessionId: string): Promise<ProgramApplicationSnapshotV1> {
    return this.program.getSnapshot(sessionId);
  }
}
