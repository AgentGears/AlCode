import { describe, expect, it } from "vitest";
import { canonicalInputDigest } from "./cognitive-operations.ts";

describe("canonicalInputDigest ESM execution", () => {
  it("computes the canonical digest without CommonJS require", () => {
    expect(canonicalInputDigest({
      path: "a",
      oldString: "x",
      newString: "y",
    })).toBe("a25bbd4ee0e03b83");
  });

  it("preserves command-only hashing for terminal inputs", () => {
    expect(canonicalInputDigest({ command: "echo hi", timeoutMs: 1000 }))
      .toBe("1eab1ef18bb109ae");
    expect(canonicalInputDigest({ command: "echo hi", timeoutMs: 5000 }))
      .toBe("1eab1ef18bb109ae");
  });
});
