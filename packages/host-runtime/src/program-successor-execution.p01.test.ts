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
  applyProgramTransition,
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
import type { ProgramCreationProvenanceV1 } from "./program-creation.ts";
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
      providerKind: "p01-successor-execution-proof",
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

type AttemptExecuteMessage = Extract<HostToAgentMessage, { type: "program.attempt.execute" }>;

describeLocked("P-01 successor Attempt execution", () => {
  it("routes successful verification through idle handling and sends the successor execute request without caller input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-p01-successor-execution-"));
    dirs.push(dir);
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: asWorkspaceId(uuidv7()),
      repositoryId: uuidv7(),
    });
    stores.push(locked);

    const base = executionBase(locked.store.workspaceId);
    const planningReads = new PlanningReadRegistry("p01-successor-execution", 1, []);
    const acceptedPlanningBase = planningReads.track(locked.store.workspaceId).seal();
    const runtime = createProgramExecutionRuntimeV1({
      host: { store: locked, capabilities: [] },
      planningReads,
      creationPolicy: { current: () => ({ generation: "p01", digest: "p01-policy", requirements: [] }) },
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
      generationId: "p01-successor-agent",
      capabilities: [DURABLE_TRANSCRIPT_CAPABILITY, PROGRAM_STATE_CAPABILITY, PROGRAM_EXECUTION_CAPABILITY],
      transport: pair.a,
      waitForExit: () => neverExit,
      terminate: () => undefined,
    };
    await runtime.attachAgent(connection, session, "system");
    const agentGeneration = runtime.host.programAgents.currentAgentGeneration(String(session.sessionId));
    if (agentGeneration === null) throw new Error("missing Agent generation");

    const programStateId = asProgramStateId(String(mkProgramStateId()));
    const firstWorkItemId = asProgramWorkItemId("work-first");
    const secondWorkItemId = asProgramWorkItemId("work-second");
    const initial = createProgramState({
      programStateId,
      sourceSessionId: asSessionId(String(session.sessionId)),
      objective: "Execute dependent work without new caller input",
      workItems: [
        {
          workItemId: firstWorkItemId,
          creationOrder: 0,
          description: "First work",
          dependencyIds: [],
          affectedPaths: [],
        },
        {
          workItemId: secondWorkItemId,
          creationOrder: 1,
          description: "Dependent successor",
          dependencyIds: [firstWorkItemId],
          affectedPaths: [],
        },
      ],
      verification: [],
      outputSlots: [],
      productionSteps: [],
    });
    const creation: ProgramCreationProvenanceV1 = {
      draftId: "p01-successor-draft",
      draftDigest: "p01-successor-digest",
      objectiveProvenance: {
        kind: "application-objective-v1",
        sourceSessionId: String(session.sessionId),
        sourceEventId: String(mkEventId()),
        objectiveDigest: "p01-successor-objective-digest",
      },
      acceptedPlanningBase,
      executionObservationProfile: {
        profileId: "workspace-observation-v1",
        profileVersion: 1,
        coverageIdentity: "workspace-complete-v1",
      },
      policy: { generation: "p01", digest: "p01-policy", requirements: [] },
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
      producer: { kind: "runtime", component: "p01-successor-execution-proof" },
    }]);

    const issued = await runtime.dispatch.issueAttempt({
      programStateId: String(programStateId),
      expectedProgramRevision: initial.revision,
      workItemId: String(firstWorkItemId),
      sessionId: session.sessionId,
      agentGeneration,
    });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") throw new Error(`first Attempt not issued: ${issued.status}`);

    const awaiting = applyProgramTransition(issued.state, {
      kind: "work.lifecycle.set",
      expectedProgramRevision: issued.state.revision,
      workItemId: firstWorkItemId,
      lifecycle: "awaiting_verification",
    });
    await runtime.host.admission.append([{
      eventId: mkEventId(),
      workspaceId: asWorkspaceId(locked.store.workspaceId),
      sessionId: session.sessionId,
      programStateId: asEventProgramStateId(String(programStateId)),
      occurredAt: new Date().toISOString(),
      type: "program.transitioned",
      payload: { state: awaiting, transitionKind: "work.lifecycle.set:awaiting_verification" },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "p01-successor-execution-proof" },
    }]);

    let resolveExecute!: (message: AttemptExecuteMessage) => void;
    const executeRequest = new Promise<AttemptExecuteMessage>((resolve) => { resolveExecute = resolve; });
    const unsubscribe = pair.b.onMessage((message) => {
      if (message.type === "program.attempt.execute") resolveExecute(message);
    });

    await pair.b.send({
      type: "agent.idle",
      requestId: "p01-successor-idle",
      sessionId: String(session.sessionId),
      reason: "stop",
    });
    const successorExecute = await executeRequest;
    unsubscribe();

    expect(String(successorExecute.authority.workItemId)).toBe(String(secondWorkItemId));
    expect(String(successorExecute.authority.programAttemptId)).not.toBe(String(issued.programAttemptId));
    expect(successorExecute.authority.agentGeneration).toBe(agentGeneration);

    const final = await latestState(locked, String(programStateId));
    expect(final.workItems.find((work) => work.workItemId === firstWorkItemId)?.lifecycle).toBe("completed");
    expect(final.workItems.find((work) => work.workItemId === secondWorkItemId)?.lifecycle).toBe("in_progress");
    expect(String(final.activeAttempt?.programAttemptId)).toBe(String(successorExecute.authority.programAttemptId));
  });
});
