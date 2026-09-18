import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asWorkspaceId, uuidv7 } from "@alcode/events";
import { DefaultHostPolicy, HostRuntime } from "@alcode/host-runtime";
import { ExecutionWorldServiceV1 } from "@alcode/host-runtime/execution-world";
import { openLockedWorkspaceStore } from "@alcode/storage";
import {
  DOCKER_ISOLATED_EXECUTION_POLICY_V1,
  DOCKER_ISOLATED_EXECUTION_PROVIDER_V1,
  createDockerExecutionWorldV1,
  type DockerExecutionWorldV1,
} from "./docker-execution-provider.ts";
import { recoverDockerExecutionWorldsAfterHostRestartV1 } from "./docker-execution-world-recovery.ts";
import {
  activateDockerExecutionWorldV1,
  type ActiveDockerExecutionWorldV1,
} from "./docker-execution-world-runtime.ts";

const enabled = process.platform === "linux" && process.env.ALCODE_A5_DOCKER_INTEGRATION === "1";
const describeDocker = enabled ? describe : describe.skip;

function expectContainerAbsent(containerId: string): void {
  expect(() => execFileSync("docker", ["inspect", containerId], { stdio: "ignore" })).toThrow();
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "alcode-a5-docker-recovery-"));
  const root = join(dir, "workspace");
  const fs = await import("node:fs/promises");
  await fs.mkdir(root, { recursive: true });
  writeFileSync(join(root, "state.txt"), "recovery\n");
  const workspaceId = asWorkspaceId(uuidv7());
  const locked = await openLockedWorkspaceStore({
    databasePath: join(dir, "workspace.sqlite"),
    lockPath: join(dir, "workspace.lock"),
    workspaceId,
    repositoryId: "a5-docker-recovery",
  });
  const host = new HostRuntime({
    store: locked,
    capabilities: [],
    policy: new DefaultHostPolicy({ knownTools: [], allowMutations: false }),
  });
  await host.startup();
  const session = await host.openOrResumeSession();
  const worlds = new ExecutionWorldServiceV1(locked.store, host.admission);
  return { dir, root, workspaceId, locked, session, worlds };
}

describeDocker("A5 isolated-v1 restart reconciliation", () => {
  it("discovers and removes a physical container when Host ownership is lost after activation preparation", async () => {
    const state = await fixture();
    let world: DockerExecutionWorldV1 | undefined;
    try {
      const identity = await state.worlds.prepareActivation({
        activationRequestId: `a5-prepared-loss-${uuidv7()}`,
        workspaceId: String(state.workspaceId),
        sessionId: String(state.session.sessionId),
        providerDescriptor: DOCKER_ISOLATED_EXECUTION_PROVIDER_V1,
        effectivePolicy: DOCKER_ISOLATED_EXECUTION_POLICY_V1,
      });
      world = await createDockerExecutionWorldV1({
        identity,
        repositoryId: "a5-docker-recovery",
        root: state.root,
      });
      const containerId = world.providerNativeInstanceId;

      expect((await state.worlds.requireGeneration(identity.executionWorldGenerationId)).state).toBe("prepared");
      execFileSync("docker", ["inspect", containerId], { stdio: "ignore" });

      await recoverDockerExecutionWorldsAfterHostRestartV1(state.worlds, state.root);

      const recovered = await state.worlds.requireGeneration(identity.executionWorldGenerationId);
      expect(recovered.state).toBe("closed");
      expect(recovered.closureEvidence?.bindingUnavailable).toBe(true);
      expect(recovered.lostReasonCode).toBe("isolated_restart_prepared_reconciliation");
      expectContainerAbsent(containerId);
    } finally {
      await world?.close().catch(() => undefined);
      state.locked.close();
      rmSync(state.dir, { recursive: true, force: true });
    }
  }, 10 * 60_000);

  it("does not equate a durable teardown request with closure before restart discovery proves absence", async () => {
    const state = await fixture();
    let active: ActiveDockerExecutionWorldV1 | undefined;
    try {
      active = await activateDockerExecutionWorldV1({
        worlds: state.worlds,
        activationRequestId: `a5-retirement-loss-${uuidv7()}`,
        workspaceId: String(state.workspaceId),
        sessionId: String(state.session.sessionId),
        repositoryId: "a5-docker-recovery",
        root: state.root,
      });
      const generationId = active.world.identity.executionWorldGenerationId;
      const containerId = active.world.providerNativeInstanceId;

      await state.worlds.requestRetirement(generationId);
      active.bindings.unregister(generationId, active.binding);
      expect((await state.worlds.requireGeneration(generationId)).state).toBe("retiring");
      execFileSync("docker", ["inspect", containerId], { stdio: "ignore" });

      await recoverDockerExecutionWorldsAfterHostRestartV1(state.worlds, state.root);

      const recovered = await state.worlds.requireGeneration(generationId);
      expect(recovered.state).toBe("closed");
      expect(recovered.closureEvidence?.bindingUnavailable).toBe(true);
      expectContainerAbsent(containerId);
    } finally {
      await active?.world.close().catch(() => undefined);
      state.locked.close();
      rmSync(state.dir, { recursive: true, force: true });
    }
  }, 10 * 60_000);
});
