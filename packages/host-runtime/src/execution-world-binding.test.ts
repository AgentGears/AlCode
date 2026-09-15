import { describe, expect, it } from "vitest";
import type { ExecutionWorldOperationProvenanceV1 } from "./execution-world.ts";
import {
  ExecutionWorldOperationBindingControlError,
  ExecutionWorldOperationBindingRegistryV1,
  type ExecutionWorldOperationBindingV1,
} from "./execution-world-binding.ts";

function provenance(generation: string): ExecutionWorldOperationProvenanceV1 {
  return {
    workspaceId: "018f0000-0000-7000-8000-00000000a502",
    providerKind: "test-provider",
    executionWorldGenerationId: generation,
    providerDescriptorDigest: "provider-digest",
    effectivePolicyDigest: "policy-digest",
  };
}

describe("A5 immutable execution-world operation binding", () => {
  it("keeps an admitted G0 binding on G0 after G1 becomes current", async () => {
    let current = provenance("g0");
    let g0Usable = true;
    const worlds = { currentOperationProvenance: async () => structuredClone(current) };
    const registry = new ExecutionWorldOperationBindingRegistryV1(worlds);
    const g0: ExecutionWorldOperationBindingV1 = {
      provenance: provenance("g0"),
      assertUsable: () => {
        if (!g0Usable) throw new Error("g0 unavailable");
      },
    };
    const g1: ExecutionWorldOperationBindingV1 = {
      provenance: provenance("g1"),
      assertUsable: () => undefined,
    };
    registry.register(g0);
    registry.register(g1);

    const admitted = await registry.captureCurrent();
    expect(admitted).toBe(g0);

    current = provenance("g1");
    expect(await registry.captureCurrent()).toBe(g1);
    expect(admitted).toBe(g0);
    expect(admitted.provenance.executionWorldGenerationId).toBe("g0");

    g0Usable = false;
    await expect(admitted.assertUsable()).rejects.toThrow("g0 unavailable");
    expect(admitted.provenance.executionWorldGenerationId).toBe("g0");
  });

  it("fails closed when the durable current generation has no exact runtime binding", async () => {
    let current = provenance("g0");
    const worlds = { currentOperationProvenance: async () => structuredClone(current) };
    const registry = new ExecutionWorldOperationBindingRegistryV1(worlds);
    registry.register({ provenance: provenance("g0"), assertUsable: () => undefined });

    current = provenance("g1");
    await expect(registry.captureCurrent()).rejects.toBeInstanceOf(
      ExecutionWorldOperationBindingControlError,
    );
  });

  it("rejects replacing a generation with a different runtime binding", () => {
    const worlds = { currentOperationProvenance: async () => provenance("g0") };
    const registry = new ExecutionWorldOperationBindingRegistryV1(worlds);
    registry.register({ provenance: provenance("g0"), assertUsable: () => undefined });
    expect(() => registry.register({
      provenance: provenance("g0"),
      assertUsable: () => undefined,
    })).toThrow("already has a different runtime binding");
  });
});
