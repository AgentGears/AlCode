// Owned ALCODE ls tool. Fresh TypeScript delegating to FilesystemCapability.

import type { AgentTool, AgentToolResult } from "@alcode/agent-core";
import type { FilesystemCapability } from "../capabilities/types.ts";

export interface LsToolInput {
  path: string;
  includeHidden?: boolean;
}

export interface LsToolDetails {
  entryCount: number;
}

export function createLsTool(fs: FilesystemCapability): AgentTool<LsToolInput, LsToolDetails> {
  return {
    name: "ls",
    description:
      "List directory contents. Shows file names, sizes, and types " +
      "(directory or file). Sorted by type then name.",
    isReadOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to list" },
        includeHidden: { type: "boolean", description: "Include hidden files (dotfiles)" },
      },
      required: ["path"],
    },

    async execute(input: LsToolInput): Promise<AgentToolResult<LsToolDetails>> {
      const req: { path: string; includeHidden?: boolean } = { path: input.path };
      if (input.includeHidden !== undefined) req.includeHidden = input.includeHidden;
      const entries = await fs.list(req);

      if (entries.length === 0) {
        return {
          content: [{ type: "text", text: `Empty directory: ${input.path}` }],
          details: { entryCount: 0 },
        };
      }

      const text = entries
        .map((e) => {
          const type = e.isDirectory ? "[DIR] " : "      ";
          const size = e.isDirectory ? "" : `${e.size}`;
          return `${type}${e.name}${size ? `\t${size}` : ""}`;
        })
        .join("\n");

      return {
        content: [{ type: "text", text }],
        details: { entryCount: entries.length },
      };
    },
  };
}
