// Capability contracts — the Host-owned environmental boundary.
// See docs/adr/0005-runtime-ownership-boundaries.md §Host↔Capability.
//
// AgentTool adapters translate model-facing tool calls into capability
// requests. Capability implementations perform the environmental action.
// The adapter normalizes the result back into AgentToolResult.
//
// Phase 0.1B implements LocalWorkspace only. The contracts are designed
// so that SSH/WSL/Docker/remote backends can implement them later without
// changing the AgentTool surface.
//
// workspace identity ≠ transport ≠ location

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/**
 * A resolved workspace — the environmental context for a session.
 * Bundles identity, filesystem, terminal, and metadata.
 */
export interface Workspace {
  /** The workspace identity (stable across transports). */
  readonly identity: WorkspaceIdentity;
  /** Filesystem operations scoped to this workspace's root. */
  readonly filesystem: FilesystemCapability;
  /** Terminal operations scoped to this workspace's root. */
  readonly terminal: TerminalCapability;
}

export interface WorkspaceIdentity {
  /** Stable UUID assigned at workspace registration. */
  readonly workspaceId: string;
  /** Repository identity (path-based hash or explicit). */
  readonly repositoryId: string;
  /** Filesystem root (absolute path for LocalWorkspace). */
  readonly root: string;
}

// ---------------------------------------------------------------------------
// Filesystem capability
// ---------------------------------------------------------------------------

export interface FilesystemReadRequest {
  /** Path relative to workspace root, or absolute. */
  path: string;
  /** Max bytes to read (truncation flag set if exceeded). */
  maxBytes?: number;
}

export interface FilesystemReadResult {
  content: string;
  truncated: boolean;
  byteCount: number;
  /** True if the file did not exist (not an error for read). */
  notFound?: boolean;
}

export interface FilesystemWriteRequest {
  path: string;
  content: string;
  /** Create parent directories if they don't exist. */
  createDirs?: boolean;
}

export interface FilesystemWriteResult {
  bytesWritten: number;
}

export interface FilesystemEditRequest {
  path: string;
  oldString: string;
  newString: string;
  /** Replace all occurrences (default false — first match only). */
  replaceAll?: boolean;
}

export interface FilesystemEditResult {
  replacements: number;
}

export interface FilesystemListEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified?: Date;
}

export interface FilesystemListRequest {
  path: string;
  /** Include hidden files (dotfiles). Default false. */
  includeHidden?: boolean;
}

export interface FilesystemSearchResult {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface FilesystemGrepRequest {
  pattern: string;
  /** Directory to search in (relative to root). Default "." */
  path?: string;
  /** File glob pattern (e.g. "*.ts"). */
  include?: string;
  /** Case-insensitive. Default false. */
  ignoreCase?: boolean;
  /** Treat pattern as regex. Default false (literal). */
  isRegex?: boolean;
  /** Max results. */
  maxResults?: number;
}

export interface FilesystemFindRequest {
  path: string;
  /** Glob pattern (e.g. '*.ts', double-star-slash-star-test.ts). */
  pattern: string;
  includeHidden?: boolean;
  maxResults?: number;
}

/**
 * Filesystem operations scoped to a workspace root.
 * Paths are relative to root unless absolute.
 */
export interface FilesystemCapability {
  read(req: FilesystemReadRequest): Promise<FilesystemReadResult>;
  write(req: FilesystemWriteRequest): Promise<FilesystemWriteResult>;
  edit(req: FilesystemEditRequest): Promise<FilesystemEditResult>;
  list(req: FilesystemListRequest): Promise<FilesystemListEntry[]>;
  grep(req: FilesystemGrepRequest): Promise<FilesystemSearchResult[]>;
  find(req: FilesystemFindRequest): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Terminal capability
// ---------------------------------------------------------------------------

export interface TerminalExecuteRequest {
  command: string;
  timeoutMs?: number;
}

export interface TerminalExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
}

/**
 * Terminal operations scoped to a workspace root (cwd).
 */
export interface TerminalCapability {
  execute(
    req: TerminalExecuteRequest,
    signal?: AbortSignal,
  ): Promise<TerminalExecuteResult>;
}
