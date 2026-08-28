import { describe, expect, it } from "vitest";
import type { PersistedDomainEvent } from "@alcode/events";
import {
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  createProgramState,
  type ProgramState,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import {
  ProgramAdaptiveSessionClassificationErrorV1,
  ProgramAdaptiveSessionClassifierV1,
} from "./program-adaptive-session-classifier-v1.ts";

const sessionId = asSessionId("018f0000-0000-4000-8000-000000000aa1");
const otherSessionId = asSessionId("018f0000-0000-4000-8000-000000000aa2");
const workspaceId = "018f0000-0000-7000-8000-000000000aa3";

function program(programStateId: string, revision = 1, attached: string = String(sessionId)): ProgramState {
  const state = createProgramState({
    programStateId: asProgramStateId(programStateId),
    sourceSessionId: asSessionId(attached),
    objective: `Program ${programStateId}`,
    workItems: [{
      workItemId: asProgramWorkItemId(`${programStateId}-work`),
      creationOrder: 0,
      description: "Do work",
      dependencyIds: [],
      affectedPaths: [],
    }],
    verification: [],
    outputSlots: [],
    productionSteps: [],
  });
  return { ...state, revision };
}

function stateEvent(sequence: number, state: ProgramState): PersistedDomainEvent<string, unknown> {
  return {
    sequence,
    eventId: `event-${sequence}`,
    workspaceId,
    sessionId: String(sessionId),
    programStateId: String(state.programStateId),
    occurredAt: "2026-08-28T00:00:00.000Z",
    type: sequence === 1 ? "program.created" : "program.transitioned",
    payload: { state, transitionKind: sequence === 1 ? "create" : "test" },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "test" },
  } as unknown as PersistedDomainEvent<string, unknown>;
}

function fakeStore(snapshots: readonly (readonly PersistedDomainEvent<string, unknown>[])[]) {
  let replayIndex = 0;
  const store = {
    workspaceId,
    replay: async function* () {
      const selected = snapshots[Math.min(replayIndex, snapshots.length - 1)] ?? [];
      replayIndex += 1;
      for (const event of selected) yield event;
    },
  } as unknown as WorkspaceEventStore;
  return { store, replayCount: () => replayIndex };
}

function classifier(input: {
  snapshots: readonly (readonly PersistedDomainEvent<string, unknown>[])[];
  adopted?: readonly boolean[];
}) {
  const fixture = fakeStore(input.snapshots);
  let adoptionIndex = 0;
  const service = new ProgramAdaptiveSessionClassifierV1({
    store: fixture.store,
    workspaceCoordinator: { runExclusive: async (work) => work() },
    adoption: {
      isAdopted: async () => {
        const values = input.adopted ?? [false];
        const value = values[Math.min(adoptionIndex, values.length - 1)] ?? false;
        adoptionIndex += 1;
        return value;
      },
    },
  });
  return { service, fixture, adoptionCount: () => adoptionIndex };
}

describe("A1 durable adaptive Session classification", () => {
  it("routes an active legacy Program through fixed-topology mode", async () => {
    const state = program("018f0000-0000-7000-8000-000000000ab1", 7);
    const events = [stateEvent(1, state)];
    const { service } = classifier({ snapshots: [events, events], adopted: [false, false] });

    await expect(service.classify(String(sessionId))).resolves.toEqual({
      mode: "fixed",
      programStateId: String(state.programStateId),
      programStateRevision: 7,
    });
    await expect(service.isAdaptiveProgramSession(String(sessionId))).resolves.toBe(false);
  });

  it("routes only an explicitly adopted Program through adaptive mode", async () => {
    const state = program("018f0000-0000-7000-8000-000000000ab2", 11);
    const events = [stateEvent(1, state)];
    const { service } = classifier({ snapshots: [events, events], adopted: [true, true] });

    await expect(service.classify(String(sessionId))).resolves.toEqual({
      mode: "adaptive",
      programStateId: String(state.programStateId),
      programStateRevision: 11,
    });
  });

  it("does not infer adaptive mode from whole-state revision or an unattached Program", async () => {
    const state = program("018f0000-0000-7000-8000-000000000ab3", 99, String(otherSessionId));
    const events = [stateEvent(1, state)];
    const { service, adoptionCount } = classifier({ snapshots: [events, events], adopted: [true, true] });

    await expect(service.classify(String(sessionId))).resolves.toEqual({ mode: "none" });
    expect(adoptionCount()).toBe(0);
  });

  it("fails closed when multiple active Programs claim the same Session", async () => {
    const left = program("018f0000-0000-7000-8000-000000000ab4", 2);
    const right = program("018f0000-0000-7000-8000-000000000ab5", 3);
    const events = [stateEvent(1, left), stateEvent(2, right)];
    const { service } = classifier({ snapshots: [events] });

    await expect(service.classify(String(sessionId))).rejects.toBeInstanceOf(
      ProgramAdaptiveSessionClassificationErrorV1,
    );
  });

  it("retries when baseline adoption changes during classification", async () => {
    const state = program("018f0000-0000-7000-8000-000000000ab6", 5);
    const events = [stateEvent(1, state)];
    const { service, fixture, adoptionCount } = classifier({
      snapshots: [events, events, events, events],
      adopted: [false, true, true, true],
    });

    await expect(service.classify(String(sessionId))).resolves.toMatchObject({ mode: "adaptive" });
    expect(fixture.replayCount()).toBe(4);
    expect(adoptionCount()).toBe(4);
  });

  it("retries operational attachment churn and returns the converged route", async () => {
    const state = program("018f0000-0000-7000-8000-000000000ab7", 4);
    const attached = [stateEvent(1, state)];
    const detachedState = { ...state, revision: 5, attachedSessionIds: [otherSessionId] };
    const detached = [stateEvent(1, state), stateEvent(2, detachedState)];
    const { service, fixture } = classifier({
      snapshots: [attached, detached, detached, detached],
      adopted: [true],
    });

    await expect(service.classify(String(sessionId))).resolves.toEqual({ mode: "none" });
    expect(fixture.replayCount()).toBe(4);
  });
});