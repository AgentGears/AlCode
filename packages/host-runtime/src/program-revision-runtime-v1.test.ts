import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const runtime = readFileSync(new URL("./program-revision-runtime-v1.ts", import.meta.url), "utf8");

describe("A1 production semantic revision transport composition", () => {
  it("wraps the existing adaptive runtime and exact Host without creating parallel authority", () => {
    expect(runtime).toContain("runtime: ProgramExecutionRuntimeV2");
    expect(runtime).toContain("this.host = options.runtime.host;");
    expect(runtime).not.toContain("new HostRuntime(");
  });

  it("keeps revision support optional for adaptive execution during rolling upgrades", () => {
    expect(runtime).toContain("PROGRAM_REVISION_CAPABILITY");
    expect(runtime).toContain("if (!capabilities.includes(PROGRAM_REVISION_CAPABILITY))");
    expect(runtime).toContain("return attached;");
    expect(runtime).not.toContain("PROGRAM_STATE_V2_CAPABILITY");
    expect(runtime).not.toContain("PROGRAM_EXECUTION_V2_CAPABILITY");
  });

  it("reuses the adaptive execution runtime routing result before binding revision authority", () => {
    expect(runtime).toContain("const attached = await this.runtime.attachAgent(");
    expect(runtime).toContain("this.runtime.agent.isCurrentConnection(sessionId, connection.generationId)");
    expect(runtime).not.toContain("const adaptive = await this.isAdaptiveProgramSession(sessionId)");
  });

  it("binds revision planning to the current production Agent generation and shared transport", () => {
    expect(runtime).toContain("this.host.programAgents.currentAgentGeneration(sessionId)");
    expect(runtime).toContain("return connection.transport as unknown as ProtocolTransport");
    expect(runtime).toContain("this.revisions.attach({");
    expect(runtime).toContain("this.revisions.handleProposal(message, connection.generationId)");
  });

  it("cleans revision authority on detach and process exit", () => {
    expect(runtime).toContain("this.revisions.detach(connection.generationId)");
    expect(runtime).toContain("void connection.waitForExit().then(detachRevision, detachRevision)");
  });

  it("will not open revision planning for a non-adopted, non-negotiated, or displaced session", () => {
    expect(runtime).toContain("Semantic revision planning requires an adopted adaptive Program");
    expect(runtime).toContain("Semantic revision planning connection is not current");
  });
});
