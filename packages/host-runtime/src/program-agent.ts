import {
  asProgramStateId as asEventProgramStateId,
  asWorkspaceId,
  mkEventId,
  type EventDraft,
  type PersistedDomainEvent,
  type SessionId as EventSessionId,
} from "@alcode/events";
import type { ProgramAttemptAuthorityV1, ProgramAttemptProjectionV1 } from "@alcode/agent-protocol";
import {
  applyProgramTransition,
  assertValidProgramState,
  isVerificationCurrent,
  type ProgramState,
  type VerificationFreshnessScopeV1,
  type VerificationPredicateV1,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import type { ProgramAgentGenerationAuthorityV1 } from "./program-dispatch.ts";

export const PROGRAM_ATTEMPT_PROJECTION_MAX_BYTES = 128 * 1024;

const MAX_AFFECTED_PATHS = 16;
const MAX_BLOCKERS = 16;
const MAX_VERIFICATION = 32;
const MAX_EVIDENCE = 64;
const MAX_ARTIFACTS = 64;
const MAX_FRESHNESS_PATHS = 2;
const MAX_BLOCKER_REASON_CHARS = 1024;

interface ProgramAgentBindingV1 {
  connectionGenerationId: string;
  agentGeneration: number;
  programStateCapable: boolean;
  programExecutionCapable: boolean;
}

export class ProgramAgentControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramAgentControlError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isProgramStateEvent(type: string): boolean {
  return type === "program.created" || type === "program.transitioned" ||
    type === "program.completed" || type === "program.cancelled";
}

async function replayAll(store: WorkspaceEventStore): Promise<PersistedDomainEvent<string, unknown>[]> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

function latestStates(events: readonly PersistedDomainEvent<string, unknown>[]): Map<string, ProgramState> {
  const states = new Map<string, ProgramState>();
  for (const event of events) {
    if (!isProgramStateEvent(event.type) || event.programStateId === undefined) continue;
    const state = record(event.payload).state as ProgramState | undefined;
    if (state === undefined) throw new ProgramAgentControlError(`${event.type} lacks payload.state`);
    assertValidProgramState(state);
    if (String(state.programStateId) !== String(event.programStateId)) {
      throw new ProgramAgentControlError(`${event.type} state identity does not match envelope`);
    }
    states.set(String(state.programStateId), state);
  }
  return states;
}

function maxHistoricalAgentGeneration(
  events: readonly PersistedDomainEvent<string, unknown>[],
  sessionId: string,
): number {
  let max = 0;
  for (const event of events) {
    if (!isProgramStateEvent(event.type)) continue;
    const state = record(event.payload).state as ProgramState | undefined;
    const attempt = state?.activeAttempt;
    if (attempt !== null && attempt !== undefined && String(attempt.sessionId) === sessionId) {
      max = Math.max(max, attempt.agentGeneration);
    }
  }
  return max;
}

function replacementTransitionDraft(
  store: WorkspaceEventStore,
  sessionId: EventSessionId,
  state: ProgramState,
  oldAttemptId: string,
  newGeneration: number,
): EventDraft<string, unknown> {
  return {
    eventId: mkEventId(),
    idempotencyKey: `program.agent_replaced:${String(state.programStateId)}:${oldAttemptId}:${newGeneration}`,
    correlationId: oldAttemptId,
    workspaceId: asWorkspaceId(store.workspaceId),
    sessionId,
    programStateId: asEventProgramStateId(String(state.programStateId)),
    occurredAt: new Date().toISOString(),
    type: "program.transitioned",
    payload: {
      state,
      transitionKind: "attempt.interrupt",
      reason: "agent_replaced",
      replacementAgentGeneration: newGeneration,
    },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-agent" },
  };
}

function predicateSummary(predicate: VerificationPredicateV1): Record<string, unknown> {
  switch (predicate.kind) {
    case "operation_result":
      return {
        kind: predicate.kind,
        specId: predicate.specId,
        specVersion: predicate.specVersion,
        canonicalArgsDigest: predicate.canonicalArgsDigest,
      };
    case "workspace_path_state":
      return { kind: predicate.kind, path: predicate.path, requiredState: predicate.requiredState };
    case "artifact_present":
      return { kind: predicate.kind, outputSlotId: String(predicate.outputSlotId) };
    default:
      return { kind: "unsupported" };
  }
}

function freshnessSummary(scope: VerificationFreshnessScopeV1): Record<string, unknown> {
  if (scope.kind === "workspace") return { kind: "workspace" };
  const entries = scope.entries.slice(0, MAX_FRESHNESS_PATHS).map((entry) => ({
    path: entry.path,
    mode: entry.mode,
  }));
  return {
    kind: "paths",
    entries,
    omittedEntryCount: Math.max(0, scope.entries.length - entries.length),
  };
}

function clipReason(reason: string): { reason: string; truncated: boolean } {
  if (reason.length <= MAX_BLOCKER_REASON_CHARS) return { reason, truncated: false };
  return { reason: reason.slice(0, MAX_BLOCKER_REASON_CHARS), truncated: true };
}

function buildProjection(state: ProgramState): ProgramAttemptProjectionV1 {
  const attempt = state.activeAttempt;
  if (attempt === null) throw new ProgramAgentControlError("Cannot project a Program without an active Attempt");
  const work = state.workItems.find((item) => item.workItemId === attempt.workItemId);
  if (work === undefined) throw new ProgramAgentControlError("Active Attempt work item is missing");

  const affectedPaths = work.affectedPaths.slice(0, MAX_AFFECTED_PATHS);
  const dependencies = work.dependencyIds.map((workItemId) => {
    const dependency = state.workItems.find((item) => item.workItemId === workItemId);
    if (dependency === undefined) {
      throw new ProgramAgentControlError(`Missing dependency ${String(workItemId)}`);
    }
    return { workItemId: String(workItemId), lifecycle: dependency.lifecycle };
  });

  const relevantBlockers = state.blockers.filter((blocker) =>
    blocker.state === "open" && (blocker.workItemId === null || blocker.workItemId === work.workItemId));
  const blockers = relevantBlockers.slice(0, MAX_BLOCKERS).map((blocker) => ({
    blockerId: String(blocker.blockerId),
    workItemId: blocker.workItemId === null ? null : String(blocker.workItemId),
    ...clipReason(blocker.reason),
  }));

  const verificationSource = state.verification.slice(0, MAX_VERIFICATION);
  const verification = verificationSource.map((obligation) => ({
    obligationId: String(obligation.obligationId),
    subjectGeneration: obligation.subjectGeneration,
    current: isVerificationCurrent(obligation),
    waived: obligation.waiver?.subjectGeneration === obligation.subjectGeneration,
    predicate: predicateSummary(obligation.predicate),
    freshnessScope: freshnessSummary(obligation.freshnessScope),
  }));

  const productionSteps = state.productionSteps
    .filter((step) => step.producerWorkItemId === work.workItemId)
    .map((step) => ({
      productionStepId: String(step.productionStepId),
      outputSlotIds: state.outputSlots
        .filter((slot) => slot.productionStepId === step.productionStepId)
        .map((slot) => String(slot.outputSlotId)),
      outputChannel: step.outputChannel,
      specId: step.specId,
      specVersion: step.specVersion,
      canonicalArgsDigest: step.canonicalArgsDigest,
    }));
  const outputSlotSet = new Set(productionSteps.flatMap((step) => step.outputSlotIds));
  const outputSlots = state.outputSlots
    .filter((slot) => outputSlotSet.has(String(slot.outputSlotId)))
    .map((slot) => ({
      outputSlotId: String(slot.outputSlotId),
      productionStepId: String(slot.productionStepId),
    }));

  const evidenceSource = state.decisiveEvidence.filter((evidence) =>
    evidence.workItemId === work.workItemId || evidence.verificationObligationId !== null);
  const decisiveEvidence = evidenceSource.slice(0, MAX_EVIDENCE).map((evidence) => ({
    evidenceRefId: String(evidence.evidenceRefId),
    verificationObligationId: evidence.verificationObligationId === null
      ? null
      : String(evidence.verificationObligationId),
    sourceOperationId: evidence.sourceOperationId === null ? null : String(evidence.sourceOperationId),
    artifactRef: evidence.artifactRef,
    subjectGeneration: evidence.subjectGeneration ?? null,
  }));

  const referencedArtifactRefs = new Set(
    decisiveEvidence.flatMap((evidence) => evidence.artifactRef === null ? [] : [evidence.artifactRef]),
  );
  for (const artifact of state.artifacts) {
    if (artifact.outputSlotId !== null && outputSlotSet.has(String(artifact.outputSlotId))) {
      referencedArtifactRefs.add(artifact.artifactRef);
    }
  }
  const artifactSource = state.artifacts.filter((artifact) => referencedArtifactRefs.has(artifact.artifactRef));
  const artifacts = artifactSource.slice(0, MAX_ARTIFACTS).map((artifact) => ({
    artifactRef: artifact.artifactRef,
    outputSlotId: artifact.outputSlotId === null ? null : String(artifact.outputSlotId),
    productionStepId: artifact.productionStepId === null ? null : String(artifact.productionStepId),
  }));

  const projection: ProgramAttemptProjectionV1 = {
    version: 1,
    authority: {
      programStateId: String(state.programStateId),
      expectedProgramRevision: state.revision,
      programAttemptId: String(attempt.programAttemptId),
      workItemId: String(attempt.workItemId),
      agentGeneration: attempt.agentGeneration,
    },
    objective: state.objective,
    work: {
      description: work.description,
      lifecycle: work.lifecycle,
      dependencyIds: work.dependencyIds.map(String),
      affectedPaths,
      omittedAffectedPathCount: Math.max(0, work.affectedPaths.length - affectedPaths.length),
    },
    dependencies,
    blockers,
    executionBase: structuredClone(attempt.expectedExecutionBase),
    verification,
    outputSlots,
    productionSteps,
    decisiveEvidence,
    artifacts,
    control: {
      executionBaseMismatch: state.executionBaseMismatch !== null,
      executionBaseUnavailable: state.executionBaseUnavailable,
    },
    omissions: {
      verification: Math.max(0, state.verification.length - verification.length),
      blockers: Math.max(0, relevantBlockers.length - blockers.length),
      evidence: Math.max(0, evidenceSource.length - decisiveEvidence.length),
      artifacts: Math.max(0, artifactSource.length - artifacts.length),
    },
    stopConditions: {
      attemptMustRemainCurrent: true,
      rebaseRequiredOnExecutionBaseMismatch: true,
      hostOwnsVerificationAndCompletion: true,
    },
  };

  const bytes = Buffer.byteLength(JSON.stringify(projection), "utf8");
  if (bytes > PROGRAM_ATTEMPT_PROJECTION_MAX_BYTES) {
    throw new ProgramAgentControlError(
      `AttemptProjection exceeds ${PROGRAM_ATTEMPT_PROJECTION_MAX_BYTES} bytes`,
    );
  }
  return projection;
}

export class ProgramAgentServiceV1 implements ProgramAgentGenerationAuthorityV1 {
  private readonly bindings = new Map<string, ProgramAgentBindingV1>();
  private readonly counters = new Map<string, number>();

  constructor(
    private readonly store: WorkspaceEventStore,
    private readonly admission: CanonicalAdmissionQueue,
  ) {}

  async attach(
    sessionId: EventSessionId,
    connectionGenerationId: string,
    programStateCapable: boolean,
    programExecutionCapable = false,
  ): Promise<number> {
    if (connectionGenerationId.length === 0) {
      throw new ProgramAgentControlError("connectionGenerationId is required");
    }
    const sid = String(sessionId);
    const events = await replayAll(this.store);
    const next = Math.max(
      (this.counters.get(sid) ?? 0) + 1,
      maxHistoricalAgentGeneration(events, sid) + 1,
    );
    if (!Number.isSafeInteger(next) || next <= 0) {
      throw new ProgramAgentControlError("Agent generation exhausted");
    }

    // Replacement never inherits an old AttemptId. Canonical interruption is
    // admitted before the new connection becomes current Agent authority.
    await this.interruptSupersededAttempt(sessionId, next);
    this.counters.set(sid, next);
    this.bindings.set(sid, {
      connectionGenerationId,
      agentGeneration: next,
      programStateCapable,
      programExecutionCapable,
    });
    return next;
  }

  detach(sessionId: EventSessionId, connectionGenerationId: string): void {
    const sid = String(sessionId);
    if (this.bindings.get(sid)?.connectionGenerationId === connectionGenerationId) {
      this.bindings.delete(sid);
    }
  }

  isCurrent(sessionId: string, agentGeneration: number): boolean {
    return this.bindings.get(sessionId)?.agentGeneration === agentGeneration;
  }

  isCurrentConnection(sessionId: string, connectionGenerationId: string): boolean {
    return this.bindings.get(sessionId)?.connectionGenerationId === connectionGenerationId;
  }

  currentAgentGeneration(sessionId: string): number | null {
    return this.bindings.get(sessionId)?.agentGeneration ?? null;
  }

  currentExecutionAgentGeneration(sessionId: string): number | null {
    const binding = this.bindings.get(sessionId);
    return binding?.programExecutionCapable === true ? binding.agentGeneration : null;
  }

  programStateCapable(sessionId: string): boolean {
    return this.bindings.get(sessionId)?.programStateCapable === true;
  }

  programExecutionCapable(sessionId: string): boolean {
    return this.bindings.get(sessionId)?.programExecutionCapable === true;
  }

  async currentAttemptAuthority(
    sessionId: EventSessionId,
  ): Promise<ProgramAttemptAuthorityV1 | undefined> {
    const states = latestStates(await replayAll(this.store));
    const matching = [...states.values()].filter((state) =>
      state.lifecycle === "active" && state.activeAttempt !== null &&
      String(state.activeAttempt.sessionId) === String(sessionId));
    if (matching.length > 1) {
      throw new ProgramAgentControlError(
        `Multiple current ProgramAttempts claim session ${String(sessionId)}`,
      );
    }
    const state = matching[0];
    const attempt = state?.activeAttempt;
    if (state === undefined || attempt === null || attempt === undefined) return undefined;
    return {
      programStateId: String(state.programStateId),
      expectedProgramRevision: state.revision,
      programAttemptId: String(attempt.programAttemptId),
      workItemId: String(attempt.workItemId),
      agentGeneration: attempt.agentGeneration,
    };
  }

  async currentAttemptProjection(
    sessionId: EventSessionId,
    connectionGenerationId: string,
  ): Promise<ProgramAttemptProjectionV1 | undefined> {
    const binding = this.bindings.get(String(sessionId));
    if (binding === undefined || binding.connectionGenerationId !== connectionGenerationId ||
        !binding.programStateCapable) {
      return undefined;
    }

    const states = latestStates(await replayAll(this.store));
    const matching = [...states.values()].filter((state) =>
      state.lifecycle === "active" && state.activeAttempt !== null &&
      String(state.activeAttempt.sessionId) === String(sessionId) &&
      state.activeAttempt.agentGeneration === binding.agentGeneration);
    if (matching.length > 1) {
      throw new ProgramAgentControlError(
        `Multiple current ProgramAttempts claim session ${String(sessionId)}`,
      );
    }
    return matching[0] === undefined ? undefined : buildProjection(matching[0]);
  }

  private async interruptSupersededAttempt(
    sessionId: EventSessionId,
    newGeneration: number,
  ): Promise<void> {
    await this.admission.enqueue(async () => {
      const states = latestStates(await replayAll(this.store));
      const matching = [...states.values()].filter((state) =>
        state.lifecycle === "active" && state.activeAttempt !== null &&
        String(state.activeAttempt.sessionId) === String(sessionId));
      if (matching.length > 1) {
        throw new ProgramAgentControlError(
          `Multiple active ProgramAttempts claim session ${String(sessionId)}`,
        );
      }
      const state = matching[0];
      if (state === undefined || state.activeAttempt === null ||
          state.activeAttempt.agentGeneration === newGeneration) {
        return;
      }
      const oldAttemptId = String(state.activeAttempt.programAttemptId);
      const next = applyProgramTransition(state, {
        kind: "attempt.interrupt",
        expectedProgramRevision: state.revision,
        programAttemptId: state.activeAttempt.programAttemptId,
      });
      await this.store.append([
        replacementTransitionDraft(this.store, sessionId, next, oldAttemptId, newGeneration),
      ]);
    });
  }
}
