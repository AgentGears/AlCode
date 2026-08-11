import type { AgentExtension } from "@alcode/agent-core";
import type {
  AgentToHostMessage,
  HostToAgentMessage,
  ProtocolTransport,
} from "@alcode/agent-protocol";
import { createAgentEventForwarder } from "./event-adapter.ts";
import { createProtocolProxyTool } from "./proxy-tools.ts";

export interface CognitionExtensionOptions {
  transport: ProtocolTransport<AgentToHostMessage, HostToAgentMessage>;
  sessionId: () => string;
  toolNames: readonly string[];
  readOnlyTools?: ReadonlySet<string>;
  /** Defaults true; false exists only for pre-0.6 compatibility paths. */
  durableTranscript?: boolean;
}

export function createCognitionExtension(options: CognitionExtensionOptions): AgentExtension {
  return {
    name: "cognition",
    register(context) {
      for (const name of options.toolNames) {
        context.registerTool(createProtocolProxyTool({
          name,
          sessionId: options.sessionId,
          transport: options.transport,
          ...(options.readOnlyTools ? { isReadOnly: options.readOnlyTools.has(name) } : {}),
        }));
      }
      context.onEvent(createAgentEventForwarder(
        options.transport,
        options.sessionId,
        options.durableTranscript ?? true,
      ));
    },
  };
}

export { createProtocolProxyTool, type ProxyToolOptions } from "./proxy-tools.ts";
export { createAgentEventForwarder } from "./event-adapter.ts";
