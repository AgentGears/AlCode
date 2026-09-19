import type { ExecutionWorldOperationBindingAuthorityV1 } from "@alcode/host-runtime";
import { ExecutionWorldServiceV1 } from "@alcode/host-runtime/execution-world";
import {
  activateDockerExecutionWorldV1,
  retireDockerExecutionWorldV1,
} from "./docker-execution-world-runtime.ts";
import { recoverDockerExecutionWorldsAfterHostRestartV1 } from "./docker-execution-world-recovery.ts";
import {
  activateLocalExecutionWorldV1,
  recoverLocalExecutionWorldsAfterHostRestartV1,
  retireLocalExecutionWorldV1,
} from "./local-execution-world-runtime.ts";

export type ProductExecutionProviderKindV1 = "local-trusted" | "isolated-v1";

export interface ActiveProductExecutionWorldV1 {
  readonly providerKind: ProductExecutionProviderKindV1;
  readonly generationId: string;
  readonly bindings: ExecutionWorldOperationBindingAuthorityV1;
  retire(): Promise<void>;
}

export interface ProductExecutionWorldActivationInputV1 {
  providerKind: ProductExecutionProviderKindV1;
  worlds: ExecutionWorldServiceV1;
  activationRequestId: string;
  workspaceId: string;
  sessionId: string;
  repositoryId: string;
  root: string;
}

/**
 * Product/provider selection is Application/Host configuration, never Agent
 * authority. The default remains the compatibility provider; isolated-v1 must
 * be selected explicitly.
 */
export function resolveProductExecutionProviderKindV1(
  configured: string | undefined = process.env.ALCODE_EXECUTION_PROVIDER,
): ProductExecutionProviderKindV1 {
  if (configured === undefined || configured === "" || configured === "local-trusted") {
    return "local-trusted";
  }
  if (configured === "isolated-v1") return "isolated-v1";
  throw new Error(
    `Unsupported ALCODE execution provider ${JSON.stringify(configured)}; expected local-trusted or isolated-v1`,
  );
}

/**
 * Restart reconciliation is provider-selection independent. A prior Host may
 * have died while another provider kind was active; every known durable world
 * must therefore be reconciled/fenced before a successor is activated.
 */
export async function recoverProductExecutionWorldsAfterHostRestartV1(input: {
  providerKind?: ProductExecutionProviderKindV1;
  worlds: ExecutionWorldServiceV1;
  root: string;
}): Promise<void> {
  await recoverLocalExecutionWorldsAfterHostRestartV1(input.worlds);
  await recoverDockerExecutionWorldsAfterHostRestartV1(input.worlds, input.root);
}

export async function activateProductExecutionWorldV1(
  input: ProductExecutionWorldActivationInputV1,
): Promise<ActiveProductExecutionWorldV1> {
  if (input.providerKind === "local-trusted") {
    const active = await activateLocalExecutionWorldV1({
      worlds: input.worlds,
      activationRequestId: input.activationRequestId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      repositoryId: input.repositoryId,
      root: input.root,
    });
    return {
      providerKind: "local-trusted",
      generationId: active.world.identity.executionWorldGenerationId,
      bindings: active.bindings,
      retire: () => retireLocalExecutionWorldV1(active),
    };
  }

  const active = await activateDockerExecutionWorldV1({
    worlds: input.worlds,
    activationRequestId: input.activationRequestId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    repositoryId: input.repositoryId,
    root: input.root,
  });
  return {
    providerKind: "isolated-v1",
    generationId: active.world.identity.executionWorldGenerationId,
    bindings: active.bindings,
    retire: () => retireDockerExecutionWorldV1(active),
  };
}
