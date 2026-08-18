import {
  asProgramStateId as asEventProgramStateId,
  asWorkspaceId,
  mkEventId,
  type EventDraft,
  type PersistedDomainEvent,
  type SessionId,
} from "@alcode/events";
import {
  ProgramRevisionConflictError,
  ProgramTransitionError,
  applyProgramTransition,
  assertValidProgramState,
  isVerificationCurrent,
  type ProgramState,
  type ProgramWorkItem,
  type VerificationObligation,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import type { ProgramExecutionSchedulerV1 } from "./program-execution-scheduler.ts";
import type { ProgramTerminalServiceV1 } from "./program-terminal.ts";
import type {
  ProgramProductionStepResultV1,
  ProgramVerificationResultV1,
  ProgramVerificationServiceV1,
} from "./program-verification.ts";

export interface ProgramExecutionIdleAgentAuthorityV1 {
  isCurrent(sessionId: string, connectionGenerationId: string, agentGeneration: number): boolean;
}

export type ProgramExecutionIdleResultV1 =
  | { status: "not_program" }
  | { status: "handled"; terminal: "none" | "completed" | "cancelled"; reason?: string };

export interface ProgramExecutionControlOptionsV1 {
  store: WorkspaceEventStore;
  admission: CanonicalAdmissionQueue;
  verification: ProgramVerificationServiceV1;
  scheduler: ProgramExecutionSchedulerV1;
  terminal: ProgramTerminalServiceV1;
  agents: ProgramExecutionIdleAgentAuthorityV1;
}

export class ProgramExecutionControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramExecutionControlError";
  }
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

function latestStates(events: readonly PersistedDomainEvent<string, unknown>[]): ProgramState[] {
  const states = new Map<string, ProgramState>();
  for (const event of events) {
    if (event.type !== "program.created" && event.type !== "program.transitioned"
        && event.type !== "program.completed" && event.type !== "program.cancelled") continue;
    const state = record(event.payload).state as ProgramState | undefined;
    if (state === undefined) continue;
    assertValidProgramState(state);
    states.set(String(state.programStateId), state);
  }
  return [...states.values()];
}

function attachedProgramState(
  events: readonly PersistedDomainEvent<string, unknown>[],
  sessionId: string,
): ProgramState | undefined {
  const matching = latestStates(events).filter((state) =>
    state.attachedSessionIds.some((id) => String(id) === sessionId));
  if (matching.length > 1) {
    throw new ProgramExecutionControlError(`Multiple ProgramStates are attached to Session ${sessionId}`);
  }
  return matching[0];
}

function transitionDraft(
  store: WorkspaceEventStore,
  sessionId: SessionId,
  state: ProgramState,
  transitionKind: string,
  correlationId: string,
): EventDraft<string, unknown> {
  return {
    eventId: mkEventId(),
    idempotencyKey: `program.execution.control:${String(state.programStateId)}:${state.revision}`,
    correlationId,
    workspaceId: asWorkspaceId(store.workspaceId),
    sessionId,
    programStateId: asEventProgramStateId(String(state.programStateId)),
    occurredAt: new Date().toISOString(),
    type: "program.transitioned",
    payload: { state, transitionKind },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-execution-control" },
  };
}

function pathOverlaps(left: string, right: string): boolean {
  if (left === right) return true;
  const l = left.endsWith("/") ? left : `${left}/`;
  const r = right.endsWith("/") ? right : `${right}/`;
  return l.startsWith(r) || r.startsWith(l);
}

function artifactObligationOwnedByWork(
  state: ProgramState,
  work: ProgramWorkItem,
  obligation: VerificationObligation,
): boolean {
  if (obligation.predicate.kind !== "artifact_present") return false;
  const slot = state.outputSlots.find((item) => item.outputSlotId === obligation.predicate.outputSlotId);
  if (slot === undefined) return false;
  const step = state.productionSteps.find((item) => item.productionStepId === slot.productionStepId);
  return step?.producerWorkItemId === work.workItemId;
}

function obligationIsWorkBound(
  state: ProgramState,
  work: ProgramWorkItem,
  obligation: VerificationObligation,
): boolean {
  if (artifactObligationOwnedByWork(state, work, obligation)) return true;
  if (obligation.predicate.kind === "workspace_path_state"
      && work.affectedPaths.some((path) => pathOverlaps(path, obligation.predicate.path))) return true;
  return state.decisiveEvidence.some((evidence) =>
    evidence.workItemId === work.workItemId
    && evidence.verificationObligationId === obligation.obligationId);
}

function requiredForCurrentWork(
  state: ProgramState,
  work: ProgramWorkItem,
): VerificationObligation[] {
  const otherIncomplete = state.workItems.some((candidate) =>
    candidate.workItemId !== work.workItemId && candidate.lifecycle !== "completed");
  return state.verification.filter((obligation) =>
    obligationIsWorkBound(state, work, obligation) || !otherIncomplete);
}

function currentWork(state: ProgramState): ProgramWorkItem | undefined {
  const attempt = state.activeAttempt;
  return attempt === null ? undefined : state.workItems.find((item) => item.workItemId === attempt.workItemId);
}

function artifactBound(state: ProgramState, obligation: VerificationObligation): boolean {
  if (obligation.predicate.kind !== "artifact_present") return false;
  return state.artifacts.some((artifact) => artifact.outputSlotId === obligation.predicate.outputSlotId);
}

export class ProgramExecutionControlV1 {
  constructor(private readonly options: ProgramExecutionControlOptionsV1) {}

  async handleAgentIdle(input: {
    connectionGenerationId: string;
    sessionId: SessionId;
  }): Promise<ProgramExecutionIdleResultV1> {
    const sessionId = String(input.sessionId);
    let state = attachedProgramState(await replayAll(this.options.store), sessionId);
    if (state === undefined) return { status: "not_program" };
    if (state.lifecycle === "completed") return { status: "handled", terminal: "completed" };
    if (state.lifecycle === "cancelled") return { status: "handled", terminal: "cancelled" };

    const attempt = state.activeAttempt;
    if (attempt === null) return this.tryTerminal(state, input.sessionId);
    if (String(attempt.sessionId) !== sessionId
        || !this.options.agents.isCurrent(sessionId, input.connectionGenerationId, attempt.agentGeneration)) {
      return { status: "handled", terminal: "none", reason: "stale_agent_idle" };
    }
    const work = currentWork(state);
    if (work === undefined) throw new ProgramExecutionControlError("Active ProgramAttempt work item is missing");
    if (work.lifecycle !== "awaiting_verification") {
      return { status: "handled", terminal: "none", reason: `work_${work.lifecycle}` };
    }

    const maxVerificationPasses = Math.max(1, state.verification.length * 2 + 2);
    for (let pass = 0; pass < maxVerificationPasses; pass++) {
      state = attachedProgramState(await replayAll(this.options.store), sessionId);
      if (state === undefined) return { status: "not_program" };
      if (state.lifecycle === "completed") return { status: "handled", terminal: "completed" };
      if (state.lifecycle === "cancelled") return { status: "handled", terminal: "cancelled" };
      const currentAttempt = state.activeAttempt;
      const current = currentWork(state);
      if (currentAttempt === null || current === undefined
          || String(currentAttempt.programAttemptId) !== String(attempt.programAttemptId)
          || current.lifecycle !== "awaiting_verification") {
        return { status: "handled", terminal: "none", reason: "program_control_changed" };
      }

      const pending = requiredForCurrentWork(state, current).find((obligation) => !isVerificationCurrent(obligation));
      if (pending === undefined) {
        const completed = await this.completeCurrentWork(state, input.sessionId, String(currentAttempt.programAttemptId));
        const scheduled = await this.options.scheduler.dispatchNext({
          programStateId: String(completed.programStateId),
          sessionId: input.sessionId,
        });
        if (scheduled.status === "issued") {
          return { status: "handled", terminal: "none", reason: "successor_dispatched" };
        }
        const terminalState = "state" in scheduled ? scheduled.state : completed;
        return this.tryTerminal(terminalState, input.sessionId);
      }

      const result = await this.verifyOne(state, pending, input.sessionId);
      if (result === "satisfied") continue;
      const retry = await this.returnCurrentWorkToPending(
        String(state.programStateId),
        input.sessionId,
        String(currentAttempt.programAttemptId),
      );
      return {
        status: "handled",
        terminal: "none",
        reason: result === "stale_generation" ? "verification_stale_generation" : "verification_not_satisfied",
      };
    }

    await this.returnCurrentWorkToPending(
      String(state.programStateId),
      input.sessionId,
      String(state.activeAttempt?.programAttemptId ?? ""),
    );
    return { status: "handled", terminal: "none", reason: "verification_did_not_converge" };
  }

  private async verifyOne(
    state: ProgramState,
    obligation: VerificationObligation,
    sessionId: SessionId,
  ): Promise<"satisfied" | "not_satisfied" | "stale_generation"> {
    let current = state;
    if (obligation.predicate.kind === "artifact_present" && !artifactBound(current, obligation)) {
      const produced = await this.options.verification.executeProductionStep({
        programStateId: String(current.programStateId),
        expectedProgramRevision: current.revision,
        outputSlotId: String(obligation.predicate.outputSlotId),
        sessionId,
      });
      if (produced.status !== "bound") return "not_satisfied";
      current = produced.state;
    }

    let result: ProgramVerificationResultV1;
    const command = {
      programStateId: String(current.programStateId),
      expectedProgramRevision: current.revision,
      verificationObligationId: String(obligation.obligationId),
      sessionId,
    };
    switch (obligation.predicate.kind) {
      case "operation_result":
        result = await this.options.verification.satisfyOperationResult(command);
        break;
      case "workspace_path_state":
        result = await this.options.verification.satisfyWorkspacePathState(command);
        break;
      case "artifact_present":
        result = await this.options.verification.satisfyArtifactPresent(command);
        break;
    }
    if (result.status === "satisfied") return "satisfied";
    if (result.status === "stale_generation") return "stale_generation";
    return "not_satisfied";
  }

  private async completeCurrentWork(
    expected: ProgramState,
    sessionId: SessionId,
    programAttemptId: string,
  ): Promise<ProgramState> {
    return this.options.admission.enqueue(async () => {
      const state = attachedProgramState(await replayAll(this.options.store), String(sessionId));
      if (state === undefined || String(state.programStateId) !== String(expected.programStateId)
          || state.revision !== expected.revision || state.lifecycle !== "active") {
        throw new ProgramRevisionConflictError(expected.revision, state?.revision ?? -1);
      }
      const attempt = state.activeAttempt;
      const work = currentWork(state);
      if (attempt === null || work === undefined || String(attempt.programAttemptId) !== programAttemptId
          || work.lifecycle !== "awaiting_verification") {
        throw new ProgramExecutionControlError("ProgramAttempt changed before work completion admission");
      }
      if (requiredForCurrentWork(state, work).some((obligation) => !isVerificationCurrent(obligation))) {
        throw new ProgramExecutionControlError("Current work verification is not complete");
      }

      const retired = applyProgramTransition(state, {
        kind: "attempt.interrupt",
        expectedProgramRevision: state.revision,
        programAttemptId,
      });
      const completed = applyProgramTransition(retired, {
        kind: "work.lifecycle.set",
        expectedProgramRevision: retired.revision,
        workItemId: work.workItemId,
        lifecycle: "completed",
      });
      const persisted = await this.options.store.append([
        transitionDraft(this.options.store, sessionId, retired, "attempt.interrupt:verified", programAttemptId),
        transitionDraft(this.options.store, sessionId, completed, "work.lifecycle.set:completed", programAttemptId),
      ]);
      if (persisted.length !== 2) throw new ProgramExecutionControlError("Verified work completion admission was not atomic");
      return completed;
    });
  }

  private async returnCurrentWorkToPending(
    programStateId: string,
    sessionId: SessionId,
    programAttemptId: string,
  ): Promise<ProgramState> {
    return this.options.admission.enqueue(async () => {
      const state = attachedProgramState(await replayAll(this.options.store), String(sessionId));
      if (state === undefined || String(state.programStateId) !== programStateId) {
        throw new ProgramExecutionControlError("Program changed before verification retry admission");
      }
      if (state.lifecycle !== "active" || state.activeAttempt === null
          || String(state.activeAttempt.programAttemptId) !== programAttemptId) return state;
      const work = currentWork(state);
      if (work === undefined) throw new ProgramExecutionControlError("Active retry work item is missing");

      const retired = applyProgramTransition(state, {
        kind: "attempt.interrupt",
        expectedProgramRevision: state.revision,
        programAttemptId,
      });
      const pending = applyProgramTransition(retired, {
        kind: "work.lifecycle.set",
        expectedProgramRevision: retired.revision,
        workItemId: work.workItemId,
        lifecycle: "pending",
      });
      const drafts = [
        transitionDraft(this.options.store, sessionId, retired, "attempt.interrupt:verification_failed", programAttemptId),
      ];
      if (pending !== retired) {
        drafts.push(transitionDraft(this.options.store, sessionId, pending, "work.lifecycle.set:pending", programAttemptId));
      }
      await this.options.store.append(drafts);
      return pending;
    });
  }

  private async tryTerminal(state: ProgramState, sessionId: SessionId): Promise<ProgramExecutionIdleResultV1> {
    if (state.lifecycle === "completed") return { status: "handled", terminal: "completed" };
    if (state.lifecycle === "cancelled") return { status: "handled", terminal: "cancelled" };
    if (state.activeAttempt !== null) return { status: "handled", terminal: "none" };
    if (state.workItems.some((work) => work.lifecycle !== "completed")) {
      return { status: "handled", terminal: "none", reason: "program_active_idle" };
    }
    const result = await this.options.terminal.complete({
      programStateId: String(state.programStateId),
      expectedProgramRevision: state.revision,
      sessionId,
    });
    if (result.status === "completed") return { status: "handled", terminal: "completed" };
    return { status: "handled", terminal: "none", reason: result.status };
  }
}
