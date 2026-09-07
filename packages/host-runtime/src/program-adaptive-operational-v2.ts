export * from "./program-adaptive-operational-guarded-v2.ts";

import type { EventDraft, PersistedDomainEvent } from "@alcode/events";
import {
  assertValidProgramState,
  type ProgramState,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import { materializeAdaptiveMutationSettlementProgramStateV2 } from "./program-adaptive-admission-v2.ts";
import type {
  ProgramSemanticCurrentSnapshotV1,
  ProgramSemanticCurrentStateSourceV1,
} from "./program-revision.ts";
import {
  ProgramTerminalServiceV1,
  ProgramTerminalStaleError,
  type ProgramCancellationCommandV1,
  type ProgramCancellationResultV1,
  type ProgramCompletionCommandV1,
  type ProgramCompletionResultV1,
  type ProgramTerminalServiceOptionsV1,
} from "./program-terminal.ts";

export interface ProgramAdaptiveTerminalServiceOptionsV2 extends ProgramTerminalServiceOptionsV1 {
  currentState: ProgramSemanticCurrentStateSourceV1;
}

interface PreparedAdaptiveTerminalStateV2 {
  programStateId: string;
  rawEventSequence: number;
  rawRevision: number;
  semanticProgramStateRevision: number;
  semanticRevisionId: string;
  state: ProgramState;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isProgramStateEventV2(type: string): boolean {
  return type === "program.created" || type === "program.transitioned"
    || type === "program.completed" || type === "program.cancelled";
}

async function replayAllV2(store: WorkspaceEventStore): Promise<PersistedDomainEvent<string, unknown>[]> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

function latestProgramStateEventV2(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
): { event: PersistedDomainEvent<string, unknown>; state: ProgramState } {
  let latest: { event: PersistedDomainEvent<string, unknown>; state: ProgramState } | undefined;
  for (const event of events) {
    if (!isProgramStateEventV2(event.type) || String(event.programStateId ?? "") !== programStateId) continue;
    const state = record(event.payload).state as ProgramState | undefined;
    if (state === undefined) throw new ProgramTerminalStaleError(`${event.type} lacks payload.state`);
    assertValidProgramState(state);
    if (String(state.programStateId) !== programStateId) {
      throw new ProgramTerminalStaleError(`${event.type} state identity does not match envelope`);
    }
    latest = { event, state };
  }
  if (latest === undefined) throw new ProgramTerminalStaleError(`Unknown ProgramState ${programStateId}`);
  return latest;
}

function materializeAdaptiveTerminalProgramStateV2(
  raw: ProgramState,
  current: ProgramSemanticCurrentSnapshotV1,
): ProgramState {
  const materialized = materializeAdaptiveMutationSettlementProgramStateV2(raw, current);
  const nonRequiredWorkIds = new Set(
    current.semanticState.workItems
      .filter((work) => work.requirementState !== "required")
      .map((work) => String(work.workItemId)),
  );
  if (nonRequiredWorkIds.size === 0) return materialized;
  const next: ProgramState = {
    ...materialized,
    workItems: materialized.workItems.map((work) =>
      nonRequiredWorkIds.has(String(work.workItemId))
        ? { ...work, lifecycle: "completed" as const }
        : work),
  };
  assertValidProgramState(next);
  return next;
}

function rewriteAdaptiveTerminalProducerV2(
  drafts: readonly EventDraft<string, unknown>[],
): EventDraft<string, unknown>[] {
  return drafts.map((draft) => {
    if (draft.producer.kind !== "runtime" || record(draft.producer).component !== "program-terminal") {
      return draft;
    }
    return {
      ...draft,
      producer: { kind: "runtime", component: "program-adaptive-terminal-v2" },
    } as EventDraft<string, unknown>;
  });
}

function overlayAdaptiveTerminalStoreV2(
  store: WorkspaceEventStore,
  currentState: ProgramSemanticCurrentStateSourceV1,
  prepared: PreparedAdaptiveTerminalStateV2,
): WorkspaceEventStore {
  const replay = async function* (): AsyncGenerator<PersistedDomainEvent<string, unknown>> {
    const events = await replayAllV2(store);
    const latest = latestProgramStateEventV2(events, prepared.programStateId);
    if (latest.event.sequence !== prepared.rawEventSequence || latest.state.revision !== prepared.rawRevision) {
      throw new ProgramTerminalStaleError("Program operational state changed before adaptive terminal admission");
    }
    const current = await currentState.current(prepared.programStateId);
    if (current.programStateRevision !== prepared.semanticProgramStateRevision
        || String(current.semanticState.currentRevision.programRevisionId) !== prepared.semanticRevisionId) {
      throw new ProgramTerminalStaleError("Program semantic currentness changed before adaptive terminal admission");
    }
    for (const event of events) {
      if (event.sequence !== prepared.rawEventSequence) {
        yield event;
        continue;
      }
      yield {
        ...event,
        payload: { ...record(event.payload), state: structuredClone(prepared.state) },
      } as PersistedDomainEvent<string, unknown>;
    }
  };

  // Never proxy the concrete WorkspaceEventStore target: production stores may
  // expose replay/append as non-configurable own properties. Proxy invariants
  // would then forbid an adaptive view from overriding those methods. The empty
  // target carries no descriptor authority; every non-overridden member is
  // explicitly delegated to the canonical store with its original receiver.
  return new Proxy({} as WorkspaceEventStore, {
    get(_target, property) {
      if (property === "replay") return () => replay();
      if (property === "append") {
        return (drafts: readonly EventDraft<string, unknown>[]) =>
          store.append(rewriteAdaptiveTerminalProducerV2(drafts));
      }
      const value = Reflect.get(store, property, store) as unknown;
      return typeof value === "function" ? value.bind(store) : value;
    },
  }) as WorkspaceEventStore;
}

/**
 * Adaptive adapter over the frozen V1 terminal authority. The V1 Completion
 * Oracle and cancellation semantics remain authoritative; this adapter only
 * presents the exact semantic/operational current cut to that authority and
 * marks any resulting state transition as an adaptive terminal anchor.
 */
export class ProgramAdaptiveTerminalServiceV2 extends ProgramTerminalServiceV1 {
  constructor(private readonly adaptiveOptions: ProgramAdaptiveTerminalServiceOptionsV2) {
    super(adaptiveOptions);
  }

  private async prepare(
    programStateId: string,
    expectedProgramRevision: number,
  ): Promise<PreparedAdaptiveTerminalStateV2 | null> {
    const events = await replayAllV2(this.adaptiveOptions.store);
    const raw = latestProgramStateEventV2(events, programStateId);
    if (raw.state.lifecycle === "completed" || raw.state.lifecycle === "cancelled") return null;
    if (raw.state.revision !== expectedProgramRevision) {
      throw new ProgramTerminalStaleError(
        `Program operational revision changed before adaptive terminal preparation: expected ${expectedProgramRevision}, current ${raw.state.revision}`,
      );
    }
    const current = await this.adaptiveOptions.currentState.current(programStateId);
    const materialized = materializeAdaptiveTerminalProgramStateV2(raw.state, current);
    if (materialized.revision !== current.programStateRevision || materialized.revision < raw.state.revision) {
      throw new ProgramTerminalStaleError("Adaptive terminal materialization did not preserve monotonic currentness");
    }
    return {
      programStateId,
      rawEventSequence: raw.event.sequence,
      rawRevision: raw.state.revision,
      semanticProgramStateRevision: current.programStateRevision,
      semanticRevisionId: String(current.semanticState.currentRevision.programRevisionId),
      state: materialized,
    };
  }

  private delegate(prepared: PreparedAdaptiveTerminalStateV2): ProgramTerminalServiceV1 {
    const { currentState: _currentState, ...terminalOptions } = this.adaptiveOptions;
    return new ProgramTerminalServiceV1({
      ...terminalOptions,
      store: overlayAdaptiveTerminalStoreV2(
        this.adaptiveOptions.store,
        this.adaptiveOptions.currentState,
        prepared,
      ),
    });
  }

  override async cancel(command: ProgramCancellationCommandV1): Promise<ProgramCancellationResultV1> {
    const prepared = await this.prepare(command.programStateId, command.expectedProgramRevision);
    if (prepared === null) return super.cancel(command);
    return this.delegate(prepared).cancel({
      ...command,
      expectedProgramRevision: prepared.state.revision,
    });
  }

  override async complete(command: ProgramCompletionCommandV1): Promise<ProgramCompletionResultV1> {
    const prepared = await this.prepare(command.programStateId, command.expectedProgramRevision);
    if (prepared === null) return super.complete(command);
    return this.delegate(prepared).complete({
      ...command,
      expectedProgramRevision: prepared.state.revision,
    });
  }
}
