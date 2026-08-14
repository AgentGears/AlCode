import { describe, expect, it } from "vitest";
import { HostHookManager } from "./hook-manager.ts";
import type { PluginRuntimeActivation } from "./plugin-service.ts";

function activation(hooks: PluginRuntimeActivation["inspection"]["hooks"]): PluginRuntimeActivation {
  return {
    registrationId: "r1",
    dataOwnerId: "d1",
    name: "plugin",
    digest: "D0",
    pluginRoot: "/plugin",
    pluginData: "/data",
    inspection: { root: "/plugin", status: "valid", complete: true, skills: [], mcpServers: {}, hooks, diagnostics: [] },
  };
}

describe("HostHookManager", () => {
  it("does not start process hooks merely because the plugin generation activates", async () => {
    let starts = 0;
    const manager = new HostHookManager({
      processSupervisor: { start() { starts++; throw new Error("not expected"); } } as never,
    });
    await manager.activate(activation([{ id: "observe", event: "session.started", type: "process", command: "node" }]));
    expect(starts).toBe(0);
  });

  it("returns infrastructure failure rather than manufacturing allow for a policy hook", async () => {
    const manager = new HostHookManager({
      processSupervisor: { start() { throw new Error("hook infrastructure down"); } } as never,
      authorizeProcessStart: async () => activation([]),
    });
    await manager.activate(activation([{ id: "guard", event: "capability.before_execute", type: "process", command: "node" }]));
    const result = await manager.beforeCapability({ sessionId: "s1", toolName: "write", isReadOnly: false, args: { path: "x" } });
    expect(result.status).toBe("failed");
  });
});
