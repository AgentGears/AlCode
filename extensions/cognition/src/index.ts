import type { AgentExtension } from "@alcode/agent-core";
import { createAgentEventForwarder } from "./event-adapter.ts";
import type { CognitionHostClient } from "./host-client.ts";
import { createProtocolProxyTool } from "./proxy-tools.ts";

export interface CognitionExtensionOptions {
  client: CognitionHostClient;
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
          client: options.client,
          ...(options.readOnlyTools ? { isReadOnly: options.readOnlyTools.has(name) } : {}),
        }));
      }
      context.onEvent(createAgentEventForwarder(
        options.client,
        options.sessionId,
        options.durableTranscript ?? true,
      ));
    },
  };
}

export {
  type CognitionAssistantRecord,
  type CognitionCapabilityRequest,
  type CognitionHostClient,
  type CognitionIdleRecord,
  type CognitionToolResultRecord,
} from "./host-client.ts";
export { createProtocolProxyTool, type ProxyToolOptions } from "./proxy-tools.ts";
export { createAgentEventForwarder } from "./event-adapter.ts";
