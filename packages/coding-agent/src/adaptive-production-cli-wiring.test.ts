import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cli = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");

describe("A1 CLI adaptive production wiring", () => {
  it("composes the production V2 runtime around the existing V1 Host", () => {
    expect(cli).toContain("createProgramExecutionRuntimeV1({");
    expect(cli).toContain("createProgramAdaptiveProductionRuntimeV1({");
    expect(cli).toContain("fixedTopology: fixedRuntime");
    expect(cli).toContain("const runtime = adaptiveProduct.runtime;");
  });

  it("keeps new Program creation quiescent until exact Application baseline acceptance", () => {
    expect(cli).toContain("createBaselineAdoptionApplicationService");
    expect(cli).toContain('type: "program.semantic_baseline.seal"');
    expect(cli).toContain('type: "program.semantic_baseline.accept"');
    expect(cli).toContain("createdProgram.activeAttempt !== undefined");
    expect(cli).toContain('await attachConnection(connection, "reattach")');
  });

  it("drives post-adoption work only through adaptive execution and terminal authority", () => {
    expect(cli).toContain("runtime.requestCurrentAttemptExecution(connection, session)");
    expect(cli).toContain("adaptiveProduct.terminal.cancel({");
    expect(cli).toContain("recoverAfterAgentReplacement(locked.store, fixedRuntime.recovery)");
    expect(cli).not.toContain("runtime.scheduler.dispatchNext");
  });
});
