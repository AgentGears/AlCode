import { describe, expect, it } from "vitest";
import {
  PlanningBaseStaleError,
  type ExecutionWorldOperationBindingAuthorityV1,
  type ExecutionWorldOperationBindingV1,
} from "@alcode/host-runtime";
import type { ExecutionWorldOperationProvenanceV1 } from "@alcode/host-runtime/execution-world";
import type { WorkspaceEventStore } from "@alcode/storage";
import type { Workspace } from "./capabilities/types.ts";
import {
  CODING_WORKSPACE_EXECUTION_SERVICE_V1,
  CODING_WORKSPACE_OBSERVATION_SERVICE_V1,
  type CodingWorkspaceObservationServiceV1,
} from "./execution-provider.ts";
import {
  createExecutionWorldObservationSourceV1,
  createExecutionWorldPathStateObserverV1,
  createExecutionWorldPlanningBindingV1,
  createExecutionWorldSemanticPlanningBridgeV1,
} from "./execution-world-observation.ts";
import { createLocalPlanningReadRegistry } from "./planning-read-catalog.ts";
import type {
  SemanticPlanningCodeIntelligence,
  SemanticPlanningQuery,
  SemanticPlanningQueryResult,
} from "./semantic-planning-read.ts";

function provenance(
  workspaceId: string,
  generation: string,
  providerKind = "local-trusted",
): ExecutionWorldOperationProvenanceV1 {
  return {
    workspaceId,
    providerKind,
    executionWorldGenerationId: generation,
    providerDescriptorDigest: "provider-digest",
    effectivePolicyDigest: "policy-digest",
  };
}

function workspace(workspaceId: string, root: string, value: string): Workspace {
  return {
    identity: { workspaceId, repositoryId: "repo-a5", root },
    filesystem: {
      read: async () => ({ content: value, truncated: false, byteCount: Buffer.byteLength(value) }),
      write: async (request) => ({ bytesWritten: Buffer.byteLength(request.content) }),
      edit: async () => ({ replacements: 1 }),
      list: async () => [],
      grep: async () => [],
      find: async () => [],
    },
    terminal: {
      execute: async () => ({
        stdout: value,
        stderr: "",
        exitCode: 0,
        durationMs: 1,
        timedOut: false,
        cancelled: false,
        truncated: false,
      }),
    },
  };
}

function binding(input: {
  workspaceId: string;
  generation: string;
  root: string;
  value: string;
  providerKind?: string;
  stateDigest?: string;
  pathState?: "file" | "directory" | "symlink" | "absent";
}): ExecutionWorldOperationBindingV1 {
  const boundWorkspace = workspace(input.workspaceId, input.root, input.value);
  const observations: CodingWorkspaceObservationServiceV1 = {
    observeStateDigest: async () => input.stateDigest ?? "same-bytes",
    observePathState: async () => input.pathState ?? "file",
  };
  return {
    provenance: provenance(input.workspaceId, input.generation, input.providerKind),
    assertUsable: () => undefined,
    getService(serviceId) {
      if (serviceId === CODING_WORKSPACE_EXECUTION_SERVICE_V1) return boundWorkspace;
      if (serviceId === CODING_WORKSPACE_OBSERVATION_SERVICE_V1) return observations;
      return undefined;
    },
  };
}

function authority(initial: ExecutionWorldOperationBindingV1): {
  authority: ExecutionWorldOperationBindingAuthorityV1;
  setCurrent(binding: ExecutionWorldOperationBindingV1): void;
} {
  let current = initial;
  return {
    authority: { captureCurrent: async () => current },
    setCurrent(next) { current = next; },
  };
}

describe("A5 generation-bound planning and observation bridges", () => {
  it("pins one planning read to G0 and makes its dependency stale after same-bytes G1 replacement", async () => {
    const workspaceId = "018f0000-0000-7000-8000-00000000a530";
    const g0 = binding({ workspaceId, generation: "g0", root: "/world-g0", value: "stable" });
    const g1 = binding({ workspaceId, generation: "g1", root: "/world-g1", value: "stable" });
    const current = authority(g0);
    const descriptor = workspace(workspaceId, "/descriptor", "descriptor");
    const registry = createLocalPlanningReadRegistry(
      descriptor,
      undefined,
      createExecutionWorldPlanningBindingV1(current.authority),
    );
    const tracked = registry.track(workspaceId);

    expect(await tracked.read("workspace.read_text", 1, { path: "value.txt" })).toMatchObject({
      text: "stable",
    });
    const sealed = tracked.seal();
    expect(sealed.dependencies[0]?.providerBindingRevision).toContain("g0");

    current.setCurrent(g1);
    await expect(registry.recheck(sealed)).rejects.toBeInstanceOf(PlanningBaseStaleError);
  });

  it("puts the exact execution-world generation into the canonical execution-base observation", async () => {
    const workspaceId = "018f0000-0000-7000-8000-00000000a531";
    const g0 = binding({ workspaceId, generation: "g0", root: "/same-root", value: "stable" });
    const g1 = binding({ workspaceId, generation: "g1", root: "/same-root", value: "stable" });
    const current = authority(g0);
    const store = {
      workspaceId,
      async *replay() {},
    } as unknown as WorkspaceEventStore;
    const observations = createExecutionWorldObservationSourceV1(store, current.authority);

    const before = await observations.observe();
    expect(before).toMatchObject({
      status: "complete",
      base: {
        workspaceEffectGeneration: 0,
        observation: { executionWorld: { executionWorldGenerationId: "g0" } },
      },
    });

    current.setCurrent(g1);
    const after = await observations.observe();
    expect(after).toMatchObject({
      status: "complete",
      base: { observation: { executionWorld: { executionWorldGenerationId: "g1" } } },
    });
    expect(JSON.stringify(before)).not.toBe(JSON.stringify(after));
  });

  it("observes verification path state through the exact bound world", async () => {
    const workspaceId = "018f0000-0000-7000-8000-00000000a532";
    const current = authority(binding({
      workspaceId,
      generation: "g0",
      root: "/world",
      value: "stable",
      pathState: "symlink",
    }));
    const observer = createExecutionWorldPathStateObserverV1(current.authority);
    await expect(observer.observePathState("link.ts")).resolves.toBe("symlink");
  });

  it("fails semantic planning closed when CodeIntelligence cannot prove the current world root", async () => {
    const workspaceId = "018f0000-0000-7000-8000-00000000a533";
    const current = authority(binding({
      workspaceId,
      generation: "g0",
      root: "/isolated-world",
      value: "stable",
    }));
    let queried = false;
    const service: SemanticPlanningCodeIntelligence = {
      isRevisionTrackedPath: () => true,
      async query<Q extends SemanticPlanningQuery>(request: Q): Promise<{
        workspaceId: string;
        repositoryId: string;
        revision: { epoch: string; generation: number; fingerprint: string };
        complete: boolean;
        current: boolean;
        observedAt: string;
        provider: { name: string; version: string };
        value: SemanticPlanningQueryResult<Q>;
        diagnostics: string[];
      }> {
        queried = true;
        return {
          workspaceId,
          repositoryId: "repo-a5",
          revision: { epoch: "e", generation: 1, fingerprint: "f" },
          complete: true,
          current: true,
          observedAt: new Date(0).toISOString(),
          provider: { name: "fake", version: "1" },
          value: ({ symbols: [] } as unknown) as SemanticPlanningQueryResult<Q>,
          diagnostics: [],
        };
      },
    };
    const bridge = createExecutionWorldSemanticPlanningBridgeV1(
      current.authority,
      "/host-copy",
      service,
    );
    await expect(bridge.query({ type: "symbol_search", query: "x" })).rejects.toThrow(
      "CodeIntelligence is unavailable",
    );
    expect(queried).toBe(false);
  });

  it("fails Host-local semantic planning closed for an isolated provider even when path labels match", async () => {
    const workspaceId = "018f0000-0000-7000-8000-00000000a535";
    const current = authority(binding({
      workspaceId,
      generation: "g-isolated",
      root: "/same-label",
      value: "stable",
      providerKind: "isolated-v1",
    }));
    let queried = false;
    const service: SemanticPlanningCodeIntelligence = {
      isRevisionTrackedPath: () => true,
      async query<Q extends SemanticPlanningQuery>(): Promise<{
        workspaceId: string;
        repositoryId: string;
        revision: { epoch: string; generation: number; fingerprint: string };
        complete: boolean;
        current: boolean;
        observedAt: string;
        provider: { name: string; version: string };
        value: SemanticPlanningQueryResult<Q>;
        diagnostics: string[];
      }> {
        queried = true;
        return {
          workspaceId,
          repositoryId: "repo-a5",
          revision: { epoch: "e", generation: 1, fingerprint: "f" },
          complete: true,
          current: true,
          observedAt: new Date(0).toISOString(),
          provider: { name: "fake", version: "1" },
          value: ({ symbols: [] } as unknown) as SemanticPlanningQueryResult<Q>,
          diagnostics: [],
        };
      },
    };
    const bridge = createExecutionWorldSemanticPlanningBridgeV1(
      current.authority,
      "/same-label",
      service,
    );

    await expect(bridge.query({ type: "symbol_search", query: "x" })).rejects.toThrow(
      "cannot prove Host-local semantic freshness",
    );
    expect(queried).toBe(false);
  });

  it("rejects CodeIntelligence evidence if the execution generation changes during the query", async () => {
    const workspaceId = "018f0000-0000-7000-8000-00000000a534";
    const g0 = binding({ workspaceId, generation: "g0", root: "/world", value: "stable" });
    const g1 = binding({ workspaceId, generation: "g1", root: "/world", value: "stable" });
    const current = authority(g0);
    const service: SemanticPlanningCodeIntelligence = {
      isRevisionTrackedPath: () => true,
      async query<Q extends SemanticPlanningQuery>(): Promise<{
        workspaceId: string;
        repositoryId: string;
        revision: { epoch: string; generation: number; fingerprint: string };
        complete: boolean;
        current: boolean;
        observedAt: string;
        provider: { name: string; version: string };
        value: SemanticPlanningQueryResult<Q>;
        diagnostics: string[];
      }> {
        current.setCurrent(g1);
        return {
          workspaceId,
          repositoryId: "repo-a5",
          revision: { epoch: "e", generation: 1, fingerprint: "f" },
          complete: true,
          current: true,
          observedAt: new Date(0).toISOString(),
          provider: { name: "fake", version: "1" },
          value: ({ symbols: [] } as unknown) as SemanticPlanningQueryResult<Q>,
          diagnostics: [],
        };
      },
    };
    const bridge = createExecutionWorldSemanticPlanningBridgeV1(current.authority, "/world", service);
    await expect(bridge.query({ type: "symbol_search", query: "x" })).rejects.toThrow(
      "Execution world changed",
    );
  });
});
