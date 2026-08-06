import { describe, expect, it } from "vitest";
import { TestProvider } from "./index.ts";

describe("TestProvider", () => {
  it("returns a constant response", async () => {
    const p = TestProvider.constant("hello back");
    expect(await p.complete("hello")).toBe("hello back");
    expect(await p.complete("anything")).toBe("hello back");
  });

  it("matches the first substring response", async () => {
    const p = new TestProvider({
      responses: [
        { match: "world", text: "world!" },
        { match: "*", text: "default" },
      ],
    });
    expect(await p.complete("hello world")).toBe("world!");
    expect(await p.complete("hello")).toBe("default");
  });

  it("throws when no match and no default", async () => {
    const p = new TestProvider({ responses: [{ match: "x", text: "y" }] });
    await expect(p.complete("no match here")).rejects.toThrow(/no canned response/);
  });

  it("is deterministic (same input → same output)", async () => {
    const p = new TestProvider({
      responses: [{ match: "*", text: "same" }],
    });
    const a = await p.complete("first");
    const b = await p.complete("first");
    expect(a).toBe(b);
  });
});
