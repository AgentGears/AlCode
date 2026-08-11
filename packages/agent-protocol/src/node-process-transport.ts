import {
  assertHostToAgentMessage,
} from "./validation.ts";
import type { AgentToHostMessage, HostToAgentMessage } from "./messages.ts";
import type { MessageHandler, ProtocolTransport } from "./transport.ts";

/** Process-side adapter for the local Node IPC transport used in Phase 0.5. */
export function createProcessAgentTransport(
  proc: NodeJS.Process = process,
): ProtocolTransport<AgentToHostMessage, HostToAgentMessage> {
  const handlers = new Set<MessageHandler<HostToAgentMessage>>();
  const listener = (value: unknown) => {
    assertHostToAgentMessage(value);
    for (const handler of [...handlers]) void Promise.resolve(handler(value));
  };
  proc.on("message", listener);

  return {
    async send(message: AgentToHostMessage): Promise<void> {
      if (typeof proc.send !== "function") throw new Error("Agent process has no IPC channel");
      await new Promise<void>((resolve, reject) => {
        proc.send!(message, (error) => error ? reject(error) : resolve());
      });
    },
    onMessage(handler: MessageHandler<HostToAgentMessage>): () => void {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async close(): Promise<void> {
      proc.off("message", listener);
      handlers.clear();
      if (typeof proc.disconnect === "function" && proc.connected) proc.disconnect();
    },
  };
}
