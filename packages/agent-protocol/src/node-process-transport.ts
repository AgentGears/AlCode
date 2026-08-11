import { assertHostToAgentMessage } from "./validation.ts";
import type { AgentToHostMessage, HostToAgentMessage } from "./messages.ts";
import type { MessageHandler, ProtocolTransport } from "./transport.ts";

const MAX_PREHANDLER_MESSAGES = 32;

/** Process-side adapter for the local Node IPC transport used in Phase 0.5. */
export function createProcessAgentTransport(
  proc: NodeJS.Process = process,
): ProtocolTransport<AgentToHostMessage, HostToAgentMessage> {
  const handlers = new Set<MessageHandler<HostToAgentMessage>>();
  const pending: HostToAgentMessage[] = [];

  const listener = (value: unknown) => {
    assertHostToAgentMessage(value);
    if (handlers.size === 0) {
      if (pending.length >= MAX_PREHANDLER_MESSAGES) {
        throw new Error("Host IPC pre-handler buffer overflow");
      }
      pending.push(value);
      return;
    }
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
      if (pending.length > 0) {
        const buffered = pending.splice(0, pending.length);
        for (const message of buffered) void Promise.resolve(handler(message));
      }
      return () => handlers.delete(handler);
    },
    async close(): Promise<void> {
      proc.off("message", listener);
      handlers.clear();
      pending.length = 0;
      if (typeof proc.disconnect === "function" && proc.connected) proc.disconnect();
    },
  };
}
