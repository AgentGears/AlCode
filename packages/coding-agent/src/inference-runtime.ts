import {
  createServiceToken,
  type AgentRuntime,
  type AgentTool,
  type RuntimeScope,
} from "@alcode/agent-core";
import type {
  CapabilityResult,
  InferenceToolCatalog,
  ProgramAttemptProjectionV1,
} from "@alcode/agent-protocol";
import {
  createProtocolProxyTool,
  type CognitionCapabilityRequest,
  type CognitionHostClient,
} from "@alcode/cognition-extension";

/**
 * Capability-only semantic client owned by exactly one inference scope.
 * Visibility through this client is not Host execution authorization.
 */
export interface InferenceCapabilityClient {
  requestCapability(request: CognitionCapabilityRequest): Promise<CapabilityResult>;
}

export const INFERENCE_CAPABILITY_CLIENT = createServiceToken<InferenceCapabilityClient>(
  "coding-agent.inference-capability-client.v1",
);

export interface InferenceCapabilityProjection {
  readonly scope: RuntimeScope;
  readonly tools?: readonly AgentTool[];
  /** Release the inference lifecycle lease, then quiescently close the scope. */
  dispose(): Promise<void>;
}

export interface CreateInferenceCapabilityProjectionOptions {
  runtime: AgentRuntime;
  client: Pick<CognitionHostClient, "requestCapability">;
  sessionId: string;
  catalog?: InferenceToolCatalog | undefined;
  programAttemptAuthority?: ProgramAttemptProjectionV1["authority"] | undefined;
}

function createScopedCapabilityClient(
  scope: RuntimeScope,
  client: Pick<CognitionHostClient, "requestCapability">,
): InferenceCapabilityClient {
  return {
    async requestCapability(request) {
      // Scope admission is a lifecycle fence only. The Host still performs
      // generation, ProgramAttempt, capability-revision, policy, and Operation
      // admission checks independently.
      const admission = scope.admit();
      try {
        return await client.requestCapability(request);
      } finally {
        admission.release();
      }
    },
  };
}

/**
 * Create the ephemeral Host-capability projection for exactly one provider
 * inference. A lifecycle admission remains held for the whole inference/tool
 * cycle, so Agent-generation disposal cannot close the protocol beneath live
 * inference work. `dispose()` releases that lease and then closes quiescently.
 */
export function createInferenceCapabilityProjection(
  options: CreateInferenceCapabilityProjectionOptions,
): InferenceCapabilityProjection {
  const scope = options.runtime.createInferenceScope();
  const lifecycleAdmission = scope.admit();
  let disposalPromise: Promise<void> | null = null;

  const dispose = (): Promise<void> => {
    if (disposalPromise !== null) return disposalPromise;
    lifecycleAdmission.release();
    disposalPromise = scope.dispose();
    return disposalPromise;
  };

  try {
    scope.provide(
      INFERENCE_CAPABILITY_CLIENT,
      createScopedCapabilityClient(scope, options.client),
    );

    if (options.catalog === undefined) return { scope, dispose };

    const client = scope.resolve(INFERENCE_CAPABILITY_CLIENT);
    const tools = options.catalog.tools.map((descriptor) => createProtocolProxyTool({
      name: descriptor.definition.name,
      description: descriptor.definition.description,
      inputSchema: descriptor.definition.inputSchema,
      ...(descriptor.isReadOnly !== undefined ? { isReadOnly: descriptor.isReadOnly } : {}),
      ...(descriptor.binding.kind === "dynamic"
        ? { expectedCapabilityRevision: descriptor.binding.revision }
        : {}),
      ...(options.programAttemptAuthority !== undefined
        ? { programAttemptAuthority: structuredClone(options.programAttemptAuthority) }
        : {}),
      sessionId: () => options.sessionId,
      client,
    }));

    return { scope, tools, dispose };
  } catch (error) {
    lifecycleAdmission.release();
    void scope.dispose().catch(() => {});
    throw error;
  }
}
