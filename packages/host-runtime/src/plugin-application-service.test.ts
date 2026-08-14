import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APPLICATION_PROTOCOL_VERSION, type ApplicationServicePort, type ApplicationSnapshot, type PluginCommand } from "@alcode/application-protocol";
import { AGENT_PLUGINS_PLUGIN_SCHEMA } from "@alcode/plugins";
import { HostPluginApplicationService } from "./plugin-application-service.ts";
import { HostPluginService } from "./plugin-service.ts";

const roots: string[] = [];
async function tempRoot(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), "alcode-plugin-app-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function baseSnapshot(sessionId: string): ApplicationSnapshot {
  return { protocolVersion: APPLICATION_PROTOCOL_VERSION, sessionId, cursor: 0, session: { sessionId, status: "active" }, transcript: [], executions: [], operations: [], queue: [], pendingInteractions: [] };
}

describe("Host plugin Application Protocol projection", () => {
  it("executes Host plugin commands and projects authoritative plugin state", async () => {
    const alcodeHome = await tempRoot();
    const source = await tempRoot();
    await writeFile(path.join(source, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGINS_PLUGIN_SCHEMA, name: "projected" }));
    const plugins = new HostPluginService({ alcodeHome });
    await plugins.initialize();
    const base: ApplicationServicePort = {
      async execute(command) { return { protocolVersion: APPLICATION_PROTOCOL_VERSION, commandId: command.commandId, sessionId: command.sessionId, decision: "accepted", cursor: 0 }; },
      async getSnapshot(sessionId) { return baseSnapshot(sessionId); },
      async recover(sessionId) { return { mode: "snapshot", snapshot: baseSnapshot(sessionId), reason: "initial" }; },
      subscribe() { return () => {}; },
    };
    const service = new HostPluginApplicationService(base, plugins, "W");
    const command: PluginCommand = { protocolVersion: APPLICATION_PROTOCOL_VERSION, type: "plugin.register", commandId: "C1", clientId: "client", sessionId: "S", issuedAt: new Date().toISOString(), sourceRoot: source, scope: "workspace" };
    expect((await service.executePlugin(command)).decision).toBe("accepted");
    const snapshot = await service.getSnapshot("S");
    expect(snapshot.plugins).toHaveLength(1);
    expect(snapshot.plugins?.[0]).toMatchObject({ name: "projected", scope: "workspace", status: "registered" });
    const duplicate = await service.executePlugin(command);
    expect(duplicate.decision).toBe("duplicate");
  });
});
