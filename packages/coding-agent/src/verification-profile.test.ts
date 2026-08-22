import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostCapability, ProgramExecutionObservationSourceV1 } from "@alcode/host-runtime";
import { createDefaultProgramVerifierConfiguration } from "./verification-profile.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function bashCapability(): HostCapability {
  return {
    name: "bash",
    description: "test bash",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    workspaceAccessClass: "may_write",
    async execute() {
      return { result: {}, outcome: "succeeded", exitCode: 0 };
    },
  };
}

function observations(): ProgramExecutionObservationSourceV1 {
  return {
    observe: async () => ({
      status: "complete",
      base: {
        workspaceEffectGeneration: 0,
        observation: {
          kind: "workspace-observation-v1",
          providerKind: "test",
          workspaceIdentity: "workspace-test",
          coverageDigest: "complete",
          stateDigest: "stable",
        },
      },
    }),
  };
}

describe("P-01 default verifier profile", () => {
  it("installs command_exit_zero through bash and a capability-free two-family planning catalog", () => {
    const profile = createDefaultProgramVerifierConfiguration({
      root: process.cwd(),
      capabilities: [bashCapability()],
      observations: observations(),
    });
    const spec = profile.operationSpecs.resolve("command_exit_zero", 1);
    expect(spec.capabilityName).toBe("bash");
    expect(spec.workspaceAccessClass).toBe("may_write");
    expect(spec.isSuccessful({ outcome: "succeeded", result: { details: { exitCode: 0 } } })).toBe(true);
    expect(spec.isSuccessful({ outcome: "succeeded", result: { details: { exitCode: 1 } } })).toBe(false);
    const catalog = profile.verifierCatalog.catalog();
    expect(catalog.verifiers.map((item) => item.predicateKind)).toEqual([
      "operation_result",
      "workspace_path_state",
    ]);
    expect(JSON.stringify(catalog)).not.toContain("capabilityName");
    expect(JSON.stringify(catalog)).not.toContain('"bash"');
  });

  it("observes real contained path states and rejects Workspace escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "alcode-p01-verifier-")); roots.push(root);
    await writeFile(join(root, "file.txt"), "hello");
    await mkdir(join(root, "dir"));
    if (process.platform !== "win32") await symlink("file.txt", join(root, "link.txt"));
    const profile = createDefaultProgramVerifierConfiguration({
      root,
      capabilities: [bashCapability()],
      observations: observations(),
    });
    await expect(profile.pathObservations.observePath("file.txt")).resolves.toMatchObject({ status: "complete", pathState: "file" });
    await expect(profile.pathObservations.observePath("dir")).resolves.toMatchObject({ status: "complete", pathState: "directory" });
    if (process.platform !== "win32") {
      await expect(profile.pathObservations.observePath("link.txt")).resolves.toMatchObject({ status: "complete", pathState: "symlink" });
    }
    await expect(profile.pathObservations.observePath("missing.txt")).resolves.toMatchObject({ status: "complete", pathState: "absent" });
    await expect(profile.pathObservations.observePath("../outside.txt")).resolves.toMatchObject({ status: "unknown" });
  });
});
