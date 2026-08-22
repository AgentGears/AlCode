import { describe, expect, it } from "vitest";
import {
  asSessionId,
  asWorkspaceId,
  mkEventId,
  type PersistedDomainEvent,
} from "@alcode/events";
import type { WorkspaceEventStore } from "@alcode/storage";
import { ProgramCreationServiceV1 } from "./program-creation.ts";
import { ProgramPlanningServiceV1 } from "./program-planning.ts";
import { PlanningReadRegistry } from "./planning-read.ts";

function fakeStore(sessionId: string, objective: string): WorkspaceEventStore {
  const events = [
    {
      eventId: mkEventId(),
      workspaceId: asWorkspaceId("018f0000-0000-7000-8000-000000000500"),
      sessionId: asSessionId(sessionId),
      occurredAt: new Date().toISOString(),
      type: "runtime.session.started",
      payload: {},
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "test" },
      sequence: 1,
    },
    {
      eventId: mkEventId(),
      workspaceId: asWorkspaceId("018f0000-0000-7000-8000-000000000500"),
      sessionId: asSessionId(sessionId),
      occurredAt: new Date().toISOString(),
      type: "user.message.appended",
      payload: { text: objective, timestamp: Date.now() },
      payloadSchemaVersion: 1,
      producer: { kind: "user" },
      sequence: 2,
    },
  ] as unknown as PersistedDomainEvent<string, unknown>[];
  return {
    workspaceId: "018f0000-0000-7000-8000-000000000500",
    async *replay() {
      for (const event of events) yield event;
    },
  } as unknown as WorkspaceEventStore;
}

function proposal(objective: string, duplicate = false) {
  const work = {
    workItemId: "work-1",
    creationOrder: 0,
    description: "Update the file",
    dependencyIds: [],
    affectedPaths: ["src/a.ts"],
  };
  return {
    objective,
    workItems: duplicate ? [work, { ...work, creationOrder: 1 }] : [work],
    verification: [],
    outputSlots: [],
    productionSteps: [],
  };
}

describe("P-01 Host proposal correction window", () => {
  it("keeps the current planning episode open after structural rejection and seals only the corrected proposal", async () => {
    const sessionId = "018f0000-0000-7000-8000-000000000501";
    const objective = "Update src/a.ts";
    const store = fakeStore(sessionId, objective);
    const planningReads = new PlanningReadRegistry("planning-empty-v1", 1, []);
    const sealed: unknown[] = [];
    const creation = {
      async sealDraft(input: unknown) {
        sealed.push(input);
        return {};
      },
    } as unknown as ProgramCreationServiceV1;
    const planning = new ProgramPlanningServiceV1({
      store,
      planningReads,
      creation,
      agents: { isCurrent: () => true },
    });
    const begin = await planning.begin({
      sourceSessionId: asSessionId(sessionId),
      connectionGenerationId: "connection-1",
      agentGeneration: 1,
      objective,
    });

    const rejected = await planning.handleAgentMessage({
      connectionGenerationId: "connection-1",
      agentGeneration: 1,
      sessionId: asSessionId(sessionId),
      message: {
        type: "program.proposal",
        version: 1,
        requestId: "proposal-invalid",
        sessionId,
        planningEpisodeId: begin.planningEpisodeId,
        proposal: proposal(objective, true),
      },
    });
    expect(rejected).toMatchObject({
      outcome: "denied",
      errorCode: "program_proposal_invalid",
    });
    expect(sealed).toHaveLength(0);

    const accepted = await planning.handleAgentMessage({
      connectionGenerationId: "connection-1",
      agentGeneration: 1,
      sessionId: asSessionId(sessionId),
      message: {
        type: "program.proposal",
        version: 1,
        requestId: "proposal-corrected",
        sessionId,
        planningEpisodeId: begin.planningEpisodeId,
        proposal: proposal(objective),
      },
    });
    expect(accepted).toMatchObject({ outcome: "sealed" });
    expect(sealed).toHaveLength(1);

    const afterSeal = await planning.handleAgentMessage({
      connectionGenerationId: "connection-1",
      agentGeneration: 1,
      sessionId: asSessionId(sessionId),
      message: {
        type: "program.proposal",
        version: 1,
        requestId: "proposal-after-seal",
        sessionId,
        planningEpisodeId: begin.planningEpisodeId,
        proposal: proposal(objective),
      },
    });
    expect(afterSeal).toMatchObject({ outcome: "stale", errorCode: "program_planning_stale" });
    expect(sealed).toHaveLength(1);
  });
});
