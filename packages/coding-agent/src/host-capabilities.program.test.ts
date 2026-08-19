import { describe, expect, it } from "vitest";
import type { AgentTool } from "@alcode/agent-core";
import { agentToolAsHostCapability } from "./host-capabilities.ts";

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
      proofContractId: "coding-agent-owned-tool-promise-v1",
      proofContractVersion: 1,
    });
    const result = await capability.execute({}, {
      quiescenceContract: {
        containment: "operation_scoped_containment",
        proofContractId: "coding-agent-owned-tool-promise-v1",
        proofContractVersion: 1,
        containmentInstanceId: "containment-1",
      },
    });
    expect(result.quiescenceProof).toEqual({
      containmentInstanceId: "containment-1",
      proofContractId: "coding-agent-owned-tool-promise-v1",
      proofContractVersion: 1,
      proofKind: "operation_containment_ended",
      evidence: { kind: "operation_scope_ended", containmentInstanceId: "containment-1" },
    });
  });
});
