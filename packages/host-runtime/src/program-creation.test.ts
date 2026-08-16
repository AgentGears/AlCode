import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asProgramWorkItemId,
  asVerificationObligationId,
  type Json,
} from "@alcode/program-state";
import { openLockedWorkspaceStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { HostSessionManager } from "./session-manager.ts";
import {
  ProgramCreationServiceV1,
  ProgramCreationStaleError,
  type ExecutionObservationProfileAuthorityV1,
  type PlanningReadBarrierV1,
  type ProgramCreationPolicySourceV1,
  type ProgramCreationProposalV1,
} from "./program-creation.ts";
import {
  PlanningReadRegistry,
  TrackedPlanningReads,
  type PlanningReadContractV1,
} from "./planning-read.ts";

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
  current: () => ({
    generation: "policy-generation-1",
    digest: "policy-digest-1",
    requirements: [],
  }),
};

const executionProfiles: ExecutionObservationProfileAuthorityV1 = {
  current: () => ({
    profileId: "workspace-observation-v1",
    profileVersion: 1,
    coverageIdentity: "local-git-complete-v1",
  }),
  validate: () => undefined,
};

class ImmediateBarrier implements PlanningReadBarrierV1 {
  runExclusive<T>(work: () => Promise<T>): Promise<T> { return work(); }
}

class ControlledBarrier implements PlanningReadBarrierV1 {
  entered = false;
  private releasePromise!: Promise<void>;
  private releaseResolve!: () => void;

  constructor() {
    this.releasePromise = new Promise<void>((resolve) => { this.releaseResolve = resolve; });
  }

  async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    this.entered = true;
    await this.releasePromise;
    return work();
  }

  release(): void { this.releaseResolve(); }
}

function proposal(): ProgramCreationProposalV1 {
  const workItemId = asProgramWorkItemId("work-1");
  return {
    objective: "Update src/a.ts without losing planning provenance",
    workItems: [{
      workItemId,
      creationOrder: 0,
      description: "Update the file",
      dependencyIds: [],
      affectedPaths: ["src/a.ts"],
    }],
    verification: [{
      obligationId: asVerificationObligationId("verify-a"),
      predicate: { kind: "workspace_path_state", path: "src/a.ts", requiredState: "file" },
      freshnessScope: { kind: "paths", entries: [{ path: "src/a.ts", mode: "exact" }] },
    }],
    outputSlots: [],
    productionSteps: [],
  };
}

async function allEvents(store: { replay(): AsyncIterable<any> }): Promise<any[]> {
  const events: any[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

const describeLocked = process.platform === "win32" ? describe.skip : describe;

describeLocked("Program creation control", () => {
  it("seals exact tracked provenance, atomically creates one Program, deduplicates acceptance, and supports restart recheck", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-creation-"));
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: "018f0000-0000-7000-8000-000000000301",
      repositoryId: "program-creation-test",
    });
    const admission = new CanonicalAdmissionQueue(locked.store);
    const sessions = new HostSessionManager(locked, admission);
    const session = await sessions.openOrResume();
    const files = new Map([["src/a.ts", "before"]]);
    const registry = new PlanningReadRegistry("planning-files-v1", 1, [fileContract(files)]);
    const tracker = new TrackedPlanningReads(registry, locked.store.workspaceId);
    expect(await tracker.read("file.read.v1", 1, { path: "src/a.ts" })).toEqual({ kind: "file", text: "before" });
    const planningIdentity = tracker.seal();

    const service = new ProgramCreationServiceV1({
      store: locked.store,
      admission,
      planningReads: registry,
      planningBarrier: new ImmediateBarrier(),
      policy,
      executionObservationProfiles: executionProfiles,
    });
    const draft = await service.sealDraft({
      sourceSessionId: session.sessionId,
      proposal: proposal(),
      planningObservationIdentity: planningIdentity,
    });
    expect(draft.planningObservationIdentity.dependencies[0]!.canonicalArgs).toEqual({ path: "src/a.ts" });

    const created = await service.acceptDraft({
      draftId: draft.draftId,
      draftDigest: draft.draftDigest,
      commandId: "accept-1",
    });
    expect(created.status).toBe("created");
    expect(created.programState?.revision).toBe(1);
    expect(created.programState?.attachedSessionIds).toEqual([session.sessionId]);

    const duplicate = await service.acceptDraft({
      draftId: draft.draftId,
      draftDigest: draft.draftDigest,
      commandId: "accept-2",
    });
    expect(duplicate.status).toBe("existing");
    expect(duplicate.programStateId).toBe(created.programStateId);

    const events = await allEvents(locked.store);
    const accepted = events.find((event) => event.type === "program.creation.draft.accepted");
    const programCreated = events.find((event) => event.type === "program.created");
    expect(accepted.sequence + 1).toBe(programCreated.sequence);
    expect(programCreated.payload.creation.acceptedPlanningBase.dependencies[0].canonicalArgs).toEqual({ path: "src/a.ts" });
    expect(events.filter((event) => event.type === "program.created")).toHaveLength(1);

    // New service instance: no pre-crash tracker state survives. The durable
    // program.created provenance contains the exact arguments needed to recheck.
    const reopenedService = new ProgramCreationServiceV1({
      store: locked.store,
      admission,
      planningReads: new PlanningReadRegistry("planning-files-v1", 1, [fileContract(files)]),
      planningBarrier: new ImmediateBarrier(),
      policy,
      executionObservationProfiles: executionProfiles,
    });
    await expect(reopenedService.recheckAcceptedPlanningBase(created.programStateId)).resolves.toBeUndefined();
    files.set("src/a.ts", "changed-after-create");
    await expect(reopenedService.recheckAcceptedPlanningBase(created.programStateId)).rejects.toThrow(/changed/);
    locked.close();
  });

  it("fails creation closed when a tracked planning dependency changes before acceptance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-creation-stale-"));
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: "018f0000-0000-7000-8000-000000000302",
      repositoryId: "program-creation-test",
    });
    const admission = new CanonicalAdmissionQueue(locked.store);
    const session = await new HostSessionManager(locked, admission).openOrResume();
    const files = new Map([["src/a.ts", "one"]]);
    const registry = new PlanningReadRegistry("planning-files-v1", 1, [fileContract(files)]);
    const tracker = new TrackedPlanningReads(registry, locked.store.workspaceId);
    await tracker.read("file.read.v1", 1, { path: "src/a.ts" });
    const service = new ProgramCreationServiceV1({
      store: locked.store,
      admission,
      planningReads: registry,
      planningBarrier: new ImmediateBarrier(),
      policy,
      executionObservationProfiles: executionProfiles,
    });
    const draft = await service.sealDraft({
      sourceSessionId: session.sessionId,
      proposal: proposal(),
      planningObservationIdentity: tracker.seal(),
    });

    files.set("src/a.ts", "two");
    await expect(service.acceptDraft({
      draftId: draft.draftId,
      draftDigest: draft.draftDigest,
      commandId: "accept-stale",
    })).rejects.toBeInstanceOf(ProgramCreationStaleError);
    expect((await allEvents(locked.store)).filter((event) => event.type === "program.created")).toHaveLength(0);
    locked.close();
  });

  it("linearizes source-session stop ahead of acceptance that is waiting for Workspace read protection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-creation-stop-race-"));
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: "018f0000-0000-7000-8000-000000000303",
      repositoryId: "program-creation-test",
    });
    const admission = new CanonicalAdmissionQueue(locked.store);
    const sessions = new HostSessionManager(locked, admission);
    const session = await sessions.openOrResume();
    const files = new Map([["src/a.ts", "one"]]);
    const registry = new PlanningReadRegistry("planning-files-v1", 1, [fileContract(files)]);
    const tracker = new TrackedPlanningReads(registry, locked.store.workspaceId);
    await tracker.read("file.read.v1", 1, { path: "src/a.ts" });
    const barrier = new ControlledBarrier();
    const service = new ProgramCreationServiceV1({
      store: locked.store,
      admission,
      planningReads: registry,
      planningBarrier: barrier,
      policy,
      executionObservationProfiles: executionProfiles,
    });
    const draft = await service.sealDraft({
      sourceSessionId: session.sessionId,
      proposal: proposal(),
      planningObservationIdentity: tracker.seal(),
    });

    const acceptance = service.acceptDraft({
      draftId: draft.draftId,
      draftDigest: draft.draftDigest,
      commandId: "accept-racing-stop",
    });
    while (!barrier.entered) await Promise.resolve();
    await sessions.stop(session.sessionId, "cancelled");
    barrier.release();

    await expect(acceptance).rejects.toBeInstanceOf(ProgramCreationStaleError);
    const events = await allEvents(locked.store);
    expect(events.some((event) => event.type === "program.creation.draft.invalidated")).toBe(true);
    expect(events.some((event) => event.type === "runtime.session.stopped")).toBe(true);
    expect(events.some((event) => event.type === "program.created")).toBe(false);
    locked.close();
  });
});
