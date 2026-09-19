// Host-side adapters for the existing owned coding tools.
//
// The Agent never imports or constructs these tools in the Phase 0.5 path.
// They are instantiated by the Host and exposed to the Agent only through
// Agent Protocol proxy tools.

import type { AgentTool } from "@alcode/agent-core";
import type {
  HostCapability,
  HostCapabilityContext,
  HostCapabilityResult,
} from "@alcode/host-runtime";
import type { Workspace } from "./capabilities/types.ts";
import { CODING_WORKSPACE_EXECUTION_SERVICE_V1 } from "./execution-provider.ts";
import { createBashTool } from "./tools/bash.ts";
import { createEditTool } from "./tools/edit.ts";
import { createFindTool } from "./tools/find.ts";
import { createGrepTool } from "./tools/grep.ts";
import { createLsTool } from "./tools/ls.ts";
import { createReadTool } from "./tools/read.ts";
import { createWriteTool } from "./tools/write.ts";

// Heterogeneous owned tool collection. This does not widen any tool's own
// execute contract; the Host adapter casts the already-validated protocol
// payload at the single model-facing boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAgentTool = AgentTool<any, any>;
type OwnedToolFactory = (workspace: Workspace) => AnyAgentTool;

const OPERATION_SCOPED_PROOF_CONTRACT_ID = "host-capability-promise-v1";
const OPERATION_SCOPED_PROOF_CONTRACT_VERSION = 1;

const DEFAULT_TOOL_FACTORIES: readonly OwnedToolFactory[] = [
  (workspace) => createReadTool(workspace.filesystem),
  (workspace) => createWriteTool(workspace.filesystem),
  (workspace) => createEditTool(workspace.filesystem),
  (workspace) => createGrepTool(workspace.filesystem),
  (workspace) => createLsTool(workspace.filesystem),
  (workspace) => createFindTool(workspace.filesystem),
  (workspace) => createBashTool({ workingDirectory: workspace.identity.root }),
];

function extractNumber(details: unknown, key: string): number | null | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "number" || value === null ? value : undefined;
}

function quiescenceProof(
  isReadOnly: boolean,
  context: HostCapabilityContext,
) {
  return !isReadOnly && context.quiescenceContract !== undefined
    ? {
        containmentInstanceId: context.quiescenceContract.containmentInstanceId,
        proofContractId: context.quiescenceContract.proofContractId,
        proofContractVersion: context.quiescenceContract.proofContractVersion,
        proofKind: "operation_containment_ended" as const,
        evidence: {
          kind: "operation_scope_ended",
          containmentInstanceId: context.quiescenceContract.containmentInstanceId,
        },
      }
    : undefined;
}

async function executeOwnedTool(
  tool: AnyAgentTool,
  args: unknown,
  context: HostCapabilityContext,
): Promise<HostCapabilityResult> {
  const isReadOnly = tool.isReadOnly ?? false;
  const result = await tool.execute(
    args,
    context.signal ? { signal: context.signal } : {},
  );
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const exitCode = extractNumber(result.details, "exitCode");
  const proof = quiescenceProof(isReadOnly, context);
  return {
    result: {
      content: result.content,
      details: result.details,
    },
    ...(result.executionOutcome !== undefined ? { outcome: result.executionOutcome } : {}),
    stdout: text,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(proof !== undefined ? { quiescenceProof: proof } : {}),
  };
}

function requiredBashCommand(args: unknown): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("bash arguments must be an object");
  }
  const command = (args as Record<string, unknown>).command;
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("bash command must be a non-empty string");
  }
  return command;
}

/**
 * Execute bash through the Workspace terminal supplied by the exact captured
 * execution-world generation. This intentionally does not reuse createBashTool:
 * that compatibility tool spawns on the Host using a cwd string, which would
 * make an isolated world's process execution escape back to the Host.
 */
async function executeCapturedWorldTerminal(
  workspace: Workspace,
  args: unknown,
  context: HostCapabilityContext,
): Promise<HostCapabilityResult> {
  const command = requiredBashCommand(args);
  const execution = await workspace.terminal.execute(
    { command },
    context.signal,
  );
  const outcome = execution.cancelled
    ? "cancelled" as const
    : execution.timedOut
      ? "timed_out" as const
      : execution.exitCode !== 0
        ? "failed" as const
        : "succeeded" as const;
  const text = execution.cancelled
    ? `[cancelled] exit=${execution.exitCode} duration=${execution.durationMs}ms\n${execution.stdout}`
    : execution.timedOut
      ? `[timed_out] exit=${execution.exitCode} duration=${execution.durationMs}ms\n${execution.stdout}`
      : `exit=${execution.exitCode} duration=${execution.durationMs}ms\n${execution.stdout}${execution.stderr ? `\n[stderr]\n${execution.stderr}` : ""}`;
  const proof = quiescenceProof(false, context);
  return {
    result: {
      content: [{ type: "text", text }],
      details: {
        exitCode: execution.exitCode,
        durationMs: execution.durationMs,
        timedOut: execution.timedOut,
        cancelled: execution.cancelled,
        truncated: execution.truncated,
      },
    },
    outcome,
    stdout: execution.stdout,
    stderr: execution.stderr,
    exitCode: execution.exitCode,
    ...(proof !== undefined ? { quiescenceProof: proof } : {}),
  };
}

function isWorkspace(value: unknown): value is Workspace {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<Workspace>;
  return typeof candidate.identity === "object" && candidate.identity !== null
    && typeof candidate.filesystem === "object" && candidate.filesystem !== null
    && typeof candidate.terminal === "object" && candidate.terminal !== null;
}

function requireCapturedWorkspace(context: HostCapabilityContext): Workspace {
  const binding = context.executionWorldBinding;
  if (binding === undefined) {
    throw new Error("Workspace-world coding capability lacks its captured execution binding");
  }
  const service = binding.getService(CODING_WORKSPACE_EXECUTION_SERVICE_V1);
  if (!isWorkspace(service)) {
    throw new Error(
      `Execution-world generation ${binding.provenance.executionWorldGenerationId} lacks coding Workspace service`,
    );
  }
  if (service.identity.workspaceId !== binding.provenance.workspaceId) {
    throw new Error("Execution-world coding Workspace service identity does not match captured provenance");
  }
  return service;
}

export function agentToolAsHostCapability<TInput, TResult>(
  tool: AgentTool<TInput, TResult>,
): HostCapability {
  const isReadOnly = tool.isReadOnly ?? false;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: structuredClone(tool.inputSchema),
    isReadOnly,
    workspaceAccessClass: isReadOnly ? "read_only" : "may_write",
    ...(!isReadOnly ? {
      quiescence: {
        containmentKind: "operation_scoped_containment" as const,
        proofContractId: OPERATION_SCOPED_PROOF_CONTRACT_ID,
        proofContractVersion: OPERATION_SCOPED_PROOF_CONTRACT_VERSION,
      },
    } : {}),
    execute: (args, context) => executeOwnedTool(tool as AnyAgentTool, args, context),
  };
}

export function createDefaultHostCapabilities(workspace: Workspace): HostCapability[] {
  return DEFAULT_TOOL_FACTORIES.map((factory) => agentToolAsHostCapability(factory(workspace)));
}

/**
 * A5 production adapter: metadata is derived from the ordinary owned tools, but
 * every execution re-resolves the exact Workspace service from the immutable
 * Operation binding captured by the Host. The descriptor Workspace is never an
 * execution fallback.
 */
export function createExecutionWorldHostCapabilities(descriptorWorkspace: Workspace): HostCapability[] {
  return DEFAULT_TOOL_FACTORIES.map((factory) => {
    const descriptor = agentToolAsHostCapability(factory(descriptorWorkspace));
    return {
      ...descriptor,
      executionScope: "workspace_world" as const,
      async execute(args: unknown, context: HostCapabilityContext): Promise<HostCapabilityResult> {
        const workspace = requireCapturedWorkspace(context);
        if (descriptor.name === "bash") {
          return executeCapturedWorldTerminal(workspace, args, context);
        }
        return executeOwnedTool(factory(workspace), args, context);
      },
    };
  });
}
