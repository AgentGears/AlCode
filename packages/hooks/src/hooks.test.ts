import { describe, expect, it } from "vitest";
import { combineHookPolicySignals } from "./index.ts";

describe("hook policy composition", () => {
  it("combines monotonically as deny > ask > continue", () => {
    expect(combineHookPolicySignals([{ decision: "continue" }, { decision: "ask", reason: "review" }])).toEqual({ decision: "ask", reasons: ["review"] });
    expect(combineHookPolicySignals([{ decision: "deny" }, { decision: "ask" }, { decision: "continue" }]).decision).toBe("deny");
  });
});
