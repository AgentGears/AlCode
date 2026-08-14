import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/client";
import {
  DEFAULT_MCP_TOOL_LIMITS,
  type McpToolDescriptor,
  type McpToolLimits,
  type McpToolProvenance,
} from "./types.ts";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sanitizeSegment(value: string): string {
  const sanitized = value.normalize("NFKC").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "unnamed";
}

export function qualifyMcpToolName(provenance: McpToolProvenance, rawName: string, maxChars = DEFAULT_MCP_TOOL_LIMITS.maxNameChars): string {
  const base = `mcp__${sanitizeSegment(provenance.pluginName)}__${sanitizeSegment(provenance.serverName)}__${sanitizeSegment(rawName)}`;
  if (base.length <= maxChars) return base;
  const suffix = createHash("sha256").update(base).digest("hex").slice(0, 12);
  const headLength = Math.max(1, maxChars - suffix.length - 2);
  return `${base.slice(0, headLength)}__${suffix}`;
}

function analyzeSchema(value: unknown, depth: number, counters: { nodes: number; maxDepth: number }): void {
  counters.nodes += 1;
  counters.maxDepth = Math.max(counters.maxDepth, depth);
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) analyzeSchema(item, depth + 1, counters);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$ref" && typeof child === "string" && /^(?:https?:)?\/\//i.test(child)) {
      throw new Error("remote JSON Schema $ref is not permitted for MCP tool definitions");
    }
    analyzeSchema(child, depth + 1, counters);
  }
}

function validateTool(tool: Tool, provenance: McpToolProvenance, limits: McpToolLimits): McpToolDescriptor {
  if (!tool.name || tool.name.length > limits.maxNameChars) throw new Error(`MCP tool name exceeds ${limits.maxNameChars} characters`);
  const description = tool.description ?? `MCP tool ${tool.name}`;
  if (description.length > limits.maxDescriptionChars) throw new Error(`MCP tool description exceeds ${limits.maxDescriptionChars} characters`);
  if (tool.inputSchema === null || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) throw new Error("MCP tool inputSchema must be an object");
  const schema = structuredClone(tool.inputSchema) as Record<string, unknown>;
  const serialized = stableJson(schema);
  if (Buffer.byteLength(serialized, "utf8") > limits.maxSchemaBytes) throw new Error(`MCP tool schema exceeds ${limits.maxSchemaBytes} bytes`);
  const counters = { nodes: 0, maxDepth: 0 };
  analyzeSchema(schema, 0, counters);
  if (counters.maxDepth > limits.maxSchemaDepth) throw new Error(`MCP tool schema exceeds depth ${limits.maxSchemaDepth}`);
  if (counters.nodes > limits.maxSchemaNodes) throw new Error(`MCP tool schema exceeds ${limits.maxSchemaNodes} structural nodes`);
  return {
    rawName: tool.name,
    modelName: qualifyMcpToolName(provenance, tool.name, limits.maxNameChars),
    description,
    inputSchema: schema,
    provenance: structuredClone(provenance),
    sdkDefinition: structuredClone(tool),
  };
}

export function buildMcpToolCatalog(
  tools: readonly Tool[],
  provenance: McpToolProvenance,
  overrides: Partial<McpToolLimits> = {},
): { tools: McpToolDescriptor[]; canonicalBytes: number } {
  const limits = { ...DEFAULT_MCP_TOOL_LIMITS, ...overrides };
  if (tools.length > limits.maxTools) throw new Error(`MCP server exposes ${tools.length} tools; limit is ${limits.maxTools}`);
  const descriptors: McpToolDescriptor[] = [];
  const modelNames = new Map<string, string>();
  let catalogBytes = 0;
  for (const tool of tools) {
    const descriptor = validateTool(tool, provenance, limits);
    const previous = modelNames.get(descriptor.modelName);
    if (previous !== undefined) throw new Error(`MCP model-facing name collision: ${previous} and ${descriptor.rawName} → ${descriptor.modelName}`);
    modelNames.set(descriptor.modelName, descriptor.rawName);
    catalogBytes += Buffer.byteLength(stableJson({ name: descriptor.modelName, description: descriptor.description, inputSchema: descriptor.inputSchema }), "utf8");
    if (catalogBytes > limits.maxCatalogBytes) throw new Error(`MCP tool catalog exceeds ${limits.maxCatalogBytes} bytes`);
    descriptors.push(descriptor);
  }
  descriptors.sort((a, b) => a.modelName.localeCompare(b.modelName, "en"));
  return { tools: descriptors, canonicalBytes: catalogBytes };
}
