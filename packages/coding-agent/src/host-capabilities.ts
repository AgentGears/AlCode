// Host-side adapters for the existing owned coding tools.
//
// The Agent never imports or constructs these tools in the Phase 0.5 path.
// They are instantiated by the Host and exposed to the Agent only through
// Agent Protocol proxy tools.

import type { AgentTool } from "@alcode/agent-core";
import type { HostCapability, HostCapabilityResult } from "@alcode/host-runtime";
import type { Workspace } from "./capabilities/types.ts";
import { createBashTool } from "./tools/bash.ts";
import { createEditTool } from "./tools/edit.ts";
import { createFindTool } from "./tools/find.ts";
import { createGrepTool } from "./tools/grep.ts";
import { createLsTool } from "./tools/ls.ts";
import { createReadTool } from "./tools/read.ts";
import { createWriteTool } from "./tools/write.ts";

function extractNumber(details: unknown, key: string): number | null | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "number" || value === null ? value : undefined;
}

export function agentToolAsHostCapability(tool: AgentTool): HostCapability {
  return {
    name: tool.name,
    isReadOnly: tool.isReadOnly ?? false,
    async execute(args, context): Promise<HostCapabilityResult> {
      const result = await tool.execute(args as Record<string, unknown>, context.signal ? { signal: context.signal } : {});
      const text = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const exitCode = extractNumber(result.details, "exitCode");
      return {
        result: {
          content: result.content,
          details: result.details,
        },
        ...(result.executionOutcome !== undefined ? { outcome: result.executionOutcome } : {}),
        stdout: text,
        ...(exitCode !== undefined ? { exitCode } : {}),
      };
    },
  };
}

export function createDefaultHostCapabilities(workspace: Workspace): HostCapability[] {
  const tools: AgentTool[] = [
    createReadTool(workspace.filesystem),
    createWriteTool(workspace.filesystem),
    createEditTool(workspace.filesystem),
    createGrepTool(workspace.filesystem),
    createLsTool(workspace.filesystem),
    createFindTool(workspace.filesystem),
    createBashTool({ workingDirectory: workspace.identity.root }),
  ];
  return tools.map(agentToolAsHostCapability);
}
