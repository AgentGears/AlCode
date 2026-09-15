import { describe, expect, it } from "vitest";
import {
  asProgramStateId as asEventProgramStateId,
  asWorkspaceId,
  mkEventId,
  uuidv7,
  type EventDraft,
  type PersistedDomainEvent,
} from "@alcode/events";
import {
  applyProgramTransition,
  asProgramAttemptId,
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  createProgramState,
  type ProgramAttemptExecutionBase,
} from "@alcode/program-state";
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

function base(generation: string, effectGeneration = 0): ProgramAttemptExecutionBase {
  return {
    workspaceEffectGeneration: effectGeneration,
    observation: {
      kind: "workspace-observation-v1",
      providerKind: "local-trusted",
      workspaceIdentity: "workspace-a5",
      coverageDigest: "a5-guard-coverage",
      stateDigest: `state-${generation}-${effectGeneration}`,
      executionWorld: world(generation),
    },
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

function storeThatRecords(
  appended: EventDraft<string, unknown>[][],
  history: PersistedDomainEvent<string, unknown>[] = [],
): WorkspaceEventStore {
  return {
    workspaceId: "workspace-a5",
    append: async (batch: readonly EventDraft<string, unknown>[]) => {
      appended.push([...batch]);
      const persisted = batch.map((draft, index) => ({
        ...draft,
        sequence: history.length + index + 1,
      })) as PersistedDomainEvent<string, unknown>[];
      history.push(...persisted);
      return persisted;
    },
    replay: async function* () {
      for (const event of history) yield event;
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

  it("settles an admitted G0 mutation but interrupts the Attempt instead of migrating its base to G1", async () => {
    const appended: EventDraft<string, unknown>[][] = [];
    const history: PersistedDomainEvent<string, unknown>[] = [];
    const sessionId = asSessionId(uuidv7());
    const workItemId = asProgramWorkItemId("work-a5-settlement");
    const programStateId = asProgramStateId(uuidv7());
    const attemptId = asProgramAttemptId(uuidv7());
    const initial = createProgramState({
      programStateId,
      sourceSessionId: sessionId,
      objective: "Fence A5 settlement migration",
      workItems: [{
        workItemId,
        creationOrder: 0,
        description: "Mutate under G0",
        dependencyIds: [],
        affectedPaths: ["src/a5.ts"],
      }],
      verification: [],
      outputSlots: [],
      productionSteps: [],
    });
    const g0Base = base("g0", 0);
    const issued = applyProgramTransition(initial, {
      kind: "attempt.issue",
      expectedProgramRevision: initial.revision,
      attempt: {
        programAttemptId: attemptId,
        workItemId,
        sessionId,
        agentGeneration: 1,
        initialExecutionBase: g0Base,
        expectedExecutionBase: g0Base,
      },
    });
    history.push(
      {
        sequence: 1,
        eventId: mkEventId(),
        workspaceId: asWorkspaceId("workspace-a5"),
        sessionId: sessionId as never,
        programStateId: asEventProgramStateId(String(programStateId)),
        occurredAt: "2026-09-16T00:00:00.000Z",
        type: "program.transitioned",
        payload: { transitionKind: "attempt.issue", state: issued },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "program-dispatch" },
      } as PersistedDomainEvent<string, unknown>,
      {
        sequence: 2,
        eventId: mkEventId(),
        workspaceId: asWorkspaceId("workspace-a5"),
        sessionId: sessionId as never,
        programStateId: asEventProgramStateId(String(programStateId)),
        occurredAt: "2026-09-16T00:00:00.001Z",
        type: "program.attempt.execution_world.bound",
        payload: { programAttemptId: String(attemptId), executionWorld: world("g0") },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "program-dispatch" },
      } as PersistedDomainEvent<string, unknown>,
    );

    const migrated = applyProgramTransition(issued, {
      kind: "attempt.execution_base.advance",
      expectedProgramRevision: issued.revision,
      programAttemptId: String(attemptId),
      executionBase: base("g1", 1),
    });
    const settlement: EventDraft<string, unknown>[] = [
      {
        eventId: mkEventId(),
        workspaceId: asWorkspaceId("workspace-a5"),
        sessionId: sessionId as never,
        programStateId: asEventProgramStateId(String(programStateId)),
        occurredAt: "2026-09-16T00:00:01.000Z",
        type: "workspace.effect_generation.advanced",
        payload: { workspaceEffectGeneration: 1 },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "program-dispatch" },
      },
      {
        eventId: mkEventId(),
        workspaceId: asWorkspaceId("workspace-a5"),
        sessionId: sessionId as never,
        programStateId: asEventProgramStateId(String(programStateId)),
        occurredAt: "2026-09-16T00:00:01.001Z",
        type: "program.transitioned",
        payload: { transitionKind: "attempt.execution_base.advance", state: migrated },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "program-dispatch" },
      },
    ];

    const guarded = withProgramDispatchExecutionWorldGuardV1(storeThatRecords(appended, history));
    await guarded.append(settlement);

    expect(appended).toHaveLength(1);
    const persistedTransition = appended[0]!.find((draft) => draft.type === "program.transitioned");
    const payload = persistedTransition?.payload as { transitionKind?: string; state?: { activeAttempt?: unknown; executionBaseUnavailable?: boolean } };
    expect(payload.transitionKind).toBe("execution_base.unavailable");
    expect(payload.state?.activeAttempt).toBeNull();
    expect(payload.state?.executionBaseUnavailable).toBe(true);
    expect(appended[0]!.some((draft) => draft.type === "workspace.effect_generation.advanced")).toBe(true);
  });
});
