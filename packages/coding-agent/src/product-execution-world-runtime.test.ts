import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asWorkspaceId, uuidv7 } from "@alcode/events";
import { DefaultHostPolicy, HostRuntime } from "@alcode/host-runtime";
import { ExecutionWorldServiceV1 } from "@alcode/host-runtime/execution-world";
import { openLockedWorkspaceStore } from "@alcode/storage";
import { activateLocalExecutionWorldV1 } from "./local-execution-world-runtime.ts";
import {
  recoverProductExecutionWorldsAfterHostRestartV1,
  resolveProductExecutionProviderKindV1,
} from "./product-execution-world-runtime.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

describe("A5 product execution-provider selection", () => {
  it("keeps local-trusted as the explicit compatibility default", () => {
    expect(resolveProductExecutionProviderKindV1(undefined)).toBe("local-trusted");
    expect(resolveProductExecutionProviderKindV1("")).toBe("local-trusted");
    expect(resolveProductExecutionProviderKindV1("local-trusted")).toBe("local-trusted");
  });

  it("selects isolated-v1 only when Application/Host configuration requests it", () => {
    expect(resolveProductExecutionProviderKindV1("isolated-v1")).toBe("isolated-v1");
  });

  it("fails closed for unknown providers instead of silently downgrading to local execution", () => {
    expect(() => resolveProductExecutionProviderKindV1("mystery-provider"))
      .toThrow(/Unsupported ALCODE execution provider/);
  });
});

describeLocked("A5 product execution-world restart recovery", () => {
  it("reconciles a prior local generation even when the next product selection is isolated-v1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-a5-product-recovery-"));
    const root = join(dir, "workspace");
    mkdirSync(root, { recursive: true });
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: asWorkspaceId(uuidv7()),
      repositoryId: "a5-product-recovery",
    });
    try {
      const host = new HostRuntime({
        store: locked,
        capabilities: [],
        policy: new DefaultHostPolicy({ knownTools: [] }),
      });
      await host.startup();
      const session = await host.openOrResumeSession();
      const worlds = new ExecutionWorldServiceV1(locked.store, host.admission);
      const prior = await activateLocalExecutionWorldV1({
        worlds,
        activationRequestId: "prior-local-generation",
        workspaceId: String(locked.store.workspaceId),
        sessionId: String(session.sessionId),
        repositoryId: "a5-product-recovery",
        root,
      });
      const generationId = prior.world.identity.executionWorldGenerationId;
      expect((await worlds.requireGeneration(generationId)).state).toBe("active");

      // Selection is deliberately the opposite provider. Recovery must still
      // fence/close the durable prior world before any successor activation.
      await recoverProductExecutionWorldsAfterHostRestartV1({
        providerKind: "isolated-v1",
        worlds,
        root,
      });

      expect((await worlds.requireGeneration(generationId)).state).toBe("closed");
      expect(await worlds.currentOperationProvenance().then(
        () => "unexpected-current",
        () => "none",
      )).toBe("none");
    } finally {
      locked.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
