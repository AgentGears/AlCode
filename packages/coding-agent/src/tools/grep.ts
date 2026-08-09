// Owned ALCODE grep tool. Fresh TypeScript delegating to FilesystemCapability.

import type { AgentTool, AgentToolResult } from "@alcode/agent-core";
import type { FilesystemCapability } from "../capabilities/types.ts";

export interface GrepToolInput {
  pattern: string;
  path?: string;
  include?: string;
  ignoreCase?: boolean;
  isRegex?: boolean;
}

export interface GrepToolDetails {
  matchCount: number;
}

export function createGrepTool(fs: FilesystemCapability): AgentTool<GrepToolInput, GrepToolDetails> {
  return {
    name: "grep",
    description:
      "Search file contents using literal or regex patterns. Returns " +
      "matching lines with file path and line number. Use include to " +
      "filter by file glob (e.g. '*.ts').",
    isReadOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The search pattern" },
        path: { type: "string", description: "Directory to search in (default: workspace root)" },
        include: { type: "string", description: "File glob to filter (e.g. '*.ts')" },
        ignoreCase: { type: "boolean", description: "Case-insensitive search" },
        isRegex: { type: "boolean", description: "Treat pattern as regex (default: literal)" },
      },
      required: ["pattern"],
    },

    async execute(input: GrepToolInput): Promise<AgentToolResult<GrepToolDetails>> {
      const req: { pattern: string; path?: string; include?: string; ignoreCase?: boolean; isRegex?: boolean; maxResults: number } = {
        pattern: input.pattern,
        maxResults: 100,
      };
      if (input.path !== undefined) req.path = input.path;
      if (input.include !== undefined) req.include = input.include;
      if (input.ignoreCase !== undefined) req.ignoreCase = input.ignoreCase;
      if (input.isRegex !== undefined) req.isRegex = input.isRegex;
      const results = await fs.grep(req);

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "No matches found." }],
          details: { matchCount: 0 },
        };
      }

      const text = results
        .map((r) => `${r.path}:${r.line}: ${r.text}`)
        .join("\n");

      return {
        content: [{ type: "text", text }],
        details: { matchCount: results.length },
      };
    },
  };
}
