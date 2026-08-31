import { describe, expect, it } from "vitest";
import { recoverAfterAgentReplacement } from "./agent-replacement-recovery.ts";

describe("Agent replacement operation recovery", () => {
  it("marks interrupted operations and materializes adaptive Program recovery before Phase-1 recovery", async () => {
    const order: string[] = [];
    await recoverAfterAgentReplacement(
      { recoverInterruptedOperations: async () => { order.push("interrupted"); } },
      { recover: async () => { order.push("phase"); } },
      { recover: async () => { order.push("adaptive"); } },
    );
    expect(order).toEqual(["interrupted", "adaptive", "phase"]);
  });

  it("preserves the fixed-topology ordering when no adaptive recovery authority is supplied", async () => {
    const order: string[] = [];
    await recoverAfterAgentReplacement(
      { recoverInterruptedOperations: async () => { order.push("interrupted"); } },
      { recover: async () => { order.push("phase"); } },
    );
    expect(order).toEqual(["interrupted", "phase"]);
  });

  it("fails closed before Program recovery when interrupted-operation recovery fails", async () => {
    let phaseRecoveryRan = false;
    let adaptiveRecoveryRan = false;
    await expect(recoverAfterAgentReplacement(
      { recoverInterruptedOperations: async () => { throw new Error("storage recovery failed"); } },
      { recover: async () => { phaseRecoveryRan = true; } },
      { recover: async () => { adaptiveRecoveryRan = true; } },
    )).rejects.toThrow("storage recovery failed");
    expect(adaptiveRecoveryRan).toBe(false);
    expect(phaseRecoveryRan).toBe(false);
  });
});
