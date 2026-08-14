export const AGENT_PLUGINS_VERSION = "1.0.0" as const;
export const AGENT_PLUGINS_PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" as const;
export const AGENT_PLUGINS_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json" as const;
export const ALCODE_HOOK_EXTENSION_NAMESPACE = "io.github.agentgears.alcode.hooks" as const;
export const ALCODE_PLUGIN_DIGEST_PROFILE = "alcode-plugin-tree-v1" as const;

export type PluginScope = "user" | "workspace";
export type DiagnosticSeverity = "info" | "warning" | "error";

export interface PluginDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  path?: string;
  component?: string;
}

export interface PluginAuthor {
  name?: string;
  email?: string;
  url?: string;
}

export interface PluginManifest {
  $schema: typeof AGENT_PLUGINS_PLUGIN_SCHEMA;
  name: string;
  version?: string;
  description?: string;
  author?: PluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  extensions?: Record<string, Record<string, unknown>>;
}

export interface SkillDescriptor {
  name: string;
  description: string;
  relativePath: string;
  compatibility?: string;
  license?: string;
  allowedTools?: string;
}

export interface McpStdioServerConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpServerConfig {
  type: "streamable-http";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export type HookEvent =
  | "session.started"
  | "input.admitted"
  | "capability.before_execute"
  | "capability.settled"
  | "operation.stop_requested";

export interface HookBase {
  id: string;
  event: HookEvent;
  timeoutMs?: number;
}

export interface ProcessHookConfig extends HookBase {
  type: "process";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface HttpHookConfig extends HookBase {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

export type HookConfig = ProcessHookConfig | HttpHookConfig;

export interface PluginInspection {
  root: string;
  status: "valid" | "invalid";
  complete: boolean;
  manifest?: PluginManifest;
  skills: SkillDescriptor[];
  mcpServers: Record<string, McpServerConfig>;
  hooks: HookConfig[];
  diagnostics: PluginDiagnostic[];
}

export interface TreeManifestEntry {
  path: string;
  kind: "file" | "directory";
  modeClass: "regular" | "executable" | "portable" | "directory";
  size: number;
  contentDigest?: string;
}

export interface PackageTreeManifest {
  profile: typeof ALCODE_PLUGIN_DIGEST_PROFILE;
  entries: TreeManifestEntry[];
  canonical: string;
  digest: string;
  totalBytes: number;
}

export interface StagedPluginGeneration {
  digest: string;
  root: string;
  manifest: PackageTreeManifest;
  inspection: PluginInspection;
  reused: boolean;
}
