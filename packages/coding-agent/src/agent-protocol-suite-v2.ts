import {
  createProcessAgentTransport,
  type AgentToHostMessageV2Aware,
  type HostToAgentMessageV2Aware,
  type ProtocolTransport,
} from "@alcode/agent-protocol";
import {
  createAgentProtocolBridgeV2ForTransport,
  type AgentProtocolClientV2,
} from "./agent-protocol-bridge-v2.ts";
import {
  createProgramRevisionProtocolClientV1,
  type ProgramRevisionProtocolClientV1,
} from "./program-revision-protocol-client-v1.ts";

/**
 * Privileged production composition for the replaceable Agent process.
 * Raw IPC transport authority terminates here; normal worker/runtime consumers
 * receive only semantic protocol clients. Both clients share one exact process
 * transport so execution and semantic-revision traffic cannot drift onto
 * parallel Agent connections.
 */
export interface ProcessAdaptiveAgentProtocolSuiteV1 {
  adaptiveProtocol: AgentProtocolClientV2;
  revisionProtocol: ProgramRevisionProtocolClientV1;
}

export function createProcessAdaptiveAgentProtocolSuiteV1(): ProcessAdaptiveAgentProtocolSuiteV1 {
  const transport = createProcessAgentTransport() as unknown as ProtocolTransport<
    AgentToHostMessageV2Aware,
    HostToAgentMessageV2Aware
  >;
  return Object.freeze({
    adaptiveProtocol: createAgentProtocolBridgeV2ForTransport(transport),
    // Production proposal lifetime is owned by the exact Agent generation and
    // shared transport. Do not let an Agent-side wall-clock timeout abandon a
    // Host-consumed planning episode while validation/sealing is still in flight.
    revisionProtocol: createProgramRevisionProtocolClientV1(transport, { proposalTimeoutMs: null }),
  });
}
