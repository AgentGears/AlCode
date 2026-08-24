import type { ChildProcess } from "node:child_process";
import {
  assertAgentToHostMessageV2Aware,
  assertHostToAgentMessageV2Aware,
  type AgentToHostMessage,
  type HostToAgentMessage,
  type MessageHandler,
  type ProtocolTransport,
} from "@alcode/agent-protocol";

const MAX_PREHANDLER_MESSAGES = 32;

export function createChildProcessHostTransport(
  child: ChildProcess,
): ProtocolTransport<HostToAgentMessage, AgentToHostMessage> {
  const handlers = new Set<MessageHandler<AgentToHostMessage>>();
  const pending: AgentToHostMessage[] = [];
  const dispatch = (message: AgentToHostMessage) => {
    if (handlers.size === 0) {
      if (pending.length >= MAX_PREHANDLER_MESSAGES) throw new Error("Agent IPC pre-handler buffer overflow");
      pending.push(message);
      return;
    }
    for (const handler of [...handlers]) void Promise.resolve(handler(message));
  };
  const listener = (value: unknown) => {
    assertAgentToHostMessageV2Aware(value);
    dispatch(value as AgentToHostMessage);
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
      if (pending.length > 0) {
        const buffered = pending.splice(0, pending.length);
        for (const message of buffered) void Promise.resolve(handler(message));
      }
      return () => handlers.delete(handler);
    },
    async close(): Promise<void> {
      child.off("message", listener);
      handlers.clear();
      pending.length = 0;
      if (child.connected) child.disconnect();
    },
  };
}

export function createProcessAgentTransport(
  proc: NodeJS.Process = process,
): ProtocolTransport<AgentToHostMessage, HostToAgentMessage> {
  const handlers = new Set<MessageHandler<HostToAgentMessage>>();
  const pending: HostToAgentMessage[] = [];
  const dispatch = (message: HostToAgentMessage) => {
    if (handlers.size === 0) {
      if (pending.length >= MAX_PREHANDLER_MESSAGES) throw new Error("Host IPC pre-handler buffer overflow");
      pending.push(message);
      return;
    }
    for (const handler of [...handlers]) void Promise.resolve(handler(message));
  };
  const listener = (value: unknown) => {
    assertHostToAgentMessageV2Aware(value);
    dispatch(value as HostToAgentMessage);
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
