import { describe, expect, it } from "vitest";
import { resolveProductExecutionProviderKindV1 } from "./product-execution-world-runtime.ts";

describe("A5 product execution-provider selection", () => {
  it("keeps local-trusted as the explicit compatibility default", () => {
    expect(resolveProductExecutionProviderKindV1(undefined)).toBe("local-trusted");
    expect(resolveProductExecutionProviderKindV1("")).toBe("local-trusted");
    expect(resolveProductExecutionProviderKindV1("local-trusted")).toBe("local-trusted");
  });

  it("selects isolated-v1 only when Application/Host configuration requests it", () => {
    expect(resolveProductExecutionProviderKindV1("isolated-v1")).toBe("isolated-v1");
  });

  it("fails closed for unknown providers instead of silently downgrading to local execution", () => {
    expect(() => resolveProductExecutionProviderKindV1("mystery-provider"))
      .toThrow(/Unsupported ALCODE execution provider/);
  });
});
