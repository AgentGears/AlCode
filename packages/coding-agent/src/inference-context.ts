import type { InferenceContext, Message } from "@alcode/agent-core";
import type {
  ContextUpdate,
  InferenceToolCatalog,
  ProgramAttemptProjectionV1,
} from "@alcode/agent-protocol";

export interface RefreshedInferenceContext extends InferenceContext {
  toolCatalog?: InferenceToolCatalog;
  programAttempt?: ProgramAttemptProjectionV1;
}

export interface InferenceContextClient {
  requestContextUpdate(sessionId: string, signal: AbortSignal): Promise<ContextUpdate>;
}

/** Request the Host-owned context + capability decision for one provider inference. */
export async function requestInferenceContext(
  client: InferenceContextClient,
  sessionId: string,
  signal: AbortSignal,
): Promise<RefreshedInferenceContext> {
  const update = await client.requestContextUpdate(sessionId, signal);
  return {
    systemPrompt: update.systemPrompt,
    messages: structuredClone(update.messages) as Message[],
    ...(update.toolCatalog !== undefined ? { toolCatalog: structuredClone(update.toolCatalog) } : {}),
    ...(update.programAttempt !== undefined ? { programAttempt: structuredClone(update.programAttempt) } : {}),
  };
}
