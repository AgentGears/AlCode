import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestOf } from "@alcode/context";
import { uuidv7 } from "@alcode/events";
import {
  LOCAL_TRUSTED_EXECUTION_POLICY_V1,
  LOCAL_TRUSTED_EXECUTION_PROVIDER_V1,
  createLocalExecutionWorldV1,
} from "./execution-provider.ts";

function identity(workspaceId: string, generationId: string) {
  return {
    workspaceId,
    providerKind: LOCAL_TRUSTED_EXECUTION_PROVIDER_V1.providerKind,
    executionWorldGenerationId: generationId,
    providerDescriptorDigest: digestOf(LOCAL_TRUSTED_EXECUTION_PROVIDER_V1),
    effectivePolicyDigest: digestOf(LOCAL_TRUSTED_EXECUTION_POLICY_V1),
  };
}

describe("A5 local execution provider", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "alcode-a5-local-provider-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("binds filesystem/process surfaces to one exact open generation", async () => {
    const workspaceId = uuidv7();
    const generationId = uuidv7();
    const world = createLocalExecutionWorldV1({
      identity: identity(workspaceId, generationId),
      repositoryId: "repo-local",
      root,
    });

    await world.workspace.filesystem.write({ path: "a.txt", content: "hello" });
    expect((await world.workspace.filesystem.read({ path: "a.txt" })).content).toBe("hello");
    const command = process.platform === "win32" ? "echo hello" : "printf hello";
    expect((await world.workspace.terminal.execute({ command })).stdout).toContain("hello");
    expect(world.activationEvidence().readinessEvidenceDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not let a retired G0 binding transparently migrate to G1", async () => {
    const workspaceId = uuidv7();
    const g0 = createLocalExecutionWorldV1({
      identity: identity(workspaceId, uuidv7()),
      repositoryId: "repo-local",
      root,
    });
    await g0.workspace.filesystem.write({ path: "same-bytes.txt", content: "stable" });
    const closure = await g0.close();
    expect(closure.bindingUnavailable).toBe(true);

    const g1 = createLocalExecutionWorldV1({
      identity: identity(workspaceId, uuidv7()),
      repositoryId: "repo-local",
      root,
    });
    expect((await g1.workspace.filesystem.read({ path: "same-bytes.txt" })).content).toBe("stable");
    await expect(g0.workspace.filesystem.read({ path: "same-bytes.txt" })).rejects.toThrow("generation is closed");
  });
});
