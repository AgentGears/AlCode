import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  HostToAgentMessage,
  ProtocolTransport,
  AgentToHostMessage,
} from "@alcode/agent-protocol";
import { asWorkspaceId, uuidv7 } from "@alcode/events";
import {
  AgentSupervisor,
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition not reached within ${timeoutMs}ms`);
}

function withObservedHostSends(
  connection: AgentConnection,
  observe: (message: HostToAgentMessage) => void | Promise<void>,
): AgentConnection {
  const underlying = connection.transport;
  const transport: ProtocolTransport<HostToAgentMessage, AgentToHostMessage> = {
    async send(message) {
      await observe(message);
      await underlying.send(message);
    },
    onMessage(handler) { return underlying.onMessage(handler); },
    close() { return underlying.close(); },
  };
  return { ...connection, transport };
}

describeLocked("Phase 0.6 Host + Agent verbatim restart", () => {
  let dir: string;
  let locked: LockedWorkspaceStore | null;
  let supervisorA: AgentSupervisor | null;
  let supervisorB: AgentSupervisor | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-verbatim-restart-"));
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

  it("reconstructs a complete canonical prefix after both Host and Agent replacement and continues", async () => {
    const workspaceId = asWorkspaceId(uuidv7());
    const repositoryId = uuidv7();
    const databasePath = join(dir, "workspace.sqlite");
    const lockPath = join(dir, "workspace.lock");
    const workerEntrypoint = fileURLToPath(new URL("./agent-worker.ts", import.meta.url));

    let inspectExecutions = 0;
    const inspect: HostCapability = {
      name: "inspect",
      isReadOnly: true,
      async execute() {
        inspectExecutions++;
        return { result: { contents: "durable-result" }, outcome: "succeeded", stdout: "durable-result" };
      },
    };

    locked = await openLockedWorkspaceStore({ databasePath, lockPath, workspaceId, repositoryId });
    const hostA = new HostRuntime({ store: locked, capabilities: [inspect] });
    await hostA.startup();
    const session = await hostA.openOrResumeSession();

    supervisorA = new AgentSupervisor({
      entrypoint: workerEntrypoint,
      execArgv: ["--import", "tsx"],
      env: {
        ALCODE_AGENT_SCRIPT: JSON.stringify([
          {
            text: "checking",
            toolCalls: [{ id: "T1", name: "inspect", arguments: { path: "README.md" } }],
            stopReason: "tool_use",
          },
          { text: "first turn complete", stopReason: "stop" },
        ]),
      },
    });
    const rawA = await supervisorA.start();
    const holdFinalAck = deferred();
    const finalAckReached = deferred();
    let transcriptAckCount = 0;
    const connectionA = withObservedHostSends(rawA, async (message) => {
      if (message.type !== "transcript.admitted") return;
      transcriptAckCount++;
      if (transcriptAckCount === 3) {
        finalAckReached.resolve();
        await holdFinalAck.promise;
      }
    });

    await hostA.attachAgent(connectionA, session, "Phase 0.6 verbatim restart");
    await hostA.sendInput(connectionA.transport, session.sessionId, "U1");
    await finalAckReached.promise;

    const prefix = await createWorkspaceReadModels(locked.store).getTranscriptSnapshot(session.sessionId as string);
    expect(prefix.status).toBe("complete");
    expect(prefix.fidelity).toBe("exact");
    expect(prefix.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(prefix.messages[1]).toMatchObject({
      role: "assistant",
      content: expect.arrayContaining([{ type: "toolCall", id: "T1", name: "inspect" }]),
    });
    expect(prefix.messages[2]).toMatchObject({ role: "toolResult", toolCallId: "T1", toolName: "inspect" });
    expect(inspectExecutions).toBe(1);

    // Canonical final assistant exists, but the Agent has not received its ACK,
    // so it cannot emit idle or begin any later inference. Kill it at this cut.
    rawA.terminate("SIGKILL");
    await rawA.waitForExit();
    holdFinalAck.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await hostA.sessions.getState(session.sessionId)).stopped).toBe(false);

    // Destroy Host A without stopping the canonical session.
    locked.close();
    locked = null;

    locked = await openLockedWorkspaceStore({ databasePath, lockPath, workspaceId, repositoryId });
    const hostB = new HostRuntime({ store: locked, capabilities: [inspect] });
    await hostB.startup();
    const resumed = await hostB.openOrResumeSession(session.sessionId);
    expect(resumed.resumed).toBe(true);

    supervisorB = new AgentSupervisor({
      entrypoint: workerEntrypoint,
      execArgv: ["--import", "tsx"],
      env: {
        ALCODE_AGENT_SCRIPT: JSON.stringify([
          { text: "continued after full restart", stopReason: "stop" },
        ]),
      },
    });
    const rawB = await supervisorB.start();
    let suppliedContext: Extract<HostToAgentMessage, { type: "context.provide" }> | undefined;
    const connectionB = withObservedHostSends(rawB, (message) => {
      if (message.type === "context.provide") suppliedContext = structuredClone(message);
    });
    await hostB.attachAgent(connectionB, resumed, "Phase 0.6 verbatim restart", "host_reopened");

    expect(suppliedContext?.verbatim?.messages).toEqual(prefix.messages);
    expect(suppliedContext?.verbatim).toMatchObject({
      compilerVersion: "verbatim-v1",
      status: "complete",
      fidelity: "exact",
      pendingToolCallIds: [],
    });

    await hostB.sendInput(connectionB.transport, session.sessionId, "U2");
    await waitUntil(async () => (await hostB.sessions.getState(session.sessionId)).stopped);

    const finalSnapshot = await createWorkspaceReadModels(locked.store).getTranscriptSnapshot(session.sessionId as string);
    expect(finalSnapshot.messages.slice(0, prefix.messages.length)).toEqual(prefix.messages);
    expect(finalSnapshot.messages[prefix.messages.length]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "U2" }],
    });
    expect(finalSnapshot.messages[prefix.messages.length + 1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "continued after full restart" }],
    });
    expect(inspectExecutions).toBe(1);
  });
});
