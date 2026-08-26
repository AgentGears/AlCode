import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const worker = readFileSync(new URL("./agent-worker.ts", import.meta.url), "utf8");
const suite = readFileSync(new URL("./agent-protocol-suite-v2.ts", import.meta.url), "utf8");
const planner = readFileSync(new URL("./program-revision-planner.ts", import.meta.url), "utf8");

describe("A1 coding Agent semantic revision production wiring", () => {
  it("terminates raw IPC authority in one privileged suite shared by execution and revision clients", () => {
    expect(worker).toContain("createProcessAdaptiveAgentProtocolSuiteV1()");
    expect(worker).not.toContain("ProtocolTransport");
    expect(worker).not.toContain("createProcessAgentTransport");
    expect(suite).toContain("const transport = createProcessAgentTransport()");
    expect(suite).toContain("createAgentProtocolBridgeV2ForTransport(transport)");
    expect(suite).toContain("createProgramRevisionProtocolClientV1(transport, { proposalTimeoutMs: null })");
  });

  it("advertises and handles the negotiated program_revision_v1 capability", () => {
    expect(worker).toContain("PROGRAM_REVISION_CAPABILITY");
    expect(worker).toContain("revisionProtocol.onPlan((plan) =>");
    expect(worker).toContain("runProgramRevisionPlanner({");
  });

  it("ties revision-planning model work to exact session cancellation", () => {
    expect(worker).toContain("revisionPlanningControllers");
    expect(worker).toContain("signal: controller.signal");
    expect(worker).toContain("abortRevisionPlanningForSession(message.sessionId, message.reason)");
    expect(worker).toContain("abortAllRevisionPlanning(message.reason)");
    expect(planner).toContain("ProgramRevisionPlannerCancelledError");
    expect(planner).toContain("throwIfCancelled(options.signal)");
  });

  it("keeps canonical revision authority out of the model proposal schema", () => {
    expect(planner).toContain("proposedChangeClass");
    expect(planner).toContain("proposedEdit");
    expect(planner).not.toMatch(/required:\s*\[[^\]]*(programRevisionId|revisionImpact|retainedAttempts|invalidatedAttempts)/i);
    expect(planner).toContain("The Host owns canonical IDs, identity dispositions, RevisionImpact, Attempt retention, validation, sealing, and Application acceptance.");
  });
});
