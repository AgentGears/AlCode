// @alcode/coding-agent — the application layer.
export { TestModelProvider, type CannedModelResponse } from "./test-model-provider.ts";
export { createBashTool, type BashToolInput, type BashToolDetails } from "./tools/bash.ts";
export { createReadTool, type ReadToolInput, type ReadToolDetails } from "./tools/read.ts";
export { createWriteTool, type WriteToolInput, type WriteToolDetails } from "./tools/write.ts";
export { createEditTool, type EditToolInput, type EditToolDetails } from "./tools/edit.ts";
export { createGrepTool, type GrepToolInput, type GrepToolDetails } from "./tools/grep.ts";
export { createLsTool, type LsToolInput, type LsToolDetails } from "./tools/ls.ts";
export { createFindTool, type FindToolInput, type FindToolDetails } from "./tools/find.ts";
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
export { GitWorkspaceContextProvider, type GitCommandRunner } from "./workspace-context.ts";
export {
  agentToolAsHostCapability,
  createDefaultHostCapabilities,
} from "./host-capabilities.ts";
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
export {
  createProgramRevisionProtocolClientV1,
  ProgramRevisionProtocolClientClosedError,
  type ProgramRevisionProposalClientInputV1,
  type ProgramRevisionProtocolClientV1,
} from "./program-revision-protocol-client-v1.ts";
