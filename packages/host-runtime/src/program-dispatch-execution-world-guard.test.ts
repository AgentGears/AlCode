import { describe, expect, it } from "vitest";
import type { EventDraft, PersistedDomainEvent } from "@alcode/events";
import type { WorkspaceEventStore } from "@alcode/storage";
import { withProgramDispatchExecutionWorldGuardV1 } from "./program-dispatch-execution-world-guard.ts";
import { ProgramDispatchStaleError } from "./program-dispatch.ts";

function world(generation: string) {
  return {
    workspaceId: "workspace-a5",
    providerKind: "local-trusted",
    executionWorldGenerationId: generation,
    providerDescriptorDigest: "provider-digest",
    effectivePolicyDigest: "policy-digest",
  };
}

function drafts(observedGeneration: string | undefined, boundGeneration: string): EventDraft<string, unknown>[] {
  const attemptId = "attempt-a5-guard";
  return [
    {
      eventId: "event-transition" as never,
      workspaceId: "workspace-a5" as never,
      sessionId: "session-a5" as never,
      programStateId: "program-a5" as never,
      occurredAt: "2026-09-16T00:00:00.000Z",
      type: "program.transitioned",
      payload: {
        transitionKind: "attempt.issue",
        state: {
          activeAttempt: {
            programAttemptId: attemptId,
            expectedExecutionBase: {
              workspaceEffectGeneration: 0,
              observation: {
                ...(observedGeneration === undefined ? {} : { executionWorld: world(observedGeneration) }),
              },
            },
          },
        },
      },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "program-dispatch" },
    },
    {
      eventId: "event-binding" as never,
      workspaceId: "workspace-a5" as never,
      sessionId: "session-a5" as never,
      programStateId: "program-a5" as never,
      occurredAt: "2026-09-16T00:00:00.000Z",
      type: "program.attempt.execution_world.bound",
      payload: { programAttemptId: attemptId, executionWorld: world(boundGeneration) },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "program-dispatch" },
    },
  ];
}

function storeThatRecords(appended: EventDraft<string, unknown>[][]): WorkspaceEventStore {
  return {
    workspaceId: "workspace-a5",
    append: async (batch) => {
      appended.push([...batch]);
      return batch.map((draft, index) => ({ ...draft, sequence: index + 1 })) as PersistedDomainEvent<string, unknown>[];
    },
  } as unknown as WorkspaceEventStore;
}

describe("A5 fixed Program dispatch execution-world persistence guard", () => {
  it("admits an Attempt only when its observed base and durable binding name the same exact generation", async () => {
    const appended: EventDraft<string, unknown>[][] = [];
    const guarded = withProgramDispatchExecutionWorldGuardV1(storeThatRecords(appended));
    await guarded.append(drafts("g0", "g0"));
    expect(appended).toHaveLength(1);
  });

  it("rejects same-bytes G0 observation plus G1 binding before either event persists", async () => {
    const appended: EventDraft<string, unknown>[][] = [];
    const guarded = withProgramDispatchExecutionWorldGuardV1(storeThatRecords(appended));
    await expect(guarded.append(drafts("g0", "g1"))).rejects.toBeInstanceOf(ProgramDispatchStaleError);
    expect(appended).toHaveLength(0);
  });

  it("fails closed when an A5 Attempt transition lacks an exact observed world", async () => {
    const appended: EventDraft<string, unknown>[][] = [];
    const guarded = withProgramDispatchExecutionWorldGuardV1(storeThatRecords(appended));
    await expect(guarded.append(drafts(undefined, "g0"))).rejects.toBeInstanceOf(ProgramDispatchStaleError);
    expect(appended).toHaveLength(0);
  });
});
