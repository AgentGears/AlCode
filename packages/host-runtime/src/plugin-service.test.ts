import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_PLUGINS_PLUGIN_SCHEMA } from "@alcode/plugins";
import {
  HostPluginService,
  type HostPluginLifecycle,
  type PluginRuntimeActivation,
} from "./plugin-service.ts";

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "alcode-host-plugin-"));
  roots.push(root);
  return root;
}
async function plugin(root: string, name = "demo"): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGINS_PLUGIN_SCHEMA, name }));
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function recordingLifecycle() {
  const activated: PluginRuntimeActivation[] = [];
  const withdrawn: Array<{ registrationId: string; digest: string; reason: string }> = [];
  const lifecycle: HostPluginLifecycle = {
    async activate(value) { activated.push(structuredClone(value)); },
    async withdraw(registrationId, digest, reason) { withdrawn.push({ registrationId, digest, reason }); },
  };
  return { activated, withdrawn, lifecycle };
}

describe("HostPluginService exact-generation trust", () => {
  it("registers without execution, enables an immutable generation, withdraws changed source, and preserves data identity across update", async () => {
    const alcodeHome = await tempRoot();
    const source = await tempRoot();
    await plugin(source);
    const events = recordingLifecycle();
    const service = new HostPluginService({ alcodeHome, lifecycle: events.lifecycle });
    await service.initialize();

    const registration = await service.registerLocal({ sourceRoot: source, scope: "user" });
    expect(events.activated).toHaveLength(0);
    const d0 = await service.enable(registration.registrationId);
    expect(d0.status).toBe("enabled");
    expect(d0.activeDigest).toBeTruthy();
    expect(events.activated).toHaveLength(1);
    const trusted = await service.authorizeProcessStart(registration.registrationId, d0.activeDigest!);
    expect(trusted.pluginRoot).toContain(path.join("plugins", "generations", d0.activeDigest!));

    await writeFile(path.join(source, "new.txt"), "D1");
    await expect(service.authorizeProcessStart(registration.registrationId, d0.activeDigest!)).rejects.toThrow(/changed/);
    expect(events.withdrawn.at(-1)?.reason).toBe("changed");
    expect(service.get(registration.registrationId)?.status).toBe("changed");

    const d1 = await service.enable(registration.registrationId);
    expect(d1.activeDigest).not.toBe(d0.activeDigest);
    expect(d1.dataOwnerId).toBe(d0.dataOwnerId);
  });

  it("retains PLUGIN_DATA ownership on unregister but never assigns it to an unrelated same-name registration", async () => {
    const alcodeHome = await tempRoot();
    const firstRoot = await tempRoot();
    const secondRoot = await tempRoot();
    await plugin(firstRoot, "same-name");
    await plugin(secondRoot, "same-name");
    const service = new HostPluginService({ alcodeHome });
    await service.initialize();
    const first = await service.registerLocal({ sourceRoot: firstRoot, scope: "user" });
    await service.enable(first.registrationId);
    await service.unregister(first.registrationId);
    const second = await service.registerLocal({ sourceRoot: secondRoot, scope: "user" });
    expect(second.dataOwnerId).not.toBe(first.dataOwnerId);
  });

  it("allows the same workspace-scoped name in separate workspaces and rejects a collision in one effective registry", async () => {
    const alcodeHome = await tempRoot();
    const a = await tempRoot();
    const b = await tempRoot();
    const user = await tempRoot();
    await plugin(a, "shared");
    await plugin(b, "shared");
    await plugin(user, "shared");
    const service = new HostPluginService({ alcodeHome });
    await service.initialize();
    await service.registerLocal({ sourceRoot: a, scope: "workspace", workspaceId: "A" });
    await service.registerLocal({ sourceRoot: b, scope: "workspace", workspaceId: "B" });
    expect(service.effectiveRegistry("A")).toHaveLength(1);
    await expect(service.registerLocal({ sourceRoot: user, scope: "user" })).rejects.toThrow(/duplicate effective plugin name/);
  });

  it("marks an enabled plugin changed on startup after offline source mutation and does not reactivate D1", async () => {
    const alcodeHome = await tempRoot();
    const source = await tempRoot();
    await plugin(source);
    const firstEvents = recordingLifecycle();
    const first = new HostPluginService({ alcodeHome, lifecycle: firstEvents.lifecycle });
    await first.initialize();
    const registration = await first.registerLocal({ sourceRoot: source, scope: "user" });
    await first.enable(registration.registrationId);
    await writeFile(path.join(source, "offline-change.txt"), "D1");

    const restartEvents = recordingLifecycle();
    const restarted = new HostPluginService({ alcodeHome, lifecycle: restartEvents.lifecycle });
    await restarted.initialize();
    await restarted.startup();
    expect(restartEvents.activated).toHaveLength(0);
    expect(restarted.get(registration.registrationId)?.status).toBe("changed");
  });
});
