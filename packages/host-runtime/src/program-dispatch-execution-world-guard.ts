import type { EventDraft, PersistedDomainEvent } from "@alcode/events";
import {
  applyProgramTransition,
  assertValidProgramState,
  type ProgramState,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import type { ExecutionWorldOperationProvenanceV1 } from "./execution-world.ts";
import { ProgramDispatchStaleError } from "./program-dispatch.ts";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseWorld(value: unknown): ExecutionWorldOperationProvenanceV1 | null {
  const candidate = record(value);
  const workspaceId = candidate.workspaceId;
  const providerKind = candidate.providerKind;
  const executionWorldGenerationId = candidate.executionWorldGenerationId;
  const providerDescriptorDigest = candidate.providerDescriptorDigest;
  const effectivePolicyDigest = candidate.effectivePolicyDigest;
  if (typeof workspaceId !== "string" || workspaceId.length === 0
      || typeof providerKind !== "string" || providerKind.length === 0
      || typeof executionWorldGenerationId !== "string" || executionWorldGenerationId.length === 0
      || typeof providerDescriptorDigest !== "string" || providerDescriptorDigest.length === 0
      || typeof effectivePolicyDigest !== "string" || effectivePolicyDigest.length === 0) {
    return null;
  }
  return {
    workspaceId,
    providerKind,
    executionWorldGenerationId,
    providerDescriptorDigest,
    effectivePolicyDigest,
  };
}

function sameWorld(
  left: ExecutionWorldOperationProvenanceV1,
  right: ExecutionWorldOperationProvenanceV1,
): boolean {
  return left.workspaceId === right.workspaceId
    && left.providerKind === right.providerKind
    && left.executionWorldGenerationId === right.executionWorldGenerationId
    && left.providerDescriptorDigest === right.providerDescriptorDigest
    && left.effectivePolicyDigest === right.effectivePolicyDigest;
}

function attemptBaseWorld(transition: EventDraft<string, unknown>): ExecutionWorldOperationProvenanceV1 | null {
  const state = record(record(transition.payload).state);
  const attempt = record(state.activeAttempt);
  const expectedBase = record(attempt.expectedExecutionBase);
  const observation = record(expectedBase.observation);
  return parseWorld(observation.executionWorld);
}

function bindingWorld(
  drafts: readonly EventDraft<string, unknown>[],
  transition: EventDraft<string, unknown>,
): ExecutionWorldOperationProvenanceV1 | null {
  const state = record(record(transition.payload).state);
  const attemptId = String(record(state.activeAttempt).programAttemptId ?? "");
  if (attemptId.length === 0) return null;
  const binding = drafts.find((draft) =>
    draft.type === "program.attempt.execution_world.bound"
    && String(record(draft.payload).programAttemptId ?? "") === attemptId);
  return binding === undefined ? null : parseWorld(record(binding.payload).executionWorld);
}

async function replayAll(store: WorkspaceEventStore): Promise<PersistedDomainEvent<string, unknown>[]> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

function latestProgramState(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programStateId: string,
): ProgramState | null {
  let current: ProgramState | null = null;
  for (const event of events) {
    if (event.programStateId === undefined || String(event.programStateId) !== programStateId) continue;
    if (event.type !== "program.created"
        && event.type !== "program.transitioned"
        && event.type !== "program.completed"
        && event.type !== "program.cancelled") continue;
    const candidate = record(event.payload).state as ProgramState | undefined;
    if (candidate === undefined) continue;
    assertValidProgramState(candidate);
    current = candidate;
  }
  return current;
}

function durableAttemptWorld(
  events: readonly PersistedDomainEvent<string, unknown>[],
  programAttemptId: string,
): ExecutionWorldOperationProvenanceV1 | null {
  let current: ExecutionWorldOperationProvenanceV1 | null = null;
  for (const event of events) {
    if (event.type !== "program.attempt.execution_world.bound") continue;
    const payload = record(event.payload);
    if (String(payload.programAttemptId ?? "") !== programAttemptId) continue;
    const candidate = parseWorld(payload.executionWorld);
    if (candidate === null) return null;
    if (current !== null && !sameWorld(current, candidate)) return null;
    current = candidate;
  }
  return current;
}

function settlementAdvance(
  drafts: readonly EventDraft<string, unknown>[],
): { index: number; draft: EventDraft<string, unknown> } | null {
  const index = drafts.findIndex((draft) =>
    draft.type === "program.transitioned"
    && record(draft.payload).transitionKind === "attempt.execution_base.advance"
    && record(draft.producer).component === "program-dispatch");
  return index < 0 ? null : { index, draft: drafts[index]! };
}

async function fenceSettlementMigration(
  store: WorkspaceEventStore,
  drafts: readonly EventDraft<string, unknown>[],
): Promise<EventDraft<string, unknown>[]> {
  const advance = settlementAdvance(drafts);
  if (advance === null) return [...drafts];

  const advancedState = record(record(advance.draft.payload).state);
  const advancedAttempt = record(advancedState.activeAttempt);
  const attemptId = String(advancedAttempt.programAttemptId ?? "");
  const programStateId = advance.draft.programStateId === undefined
    ? ""
    : String(advance.draft.programStateId);
  if (attemptId.length === 0 || programStateId.length === 0) {
    throw new ProgramDispatchStaleError(
      "Program mutation settlement lost its exact A5 Attempt ownership before persistence",
    );
  }

  const events = await replayAll(store);
  const bound = durableAttemptWorld(events, attemptId);
  const observed = attemptBaseWorld(advance.draft);
  if (bound !== null && observed !== null && sameWorld(bound, observed)) {
    return [...drafts];
  }

  // The already-admitted Operation still settles, including its effect and
  // quiescence facts. Only the stale Attempt-base migration is replaced: G0
  // cannot become G1 merely because post-operation observation now sees G1.
  const before = latestProgramState(events, programStateId);
  if (before === null) {
    throw new ProgramDispatchStaleError(
      "Program mutation settlement cannot reconstruct current ProgramState for A5 fencing",
    );
  }
  const unavailable = applyProgramTransition(before, {
    kind: "execution_base.unavailable",
    expectedProgramRevision: before.revision,
  });
  const next = [...drafts];
  next[advance.index] = {
    ...advance.draft,
    payload: {
      ...record(advance.draft.payload),
      transitionKind: "execution_base.unavailable",
      state: unavailable,
    },
  };
  return next;
}

/**
 * Final pre-persistence A5 guard for the fixed Program dispatcher. The
 * execution-base observation is taken before canonical admission while the
 * exact current world is captured inside admission. This guard joins those two
 * facts at the append cut so a G0 observation can never be persisted together
 * with a G1 Attempt binding if replacement races the observation.
 *
 * It also preserves D6 during mutation settlement: an Operation admitted to G0
 * may finish after G1 becomes current, but its post-observation cannot migrate
 * the still-durable G0 Attempt to G1. The Operation facts are retained and the
 * Attempt is made execution-base-unavailable for normal re-observation/rebase.
 */
export function withProgramDispatchExecutionWorldGuardV1(
  store: WorkspaceEventStore,
): WorkspaceEventStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === "append") {
        return async (drafts: readonly EventDraft<string, unknown>[]) => {
          const transition = drafts.find((draft) =>
            draft.type === "program.transitioned"
            && record(draft.payload).transitionKind === "attempt.issue"
            && record(draft.producer).component === "program-dispatch");
          if (transition !== undefined) {
            const observed = attemptBaseWorld(transition);
            const bound = bindingWorld(drafts, transition);
            if (observed === null || bound === null) {
              throw new ProgramDispatchStaleError(
                "A5 ProgramAttempt issuance requires one exact execution-world base and durable binding",
              );
            }
            if (!sameWorld(observed, bound)) {
              throw new ProgramDispatchStaleError(
                "ProgramAttempt observation and current execution-world generation diverged before admission",
              );
            }
          }
          return store.append(await fenceSettlementMigration(store, drafts));
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(store) : value;
    },
  }) as WorkspaceEventStore;
}
