import { describe, expect, it } from "vitest";
import type { AgentTool } from "@alcode/agent-core";
import { agentToolAsHostCapability } from "./host-capabilities.ts";

describe("coding Agent Host capability quiescence adapter", () => {
  it("uses the Host operation-scoped proof contract for mutating tools", async () => {
    const tool: AgentTool<Record<string, unknown>, { ok: boolean }> = {
      name: "mutate_fixture",
      description: "fixture mutating tool",
      inputSchema: { type: "object", properties: {} },
      isReadOnly: false,
      async execute() {
        return {
          content: [{ type: "text", text: "done" }],
          details: { ok: true },
        };
      },
    };

    const capability = agentToolAsHostCapability(tool);
    expect(capability.quiescence).toEqual({
      containmentKind: "operation_scoped_containment",
      proofContractId: "host-capability-promise-v1",
      proofContractVersion: 1,
    });

    const result = await capability.execute({}, {
      quiescenceContract: {
        containment: "operation_scoped_containment",
        proofContractId: "host-capability-promise-v1",
        proofContractVersion: 1,
        containmentInstanceId: "fixture-containment",
      },
    });
    expect(result.quiescenceProof).toEqual({
      containmentInstanceId: "fixture-containment",
      proofContractId: "host-capability-promise-v1",
      proofContractVersion: 1,
      proofKind: "operation_containment_ended",
      evidence: {
        kind: "operation_scope_ended",
        containmentInstanceId: "fixture-containment",
      },
    });
  });
});
