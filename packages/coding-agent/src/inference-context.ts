import { randomUUID } from "node:crypto";
import type { InferenceContext, Message } from "@alcode/agent-core";
import type {
  AgentToHostMessage,
  ContextUpdate,
  HostToAgentMessage,
  InferenceToolCatalog,
  ProtocolTransport,
} from "@alcode/agent-protocol";

export interface RefreshedInferenceContext extends InferenceContext {
  toolCatalog?: InferenceToolCatalog;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(signal.reason === undefined ? "context refresh aborted" : String(signal.reason));
}

/** Request the Host-owned context + capability decision for one provider inference. */
export async function requestInferenceContext(
  transport: ProtocolTransport<AgentToHostMessage, HostToAgentMessage>,
  sessionId: string,
  signal: AbortSignal,
): Promise<RefreshedInferenceContext> {
  if (signal.aborted) throw abortError(signal);
  const requestId = randomUUID();
  const update = await new Promise<ContextUpdate>((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => {};
    const cleanup = () => { unsubscribe(); signal.removeEventListener("abort", onAbort); };
    const fail = (error: unknown) => { if (settled) return; settled = true; cleanup(); reject(error); };
    const succeed = (response: ContextUpdate) => { if (settled) return; settled = true; cleanup(); resolve(response); };
    const onAbort = () => fail(abortError(signal));
    const registeredUnsubscribe = transport.onMessage((response) => {
      if (response.type !== "context.update" || response.requestId !== requestId || response.sessionId !== sessionId) return;
      succeed(response);
    });
    unsubscribe = registeredUnsubscribe;
    if (settled) { unsubscribe(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    try {
      void transport.send({ type: "context.refresh.request", requestId, sessionId }).catch(fail);
    } catch (error) { fail(error); }
  });
  return {
    systemPrompt: update.systemPrompt,
    messages: structuredClone(update.messages) as Message[],
    ...(update.toolCatalog !== undefined ? { toolCatalog: structuredClone(update.toolCatalog) } : {}),
  };
}
