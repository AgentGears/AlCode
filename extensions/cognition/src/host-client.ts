import type { AssistantMessage, ToolResultMessage } from "@alcode/agent-core";
import type {
  CapabilityResult,
  ProgramAttemptAuthorityAny,
  ProgramAttemptAuthorityV1,
} from "@alcode/agent-protocol";

export interface CognitionCapabilityRequest {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  expectedCapabilityRevision?: string;
  /** Agent-local cancellation only; never serialized as Host authority. */
  signal?: AbortSignal;
  programAttemptAuthority?: ProgramAttemptAuthorityV1;
  /** A2 causal provenance only; never accepted as capability authority. */
  inferenceEpochId?: string;
  /** Explicit S-02 lineage; never inferred durably from toolCallId spelling. */
  parentToolCallId?: string;
  localSubcallIndex?: number;
}

/** Transitional semantic request used only by V2-aware Agent protocol clients. */
export interface CognitionCapabilityRequestV2Aware
extends Omit<CognitionCapabilityRequest, "programAttemptAuthority"> {
  programAttemptAuthority?: ProgramAttemptAuthorityAny;
}

export interface CognitionAssistantRecord {
  sessionId: string;
  text: string;
  content: AssistantMessage["content"];
  stopReason: AssistantMessage["stopReason"];
  errorMessage?: string;
  timestamp: number;
  durable: boolean;
  inferenceEpochId?: string;
}

export interface CognitionToolResultRecord {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  content: ToolResultMessage["content"];
  isError: boolean;
  timestamp: number;
}

export interface CognitionIdleRecord {
  sessionId: string;
  reason: "stop" | "max_steps" | "cancelled";
}

/** Narrow legacy Agent-local semantic client. It intentionally exposes no raw protocol primitives. */
export interface CognitionHostClient {
  requestCapability(request: CognitionCapabilityRequest): Promise<CapabilityResult>;
  recordAssistant(record: CognitionAssistantRecord): Promise<void>;
  recordToolResult(record: CognitionToolResultRecord): Promise<void>;
  reportIdle(record: CognitionIdleRecord): Promise<void>;
}

/** V2-aware semantic client; the legacy client remains strictly V1. */
export interface CognitionHostClientV2Aware
extends Omit<CognitionHostClient, "requestCapability"> {
  requestCapability(request: CognitionCapabilityRequestV2Aware): Promise<CapabilityResult>;
}
