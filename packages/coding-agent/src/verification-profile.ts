import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  HostProgramVerifierCatalogV1,
  HostVerificationOperationRegistryV1,
  type CapabilityBrokerResult,
  type HostCapability,
  type ProgramExecutionObservationSourceV1,
  type ProgramWorkspacePathObservationSourceV1,
} from "@alcode/host-runtime";
import type { WorkspacePathState } from "@alcode/program-state";

export const COMMAND_EXIT_ZERO_SPEC_ID = "command_exit_zero";
export const COMMAND_EXIT_ZERO_SPEC_VERSION = 1;
export const WORKSPACE_PATH_STATE_SPEC_ID = "workspace_path_state";
export const WORKSPACE_PATH_STATE_SPEC_VERSION = 1;

export interface DefaultProgramVerifierConfigurationV1 {
  operationSpecs: HostVerificationOperationRegistryV1;
  verifierCatalog: HostProgramVerifierCatalogV1;
  pathObservations: ProgramWorkspacePathObservationSourceV1;
}

function containedPath(root: string, requested: string): string {
  if (typeof requested !== "string" || requested.length === 0 || isAbsolute(requested)) {
    throw new Error("Verifier path must be a non-empty Workspace-relative path");
  }
  const absolute = resolve(root, requested);
  const rel = relative(root, absolute);
  const separator = process.platform === "win32" ? "\\" : "/";
  if (rel === "" || rel === ".." || rel.startsWith(`..${separator}`) || isAbsolute(rel)) {
    throw new Error("Verifier path escapes the Workspace root");
  }
  return absolute;
}

async function observePathState(absolute: string): Promise<WorkspacePathState> {
  try {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    throw new Error("Verifier path is neither a file, directory, symlink, nor absent");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

function brokerExitCode(result: CapabilityBrokerResult): number | null | undefined {
  const payload = typeof result.result === "object" && result.result !== null && !Array.isArray(result.result)
    ? result.result as Record<string, unknown>
    : undefined;
  const details = payload !== undefined && typeof payload.details === "object" && payload.details !== null && !Array.isArray(payload.details)
    ? payload.details as Record<string, unknown>
    : undefined;
  const value = details?.exitCode;
  return typeof value === "number" || value === null ? value : undefined;
}

export function createDefaultProgramVerifierConfiguration(options: {
  root: string;
  capabilities: readonly HostCapability[];
  observations: ProgramExecutionObservationSourceV1;
}): DefaultProgramVerifierConfigurationV1 {
  const bash = options.capabilities.find((capability) => capability.name === "bash");
  if (bash === undefined || bash.inputSchema === undefined) {
    throw new Error("P-01 command_exit_zero verifier requires the Host bash capability and its input schema");
  }
  if (bash.workspaceAccessClass !== "may_write") {
    throw new Error("P-01 command_exit_zero verifier requires bash to retain may_write authority semantics");
  }

  const operationSpecs = new HostVerificationOperationRegistryV1([{
    specId: COMMAND_EXIT_ZERO_SPEC_ID,
    specVersion: COMMAND_EXIT_ZERO_SPEC_VERSION,
    capabilityName: bash.name,
    workspaceAccessClass: "may_write",
    isSuccessful: (result) => result.outcome === "succeeded" && brokerExitCode(result) === 0,
  }]);

  const verifierCatalog = new HostProgramVerifierCatalogV1([
    {
      specId: COMMAND_EXIT_ZERO_SPEC_ID,
      specVersion: COMMAND_EXIT_ZERO_SPEC_VERSION,
      predicateKind: "operation_result",
      description: "Execute a Host-authorized shell command through the normal capability/Operation path and satisfy only when its admitted exit code is zero.",
      inputSchema: structuredClone(bash.inputSchema),
    },
    {
      specId: WORKSPACE_PATH_STATE_SPEC_ID,
      specVersion: WORKSPACE_PATH_STATE_SPEC_VERSION,
      predicateKind: "workspace_path_state",
      description: "Observe a Workspace-relative path through the Host and require its current state to be file, directory, symlink, or absent.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path" },
          requiredState: { type: "string", enum: ["file", "directory", "symlink", "absent"] },
        },
        required: ["path", "requiredState"],
      },
    },
  ], operationSpecs);

  const pathObservations: ProgramWorkspacePathObservationSourceV1 = {
    observePath: async (path) => {
      try {
        const absolute = containedPath(options.root, path);
        const before = await options.observations.observe();
        if (before.status === "unknown") return before;
        const pathState = await observePathState(absolute);
        const after = await options.observations.observe();
        if (after.status === "unknown") return after;
        if (JSON.stringify(before.base) !== JSON.stringify(after.base)) {
          return { status: "unknown", reason: "Workspace changed during protected path observation" };
        }
        return { status: "complete", base: after.base, pathState };
      } catch (error) {
        return { status: "unknown", reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };

  return { operationSpecs, verifierCatalog, pathObservations };
}
