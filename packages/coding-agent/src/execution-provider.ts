import { digestOf } from "@alcode/context";
import type {
  ExecutionContainmentPolicyDescriptorV1,
  ExecutionProviderDescriptorV1,
  ExecutionWorldActivationEvidenceV1,
  ExecutionWorldClosureEvidenceV1,
  ExecutionWorldIdentityV1,
} from "@alcode/host-runtime/execution-world";
import { createLocalWorkspace } from "./capabilities/local-workspace.ts";
import type { FilesystemCapability, TerminalCapability, Workspace } from "./capabilities/types.ts";

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

  return {
    identity: structuredClone(input.identity),
    workspace,
    activationEvidence,
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
