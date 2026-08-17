import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asWorkspaceId, mkEventId, type SessionId } from "@alcode/events";
import {
  asProgramWorkItemId,
  asVerificationObligationId,
} from "@alcode/program-state";
import { openLockedWorkspaceStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import {
  ProgramCreationControlError,
  ProgramCreationServiceV1,
  ProgramCreationStaleError,
  type ExecutionObservationProfileAuthorityV1,
  type PlanningReadBarrierV1,
  type ProgramCreationPolicySourceV1,
  type ProgramCreationProposalV1,
} from "./program-creation.ts";
import { PlanningReadRegistry, TrackedPlanningReads } from "./planning-read.ts";
import { HostSessionManager, HostSessionStateError } from "./session-manager.ts";

const policy: ProgramCreationPolicySourceV1 = {
  current: () => ({ generation: "policy-1", digest: "policy-digest-1", requirements: [] }),
};

const executionProfiles: ExecutionObservationProfileAuthorityV1 = {
  current: () => ({
    profileId: "workspace-observation-v1",
    profileVersion: 1,
    coverageIdentity: "local-git-v1",
  }),
  validate: () => undefined,
};

const barrier: PlanningReadBarrierV1 = {
  runExclusive: (work) => work(),
};

function proposal(): ProgramCreationProposalV1 {
  const workItemId = asProgramWorkItemId("work-binding");
  return {
    objective: "Preserve single-session Program binding",
    workItems: [{
      workItemId,
      creationOrder: 0,
      description: "Do bounded work",
      dependencyIds: [],
      affectedPaths: ["src/binding.ts"],
    }],
    verification: [{
      obligationId: asVerificationObligationId("verify-binding"),
      predicate: { kind: "workspace_path_state", path: "src/binding.ts", requiredState: "file" },
      freshnessScope: { kind: "workspace" },
    }],
    outputSlots: [],
    productionSteps: [],
  };
}

async function appendObjectiveEvent(
  admission: CanonicalAdmissionQueue,
  workspaceId: string,
  sessionId: SessionId,
  objective: string,
): Promise<string> {
  const eventId = mkEventId();
  const timestamp = Date.now();
  await admission.append([{
    eventId,
    workspaceId: asWorkspaceId(workspaceId),
    sessionId,
    occurredAt: new Date(timestamp).toISOString(),
    type: "user.message.appended",
    payload: { text: objective, timestamp },
    payloadSchemaVersion: 1,
    producer: { kind: "user" },
  }]);
  return String(eventId);
}

async function replayTypes(store: { replay(): AsyncIterable<{ type: string }> }): Promise<string[]> {
  const result: string[] = [];
  for await (const event of store.replay()) result.push(event.type);
  return result;
}

const describeLocked = process.platform === "win32" ? describe.skip : describe;

describeLocked("Program creation source-session binding", () => {
  it("rejects a second pending draft and makes pending creation block ordinary completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-binding-"));
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: "018f0000-0000-7000-8000-000000000304",
      repositoryId: "program-binding-test",
    });
    const admission = new CanonicalAdmissionQueue(locked.store);
    const sessions = new HostSessionManager(locked, admission);
    const session = await sessions.openOrResume();
    const registry = new PlanningReadRegistry("planning-empty-v1", 1, []);
    const service = new ProgramCreationServiceV1({
      store: locked.store,
      admission,
      planningReads: registry,
      planningBarrier: barrier,
      policy,
      executionObservationProfiles: executionProfiles,
    });
    const programProposal = proposal();
    const sourceObjectiveEventId = await appendObjectiveEvent(
      admission, locked.store.workspaceId, session.sessionId, programProposal.objective,
    );

    const unissued = new TrackedPlanningReads(registry, locked.store.workspaceId);
    await expect(service.sealDraft({
      sourceSessionId: session.sessionId,
      proposal: programProposal,
      planningReads: unissued,
      sourceObjectiveEventId,
    })).rejects.toBeInstanceOf(ProgramCreationControlError);

    const alteredTracker = registry.track(locked.store.workspaceId);
    await expect(service.sealDraft({
      sourceSessionId: session.sessionId,
      proposal: { ...programProposal, objective: "Agent-altered objective" },
      planningReads: alteredTracker,
      sourceObjectiveEventId,
    })).rejects.toBeInstanceOf(ProgramCreationStaleError);

    const tracker = registry.track(locked.store.workspaceId);
    await service.sealDraft({
      sourceSessionId: session.sessionId,
      proposal: programProposal,
      planningReads: tracker,
      sourceObjectiveEventId,
    });

    const secondTracker = registry.track(locked.store.workspaceId);
    await expect(service.sealDraft({
      sourceSessionId: session.sessionId,
      proposal: programProposal,
      planningReads: secondTracker,
      sourceObjectiveEventId,
    })).rejects.toBeInstanceOf(ProgramCreationControlError);

    await expect(sessions.stop(session.sessionId, "completed")).rejects.toBeInstanceOf(HostSessionStateError);
    expect(await sessions.getState(session.sessionId)).toMatchObject({ started: true, stopped: false });
    let types = await replayTypes(locked.store);
    expect(types).not.toContain("program.creation.draft.invalidated");
    expect(types).not.toContain("runtime.session.stopped");

    await sessions.stop(session.sessionId, "cancelled");
    types = await replayTypes(locked.store);
    expect(types).toContain("program.creation.draft.invalidated");
    expect(types).toContain("runtime.session.stopped");
    locked.close();
  });
});
