import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asWorkspaceId, mkEventId } from "@alcode/events";
import {
  asProgramWorkItemId,
  asVerificationObligationId,
  type Json,
} from "@alcode/program-state";
import { openLockedWorkspaceStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { ProgramAgentServiceV1 } from "./program-agent.ts";
import {
  ProgramCreationServiceV1,
  type ExecutionObservationProfileAuthorityV1,
  type PlanningReadBarrierV1,
  type ProgramCreationPolicySourceV1,
} from "./program-creation.ts";
import {
  ProgramPlanningServiceV1,
  ProgramPlanningStaleError,
  type ProgramPlanningAgentAuthorityV1,
} from "./program-planning.ts";
import { PlanningReadRegistry, type PlanningReadContractV1 } from "./planning-read.ts";
import { HostSessionManager } from "./session-manager.ts";

class ImmediateBarrier implements PlanningReadBarrierV1 {
  runExclusive<T>(work: () => Promise<T>): Promise<T> { return work(); }
}

function fileContract(files: Map<string, string>): PlanningReadContractV1 {
  return {
    readContractId: "file.read.v1",
    readContractVersion: 1,
    maxCanonicalArgsBytes: 1024,
    maxCanonicalResultBytes: 64 * 1024,
    normalizeArgs(input: Json): Json {
      const path = (input as { path?: unknown }).path;
      if (typeof path !== "string" || path.length === 0) throw new Error("path required");
      return { path };
    },
    async execute(canonicalArgs) {
      const path = (canonicalArgs as { path: string }).path;
      return {
        result: files.has(path) ? { kind: "file", text: files.get(path)! } : { kind: "absent" },
        complete: true,
        coverageIdentity: "workspace-files-v1",
        providerBindingRevision: "provider-1",
      };
    },
  };
}

const policy: ProgramCreationPolicySourceV1 = {
  current: () => ({ generation: "policy-1", digest: "policy-digest-1", requirements: [] }),
};
const executionProfiles: ExecutionObservationProfileAuthorityV1 = {
  current: () => ({
    profileId: "workspace-observation-v1",
    profileVersion: 1,
    coverageIdentity: "local-complete-v1",
  }),
  validate: () => undefined,
};

async function appendObjective(
  admission: CanonicalAdmissionQueue,
  workspaceId: string,
  sessionId: Parameters<HostSessionManager["getState"]>[0],
  objective: string,
): Promise<void> {
  await admission.append([{
    eventId: mkEventId(),
    workspaceId: asWorkspaceId(workspaceId),
    sessionId,
    occurredAt: new Date().toISOString(),
    type: "user.message.appended",
    payload: { text: objective, timestamp: Date.now() },
    payloadSchemaVersion: 1,
    producer: { kind: "user" },
  }]);
}

async function allEvents(store: { replay(): AsyncIterable<unknown> }): Promise<any[]> {
  const events: any[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

function planningAuthority(
  agents: ProgramAgentServiceV1,
  currentConnections: Map<string, string>,
): ProgramPlanningAgentAuthorityV1 {
  return {
    isCurrent(sessionId, connectionGenerationId, agentGeneration) {
      return currentConnections.get(sessionId) === connectionGenerationId
        && agents.isCurrent(sessionId, agentGeneration);
    },
  };
}

const describeLocked = process.platform === "win32" ? describe.skip : describe;

describeLocked("Program planning bridge", () => {
  it("tracks Host planning reads, seals one proposal, and deduplicates request retry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-planning-"));
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: "018f0000-0000-7000-8000-000000000401",
      repositoryId: "program-planning-test",
    });
    const admission = new CanonicalAdmissionQueue(locked.store);
    const sessions = new HostSessionManager(locked, admission);
    const session = await sessions.openOrResume();
    const objective = "Update src/a.ts through the Program planning bridge";
    await appendObjective(admission, locked.store.workspaceId, session.sessionId, objective);

    const files = new Map([["src/a.ts", "before"]]);
    const registry = new PlanningReadRegistry("planning-files-v1", 1, [fileContract(files)]);
    const creation = new ProgramCreationServiceV1({
      store: locked.store,
      admission,
      planningReads: registry,
      planningBarrier: new ImmediateBarrier(),
      policy,
      executionObservationProfiles: executionProfiles,
    });
    const agents = new ProgramAgentServiceV1(locked.store, admission);
    const agentGeneration = await agents.attach(session.sessionId, "connection-1", true);
    const currentConnections = new Map([[String(session.sessionId), "connection-1"]]);
    const planning = new ProgramPlanningServiceV1({
      store: locked.store,
      planningReads: registry,
      creation,
      agents: planningAuthority(agents, currentConnections),
    });
    const begin = await planning.begin({
      sourceSessionId: session.sessionId,
      connectionGenerationId: "connection-1",
      agentGeneration,
      objective,
    });

    const read = await planning.handleAgentMessage({
      connectionGenerationId: "connection-1",
      agentGeneration,
      sessionId: session.sessionId,
      message: {
        type: "program.planning.read",
        version: 1,
        requestId: "read-1",
        sessionId: String(session.sessionId),
        planningEpisodeId: begin.planningEpisodeId,
        readContractId: "file.read.v1",
        readContractVersion: 1,
        args: { path: "src/a.ts" },
      },
    });
    expect(read).toMatchObject({ outcome: "succeeded", result: { kind: "file", text: "before" } });

    const workItemId = asProgramWorkItemId("work-1");
    const proposalMessage = {
      type: "program.proposal" as const,
      version: 1 as const,
      requestId: "proposal-1",
      sessionId: String(session.sessionId),
      planningEpisodeId: begin.planningEpisodeId,
      proposal: {
        objective,
        workItems: [{
          workItemId,
          creationOrder: 0,
          description: "Update the file",
          dependencyIds: [],
          affectedPaths: ["src/a.ts"],
        }],
        verification: [{
          obligationId: asVerificationObligationId("verify-a"),
          predicate: { kind: "workspace_path_state" as const, path: "src/a.ts", requiredState: "file" as const },
          freshnessScope: { kind: "paths" as const, entries: [{ path: "src/a.ts", mode: "exact" as const }] },
        }],
        outputSlots: [],
        productionSteps: [],
      },
    };
    const sealed = await planning.handleAgentMessage({
      connectionGenerationId: "connection-1",
      agentGeneration,
      sessionId: session.sessionId,
      message: proposalMessage,
    });
    expect(sealed).toMatchObject({ outcome: "sealed" });

    const duplicate = await planning.handleAgentMessage({
      connectionGenerationId: "connection-1",
      agentGeneration,
      sessionId: session.sessionId,
      message: proposalMessage,
    });
    expect(duplicate).toEqual(sealed);
    const events = await allEvents(locked.store);
    const drafts = events.filter((event) => event.type === "program.creation.draft.sealed");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].payload.draft.planningObservationIdentity.dependencies).toHaveLength(1);
    expect(events.some((event) => event.type === "program.created")).toBe(false);
    locked.close();
  });

  it("fails stale for replaced Agent authority and a stopped source Session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-planning-stale-"));
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: "018f0000-0000-7000-8000-000000000402",
      repositoryId: "program-planning-stale-test",
    });
    const admission = new CanonicalAdmissionQueue(locked.store);
    const sessions = new HostSessionManager(locked, admission);
    const session = await sessions.openOrResume();
    const objective = "Inspect src/a.ts";
    await appendObjective(admission, locked.store.workspaceId, session.sessionId, objective);
    const registry = new PlanningReadRegistry(
      "planning-files-v1", 1, [fileContract(new Map([["src/a.ts", "before"]]))],
    );
    const creation = new ProgramCreationServiceV1({
      store: locked.store,
      admission,
      planningReads: registry,
      planningBarrier: new ImmediateBarrier(),
      policy,
      executionObservationProfiles: executionProfiles,
    });
    const agents = new ProgramAgentServiceV1(locked.store, admission);
    const generation1 = await agents.attach(session.sessionId, "connection-1", true);
    const currentConnections = new Map([[String(session.sessionId), "connection-1"]]);
    const planning = new ProgramPlanningServiceV1({
      store: locked.store,
      planningReads: registry,
      creation,
      agents: planningAuthority(agents, currentConnections),
    });
    const begin = await planning.begin({
      sourceSessionId: session.sessionId,
      connectionGenerationId: "connection-1",
      agentGeneration: generation1,
      objective,
    });

    const generation2 = await agents.attach(session.sessionId, "connection-2", true);
    currentConnections.set(String(session.sessionId), "connection-2");
    const replaced = await planning.handleAgentMessage({
      connectionGenerationId: "connection-1",
      agentGeneration: generation1,
      sessionId: session.sessionId,
      message: {
        type: "program.planning.read",
        version: 1,
        requestId: "read-stale",
        sessionId: String(session.sessionId),
        planningEpisodeId: begin.planningEpisodeId,
        readContractId: "file.read.v1",
        readContractVersion: 1,
        args: { path: "src/a.ts" },
      },
    });
    expect(replaced).toMatchObject({ outcome: "stale", errorCode: "program_planning_stale" });

    const begin2 = await planning.begin({
      sourceSessionId: session.sessionId,
      connectionGenerationId: "connection-2",
      agentGeneration: generation2,
      objective,
    });
    await sessions.stop(session.sessionId, "cancelled");
    const stopped = await planning.handleAgentMessage({
      connectionGenerationId: "connection-2",
      agentGeneration: generation2,
      sessionId: session.sessionId,
      message: {
        type: "program.proposal",
        version: 1,
        requestId: "proposal-stopped",
        sessionId: String(session.sessionId),
        planningEpisodeId: begin2.planningEpisodeId,
        proposal: { objective, workItems: [], verification: [], outputSlots: [], productionSteps: [] },
      },
    });
    expect(stopped).toMatchObject({ outcome: "stale", errorCode: "program_planning_stale" });
    locked.close();
  });

  it("rejects begin when the connection identity is not current", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-planning-authority-"));
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: "018f0000-0000-7000-8000-000000000403",
      repositoryId: "program-planning-authority-test",
    });
    const admission = new CanonicalAdmissionQueue(locked.store);
    const sessions = new HostSessionManager(locked, admission);
    const session = await sessions.openOrResume();
    const objective = "Inspect src/a.ts";
    await appendObjective(admission, locked.store.workspaceId, session.sessionId, objective);
    const registry = new PlanningReadRegistry("planning-files-v1", 1, [fileContract(new Map())]);
    const creation = new ProgramCreationServiceV1({
      store: locked.store,
      admission,
      planningReads: registry,
      planningBarrier: new ImmediateBarrier(),
      policy,
      executionObservationProfiles: executionProfiles,
    });
    const agents = new ProgramAgentServiceV1(locked.store, admission);
    const generation = await agents.attach(session.sessionId, "connection-current", true);
    const currentConnections = new Map([[String(session.sessionId), "connection-current"]]);
    const planning = new ProgramPlanningServiceV1({
      store: locked.store,
      planningReads: registry,
      creation,
      agents: planningAuthority(agents, currentConnections),
    });
    await expect(planning.begin({
      sourceSessionId: session.sessionId,
      connectionGenerationId: "connection-stale",
      agentGeneration: generation,
      objective,
    })).rejects.toBeInstanceOf(ProgramPlanningStaleError);
    locked.close();
  });
});
