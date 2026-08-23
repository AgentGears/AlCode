import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DURABLE_TRANSCRIPT_CAPABILITY,
  type HostToAgentMessage,
} from "@alcode/agent-protocol";
import { asWorkspaceId, uuidv7 } from "@alcode/events";
import { openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import { type AgentConnection } from "./agent-supervisor.ts";
import { HostRuntime } from "./host.ts";
import { INTERRUPTED_TOOL_RESULT_TEXT } from "./transcript-admission.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;
const stores: LockedWorkspaceStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch {} }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describeLocked("Host replacement context preparation", () => {
  it("closes a dead-generation transcript gap before generation B receives context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-host-replacement-context-"));
    dirs.push(dir);
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: asWorkspaceId(uuidv7()),
      repositoryId: uuidv7(),
    });
    stores.push(locked);
    const host = new HostRuntime({ store: locked, capabilities: [] });
    await host.startup();
    const session = await host.openOrResumeSession();
    const timestamp = Date.now();
    await host.admitInput(session.sessionId, "run a tool");
    await host.transcriptAdmission.admitAssistant("dead-generation", session.sessionId, {
      type: "assistant.message",
      requestId: uuidv7(),
      sessionId: String(session.sessionId),
      text: "",
      content: [{ type: "toolCall", id: "dangling-call", name: "bash", arguments: { command: "echo hi" } }],
      stopReason: "tool_use",
      timestamp,
    });

    const sent: HostToAgentMessage[] = [];
    const connection: AgentConnection = {
      generationId: uuidv7(),
      capabilities: [DURABLE_TRANSCRIPT_CAPABILITY],
      transport: {
        send: async (message) => { sent.push(structuredClone(message)); },
        onMessage: () => () => undefined,
        close: async () => undefined,
      },
      waitForExit: () => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => undefined),
      terminate: () => undefined,
    };

    await host.attachAgent(connection, session, "replacement-system", "agent_replaced");

    const context = sent.find((message) => message.type === "context.provide");
    expect(context?.type).toBe("context.provide");
    if (context?.type !== "context.provide") throw new Error("replacement context missing");
    expect(context.verbatim?.status).toBe("complete");
    expect(context.verbatim?.pendingToolCallIds).toEqual([]);
    const last = context.verbatim?.messages.at(-1);
    expect(last?.role).toBe("toolResult");
    if (last?.role !== "toolResult") throw new Error("replacement recovery tool result missing");
    expect(last.toolCallId).toBe("dangling-call");
    expect(last.isError).toBe(true);
    expect(last.content).toEqual([{ type: "text", text: INTERRUPTED_TOOL_RESULT_TEXT }]);
  });
});
