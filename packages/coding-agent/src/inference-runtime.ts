import {
  createServiceToken,
  type AgentRuntime,
  type AgentTool,
  type RuntimeScope,
} from "@alcode/agent-core";
import type {
  CapabilityResult,
  InferenceToolCatalog,
  ProgramAttemptAuthorityAny,
} from "@alcode/agent-protocol";
import {
  createProtocolProxyTool,
  type CognitionCapabilityRequestV2Aware,
  type CognitionHostClientV2Aware,
} from "@alcode/cognition-extension";

export interface InferenceCapabilityClient {
  requestCapability(request: CognitionCapabilityRequestV2Aware): Promise<CapabilityResult>;
}

export const INFERENCE_CAPABILITY_CLIENT = createServiceToken<InferenceCapabilityClient>(
  "coding-agent.inference-capability-client.v1",
);

export interface InferenceCapabilityProjection {
  readonly scope: RuntimeScope;
  readonly tools?: readonly AgentTool[];
  dispose(): Promise<void>;
}

export interface CreateInferenceCapabilityProjectionOptions {
  runtime: AgentRuntime;
  client: Pick<CognitionHostClientV2Aware, "requestCapability">;
  sessionId: string;
  catalog?: InferenceToolCatalog | undefined;
  programAttemptAuthority?: ProgramAttemptAuthorityAny | undefined;
}

function createScopedCapabilityClient(
  scope: RuntimeScope,
  client: Pick<CognitionHostClientV2Aware, "requestCapability">,
): InferenceCapabilityClient {
  return {
    async requestCapability(request) {
      const admission = scope.admit();
      try {
        return await client.requestCapability(request);
      } finally {
        admission.release();
      }
    },
  };
}

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
    scope.provide(INFERENCE_CAPABILITY_CLIENT, createScopedCapabilityClient(scope, options.client));
    if (options.catalog === undefined) return { scope, dispose };

    const client = scope.resolve(INFERENCE_CAPABILITY_CLIENT);
    const tools = options.catalog.tools.map((descriptor) => createProtocolProxyTool<ProgramAttemptAuthorityAny>({
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
