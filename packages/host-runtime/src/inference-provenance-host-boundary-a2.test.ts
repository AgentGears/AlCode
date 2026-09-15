import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DURABLE_TRANSCRIPT_CAPABILITY,
  INFERENCE_PROVENANCE_CAPABILITY,
  createInMemoryTransportPair,
  type AgentToHostMessage,
  type HostToAgentMessage,
} from "@alcode/agent-protocol";
import { asWorkspaceId, uuidv7 } from "@alcode/events";
import { openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import type { AgentConnection } from "./agent-supervisor.ts";
import { HostRuntime } from "./host.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

describeLocked("A2 Host inference provenance boundary", () => {
  let dir: string;
  let locked: LockedWorkspaceStore | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-a2-host-boundary-"));
    locked = null;
  });

  afterEach(() => {
    try { locked?.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a forged inference epoch before CapabilityBroker can admit an Operation", async () => {
    locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: asWorkspaceId(uuidv7()),
      repositoryId: uuidv7(),
    });
    let executions = 0;
    const host = new HostRuntime({
      store: locked,
      capabilities: [{
        name: "inspect",
        description: "A2 boundary fixture",
        workspaceAccessClass: "read_only",
        async execute() {
          executions += 1;
          return { result: { ok: true } };
        },
      }],
    });
    await host.startup();
    const session = await host.openOrResumeSession();
    const pair = createInMemoryTransportPair<HostToAgentMessage, AgentToHostMessage>();
    const connection: AgentConnection = {
      generationId: "generation-current",
      capabilities: [DURABLE_TRANSCRIPT_CAPABILITY, INFERENCE_PROVENANCE_CAPABILITY],
      transport: pair.a,
      waitForExit: () => new Promise(() => undefined),
      terminate: () => undefined,
    };
    const received: HostToAgentMessage[] = [];
    pair.b.onMessage((message) => { received.push(structuredClone(message)); });
    const attached = await host.attachAgent(connection, session, "A2 forged epoch boundary");

    await pair.b.send({
      type: "capability.request",
      requestId: "forged-epoch-request",
      sessionId: String(session.sessionId),
      toolCallId: "forged-tool-call",
      toolName: "inspect",
      args: {},
      inferenceEpochId: uuidv7(),
    });

    expect(received.find((message) => message.type === "capability.result"
      && message.requestId === "forged-epoch-request")).toMatchObject({
      type: "capability.result",
      outcome: "stale",
      errorCode: "inference_provenance_stale",
    });
    expect(executions).toBe(0);

    const requested: unknown[] = [];
    for await (const event of locked.store.replay()) {
      if (event.type === "operation.requested") requested.push(event.payload);
    }
    expect(requested).toEqual([]);

    attached.detach();
    await pair.b.close();
  });
});
