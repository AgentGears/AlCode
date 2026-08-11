import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asWorkspaceId, uuidv7 } from "@alcode/events";
import {
  AgentSupervisor,
  DefaultHostPolicy,
  HostRuntime,
  type AgentConnection,
  type HostCapability,
} from "@alcode/host-runtime";
import {
  createWorkspaceReadModels,
  openLockedWorkspaceStore,
  type LockedWorkspaceStore,
} from "@alcode/storage";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition not reached within ${timeoutMs}ms`);
}

function asLegacyConnection(connection: AgentConnection): AgentConnection {
  const { capabilities: _capabilities, ...legacy } = connection;
  return legacy;
}

const lessonFields = {
  lesson_name: "agent_replacement",
  outcome: "success",
  stage_anchor: "terminal",
  retrieval_anchor: "replaceable agent host continuity",
  not_applicable_when: "single ephemeral response",
  domain: "integration-test",
  verification_boundary: "kill Agent and resume",
  content: "Agent replacement must preserve Host-owned durable cognition.",
};

describeLocked("Phase 0.5 replaceable Agent", () => {
  let dir: string;
  let locked: LockedWorkspaceStore | null;
  let supervisorA: AgentSupervisor | null;
  let supervisorB: AgentSupervisor | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-agent-replace-"));
    locked = null;
    supervisorA = null;
    supervisorB = null;
  });

  afterEach(async () => {
    await supervisorA?.shutdown().catch(() => undefined);
    await supervisorB?.shutdown().catch(() => undefined);
    try { locked?.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("kill Agent A → Host finishes operation → Agent B resumes, orients, and acts with durable state intact", async () => {
    const workspaceId = asWorkspaceId(uuidv7());
    locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId,
      repositoryId: uuidv7(),
    });

    let slowExecutions = 0;
    let afterExecutions = 0;
    const slowStarted = deferred();
    const releaseSlow = deferred();

    const slow: HostCapability = {
      name: "slow",
      isReadOnly: false,
      async execute() {
        slowExecutions++;
        slowStarted.resolve();
        await releaseSlow.promise;
        return { result: { completed: true }, outcome: "succeeded", stdout: "slow-complete" };
      },
    };
    const after: HostCapability = {
      name: "after",
      isReadOnly: true,
      async execute() {
        afterExecutions++;
        return { result: { continued: true }, outcome: "succeeded", stdout: "continued" };
      },
    };

    const host = new HostRuntime({
      store: locked,
      capabilities: [slow, after],
      policy: new DefaultHostPolicy({ knownTools: ["slow", "after"], allowMutations: true }),
    });
    await host.startup();
    const session = await host.openOrResumeSession();
    await host.admitInput(session.sessionId, "Seed durable cognition before replacement");
    await host.cognition.openInvestigation(
      session.sessionId,
      "Preserve durable Host state",
      "Replacing the Agent does not replace the Host session",
      { falsifier: "The replacement loses the active hypothesis" },
    );
    const remembered = await host.cognition.invoke(session.sessionId, "remember", {
      type: "lesson",
      name: "agent_replacement",
      confidence: 0.9,
      fields: lessonFields,
    }) as { memoryId: string };

    const workerEntrypoint = fileURLToPath(new URL("./agent-worker.ts", import.meta.url));
    supervisorA = new AgentSupervisor({
      entrypoint: workerEntrypoint,
      execArgv: ["--import", "tsx"],
      env: {
        ALCODE_AGENT_SCRIPT: JSON.stringify([
          {
            toolCalls: [{ id: "slow-model-call", name: "slow", arguments: { value: 1 } }],
            stopReason: "tool_use",
          },
          { text: "Agent A should never reach this turn.", stopReason: "stop" },
        ]),
      },
    });
    const connectionA = await supervisorA.start();
    const generationA = connectionA.generationId;
    // This test is the frozen 0.5 proof, so deliberately exercise the pre-0.6
    // protocol mode. Phase 0.6 has separate tests for durable transcript mode.
    await host.attachAgent(asLegacyConnection(connectionA), session, "Phase 0.5 replacement proof");
    await host.sendInput(connectionA.transport, session.sessionId, "Start the slow Host operation");

    await slowStarted.promise;
    expect(slowExecutions).toBe(1);
    const operationsBeforeKill = await createWorkspaceReadModels(locked.store).getOperations(session.sessionId as string);
    expect(operationsBeforeKill).toHaveLength(1);
    expect(operationsBeforeKill[0]?.lifecycleState).toBe("started");
    const durableOperationId = operationsBeforeKill[0]!.operationId;

    connectionA.terminate("SIGKILL");
    await connectionA.waitForExit();
    const stateAfterAgentDeath = await host.sessions.getState(session.sessionId);
    expect(stateAfterAgentDeath.started).toBe(true);
    expect(stateAfterAgentDeath.stopped).toBe(false);

    releaseSlow.resolve();
    await waitUntil(async () => {
      const operations = await createWorkspaceReadModels(locked!.store).getOperations(session.sessionId as string);
      return operations.some((operation) => operation.operationId === durableOperationId && operation.lifecycleState === "terminal");
    });
    expect(slowExecutions).toBe(1);

    const snapshotBeforeReplacement = await host.cognitionGateway.snapshot(session.sessionId as string);
    expect(snapshotBeforeReplacement.memories.some((memory) => memory.memory_id === remembered.memoryId)).toBe(true);
    const orientationBeforeReplacement = host.cognitionGateway.coordinator.orient(snapshotBeforeReplacement);
    expect(orientationBeforeReplacement.activeHypotheses.some(
      (node) => node.label === "Replacing the Agent does not replace the Host session",
    )).toBe(true);

    supervisorB = new AgentSupervisor({
      entrypoint: workerEntrypoint,
      execArgv: ["--import", "tsx"],
      env: {
        ALCODE_AGENT_SCRIPT: JSON.stringify([
          {
            toolCalls: [{ id: "orient-call", name: "orient", arguments: {} }],
            stopReason: "tool_use",
          },
          {
            toolCalls: [{ id: "after-call", name: "after", arguments: { value: 2 } }],
            stopReason: "tool_use",
          },
          { text: "Replacement Agent continued successfully.", stopReason: "stop" },
        ]),
      },
    });
    const connectionB = await supervisorB.start();
    expect(connectionB.generationId).not.toBe(generationA);
    const requestedTools: string[] = [];
    const removeObserver = connectionB.transport.onMessage((message) => {
      if (message.type === "capability.request") requestedTools.push(message.toolName);
    });
    const resumed = await host.openOrResumeSession(session.sessionId);
    expect(resumed.resumed).toBe(true);
    await host.attachAgent(asLegacyConnection(connectionB), resumed, "Phase 0.5 replacement proof", "agent_replaced");
    await host.sendInput(connectionB.transport, session.sessionId, "Resume, orient, then continue");

    await waitUntil(() => afterExecutions === 1);
    await waitUntil(async () => (await host.sessions.getState(session.sessionId)).stopped);
    removeObserver();

    expect(requestedTools.slice(0, 2)).toEqual(["orient", "after"]);
    expect(slowExecutions).toBe(1);
    expect(afterExecutions).toBe(1);

    const finalOperations = await createWorkspaceReadModels(locked.store).getOperations(session.sessionId as string);
    const original = finalOperations.find((operation) => operation.operationId === durableOperationId);
    expect(original?.lifecycleState).toBe("terminal");
    expect(original?.executionOutcome).toBe("succeeded");
    expect(finalOperations).toHaveLength(2);

    const sessionEvents = await createWorkspaceReadModels(locked.store).getSessionEvents(session.sessionId as string);
    const stopEvents = sessionEvents.filter((event) => event.type === "runtime.session.stopped");
    expect(stopEvents).toHaveLength(1);
    const slowCompleted = sessionEvents.find((event) =>
      event.type === "operation.completed" && event.operationId === durableOperationId,
    );
    expect(slowCompleted).toBeDefined();
  });
});
