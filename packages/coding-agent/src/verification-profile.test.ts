import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostCapability, ProgramExecutionObservationSourceV1 } from "@alcode/host-runtime";
import {
  COMMAND_EXIT_ZERO_SPEC_ID,
  PACKAGE_LINT_SPEC_ID,
  PACKAGE_TYPECHECK_SPEC_ID,
  TARGETED_PACKAGE_TEST_SPEC_ID,
  createDefaultProgramVerifierConfiguration,
} from "./verification-profile.ts";

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

const freshnessScope = { kind: "program" as const };

describe("P-02 default verifier profile", () => {
  it("retains command_exit_zero and advertises typed package verification without exposing capability authority", () => {
    const profile = createDefaultProgramVerifierConfiguration({
      root: process.cwd(),
      capabilities: [bashCapability()],
      observations: observations(),
    });
    const spec = profile.operationSpecs.resolve(COMMAND_EXIT_ZERO_SPEC_ID, 1);
    expect(spec.capabilityName).toBe("bash");
    expect(spec.workspaceAccessClass).toBe("may_write");
    expect(spec.isSuccessful({ outcome: "succeeded", result: { details: { exitCode: 0 } } })).toBe(true);
    expect(spec.isSuccessful({ outcome: "succeeded", result: { details: { exitCode: 1 } } })).toBe(false);
    const catalog = profile.verifierCatalog.catalog();
    expect(catalog.verifiers.map((item) => item.specId)).toEqual([
      COMMAND_EXIT_ZERO_SPEC_ID,
      PACKAGE_LINT_SPEC_ID,
      PACKAGE_TYPECHECK_SPEC_ID,
      TARGETED_PACKAGE_TEST_SPEC_ID,
      "workspace_path_state",
    ]);
    expect(catalog.verifiers.map((item) => item.predicateKind)).toEqual([
      "operation_result",
      "operation_result",
      "operation_result",
      "operation_result",
      "workspace_path_state",
    ]);
    expect(JSON.stringify(catalog)).not.toContain("capabilityName");
    expect(JSON.stringify(catalog)).not.toContain('"bash"');
  });

  it("Host-canonicalizes typed verifier arguments into fixed commands before Program admission", () => {
    const profile = createDefaultProgramVerifierConfiguration({
      root: process.cwd(),
      capabilities: [bashCapability()],
      observations: observations(),
    });
    const verification = profile.verifierCatalog.canonicalizeVerification([
      {
        obligationId: "verify-typecheck",
        verifier: { specId: PACKAGE_TYPECHECK_SPEC_ID, specVersion: 1 },
        args: { package: "@alcode/host-runtime" },
        freshnessScope,
      },
      {
        obligationId: "verify-lint",
        verifier: { specId: PACKAGE_LINT_SPEC_ID, specVersion: 1 },
        args: { package: "@alcode/coding-agent" },
        freshnessScope,
      },
      {
        obligationId: "verify-targeted",
        verifier: { specId: TARGETED_PACKAGE_TEST_SPEC_ID, specVersion: 1 },
        args: { package: "@alcode/coding-agent", target: "src/verification-profile.test.ts" },
        freshnessScope,
      },
    ]);
    expect(verification.map((item) => item.predicate)).toEqual([
      expect.objectContaining({
        kind: "operation_result",
        specId: PACKAGE_TYPECHECK_SPEC_ID,
        canonicalArgs: { command: "pnpm --filter @alcode/host-runtime typecheck" },
      }),
      expect.objectContaining({
        kind: "operation_result",
        specId: PACKAGE_LINT_SPEC_ID,
        canonicalArgs: { command: "pnpm --filter @alcode/coding-agent lint" },
      }),
      expect.objectContaining({
        kind: "operation_result",
        specId: TARGETED_PACKAGE_TEST_SPEC_ID,
        canonicalArgs: { command: "pnpm --filter @alcode/coding-agent exec vitest run src/verification-profile.test.ts" },
      }),
    ]);
    expect(JSON.stringify(verification)).not.toContain('"package"');
    expect(JSON.stringify(verification)).not.toContain('"target"');
  });

  it("rejects shell-bearing or escaping typed verifier fields before Program acceptance", () => {
    const profile = createDefaultProgramVerifierConfiguration({
      root: process.cwd(),
      capabilities: [bashCapability()],
      observations: observations(),
    });
    expect(() => profile.verifierCatalog.canonicalizeVerification([{
      obligationId: "verify-injected-package",
      verifier: { specId: PACKAGE_TYPECHECK_SPEC_ID, specVersion: 1 },
      args: { package: "@alcode/host-runtime;echo-pwned" },
      freshnessScope,
    }])).toThrow(/Host argument canonicalization failed/);
    expect(() => profile.verifierCatalog.canonicalizeVerification([{
      obligationId: "verify-injected-target",
      verifier: { specId: TARGETED_PACKAGE_TEST_SPEC_ID, specVersion: 1 },
      args: { package: "@alcode/coding-agent", target: "../outside.test.ts" },
      freshnessScope,
    }])).toThrow(/Host argument canonicalization failed/);
    expect(() => profile.verifierCatalog.canonicalizeVerification([{
      obligationId: "verify-extra-authority",
      verifier: { specId: PACKAGE_LINT_SPEC_ID, specVersion: 1 },
      args: { package: "@alcode/coding-agent", command: "rm -rf ." },
      freshnessScope,
    }])).toThrow(/Unexpected verifier argument command/);
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
