import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asSessionId, asWorkspaceId, uuidv7 } from "@alcode/events";
import {
  createWorkspaceReadModels,
  openLockedWorkspaceStore,
  type LockedWorkspaceStore,
} from "@alcode/storage";
import {
  DefaultHostPolicy,
  HostRuntime,
  type HostCapability,
} from "./index.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

function makePaths(dir: string) {
  return {
    databasePath: join(dir, "workspace.sqlite"),
    lockPath: join(dir, "workspace.lock"),
  };
}

async function openStore(dir: string): Promise<LockedWorkspaceStore> {
  const paths = makePaths(dir);
  return openLockedWorkspaceStore({
    ...paths,
    workspaceId: asWorkspaceId(uuidv7()),
    repositoryId: uuidv7(),
  });
}

async function eventTypes(store: LockedWorkspaceStore): Promise<string[]> {
  const types: string[] = [];
  for await (const event of store.store.replay()) types.push(event.type);
  return types;
}

describeLocked("Phase 0.5 Host runtime integration", () => {
  let dir: string;
  let locked: LockedWorkspaceStore | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-host-05-"));
    locked = null;
  });

  afterEach(() => {
    try { locked?.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("denies a mutating capability before operation start or environmental execution", async () => {
    locked = await openStore(dir);
    let executed = 0;
    const mutating: HostCapability = {
      name: "mutate",
      isReadOnly: false,
      async execute() {
        executed++;
        return { result: "should not run", outcome: "succeeded" };
      },
    };
    const host = new HostRuntime({
      store: locked,
      capabilities: [mutating],
      policy: new DefaultHostPolicy({ knownTools: ["mutate"], allowMutations: false }),
    });
    await host.startup();
    const session = await host.openOrResumeSession();

    const result = await host.capabilityBroker.execute({
      sessionId: session.sessionId,
      toolCallId: "tc-denied",
      toolName: "mutate",
      args: { path: "x" },
    });

    expect(result.outcome).toBe("denied");
    expect(executed).toBe(0);
    expect(await eventTypes(locked)).not.toContain("operation.started");
  });

  it("makes operation + action canonical and the operations projection caught up before environmental execution", async () => {
    locked = await openStore(dir);
    let observedBarrier = false;
    const capability: HostCapability = {
      name: "touch",
      isReadOnly: false,
      async execute() {
        if (!locked) throw new Error("store closed");
        const head = await locked.store.headSequence();
        const events = locked.store.getVerifiedEvents(0, 100);
        const tail = events.slice(-3).map((event) => event.type);
        const cursor = locked.store.getProjectionRunner().getCursor("operations");
        expect(tail).toEqual(["operation.requested", "operation.started", "action.recorded"]);
        expect(cursor.lastAppliedEventSequence).toBe(head);
        observedBarrier = true;
        return { result: { ok: true }, outcome: "succeeded", stdout: "ok" };
      },
    };
    const host = new HostRuntime({
      store: locked,
      capabilities: [capability],
      policy: new DefaultHostPolicy({ knownTools: ["touch"], allowMutations: true }),
    });
    await host.startup();
    const session = await host.openOrResumeSession();

    const result = await host.capabilityBroker.execute({
      sessionId: session.sessionId,
      toolCallId: "tc-touch",
      toolName: "touch",
      args: { value: 1 },
    });

    expect(observedBarrier).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(result.operationId).toBeDefined();
    const operations = await createWorkspaceReadModels(locked.store).getOperations(session.sessionId as string);
    expect(operations).toHaveLength(1);
    expect(operations[0]?.operationId).toBe(result.operationId as string);
    expect(operations[0]?.lifecycleState).toBe("terminal");
  });

  it("resumes an active Host session without a duplicate start or implicit stop", async () => {
    locked = await openStore(dir);
    const host = new HostRuntime({ store: locked, capabilities: [] });
    await host.startup();
    const sessionId = asSessionId(uuidv7());

    const first = await host.openOrResumeSession(sessionId);
    const second = await host.openOrResumeSession(sessionId);

    expect(first.resumed).toBe(false);
    expect(second.resumed).toBe(true);
    const events = await createWorkspaceReadModels(locked.store).getSessionEvents(sessionId as string);
    expect(events.filter((event) => event.type === "runtime.session.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "runtime.session.stopped")).toHaveLength(0);
  });

  it("resolves open_investigation symbolic references in one non-interleaved canonical batch", async () => {
    locked = await openStore(dir);
    const host = new HostRuntime({ store: locked, capabilities: [] });
    await host.startup();
    const session = await host.openOrResumeSession();

    const result = await host.cognition.openInvestigation(
      session.sessionId,
      "Fix the integration defect",
      "The Host boundary is missing",
      { falsifier: "The replacement Agent loses durable state" },
    );

    expect(result.eventIds).toHaveLength(2);
    const events = await createWorkspaceReadModels(locked.store).getReasoningEvents(session.sessionId as string);
    const objective = events.find((event) => event.type === "objective.set");
    const hypothesis = events.find((event) => event.type === "hypothesis.created");
    expect(objective).toBeDefined();
    expect(hypothesis).toBeDefined();
    expect(hypothesis!.sequence).toBe(objective!.sequence + 1);
    expect((hypothesis!.payload as Record<string, unknown>).objectiveId)
      .toBe(`event:${session.sessionId as string}:${objective!.sequence}:objective`);

    const orientation = await host.cognitionGateway.orient(session.sessionId as string);
    expect(orientation.activeObjective?.label).toBe("Fix the integration defect");
    expect(orientation.activeHypotheses.some((node) => node.label === "The Host boundary is missing")).toBe(true);
  });
});
