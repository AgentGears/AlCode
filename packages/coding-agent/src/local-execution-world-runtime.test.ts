import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asWorkspaceId, uuidv7 } from "@alcode/events";
import {
  DefaultHostPolicy,
  HostRuntime,
} from "@alcode/host-runtime";
import { ExecutionWorldServiceV1 } from "@alcode/host-runtime/execution-world";
import { openLockedWorkspaceStore } from "@alcode/storage";
import { createLocalWorkspace } from "./capabilities/local-workspace.ts";
import { createExecutionWorldHostCapabilities } from "./host-capabilities.ts";
import {
  activateLocalExecutionWorldV1,
  retireLocalExecutionWorldV1,
} from "./local-execution-world-runtime.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

async function replayAll(host: HostRuntime) {
  const events = [];
  for await (const event of host.capabilityBroker["store"].replay()) events.push(event);
  return events;
}

describeLocked("A5 local execution-world production bootstrap", () => {
  it("routes an ordinary coding capability through the exact active generation and records provenance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-a5-local-runtime-"));
    const descriptorRoot = join(dir, "descriptor");
    const worldRoot = join(dir, "world");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(descriptorRoot, { recursive: true });
    mkdirSync(worldRoot, { recursive: true });
    writeFileSync(join(descriptorRoot, "value.txt"), "descriptor\n");
    writeFileSync(join(worldRoot, "value.txt"), "world\n");

    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: asWorkspaceId(uuidv7()),
      repositoryId: "a5-local-runtime",
    });
    try {
      const descriptorWorkspace = createLocalWorkspace({
        workspaceId: String(locked.store.workspaceId),
        repositoryId: "a5-local-runtime",
        root: descriptorRoot,
      });
      const capabilities = createExecutionWorldHostCapabilities(descriptorWorkspace);
      const host = new HostRuntime({
        store: locked,
        capabilities,
        policy: new DefaultHostPolicy({
          knownTools: capabilities.map((capability) => capability.name),
          allowMutations: true,
        }),
      });
      await host.startup();
      const session = await host.openOrResumeSession();
      const worlds = new ExecutionWorldServiceV1(locked.store, host.admission);
      const active = await activateLocalExecutionWorldV1({
        worlds,
        activationRequestId: `test-${uuidv7()}`,
        workspaceId: String(locked.store.workspaceId),
        sessionId: String(session.sessionId),
        repositoryId: "a5-local-runtime",
        root: worldRoot,
      });
      host.capabilityBroker.setExecutionWorldBindingAuthority(active.bindings);

      const result = await host.capabilityBroker.execute({
        sessionId: session.sessionId,
        toolCallId: "tc-a5-local-runtime",
        toolName: "read",
        args: { path: "value.txt" },
      });
      expect(result.outcome).toBe("succeeded");
      expect(JSON.stringify(result.result)).toContain("world");
      expect(JSON.stringify(result.result)).not.toContain("descriptor");

      const events = [];
      for await (const event of locked.store.replay()) events.push(event);
      const requested = events.find((event) => event.type === "operation.requested");
      const executionWorld = (requested?.payload as { executionWorld?: { executionWorldGenerationId?: string } } | undefined)?.executionWorld;
      expect(executionWorld?.executionWorldGenerationId).toBe(active.world.identity.executionWorldGenerationId);

      await retireLocalExecutionWorldV1(active);
      expect((await worlds.requireGeneration(active.world.identity.executionWorldGenerationId)).state).toBe("closed");
    } finally {
      locked.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
