import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APPLICATION_PROTOCOL_VERSION, reduceApplicationEvents } from "@alcode/application-protocol";
import { asWorkspaceId, uuidv7 } from "@alcode/events";
import { openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import { HostApplicationService } from "./application-service.ts";
import { HostRuntime } from "./host.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

async function openStore(dir: string): Promise<LockedWorkspaceStore> {
  return openLockedWorkspaceStore({
    databasePath: join(dir, "workspace.sqlite"),
    lockPath: join(dir, "workspace.lock"),
    workspaceId: asWorkspaceId(uuidv7()),
    repositoryId: uuidv7(),
  });
}

function commandBase(sessionId: string, commandId: string) {
  return {
    protocolVersion: APPLICATION_PROTOCOL_VERSION,
    commandId,
    clientId: "test-client",
    sessionId,
    issuedAt: new Date().toISOString(),
  } as const;
}

describeLocked("Phase 0.8 Host Application Protocol", () => {
  let dir: string;
  let locked: LockedWorkspaceStore | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-application-08-"));
    locked = null;
  });

  afterEach(() => {
    try { locked?.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("makes command identity, queue ordering, and target-sensitive cancel authoritative", async () => {
    locked = await openStore(dir);
    const host = new HostRuntime({ store: locked, capabilities: [] });
    await host.startup();
    const session = await host.openOrResumeSession();
    const sessionId = session.sessionId as string;
    const controls: string[] = [];
    const service = new HostApplicationService({
      store: locked.store,
      admission: host.admission,
      agent: {
        start: async (_session, text) => { controls.push(`start:${text}`); return true; },
        guide: async () => false,
        cancel: async (_session, executionId) => { controls.push(`cancel:${executionId}`); return true; },
      },
    });

    const start = await service.execute({
      ...commandBase(sessionId, "c-start"),
      type: "input.submit",
      text: "first",
      requestedDisposition: "START_NOW",
    });
    expect(start.decision).toBe("accepted");
    expect(start.admittedDisposition).toBe("START_NOW");
    expect(start.targetExecutionId).toBeTruthy();
    expect(controls).toEqual(["start:first"]);

    const duplicate = await service.execute({
      ...commandBase(sessionId, "c-start"),
      type: "input.submit",
      text: "first",
      requestedDisposition: "START_NOW",
    });
    expect(duplicate.decision).toBe("duplicate");
    expect(duplicate.targetExecutionId).toBe(start.targetExecutionId);
    expect(controls).toEqual(["start:first"]);

    const queued = await service.execute({
      ...commandBase(sessionId, "c-queue"),
      type: "input.submit",
      text: "second",
      requestedDisposition: "QUEUE",
    });
    expect(queued).toMatchObject({ decision: "accepted", admittedDisposition: "QUEUE" });
    const queueItemId = queued.queueItemId!;

    const duplicateQueue = await service.execute({
      ...commandBase(sessionId, "c-queue"),
      type: "input.submit",
      text: "second",
      requestedDisposition: "QUEUE",
    });
    expect(duplicateQueue.decision).toBe("duplicate");
    expect(duplicateQueue.queueItemId).toBe(queueItemId);
    expect((await service.getSnapshot(sessionId)).queue).toHaveLength(1);

    const staleCancel = await service.execute({
      ...commandBase(sessionId, "c-stale-cancel"),
      type: "execution.cancel",
      expectedExecutionId: "old-execution",
    });
    expect(staleCancel.decision).toBe("stale");
    expect(controls.some((entry) => entry.startsWith("cancel:"))).toBe(false);

    const cancel = await service.execute({
      ...commandBase(sessionId, "c-cancel"),
      type: "execution.cancel",
      expectedExecutionId: start.targetExecutionId!,
    });
    expect(cancel.decision).toBe("accepted");
    expect(controls).toContain(`cancel:${start.targetExecutionId}`);
  });

  it("rejects unsupported GUIDE explicitly and never silently queues it", async () => {
    locked = await openStore(dir);
    const host = new HostRuntime({ store: locked, capabilities: [] });
    await host.startup();
    const session = await host.openOrResumeSession();
    const sessionId = session.sessionId as string;
    const service = new HostApplicationService({
      store: locked.store,
      admission: host.admission,
      agent: {
        start: async () => true,
        guide: async () => false,
        cancel: async () => true,
      },
    });

    await service.execute({
      ...commandBase(sessionId, "c-start"),
      type: "input.submit",
      text: "working",
      requestedDisposition: "START_NOW",
    });
    const guide = await service.execute({
      ...commandBase(sessionId, "c-guide"),
      type: "input.submit",
      text: "avoid generated files",
      requestedDisposition: "GUIDE",
    });

    expect(guide).toMatchObject({ decision: "rejected", reasonCode: "guide_not_supported" });
    const snapshot = await service.getSnapshot(sessionId);
    expect(snapshot.queue).toHaveLength(0);
    expect(snapshot.transcript.some((message) => message.text === "avoid generated files")).toBe(false);
  });

  it("replays from a known cursor and falls back to an authoritative snapshot for stale cursors", async () => {
    locked = await openStore(dir);
    const host = new HostRuntime({ store: locked, capabilities: [] });
    await host.startup();
    const session = await host.openOrResumeSession();
    const sessionId = session.sessionId as string;
    const service = new HostApplicationService({
      store: locked.store,
      admission: host.admission,
      agent: { start: async () => true, guide: async () => false, cancel: async () => true },
    });

    const initial = await service.getSnapshot(sessionId);
    await service.execute({
      ...commandBase(sessionId, "c-start"),
      type: "input.submit",
      text: "resume me",
      requestedDisposition: "START_NOW",
    });

    const recovery = await service.recover(sessionId, initial.cursor);
    expect(recovery.mode).toBe("resume");
    if (recovery.mode !== "resume") throw new Error("expected resume");
    expect(recovery.events.length).toBeGreaterThan(0);
    const rebuilt = reduceApplicationEvents(initial, recovery.events);
    expect(rebuilt).toEqual(await service.getSnapshot(sessionId));

    const stale = await service.recover(sessionId, initial.cursor + 1);
    expect(stale.mode).toBe("snapshot");
    if (stale.mode !== "snapshot") throw new Error("expected snapshot");
    expect(stale.reason).toBe("stale");
    expect(stale.snapshot).toEqual(await service.getSnapshot(sessionId));
  });

  it("represents permission as Host state and only executes mutation after a typed response", async () => {
    locked = await openStore(dir);
    let executions = 0;
    const host = new HostRuntime({
      store: locked,
      capabilities: [{
        name: "mutate",
        isReadOnly: false,
        async execute() {
          executions += 1;
          return { result: "done", outcome: "succeeded" as const };
        },
      }],
    });
    await host.startup();
    const session = await host.openOrResumeSession();
    const sessionId = session.sessionId as string;
    const service = new HostApplicationService({
      store: locked.store,
      admission: host.admission,
      agent: { start: async () => true, guide: async () => false, cancel: async () => true },
    });
    host.capabilityBroker.setApprovalHandler(async (request) => service.requestPermission({
      sessionId: request.sessionId,
      toolName: request.toolName,
      description: request.reason,
    }));

    const pendingExecution = host.capabilityBroker.execute({
      sessionId: session.sessionId,
      toolCallId: "tc-1",
      toolName: "mutate",
      args: { path: "x" },
    });

    // requestPermission admits the interaction before returning its unresolved promise.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pendingSnapshot = await service.getSnapshot(sessionId);
    expect(executions).toBe(0);
    expect(pendingSnapshot.pendingInteractions).toHaveLength(1);
    const interactionId = pendingSnapshot.pendingInteractions[0]!.interactionId;

    const response = await service.execute({
      ...commandBase(sessionId, "c-permission"),
      type: "permission.respond",
      interactionId,
      decision: "allow_once",
    });
    expect(response.decision).toBe("accepted");

    const result = await pendingExecution;
    expect(result.outcome).toBe("succeeded");
    expect(executions).toBe(1);
    expect((await service.getSnapshot(sessionId)).pendingInteractions).toHaveLength(0);
  });
});
