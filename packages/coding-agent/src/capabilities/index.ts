// Capability contracts and LocalWorkspace implementation.
// See docs/adr/0005-runtime-ownership-boundaries.md.

export type {
  Workspace,
  WorkspaceIdentity,
  FilesystemCapability,
  TerminalCapability,
  FilesystemReadRequest,
  FilesystemReadResult,
  FilesystemWriteRequest,
  FilesystemWriteResult,
  FilesystemEditRequest,
  FilesystemEditResult,
  FilesystemListRequest,
  FilesystemListEntry,
  FilesystemGrepRequest,
  FilesystemSearchResult,
  FilesystemFindRequest,
  TerminalExecuteRequest,
  TerminalExecuteResult,
} from "./types.ts";

export { createLocalWorkspace } from "./local-workspace.ts";
