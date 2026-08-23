import { describe, expect, it } from "vitest";
import { planningCanonicalDigest } from "./planning-read.ts";
import { HostProgramVerifierCatalogV1, ProgramVerifierCatalogError } from "./program-verifier-catalog.ts";
import { HostVerificationOperationRegistryV1 } from "./program-verification.ts";

function operationSpecs(): HostVerificationOperationRegistryV1 {
  return new HostVerificationOperationRegistryV1([{
    specId: "command_exit_zero",
    specVersion: 1,
    capabilityName: "bash",
    workspaceAccessClass: "may_write",
    isSuccessful: (result) => {
      const payload = result.result as { details?: { exitCode?: number | null } } | undefined;
      return result.outcome === "succeeded" && payload?.details?.exitCode === 0;
    },
  }]);
}

function catalog(): HostProgramVerifierCatalogV1 {
  return new HostProgramVerifierCatalogV1([
    {
      specId: "workspace_path_state",
      specVersion: 1,
      predicateKind: "workspace_path_state",
      description: "Observe a path state",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, requiredState: { type: "string" } },
        required: ["path", "requiredState"],
      },
    },
    {
      specId: "command_exit_zero",
      specVersion: 1,
      predicateKind: "operation_result",
      description: "Run a command and require zero exit",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  ], operationSpecs());
}

describe("P-01 Host verifier catalog", () => {
  it("is deterministic, exact, and never exposes Host capability names", () => {
    const first = catalog().catalog();
    const second = catalog().catalog();
    expect(first).toEqual(second);
    expect(first.verifiers.map((item) => `${item.specId}@${item.specVersion}`)).toEqual([
      "command_exit_zero@1",
      "workspace_path_state@1",
    ]);
    expect(JSON.stringify(first)).not.toContain("bash");
  });

  it("canonicalizes model verifier references and computes trusted command argument digests", () => {
    const verification = catalog().canonicalizeVerification([
      {
        obligationId: "verify-command",
        verifier: { specId: "command_exit_zero", specVersion: 1 },
        args: { command: "pnpm test" },
        freshnessScope: { kind: "workspace" },
      },
      {
        obligationId: "verify-path",
        verifier: { specId: "workspace_path_state", specVersion: 1 },
        args: { path: "package.json", requiredState: "file" },
        freshnessScope: { kind: "paths", entries: [{ path: "package.json", mode: "exact" }] },
      },
    ]);
    expect(verification[0]?.predicate).toEqual({
      kind: "operation_result",
      specId: "command_exit_zero",
      specVersion: 1,
      canonicalArgs: { command: "pnpm test" },
      canonicalArgsDigest: planningCanonicalDigest({ command: "pnpm test" }),
    });
    expect(verification[1]?.predicate).toEqual({
      kind: "workspace_path_state",
      path: "package.json",
      requiredState: "file",
    });
  });

  it("rejects zero verification and unknown or stale verifier identities before sealing", () => {
    const current = catalog();
    expect(() => current.canonicalizeVerification([])).toThrow(ProgramVerifierCatalogError);
    expect(() => current.canonicalizeVerification([{
      obligationId: "verify-stale",
      verifier: { specId: "command_exit_zero", specVersion: 2 },
      args: { command: "pnpm test" },
      freshnessScope: { kind: "workspace" },
    }])).toThrow(/not in the current planning episode catalog/);
  });
});
