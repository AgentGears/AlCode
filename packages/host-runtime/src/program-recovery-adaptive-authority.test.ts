import { describe, expect, it } from "vitest";
import {
  asProgramStateId as asEventProgramStateId,
  asSessionId,
  type EventDraft,
  type PersistedDomainEvent,
} from "@alcode/events";
import {
  asProgramAttemptId,
  asProgramStateId,
  asProgramWorkItemId,
  createProgramState,
  type ProgramAttemptExecutionBase,
  type ProgramState,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { Phase1RecoveryControllerV1 } from "./program-recovery.ts";

const workspaceId = "018f0000-0000-7000-8000-000000000c01";
const sessionId = asSessionId("018f0000-0000-4000-8000-000000000c02");
const workId = asProgramWorkItemId("recovery-authority-work");

function executionBase(stateDigest: string): ProgramAttemptExecutionBase {
  return {
    workspaceEffectGeneration: 0,
    observation: {
      kind: "workspace-observation-v1",
      providerKind: "test",
      workspaceIdentity: workspaceId,
      coverageDigest: "complete",
      stateDigest,
    },
  };
}

function programState(programStateId: ReturnType<typeof asProgramStateId>, active: boolean): ProgramState {
  const state = createProgramState({
    programStateId,
    sourceSessionId: sessionId,
    objective: "Recover only under the authority that currently owns ProgramState",
    workItems: [{
      workItemId: workId,
      creationOrder: 0,
      description: "Recover authority",
      dependencyIds: [],
      affectedPaths: ["src/recovery.ts"],
    }],
    verification: [],
    outputSlots: [],
    productionSteps: [],
  });
  state.revision = active ? 9 : 7;
  state.acceptedExecutionBase = executionBase("accepted");
  if (active) {
    state.workItems[0] = { ...state.workItems[0]!, lifecycle: "in_progress" };
    state.activeAttempt = {
      programAttemptId: asProgramAttemptId(`recovery-authority-attempt-${String(programStateId)}`),
      workItemId: workId,
      sessionId,
      agentGeneration: 2,
      initialExecutionBase: executionBase("accepted"),
      expectedExecutionBase: executionBase("accepted"),
    };
  }
  return state;
}

function event(
  sequence: number,
  type: string,
  programStateId: ReturnType<typeof asProgramStateId>,
  payload: Record<string, unknown>,
  component: string,
): PersistedDomainEvent<string, unknown> {
  return {
    sequence,
    eventId: `recovery-authority-event-${sequence}`,
    workspaceId,
    sessionId: String(sessionId),
    programStateId: asEventProgramStateId(String(programStateId)),
    occurredAt: "2026-08-30T00:00:00.000Z",
    type,
    payload,
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component },
  } as unknown as PersistedDomainEvent<string, unknown>;
}

class TestStore {
  readonly workspaceId = workspaceId;
  readonly events: PersistedDomainEvent<string, unknown>[];

  constructor(events: PersistedDomainEvent<string, unknown>[]) {
    this.events = [...events];
  }

  async *replay(): AsyncGenerator<PersistedDomainEvent<string, unknown>> {
    for (const item of this.events) yield item;
  }

  async headSequence(): Promise<number> {
    return this.events.at(-1)?.sequence ?? 0;
  }

  async append(drafts: readonly EventDraft<string, unknown>[]): Promise<PersistedDomainEvent<string, unknown>[]> {
    const head = await this.headSequence();
    const persisted = drafts.map((draft, index) => ({
      ...draft,
      sequence: head + index + 1,
    } as unknown as PersistedDomainEvent<string, unknown>));
    this.events.push(...persisted);
    return persisted;
  }

  getProjectionRunner(): { catchUp(): Promise<void> } {
    return { catchUp: async () => undefined };
  }
}

function controller(store: TestStore): Phase1RecoveryControllerV1 {
  return new Phase1RecoveryControllerV1({
    store: store as unknown as WorkspaceEventStore,
    admission: new CanonicalAdmissionQueue(store as unknown as WorkspaceEventStore),
    workspaceCoordinator: { runExclusive: async (work) => work() },
    observations: { observe: async () => ({ status: "complete" as const, base: executionBase("current") }) },
    capabilities: [],
  });
}

function phase1ProgramTransitions(store: TestStore, programStateId: string) {
  return store.events.filter((item) =>
    item.type === "program.transitioned"
    && String(item.programStateId ?? "") === programStateId
    && item.producer.kind === "runtime"
    && String((item.producer as { component?: unknown }).component ?? "") === "phase1-recovery");
}

describe("A1 Phase-1 recovery authority after semantic adoption", () => {
  it("retains fixed-topology orphan interruption and execution-base revalidation", async () => {
    const id = asProgramStateId("018f0000-0000-7000-8000-000000000c10");
    const active = programState(id, true);
    const store = new TestStore([
      event(1, "program.created", id, { state: programState(id, false) }, "test"),
      event(2, "program.transitioned", id, { state: active, transitionKind: "attempt.issue" }, "program-dispatch"),
    ]);

    const result = await controller(store).recover();

    expect(result.clear).toBe(true);
    expect(result.interruptedAttempts).toBe(1);
    const transitions = phase1ProgramTransitions(store, String(id));
    expect(transitions.map((item) => (item.payload as { transitionKind?: unknown }).transitionKind))
      .toEqual(["attempt.interrupt.recovery", "execution_base.mismatch.recovery"]);
  });

  it("never lets fixed Phase-1 recovery write ProgramState after canonical semantic adoption", async () => {
    const id = asProgramStateId("018f0000-0000-7000-8000-000000000c20");
    const active = programState(id, true);
    const store = new TestStore([
      event(1, "program.created", id, { state: programState(id, false) }, "test"),
      event(2, "program.semantic_baseline.adopted.v1", id, { cut: { kind: "program.semantic_baseline.adopted.v1" } }, "program-semantic-baseline-v1"),
      event(3, "program.transitioned", id, { state: active, transitionKind: "attempt.issue" }, "program-adaptive-admission-v2"),
    ]);

    const result = await controller(store).recover();

    expect(result.clear).toBe(true);
    expect(result.interruptedAttempts).toBe(0);
    expect(phase1ProgramTransitions(store, String(id))).toEqual([]);
    const latestProgramEvent = [...store.events].reverse().find((item) =>
      String(item.programStateId ?? "") === String(id)
      && (item.type === "program.created" || item.type === "program.transitioned"));
    expect((latestProgramEvent?.payload as { state?: ProgramState }).state?.activeAttempt?.programAttemptId)
      .toBe(active.activeAttempt?.programAttemptId);
  });
});
