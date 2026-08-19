// @alcode/agent-core — ALCODE-owned agent loop, contracts, scoped runtime, and extension host.
//
// The agent loop semantics are derived from pi v0.81.1 (see ./imported/ for
// the verified reference slice and docs/provenance/pi.md for provenance), but
// the public API is fresh owned TypeScript — no pi-ai dependency.

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

export { runAgentLoop, type AgentLoopOptions, type InferenceContext } from "./agent-loop.ts";

export {
  AgentRuntime,
  AgentRuntimeMountError,
  DuplicateRuntimeModuleError,
  DuplicateServiceBindingError,
  ScopeDisposalError,
  ScopeNotOpenError,
  ServiceNotFoundError,
  createServiceToken,
  type AgentRuntimeConfig,
  type ChildScopeKind,
  type Disposer,
  type Registration,
  type RuntimeModule,
  type RuntimeScope,
  type ScopeAdmission,
  type ScopeKind,
  type ScopeState,
  type ServiceToken,
} from "./runtime-scope.ts";

export {
  type ExtensionContext,
  type AgentExtension,
  StaticExtensionHost,
} from "./extension-host.ts";
