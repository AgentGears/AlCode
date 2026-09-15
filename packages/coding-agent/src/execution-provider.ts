import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { digestOf } from "@alcode/context";
import type {
  ExecutionWorldOperationBindingV1,
} from "@alcode/host-runtime";
import type {
  ExecutionContainmentPolicyDescriptorV1,
  ExecutionProviderDescriptorV1,
  ExecutionWorldActivationEvidenceV1,
  ExecutionWorldClosureEvidenceV1,
  ExecutionWorldIdentityV1,
} from "@alcode/host-runtime/execution-world";
import { createLocalWorkspace } from "./capabilities/local-workspace.ts";
import type { FilesystemCapability, TerminalCapability, Workspace } from "./capabilities/types.ts";

export const CODING_WORKSPACE_EXECUTION_SERVICE_V1 = "alcode.coding.workspace.v1";
export const CODING_WORKSPACE_OBSERVATION_SERVICE_V1 = "alcode.coding.workspace-observation.v1";

const FALLBACK_MAX_ENTRIES = 20_000;
const FALLBACK_MAX_BYTES = 64 * 1024 * 1024;

export type ExecutionWorldPathStateV1 = "file" | "directory" | "symlink" | "absent";

export interface CodingWorkspaceObservationServiceV1 {
  observeStateDigest(): Promise<string>;
  observePathState(path: string): Promise<ExecutionWorldPathStateV1>;
}

export const LOCAL_TRUSTED_EXECUTION_PROVIDER_V1: ExecutionProviderDescriptorV1 = {
  providerKind: "local-trusted",
  adapter: "alcode-local-execution-world",
  adapterVersion: 1,
  semanticConfig: {
    transport: "host-process",
    filesystem: "host-workspace-root",
    process: "host-child-process",
    hostileCodeIsolation: false,
  },
};

export const LOCAL_TRUSTED_EXECUTION_POLICY_V1: ExecutionContainmentPolicyDescriptorV1 = {
  profile: "local-trusted-v1",
  semanticConfig: {
    filesystem: "registered-workspace-root",
    network: "host-policy",
    environment: "bounded-by-capability-adapter",
    hostileCodeIsolation: false,
  },
};

export interface WorkspaceExecutionWorldV1 {
  readonly identity: ExecutionWorldIdentityV1;
  readonly workspace: Workspace;
  activationEvidence(): ExecutionWorldActivationEvidenceV1;
  operationBinding(): ExecutionWorldOperationBindingV1;
  close(): Promise<ExecutionWorldClosureEvidenceV1>;
  isOpen(): boolean;
}

export interface LocalExecutionWorldInputV1 {
  identity: ExecutionWorldIdentityV1;
  repositoryId: string;
  root: string;
}

function closedError(identity: ExecutionWorldIdentityV1): Error {
  return new Error(`Execution-world generation is closed: ${identity.executionWorldGenerationId}`);
}

function containedPath(root: string, requested: string): string {
  if (typeof requested !== "string" || requested.length === 0 || isAbsolute(requested)) {
    throw new Error("Execution-world observation path must be a non-empty Workspace-relative path");
  }
  const absolute = resolve(root, requested);
  const rel = relative(root, absolute);
  const separator = process.platform === "win32" ? "\\" : "/";
  if (rel === "" || rel === ".." || rel.startsWith(`..${separator}`) || isAbsolute(rel)) {
    throw new Error("Execution-world observation path escapes the Workspace root");
  }
  return absolute;
}

async function fallbackWorkspaceDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  let entriesSeen = 0;
  let bytesSeen = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      if (prefix === "" && entry.name === ".git") continue;
      entriesSeen += 1;
      if (entriesSeen > FALLBACK_MAX_ENTRIES) throw new Error("workspace observation entry bound exceeded");
      const absolute = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        hash.update(`L\0${relativePath}\0${await readlink(absolute)}\0`);
      } else if (stat.isDirectory()) {
        hash.update(`D\0${relativePath}\0`);
        await walk(absolute, relativePath);
      } else if (stat.isFile()) {
        const bytes = await readFile(absolute);
        bytesSeen += bytes.byteLength;
        if (bytesSeen > FALLBACK_MAX_BYTES) throw new Error("workspace observation byte bound exceeded");
        hash.update(`F\0${relativePath}\0${bytes.byteLength}\0`);
        hash.update(bytes);
      } else {
        hash.update(`O\0${relativePath}\0${stat.mode}\0`);
      }
    }
  };
  await walk(root, "");
  return hash.digest("hex");
}

async function workspaceStateDigest(root: string): Promise<string> {
  try {
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const status = execFileSync("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return createHash("sha256").update("git-head-status-v1\0").update(head).update("\0").update(status).digest("hex");
  } catch {
    return fallbackWorkspaceDigest(root);
  }
}

export function createLocalExecutionWorldV1(input: LocalExecutionWorldInputV1): WorkspaceExecutionWorldV1 {
  if (input.identity.providerKind !== LOCAL_TRUSTED_EXECUTION_PROVIDER_V1.providerKind) {
    throw new Error(`Local execution provider cannot bind provider kind ${input.identity.providerKind}`);
  }
  const underlying = createLocalWorkspace({
    workspaceId: input.identity.workspaceId,
    repositoryId: input.repositoryId,
    root: input.root,
  });
  let open = true;
  const requireOpen = (): void => {
    if (!open) throw closedError(input.identity);
  };

  const filesystem: FilesystemCapability = {
    read: async (req) => { requireOpen(); return underlying.filesystem.read(req); },
    write: async (req) => { requireOpen(); return underlying.filesystem.write(req); },
    edit: async (req) => { requireOpen(); return underlying.filesystem.edit(req); },
    list: async (req) => { requireOpen(); return underlying.filesystem.list(req); },
    grep: async (req) => { requireOpen(); return underlying.filesystem.grep(req); },
    find: async (req) => { requireOpen(); return underlying.filesystem.find(req); },
  };
  const terminal: TerminalCapability = {
    execute: async (req, signal) => { requireOpen(); return underlying.terminal.execute(req, signal); },
  };
  const workspace: Workspace = {
    identity: underlying.identity,
    filesystem,
    terminal,
  };
  const observations: CodingWorkspaceObservationServiceV1 = {
    observeStateDigest: async () => {
      requireOpen();
      const digest = await workspaceStateDigest(input.root);
      requireOpen();
      return digest;
    },
    observePathState: async (path) => {
      requireOpen();
      const absolute = containedPath(input.root, path);
      try {
        const stat = await lstat(absolute);
        requireOpen();
        if (stat.isSymbolicLink()) return "symlink";
        if (stat.isFile()) return "file";
        if (stat.isDirectory()) return "directory";
        throw new Error("Execution-world path is neither a file, directory, symlink, nor absent");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          requireOpen();
          return "absent";
        }
        throw error;
      }
    },
  };

  const activationEvidence = (): ExecutionWorldActivationEvidenceV1 => ({
    readinessEvidenceDigest: digestOf({
      contract: "local-execution-world-readiness-v1",
      executionWorldGenerationId: input.identity.executionWorldGenerationId,
      workspaceId: input.identity.workspaceId,
      repositoryId: input.repositoryId,
      providerDescriptorDigest: input.identity.providerDescriptorDigest,
      effectivePolicyDigest: input.identity.effectivePolicyDigest,
    }),
  });

  const operationBinding = (): ExecutionWorldOperationBindingV1 => ({
    provenance: structuredClone(input.identity),
    assertUsable: requireOpen,
    getService: (serviceId) => {
      if (serviceId === CODING_WORKSPACE_EXECUTION_SERVICE_V1) return workspace;
      if (serviceId === CODING_WORKSPACE_OBSERVATION_SERVICE_V1) return observations;
      return undefined;
    },
  });

  return {
    identity: structuredClone(input.identity),
    workspace,
    activationEvidence,
    operationBinding,
    isOpen: () => open,
    close: async () => {
      open = false;
      return {
        closureEvidenceDigest: digestOf({
          contract: "local-execution-world-closure-v1",
          executionWorldGenerationId: input.identity.executionWorldGenerationId,
          bindingUnavailable: true,
        }),
        bindingUnavailable: true,
      };
    },
  };
}
