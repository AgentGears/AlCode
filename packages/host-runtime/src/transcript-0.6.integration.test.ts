import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DURABLE_TRANSCRIPT_CAPABILITY,
  createInMemoryTransportPair,
  type AgentToHostMessage,
  type HostToAgentMessage,
} from "@alcode/agent-protocol";
import { asWorkspaceId, uuidv7 } from "@alcode/events";
import {
  createWorkspaceReadModels,
  openLockedWorkspaceStore,
  type LockedWorkspaceStore,
} from "@alcode/storage";
import {
  ContextIncompleteError,
  HostRuntime,
  type AgentConnection,
} from "./index.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

function paths(dir: string) {
  return { databasePath: join(dir, "workspace.sqlite"), lockPath: join(dir, "workspace.lock") };
}

function connection(
  transport: AgentConnection["transport"],
  capabilities: readonly string[] = [DURABLE_TRANSCRIPT_CAPABILITY],
): AgentConnection {
  return {
    generationId: "g1",
    capabilities,
    transport,
    async waitForExit() { return { code: null, signal: null }; },
    terminate() {},
  };
}

describeLocked("Phase 0.6 canonical transcript", () => {
  let dir: string;
  let locked: LockedWorkspaceStore | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-transcript-06-"));
    locked = null;
  });

  afterEach(() => {
    try { locked?.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("validates transcript semantics before canonical append", async () => {
    const workspaceId = asWorkspaceId(uuidv7());
    locked = await openLockedWorkspaceStore({ ...paths(dir), workspaceId, repositoryId: uuidv7() });
    const host = new HostRuntime({ store: locked, capabilities: [] });
    await host.startup();
    const session = await host.openOrResumeSession();
    const before = await locked.store.headSequence();

    await expect(host.transcriptAdmission.admitAssistant("g1", session.sessionId, {
      type: "assistant.message",
      requestId: "bad",
      sessionId: session.sessionId as string,
      text: "foo",
      content: [{ type: "text", text: "bar" }],
      stopReason: "stop",
      timestamp: 100,
    })).rejects.toThrow(/text\/content mismatch/);

    expect(await locked.store.headSequence()).toBe(before);
  });

  it("deduplicates the same transcript delivery and preserves exact tool pairing", async () => {
    const workspaceId = asWorkspaceId(uuidv7());
    locked = await openLockedWorkspaceStore({ ...paths(dir), workspaceId, repositoryId: uuidv7() });
    const host = new HostRuntime({ store: locked, capabilities: [] });
    await host.startup();
    const session = await host.openOrResumeSession();
    await host.admitInput(session.sessionId, "inspect");

    const assistant = {
      type: "assistant.message" as const,
      requestId: "assistant-r1",
      sessionId: session.sessionId as string,
      text: "checking",
      content: [
        { type: "text" as const, text: "checking" },
        { type: "toolCall" as const, id: "T1", name: "read", arguments: { path: "README.md" } },
      ],
      stopReason: "tool_use" as const,
      timestamp: 200,
    };
    const first = await host.transcriptAdmission.admitAssistant("g1", session.sessionId, assistant);
    const duplicate = await host.transcriptAdmission.admitAssistant("g1", session.sessionId, assistant);
    expect(duplicate.eventId).toBe(first.eventId);
    expect(duplicate.sequence).toBe(first.sequence);

    let snapshot = await createWorkspaceReadModels(locked.store).getTranscriptSnapshot(session.sessionId as string);
    expect(snapshot.status).toBe("incomplete");
    expect(snapshot.pendingToolCallIds).toEqual(["T1"]);
    expect(snapshot.fidelity).toBe("exact");

    const result = await host.transcriptAdmission.admitToolResult("g1", session.sessionId, {
      type: "tool.result",
      requestId: "result-r1",
      sessionId: session.sessionId as string,
      toolCallId: "T1",
      toolName: "read",
      content: [{ type: "text", text: "contents" }],
      isError: false,
      timestamp: 300,
    });
    expect(result.operationId).toBeUndefined();

    snapshot = await createWorkspaceReadModels(locked.store).getTranscriptSnapshot(session.sessionId as string);
    expect(snapshot.status).toBe("complete");
    expect(snapshot.pendingToolCallIds).toEqual([]);
    expect(snapshot.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(snapshot.messages[1]).toMatchObject({
      role: "assistant",
      content: expect.arrayContaining([{ type: "toolCall", id: "T1", name: "read", arguments: { path: "README.md" } }]),
    });
    expect(snapshot.messages[2]).toMatchObject({ role: "toolResult", toolCallId: "T1", toolName: "read" });

    const events = await createWorkspaceReadModels(locked.store).getSessionEvents(session.sessionId as string);
    expect(events.filter((event) => event.type === "assistant.message.appended")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool.result.appended")).toHaveLength(1);
  });

  it("reconstructs an orphan exactly but blocks continuation without synthetic results", async () => {
    const workspaceId = asWorkspaceId(uuidv7());
    locked = await openLockedWorkspaceStore({ ...paths(dir), workspaceId, repositoryId: uuidv7() });
    const host = new HostRuntime({ store: locked, capabilities: [] });
    await host.startup();
    const session = await host.openOrResumeSession();
    await host.admitInput(session.sessionId, "inspect");
    await host.transcriptAdmission.admitAssistant("g1", session.sessionId, {
      type: "assistant.message",
      requestId: "orphan-r1",
      sessionId: session.sessionId as string,
      text: "",
      content: [{ type: "toolCall", id: "T-orphan", name: "read", arguments: { path: "x" } }],
      stopReason: "tool_use",
      timestamp: 200,
    });

    const snapshot = await createWorkspaceReadModels(locked.store).getTranscriptSnapshot(session.sessionId as string);
    expect(snapshot.status).toBe("incomplete");
    expect(snapshot.pendingToolCallIds).toEqual(["T-orphan"]);
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages.some((message) => message.role === "toolResult")).toBe(false);

    const pair = createInMemoryTransportPair<HostToAgentMessage, AgentToHostMessage>();
    const before = await locked.store.headSequence();
    await expect(host.sendInput(pair.a, session.sessionId, "continue"))
      .rejects.toBeInstanceOf(ContextIncompleteError);
    expect(await locked.store.headSequence()).toBe(before);
  });

  it("requires durable transcript capability for supervised-style attachments and sends verbatim context when negotiated", async () => {
    const workspaceId = asWorkspaceId(uuidv7());
    locked = await openLockedWorkspaceStore({ ...paths(dir), workspaceId, repositoryId: uuidv7() });
    const host = new HostRuntime({ store: locked, capabilities: [] });
    await host.startup();
    const session = await host.openOrResumeSession();
    await host.admitInput(session.sessionId, "hello");

    const rejectedPair = createInMemoryTransportPair<HostToAgentMessage, AgentToHostMessage>();
    await expect(host.attachAgent(connection(rejectedPair.a, []), session, "system"))
      .rejects.toThrow(/durable_transcript_v1/);

    const pair = createInMemoryTransportPair<HostToAgentMessage, AgentToHostMessage>();
    const received: HostToAgentMessage[] = [];
    pair.b.onMessage((message) => { received.push(message); });
    await host.attachAgent(connection(pair.a), session, "system");
    const context = received.find((message) => message.type === "context.provide");
    expect(context?.type).toBe("context.provide");
    if (context?.type !== "context.provide") throw new Error("missing context.provide");
    expect(context.verbatim).toMatchObject({
      compilerVersion: "verbatim-v1",
      status: "complete",
      fidelity: "exact",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
  });

  it("reconstructs the same message prefix after store close/reopen with no Agent state", async () => {
    const workspaceId = asWorkspaceId(uuidv7());
    const repositoryId = uuidv7();
    locked = await openLockedWorkspaceStore({ ...paths(dir), workspaceId, repositoryId });
    const host1 = new HostRuntime({ store: locked, capabilities: [] });
    await host1.startup();
    const session = await host1.openOrResumeSession();
    await host1.admitInput(session.sessionId, "hello");
    await host1.transcriptAdmission.admitAssistant("g1", session.sessionId, {
      type: "assistant.message",
      requestId: "a1",
      sessionId: session.sessionId as string,
      text: "world",
      content: [{ type: "text", text: "world" }],
      stopReason: "stop",
      timestamp: 200,
    });
    const before = await createWorkspaceReadModels(locked.store).getTranscriptSnapshot(session.sessionId as string);

    locked.close();
    locked = null;
    locked = await openLockedWorkspaceStore({ ...paths(dir), workspaceId, repositoryId });
    const host2 = new HostRuntime({ store: locked, capabilities: [] });
    await host2.startup();
    const resumed = await host2.openOrResumeSession(session.sessionId);
    expect(resumed.resumed).toBe(true);
    const after = await createWorkspaceReadModels(locked.store).getTranscriptSnapshot(session.sessionId as string);

    expect(after.messages).toEqual(before.messages);
    expect(after.status).toBe(before.status);
    expect(after.fidelity).toBe(before.fidelity);
    expect(after.pendingToolCallIds).toEqual(before.pendingToolCallIds);
  });
});
