import type { EventDraft } from "@alcode/events";
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

/**
 * Final pre-persistence A5 guard for the fixed Program dispatcher. The
 * execution-base observation is taken before canonical admission while the
 * exact current world is captured inside admission. This guard joins those two
 * facts at the append cut so a G0 observation can never be persisted together
 * with a G1 Attempt binding if replacement races the observation.
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
          return store.append(drafts);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(store) : value;
    },
  }) as WorkspaceEventStore;
}
