import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createInMemoryTransportPair,
  type AgentToHostMessage,
  type HostToAgentMessage,
} from "@alcode/agent-protocol";
import { createWorkspaceContextSnapshot } from "@alcode/context";
import { asWorkspaceId, uuidv7 } from "@alcode/events";
import { AgentSupervisor, HostRuntime } from "@alcode/host-runtime";
import { createWorkspaceReadModels, openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import { createAgentProtocolBridgeForTransport } from "./agent-protocol-bridge.ts";
import { requestInferenceContext } from "./inference-context.ts";
import { GitWorkspaceContextProvider } from "./workspace-context.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition not reached within ${timeoutMs}ms`);
}

describe("Phase 0.7 coding-agent boundary corrections", () => {
  it("cancels a pending Host context refresh instead of leaving the Agent wait unresolved", async () => {
    const { a: agentTransport, b: hostTransport } = createInMemoryTransportPair<AgentToHostMessage, HostToAgentMessage>();
    const protocol = createAgentProtocolBridgeForTransport(agentTransport);
    let requestSeen = false;
    const unsubscribe = hostTransport.onMessage((message) => {
      if (message.type === "context.refresh.request") requestSeen = true;
    });
    const controller = new AbortController();

    try {
      const pending = requestInferenceContext(protocol, "session-1", controller.signal);
      await waitUntil(() => requestSeen, 1_000);

      const reason = new Error("cancelled while Host context was pending");
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
    } finally {
      unsubscribe();
      await protocol.close();
      await hostTransport.close();
    }
  });

  it("fails workspace observation closed when a porcelain rename record is truncated", async () => {
    const provider = new GitWorkspaceContextProvider(
      { workspaceId: "workspace-1", repositoryId: "repository-1", root: "/workspace" },
      {
        runner: {
          async run(args) {
            const command = args.join(" ");
            if (command === "rev-parse --is-inside-work-tree") return "true\n";
            if (command === "rev-parse HEAD") return "abc123\n";
            if (command === "symbolic-ref --short -q HEAD") return "main\n";
            if (command === "status --porcelain=v1 -z --untracked-files=all") return "R  new.ts\0";
            throw new Error(`unexpected git command: ${command}`);
          },
        },
      },
    );

    const observation = await provider.observe();
    expect(observation.status).toBe("failed");
    if (observation.status === "failed") {
      expect(observation.reasonCode).toBe("workspace_observation_failed");
    }
  });
});

describeLocked("Phase 0.7 real Agent context replacement", () => {
  let dir: string;
  let locked: LockedWorkspaceStore | null;
  let supervisorA: AgentSupervisor | null;
  let supervisorB: AgentSupervisor | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-context-replace-07-"));
    locked = null;
    supervisorA = null;
    supervisorB = null;
  });

  afterEach(async () => {
    await supervisorA?.shutdown().catch(() => undefined);
    await supervisorB?.shutdown().catch(() => undefined);
    try { locked?.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  it("replacement Agent obtains a fresh canonical context receipt before its next provider inference", async () => {
    const workspaceId = asWorkspaceId(uuidv7());
    locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId,
      repositoryId: uuidv7(),
    });

    const host = new HostRuntime({
      store: locked,
      capabilities: [],
      context: {
        requestedMode: "graph",
        graphBudget: { maxGraphRenderedChars: 30_000, estimatorVersion: "chars4-v1" },
        workspaceContextProvider: {
          async observe() {
            return {
              status: "observed" as const,
              observedAt: new Date().toISOString(),
              providerVersion: "replacement-fixture-v1",
              snapshot: createWorkspaceContextSnapshot({
                workspaceId: locked!.store.workspaceId,
                repositoryId: "replacement-repo",
                kind: "git",
                headCommit: "abc123",
                branch: "main",
                dirty: false,
                changedPaths: [],
              }),
            };
          },
        },
      },
    });
    await host.startup();
    const session = await host.openOrResumeSession();
    const investigation = await host.cognition.openInvestigation(
      session.sessionId,
      "Preserve selective context across replacement",
      "A new Agent observes the same Host-owned task state",
    );
    const hypothesisId = investigation.nodeIds.find((id) => id.endsWith(":hypothesis"));
    if (!hypothesisId) throw new Error("hypothesis id missing");
    await host.cognition.invoke(session.sessionId, "plan_verification", {
      hypothesisId,
      toolName: "read",
      toolInput: { path: "README.md" },
      description: "Keep completion blocked during replacement proof",
    });

    const workerEntrypoint = fileURLToPath(new URL("./agent-worker.ts", import.meta.url));
    supervisorA = new AgentSupervisor({
      entrypoint: workerEntrypoint,
      execArgv: ["--import", "tsx"],
      env: { ALCODE_AGENT_SCRIPT: JSON.stringify([{ text: "Agent A observed the task.", stopReason: "stop" }]) },
    });
    const connectionA = await supervisorA.start();
    await host.attachAgent(connectionA, session, "Phase 0.7 replacement proof");
    await host.sendInput(connectionA.transport, session.sessionId, "First inference before replacement");

    const readModels = createWorkspaceReadModels(locked.store);
    await waitUntil(async () => {
      const events = await readModels.getSessionEvents(session.sessionId as string);
      return events.some((event) => event.type === "assistant.message.appended" && (event.payload as any).text === "Agent A observed the task.");
    });
    expect((await host.sessions.getState(session.sessionId)).stopped).toBe(false);

    const beforeReplacement = await readModels.getSessionEvents(session.sessionId as string);
    const receiptA = beforeReplacement.find((event) => event.type === "context.projection_compiled");
    const assistantA = beforeReplacement.find((event) => event.type === "assistant.message.appended" && (event.payload as any).text === "Agent A observed the task.");
    expect(receiptA).toBeDefined();
    expect((receiptA!.payload as any).effectiveMode).toBe("graph-v1");
    expect(assistantA!.sequence).toBeGreaterThan(receiptA!.sequence);

    const generationA = connectionA.generationId;
    connectionA.terminate("SIGKILL");
    await connectionA.waitForExit();
    expect((await host.sessions.getState(session.sessionId)).stopped).toBe(false);

    supervisorB = new AgentSupervisor({
      entrypoint: workerEntrypoint,
      execArgv: ["--import", "tsx"],
      env: { ALCODE_AGENT_SCRIPT: JSON.stringify([{ text: "Agent B continued from Host context.", stopReason: "stop" }]) },
    });
    const connectionB = await supervisorB.start();
    expect(connectionB.generationId).not.toBe(generationA);
    const resumed = await host.openOrResumeSession(session.sessionId);
    expect(resumed.resumed).toBe(true);
    await host.attachAgent(connectionB, resumed, "Phase 0.7 replacement proof", "agent_replaced");
    await host.sendInput(connectionB.transport, session.sessionId, "Second inference after replacement");

    await waitUntil(async () => {
      const events = await readModels.getSessionEvents(session.sessionId as string);
      return events.some((event) => event.type === "assistant.message.appended" && (event.payload as any).text === "Agent B continued from Host context.");
    });

    const finalEvents = await readModels.getSessionEvents(session.sessionId as string);
    const receipts = finalEvents.filter((event) => event.type === "context.projection_compiled");
    expect(receipts).toHaveLength(2);
    const receiptB = receipts[1]!;
    expect((receiptB.payload as any).effectiveMode).toBe("graph-v1");
    expect((receiptB.payload as any).source.sourceEventSequence).toBeGreaterThan((receiptA!.payload as any).source.sourceEventSequence);
    expect((receiptB.payload as any).source.sourceEventSequence).toBeGreaterThanOrEqual(assistantA!.sequence);
    const assistantB = finalEvents.find((event) => event.type === "assistant.message.appended" && (event.payload as any).text === "Agent B continued from Host context.");
    expect(assistantB!.sequence).toBeGreaterThan(receiptB.sequence);
    expect((await host.sessions.getState(session.sessionId)).stopped).toBe(false);
  });
});