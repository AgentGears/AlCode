import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import {
  activateDockerExecutionWorldV1,
  retireDockerExecutionWorldV1,
  type ActiveDockerExecutionWorldV1,
} from "./docker-execution-world-runtime.ts";
import { createExecutionWorldHostCapabilities } from "./host-capabilities.ts";

const enabled = process.platform === "linux" && process.env.ALCODE_A5_DOCKER_INTEGRATION === "1";
const describeDocker = enabled ? describe : describe.skip;

function inspectContainer(containerId: string): {
  HostConfig: {
    NetworkMode: string;
    CapDrop: string[];
    ReadonlyRootfs: boolean;
    NanoCpus: number;
    Memory: number;
    PidsLimit: number;
    SecurityOpt: string[];
  };
  Config: { Env: string[] };
  Mounts: Array<{ Source: string; Destination: string; RW: boolean }>;
} {
  const raw = execFileSync("docker", ["inspect", containerId], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(raw)[0] as ReturnType<typeof inspectContainer>;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

describeDocker("A5 isolated-v1 Docker provider conformance", () => {
  it("enforces one exact isolated generation across Host capability, observation, containment, and teardown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-a5-docker-"));
    const root = join(dir, "workspace");
    const outside = join(dir, "host-only-secret.txt");
    const databasePath = join(dir, "workspace.sqlite");
    const lockPath = join(dir, "workspace.lock");
    const fs = await import("node:fs/promises");
    await fs.mkdir(root, { recursive: true });
    writeFileSync(join(root, "inside.txt"), "inside\n");
    writeFileSync(outside, "HOST_ONLY_SECRET\n");

    const workspaceId = asWorkspaceId(uuidv7());
    const locked = await openLockedWorkspaceStore({
      databasePath,
      lockPath,
      workspaceId,
      repositoryId: "a5-docker-integration",
    });
    let active: ActiveDockerExecutionWorldV1 | undefined;
    const priorSecret = process.env.ALCODE_A5_HOST_SECRET_SENTINEL;
    process.env.ALCODE_A5_HOST_SECRET_SENTINEL = "must-not-enter-container";
    try {
      const descriptorWorkspace = createLocalWorkspace({
        workspaceId: String(workspaceId),
        repositoryId: "a5-docker-integration",
        root,
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
      active = await activateDockerExecutionWorldV1({
        worlds,
        activationRequestId: `a5-docker-${uuidv7()}`,
        workspaceId: String(workspaceId),
        sessionId: String(session.sessionId),
        repositoryId: "a5-docker-integration",
        root,
      });
      host.capabilityBroker.setExecutionWorldBindingAuthority(active.bindings);

      const containerId = active.world.providerNativeInstanceId;
      const inspected = inspectContainer(containerId);
      expect(inspected.HostConfig.NetworkMode).toBe("none");
      expect(inspected.HostConfig.ReadonlyRootfs).toBe(true);
      expect(inspected.HostConfig.CapDrop).toContain("ALL");
      expect(inspected.HostConfig.NanoCpus).toBeGreaterThan(0);
      expect(inspected.HostConfig.Memory).toBeGreaterThan(0);
      expect(inspected.HostConfig.PidsLimit).toBeGreaterThan(0);
      expect(inspected.HostConfig.SecurityOpt.some((value) => value.includes("no-new-privileges"))).toBe(true);
      expect(inspected.Mounts.filter((mount) => mount.Destination === "/workspace")).toEqual([
        expect.objectContaining({ Source: root, Destination: "/workspace", RW: true }),
      ]);
      expect(inspected.Config.Env.some((value) => value.includes("must-not-enter-container"))).toBe(false);

      const read = await host.capabilityBroker.execute({
        sessionId: session.sessionId,
        toolCallId: "a5-docker-read",
        toolName: "read",
        args: { path: "inside.txt" },
      });
      expect(read.outcome).toBe("succeeded");
      expect(JSON.stringify(read.result)).toContain("inside");

      const write = await host.capabilityBroker.execute({
        sessionId: session.sessionId,
        toolCallId: "a5-docker-write",
        toolName: "write",
        args: { path: "written.txt", content: "from-isolated-world\n" },
      });
      expect(write.outcome).toBe("succeeded");
      expect(readFileSync(join(root, "written.txt"), "utf8")).toBe("from-isolated-world\n");

      const confined = await active.world.workspace.terminal.execute({
        command: `test ! -e ${shQuote(outside)} && printf confined`,
        timeoutMs: 5_000,
      });
      expect(confined.exitCode).toBe(0);
      expect(confined.stdout).toContain("confined");

      const environment = await active.world.workspace.terminal.execute({ command: "env", timeoutMs: 5_000 });
      expect(environment.stdout).not.toContain("ALCODE_A5_HOST_SECRET_SENTINEL");
      expect(environment.stdout).not.toContain("must-not-enter-container");

      const rootWrite = await active.world.workspace.terminal.execute({
        command: "touch /a5-must-fail",
        timeoutMs: 5_000,
      });
      expect(rootWrite.exitCode).not.toBe(0);

      const network = await active.world.workspace.terminal.execute({
        command: "node -e \"const n=require('net').connect({host:'1.1.1.1',port:53}); n.on('connect',()=>process.exit(9)); n.on('error',()=>process.exit(0)); setTimeout(()=>process.exit(0),1000)\"",
        timeoutMs: 5_000,
      });
      expect(network.exitCode).toBe(0);

      const timeout = await active.world.workspace.terminal.execute({
        command: "sleep 5",
        timeoutMs: 100,
      });
      expect(timeout.timedOut).toBe(true);

      const output = await active.world.workspace.terminal.execute({
        command: "node -e \"process.stdout.write('x'.repeat(1200000))\"",
        timeoutMs: 5_000,
      });
      expect(output.truncated).toBe(true);
      expect(Buffer.byteLength(output.stdout, "utf8")).toBeLessThanOrEqual(1_000_000);

      await active.world.workspace.terminal.execute({
        command: "rm -f linger.log; (while :; do printf x >> linger.log; sleep 0.05; done) >/dev/null 2>&1 &",
        timeoutMs: 5_000,
      });
      const before = readFileSync(join(root, "linger.log"), "utf8").length;
      await new Promise((resolve) => setTimeout(resolve, 400));
      const after = readFileSync(join(root, "linger.log"), "utf8").length;
      expect(after).toBe(before);

      const events = [];
      for await (const event of locked.store.replay()) events.push(event);
      const requested = events.filter((event) => event.type === "operation.requested");
      expect(requested.length).toBeGreaterThanOrEqual(2);
      for (const event of requested) {
        const world = (event.payload as { executionWorld?: { executionWorldGenerationId?: string } }).executionWorld;
        expect(world?.executionWorldGenerationId).toBe(active.world.identity.executionWorldGenerationId);
      }

      host.capabilityBroker.setExecutionWorldBindingAuthority(undefined);
      await retireDockerExecutionWorldV1(active);
      expect((await worlds.requireGeneration(active.world.identity.executionWorldGenerationId)).state).toBe("closed");
      expect(() => execFileSync("docker", ["inspect", containerId], { stdio: "ignore" })).toThrow();
      active = undefined;
    } finally {
      if (active !== undefined) {
        await retireDockerExecutionWorldV1(active).catch(async () => {
          try { execFileSync("docker", ["rm", "-f", active!.world.providerNativeInstanceId], { stdio: "ignore" }); } catch {}
        });
      }
      if (priorSecret === undefined) delete process.env.ALCODE_A5_HOST_SECRET_SENTINEL;
      else process.env.ALCODE_A5_HOST_SECRET_SENTINEL = priorSecret;
      locked.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10 * 60_000);
});
