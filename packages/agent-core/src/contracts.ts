// ALCODE-owned agent contracts. These define the minimal surface for a
// tool-calling agent loop. They are NOT derived from pi-ai's type system;
// they are fresh owned types that implement the same semantics.
//
// The imported pi v0.81.1 agent-loop slice under ./imported/ is the
// provenance reference for loop behavior (steering, follow-ups, before/after
// hooks). This file is the owned public contract.

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  // Opaque image data; format-specific for the provider adapter.
  data: string;
  mediaType?: string;
}

export type ContentBlock = TextContent | ImageContent;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface UserMessage {
  role: "user";
  content: ContentBlock[];
  timestamp: number;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ToolCallContent)[];
  stopReason: "stop" | "length" | "tool_use" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: TextContent[];
  isError: boolean;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/**
 * AgentMessage — extensible via declaration merging like pi's, but the base
 * type is ALCODE-owned (not re-exported from pi-ai).
 */
export interface CustomAgentMessages {}

export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

/**
 * The execution outcome a tool reports. When omitted, the agent loop infers
 * succeeded (normal return) or failed (thrown). Tools that can distinguish
 * cancellation or timeout (e.g. bash) populate this so the durable runtime
 * records the correct terminal state per ADR 0003.
 */
export type ToolExecutionOutcome = "succeeded" | "failed" | "cancelled" | "timed_out";

export interface AgentToolResult<TDetails = unknown> {
  content: TextContent[];
  details: TDetails;
  /** Tool-reported outcome; defaults to succeeded (return) or failed (throw). */
  executionOutcome?: ToolExecutionOutcome;
  terminate?: boolean;
}

export interface ToolExecutionContext {
  signal?: AbortSignal;
  workingDirectory?: string;
}

export interface AgentTool<TInput = Record<string, unknown>, TResult = unknown> {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  execute(input: TInput, context: ToolExecutionContext): Promise<AgentToolResult<TResult>>;
  /**
   * If true, the tool is guaranteed to have no external side effects (pure
   * read). The durable runtime uses this to set EffectStatus=not_applicable
   * and skip reconciliation. Defaults to false when omitted.
   */
  readonly isReadOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Model provider
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

export interface ModelRequest {
  systemPrompt: string;
  messages: readonly Message[];
  tools: readonly ToolDefinition[];
  signal?: AbortSignal;
}

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "done"; stopReason: AssistantMessage["stopReason"]; errorMessage?: string }
  | { type: "error"; message: string };

export interface ModelStream {
  [Symbol.asyncIterator](): AsyncIterator<ModelEvent>;
}

export interface ModelProvider {
  stream(request: ModelRequest): Promise<ModelStream>;
}

// ---------------------------------------------------------------------------
// Agent context and events
// ---------------------------------------------------------------------------

export interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: AgentTool[];
}

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: AgentToolResult; isError: boolean; outcome: ToolExecutionOutcome };

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;
