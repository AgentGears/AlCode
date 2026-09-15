import { AsyncLocalStorage } from "node:async_hooks";
import {
  mkEventId,
  type EventDraft,
  type PersistedDomainEvent,
} from "@alcode/events";
import type { ProgramState } from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import type { ExecutionWorldOperationProvenanceV1 } from "./execution-world.ts";
import {
  ProgramDispatchControlError,
  ProgramDispatchStaleError,
  resolveProgramAttemptExecutionWorldBindingV1,
  type ProgramExecutionWorldAuthorityV1,
  type ProgramRootOperationAuthorityV1,
  type ProgramRoutedRootOperationInputV1,
} from "./program-dispatch.ts";

interface AdaptiveExecutionWorldOperationScopeV1 {
  readonly input: ProgramRoutedRootOperationInputV1;
}

export interface ProgramAdaptiveExecutionWorldCompositionV1 {
  readonly store: WorkspaceEventStore;
  wrapOperationAuthority(authority: ProgramRootOperationAuthorityV1): ProgramRootOperationAuthorityV1;
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

function sameExecutionWorld(
  left: ExecutionWorldOperationProvenanceV1,
  right: ExecutionWorldOperationProvenanceV1,
): boolean {
  return left.workspaceId === right.workspaceId
    && left.providerKind === right.providerKind
    && left.executionWorldGenerationId === right.executionWorldGenerationId
    && left.providerDescriptorDigest === right.providerDescriptorDigest
    && left.effectivePolicyDigest === right.effectivePolicyDigest;
}

function requireWorkspace(
  store: WorkspaceEventStore,
  provenance: ExecutionWorldOperationProvenanceV1,
): void {
  if (provenance.workspaceId !== store.workspaceId) {
    throw new ProgramDispatchControlError(
      `Execution-world generation belongs to another Workspace: ${provenance.workspaceId}`,
    );
  }
}

function adaptiveAttemptBindingDraft(
  transition: EventDraft<string, unknown>,
  executionWorld: ExecutionWorldOperationProvenanceV1,
): EventDraft<string, unknown> | null {
  if (transition.type !== "program.transitioned") return null;
  const payload = record(transition.payload);
  if (payload.transitionKind !== "attempt.issue") return null;
  if (record(transition.producer).component !== "program-adaptive-admission-v2") return null;

  const state = payload.state as ProgramState | undefined;
  const attempt = state?.activeAttempt;
  if (state === undefined || attempt === null || attempt === undefined) {
    throw new ProgramDispatchControlError("Adaptive attempt.issue transition lacks active Attempt state");
  }
  if (transition.programStateId === undefined || transition.sessionId === undefined) {
    throw new ProgramDispatchControlError("Adaptive attempt.issue transition lacks durable ownership envelope");
  }
  const programAttemptId = String(attempt.programAttemptId);
  const workItemId = String(attempt.workItemId);
  if (programAttemptId.length === 0 || workItemId.length === 0) {
    throw new ProgramDispatchControlError("Adaptive attempt.issue transition has invalid Attempt identity");
  }

  return {
    eventId: mkEventId(),
    idempotencyKey: `program.attempt.execution_world.bound:${programAttemptId}`,
    correlationId: programAttemptId,
    workspaceId: transition.workspaceId,
    sessionId: transition.sessionId,
    programStateId: transition.programStateId,
    occurredAt: transition.occurredAt,
    type: "program.attempt.execution_world.bound",
    payload: {
      programAttemptId,
      workItemId,
      executionWorld: structuredClone(executionWorld),
    },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-adaptive-admission-a5" },
  };
}

function stampOperationExecutionWorld(
  drafts: readonly EventDraft<string, unknown>[],
  executionWorld: ExecutionWorldOperationProvenanceV1,
): EventDraft<string, unknown>[] {
  return drafts.map((draft, index) => index === 0
    ? {
        ...draft,
        payload: { ...record(draft.payload), executionWorld: structuredClone(executionWorld) },
      }
    : draft);
}

/**
 * A5 adapter around the frozen adaptive Program runtime. It does not own
 * scheduling or Operation admission. Instead it joins execution-world checks to
 * the adaptive runtime's existing canonical admission queue by intercepting the
 * final Workspace-store append performed from inside that queue.
 */
export function createProgramAdaptiveExecutionWorldCompositionV1(
  store: WorkspaceEventStore,
  executionWorld: ProgramExecutionWorldAuthorityV1,
): ProgramAdaptiveExecutionWorldCompositionV1 {
  const operationScope = new AsyncLocalStorage<AdaptiveExecutionWorldOperationScopeV1>();

  const adaptedStore = new Proxy({} as WorkspaceEventStore, {
    get(_target, property) {
      if (property === "append") {
        return async (drafts: readonly EventDraft<string, unknown>[]) => {
          let nextDrafts = [...drafts];

          const attemptTransition = drafts.find((draft) =>
            draft.type === "program.transitioned"
            && record(draft.payload).transitionKind === "attempt.issue"
            && record(draft.producer).component === "program-adaptive-admission-v2");
          if (attemptTransition !== undefined) {
            const current = await executionWorld.currentOperationProvenance();
            requireWorkspace(store, current);
            const binding = adaptiveAttemptBindingDraft(attemptTransition, current);
            if (binding !== null) nextDrafts.push(binding);
          }

          const scope = operationScope.getStore();
          const requested = nextDrafts[0];
          if (scope !== undefined && requested?.type === "operation.requested"
              && scope.input.executionWorld !== undefined) {
            const captured = scope.input.executionWorld;
            requireWorkspace(store, captured);
            const requestedPayload = record(requested.payload);
            const programAttemptId = String(requestedPayload.programAttemptId ?? "");
            if (programAttemptId.length === 0) {
              throw new ProgramDispatchControlError(
                "Adaptive execution-world Operation lacks protected ProgramAttempt identity",
              );
            }
            const events = await replayAll(store);
            const attemptWorld = resolveProgramAttemptExecutionWorldBindingV1(events, programAttemptId);
            if (attemptWorld === null) {
              throw new ProgramDispatchStaleError(
                "Adaptive ProgramAttempt lacks a durable execution-world binding",
              );
            }
            requireWorkspace(store, attemptWorld);
            const current = await executionWorld.currentOperationProvenance();
            requireWorkspace(store, current);
            if (!sameExecutionWorld(attemptWorld, current)) {
              throw new ProgramDispatchStaleError("Adaptive ProgramAttempt execution-world generation is stale");
            }
            if (!sameExecutionWorld(captured, attemptWorld)) {
              throw new ProgramDispatchStaleError(
                "Captured Operation execution binding does not match adaptive ProgramAttempt generation",
              );
            }
            nextDrafts = stampOperationExecutionWorld(nextDrafts, attemptWorld);
          }

          return store.append(nextDrafts);
        };
      }
      const value = Reflect.get(store, property, store) as unknown;
      return typeof value === "function" ? value.bind(store) : value;
    },
  }) as WorkspaceEventStore;

  const wrapOperationAuthority = (
    authority: ProgramRootOperationAuthorityV1,
  ): ProgramRootOperationAuthorityV1 => ({
    resolveCurrentOperation: (sessionId) => authority.resolveCurrentOperation(sessionId),
    appendRoutedRootOperation: (input) =>
      operationScope.run({ input }, () => authority.appendRoutedRootOperation(input)),
    appendRootOperation: (input, drafts) => authority.appendRootOperation(input, drafts),
    settleProgramMutation: (input) => authority.settleProgramMutation(input),
  });

  return { store: adaptedStore, wrapOperationAuthority };
}
