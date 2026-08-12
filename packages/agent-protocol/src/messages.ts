import type {
  TranscriptAssistantMessage,
  TranscriptMessage,
  TranscriptToolResultMessage,
} from "@alcode/transcript";

export const AGENT_PROTOCOL_VERSION = 1 as const;
export const DURABLE_TRANSCRIPT_CAPABILITY = "durable_transcript_v1" as const;
export const GRAPH_CONTEXT_CAPABILITY = "graph_context_v1" as const;
export const VERBATIM_COMPILER_VERSION = "verbatim-v1" as const;

export type ProtocolRequestId = string;
export type AgentGenerationId = string;

export interface AgentHello { type: "agent.hello"; protocolVersion: typeof AGENT_PROTOCOL_VERSION; generationId: AgentGenerationId; capabilities: string[]; }
export interface AssistantMessageProduced { type: "assistant.message"; requestId: ProtocolRequestId; sessionId: string; text: string; content?: TranscriptAssistantMessage["content"]; stopReason?: TranscriptAssistantMessage["stopReason"]; errorMessage?: string; timestamp?: number; }
export interface ToolResultProduced { type: "tool.result"; requestId: ProtocolRequestId; sessionId: string; toolCallId: string; toolName: string; content: TranscriptToolResultMessage["content"]; isError: boolean; timestamp: number; operationId?: string; }
export interface CapabilityRequest { type: "capability.request"; requestId: ProtocolRequestId; sessionId: string; toolCallId: string; toolName: string; args: unknown; }
export interface ContextRefreshRequest { type: "context.refresh.request"; requestId: ProtocolRequestId; sessionId: string; }
export interface CriterionEvidence { type: "criterion.evidence"; requestId: ProtocolRequestId; sessionId: string; evidenceType: string; data?: unknown; }
export interface AgentIdle { type: "agent.idle"; requestId: ProtocolRequestId; sessionId: string; reason: "stop" | "max_steps" | "cancelled"; }
export interface AgentError { type: "agent.error"; requestId: ProtocolRequestId; sessionId?: string; message: string; }

export type AgentToHostMessage = AgentHello | AssistantMessageProduced | ToolResultProduced | CapabilityRequest | ContextRefreshRequest | CriterionEvidence | AgentIdle | AgentError;

export interface HostHello { type: "host.hello"; protocolVersion: typeof AGENT_PROTOCOL_VERSION; hostInstanceId: string; }
export interface SessionOpen { type: "session.open"; requestId: ProtocolRequestId; sessionId: string; workspaceId: string; }
export interface SessionResume { type: "session.resume"; requestId: ProtocolRequestId; sessionId: string; workspaceId: string; reason: "agent_replaced" | "host_reopened" | "reattach"; }
export interface InputAdmitted { type: "input.admitted"; requestId: ProtocolRequestId; sessionId: string; text: string; timestamp?: number; }

export interface VerbatimContextEnvelope {
  compilerVersion: typeof VERBATIM_COMPILER_VERSION;
  sourceEventSequence: number;
  messages: TranscriptMessage[];
  status: "complete" | "incomplete";
  pendingToolCallIds: string[];
  fidelity: "exact" | "legacy_text_only";
}

export interface ContextProvide { type: "context.provide"; requestId: ProtocolRequestId; sessionId: string; systemPrompt: string; orientationRequired: boolean; toolNames: string[]; verbatim?: VerbatimContextEnvelope; }

export interface ContextUpdate {
  type: "context.update";
  requestId: ProtocolRequestId;
  sessionId: string;
  receiptId: string;
  effectiveMode: "verbatim-v1" | "graph-v1";
  sourceEventSequence: number;
  systemPrompt: string;
  messages: TranscriptMessage[];
}

export interface TranscriptAdmitted { type: "transcript.admitted"; requestId: ProtocolRequestId; sessionId: string; eventId: string; sequence: number; }
export interface CapabilityResult { type: "capability.result"; requestId: ProtocolRequestId; sessionId: string; toolCallId: string; toolName: string; operationId?: string; outcome: "succeeded" | "failed" | "cancelled" | "timed_out" | "denied"; result?: unknown; error?: string; }
export interface Cancel { type: "cancel"; requestId: ProtocolRequestId; sessionId: string; reason?: string; }
export interface Shutdown { type: "shutdown"; requestId: ProtocolRequestId; sessionId?: string; reason: "completed" | "cancelled" | "host_shutdown" | "replaced"; }

export type HostToAgentMessage = HostHello | SessionOpen | SessionResume | InputAdmitted | ContextProvide | ContextUpdate | TranscriptAdmitted | CapabilityResult | Cancel | Shutdown;
export type AgentProtocolMessage = AgentToHostMessage | HostToAgentMessage;
