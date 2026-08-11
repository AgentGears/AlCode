import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asWorkspaceId, uuidv7 } from "@alcode/events";
import {
  createInMemoryTransportPair,
  type AgentToHostMessage,
  type CapabilityResult,
  type HostToAgentMessage,
} from "@alcode/agent-protocol";
import { createWorkspaceReadModels, openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import { HostRuntime, type AgentConnection, type HostCapability } from "./index.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

async function openStore(dir: string): Promise<LockedWorkspaceStore> {
  return openLockedWorkspaceStore({
    databasePath: join(dir, "workspace.sqlite"),
    lockPath: join(dir, "workspace.lock"),
    workspaceId: asWorkspaceId(uuidv7()),
    repositoryId: uuidv7(),
  });
}

describeLocked("Phase 0.5 protocol duplicate delivery", () => {
  let dir: string;
  let locked: LockedWorkspaceStore | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-protocol-dedup-"));
    locked = null;
  });

  afterEach(() => {
    try { locked?.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("replays one Host capability result for a duplicate requestId without duplicate execution", async () => {
    locked = await openStore(dir);
    let executions = 0;
    const read: HostCapability = {
      name: "read-once",
      isReadOnly: true,
      async execute() {
        executions++;
        return { result: { value: 42 }, outcome: "succeeded", stdout: "42" };
      },
    };
    const host = new HostRuntime({ store: locked, capabilities: [read] });
    await host.startup();
    const session = await host.openOrResumeSession();

    const pair = createInMemoryTransportPair<AgentToHostMessage, HostToAgentMessage>();
    const connection: AgentConnection = {
      generationId: "generation-dedup",
      transport: pair.b,
      async waitForExit() { return { code: 0, signal: null }; },
      terminate() {},
    };
    const responses: CapabilityResult[] = [];
    pair.a.onMessage((message) => {
      if (message.type === "capability.result") responses.push(message);
    });
    await host.attachAgent(connection, session, "dedup proof");

    const request: AgentToHostMessage = {
      type: "capability.request",
      requestId: "same-request-id",
      sessionId: session.sessionId as string,
      toolCallId: "same-tool-call",
      toolName: "read-once",
      args: { key: "x" },
    };
    await pair.a.send(request);
    await pair.a.send(request);

    expect(executions).toBe(1);
    expect(responses).toHaveLength(2);
    expect(responses[0]?.operationId).toBeDefined();
    expect(responses[1]?.operationId).toBe(responses[0]?.operationId);
    const operations = await createWorkspaceReadModels(locked.store).getOperations(session.sessionId as string);
    expect(operations).toHaveLength(1);
  });
});
