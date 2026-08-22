import { describe, expect, it } from "vitest";
import {
  PROGRAM_EXECUTION_MESSAGE_VERSION,
  type AgentToHostMessage,
  type HostToAgentMessage,
  type ProtocolTransport,
} from "@alcode/agent-protocol";
import { createAgentProtocolBridgeForTransport } from "./agent-protocol-bridge.ts";

class PlanningReadTransport implements ProtocolTransport<AgentToHostMessage, HostToAgentMessage> {
  sent: AgentToHostMessage[] = [];
  private handler: ((message: HostToAgentMessage) => void) | undefined;

  async send(message: AgentToHostMessage): Promise<void> {
    this.sent.push(structuredClone(message));
    if (message.type !== "program.planning.read") return;
    queueMicrotask(() => this.handler?.({
      type: "program.planning.read.result",
      version: PROGRAM_EXECUTION_MESSAGE_VERSION,
      requestId: message.requestId,
      sessionId: message.sessionId,
      planningEpisodeId: message.planningEpisodeId,
      outcome: "succeeded",
      result: { path: "src", entries: [], complete: true },
    }));
  }

  onMessage(handler: (message: HostToAgentMessage) => void): () => void {
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = undefined;
    };
  }

  async close(): Promise<void> {}
}

describe("P-01 semantic planning read bridge", () => {
  it("routes planning observations through AgentProtocolClient without exposing raw send", async () => {
    const transport = new PlanningReadTransport();
    const client = createAgentProtocolBridgeForTransport(transport);
    const result = await client.requestProgramPlanningRead({
      sessionId: "session-1",
      planningEpisodeId: "episode-1",
      readContractId: "workspace.list_tree",
      readContractVersion: 1,
      args: { path: "src" },
    });

    expect(result.outcome).toBe("succeeded");
    expect(result.result).toEqual({ path: "src", entries: [], complete: true });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({
      type: "program.planning.read",
      sessionId: "session-1",
      planningEpisodeId: "episode-1",
      readContractId: "workspace.list_tree",
      readContractVersion: 1,
      args: { path: "src" },
    });
    expect("send" in client).toBe(false);
    await client.close();
  });
});
