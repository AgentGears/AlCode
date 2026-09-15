import { digestOf } from "@alcode/context";
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
 * Reconcile durable local-trusted generations after a Host process restart.
 *
 * The local provider's runtime binding exists only in the Host process that
 * created it; it cannot survive process death. A fresh Host process therefore
 * has complete positive absence for the exact old in-memory binding. This
 * recovery is deliberately limited to this adapter and must run before any new
 * local binding is created in the current process.
 */
export async function recoverLocalExecutionWorldsAfterHostRestartV1(
  worlds: ExecutionWorldServiceV1,
): Promise<string[]> {
  const projection = await worlds.rebuild();
  const recovered: string[] = [];
  for (const generation of projection.generations.values()) {
    if (generation.state === "closed") continue;
    if (generation.providerDescriptor.providerKind !== LOCAL_TRUSTED_EXECUTION_PROVIDER_V1.providerKind
        || generation.providerDescriptor.adapter !== LOCAL_TRUSTED_EXECUTION_PROVIDER_V1.adapter) {
      continue;
    }

    const generationId = generation.identity.executionWorldGenerationId;
    let current = generation;
    if (current.state === "prepared" || current.state === "active") {
      current = await worlds.markLost({
        executionWorldGenerationId: generationId,
        reasonCode: "local_host_restart_binding_absent",
      });
    }
    if (current.state !== "retiring" && current.state !== "lost_or_unknown") {
      throw new Error(`Local restart recovery cannot close execution world from ${current.state}`);
    }

    await worlds.observeClosure({
      executionWorldGenerationId: generationId,
      evidence: {
        closureEvidenceDigest: digestOf({
          contract: "local-execution-world-restart-absence-v1",
          executionWorldGenerationId: generationId,
          adapter: generation.providerDescriptor.adapter,
          bindingUnavailable: true,
        }),
        bindingUnavailable: true,
      },
    });
    recovered.push(generationId);
  }
  return recovered;
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
