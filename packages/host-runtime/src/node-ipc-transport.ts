import type { ChildProcess } from "node:child_process";
import {
  assertAgentToHostMessage,
  assertHostToAgentMessage,
  type AgentToHostMessage,
  type HostToAgentMessage,
  type MessageHandler,
  type ProtocolTransport,
} from "@alcode/agent-protocol";

export function createChildProcessHostTransport(
  child: ChildProcess,
): ProtocolTransport<HostToAgentMessage, AgentToHostMessage> {
  const handlers = new Set<MessageHandler<AgentToHostMessage>>();
  const listener = (value: unknown) => {
    assertAgentToHostMessage(value);
    for (const handler of [...handlers]) void Promise.resolve(handler(value));
  };
  child.on("message", listener);

  return {
    async send(message: HostToAgentMessage): Promise<void> {
      if (!child.connected) throw new Error("Agent IPC channel is not connected");
      await new Promise<void>((resolve, reject) => {
        child.send(message, (error) => error ? reject(error) : resolve());
      });
    },
    onMessage(handler: MessageHandler<AgentToHostMessage>): () => void {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async close(): Promise<void> {
      child.off("message", listener);
      handlers.clear();
      if (child.connected) child.disconnect();
    },
  };
}

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
