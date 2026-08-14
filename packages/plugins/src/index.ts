export {
  AGENT_PLUGINS_VERSION,
  AGENT_PLUGINS_PLUGIN_SCHEMA,
  AGENT_PLUGINS_MCP_SCHEMA,
  ALCODE_HOOK_EXTENSION_NAMESPACE,
  ALCODE_PLUGIN_DIGEST_PROFILE,
  type PluginScope,
  type PluginDiagnostic,
  type PluginManifest,
  type SkillDescriptor,
  type McpStdioServerConfig,
  type McpHttpServerConfig,
  type McpServerConfig,
  type HookEvent,
  type ProcessHookConfig,
  type HttpHookConfig,
  type HookConfig,
  type PluginInspection,
  type TreeManifestEntry,
  type PackageTreeManifest,
  type StagedPluginGeneration,
} from "./types.ts";
export { buildPackageTreeManifest, canonicalizeTreeEntries, type TreeManifestLimits } from "./digest.ts";
export { inspectPluginPackage } from "./manifest.ts";
export { stagePluginGeneration, type StagePluginOptions } from "./stage.ts";
