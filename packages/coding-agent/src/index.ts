// @alcode/coding-agent — the application layer.
export { TestModelProvider, type CannedModelResponse } from "./test-model-provider.ts";
export { createBashTool, type BashToolInput, type BashToolDetails } from "./tools/bash.ts";
export {
  type Workspace,
  type WorkspaceIdentity,
  type FilesystemCapability,
  type TerminalCapability,
  type FilesystemReadRequest,
  type FilesystemReadResult,
  type FilesystemWriteRequest,
  type FilesystemWriteResult,
  type FilesystemEditRequest,
  type FilesystemEditResult,
  type FilesystemListRequest,
  type FilesystemListEntry,
  type FilesystemGrepRequest,
  type FilesystemSearchResult,
  type FilesystemFindRequest,
  type TerminalExecuteRequest,
  type TerminalExecuteResult,
  createLocalWorkspace,
} from "./capabilities/index.ts";
export {
  runDurableAgent,
  type DurableAgentOptions,
  type DurableAgentResult,
} from "./durable-agent.ts";
export {
  startDurableSession,
  stopDurableSession,
  type StartDurableSessionOptions,
  type StartedSession,
} from "./session-lifecycle.ts";
export {
  createSessionsProjection,
  createSessionQuery,
  sessionStatements,
  SessionStateError,
  type SessionStartedPayload,
  type SessionStoppedPayload,
  type SessionRecord,
} from "./sessions-projection.ts";
