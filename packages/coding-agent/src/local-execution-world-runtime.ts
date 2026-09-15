import {
  ExecutionWorldOperationBindingRegistryV1,
  type ExecutionWorldOperationBindingV1,
} from "@alcode/host-runtime";
import { ExecutionWorldServiceV1 } from "@alcode/host-runtime/execution-world";
import {
  LOCAL_TRUSTED_EXECUTION_POLICY_V1,
  LOCAL_TRUSTED_EXECUTION_PROVIDER_V1,
  createLocalExecutionWorldV1,
  type WorkspaceExecutionWorldV1,
} from "./execution-provider.ts";

export interface ActiveLocalExecutionWorldV1 {
  readonly worlds: ExecutionWorldServiceV1;
  readonly bindings: ExecutionWorldOperationBindingRegistryV1;
  readonly world: WorkspaceExecutionWorldV1;
  readonly binding: ExecutionWorldOperationBindingV1;
}

export interface ActivateLocalExecutionWorldInputV1 {
  worlds: ExecutionWorldServiceV1;
  activationRequestId: string;
  workspaceId: string;
  sessionId: string;
  repositoryId: string;
  root: string;
}

/**
 * Bind the local compatibility provider to one Host-owned execution-world
 * generation. Runtime binding registration precedes positive activation
 * observation so an observed current generation is executable immediately.
 */
export async function activateLocalExecutionWorldV1(
  input: ActivateLocalExecutionWorldInputV1,
): Promise<ActiveLocalExecutionWorldV1> {
  const identity = await input.worlds.prepareActivation({
    activationRequestId: input.activationRequestId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    providerDescriptor: LOCAL_TRUSTED_EXECUTION_PROVIDER_V1,
    effectivePolicy: LOCAL_TRUSTED_EXECUTION_POLICY_V1,
  });
  const world = createLocalExecutionWorldV1({
    identity,
    repositoryId: input.repositoryId,
    root: input.root,
  });
  const binding = world.operationBinding();
  const bindings = new ExecutionWorldOperationBindingRegistryV1(input.worlds);
  bindings.register(binding);

  try {
    await input.worlds.observeActivation({
      executionWorldGenerationId: identity.executionWorldGenerationId,
      evidence: world.activationEvidence(),
    });
  } catch (error) {
    bindings.unregister(identity.executionWorldGenerationId, binding);
    await world.close().catch(() => undefined);
    await input.worlds.markLost({
      executionWorldGenerationId: identity.executionWorldGenerationId,
      reasonCode: "local_activation_observation_failed",
    }).catch(() => undefined);
    throw error;
  }

  return { worlds: input.worlds, bindings, world, binding };
}

/**
 * Stop admitting new work to the exact generation, make its local binding
 * unavailable, then record positive provider closure. This does not assert
 * Operation effect absence or quiescence.
 */
export async function retireLocalExecutionWorldV1(active: ActiveLocalExecutionWorldV1): Promise<void> {
  const generationId = active.world.identity.executionWorldGenerationId;
  try {
    const projection = await active.worlds.requireGeneration(generationId);
    if (projection.state === "active") {
      await active.worlds.requestRetirement(generationId);
    } else if (projection.state !== "retiring" && projection.state !== "lost_or_unknown") {
      throw new Error(`Execution-world generation cannot be closed from ${projection.state}`);
    }

    active.bindings.unregister(generationId, active.binding);
    const evidence = await active.world.close();
    await active.worlds.observeClosure({ executionWorldGenerationId: generationId, evidence });
  } catch (error) {
    try { active.bindings.unregister(generationId, active.binding); } catch {}
    await active.world.close().catch(() => undefined);
    await active.worlds.markLost({
      executionWorldGenerationId: generationId,
      reasonCode: "local_retirement_or_closure_uncertain",
    }).catch(() => undefined);
    throw error;
  }
}
