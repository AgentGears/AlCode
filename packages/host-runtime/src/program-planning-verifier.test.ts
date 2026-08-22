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
import { HostProgramVerifierCatalogV1 } from "./program-verifier-catalog.ts";
import { HostVerificationOperationRegistryV1 } from "./program-verification.ts";

function fakeStore(sessionId: string, objective: string): WorkspaceEventStore {
  const events = [
    {
      eventId: mkEventId(),
      workspaceId: asWorkspaceId("018f0000-0000-7000-8000-000000000520"),
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
      workspaceId: asWorkspaceId("018f0000-0000-7000-8000-000000000520"),
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
    workspaceId: "018f0000-0000-7000-8000-000000000520",
    async *replay() {
      for (const event of events) yield event;
    },
  } as unknown as WorkspaceEventStore;
}

function proposal(objective: string, specVersion: number) {
  return {
    objective,
    workItems: [{
      workItemId: "work-1",
      creationOrder: 0,
      description: "Inspect package.json",
      dependencyIds: [],
      affectedPaths: ["package.json"],
    }],
    verification: [{
      obligationId: "verify-package-json",
      verifier: { specId: "workspace_path_state", specVersion },
      args: { path: "package.json", requiredState: "file" },
      freshnessScope: { kind: "workspace" },
    }],
    outputSlots: [],
    productionSteps: [],
  };
}

describe("P-01 planning verifier episode binding", () => {
  it("advertises the exact verifier catalog, keeps invalid verifier correction in-episode, and seals Host-canonical verification", async () => {
    const sessionId = "018f0000-0000-7000-8000-000000000521";
    const objective = "Inspect package.json";
    const store = fakeStore(sessionId, objective);
    const planningReads = new PlanningReadRegistry("planning-empty-v1", 1, []);
    const verifiers = new HostProgramVerifierCatalogV1([{
      specId: "workspace_path_state",
      specVersion: 1,
      predicateKind: "workspace_path_state",
      description: "Observe a Workspace path state",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, requiredState: { type: "string" } },
        required: ["path", "requiredState"],
      },
    }], new HostVerificationOperationRegistryV1([]));
    const sealed: Array<{ proposal?: { verification?: unknown[] } }> = [];
    const creation = {
      async sealDraft(input: { proposal?: { verification?: unknown[] } }) {
        sealed.push(structuredClone(input));
        return {};
      },
    } as unknown as ProgramCreationServiceV1;
    const planning = new ProgramPlanningServiceV1({
      store,
      planningReads,
      creation,
      agents: { isCurrent: () => true },
      verifiers,
    });
    const begin = await planning.begin({
      sourceSessionId: asSessionId(sessionId),
      connectionGenerationId: "connection-1",
      agentGeneration: 1,
      objective,
    });
    expect(begin.verifierCatalog).toEqual(verifiers.catalog());

    const rejected = await planning.handleAgentMessage({
      connectionGenerationId: "connection-1",
      agentGeneration: 1,
      sessionId: asSessionId(sessionId),
      message: {
        type: "program.proposal",
        version: 1,
        requestId: "proposal-stale-verifier",
        sessionId,
        planningEpisodeId: begin.planningEpisodeId,
        proposal: proposal(objective, 2),
      },
    });
    expect(rejected).toMatchObject({ outcome: "denied", errorCode: "program_proposal_invalid" });
    expect(sealed).toHaveLength(0);

    const accepted = await planning.handleAgentMessage({
      connectionGenerationId: "connection-1",
      agentGeneration: 1,
      sessionId: asSessionId(sessionId),
      message: {
        type: "program.proposal",
        version: 1,
        requestId: "proposal-current-verifier",
        sessionId,
        planningEpisodeId: begin.planningEpisodeId,
        proposal: proposal(objective, 1),
      },
    });
    expect(accepted).toMatchObject({ outcome: "sealed" });
    expect(sealed).toHaveLength(1);
    expect(sealed[0]?.proposal?.verification).toEqual([{
      obligationId: "verify-package-json",
      predicate: {
        kind: "workspace_path_state",
        path: "package.json",
        requiredState: "file",
      },
      freshnessScope: { kind: "workspace" },
    }]);
  });
});
