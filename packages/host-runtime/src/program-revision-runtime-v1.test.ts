import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const runtime = readFileSync(new URL("./program-revision-runtime-v1.ts", import.meta.url), "utf8");

describe("A1 production semantic revision transport composition", () => {
  it("wraps the existing adaptive runtime and exact Host without creating parallel authority", () => {
    expect(runtime).toContain("runtime: ProgramExecutionRuntimeV2");
    expect(runtime).toContain("this.host = options.runtime.host;");
    expect(runtime).not.toContain("new HostRuntime(");
  });

  it("requires the complete negotiated adaptive capability set before revision routing", () => {
    expect(runtime).toContain("PROGRAM_STATE_V2_CAPABILITY");
    expect(runtime).toContain("PROGRAM_EXECUTION_V2_CAPABILITY");
    expect(runtime).toContain("PROGRAM_REVISION_CAPABILITY");
    expect(runtime).toContain("if (adaptive)");
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

  it("will not open revision planning for a non-adopted or displaced session", () => {
    expect(runtime).toContain("Semantic revision planning requires an adopted adaptive Program");
    expect(runtime).toContain("Semantic revision planning connection is not current");
  });
});