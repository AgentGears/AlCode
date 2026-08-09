// Owned ALCODE edit tool. Fresh TypeScript delegating to FilesystemCapability.

import type { AgentTool, AgentToolResult } from "@alcode/agent-core";
import type { FilesystemCapability } from "../capabilities/types.ts";

export interface EditToolInput {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export interface EditToolDetails {
  replacements: number;
}

export function createEditTool(fs: FilesystemCapability): AgentTool<EditToolInput, EditToolDetails> {
  return {
    name: "edit",
    description:
      "Perform exact string replacements in a file. By default replaces only " +
      "the first occurrence. Set replaceAll to replace every occurrence. " +
      "The oldString must appear at least once or the operation fails.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to edit" },
        oldString: { type: "string", description: "The exact text to replace" },
        newString: { type: "string", description: "The replacement text" },
        replaceAll: { type: "boolean", description: "Replace all occurrences (default: first only)" },
      },
      required: ["path", "oldString", "newString"],
    },

    async execute(input: EditToolInput): Promise<AgentToolResult<EditToolDetails>> {
      const req: { path: string; oldString: string; newString: string; replaceAll?: boolean } = {
        path: input.path,
        oldString: input.oldString,
        newString: input.newString,
      };
      if (input.replaceAll !== undefined) req.replaceAll = input.replaceAll;
      const result = await fs.edit(req);

      if (result.replacements === 0) {
        return {
          content: [{ type: "text", text: `No matches found for oldString in ${input.path}` }],
          details: { replacements: 0 },
        };
      }

      return {
        content: [
          { type: "text", text: `Replaced ${result.replacements} occurrence(s) in ${input.path}` },
        ],
        details: { replacements: result.replacements },
      };
    },
  };
}
