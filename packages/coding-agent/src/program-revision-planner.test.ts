import { describe, expect, it, vi } from "vitest";
import type { ModelEvent, ModelProvider, ModelStream } from "@alcode/agent-core";
import {
  PROGRAM_REVISION_MESSAGE_VERSION,
  type ProgramRevisionPlanWireV1,
  type ProgramRevisionProposalResultWireV1,
} from "@alcode/agent-protocol";
import { ProgramRevisionProtocolClientValidationError } from "./program-revision-protocol-client-v1.ts";
import {
  PROGRAM_REVISION_PROPOSAL_TOOL_NAME,
  ProgramRevisionPlannerCancelledError,
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

  it("returns local wire-limit validation failures to the planner for correction", async () => {
    const submitProposal = vi.fn()
      .mockRejectedValueOnce(new ProgramRevisionProtocolClientValidationError())
      .mockResolvedValueOnce(result("sealed", { draftId: "draft-1", draftDigest: "digest-1" }));
    const model = provider([
      proposal({ proposedChangeClass: "refinement", proposedEdit: { workItems: [] }, rationale: "x" }, "oversized-local"),
      proposal({ proposedChangeClass: "refinement", proposedEdit: { workItems: [] } }, "corrected-local"),
    ]);

    await expect(runProgramRevisionPlanner({
      plan,
      provider: model,
      client: { submitProposal },
    })).resolves.toEqual({ outcome: "sealed", turns: 2 });
    expect(submitProposal).toHaveBeenCalledTimes(2);
  });

  it("cancels the model planning run before Host submission", async () => {
    const controller = new AbortController();
    const submitProposal = vi.fn(async () => result("sealed", { draftId: "draft-1", draftDigest: "digest-1" }));
    const model: ModelProvider = {
      async stream(request): Promise<ModelStream> {
        expect(request.signal).toBe(controller.signal);
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "tool_call",
              id: "cancelled-before-submit",
              name: PROGRAM_REVISION_PROPOSAL_TOOL_NAME,
              arguments: { proposedChangeClass: "refinement", proposedEdit: { workItems: [] } },
            } satisfies ModelEvent;
            controller.abort("Application cancelled session");
            yield { type: "done", stopReason: "tool_use" } satisfies ModelEvent;
          },
        };
      },
    };

    await expect(runProgramRevisionPlanner({
      plan,
      provider: model,
      client: { submitProposal },
      signal: controller.signal,
    })).rejects.toBeInstanceOf(ProgramRevisionPlannerCancelledError);
    expect(submitProposal).not.toHaveBeenCalled();
  });

  it("reconciles the Host result once submission has consumed planning authority", async () => {
    const controller = new AbortController();
    const submitProposal = vi.fn(async () => {
      controller.abort("Application cancelled after Host submission began");
      return result("sealed", { draftId: "draft-1", draftDigest: "digest-1" });
    });

    await expect(runProgramRevisionPlanner({
      plan,
      provider: provider([
        proposal({ proposedChangeClass: "refinement", proposedEdit: { workItems: [] } }, "submitted-before-cancel"),
      ]),
      client: { submitProposal },
      signal: controller.signal,
    })).resolves.toEqual({ outcome: "sealed", turns: 1 });
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
