// Owned ALCODE find tool. Fresh TypeScript delegating to FilesystemCapability.

import type { AgentTool, AgentToolResult } from "@alcode/agent-core";
import type { FilesystemCapability } from "../capabilities/types.ts";

export interface FindToolInput {
  path: string;
  pattern: string;
  includeHidden?: boolean;
}

export interface FindToolDetails {
  matchCount: number;
}

export function createFindTool(fs: FilesystemCapability): AgentTool<FindToolInput, FindToolDetails> {
  return {
    name: "find",
    description:
      "Find files by name pattern. Searches recursively from the given path. " +
      "Returns matching file paths relative to the workspace root.",
    isReadOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to search in" },
        pattern: { type: "string", description: "File name pattern (glob, e.g. '*.ts')" },
        includeHidden: { type: "boolean", description: "Include hidden files and directories" },
      },
      required: ["path", "pattern"],
    },

    async execute(input: FindToolInput): Promise<AgentToolResult<FindToolDetails>> {
      const req: { path: string; pattern: string; includeHidden?: boolean; maxResults: number } = {
        path: input.path,
        pattern: input.pattern,
        maxResults: 200,
      };
      if (input.includeHidden !== undefined) req.includeHidden = input.includeHidden;
      const results = await fs.find(req);

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No files matching '${input.pattern}' found in ${input.path}` }],
          details: { matchCount: 0 },
        };
      }

      return {
        content: [{ type: "text", text: results.join("\n") }],
        details: { matchCount: results.length },
      };
    },
  };
}
