import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { buildPackageTreeManifest } from "./digest.ts";
import { discoverHooks } from "./hooks.ts";
import { discoverMcpServers } from "./mcp-config.ts";
import { discoverSkills } from "./skills.ts";
import {
  AGENT_PLUGINS_PLUGIN_SCHEMA,
  type PluginDiagnostic,
  type PluginInspection,
  type PluginManifest,
} from "./types.ts";

const MANIFEST_FIELDS = new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"]);
const NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateManifest(value: unknown, diagnostics: PluginDiagnostic[]): PluginManifest | undefined {
  if (!isObject(value)) {
    diagnostics.push({ code: "manifest.invalid", severity: "error", message: "plugin.json must contain an object", path: "plugin.json" });
    return undefined;
  }
  for (const field of Object.keys(value)) {
    if (!MANIFEST_FIELDS.has(field)) diagnostics.push({ code: "manifest.unknown_field", severity: "warning", message: `unknown plugin.json field ignored: ${field}`, path: "plugin.json" });
  }
  if (value.$schema !== AGENT_PLUGINS_PLUGIN_SCHEMA) {
    diagnostics.push({ code: "manifest.unsupported_schema", severity: "error", message: "plugin.json must target Agent Plugins 1.0.0", path: "plugin.json" });
    return undefined;
  }
  if (typeof value.name !== "string" || value.name.length < 1 || value.name.length > 64 || !NAME_PATTERN.test(value.name)) {
    diagnostics.push({ code: "manifest.invalid_name", severity: "error", message: "plugin name violates Agent Plugins 1.0.0 constraints", path: "plugin.json" });
    return undefined;
  }
  for (const key of ["version", "description", "homepage", "repository", "license"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      diagnostics.push({ code: "manifest.invalid_metadata", severity: "error", message: `${key} must be a string`, path: "plugin.json" });
      return undefined;
    }
  }
  if (value.keywords !== undefined && (!Array.isArray(value.keywords) || value.keywords.some((item) => typeof item !== "string"))) {
    diagnostics.push({ code: "manifest.invalid_keywords", severity: "error", message: "keywords must be a string array", path: "plugin.json" });
    return undefined;
  }
  let author: PluginManifest["author"];
  if (value.author !== undefined) {
    if (!isObject(value.author) || Object.keys(value.author).some((key) => !["name", "email", "url"].includes(key)) || Object.values(value.author).some((item) => typeof item !== "string")) {
      diagnostics.push({ code: "manifest.invalid_author", severity: "error", message: "author must contain only string name/email/url fields", path: "plugin.json" });
      return undefined;
    }
    author = value.author;
  }
  let extensions: Record<string, Record<string, unknown>> | undefined;
  if (value.extensions !== undefined) {
    if (!isObject(value.extensions)) {
      diagnostics.push({ code: "manifest.extensions_ignored", severity: "warning", message: "non-object extensions field ignored", path: "plugin.json" });
    } else {
      extensions = {};
      for (const [name, extensionValue] of Object.entries(value.extensions)) {
        if (!isObject(extensionValue)) {
          diagnostics.push({ code: "manifest.extension_ignored", severity: "warning", message: `non-object extension ignored: ${name}`, path: "plugin.json" });
          continue;
        }
        extensions[name] = extensionValue;
      }
    }
  }
  return {
    $schema: AGENT_PLUGINS_PLUGIN_SCHEMA,
    name: value.name,
    ...(typeof value.version === "string" ? { version: value.version } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(author ? { author } : {}),
    ...(typeof value.homepage === "string" ? { homepage: value.homepage } : {}),
    ...(typeof value.repository === "string" ? { repository: value.repository } : {}),
    ...(typeof value.license === "string" ? { license: value.license } : {}),
    ...(Array.isArray(value.keywords) ? { keywords: value.keywords as string[] } : {}),
    ...(extensions ? { extensions } : {}),
  };
}

export async function inspectPluginPackage(root: string): Promise<PluginInspection> {
  const resolvedRoot = path.resolve(root);
  const diagnostics: PluginDiagnostic[] = [];
  try { await buildPackageTreeManifest(resolvedRoot); }
  catch (error) {
    diagnostics.push({ code: "package.invalid_tree", severity: "error", message: error instanceof Error ? error.message : String(error) });
    return { root: resolvedRoot, status: "invalid", complete: true, skills: [], mcpServers: {}, hooks: [], diagnostics };
  }

  const manifestPath = path.join(resolvedRoot, "plugin.json");
  try {
    const stat = await lstat(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("plugin.json must be a regular file");
  } catch (error) {
    diagnostics.push({ code: "manifest.missing", severity: "error", message: error instanceof Error ? error.message : String(error), path: "plugin.json" });
    return { root: resolvedRoot, status: "invalid", complete: true, skills: [], mcpServers: {}, hooks: [], diagnostics };
  }

  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch (error) {
    diagnostics.push({ code: "manifest.invalid_json", severity: "error", message: error instanceof Error ? error.message : String(error), path: "plugin.json" });
    return { root: resolvedRoot, status: "invalid", complete: true, skills: [], mcpServers: {}, hooks: [], diagnostics };
  }
  const manifest = validateManifest(parsed, diagnostics);
  if (!manifest) return { root: resolvedRoot, status: "invalid", complete: true, skills: [], mcpServers: {}, hooks: [], diagnostics };

  const skills = await discoverSkills(resolvedRoot, diagnostics);
  const mcpServers = await discoverMcpServers(resolvedRoot, diagnostics);
  const hooks = discoverHooks(manifest.extensions, diagnostics);
  return { root: resolvedRoot, status: "valid", complete: true, manifest, skills, mcpServers, hooks, diagnostics };
}
