import {
  ExecutionWorldOperationBindingRegistryV1,
  type ExecutionWorldOperationBindingV1,
} from "@alcode/host-runtime";
import { ExecutionWorldServiceV1 } from "@alcode/host-runtime/execution-world";
import {
  DOCKER_ISOLATED_EXECUTION_POLICY_V1,
  DOCKER_ISOLATED_EXECUTION_PROVIDER_V1,
  createDockerExecutionWorldV1,
  type DockerExecutionWorldV1,
} from "./docker-execution-provider.ts";

export interface ActiveDockerExecutionWorldV1 {
  readonly worlds: ExecutionWorldServiceV1;
  readonly bindings: ExecutionWorldOperationBindingRegistryV1;
  readonly world: DockerExecutionWorldV1;
  readonly binding: ExecutionWorldOperationBindingV1;
}

export interface ActivateDockerExecutionWorldInputV1 {
  worlds: ExecutionWorldServiceV1;
  activationRequestId: string;
  workspaceId: string;
  sessionId: string;
  repositoryId: string;
  root: string;
}

/**
 * Activate one real isolated-v1 world. The Host lifecycle preparation remains
 * durable before the environmental Docker create/start effect. Positive
 * readiness evidence is admitted only after the exact generation container is
 * running with the required containment profile.
 */
export async function activateDockerExecutionWorldV1(
  input: ActivateDockerExecutionWorldInputV1,
): Promise<ActiveDockerExecutionWorldV1> {
  const identity = await input.worlds.prepareActivation({
    activationRequestId: input.activationRequestId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    providerDescriptor: DOCKER_ISOLATED_EXECUTION_PROVIDER_V1,
    effectivePolicy: DOCKER_ISOLATED_EXECUTION_POLICY_V1,
  });

  let world: DockerExecutionWorldV1 | undefined;
  let binding: ExecutionWorldOperationBindingV1 | undefined;
  const bindings = new ExecutionWorldOperationBindingRegistryV1(input.worlds);
  try {
    world = await createDockerExecutionWorldV1({
      identity,
      repositoryId: input.repositoryId,
      root: input.root,
    });
    binding = world.operationBinding();
    bindings.register(binding);
    await input.worlds.observeActivation({
      executionWorldGenerationId: identity.executionWorldGenerationId,
      evidence: world.activationEvidence(),
    });
    return { worlds: input.worlds, bindings, world, binding };
  } catch (error) {
    if (binding !== undefined) {
      try { bindings.unregister(identity.executionWorldGenerationId, binding); } catch { /* best effort */ }
    }
    let closureEvidence: Awaited<ReturnType<DockerExecutionWorldV1["close"]>> | undefined;
    if (world !== undefined) {
      try { closureEvidence = await world.close(); } catch { /* occurrence remains uncertain */ }
    }
    await input.worlds.markLost({
      executionWorldGenerationId: identity.executionWorldGenerationId,
      reasonCode: "isolated_activation_or_observation_failed",
    }).catch(() => undefined);
    if (closureEvidence !== undefined) {
      await input.worlds.observeClosure({
        executionWorldGenerationId: identity.executionWorldGenerationId,
        evidence: closureEvidence,
      }).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Fence new work first, then force provider teardown and require positive exact
 * container absence before durable closure. Failure leaves the generation
 * lost/unknown; it never fabricates closure or Operation-effect absence.
 */
export async function retireDockerExecutionWorldV1(
  active: ActiveDockerExecutionWorldV1,
): Promise<void> {
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
    await active.worlds.observeClosure({
      executionWorldGenerationId: generationId,
      evidence,
    });
  } catch (error) {
    try { active.bindings.unregister(generationId, active.binding); } catch { /* best effort */ }
    await active.worlds.markLost({
      executionWorldGenerationId: generationId,
      reasonCode: "isolated_retirement_or_closure_uncertain",
    }).catch(() => undefined);
    throw error;
  }
}
