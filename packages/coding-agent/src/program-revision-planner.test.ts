import { describe, expect, it, vi } from "vitest";
import type { ModelEvent, ModelProvider, ModelStream } from "@alcode/agent-core";
import {
  PROGRAM_REVISION_MESSAGE_VERSION,
  type ProgramRevisionPlanWireV1,
  type ProgramRevisionProposalResultWireV1,
} from "@alcode/agent-protocol";
import {
  PROGRAM_REVISION_PROPOSAL_TOOL_NAME,
  ProgramRevisionPlannerError,
  runProgramRevisionPlanner,
} from "./program-revision-planner.ts";

const plan: ProgramRevisionPlanWireV1 = {
  type: "program.revision.plan",
  version: PROGRAM_REVISION_MESSAGE_VERSION,
  requestId: "plan-request",
  sessionId: "session-1",
  planningEpisodeId: "episode-1",
  programStateId: "program-1",
  fromProgramStateRevision: 9,
  parentProgramRevisionId: "revision-1",
  semanticState: { currentRevision: { programRevisionId: "revision-1" } },
};

function provider(turns: readonly (readonly ModelEvent[])[]): ModelProvider {
  let turn = 0;
  return {
    async stream(): Promise<ModelStream> {
      const events = turns[turn++] ?? [];
      return {
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event;
        },
      };
    },
  };
}

function proposal(argumentsValue: Record<string, unknown>, id: string): readonly ModelEvent[] {
  return [
    {
      type: "tool_call",
      id,
      name: PROGRAM_REVISION_PROPOSAL_TOOL_NAME,
      arguments: argumentsValue,
    },
    { type: "done", stopReason: "tool_use" },
  ];
}

function result(outcome: ProgramRevisionProposalResultWireV1["outcome"], extras: Partial<ProgramRevisionProposalResultWireV1> = {}): ProgramRevisionProposalResultWireV1 {
  return {
    type: "program.revision.proposal.result",
    version: PROGRAM_REVISION_MESSAGE_VERSION,
    requestId: "proposal-request",
    sessionId: plan.sessionId,
    planningEpisodeId: plan.planningEpisodeId,
    outcome,
    ...extras,
  };
}

describe("A1 production semantic revision planner", () => {
  it("allows local proposal-shape correction before consuming Host planning authority", async () => {
    const submitProposal = vi.fn(async () => result("sealed", { draftId: "draft-1", draftDigest: "digest-1" }));
    const model = provider([
      proposal({ proposedChangeClass: "refinement" }, "bad-local"),
      proposal({ proposedChangeClass: "refinement", proposedEdit: { workItems: [] } }, "good-local"),
    ]);

    await expect(runProgramRevisionPlanner({
      plan,
      provider: model,
      client: { submitProposal },
    })).resolves.toEqual({ outcome: "sealed", turns: 2 });
    expect(submitProposal).toHaveBeenCalledTimes(1);
  });

  it("treats Host denial as terminal because the exact delivered planning episode is consumed", async () => {
    const submitProposal = vi.fn(async () => result("denied", {
      errorCode: "ProgramRevisionControlError",
      error: "Host semantic validation denied the proposal",
    }));
    const model = provider([
      proposal({ proposedChangeClass: "correction", proposedEdit: { workItems: [] } }, "first"),
      proposal({ proposedChangeClass: "correction", proposedEdit: { workItems: [] } }, "must-not-run"),
    ]);

    await expect(runProgramRevisionPlanner({
      plan,
      provider: model,
      client: { submitProposal },
    })).rejects.toThrow(ProgramRevisionPlannerError);
    expect(submitProposal).toHaveBeenCalledTimes(1);
  });
});
