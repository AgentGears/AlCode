import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./program-adaptive-production-v1.ts", import.meta.url), "utf8");

describe("A1 production adaptive Application composition", () => {
  it("instantiates the real Host baseline and revision acceptance authorities", () => {
    expect(source).toContain("new ProgramSemanticBaselineServiceV1({");
    expect(source).toContain("authority: options.baselineAuthority");
    expect(source).toContain("new ProgramRevisionControlServiceV1({");
    expect(source).toContain("currentState,");
    expect(source).toContain("new HostProgramSemanticBaselineApplicationControlV1(baselineService)");
    expect(source).toContain("new HostProgramRevisionApplicationControlV1(revisionControl)");
    expect(source).toContain("new ProgramAdaptiveSemanticApplicationControlV1({");
  });

  it("constructs adaptive Application services with semantic projection and durable semantic command authority", () => {
    expect(source).toContain("new ProgramAdaptiveApplicationPortV1(program, semanticRecovery)");
    expect(source).toContain("new ProgramAdaptiveApplicationServiceV1({");
    expect(source).toContain("semantic: semanticApplication");
    expect(source).toContain("createApplication(agent, fixed.productApplication, maxReplayEvents)");
  });

  it("provides a quiescent creation-acceptance path for explicit baseline adoption without V1 first dispatch", () => {
    expect(source).toContain("createBaselineAdoptionApplicationService");
    expect(source).toContain("createApplication(agent, fixed.application, maxReplayEvents)");
    expect(source).not.toContain("baselineService.accept(");
  });
});
