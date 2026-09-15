import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentTool } from "@alcode/agent-core";
import type { ExecutionWorldOperationBindingV1 } from "@alcode/host-runtime";
import { createLocalWorkspace } from "./capabilities/local-workspace.ts";
import type { Workspace } from "./capabilities/types.ts";
import {
  agentToolAsHostCapability,
  createExecutionWorldHostCapabilities,
} from "./host-capabilities.ts";
import { CODING_WORKSPACE_EXECUTION_SERVICE_V1 } from "./execution-provider.ts";

describe("Program-backed Host capability adapters", () => {
  it("classifies read-only tools without mutation quiescence", () => {
    const tool: AgentTool<Record<string, never>, string> = {
      name: "read_only",
      description: "read",
      inputSchema: { type: "object", properties: {} },
      isReadOnly: true,
      async execute() { return { content: [{ type: "text", text: "ok" }], details: "ok" }; },
    };
    const capability = agentToolAsHostCapability(tool);
    expect(capability.workspaceAccessClass).toBe("read_only");
    expect(capability.quiescence).toBeUndefined();
  });

  it("proves an owned mutating tool promise ended for the exact Host containment", async () => {
    const tool: AgentTool<Record<string, never>, string> = {
      name: "writer",
      description: "write",
      inputSchema: { type: "object", properties: {} },
      isReadOnly: false,
      async execute() { return { content: [{ type: "text", text: "done" }], details: "done" }; },
    };
    const capability = agentToolAsHostCapability(tool);
    expect(capability.workspaceAccessClass).toBe("may_write");
    expect(capability.quiescence).toMatchObject({
      containmentKind: "operation_scoped_containment",
      proofContractId: "host-capability-promise-v1",
      proofContractVersion: 1,
    });
    const result = await capability.execute({}, {
      quiescenceContract: {
        containment: "operation_scoped_containment",
        proofContractId: "host-capability-promise-v1",
        proofContractVersion: 1,
        containmentInstanceId: "containment-1",
      },
    });
    expect(result.quiescenceProof).toEqual({
      containmentInstanceId: "containment-1",
      proofContractId: "host-capability-promise-v1",
      proofContractVersion: 1,
      proofKind: "operation_containment_ended",
      evidence: { kind: "operation_scope_ended", containmentInstanceId: "containment-1" },
    });
  });

  it("resolves each coding operation from the captured execution-world service, never the descriptor Workspace", async () => {
    const descriptorRoot = mkdtempSync(join(tmpdir(), "alcode-a5-descriptor-"));
    const g0Root = mkdtempSync(join(tmpdir(), "alcode-a5-g0-"));
    const g1Root = mkdtempSync(join(tmpdir(), "alcode-a5-g1-"));
    try {
      writeFileSync(join(descriptorRoot, "value.txt"), "descriptor\n");
      writeFileSync(join(g0Root, "value.txt"), "g0\n");
      writeFileSync(join(g1Root, "value.txt"), "g1\n");
      const descriptorWorkspace = createLocalWorkspace({
        workspaceId: "workspace-a5",
        repositoryId: "repo-a5",
        root: descriptorRoot,
      });
      const g0Workspace = createLocalWorkspace({
        workspaceId: "workspace-a5",
        repositoryId: "repo-a5",
        root: g0Root,
      });
      const g1Workspace = createLocalWorkspace({
        workspaceId: "workspace-a5",
        repositoryId: "repo-a5",
        root: g1Root,
      });
      const capabilities = createExecutionWorldHostCapabilities(descriptorWorkspace);
      const read = capabilities.find((candidate) => candidate.name === "read");
      if (read === undefined) throw new Error("missing read capability");
      expect(read.executionScope).toBe("workspace_world");

      const binding = (generation: string, workspace: typeof g0Workspace): ExecutionWorldOperationBindingV1 => ({
        provenance: {
          workspaceId: "workspace-a5",
          providerKind: "test-provider",
          executionWorldGenerationId: generation,
          providerDescriptorDigest: "provider-digest",
          effectivePolicyDigest: "policy-digest",
        },
        assertUsable: () => undefined,
        getService: (serviceId) => serviceId === CODING_WORKSPACE_EXECUTION_SERVICE_V1 ? workspace : undefined,
      });

      const g0Result = await read.execute({ path: "value.txt" }, { executionWorldBinding: binding("g0", g0Workspace) });
      const g1Result = await read.execute({ path: "value.txt" }, { executionWorldBinding: binding("g1", g1Workspace) });
      expect(JSON.stringify(g0Result.result)).toContain("g0");
      expect(JSON.stringify(g0Result.result)).not.toContain("descriptor");
      expect(JSON.stringify(g1Result.result)).toContain("g1");
      expect(JSON.stringify(g1Result.result)).not.toContain("g0");
    } finally {
      rmSync(descriptorRoot, { recursive: true, force: true });
      rmSync(g0Root, { recursive: true, force: true });
      rmSync(g1Root, { recursive: true, force: true });
    }
  });

  it("routes bash through the captured execution-world terminal instead of Host cwd execution", async () => {
    const descriptorRoot = mkdtempSync(join(tmpdir(), "alcode-a5-bash-descriptor-"));
    try {
      const descriptorWorkspace = createLocalWorkspace({
        workspaceId: "workspace-a5-bash",
        repositoryId: "repo-a5-bash",
        root: descriptorRoot,
      });
      let executedCommand = "";
      const boundWorkspace: Workspace = {
        identity: {
          workspaceId: "workspace-a5-bash",
          repositoryId: "repo-a5-bash",
          root: "/physical-world-label",
        },
        filesystem: descriptorWorkspace.filesystem,
        terminal: {
          execute: async (request) => {
            executedCommand = request.command;
            return {
              stdout: "physical-world-terminal\n",
              stderr: "",
              exitCode: 0,
              durationMs: 3,
              timedOut: false,
              cancelled: false,
              truncated: false,
            };
          },
        },
      };
      const binding: ExecutionWorldOperationBindingV1 = {
        provenance: {
          workspaceId: "workspace-a5-bash",
          providerKind: "isolated-test",
          executionWorldGenerationId: "g-bash",
          providerDescriptorDigest: "provider-digest",
          effectivePolicyDigest: "policy-digest",
        },
        assertUsable: () => undefined,
        getService: (serviceId) => serviceId === CODING_WORKSPACE_EXECUTION_SERVICE_V1 ? boundWorkspace : undefined,
      };
      const bash = createExecutionWorldHostCapabilities(descriptorWorkspace)
        .find((candidate) => candidate.name === "bash");
      if (bash === undefined) throw new Error("missing bash capability");

      const result = await bash.execute(
        { command: "echo physical" },
        {
          executionWorldBinding: binding,
          quiescenceContract: {
            containment: "operation_scoped_containment",
            proofContractId: "host-capability-promise-v1",
            proofContractVersion: 1,
            containmentInstanceId: "containment-bash",
          },
        },
      );

      expect(executedCommand).toBe("echo physical");
      expect(result.stdout).toContain("physical-world-terminal");
      expect(JSON.stringify(result.result)).toContain("physical-world-terminal");
      expect(result.quiescenceProof).toMatchObject({
        containmentInstanceId: "containment-bash",
        proofKind: "operation_containment_ended",
      });
    } finally {
      rmSync(descriptorRoot, { recursive: true, force: true });
    }
  });
});
