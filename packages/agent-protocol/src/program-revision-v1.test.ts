import { describe, expect, it } from "vitest";
import {
  PROGRAM_REVISION_MESSAGE_VERSION,
  PROGRAM_REVISION_PLANNING_ENVELOPE_MAX_BYTES,
  PROGRAM_REVISION_PLANNING_MAX_BYTES,
  PROGRAM_REVISION_PLANNING_SEMANTIC_MAX_BYTES,
  isAgentToHostMessageV2Aware,
  isHostToAgentMessageV2Aware,
  isProgramRevisionPlanWireV1,
  isProgramRevisionProposalResultWireV1,
  isProgramRevisionProposalWireV1,
} from "./index.ts";

const plan = {
  type: "program.revision.plan",
  version: PROGRAM_REVISION_MESSAGE_VERSION,
  requestId: "request-1",
  sessionId: "session-1",
  planningEpisodeId: "episode-1",
  programStateId: "program-1",
  fromProgramStateRevision: 8,
  parentProgramRevisionId: "revision-1",
  semanticState: { programStateId: "program-1", currentRevision: { programRevisionId: "revision-1" } },
} as const;

const proposal = {
  type: "program.revision.proposal",
  version: PROGRAM_REVISION_MESSAGE_VERSION,
  requestId: "request-2",
  sessionId: "session-1",
  planningEpisodeId: "episode-1",
  programStateId: "program-1",
  parentProgramRevisionId: "revision-1",
  proposedChangeClass: "refinement",
  proposedEdit: { workItems: [] },
  rationale: "Narrow the exact semantic work.",
} as const;

const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("A1 negotiated program_revision_v1 wire", () => {
  it("accepts bounded plan/proposal/result messages through V2-aware routing without protocol-version bump", () => {
    expect(isProgramRevisionPlanWireV1(plan)).toBe(true);
    expect(isHostToAgentMessageV2Aware(plan)).toBe(true);
    expect(isProgramRevisionProposalWireV1(proposal)).toBe(true);
    expect(isAgentToHostMessageV2Aware(proposal)).toBe(true);
    const result = {
      type: "program.revision.proposal.result",
      version: PROGRAM_REVISION_MESSAGE_VERSION,
      requestId: proposal.requestId,
      sessionId: proposal.sessionId,
      planningEpisodeId: proposal.planningEpisodeId,
      outcome: "sealed",
      draftId: "draft-1",
      draftDigest: "digest-1",
    } as const;
    expect(isProgramRevisionProposalResultWireV1(result)).toBe(true);
    expect(isHostToAgentMessageV2Aware(result)).toBe(true);
  });

  it("reserves a separately bounded wire envelope above the semantic-state ceiling", () => {
    const semanticState = {
      padding: "x".repeat(PROGRAM_REVISION_PLANNING_SEMANTIC_MAX_BYTES - 32),
    };
    const nearLimitPlan = { ...plan, semanticState };

    expect(bytes(semanticState)).toBeLessThanOrEqual(PROGRAM_REVISION_PLANNING_SEMANTIC_MAX_BYTES);
    expect(bytes(nearLimitPlan)).toBeGreaterThan(PROGRAM_REVISION_PLANNING_SEMANTIC_MAX_BYTES);
    expect(bytes(nearLimitPlan)).toBeLessThanOrEqual(PROGRAM_REVISION_PLANNING_MAX_BYTES);
    expect(isProgramRevisionPlanWireV1(nearLimitPlan)).toBe(true);
    expect(isHostToAgentMessageV2Aware(nearLimitPlan)).toBe(true);

    expect(isProgramRevisionPlanWireV1({
      ...nearLimitPlan,
      requestId: "r".repeat(PROGRAM_REVISION_PLANNING_ENVELOPE_MAX_BYTES),
    })).toBe(false);
    expect(isProgramRevisionPlanWireV1({
      ...plan,
      semanticState: { padding: "x".repeat(PROGRAM_REVISION_PLANNING_SEMANTIC_MAX_BYTES) },
    })).toBe(false);
  });

  it("rejects malformed or unbounded advisory revision messages", () => {
    expect(isProgramRevisionProposalWireV1({ ...proposal, proposedChangeClass: "initial" })).toBe(false);
    expect(isProgramRevisionProposalWireV1({ ...proposal, proposedEdit: [] })).toBe(false);
    expect(isProgramRevisionProposalWireV1({ ...proposal, rationale: "x".repeat(5 * 1024) })).toBe(false);
    expect(isProgramRevisionPlanWireV1({ ...plan, fromProgramStateRevision: 0 })).toBe(false);
    expect(isProgramRevisionProposalResultWireV1({
      type: "program.revision.proposal.result",
      version: 1,
      requestId: "r",
      sessionId: "s",
      planningEpisodeId: "p",
      outcome: "sealed",
    })).toBe(false);
  });
});
