import { describe, expect, it } from "vitest";
import {
  ApplicationProtocolValidationError,
  parseApplicationCommand,
  parseProgramAdaptiveSemanticCommand,
} from "./index.ts";

const common = {
  protocolVersion: 1 as const,
  commandId: "command-1",
  clientId: "client-1",
  sessionId: "session-1",
  issuedAt: new Date(0).toISOString(),
};

describe("Phase 1 / A1 Program Application commands", () => {
  it("parses exact fixed-topology creation/rebase/cancel/session commands", () => {
    expect(parseApplicationCommand({ ...common, type: "program.creation.accept", draftId: "draft-1", draftDigest: "digest-1" })).toMatchObject({ type: "program.creation.accept", draftId: "draft-1" });
    expect(parseApplicationCommand({ ...common, type: "program.rebase.accept", programStateId: "program-1", expectedProgramRevision: 4, mismatchReceiptId: "receipt-1" })).toMatchObject({ type: "program.rebase.accept", expectedProgramRevision: 4 });
    expect(parseApplicationCommand({ ...common, type: "program.cancel", programStateId: "program-1", expectedProgramRevision: 4, reason: "stop" })).toMatchObject({ type: "program.cancel", reason: "stop" });
    expect(parseApplicationCommand({ ...common, type: "program.session.attach", programStateId: "program-1", expectedProgramRevision: 4 })).toMatchObject({ type: "program.session.attach" });
    expect(parseApplicationCommand({ ...common, type: "program.session.detach", programStateId: "program-1", expectedProgramRevision: 4 })).toMatchObject({ type: "program.session.detach" });
  });

  it("parses additive A1 baseline sealing and exact baseline/revision acceptance", () => {
    expect(parseProgramAdaptiveSemanticCommand({
      ...common,
      type: "program.semantic_baseline.seal",
      programStateId: "program-1",
      expectedProgramStateRevision: 7,
    })).toMatchObject({ type: "program.semantic_baseline.seal", expectedProgramStateRevision: 7 });
    expect(parseProgramAdaptiveSemanticCommand({
      ...common,
      type: "program.semantic_baseline.accept",
      programStateId: "program-1",
      draftId: "baseline-draft",
      draftDigest: "baseline-digest",
    })).toMatchObject({ type: "program.semantic_baseline.accept", draftId: "baseline-draft", draftDigest: "baseline-digest" });
    expect(parseProgramAdaptiveSemanticCommand({
      ...common,
      type: "program.semantic_revision.accept",
      programStateId: "program-1",
      draftId: "revision-draft",
      draftDigest: "revision-digest",
    })).toMatchObject({ type: "program.semantic_revision.accept", draftId: "revision-draft", draftDigest: "revision-digest" });
  });

  it("keeps A1 semantic commands out of legacy ApplicationCommand parsing", () => {
    expect(() => parseApplicationCommand({
      ...common,
      type: "program.semantic_revision.accept",
      programStateId: "program-1",
      draftId: "draft",
      draftDigest: "digest",
    })).toThrow(/unknown application command type/);
  });

  it("rejects non-exact state revisions, missing exact digests, and unbounded cancellation reasons", () => {
    expect(() => parseApplicationCommand({ ...common, type: "program.cancel", programStateId: "program-1", expectedProgramRevision: 0 })).toThrow(ApplicationProtocolValidationError);
    expect(() => parseApplicationCommand({ ...common, type: "program.cancel", programStateId: "program-1", expectedProgramRevision: 2.5 })).toThrow(ApplicationProtocolValidationError);
    expect(() => parseProgramAdaptiveSemanticCommand({ ...common, type: "program.semantic_baseline.seal", programStateId: "program-1", expectedProgramStateRevision: 0 })).toThrow(/expectedProgramStateRevision/);
    expect(() => parseProgramAdaptiveSemanticCommand({ ...common, type: "program.semantic_baseline.accept", programStateId: "program-1", draftId: "draft", draftDigest: "" })).toThrow(/draftDigest/);
    expect(() => parseProgramAdaptiveSemanticCommand({ ...common, type: "program.semantic_revision.accept", programStateId: "program-1", draftId: "draft" })).toThrow(/draftDigest/);
    expect(() => parseApplicationCommand({ ...common, type: "program.cancel", programStateId: "program-1", expectedProgramRevision: 2, reason: "x".repeat(4097) })).toThrow(/4096/);
  });
});
