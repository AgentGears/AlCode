import { describe, expect, it } from "vitest";
import { ApplicationProtocolValidationError, parseApplicationCommand } from "./index.ts";

const common = {
  protocolVersion: 1 as const,
  commandId: "command-1",
  clientId: "client-1",
  sessionId: "session-1",
  issuedAt: new Date(0).toISOString(),
};

describe("Phase 1 Program Application commands", () => {
  it("parses exact creation/rebase/cancel/session commands", () => {
    expect(parseApplicationCommand({ ...common, type: "program.creation.accept", draftId: "draft-1", draftDigest: "digest-1" })).toMatchObject({ type: "program.creation.accept", draftId: "draft-1" });
    expect(parseApplicationCommand({ ...common, type: "program.rebase.accept", programStateId: "program-1", expectedProgramRevision: 4, mismatchReceiptId: "receipt-1" })).toMatchObject({ type: "program.rebase.accept", expectedProgramRevision: 4 });
    expect(parseApplicationCommand({ ...common, type: "program.cancel", programStateId: "program-1", expectedProgramRevision: 4, reason: "stop" })).toMatchObject({ type: "program.cancel", reason: "stop" });
    expect(parseApplicationCommand({ ...common, type: "program.session.attach", programStateId: "program-1", expectedProgramRevision: 4 })).toMatchObject({ type: "program.session.attach" });
    expect(parseApplicationCommand({ ...common, type: "program.session.detach", programStateId: "program-1", expectedProgramRevision: 4 })).toMatchObject({ type: "program.session.detach" });
  });

  it("rejects non-exact revisions and unbounded cancellation reasons", () => {
    expect(() => parseApplicationCommand({ ...common, type: "program.cancel", programStateId: "program-1", expectedProgramRevision: 0 })).toThrow(ApplicationProtocolValidationError);
    expect(() => parseApplicationCommand({ ...common, type: "program.cancel", programStateId: "program-1", expectedProgramRevision: 2.5 })).toThrow(ApplicationProtocolValidationError);
    expect(() => parseApplicationCommand({ ...common, type: "program.cancel", programStateId: "program-1", expectedProgramRevision: 2, reason: "x".repeat(4097) })).toThrow(/4096/);
  });
});
