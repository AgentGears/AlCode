import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, client, methods } from "@agentclientprotocol/sdk";
import { createAlcodeAcpApp, type AcpHostFacade } from "./index.ts";

describe("stable ACP v1 adapter", () => {
  it("maps initialize/new/prompt/permission/cancel/close/resume through the Host facade", async () => {
    const calls: string[] = [];
    const updates: unknown[] = [];
    const facade: AcpHostFacade = {
      async newSession({ cwd }) { calls.push(`new:${cwd}`); return { sessionId: "S1" }; },
      async resumeSession({ sessionId, cwd }) { calls.push(`resume:${sessionId}:${cwd}`); },
      async prompt({ sessionId, text }, context) {
        calls.push(`prompt:${sessionId}:${text}`);
        const permission = await context.requestPermission({ sessionId, toolCallId: "T1", title: "Write", reason: "test" });
        calls.push(`permission:${permission}`);
        await context.emitAssistantText("committed reply");
        return { stopReason: "end_turn" };
      },
      async cancelSession(sessionId) { calls.push(`cancel:${sessionId}`); },
      async closeSession(sessionId) { calls.push(`close:${sessionId}`); },
    };
    const app = createAlcodeAcpApp(facade);
    const clientApp = client({ name: "phase-0.9-test" })
      .onRequest(methods.client.session.requestPermission, () => ({ outcome: { outcome: "selected", optionId: "allow_once" } }))
      .onNotification(methods.client.session.update, (ctx) => { updates.push(ctx.params.update); });

    await clientApp.connectWith(app, async (ctx) => {
      const initialized = await ctx.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
      expect(initialized.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(initialized.agentCapabilities.sessionCapabilities).toMatchObject({ resume: {}, close: {} });
      const created = await ctx.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
      expect(created.sessionId).toBe("S1");
      const prompted = await ctx.request(methods.agent.session.prompt, { sessionId: "S1", prompt: [{ type: "text", text: "hello" }] });
      expect(prompted.stopReason).toBe("end_turn");
      await ctx.notify(methods.agent.session.cancel, { sessionId: "S1" });
      await ctx.request(methods.agent.session.close, { sessionId: "S1" });
      await ctx.request(methods.agent.session.resume, { sessionId: "S1", cwd: process.cwd(), mcpServers: [] });
    });

    expect(calls).toContain("prompt:S1:hello");
    expect(calls).toContain("permission:allow_once");
    expect(calls).toContain("cancel:S1");
    expect(calls).toContain("close:S1");
    expect(calls.some((value) => value.startsWith("resume:S1:"))).toBe(true);
    expect(updates).toContainEqual({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "committed reply" } });
  });

  it("rejects client-supplied MCP servers before creating a session", async () => {
    let created = 0;
    const facade: AcpHostFacade = {
      async newSession() { created++; return { sessionId: "S" }; },
      async resumeSession() {}, async prompt() { return { stopReason: "end_turn" }; }, async cancelSession() {}, async closeSession() {},
    };
    const app = createAlcodeAcpApp(facade);
    const clientApp = client({ name: "phase-0.9-test" });
    await expect(clientApp.connectWith(app, async (ctx) => ctx.request(methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [{ type: "http", name: "foreign", url: "https://example.com/mcp" }] as never,
    }))).rejects.toThrow(/unsupported_mcp_servers/);
    expect(created).toBe(0);
  });
});
