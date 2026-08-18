import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asProgramStateId as asEventProgramStateId,
  asWorkspaceId,
  mkEventId,
  mkProgramStateId,
  uuidv7,
  type EventDraft,
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
import { openLockedWorkspaceStore } from "@alcode/storage";
import { HostArtifactStore } from "./artifact-store.ts";
import { PlanningReadRegistry } from "./planning-read.ts";
import { HostVerificationOperationRegistryV1 } from "./program-verification.ts";
import {
  HostProgramWorkspaceCoordinatorV1,
  createProgramExecutionRuntimeV1,
} from "./program-execution-runtime.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

function executionBase(workspaceIdentity: string): ProgramAttemptExecutionBase {
  return {
    workspaceEffectGeneration: 0,
    observation: {
      kind: "workspace-observation-v1",
      providerKind: "phase-1.1-composition-test",
      workspaceIdentity,
      coverageDigest: "workspace-complete-v1",
      stateDigest: "state-v1",
    },
  };
}

describe("HostProgramWorkspaceCoordinatorV1", () => {
  it("is reentrant for nested protected planning/dispatch cuts", async () => {
    const coordinator = new HostProgramWorkspaceCoordinatorV1();
    const seen: string[] = [];
    await coordinator.runExclusive(async () => {
      seen.push("outer");
      await coordinator.runExclusive(async () => {
        seen.push("inner");
      });
    });
    expect(seen).toEqual(["outer", "inner"]);
  });
});

describeLocked("Phase 1.1 production Program composition", () => {
  it("wires one authority graph and prevents a current Program operation from bypassing Program ownership", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-execution-runtime-"));
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: "018f0000-0000-7000-8000-000000001101",
      repositoryId: "phase-1.1-composition",
    });
    const base = executionBase(locked.store.workspaceId);
    const artifactStore = new HostArtifactStore({ root: join(dir, "artifacts") });
    const runtime = createProgramExecutionRuntimeV1({
      host: {
        store: locked,
        capabilities: [{
          name: "workspace.inspect",
          workspaceAccessClass: "read_only",
          execute: async () => ({ result: { ok: true }, outcome: "succeeded" }),
        }],
      },
      planningReads: new PlanningReadRegistry("phase-1.1-test", 1, []),
      creationPolicy: {
        current: () => ({ generation: "policy-1", digest: "policy-digest-1", requirements: [] }),
      },
      executionObservationProfiles: {
        current: () => ({ profileId: "workspace-observation-v1", profileVersion: 1, coverageIdentity: "workspace-complete-v1" }),
        validate: () => undefined,
      },
      observations: { observe: async () => ({ status: "complete", base }) },
      pathObservations: {
        observePath: async () => ({ status: "unknown", reason: "not used by composition proof" }),
      },
      operationSpecs: new HostVerificationOperationRegistryV1([]),
      artifactStore,
    });

    await runtime.host.startup();
    const session = await runtime.host.sessions.openOrResume();
    const agentGeneration = await runtime.host.programAgents.attach(
      session.sessionId,
      "phase-1.1-agent-generation",
      true,
    );

    const programStateId = asProgramStateId(String(mkProgramStateId()));
    const workItemId = asProgramWorkItemId("work-compose");
    const initial = createProgramState({
      programStateId,
      sourceSessionId: asSessionId(String(session.sessionId)),
      objective: "Prove production Program authority composition",
      workItems: [{
        workItemId,
        creationOrder: 0,
        description: "Inspect the Workspace",
        dependencyIds: [],
        affectedPaths: ["src/index.ts"],
      }],
      verification: [],
      outputSlots: [],
      productionSteps: [],
    });
    const attemptId = asProgramAttemptId(uuidv7());
    const active = applyProgramTransition(initial, {
      kind: "attempt.issue",
      expectedProgramRevision: initial.revision,
      attempt: {
        programAttemptId: attemptId,
        workItemId,
        sessionId: asSessionId(String(session.sessionId)),
        agentGeneration,
        initialExecutionBase: base,
        expectedExecutionBase: base,
      },
    });
    const envelope = {
      workspaceId: asWorkspaceId(locked.store.workspaceId),
      sessionId: session.sessionId,
      programStateId: asEventProgramStateId(String(programStateId)),
      occurredAt: new Date().toISOString(),
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "phase-1.1-composition-test" } as const,
    };
    const drafts: EventDraft<string, unknown>[] = [
      {
        ...envelope,
        eventId: mkEventId(),
        type: "program.created",
        payload: { state: initial },
      },
      {
        ...envelope,
        eventId: mkEventId(),
        type: "program.transitioned",
        payload: { state: active, transitionKind: "attempt.issue" },
      },
    ];
    await runtime.host.admission.append(drafts);

    const result = await runtime.host.capabilityBroker.execute({
      sessionId: session.sessionId,
      toolCallId: uuidv7(),
      toolName: "workspace.inspect",
      args: {},
    });
    expect(result.outcome).toBe("succeeded");

    const events = [];
    for await (const event of locked.store.replay()) events.push(event);
    const requested = events.find((event) => event.type === "operation.requested");
    expect(String(requested?.programStateId ?? "")).toBe(String(programStateId));
    expect((requested?.payload as Record<string, unknown> | undefined)?.programAttemptId).toBe(String(attemptId));
    expect((requested?.payload as Record<string, unknown> | undefined)?.agentGeneration).toBe(agentGeneration);

    const application = runtime.createApplicationService({
      start: async () => false,
      guide: async () => false,
      cancel: async () => false,
    });
    const snapshot = await application.getSnapshot(String(session.sessionId));
    expect(snapshot.programs?.some((program) => program.programStateId === String(programStateId))).toBe(true);

    locked.close();
  });
});
