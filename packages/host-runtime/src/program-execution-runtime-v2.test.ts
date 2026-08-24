import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./program-execution-runtime-v2.ts", import.meta.url), "utf8");

describe("A1 adaptive Program runtime V2 authority composition", () => {
  it("installs explicit canonical Program operation authority before adaptive capability execution", () => {
    expect(source).toContain("operationAuthority: ProgramRootOperationAuthorityV1");
    expect(source).toContain("this.host.setProgramOperationAuthority(options.operationAuthority);");
    expect(source).toContain("this.host.capabilityBroker.execute(prepared)");
  });

  it("does not translate semantic ProgramRevision provenance into the operational CAS lease", () => {
    expect(source).not.toMatch(/issuedUnderProgramRevisionId[^\n]{0,120}expectedProgramRevision/);
    expect(source).not.toMatch(/expectedProgramRevision[^\n]{0,120}issuedUnderProgramRevisionId/);
  });
});
