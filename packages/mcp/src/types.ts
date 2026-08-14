import type { Tool } from "@modelcontextprotocol/client";

export interface McpToolLimits {
  maxTools: number;
  maxNameChars: number;
  maxDescriptionChars: number;
  maxSchemaBytes: number;
  maxSchemaDepth: number;
  maxSchemaNodes: number;
  maxCatalogBytes: number;
}

export const DEFAULT_MCP_TOOL_LIMITS: McpToolLimits = {
  maxTools: 128,
  maxNameChars: 128,
  maxDescriptionChars: 4096,
  maxSchemaBytes: 64 * 1024,
  maxSchemaDepth: 16,
  maxSchemaNodes: 4096,
  maxCatalogBytes: 512 * 1024,
};

export interface McpToolProvenance {
  pluginName: string;
  serverName: string;
}

export interface McpToolDescriptor {
  rawName: string;
  modelName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  provenance: McpToolProvenance;
  sdkDefinition: Tool;
}

export interface McpCallResult {
  isError: boolean;
  content: unknown[];
  structuredContent?: unknown;
}

export type McpProjectedResult =
  | { complete: true; inline: McpCallResult; serializedBytes: number }
  | { complete: true; summary: string; reference: string; serializedBytes: number }
  | { complete: false; condition: "bounded_result"; serializedBytes: number; limitBytes: number };

export interface McpResultProjectOptions {
  maxInlineBytes?: number;
  retain?: (serialized: string) => Promise<{ handle: string }>;
}
