import type { InferenceContext, Message, ModelProviderDescriptor } from "@alcode/agent-core";
import type {
  ContextUpdate,
  ContextUpdateV2,
  InferenceProviderDescriptorV1,
  InferenceToolCatalog,
  ProgramAttemptProjectionAny,
} from "@alcode/agent-protocol";

export interface RefreshedInferenceContext extends InferenceContext {
  receiptId: string;
  sourceEventSequence: number;
  effectiveMode: "verbatim-v1" | "graph-v1";
  inferenceEpochId?: string;
  toolCatalog?: InferenceToolCatalog;
  programAttempt?: ProgramAttemptProjectionAny;
}

export interface InferenceContextClient {
  requestContextUpdate(
    sessionId: string,
    providerDescriptor: InferenceProviderDescriptorV1,
    signal: AbortSignal,
  ): Promise<ContextUpdate | ContextUpdateV2>;
}

export function providerDescriptorToWire(descriptor: ModelProviderDescriptor): InferenceProviderDescriptorV1 {
  return {
    provider: descriptor.provider,
    model: descriptor.model,
    adapter: descriptor.adapter,
    adapterVersion: descriptor.adapterVersion,
    semanticConfig: structuredClone(descriptor.semanticConfig),
    semanticConfigDigest: descriptor.semanticConfigDigest,
  };
}

/** Request the Host-owned context + capability decision for one provider inference. */
export async function requestInferenceContext(
  client: InferenceContextClient,
  sessionId: string,
  providerDescriptor: ModelProviderDescriptor,
  signal: AbortSignal,
): Promise<RefreshedInferenceContext> {
  const update = await client.requestContextUpdate(
    sessionId,
    providerDescriptorToWire(providerDescriptor),
    signal,
  );
  return {
    systemPrompt: update.systemPrompt,
    messages: structuredClone(update.messages) as Message[],
    receiptId: update.receiptId,
    sourceEventSequence: update.sourceEventSequence,
    effectiveMode: update.effectiveMode,
    ...(update.inferenceEpochId !== undefined ? { inferenceEpochId: update.inferenceEpochId } : {}),
    ...(update.toolCatalog !== undefined ? { toolCatalog: structuredClone(update.toolCatalog) } : {}),
    ...(update.programAttempt !== undefined ? { programAttempt: structuredClone(update.programAttempt) } : {}),
  };
}
