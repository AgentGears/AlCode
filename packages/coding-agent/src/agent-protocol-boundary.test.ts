import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf-8");
}

describe("S-01B privileged Agent protocol boundary", () => {
  it("keeps raw ProtocolTransport out of normal Agent worker/helpers/cognition production sources", () => {
    const normalConsumers = [
      "packages/coding-agent/src/agent-worker.ts",
      "packages/coding-agent/src/inference-context.ts",
      "extensions/cognition/src/index.ts",
      "extensions/cognition/src/host-client.ts",
      "extensions/cognition/src/proxy-tools.ts",
      "extensions/cognition/src/event-adapter.ts",
    ];
    for (const path of normalConsumers) {
      const text = source(path);
      expect(text, path).not.toContain("ProtocolTransport");
      expect(text, path).not.toContain("createProcessAgentTransport");
    }

    const bridge = source("packages/coding-agent/src/agent-protocol-bridge.ts");
    expect(bridge).toContain("ProtocolTransport");
    expect(bridge).toContain("createProcessAgentTransport");
  });

  it("generation lifecycle owns bridge close while StaticExtensionHost remains the behavior path", () => {
    const worker = source("packages/coding-agent/src/agent-worker.ts");
    const profile = source("packages/coding-agent/src/agent-runtime-profile.ts");
    expect(worker).toContain("AgentRuntime.create({");
    expect(worker).toContain("modules: createDefaultAgentRuntimeModules({ protocol })");
    expect(profile).toContain("scope.register(() => protocol.close())");
    expect(worker).toContain("new StaticExtensionHost()");
  });
});
