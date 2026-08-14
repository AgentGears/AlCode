import { describe, expect, it } from "vitest";
import { asSessionId } from "@alcode/events";
import { CapabilityBroker, type HostCapability } from "./capability-broker.ts";

function broker(): CapabilityBroker {
  return new CapabilityBroker(
    {} as never,
    {} as never,
    {} as never,
    { authorizeCapability() { throw new Error("policy must not run for stale requests"); } },
    [],
  );
}

function capability(name = "mcp__p__lookup"): HostCapability {
  return {
    name,
    description: "Lookup a value",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    async execute() { throw new Error("stale capability must not execute"); },
  };
}

describe("Host dynamic capability generation", () => {
  it("atomically replaces a provider generation and rejects old ABA-bound calls before execution", async () => {
    const subject = broker();
    const disposeG0 = subject.registerDynamicProvider("provider", "G0", [capability()]);
    expect(subject.describeCapabilities()).toMatchObject([{
      definition: { name: "mcp__p__lookup", description: "Lookup a value" },
      binding: { kind: "dynamic", revision: "G0" },
    }]);

    subject.registerDynamicProvider("provider", "G1", [capability()]);
    const stale = await subject.execute({
      sessionId: asSessionId("s1"),
      toolCallId: "tc1",
      toolName: "mcp__p__lookup",
      args: { q: "x" },
      expectedCapabilityRevision: "G0",
    });
    expect(stale).toMatchObject({ outcome: "stale", errorCode: "capability_stale" });

    disposeG0(); // stale disposer cannot remove the current generation.
    expect(subject.describeCapabilities()[0]?.binding).toEqual({ kind: "dynamic", revision: "G1" });
    expect(() => subject.registerDynamicProvider("provider", "G0", [capability()])).toThrow(/retired/);
  });

  it("rejects a missing revision for dynamic tools and conflicts without partial replacement", async () => {
    const subject = broker();
    subject.registerDynamicProvider("provider", "G0", [capability("mcp__p__a")]);
    const stale = await subject.execute({ sessionId: asSessionId("s1"), toolCallId: "tc", toolName: "mcp__p__a", args: {} });
    expect(stale.outcome).toBe("stale");

    expect(() => subject.registerDynamicProvider("other", "G0", [capability("mcp__p__a")])).toThrow(/conflicts/);
    expect(subject.describeCapabilities().map((item) => item.definition.name)).toEqual(["mcp__p__a"]);
  });
});
