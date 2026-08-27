import type { PersistedDomainEvent } from "@alcode/events";
import {
  assertValidProgramState,
  type ProgramSemanticStateV1,
  type ProgramState,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import type {
  ProgramAdaptiveAttemptHistoryV2,
  ProgramAdaptiveSemanticSessionStateSourceV2,
} from "./program-adaptive-control-v2.ts";
import type {
  ProgramSemanticCurrentSnapshotV1,
  ProgramSemanticCurrentStateSourceV1,
} from "./program-revision.ts";
import {
  ProgramSemanticRecoveryError,
  recoverProgramSemanticStateV1,
  type ProgramSemanticOperationalCurrentnessSourceV1,
} from "./program-semantic-recovery-v1.ts";
import {
  ProgramAdaptiveOperationalOverlayErrorV2,
  adaptiveAttemptInvalidatedAfterIssueV2,
  deriveAttemptSemanticAssumptionsV2,
  recoverAdaptiveProgramCurrentSnapshotV2 as recoverLegacyAdaptiveProgramCurrentSnapshotV2,
} from "./program-adaptive-operational-legacy-v2.ts";

export {
  ProgramAdaptiveOperationalOverlayErrorV2,
  adaptiveAttemptInvalidatedAfterIssueV2,
  deriveAttemptSemanticAssumptionsV2,
};

interface ProgramStateEventV2 {
  event: PersistedDomainEvent<string, unknown>;
  state: ProgramState;
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

function programStateEventsV2(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
): ProgramStateEventV2[] {
  const states: ProgramStateEventV2[] = [];
  for (const event of events) {
    if (!isProgramStateEvent(event.type) || String(event.programStateId ?? "") !== programStateId) continue;
    const state = record(event.payload).state as ProgramState | undefined;
    if (state === undefined) {
      throw new ProgramAdaptiveOperationalOverlayErrorV2(`${event.type} lacks payload.state`);
    }
    assertValidProgramState(state);
    if (String(state.programStateId) !== programStateId) {
      throw new ProgramAdaptiveOperationalOverlayErrorV2(
        `${event.type} ProgramState identity disagrees with its envelope`,
      );
    }
    states.push({ event, state });
  }
  return states;
}

function semanticHeadEventSequenceV2(
  events: readonly PersistedDomainEvent<string, unknown>[],
  admissionEventId: string,
): number {
  const event = events.find((candidate) => String(candidate.eventId) === admissionEventId);
  if (event === undefined) {
    throw new ProgramAdaptiveOperationalOverlayErrorV2(
      `Current semantic head lacks canonical admission event ${admissionEventId}`,
    );
  }
  return event.sequence;
}

/**
 * A raw operational verification generation may advance beyond the semantic
 * cut because Workspace/effect freshness remains an independent axis, but it
 * may never fall behind the generation established by the semantic head.
 */
export function assertAdaptiveOperationalVerificationGenerationV2(
  semantic: ProgramSemanticStateV1,
  raw: ProgramState,
): void {
  const rawById = new Map(raw.verification.map((item) => [String(item.obligationId), item]));
  for (const obligation of semantic.verification) {
    const current = rawById.get(String(obligation.obligationId));
    if (current === undefined) {
      throw new ProgramAdaptiveOperationalOverlayErrorV2(
        `Post-semantic operational state omits verification ${String(obligation.obligationId)}`,
      );
    }
    if (current.subjectGeneration < obligation.subjectGeneration) {
      throw new ProgramAdaptiveOperationalOverlayErrorV2(
        `Post-semantic operational verification ${String(obligation.obligationId)} predates the current semantic generation`,
      );
    }
  }
}

/**
 * Validate the raw ProgramState lineage after a known semantic cut. The first
 * post-cut writer must be adaptive Attempt admission, which materializes from
 * the exact semantic whole-state revision before applying attempt.issue.
 */
export function validatePostSemanticProgramStateSequenceV2(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
  semanticHeadSequence: number,
  semanticProgramStateRevision: number,
): ProgramStateEventV2 | undefined {
  const states = programStateEventsV2(events, programStateId);
  const postHead = states.filter(({ event }) => event.sequence > semanticHeadSequence);
  if (postHead.length === 0) return undefined;

  const first = postHead[0]!;
  const payload = record(first.event.payload);
  if (first.event.type !== "program.transitioned"
      || first.event.producer.kind !== "runtime"
      || String(record(first.event.producer).component ?? "") !== "program-adaptive-admission-v2"
      || payload.transitionKind !== "attempt.issue"
      || first.state.revision !== semanticProgramStateRevision + 1) {
    throw new ProgramAdaptiveOperationalOverlayErrorV2(
      "First post-semantic ProgramState is not an exact adaptive Attempt-admission anchor",
    );
  }

  let expectedRevision = semanticProgramStateRevision + 1;
  for (const item of postHead) {
    if (item.state.revision !== expectedRevision) {
      throw new ProgramAdaptiveOperationalOverlayErrorV2(
        `Post-semantic ProgramState revision chain is not contiguous: expected ${expectedRevision}, got ${item.state.revision}`,
      );
    }
    expectedRevision += 1;
  }
  return postHead[postHead.length - 1]!;
}

/**
 * Prove that the latest raw ProgramState descends from the exact current
 * semantic cut and that verification proof does not predate that semantic
 * subject generation.
 */
export function validateAdaptiveOperationalProgramStateSequenceV2(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
): void {
  const recovered = recoverProgramSemanticStateV1(events, programStateId);
  if (recovered === undefined) return;

  const states = programStateEventsV2(events, programStateId);
  if (states.length === 0) {
    throw new ProgramAdaptiveOperationalOverlayErrorV2(
      `Adaptive Program lacks operational ProgramState ${programStateId}`,
    );
  }
  const headSequence = semanticHeadEventSequenceV2(
    events,
    String(recovered.semanticState.currentRevision.admissionEventId),
  );
  const latestPostHead = validatePostSemanticProgramStateSequenceV2(
    events,
    programStateId,
    headSequence,
    recovered.programStateRevision,
  );
  if (latestPostHead === undefined) return;

  assertAdaptiveOperationalVerificationGenerationV2(
    recovered.semanticState,
    latestPostHead.state,
  );
}

/**
 * Guard the legacy-compatible overlay with exact post-semantic lineage proof.
 * The underlying projection is reused only after current WorkItem generation
 * provenance is established by the adaptive materialization anchor and stale
 * verification generations are excluded.
 */
export function recoverAdaptiveProgramCurrentSnapshotV2(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
): ProgramSemanticCurrentSnapshotV1 | undefined {
  validateAdaptiveOperationalProgramStateSequenceV2(events, programStateId);
  return recoverLegacyAdaptiveProgramCurrentSnapshotV2(events, programStateId);
}

async function replayAllV2(store: WorkspaceEventStore): Promise<PersistedDomainEvent<string, unknown>[]> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

/** Production guarded current-state source for adaptive semantic/operational consumers. */
export class ProgramAdaptiveOperationalCurrentStateSourceV2
implements ProgramSemanticCurrentStateSourceV1,
  ProgramAdaptiveSemanticSessionStateSourceV2,
  ProgramAdaptiveAttemptHistoryV2 {
  constructor(private readonly store: WorkspaceEventStore) {}

  async current(programStateId: string): Promise<ProgramSemanticCurrentSnapshotV1> {
    const snapshot = recoverAdaptiveProgramCurrentSnapshotV2(await replayAllV2(this.store), programStateId);
    if (snapshot === undefined) {
      throw new ProgramSemanticRecoveryError(`Program ${programStateId} has not adopted adaptive semantics`);
    }
    return snapshot;
  }

  async currentForSession(sessionId: string): Promise<ProgramSemanticCurrentSnapshotV1 | undefined> {
    const events = await replayAllV2(this.store);
    const programStateIds = new Set<string>();
    for (const event of events) {
      if (isProgramStateEvent(event.type) && event.programStateId !== undefined) {
        programStateIds.add(String(event.programStateId));
      }
    }
    let current: ProgramSemanticCurrentSnapshotV1 | undefined;
    for (const programStateId of programStateIds) {
      const snapshot = recoverAdaptiveProgramCurrentSnapshotV2(events, programStateId);
      if (snapshot === undefined || !snapshot.attachedSessionIds.includes(sessionId)) continue;
      if (current !== undefined) {
        throw new ProgramAdaptiveOperationalOverlayErrorV2(
          `Multiple adaptive Programs claim attached Session ${sessionId}`,
        );
      }
      current = snapshot;
    }
    return current;
  }

  operationalCurrentnessSource(): ProgramSemanticOperationalCurrentnessSourceV1 {
    return {
      current: async (programStateId: string) => {
        const snapshot = await this.current(programStateId);
        return {
          programStateRevision: snapshot.programStateRevision,
          lifecycle: snapshot.lifecycle,
          attachedSessionIds: [...snapshot.attachedSessionIds],
          activeAttempt: structuredClone(snapshot.activeAttempt),
        };
      },
    };
  }

  async hasAnyAttempt(programStateId: string): Promise<boolean> {
    const events = await replayAllV2(this.store);
    return events.some((event) => {
      if (event.type !== "program.transitioned" || String(event.programStateId ?? "") !== programStateId) return false;
      const payload = record(event.payload);
      const state = payload.state as ProgramState | undefined;
      return payload.transitionKind === "attempt.issue" && state !== undefined && state.activeAttempt !== null;
    });
  }
}
