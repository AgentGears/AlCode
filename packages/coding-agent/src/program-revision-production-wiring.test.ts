import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const worker = readFileSync(new URL("./agent-worker.ts", import.meta.url), "utf8");
const planner = readFileSync(new URL("./program-revision-planner.ts", import.meta.url), "utf8");

describe("A1 coding Agent semantic revision production wiring", () => {
  it("uses one process IPC transport for execution and revision clients", () => {
    expect(worker).toContain("const processTransport = createProcessAgentTransport()");
    expect(worker).toContain("createAgentProtocolBridgeV2ForTransport(processTransport)");
    expect(worker).toContain("createProgramRevisionProtocolClientV1(processTransport)");
  });

  it("advertises and handles the negotiated program_revision_v1 capability", () => {
    expect(worker).toContain("PROGRAM_REVISION_CAPABILITY");
    expect(worker).toContain("revisionProtocol.onPlan((plan) =>");
    expect(worker).toContain("runProgramRevisionPlanner({");
  });

  it("keeps canonical revision authority out of the model proposal schema", () => {
    expect(planner).toContain("proposedChangeClass");
    expect(planner).toContain("proposedEdit");
    expect(planner).not.toMatch(/required:\s*\[[^\]]*(programRevisionId|revisionImpact|retainedAttempts|invalidatedAttempts)/i);
    expect(planner).toContain("The Host owns canonical IDs, identity dispositions, RevisionImpact, Attempt retention, validation, sealing, and Application acceptance.");
  });
});