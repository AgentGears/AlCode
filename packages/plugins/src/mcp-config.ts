import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_PLUGINS_MCP_SCHEMA,
  type McpServerConfig,
  type PluginDiagnostic,
} from "./types.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || Object.values(value).some((item) => typeof item !== "string")) throw new Error("expected object of string values");
  return value as Record<string, string>;
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("expected string array");
  return value as string[];
}

function closedKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`unknown fields: ${unexpected.join(", ")}`);
}

function validateHttpUrl(raw: string): void {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("MCP URL must use http or https");
  if (url.username || url.password || url.hash) throw new Error("MCP URL must not contain userinfo or fragment");
  if (url.protocol === "http:") {
    const host = url.hostname.toLowerCase();
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host.startsWith("127.");
    if (!loopback) throw new Error("non-loopback MCP HTTP endpoint must use https");
  }
}

function validateServer(value: unknown): McpServerConfig {
  if (!isObject(value) || typeof value.type !== "string") throw new Error("server must be an object with type");
  if (value.type === "stdio") {
    closedKeys(value, ["type", "command", "args", "env", "cwd"]);
    if (typeof value.command !== "string" || value.command.length === 0) throw new Error("stdio command is required");
    if (value.command.includes("/") || value.command.includes("\\")) {
      if (!value.command.startsWith("./")) throw new Error("stdio command path must be plugin-relative and begin with ./");
    }
    const args = stringArray(value.args);
    const env = stringRecord(value.env);
    if (env && Object.keys(env).some((key) => key.toUpperCase() === "PLUGIN_ROOT" || key.toUpperCase() === "PLUGIN_DATA")) {
      throw new Error("stdio env may not override PLUGIN_ROOT or PLUGIN_DATA");
    }
    if (value.cwd !== undefined) {
      if (typeof value.cwd !== "string") throw new Error("stdio cwd must be a string");
      if (!(value.cwd.startsWith("./") || value.cwd === "${PLUGIN_ROOT}" || value.cwd.startsWith("${PLUGIN_ROOT}/") || value.cwd === "${PLUGIN_DATA}" || value.cwd.startsWith("${PLUGIN_DATA}/"))) {
        throw new Error("stdio cwd must be plugin-relative, PLUGIN_ROOT-rooted, or PLUGIN_DATA-rooted");
      }
    }
    return {
      type: "stdio",
      command: value.command,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    };
  }
  if (value.type === "streamable-http") {
    closedKeys(value, ["type", "url", "headers"]);
    if (typeof value.url !== "string" || !value.url) throw new Error("streamable-http url is required");
    validateHttpUrl(value.url);
    const headers = stringRecord(value.headers);
    if (headers) {
      const seen = new Set<string>();
      for (const name of Object.keys(headers)) {
        const key = name.toLowerCase();
        if (seen.has(key)) throw new Error(`duplicate header name with different casing: ${name}`);
        seen.add(key);
      }
    }
    return { type: "streamable-http", url: value.url, ...(headers ? { headers } : {}) };
  }
  if (value.type === "sse") throw new Error("legacy SSE transport is not supported by Phase 0.9");
  throw new Error(`unsupported MCP transport: ${value.type}`);
}

export async function discoverMcpServers(root: string, diagnostics: PluginDiagnostic[]): Promise<Record<string, McpServerConfig>> {
  const configPath = path.join(root, "mcp.json");
  try {
    const stat = await lstat(configPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("mcp.json must be a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    diagnostics.push({ code: "mcp.invalid_location", severity: "error", message: error instanceof Error ? error.message : String(error), path: "mcp.json" });
    return {};
  }

  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(configPath, "utf8")); }
  catch (error) {
    diagnostics.push({ code: "mcp.invalid_json", severity: "error", message: error instanceof Error ? error.message : String(error), path: "mcp.json" });
    return {};
  }
  if (!isObject(parsed) || parsed.$schema !== AGENT_PLUGINS_MCP_SCHEMA || !isObject(parsed.mcpServers)) {
    diagnostics.push({ code: "mcp.invalid_top_level", severity: "error", message: "mcp.json must target Agent Plugins 1.0.0 and contain mcpServers", path: "mcp.json" });
    return {};
  }
  const unknownTop = Object.keys(parsed).filter((key) => key !== "$schema" && key !== "mcpServers");
  if (unknownTop.length > 0) {
    diagnostics.push({ code: "mcp.invalid_top_level", severity: "error", message: `mcp.json has unknown fields: ${unknownTop.join(", ")}`, path: "mcp.json" });
    return {};
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(parsed.mcpServers)) {
    try { servers[name] = validateServer(value); }
    catch (error) {
      diagnostics.push({ code: "mcp.server_invalid", severity: "warning", message: error instanceof Error ? error.message : String(error), path: "mcp.json", component: name });
    }
  }
  return servers;
}
