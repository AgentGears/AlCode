import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  asProgramStateId as asEventProgramStateId,
  asWorkspaceId,
  mkEventId,
  type EventDraft,
  type PersistedDomainEvent,
} from "@alcode/events";
import {
  asProgramStateId,
  asProgramWorkItemId,
  createProgramState,
  type ProgramAttemptExecutionBase,
} from "@alcode/program-state";
import { openLockedWorkspaceStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { Phase1RecoveryControllerV1 } from "./program-recovery.ts";
import { ProgramSemanticBaselineServiceV1 } from "./program-semantic-baseline-service.ts";
import { HostSessionManager } from "./session-manager.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

function executionBase(
  workspaceIdentity: string,
  stateDigest: string,
): ProgramAttemptExecutionBase {
  return {
    workspaceEffectGeneration: 0,
    observation: {
      kind: "workspace-observation-v1",
      providerKind: "adaptive-recovery-boundary-test",
      workspaceIdentity,
      coverageDigest: "complete",
      stateDigest,
    },
  };
}

async function replayAll(store: { replay(): AsyncIterable<PersistedDomainEvent<string, unknown>> }) {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

describeLocked("A1 Phase-1 recovery adaptive authority boundary", () => {
  it("does not let generic recovery mutate ProgramState after canonical semantic baseline adoption", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-a1-phase1-adaptive-boundary-"));
    const workspaceId = "018f0000-0000-7000-8000-000000001201";
    const programStateId = asProgramStateId("018f0000-0000-7000-8000-000000001202");
    const workItemId = asProgramWorkItemId("adaptive-recovery-boundary-work");
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId,
      repositoryId: "a1-phase1-adaptive-boundary",
    });

    try {
      const admission = new CanonicalAdmissionQueue(locked.store);
      const sessions = new HostSessionManager(locked, admission);
      const session = await sessions.openOrResume();
      const oldBase = executionBase(workspaceId, "old-state");
      const state = createProgramState({
        programStateId,
        sourceSessionId: session.sessionId,
        objective: "Keep fixed recovery outside adaptive ProgramState authority",
        workItems: [{
          workItemId,
          creationOrder: 0,
          description: "Preserve adaptive recovery ownership",
          dependencyIds: [],
          affectedPaths: ["src/adaptive.ts"],
        }],
        verification: [],
        outputSlots: [],
        productionSteps: [],
      });
      state.revision = 7;
      state.acceptedExecutionBase = oldBase;

      const created: EventDraft<string, unknown> = {
        eventId: mkEventId(),
        idempotencyKey: `program.created:${String(programStateId)}`,
        correlationId: "adaptive-recovery-boundary",
        workspaceId: asWorkspaceId(workspaceId),
        sessionId: session.sessionId,
        programStateId: asEventProgramStateId(String(programStateId)),
        occurredAt: new Date().toISOString(),
        type: "program.created",
        payload: { state },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "adaptive-recovery-boundary-test" },
      };
      await admission.append([created]);

      const coordinator = { runExclusive: async <T>(work: () => Promise<T>): Promise<T> => work() };
      const baseline = new ProgramSemanticBaselineServiceV1({
        store: locked.store,
        admission,
        workspaceCoordinator: coordinator,
        recovery: { isClear: () => true },
        authority: {
          forWorkItem: () => ({
            allowedRepositoryRoots: ["."],
            allowedEffectClasses: ["fs.read", "fs.write"],
            allowedExternalSystems: [],
            capabilityCeiling: ["edit", "read"],
            maximumTopologyExpansion: 8,
            mandatoryVerificationIds: [],
            forbiddenChangeKinds: ["delete_repository"],
          }),
        },
      });
      const draft = await baseline.sealDraft({
        sourceSessionId: String(session.sessionId),
        programStateId: String(programStateId),
        expectedProgramStateRevision: state.revision,
      });
      const adopted = await baseline.accept({
        commandId: "accept-adaptive-recovery-boundary",
        clientId: "adaptive-recovery-boundary-test",
        sourceSessionId: String(session.sessionId),
        programStateId: String(programStateId),
        draftId: draft.draftId,
        draftDigest: draft.draftDigest,
      });
      expect(adopted.status).toBe("adopted");

      const before = await replayAll(locked.store);
      const beforeProgramStateEvents = before.filter((event) =>
        String(event.programStateId ?? "") === String(programStateId)
        && (event.type === "program.created" || event.type === "program.transitioned"
          || event.type === "program.completed" || event.type === "program.cancelled"));
      expect(beforeProgramStateEvents).toHaveLength(1);

      const recovery = new Phase1RecoveryControllerV1({
        store: locked.store,
        admission,
        workspaceCoordinator: coordinator,
        observations: {
          observe: async () => ({
            status: "complete" as const,
            base: executionBase(workspaceId, "new-state"),
          }),
        },
        capabilities: [],
      });
      const result = await recovery.recover();
      expect(result.clear).toBe(true);
      expect(result.interruptedAttempts).toBe(0);

      const after = await replayAll(locked.store);
      const afterProgramStateEvents = after.filter((event) =>
        String(event.programStateId ?? "") === String(programStateId)
        && (event.type === "program.created" || event.type === "program.transitioned"
          || event.type === "program.completed" || event.type === "program.cancelled"));
      expect(afterProgramStateEvents).toEqual(beforeProgramStateEvents);
      expect(after.some((event) =>
        String(event.programStateId ?? "") === String(programStateId)
        && event.producer.kind === "runtime"
        && String((event.producer as { component?: string }).component ?? "") === "phase1-recovery"))
        .toBe(false);
    } finally {
      locked.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
