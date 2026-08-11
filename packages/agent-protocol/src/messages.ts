export const AGENT_PROTOCOL_VERSION = 1 as const;

export type ProtocolRequestId = string;
export type AgentGenerationId = string;

export interface AgentHello {
  type: "agent.hello";
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  generationId: AgentGenerationId;
  capabilities: string[];
}

export interface AssistantMessageProduced {
  type: "assistant.message";
  requestId: ProtocolRequestId;
  sessionId: string;
  text: string;
}

export interface CapabilityRequest {
  type: "capability.request";
  requestId: ProtocolRequestId;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface CriterionEvidence {
  type: "criterion.evidence";
  requestId: ProtocolRequestId;
  sessionId: string;
  evidenceType: string;
  data?: unknown;
}

export interface AgentIdle {
  type: "agent.idle";
  requestId: ProtocolRequestId;
  sessionId: string;
  reason: "stop" | "max_steps" | "cancelled";
}

export interface AgentError {
  type: "agent.error";
  requestId: ProtocolRequestId;
  sessionId?: string;
  message: string;
}

export type AgentToHostMessage =
  | AgentHello
  | AssistantMessageProduced
  | CapabilityRequest
  | CriterionEvidence
  | AgentIdle
  | AgentError;

export interface HostHello {
  type: "host.hello";
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  hostInstanceId: string;
}

export interface SessionOpen {
  type: "session.open";
  requestId: ProtocolRequestId;
  sessionId: string;
  workspaceId: string;
}

export interface SessionResume {
  type: "session.resume";
  requestId: ProtocolRequestId;
  sessionId: string;
  workspaceId: string;
  reason: "agent_replaced" | "host_reopened" | "reattach";
}

export interface InputAdmitted {
  type: "input.admitted";
  requestId: ProtocolRequestId;
  sessionId: string;
  text: string;
}

export interface ContextProvide {
  type: "context.provide";
  requestId: ProtocolRequestId;
  sessionId: string;
  systemPrompt: string;
  orientationRequired: boolean;
  toolNames: string[];
}

export interface CapabilityResult {
  type: "capability.result";
  requestId: ProtocolRequestId;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  operationId?: string;
  outcome: "succeeded" | "failed" | "cancelled" | "timed_out" | "denied";
  result?: unknown;
  error?: string;
}

export interface Cancel {
  type: "cancel";
  requestId: ProtocolRequestId;
  sessionId: string;
  reason?: string;
}

export interface Shutdown {
  type: "shutdown";
  requestId: ProtocolRequestId;
  sessionId?: string;
  reason: "completed" | "cancelled" | "host_shutdown" | "replaced";
}

export type HostToAgentMessage =
  | HostHello
  | SessionOpen
  | SessionResume
  | InputAdmitted
  | ContextProvide
  | CapabilityResult
  | Cancel
  | Shutdown;

export type AgentProtocolMessage = AgentToHostMessage | HostToAgentMessage;
