// Replaceable Agent process for Phase 0.5.
//
// This process owns the model loop only. It does NOT import storage, workspace,
// memory, reasoning, or Host runtime. Every cognition/environmental tool is a
// protocol proxy registered by the thin cognition extension.

import { runAgentLoop, StaticExtensionHost, type ModelEvent, type ModelProvider, type ModelRequest, type ModelStream } from "@alcode/agent-core";
import { AGENT_PROTOCOL_VERSION, type ContextProvide, type HostToAgentMessage } from "@alcode/agent-protocol";
import { createCognitionExtension } from "@alcode/cognition-extension";
import { createProcessAgentTransport } from "@alcode/host-runtime";

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
    for (const call of turn.toolCalls ?? []) {
      events.push({ type: "tool_call", id: call.id, name: call.name, arguments: call.arguments });
    }
    events.push({
      type: "done",
      stopReason: turn.stopReason ?? ((turn.toolCalls?.length ?? 0) > 0 ? "tool_use" : "stop"),
      ...(turn.errorMessage !== undefined ? { errorMessage: turn.errorMessage } : {}),
    });
    return {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          async next(): Promise<IteratorResult<ModelEvent>> {
            const value = events[i++];
            return value === undefined ? { value: undefined, done: true } : { value, done: false };
          },
        };
      },
    };
  }
}

function loadScript(): ScriptedTurn[] {
  const raw = process.env.ALCODE_AGENT_SCRIPT;
  if (!raw) return [{ text: "ALCODE Agent is ready.", stopReason: "stop" }];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("ALCODE_AGENT_SCRIPT must be a JSON array");
  return parsed as ScriptedTurn[];
}

async function main(): Promise<void> {
  const generationId = process.env.ALCODE_AGENT_GENERATION_ID;
  if (!generationId) throw new Error("ALCODE_AGENT_GENERATION_ID is required");

  const transport = createProcessAgentTransport();
  let sessionId: string | null = null;
  let context: ContextProvide | null = null;
  let abortController = new AbortController();
  let runChain: Promise<void> = Promise.resolve();

  await transport.send({
    type: "agent.hello",
    protocolVersion: AGENT_PROTOCOL_VERSION,
    generationId,
    capabilities: ["capability.request", "criterion.evidence", "agent.idle"],
  });

  const runInput = async (text: string): Promise<void> => {
    if (!sessionId || !context) throw new Error("Agent received input before session/context bootstrap");
    const localSessionId = sessionId;
    const localContext = context;
    const extensionHost = new StaticExtensionHost();
    await extensionHost.mount([createCognitionExtension({
      transport,
      sessionId: () => localSessionId,
      toolNames: localContext.toolNames,
    })]);

    const provider = new ScriptedWorkerProvider(loadScript());
    try {
      await runAgentLoop(text, {
        systemPrompt: localContext.systemPrompt,
        provider,
        tools: extensionHost.getTools(),
        emit: (event) => extensionHost.emit(event),
        signal: abortController.signal,
      });
    } catch (error) {
      await transport.send({
        type: "agent.error",
        requestId: crypto.randomUUID(),
        sessionId: localSessionId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  transport.onMessage((message: HostToAgentMessage) => {
    switch (message.type) {
      case "host.hello":
        if (message.protocolVersion !== AGENT_PROTOCOL_VERSION) {
          throw new Error(`Host protocol version ${message.protocolVersion} is incompatible`);
        }
        break;
      case "session.open":
      case "session.resume":
        sessionId = message.sessionId;
        break;
      case "context.provide":
        context = message;
        break;
      case "input.admitted":
        if (message.sessionId !== sessionId) throw new Error("input.admitted session mismatch");
        runChain = runChain.then(() => runInput(message.text));
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
      case "capability.result":
        // Consumed by the proxy tool's request-scoped listener.
        break;
    }
  });
}

main().catch(async (error) => {
  try {
    if (typeof process.send === "function") {
      process.send({
        type: "agent.error",
        requestId: crypto.randomUUID(),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    process.exit(1);
  }
});
