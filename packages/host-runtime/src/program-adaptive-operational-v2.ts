import type { PersistedDomainEvent } from "@alcode/events";
import {
  canonicalStringify,
  isProgramSemanticRequirementComplete,
  type ProgramAttempt,
  type ProgramAttemptSemanticAssumptionsV1,
  type ProgramSemanticStateV1,
  type ProgramSemanticWorkItemV1,
  type ProgramState,
  type VerificationObligation,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import type {
  ProgramAdaptiveAttemptHistoryV2,
  ProgramAdaptiveSemanticSessionStateSourceV2,
} from "./program-adaptive-control-v2.ts";
import type { ProgramSemanticCurrentSnapshotV1, ProgramSemanticCurrentStateSourceV1 } from "./program-revision.ts";
import {
  ProgramSemanticRecoveryError,
  recoverProgramSemanticStateV1,
  type ProgramSemanticOperationalCurrentnessSourceV1,
  type ProgramSemanticOperationalCurrentnessV1,
} from "./program-semantic-recovery-v1.ts";

export class ProgramAdaptiveOperationalOverlayErrorV2 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramAdaptiveOperationalOverlayErrorV2";
  }
}

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

function latestProgramStateEventV2(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
): ProgramStateEventV2 | undefined {
  let latest: ProgramStateEventV2 | undefined;
  for (const event of events) {
    if (!isProgramStateEvent(event.type) || String(event.programStateId ?? "") !== programStateId) continue;
    const state = record(event.payload).state as ProgramState | undefined;
    if (state === undefined) {
      throw new ProgramAdaptiveOperationalOverlayErrorV2(`${event.type} lacks payload.state`);
    }
    if (String(state.programStateId) !== programStateId) {
      throw new ProgramAdaptiveOperationalOverlayErrorV2(`${event.type} ProgramState identity disagrees with its envelope`);
    }
    latest = { event, state };
  }
  return latest;
}

function semanticHeadEventSequenceV2(
  events: readonly PersistedDomainEvent<string, unknown>[],
  semantic: ProgramSemanticStateV1,
): number {
  const admissionEventId = String(semantic.currentRevision.admissionEventId);
  const event = events.find((candidate) => String(candidate.eventId) === admissionEventId);
  if (event === undefined) {
    throw new ProgramAdaptiveOperationalOverlayErrorV2(
      `Current semantic head lacks canonical admission event ${admissionEventId}`,
    );
  }
  return event.sequence;
}

function sameStrings(left: readonly unknown[], right: readonly unknown[]): boolean {
  return canonicalStringify(left.map(String)) === canonicalStringify(right.map(String));
}

function legacyLifecycleToSemantic(
  lifecycle: ProgramState["workItems"][number]["lifecycle"],
): ProgramSemanticWorkItemV1["satisfactionState"] {
  switch (lifecycle) {
    case "pending": return "pending";
    case "in_progress": return "active";
    case "blocked": return "blocked";
    case "awaiting_verification": return "awaiting_verification";
    case "completed": return "satisfied";
  }
}

function sameVerificationDefinition(left: VerificationObligation, right: VerificationObligation): boolean {
  return canonicalStringify({
    obligationId: left.obligationId,
    predicate: left.predicate,
    freshnessScope: left.freshnessScope,
  }) === canonicalStringify({
    obligationId: right.obligationId,
    predicate: right.predicate,
    freshnessScope: right.freshnessScope,
  });
}

/**
 * Overlay post-semantic-cut operational progress onto one recovered semantic
 * head. The overlay is accepted only when the legacy operational snapshot is
 * structurally identical to that semantic head; otherwise it fails closed.
 */
export function overlayAdaptiveSemanticOperationalFieldsV2(
  semantic: ProgramSemanticStateV1,
  rawState: ProgramState,
  rawStateIsAfterSemanticHead: boolean,
): ProgramSemanticStateV1 {
  if (!rawStateIsAfterSemanticHead) return structuredClone(semantic);

  const rawWork = new Map(rawState.workItems.map((work) => [String(work.workItemId), work]));
  const workItems = semantic.workItems.map((work) => {
    const raw = rawWork.get(String(work.workItemId));
    if (raw === undefined) {
      throw new ProgramAdaptiveOperationalOverlayErrorV2(
        `Post-semantic operational state omits current WorkItem ${String(work.workItemId)}`,
      );
    }
    if (raw.description !== work.description
        || raw.creationOrder !== work.creationOrder
        || !sameStrings(raw.dependencyIds, work.dependencyIds)
        || canonicalStringify(raw.affectedPaths) !== canonicalStringify(work.affectedPaths)) {
      throw new ProgramAdaptiveOperationalOverlayErrorV2(
        `Post-semantic operational WorkItem ${String(work.workItemId)} does not match current semantic structure`,
      );
    }
    if (work.requirementState !== "required" || work.topologyState !== "leaf") return structuredClone(work);
    return { ...structuredClone(work), satisfactionState: legacyLifecycleToSemantic(raw.lifecycle) };
  });

  const rawVerification = new Map(rawState.verification.map((item) => [String(item.obligationId), item]));
  const verification = semantic.verification.map((obligation) => {
    const raw = rawVerification.get(String(obligation.obligationId));
    if (raw === undefined) {
      throw new ProgramAdaptiveOperationalOverlayErrorV2(
        `Post-semantic operational state omits verification ${String(obligation.obligationId)}`,
      );
    }
    if (!sameVerificationDefinition(raw, obligation)) {
      throw new ProgramAdaptiveOperationalOverlayErrorV2(
        `Post-semantic operational verification ${String(obligation.obligationId)} changed semantic definition`,
      );
    }
    return structuredClone(raw);
  });

  return {
    ...structuredClone(semantic),
    workItems,
    verification,
  };
}

export function deriveAttemptSemanticAssumptionsV2(
  semantic: ProgramSemanticStateV1,
  attempt: ProgramAttempt,
): ProgramAttemptSemanticAssumptionsV1 {
  const target = semantic.workItems.find((work) => String(work.workItemId) === String(attempt.workItemId));
  if (target === undefined || target.requirementState !== "required" || target.topologyState !== "leaf"
      || target.satisfactionState !== "pending") {
    throw new ProgramAdaptiveOperationalOverlayErrorV2(
      `Attempt ${String(attempt.programAttemptId)} was issued for non-ready adaptive work`,
    );
  }
  const byId = new Map(semantic.workItems.map((work) => [String(work.workItemId), work]));
  const directDependencies = target.dependencyIds.map((dependencyId) => {
    const dependency = byId.get(String(dependencyId));
    if (dependency === undefined || dependency.requirementState !== "required"
        || !isProgramSemanticRequirementComplete(dependency.workItemId, semantic.workItems)) {
      throw new ProgramAdaptiveOperationalOverlayErrorV2(
        `Attempt ${String(attempt.programAttemptId)} was issued without a complete current direct dependency ${String(dependencyId)}`,
      );
    }
    return {
      workItemId: dependency.workItemId,
      workItemGeneration: dependency.workItemGeneration,
      required: true as const,
      satisfiedOrDischargedAtIssue: true as const,
    };
  });
  return {
    programAttemptId: attempt.programAttemptId,
    workItemId: target.workItemId,
    workItemGeneration: target.workItemGeneration,
    directDependencies,
    workAuthorityEnvelope: structuredClone(target.authorityEnvelope),
  };
}

function attemptIssueSequenceV2(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
  attemptId: string,
): number | undefined {
  for (const event of events) {
    if (event.type !== "program.transitioned" || String(event.programStateId ?? "") !== programStateId) continue;
    const payload = record(event.payload);
    if (payload.transitionKind !== "attempt.issue") continue;
    const state = payload.state as ProgramState | undefined;
    if (state?.activeAttempt !== null && String(state?.activeAttempt?.programAttemptId ?? "") === attemptId) {
      return event.sequence;
    }
  }
  return undefined;
}

/** Canonical semantic cuts permanently retire an Attempt once its id appears in invalidatedAttempts. */
export function adaptiveAttemptInvalidatedAfterIssueV2(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
  attemptId: string,
  issueSequence: number,
): boolean {
  for (const event of events) {
    if (event.sequence <= issueSequence
        || event.type !== "program.semantic_revision.admitted.v1"
        || String(event.programStateId ?? "") !== programStateId) continue;
    const cut = record(event.payload).cut as { revisionImpact?: { invalidatedAttempts?: unknown[] } } | undefined;
    if (cut?.revisionImpact?.invalidatedAttempts?.some((id) => String(id) === attemptId)) return true;
  }
  return false;
}

function semanticAtIssueV2(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
  issueSequence: number,
): ProgramSemanticStateV1 {
  const beforeIssue = events.filter((event) => event.sequence < issueSequence);
  const recovered = recoverProgramSemanticStateV1(beforeIssue, programStateId);
  if (recovered === undefined) {
    throw new ProgramAdaptiveOperationalOverlayErrorV2(
      `Adaptive Attempt was issued before semantic baseline adoption for ${programStateId}`,
    );
  }
  const raw = latestProgramStateEventV2(beforeIssue, programStateId);
  if (raw === undefined) {
    throw new ProgramAdaptiveOperationalOverlayErrorV2(`Adaptive Attempt lacks pre-issue ProgramState ${programStateId}`);
  }
  const semanticHeadSequence = semanticHeadEventSequenceV2(beforeIssue, recovered.semanticState);
  return overlayAdaptiveSemanticOperationalFieldsV2(
    recovered.semanticState,
    raw.state,
    raw.event.sequence > semanticHeadSequence,
  );
}

function currentAttemptAssumptionsV2(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
  rawState: ProgramState,
): ProgramAttemptSemanticAssumptionsV1 | null {
  if (rawState.lifecycle !== "active" || rawState.activeAttempt === null) return null;
  const attempt = rawState.activeAttempt;
  const attemptId = String(attempt.programAttemptId);
  const issueSequence = attemptIssueSequenceV2(events, programStateId, attemptId);
  if (issueSequence === undefined) {
    throw new ProgramAdaptiveOperationalOverlayErrorV2(
      `Active adaptive Attempt ${attemptId} lacks canonical attempt.issue history`,
    );
  }
  if (adaptiveAttemptInvalidatedAfterIssueV2(events, programStateId, attemptId, issueSequence)) return null;
  return deriveAttemptSemanticAssumptionsV2(semanticAtIssueV2(events, programStateId, issueSequence), attempt);
}

/**
 * Recover one race-free logical adaptive current state from canonical events.
 * Semantic admission and ordinary ProgramState transitions share the monotonic
 * whole-state revision axis even though they are represented by different event
 * families. A post-semantic operational snapshot that did not advance beyond
 * the semantic cut is rejected as a stale writer.
 */
export function recoverAdaptiveProgramCurrentSnapshotV2(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
): ProgramSemanticCurrentSnapshotV1 | undefined {
  const recovered = recoverProgramSemanticStateV1(events, programStateId);
  if (recovered === undefined) return undefined;
  const raw = latestProgramStateEventV2(events, programStateId);
  if (raw === undefined) {
    throw new ProgramAdaptiveOperationalOverlayErrorV2(`Adaptive Program lacks operational ProgramState ${programStateId}`);
  }
  const semanticHeadSequence = semanticHeadEventSequenceV2(events, recovered.semanticState);
  const rawAfterSemanticHead = raw.event.sequence > semanticHeadSequence;
  if (rawAfterSemanticHead && raw.state.revision <= recovered.programStateRevision) {
    throw new ProgramAdaptiveOperationalOverlayErrorV2(
      "Post-semantic operational ProgramState did not advance beyond the current semantic whole-state revision",
    );
  }
  const semanticState = overlayAdaptiveSemanticOperationalFieldsV2(
    recovered.semanticState,
    raw.state,
    rawAfterSemanticHead,
  );
  return {
    programStateRevision: Math.max(raw.state.revision, recovered.programStateRevision),
    semanticState,
    activeAttempt: currentAttemptAssumptionsV2(events, programStateId, raw.state),
    lifecycle: raw.state.lifecycle,
    attachedSessionIds: raw.state.attachedSessionIds.map(String),
  };
}

async function replayAllV2(store: WorkspaceEventStore): Promise<PersistedDomainEvent<string, unknown>[]> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

/** Production event-derived current-state source for adaptive semantic and operational consumers. */
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
      current: async (programStateId: string): Promise<ProgramSemanticOperationalCurrentnessV1> => {
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
