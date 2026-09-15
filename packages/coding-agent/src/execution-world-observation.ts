import { digestOf } from "@alcode/context";
import type {
  ExecutionWorldOperationBindingAuthorityV1,
  ExecutionWorldOperationBindingV1,
  ProgramExecutionObservationSourceV1,
} from "@alcode/host-runtime";
import type { WorkspaceEventStore } from "@alcode/storage";
import type { Workspace } from "./capabilities/types.ts";
import {
  CODING_WORKSPACE_EXECUTION_SERVICE_V1,
  CODING_WORKSPACE_OBSERVATION_SERVICE_V1,
  type CodingWorkspaceObservationServiceV1,
} from "./execution-provider.ts";
import type { LocalPlanningExecutionBindingV1 } from "./planning-read-catalog.ts";
import {
  PlanningReadError,
} from "@alcode/host-runtime";
import type {
  SemanticPlanningCodeIntelligence,
  SemanticPlanningObservation,
  SemanticPlanningQuery,
  SemanticPlanningQueryResult,
} from "./semantic-planning-read.ts";
import type { ProgramWorkspacePathStateObserverV1 } from "./verification-profile.ts";

function sameBinding(
  left: ExecutionWorldOperationBindingV1,
  right: ExecutionWorldOperationBindingV1,
): boolean {
  const a = left.provenance;
  const b = right.provenance;
  return a.workspaceId === b.workspaceId
    && a.providerKind === b.providerKind
    && a.executionWorldGenerationId === b.executionWorldGenerationId
    && a.providerDescriptorDigest === b.providerDescriptorDigest
    && a.effectivePolicyDigest === b.effectivePolicyDigest;
}

function requireWorkspace(binding: ExecutionWorldOperationBindingV1): Workspace {
  const service = binding.getService?.(CODING_WORKSPACE_EXECUTION_SERVICE_V1) as Workspace | undefined;
  if (service === undefined
      || service.identity.workspaceId !== binding.provenance.workspaceId
      || typeof service.filesystem?.read !== "function"
      || typeof service.terminal?.execute !== "function") {
    throw new Error("Execution-world binding lacks a coherent coding Workspace service");
  }
  return service;
}

function requireObservations(binding: ExecutionWorldOperationBindingV1): CodingWorkspaceObservationServiceV1 {
  const service = binding.getService?.(CODING_WORKSPACE_OBSERVATION_SERVICE_V1) as CodingWorkspaceObservationServiceV1 | undefined;
  if (service === undefined
      || typeof service.observeStateDigest !== "function"
      || typeof service.observePathState !== "function") {
    throw new Error("Execution-world binding lacks generation-bound Workspace observation services");
  }
  return service;
}

function providerBindingRevision(binding: ExecutionWorldOperationBindingV1): string {
  const provenance = binding.provenance;
  return [
    "execution-world-v1",
    provenance.providerKind,
    provenance.executionWorldGenerationId,
    provenance.providerDescriptorDigest,
    provenance.effectivePolicyDigest,
  ].join(":");
}

async function durableWorkspaceEffectGeneration(store: WorkspaceEventStore): Promise<number> {
  let current = 0;
  for await (const event of store.replay()) {
    if (event.type !== "workspace.effect_generation.advanced") continue;
    const payload = typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
      ? event.payload as Record<string, unknown>
      : {};
    const value = payload.workspaceEffectGeneration;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= current) current = value;
  }
  return current;
}

export function createExecutionWorldPlanningBindingV1(
  authority: ExecutionWorldOperationBindingAuthorityV1,
): LocalPlanningExecutionBindingV1 {
  return {
    resolveWorkspace: async () => {
      const binding = await authority.captureCurrent();
      return {
        workspace: requireWorkspace(binding),
        providerBindingRevision: providerBindingRevision(binding),
      };
    },
  };
}

export function createExecutionWorldObservationSourceV1(
  store: WorkspaceEventStore,
  authority: ExecutionWorldOperationBindingAuthorityV1,
): ProgramExecutionObservationSourceV1 {
  return {
    observe: async () => {
      try {
        const beforeBinding = await authority.captureCurrent();
        const observations = requireObservations(beforeBinding);
        const beforeEffectGeneration = await durableWorkspaceEffectGeneration(store);
        const stateDigest = await observations.observeStateDigest();
        const afterEffectGeneration = await durableWorkspaceEffectGeneration(store);
        const afterBinding = await authority.captureCurrent();
        if (!sameBinding(beforeBinding, afterBinding)
            || beforeEffectGeneration !== afterEffectGeneration) {
          return { status: "unknown", reason: "Execution world changed during protected Workspace observation" } as const;
        }
        const executionWorld = structuredClone(afterBinding.provenance);
        return {
          status: "complete",
          base: {
            workspaceEffectGeneration: afterEffectGeneration,
            observation: {
              kind: "workspace-observation-v1",
              providerKind: executionWorld.providerKind,
              workspaceIdentity: executionWorld.workspaceId,
              coverageDigest: digestOf({
                contract: "execution-world-workspace-observation-v1",
                executionWorld,
              }),
              stateDigest,
              executionWorld,
            },
          },
        } as const;
      } catch (error) {
        return {
          status: "unknown",
          reason: error instanceof Error ? error.message : String(error),
        } as const;
      }
    },
  };
}

export function createExecutionWorldPathStateObserverV1(
  authority: ExecutionWorldOperationBindingAuthorityV1,
): ProgramWorkspacePathStateObserverV1 {
  return {
    observePathState: async (path) => {
      const before = await authority.captureCurrent();
      const pathState = await requireObservations(before).observePathState(path);
      const after = await authority.captureCurrent();
      if (!sameBinding(before, after)) {
        throw new Error("Execution world changed during protected path observation");
      }
      return pathState;
    },
  };
}

/**
 * Local-trusted-only freshness bridge for Host-owned CodeIntelligence. It is
 * deliberately fail-closed for a provider whose exact generation cannot prove
 * that the semantic service observes the same physical root.
 */
export function createExecutionWorldSemanticPlanningBridgeV1(
  authority: ExecutionWorldOperationBindingAuthorityV1,
  expectedRoot: string,
  service: SemanticPlanningCodeIntelligence,
): SemanticPlanningCodeIntelligence {
  return {
    isRevisionTrackedPath: (path) => service.isRevisionTrackedPath(path),
    async query<Q extends SemanticPlanningQuery>(
      request: Q,
      options?: { signal?: AbortSignal },
    ): Promise<SemanticPlanningObservation<SemanticPlanningQueryResult<Q>>> {
      const before = await authority.captureCurrent();
      const workspace = requireWorkspace(before);
      if (workspace.identity.root !== expectedRoot) {
        throw new PlanningReadError(
          "CodeIntelligence is unavailable because its Host root is not the current execution-world root",
        );
      }
      const observation = await service.query(request, options);
      const after = await authority.captureCurrent();
      if (!sameBinding(before, after)) {
        throw new PlanningReadError("Execution world changed during CodeIntelligence observation");
      }
      return {
        ...observation,
        provider: {
          name: observation.provider.name,
          version: `${observation.provider.version}+${before.provenance.executionWorldGenerationId}`,
        },
      };
    },
  };
}
