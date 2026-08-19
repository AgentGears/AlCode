import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APPLICATION_PROTOCOL_VERSION } from "@alcode/application-protocol";
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
} from "@alcode/program-state";
import { openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import { HostArtifactStore } from "./artifact-store.ts";
import { PlanningReadRegistry } from "./planning-read.ts";
import { createProgramExecutionRuntimeV1 } from "./program-execution-runtime.ts";
import { HostVerificationOperationRegistryV1 } from "./program-verification.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

function executionBase(workspaceIdentity: string): ProgramAttemptExecutionBase {
  return {
    workspaceEffectGeneration: 0,
    observation: {
      kind: "workspace-observation-v1",
      providerKind: "phase-1.1-product-restart-test",
      workspaceIdentity,
      coverageDigest: "workspace-complete-v1",
      stateDigest: "state-v1",
    },
  };
}

function createRuntime(locked: LockedWorkspaceStore, artifactRoot: string) {
  const base = executionBase(locked.store.workspaceId);
  return createProgramExecutionRuntimeV1({
    host: { store: locked, capabilities: [] },
    planningReads: new PlanningReadRegistry("phase-1.1-product-restart", 1, []),
    creationPolicy: {
      current: () => ({ generation: "policy-1", digest: "policy-digest-1", requirements: [] }),
    },
    executionObservationProfiles: {
      current: () => ({ profileId: "workspace-observation-v1", profileVersion: 1, coverageIdentity: "workspace-complete-v1" }),
      validate: () => undefined,
    },
    observations: { observe: async () => ({ status: "complete" as const, base }) },
    pathObservations: { observePath: async () => ({ status: "unknown" as const, reason: "not used" }) },
    operationSpecs: new HostVerificationOperationRegistryV1([]),
    artifactStore: new HostArtifactStore({ root: artifactRoot }),
  });
}

const applicationAgent = {
  start: async () => false,
  guide: async () => false,
  cancel: async () => false,
};

describeLocked("Phase 1.1 Program product recovery", () => {
  it("rebuilds the same Program after Host restart and permits exact Session reattachment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-product-restart-"));
    const databasePath = join(dir, "workspace.sqlite");
    const lockPath = join(dir, "workspace.lock");
    const artifactRoot = join(dir, "artifacts");
    const workspaceId = asWorkspaceId(uuidv7());
    const repositoryId = uuidv7();

    try {
      const firstStore = await openLockedWorkspaceStore({ databasePath, lockPath, workspaceId, repositoryId });
      const firstRuntime = createRuntime(firstStore, artifactRoot);
      await firstRuntime.host.startup();
      const sourceSession = await firstRuntime.host.openOrResumeSession();
      const workItemId = asProgramWorkItemId("work-product-restart");
      const initial = createProgramState({
        programStateId: asProgramStateId(String(mkProgramStateId())),
        sourceSessionId: asSessionId(String(sourceSession.sessionId)),
        objective: "Recover authoritative Program product state",
        workItems: [{
          workItemId,
          creationOrder: 0,
          description: "Remain durable across Host restart",
          dependencyIds: [],
          affectedPaths: ["src/product.ts"],
        }],
        verification: [],
        outputSlots: [],
        productionSteps: [],
      });
      await firstRuntime.host.admission.append([{
        eventId: mkEventId(),
        workspaceId,
        sessionId: sourceSession.sessionId,
        programStateId: asEventProgramStateId(String(initial.programStateId)),
        occurredAt: new Date().toISOString(),
        type: "program.created",
        payload: { state: initial },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "program-product-restart-test" },
      }]);

      const firstApplication = firstRuntime.createApplicationService(applicationAgent);
      const before = await firstApplication.getSnapshot(String(sourceSession.sessionId));
      expect(before.programs?.[0]).toMatchObject({
        programStateId: String(initial.programStateId),
        revision: initial.revision,
        objective: initial.objective,
        lifecycle: "active",
      });
      await firstRuntime.host.shutdown();

      const reopenedStore = await openLockedWorkspaceStore({ databasePath, lockPath, workspaceId, repositoryId });
      const reopenedRuntime = createRuntime(reopenedStore, artifactRoot);
      await reopenedRuntime.host.startup();
      const resumed = await reopenedRuntime.host.openOrResumeSession(sourceSession.sessionId);
      expect(resumed.resumed).toBe(true);

      const reopenedApplication = reopenedRuntime.createApplicationService(applicationAgent);
      const recovered = await reopenedApplication.recover(String(sourceSession.sessionId));
      expect(recovered.mode).toBe("snapshot");
      if (recovered.mode !== "snapshot") throw new Error("expected restart snapshot");
      const recoveredProgram = recovered.snapshot.programs?.[0];
      expect(recoveredProgram).toMatchObject({
        programStateId: String(initial.programStateId),
        revision: initial.revision,
        objective: initial.objective,
        lifecycle: "active",
      });
      expect(recoveredProgram?.workItems[0]).toMatchObject({
        workItemId: String(workItemId),
        lifecycle: "pending",
        description: "Remain durable across Host restart",
      });

      const reattachedSession = await reopenedRuntime.host.openOrResumeSession();
      const attach = await reopenedApplication.execute({
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        commandId: uuidv7(),
        clientId: "program-product-restart-test",
        sessionId: String(reattachedSession.sessionId),
        issuedAt: new Date().toISOString(),
        type: "program.session.attach",
        programStateId: String(initial.programStateId),
        expectedProgramRevision: initial.revision,
      });
      expect(attach.decision).toBe("accepted");
      const reattachedSnapshot = await reopenedApplication.getSnapshot(String(reattachedSession.sessionId));
      expect(reattachedSnapshot.programs?.[0]?.programStateId).toBe(String(initial.programStateId));
      expect(reattachedSnapshot.programs?.[0]?.revision).toBeGreaterThan(initial.revision);
      expect(reattachedSnapshot.programs?.[0]?.attachedSessionIds).toContain(String(reattachedSession.sessionId));

      await reopenedRuntime.host.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
