// @alcode/agent-core — ALCODE-owned agent loop, contracts, and extension host.
//
// The agent loop semantics are derived from pi v0.81.1 (see ./imported/ for
// the verified reference slice and docs/provenance/pi.md for provenance), but
// the public API is fresh owned TypeScript — no pi-ai dependency.

// Contracts
export type {
  TextContent,
  ImageContent,
  ContentBlock,
  UserMessage,
  ToolCallContent,
  AssistantMessage,
  ToolResultMessage,
  Message,
  CustomAgentMessages,
  AgentMessage,
  ToolInputSchema,
  AgentToolResult,
  ToolExecutionOutcome,
  ToolExecutionContext,
  AgentTool,
  ToolDefinition,
  ModelRequest,
  ModelEvent,
  ModelStream,
  ModelProvider,
  AgentContext,
  AgentEvent,
  AgentEventSink,
} from "./contracts.ts";

// Agent loop
export { runAgentLoop, type AgentLoopOptions } from "./agent-loop.ts";

// Extension host
export {
  type ExtensionContext,
  type AgentExtension,
  StaticExtensionHost,
} from "./extension-host.ts";
