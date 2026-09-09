import { describe, expect, it } from "vitest";
import { canonicalInputDigest } from "./cognitive-operations.ts";
import { canonicalDigestOf } from "./verification.ts";

describe("reasoning digest helpers under ESM", () => {
  it("computes the canonical input digest without CommonJS require", () => {
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

  it("computes verification digests without CommonJS require", () => {
    expect(canonicalDigestOf("fixture")).toBe("f16d05ec6b29248d");
    expect(canonicalDigestOf({ b: 2, a: 1 })).toBe("43258cff783fe703");
  });
});
