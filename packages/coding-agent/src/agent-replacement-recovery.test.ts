import { describe, expect, it } from "vitest";
import { recoverAfterAgentReplacement } from "./agent-replacement-recovery.ts";

describe("Agent replacement operation recovery", () => {
  it("marks interrupted operations before Phase-1 recovery", async () => {
    const order: string[] = [];
    await recoverAfterAgentReplacement(
      { recoverInterruptedOperations: async () => { order.push("interrupted"); } },
      { recover: async () => { order.push("phase"); } },
    );
    expect(order).toEqual(["interrupted", "phase"]);
  });

  it("fails closed before Phase-1 recovery when interrupted-operation recovery fails", async () => {
    let phaseRecoveryRan = false;
    await expect(recoverAfterAgentReplacement(
      { recoverInterruptedOperations: async () => { throw new Error("storage recovery failed"); } },
      { recover: async () => { phaseRecoveryRan = true; } },
    )).rejects.toThrow("storage recovery failed");
    expect(phaseRecoveryRan).toBe(false);
  });
});
