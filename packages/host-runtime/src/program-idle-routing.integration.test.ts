import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DURABLE_TRANSCRIPT_CAPABILITY,
  PROGRAM_EXECUTION_CAPABILITY,
  PROGRAM_STATE_CAPABILITY,
  createInMemoryTransportPair,
  type AgentToHostMessage,
  type HostToAgentMessage,
} from "@alcode/agent-protocol";
import {
  asProgramStateId as asEventProgramStateId,
  asWorkspaceId,
  mkEventId,
  mkProgramStateId,
  uuidv7,
} from "@alcode/events";
import {
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  createProgramState,
  type ProgramAttemptExecutionBase,
  type ProgramState,
} from "@alcode/program-state";
import { openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import type { AgentConnection } from "./agent-supervisor.ts";
import { HostArtifactStore } from "./artifact-store.ts";
import { type ProgramCreationProvenanceV1 } from "./program-creation.ts";
import { createProgramExecutionRuntimeV1 } from "./program-execution-runtime.ts";
import { PlanningReadRegistry } from "./planning-read.ts";
import { HostVerificationOperationRegistryV1 } from "./program-verification.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;
const stores: LockedWorkspaceStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function executionBase(workspaceIdentity: string): ProgramAttemptExecutionBase {
  return {
    workspaceEffectGeneration: 0,
    observation: {
      kind: "workspace-observation-v1",
      providerKind: "phase-1.1-idle-route-proof",
      workspaceIdentity,
      coverageDigest: "workspace-complete-v1",
      stateDigest: "state-v1",
    },
  };
}

async function latestState(store: LockedWorkspaceStore, programStateId: string): Promise<ProgramState> {
  let state: ProgramState | undefined;
  for await (const event of store.store.replay()) {
    if (String(event.programStateId ?? "") !== programStateId) continue;
    if (event.type !== "program.created" && event.type !== "program.transitioned"
        && event.type !== "program.completed" && event.type !== "program.cancelled") continue;
    state = (event.payload as { state?: ProgramState }).state ?? state;
  }
  if (state === undefined) throw new Error("missing ProgramState");
  return state;
}

describeLocked("Program-backed Host idle routing", () => {
  it("keeps an in-progress Program active instead of falling through to legacy Session completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-idle-route-proof-"));
    dirs.push(dir);
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: asWorkspaceId(uuidv7()),
      repositoryId: uuidv7(),
    });
    stores.push(locked);
    const base = executionBase(locked.store.workspaceId);
    const planningReads = new PlanningReadRegistry("idle-host-route", 1, []);
    const acceptedPlanningBase = planningReads.track(locked.store.workspaceId).seal();
    const runtime = createProgramExecutionRuntimeV1({
      host: { store: locked, capabilities: [] },
      planningReads,
      creationPolicy: { current: () => ({ generation: "p1", digest: "pd1", requirements: [] }) },
      executionObservationProfiles: {
        current: () => ({ profileId: "workspace-observation-v1", profileVersion: 1, coverageIdentity: "workspace-complete-v1" }),
        validate: () => undefined,
      },
      observations: { observe: async () => ({ status: "complete", base }) },
      pathObservations: { observePath: async () => ({ status: "unknown", reason: "not used" }) },
      operationSpecs: new HostVerificationOperationRegistryV1([]),
      artifactStore: new HostArtifactStore({ root: join(dir, "artifacts") }),
    });
    await runtime.host.startup();
    const session = await runtime.host.sessions.openOrResume();
    const pair = createInMemoryTransportPair<HostToAgentMessage, AgentToHostMessage>();
    const neverExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {});
    const connection: AgentConnection = {
      generationId: "host-idle-agent",
      capabilities: [DURABLE_TRANSCRIPT_CAPABILITY, PROGRAM_STATE_CAPABILITY, PROGRAM_EXECUTION_CAPABILITY],
      transport: pair.a,
      waitForExit: () => neverExit,
      terminate: () => undefined,
    };
    await runtime.attachAgent(connection, session, "system");
    const agentGeneration = runtime.host.programAgents.currentAgentGeneration(String(session.sessionId));
    if (agentGeneration === null) throw new Error("missing agent generation");

    const programStateId = asProgramStateId(String(mkProgramStateId()));
    const workItemId = asProgramWorkItemId("work-host-idle");
    const objective = "Remain active while current work is still in progress";
    const initial = createProgramState({
      programStateId,
      sourceSessionId: asSessionId(String(session.sessionId)),
      objective,
      workItems: [{ workItemId, creationOrder: 0, description: "Keep working", dependencyIds: [], affectedPaths: [] }],
      verification: [],
      outputSlots: [],
      productionSteps: [],
    });
    const creation: ProgramCreationProvenanceV1 = {
      draftId: "idle-route-proof-draft",
      draftDigest: "idle-route-proof-digest",
      objectiveProvenance: {
        kind: "application-objective-v1",
        sourceSessionId: String(session.sessionId),
        sourceEventId: String(mkEventId()),
        objectiveDigest: "idle-route-proof-objective-digest",
      },
      acceptedPlanningBase,
      executionObservationProfile: {
        profileId: "workspace-observation-v1",
        profileVersion: 1,
        coverageIdentity: "workspace-complete-v1",
      },
      policy: { generation: "p1", digest: "pd1", requirements: [] },
    };
    await runtime.host.admission.append([{
      eventId: mkEventId(),
      workspaceId: asWorkspaceId(locked.store.workspaceId),
      sessionId: session.sessionId,
      programStateId: asEventProgramStateId(String(programStateId)),
      occurredAt: new Date().toISOString(),
      type: "program.created",
      payload: { state: initial, creation },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "program-idle-routing-proof" },
    }]);
    const issued = await runtime.dispatch.issueAttempt({
      programStateId: String(programStateId),
      expectedProgramRevision: initial.revision,
      workItemId: String(workItemId),
      sessionId: session.sessionId,
      agentGeneration,
    });
    expect(issued.status).toBe("issued");

    await pair.b.send({
      type: "agent.idle",
      requestId: "idle-in-progress",
      sessionId: String(session.sessionId),
      reason: "stop",
    });
    expect((await runtime.host.sessions.getState(session.sessionId)).stopped).toBe(false);
    expect((await latestState(locked, String(programStateId))).lifecycle).toBe("active");
  });
});
