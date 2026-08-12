// Replaceable Agent process. The worker owns only the model loop and a
// disposable in-memory message cache hydrated from Host-provided durability.
// It does NOT import storage, workspace, memory, reasoning, or Host runtime.

import { randomUUID } from "node:crypto";
import {
  runAgentLoop,
  StaticExtensionHost,
  type InferenceContext,
  type Message,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
  type ModelStream,
} from "@alcode/agent-core";
import {
  AGENT_PROTOCOL_VERSION,
  DURABLE_TRANSCRIPT_CAPABILITY,
  GRAPH_CONTEXT_CAPABILITY,
  createProcessAgentTransport,
  type ContextProvide,
  type ContextUpdate,
  type HostToAgentMessage,
} from "@alcode/agent-protocol";
import { createCognitionExtension } from "@alcode/cognition-extension";
import { TestModelProvider } from "./test-model-provider.ts";

interface ScriptedTurn {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  stopReason?: "stop" | "length" | "tool_use" | "error" | "aborted";
  errorMessage?: string;
}

class ScriptedWorkerProvider implements ModelProvider {
  private index = 0;
  constructor(private readonly turns: readonly ScriptedTurn[]) {}
  async stream(_request: ModelRequest): Promise<ModelStream> {
    const turn = this.turns[this.index++] ?? { text: "ALCODE Agent is idle.", stopReason: "stop" as const };
    const events: ModelEvent[] = [];
    if (turn.text !== undefined) events.push({ type: "text_delta", text: turn.text });
    for (const call of turn.toolCalls ?? []) events.push({ type: "tool_call", id: call.id, name: call.name, arguments: call.arguments });
    events.push({ type: "done", stopReason: turn.stopReason ?? ((turn.toolCalls?.length ?? 0) > 0 ? "tool_use" : "stop"), ...(turn.errorMessage !== undefined ? { errorMessage: turn.errorMessage } : {}) });
    return {
      [Symbol.asyncIterator]() {
        let i = 0;
        return { async next(): Promise<IteratorResult<ModelEvent>> {
          const value = events[i++];
          return value === undefined ? { value: undefined, done: true } : { value, done: false };
        }};
      },
    };
  }
}

function createProvider(): ModelProvider {
  const raw = process.env.ALCODE_AGENT_SCRIPT;
  if (raw) {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("ALCODE_AGENT_SCRIPT must be a JSON array");
    return new ScriptedWorkerProvider(parsed as ScriptedTurn[]);
  }
  return new TestModelProvider([
    { match: "hello", text: "Hello from ALCODE. The agent loop is running." },
    { match: "*", text: "ALCODE received your prompt." },
  ]);
}

async function main(): Promise<void> {
  const generationId = process.env.ALCODE_AGENT_GENERATION_ID;
  if (!generationId) throw new Error("ALCODE_AGENT_GENERATION_ID is required");

  const transport = createProcessAgentTransport();
  let sessionId: string | null = null;
  let context: ContextProvide | null = null;
  let history: Message[] = [];
  let abortController = new AbortController();
  let runChain: Promise<void> = Promise.resolve();

  await transport.send({
    type: "agent.hello",
    protocolVersion: AGENT_PROTOCOL_VERSION,
    generationId,
    capabilities: [
      "capability.request",
      "criterion.evidence",
      "agent.idle",
      DURABLE_TRANSCRIPT_CAPABILITY,
      GRAPH_CONTEXT_CAPABILITY,
    ],
  });

  const requestInferenceContext = async (localSessionId: string): Promise<InferenceContext> => {
    const requestId = randomUUID();
    const update = await new Promise<ContextUpdate>((resolve, reject) => {
      const unsubscribe = transport.onMessage((response) => {
        if (response.type !== "context.update" || response.requestId !== requestId) return;
        unsubscribe();
        resolve(response);
      });
      transport.send({ type: "context.refresh.request", requestId, sessionId: localSessionId }).catch((error) => {
        unsubscribe();
        reject(error);
      });
    });
    return {
      systemPrompt: update.systemPrompt,
      messages: structuredClone(update.messages) as Message[],
    };
  };

  const runInput = async (text: string, timestamp?: number): Promise<void> => {
    if (!sessionId || !context) throw new Error("Agent received input before session/context bootstrap");
    if (context.verbatim?.status === "incomplete") {
      throw new Error(`context incomplete: unresolved tool calls ${context.verbatim.pendingToolCallIds.join(", ")}`);
    }

    const localSessionId = sessionId;
    const localContext = context;
    const extensionHost = new StaticExtensionHost();
    await extensionHost.mount([createCognitionExtension({
      transport,
      sessionId: () => localSessionId,
      toolNames: localContext.toolNames,
      durableTranscript: localContext.verbatim !== undefined,
    })]);

    const provider = createProvider();
    try {
      const completeHistory = await runAgentLoop(text, {
        systemPrompt: localContext.systemPrompt,
        provider,
        tools: extensionHost.getTools(),
        emit: (event) => extensionHost.emit(event),
        signal: abortController.signal,
        initialMessages: history,
        beforeInference: async () => requestInferenceContext(localSessionId),
        ...(timestamp !== undefined ? { promptTimestamp: timestamp } : {}),
      });
      history = completeHistory as Message[];
    } catch (error) {
      await transport.send({
        type: "agent.error",
        requestId: randomUUID(),
        sessionId: localSessionId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  transport.onMessage((message: HostToAgentMessage) => {
    switch (message.type) {
      case "host.hello":
        if (message.protocolVersion !== AGENT_PROTOCOL_VERSION) throw new Error(`Host protocol version ${message.protocolVersion} is incompatible`);
        break;
      case "session.open":
      case "session.resume":
        sessionId = message.sessionId;
        break;
      case "context.provide":
        context = message;
        history = message.verbatim ? structuredClone(message.verbatim.messages) as Message[] : [];
        break;
      case "input.admitted":
        if (message.sessionId !== sessionId) throw new Error("input.admitted session mismatch");
        runChain = runChain.then(() => runInput(message.text, message.timestamp));
        break;
      case "cancel":
        if (message.sessionId === sessionId) {
          abortController.abort(message.reason);
          abortController = new AbortController();
        }
        break;
      case "shutdown":
        abortController.abort(message.reason);
        void transport.close().finally(() => process.exit(0));
        break;
      case "context.update":
      case "capability.result":
      case "transcript.admitted":
        // Consumed by request-scoped listeners.
        break;
    }
  });
}

main().catch((error) => {
  try {
    if (typeof process.send === "function") {
      process.send({ type: "agent.error", requestId: randomUUID(), message: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    process.exit(1);
  }
});
