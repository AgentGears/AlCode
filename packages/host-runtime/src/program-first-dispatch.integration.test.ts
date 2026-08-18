import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APPLICATION_PROTOCOL_VERSION } from "@alcode/application-protocol";
import { asProgramWorkItemId, type Json, type ProgramAttemptExecutionBase } from "@alcode/program-state";
import { openLockedWorkspaceStore } from "@alcode/storage";
import { HostArtifactStore } from "./artifact-store.ts";
import { PlanningReadRegistry, type PlanningReadContractV1 } from "./planning-read.ts";
import { createProgramExecutionRuntimeV1 } from "./program-execution-runtime.ts";
import { HostVerificationOperationRegistryV1 } from "./program-verification.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

function base(workspaceIdentity: string): ProgramAttemptExecutionBase {
  return {
    workspaceEffectGeneration: 0,
    observation: {
      kind: "workspace-observation-v1",
      providerKind: "phase-1.1-first-dispatch-test",
      workspaceIdentity,
      coverageDigest: "workspace-complete-v1",
      stateDigest: "state-v1",
    },
  };
}

function trackedRead(counter: { value: number }): PlanningReadContractV1 {
  return {
    readContractId: "workspace.file.v1",
    readContractVersion: 1,
    maxCanonicalArgsBytes: 1024,
    maxCanonicalResultBytes: 4096,
    normalizeArgs(input: Json): Json {
      return input;
    },
    async execute(canonicalArgs) {
      counter.value += 1;
      return {
        result: { path: (canonicalArgs as { path?: string }).path ?? "", text: "stable" },
        complete: true,
        coverageIdentity: "workspace-file-exact-v1",
        providerBindingRevision: "provider-1",
      };
    },
  };
}

describeLocked("Phase 1.1 exact acceptance to first dispatch", () => {
  it("keeps exact Application acceptance separate, then performs the protected first dispatch exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-phase11-first-dispatch-"));
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: "018f0000-0000-7000-8000-000000001103",
      repositoryId: "phase-1.1-first-dispatch",
    });
    const reads = { value: 0 };
    const planningReads = new PlanningReadRegistry("phase-1.1-first-dispatch", 1, [trackedRead(reads)]);
    const executionBase = base(locked.store.workspaceId);
    const runtime = createProgramExecutionRuntimeV1({
      host: { store: locked, capabilities: [] },
      planningReads,
      creationPolicy: {
        current: () => ({ generation: "policy-1", digest: "policy-digest-1", requirements: [] }),
      },
      executionObservationProfiles: {
        current: () => ({
          profileId: "workspace-observation-v1",
          profileVersion: 1,
          coverageIdentity: "workspace-complete-v1",
        }),
        validate: () => undefined,
      },
      observations: { observe: async () => ({ status: "complete", base: executionBase }) },
      pathObservations: {
        observePath: async () => ({ status: "unknown", reason: "not used" }),
      },
      operationSpecs: new HostVerificationOperationRegistryV1([]),
      artifactStore: new HostArtifactStore({ root: join(dir, "artifacts") }),
    });

    await runtime.host.startup();
    const session = await runtime.host.sessions.openOrResume();
    const objective = "Create and dispatch the first Program work item";
    await runtime.host.admitInput(session.sessionId, objective);
    const agentGeneration = await runtime.host.programAgents.attach(
      session.sessionId,
      "phase11-first-dispatch-agent",
      true,
    );

    const tracker = planningReads.track(locked.store.workspaceId);
    await tracker.read("workspace.file.v1", 1, { path: "src/index.ts" });
    const draft = await runtime.creation.sealDraft({
      sourceSessionId: session.sessionId,
      proposal: {
        objective,
        workItems: [{
          workItemId: asProgramWorkItemId("work-first"),
          creationOrder: 0,
          description: "Perform the first work item",
          dependencyIds: [],
          affectedPaths: ["src/index.ts"],
        }],
        verification: [],
        outputSlots: [],
        productionSteps: [],
      },
      planningReads: tracker,
    });
    expect(reads.value).toBe(1);

    const application = runtime.createApplicationService({
      start: async () => false,
      guide: async () => false,
      cancel: async () => false,
    });

    const stale = await application.execute({
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      commandId: "accept-stale",
      clientId: "phase11-application",
      sessionId: String(session.sessionId),
      issuedAt: new Date().toISOString(),
      type: "program.creation.accept",
      draftId: draft.draftId,
      draftDigest: "wrong-digest",
    });
    expect(stale.decision).toBe("stale");
    expect((await application.getSnapshot(String(session.sessionId))).programs).toEqual([]);

    const accepted = await application.execute({
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      commandId: "accept-current",
      clientId: "phase11-application",
      sessionId: String(session.sessionId),
      issuedAt: new Date().toISOString(),
      type: "program.creation.accept",
      draftId: draft.draftId,
      draftDigest: draft.draftDigest,
    });
    expect(accepted.decision).toBe("accepted");
    expect(accepted.programRevision).toBe(2);
    expect(reads.value).toBe(3);

    const snapshot = await application.getSnapshot(String(session.sessionId));
    expect(snapshot.pendingProgramCreations).toEqual([]);
    expect(snapshot.programs).toHaveLength(1);
    const program = snapshot.programs![0]!;
    expect(program.revision).toBe(2);
    expect(program.activeAttempt).toMatchObject({
      workItemId: "work-first",
      sessionId: String(session.sessionId),
      agentGeneration,
    });
    expect(program.workItems[0]?.lifecycle).toBe("in_progress");

    const firstAttemptId = program.activeAttempt!.programAttemptId;
    const duplicate = await application.execute({
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      commandId: "accept-duplicate",
      clientId: "phase11-application",
      sessionId: String(session.sessionId),
      issuedAt: new Date().toISOString(),
      type: "program.creation.accept",
      draftId: draft.draftId,
      draftDigest: draft.draftDigest,
    });
    expect(duplicate.decision).toBe("duplicate");
    expect(duplicate.programRevision).toBe(2);
    const afterDuplicate = await application.getSnapshot(String(session.sessionId));
    expect(afterDuplicate.programs?.[0]?.activeAttempt?.programAttemptId).toBe(firstAttemptId);
    expect(reads.value).toBe(3);

    locked.close();
  });

  it("can resume a first dispatch from a later duplicate acceptance after Agent availability changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-phase11-first-dispatch-late-agent-"));
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: "018f0000-0000-7000-8000-000000001104",
      repositoryId: "phase-1.1-first-dispatch-late-agent",
    });
    const planningReads = new PlanningReadRegistry("phase-1.1-first-dispatch", 1, []);
    const runtime = createProgramExecutionRuntimeV1({
      host: { store: locked, capabilities: [] },
      planningReads,
      creationPolicy: {
        current: () => ({ generation: "policy-1", digest: "policy-digest-1", requirements: [] }),
      },
      executionObservationProfiles: {
        current: () => ({ profileId: "workspace-observation-v1", profileVersion: 1, coverageIdentity: "workspace-complete-v1" }),
        validate: () => undefined,
      },
      observations: { observe: async () => ({ status: "complete", base: base(locked.store.workspaceId) }) },
      pathObservations: { observePath: async () => ({ status: "unknown", reason: "not used" }) },
      operationSpecs: new HostVerificationOperationRegistryV1([]),
      artifactStore: new HostArtifactStore({ root: join(dir, "artifacts") }),
    });
    await runtime.host.startup();
    const session = await runtime.host.sessions.openOrResume();
    const objective = "Wait for an Agent before first dispatch";
    await runtime.host.admitInput(session.sessionId, objective);
    const draft = await runtime.creation.sealDraft({
      sourceSessionId: session.sessionId,
      proposal: {
        objective,
        workItems: [{
          workItemId: asProgramWorkItemId("work-late-agent"),
          creationOrder: 0,
          description: "Dispatch after Agent attach",
          dependencyIds: [],
          affectedPaths: [],
        }],
        verification: [], outputSlots: [], productionSteps: [],
      },
      planningReads: planningReads.track(locked.store.workspaceId),
    });
    const application = runtime.createApplicationService({ start: async () => false, guide: async () => false, cancel: async () => false });
    const first = await application.execute({
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      commandId: "accept-before-agent",
      clientId: "phase11-application",
      sessionId: String(session.sessionId),
      issuedAt: new Date().toISOString(),
      type: "program.creation.accept",
      draftId: draft.draftId,
      draftDigest: draft.draftDigest,
    });
    expect(first.decision).toBe("accepted");
    expect(first.programRevision).toBe(1);
    expect((await application.getSnapshot(String(session.sessionId))).programs?.[0]?.activeAttempt).toBeUndefined();

    await runtime.host.programAgents.attach(session.sessionId, "phase11-late-agent", true);
    const retry = await application.execute({
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      commandId: "accept-after-agent",
      clientId: "phase11-application",
      sessionId: String(session.sessionId),
      issuedAt: new Date().toISOString(),
      type: "program.creation.accept",
      draftId: draft.draftId,
      draftDigest: draft.draftDigest,
    });
    expect(retry.decision).toBe("duplicate");
    expect(retry.programRevision).toBe(2);
    expect((await application.getSnapshot(String(session.sessionId))).programs?.[0]?.activeAttempt).toBeDefined();
    locked.close();
  });
});
