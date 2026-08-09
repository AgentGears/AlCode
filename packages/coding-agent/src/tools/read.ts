// Owned ALCODE read tool. Fresh TypeScript implementing the same semantics
// as pi's read tool, but headless and delegating to FilesystemCapability.
// See packages/agent-core/src/imported/tools/read.ts for the reference.

import type { AgentTool, AgentToolResult } from "@alcode/agent-core";
import type { FilesystemCapability } from "../capabilities/types.ts";

export interface ReadToolInput {
  path: string;
  /** Line number to start reading from (1-indexed). */
  offset?: number;
  /** Maximum number of lines to read. */
  limit?: number;
}

export interface ReadToolDetails {
  byteCount: number;
  lineCount: number;
  truncated: boolean;
  notFound: boolean;
}

export function createReadTool(fs: FilesystemCapability): AgentTool<ReadToolInput, ReadToolDetails> {
  return {
    name: "read",
    description:
      "Read the contents of a file. Supports offset and limit for reading " +
      "specific sections. Returns line-numbered text. Truncated at 1MB.",
    isReadOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to read (relative or absolute)" },
        offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
        limit: { type: "number", description: "Maximum number of lines to read" },
      },
      required: ["path"],
    },

    async execute(input: ReadToolInput): Promise<AgentToolResult<ReadToolDetails>> {
      const result = await fs.read({ path: input.path });

      if (result.notFound) {
        return {
          content: [{ type: "text", text: `File not found: ${input.path}` }],
          details: { byteCount: 0, lineCount: 0, truncated: false, notFound: true },
        };
      }

      let content = result.content;
      const lines = content.split("\n");

      // Apply offset (1-indexed).
      const offset = input.offset ?? 1;
      const startIdx = Math.max(0, offset - 1);

      // Apply limit.
      const limit = input.limit ?? lines.length;
      const endIdx = Math.min(lines.length, startIdx + limit);

      const selectedLines = lines.slice(startIdx, endIdx);

      // Format with line numbers.
      const numbered = selectedLines
        .map((line, i) => `${String(startIdx + i + 1).padStart(6)}\t${line}`)
        .join("\n");

      return {
        content: [{ type: "text", text: numbered }],
        details: {
          byteCount: result.byteCount,
          lineCount: lines.length,
          truncated: result.truncated,
          notFound: false,
        },
      };
    },
  };
}
