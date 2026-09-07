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

export const COMMAND_EXIT_ZERO_SPEC_ID = "command_exit_zero";
export const COMMAND_EXIT_ZERO_SPEC_VERSION = 1;
export const PACKAGE_TYPECHECK_SPEC_ID = "package_typecheck";
export const PACKAGE_TYPECHECK_SPEC_VERSION = 1;
export const PACKAGE_LINT_SPEC_ID = "package_lint";
export const PACKAGE_LINT_SPEC_VERSION = 1;
export const TARGETED_PACKAGE_TEST_SPEC_ID = "targeted_package_test";
export const TARGETED_PACKAGE_TEST_SPEC_VERSION = 1;
export const WORKSPACE_PATH_STATE_SPEC_ID = "workspace_path_state";
export const WORKSPACE_PATH_STATE_SPEC_VERSION = 1;

const PACKAGE_NAME_PATTERN = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
const TARGET_PATTERN = /^[A-Za-z0-9@._/\\-]+$/;

type WorkspacePathState = "file" | "directory" | "symlink" | "absent";

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

function verifierRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireOnlyVerifierKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unknown !== undefined) throw new Error(`Unexpected verifier argument ${unknown}`);
}

function safePackageName(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 160 || !PACKAGE_NAME_PATTERN.test(value)) {
    throw new Error("Verifier package must be a bounded pnpm package name without shell metacharacters");
  }
  return value;
}

function safeTestTarget(root: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024 || !TARGET_PATTERN.test(value)) {
    throw new Error("Verifier test target must be a bounded Workspace-relative path without shell metacharacters");
  }
  containedPath(root, value);
  return value.replace(/\\/g, "/");
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

  const exitZero = {
    capabilityName: bash.name,
    workspaceAccessClass: "may_write" as const,
    isSuccessful: (result: CapabilityBrokerResult) => result.outcome === "succeeded" && brokerExitCode(result) === 0,
  };
  const operationSpecs = new HostVerificationOperationRegistryV1([
    { specId: COMMAND_EXIT_ZERO_SPEC_ID, specVersion: COMMAND_EXIT_ZERO_SPEC_VERSION, ...exitZero },
    { specId: PACKAGE_TYPECHECK_SPEC_ID, specVersion: PACKAGE_TYPECHECK_SPEC_VERSION, ...exitZero },
    { specId: PACKAGE_LINT_SPEC_ID, specVersion: PACKAGE_LINT_SPEC_VERSION, ...exitZero },
    { specId: TARGETED_PACKAGE_TEST_SPEC_ID, specVersion: TARGETED_PACKAGE_TEST_SPEC_VERSION, ...exitZero },
  ]);

  const verifierCatalog = new HostProgramVerifierCatalogV1([
    {
      specId: COMMAND_EXIT_ZERO_SPEC_ID,
      specVersion: COMMAND_EXIT_ZERO_SPEC_VERSION,
      predicateKind: "operation_result",
      description: "Execute a Host-authorized shell command through the normal capability/Operation path and satisfy only when its admitted exit code is zero.",
      inputSchema: structuredClone(bash.inputSchema),
    },
    {
      specId: PACKAGE_TYPECHECK_SPEC_ID,
      specVersion: PACKAGE_TYPECHECK_SPEC_VERSION,
      predicateKind: "operation_result",
      description: "Run the Host-defined pnpm typecheck script for one bounded package. The model selects only the package; the Host constructs the executable command.",
      inputSchema: {
        type: "object",
        properties: { package: { type: "string", description: "Exact pnpm workspace package name, for example @alcode/host-runtime." } },
        required: ["package"],
      },
    },
    {
      specId: PACKAGE_LINT_SPEC_ID,
      specVersion: PACKAGE_LINT_SPEC_VERSION,
      predicateKind: "operation_result",
      description: "Run the Host-defined pnpm lint script for one bounded package. The model selects only the package; the Host constructs the executable command.",
      inputSchema: {
        type: "object",
        properties: { package: { type: "string", description: "Exact pnpm workspace package name." } },
        required: ["package"],
      },
    },
    {
      specId: TARGETED_PACKAGE_TEST_SPEC_ID,
      specVersion: TARGETED_PACKAGE_TEST_SPEC_VERSION,
      predicateKind: "operation_result",
      description: "Run a Host-defined targeted Vitest invocation for one bounded package and Workspace-relative test path. Neither field is executable shell text.",
      inputSchema: {
        type: "object",
        properties: {
          package: { type: "string", description: "Exact pnpm workspace package name." },
          target: { type: "string", description: "Workspace-relative test file or bounded test target path." },
        },
        required: ["package", "target"],
      },
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
  ], operationSpecs, {
    canonicalize(specId, specVersion, advertisedArgs) {
      if (specVersion !== 1) throw new Error(`Unsupported verifier version ${specVersion}`);
      const args = verifierRecord(advertisedArgs, `${specId} args`);
      switch (specId) {
        case COMMAND_EXIT_ZERO_SPEC_ID:
          return advertisedArgs;
        case PACKAGE_TYPECHECK_SPEC_ID: {
          requireOnlyVerifierKeys(args, ["package"]);
          const packageName = safePackageName(args.package);
          return { command: `pnpm --filter ${packageName} typecheck` };
        }
        case PACKAGE_LINT_SPEC_ID: {
          requireOnlyVerifierKeys(args, ["package"]);
          const packageName = safePackageName(args.package);
          return { command: `pnpm --filter ${packageName} lint` };
        }
        case TARGETED_PACKAGE_TEST_SPEC_ID: {
          requireOnlyVerifierKeys(args, ["package", "target"]);
          const packageName = safePackageName(args.package);
          const target = safeTestTarget(options.root, args.target);
          return { command: `pnpm --filter ${packageName} exec vitest run ${target}` };
        }
        default:
          throw new Error(`No Host argument canonicalizer for ${specId}@${specVersion}`);
      }
    },
  });

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
