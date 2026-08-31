import type { PersistedDomainEvent } from "@alcode/events";
import type { ProgramState } from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import {
  materializeAdaptiveMutationSettlementProgramStateV2,
  requireAdaptiveRawProgramStateV2,
} from "./program-adaptive-admission-v2.ts";
import { ProgramAdaptiveApplicationPortV1 } from "./program-adaptive-application-projection-v1.ts";
import { recoverAdaptiveProgramCurrentSnapshotV2 } from "./program-adaptive-operational-v2.ts";
import {
  HostProgramApplicationControlV1,
  type ProgramApplicationCommandResultV1,
  type ProgramApplicationPortV1,
  type ProgramApplicationSnapshotV1,
  type ProgramCancellationApplicationAuthorityV1,
  type ProgramCreationApplicationAuthorityV1,
  type ProgramRebaseApplicationAuthorityV1,
} from "./program-application.ts";
import {
  recoverProgramSemanticStateV1,
  type ProgramSemanticRecoveryRegistryV1,
  type ProgramSemanticRecoverySnapshotV1,
} from "./program-semantic-recovery-v1.ts";

export interface ProgramAdaptiveApplicationCurrentPortOptionsV2 {
  store: WorkspaceEventStore;
  admission: CanonicalAdmissionQueue;
  creation: ProgramCreationApplicationAuthorityV1;
  dispatch: ProgramRebaseApplicationAuthorityV1;
  terminal: ProgramCancellationApplicationAuthorityV1;
  base: ProgramApplicationPortV1;
  /** Test seam only; production omits this and uses canonical replay recovery. */
  semanticCut?: {
    recoverCurrent(
      events: readonly PersistedDomainEvent<string, unknown>[],
      programStateId: string,
    ): ReturnType<typeof recoverAdaptiveProgramCurrentSnapshotV2>;
    recoverSemantic(
      events: readonly PersistedDomainEvent<string, unknown>[],
      programStateId: string,
    ): ProgramSemanticRecoverySnapshotV1 | undefined;
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isProgramStateEvent(type: string): boolean {
  return type === "program.created" || type === "program.transitioned"
    || type === "program.completed" || type === "program.cancelled";
}

async function replayAll(store: WorkspaceEventStore): Promise<PersistedDomainEvent<string, unknown>[]> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

function programStateIds(events: readonly PersistedDomainEvent<string, unknown>[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (!isProgramStateEvent(event.type) || event.programStateId === undefined) continue;
    ids.add(String(event.programStateId));
  }
  return [...ids].sort((left, right) => left.localeCompare(right, "en"));
}

function capturedStore(
  store: WorkspaceEventStore,
  events: readonly PersistedDomainEvent<string, unknown>[],
): WorkspaceEventStore {
  const replay = async function* (): AsyncGenerator<PersistedDomainEvent<string, unknown>> {
    for (const event of events) yield structuredClone(event);
  };
  return new Proxy({} as WorkspaceEventStore, {
    get(_target, property) {
      if (property === "replay") return () => replay();
      const value = Reflect.get(store, property, store) as unknown;
      return typeof value === "function" ? value.bind(store) : value;
    },
  }) as WorkspaceEventStore;
}

function overlayLatestProgramStates(
  events: readonly PersistedDomainEvent<string, unknown>[],
  replacements: ReadonlyMap<string, ProgramState>,
): PersistedDomainEvent<string, unknown>[] {
  const latestIndex = new Map<string, number>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (!isProgramStateEvent(event.type) || event.programStateId === undefined) continue;
    latestIndex.set(String(event.programStateId), index);
  }
  return events.map((event, index) => {
    const programStateId = String(event.programStateId ?? "");
    const replacement = replacements.get(programStateId);
    if (replacement === undefined || latestIndex.get(programStateId) !== index) {
      return structuredClone(event);
    }
    return {
      ...structuredClone(event),
      payload: {
        ...record(structuredClone(event.payload)),
        state: structuredClone(replacement),
      },
    } as PersistedDomainEvent<string, unknown>;
  });
}

/**
 * Production Application projection over one captured Workspace event cut.
 *
 * The raw ProgramState and semantic head are recovered from the same replay,
 * then the current semantic/operational state is materialized into a read-only
 * event view. The frozen V1 public projector and the existing bounded adaptive
 * metadata projector both consume that same captured cut. This prevents a new
 * semantic CAS revision from being paired with an invalidated old Attempt or
 * stale work topology.
 */
export class ProgramAdaptiveApplicationCurrentPortV2 implements ProgramApplicationPortV1 {
  constructor(private readonly options: ProgramAdaptiveApplicationCurrentPortOptionsV2) {}

  execute(command: Parameters<ProgramApplicationPortV1["execute"]>[0]): Promise<ProgramApplicationCommandResultV1> {
    return this.options.base.execute(command);
  }

  async getSnapshot(sessionId: string): Promise<ProgramApplicationSnapshotV1> {
    const events = await replayAll(this.options.store);
    const semanticCut = this.options.semanticCut ?? {
      recoverCurrent: recoverAdaptiveProgramCurrentSnapshotV2,
      recoverSemantic: recoverProgramSemanticStateV1,
    };

    const replacements = new Map<string, ProgramState>();
    const recovered = new Map<string, ProgramSemanticRecoverySnapshotV1>();
    for (const programStateId of programStateIds(events)) {
      const current = semanticCut.recoverCurrent(events, programStateId);
      const semantic = semanticCut.recoverSemantic(events, programStateId);
      if (current === undefined || semantic === undefined) continue;
      const raw = requireAdaptiveRawProgramStateV2(events, programStateId);
      replacements.set(
        programStateId,
        materializeAdaptiveMutationSettlementProgramStateV2(raw, current),
      );
      recovered.set(programStateId, semantic);
    }

    const viewEvents = overlayLatestProgramStates(events, replacements);
    const viewStore = capturedStore(this.options.store, viewEvents);
    const base = new HostProgramApplicationControlV1({
      store: viewStore,
      admission: this.options.admission,
      creation: this.options.creation,
      dispatch: this.options.dispatch,
      terminal: this.options.terminal,
    });
    const capturedRecovery = {
      async current(programStateId: string) {
        return recovered.get(programStateId);
      },
      async isAdaptive(programStateId: string) {
        return recovered.has(programStateId);
      },
    } as unknown as ProgramSemanticRecoveryRegistryV1;

    return new ProgramAdaptiveApplicationPortV1(base, capturedRecovery)
      .getAdaptiveSnapshot(sessionId);
  }
}
