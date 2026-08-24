import type { AssistantMessage, ToolResultMessage } from "@alcode/agent-core";
import type {
  CapabilityResult,
  ProgramAttemptAuthorityAny,
} from "@alcode/agent-protocol";

export interface CognitionCapabilityRequest {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  expectedCapabilityRevision?: string;
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

/** Narrow Agent-local semantic client. It intentionally exposes no raw protocol primitives. */
export interface CognitionHostClient {
  requestCapability(request: CognitionCapabilityRequest): Promise<CapabilityResult>;
  recordAssistant(record: CognitionAssistantRecord): Promise<void>;
  recordToolResult(record: CognitionToolResultRecord): Promise<void>;
  reportIdle(record: CognitionIdleRecord): Promise<void>;
}
