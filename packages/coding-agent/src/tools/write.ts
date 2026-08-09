// Owned ALCODE write tool. Fresh TypeScript delegating to FilesystemCapability.

import type { AgentTool, AgentToolResult } from "@alcode/agent-core";
import type { FilesystemCapability } from "../capabilities/types.ts";

export interface WriteToolInput {
  path: string;
  content: string;
}

export interface WriteToolDetails {
  bytesWritten: number;
}

export function createWriteTool(fs: FilesystemCapability): AgentTool<WriteToolInput, WriteToolDetails> {
  return {
    name: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist. " +
      "Overwrites existing content. Use for new files or complete rewrites; " +
      "use edit for targeted changes.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to write" },
        content: { type: "string", description: "The content to write" },
      },
      required: ["path", "content"],
    },

    async execute(input: WriteToolInput): Promise<AgentToolResult<WriteToolDetails>> {
      const result = await fs.write({
        path: input.path,
        content: input.content,
        createDirs: true,
      });

      return {
        content: [{ type: "text", text: `Wrote ${result.bytesWritten} bytes to ${input.path}` }],
        details: { bytesWritten: result.bytesWritten },
      };
    },
  };
}
