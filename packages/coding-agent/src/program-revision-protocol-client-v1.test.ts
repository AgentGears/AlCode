import { describe, expect, it } from "vitest";
import {
  PROGRAM_REVISION_MESSAGE_VERSION,
  createInMemoryTransportPair,
  type AgentToHostMessageV2Aware,
  type HostToAgentMessageV2Aware,
} from "@alcode/agent-protocol";
import { createProgramRevisionProtocolClientV1 } from "./program-revision-protocol-client-v1.ts";

describe("coding-Agent program_revision_v1 client", () => {
  it("receives Host plans and correlates exact proposal results", async () => {
    const pair = createInMemoryTransportPair<HostToAgentMessageV2Aware, AgentToHostMessageV2Aware>();
    const client = createProgramRevisionProtocolClientV1(pair.b);
    let receivedProposal: AgentToHostMessageV2Aware | undefined;
    pair.a.onMessage(async (message) => {
      receivedProposal = message;
      if (message.type === "program.revision.proposal") {
        await pair.a.send({
          type: "program.revision.proposal.result",
          version: PROGRAM_REVISION_MESSAGE_VERSION,
          requestId: message.requestId,
          sessionId: message.sessionId,
          planningEpisodeId: message.planningEpisodeId,
          outcome: "sealed",
          draftId: "draft-1",
          draftDigest: "digest-1",
        });
      }
    });

    let resultPromise: Promise<any> | undefined;
    client.onPlan((plan) => {
      resultPromise = client.submitProposal({
        sessionId: plan.sessionId,
        planningEpisodeId: plan.planningEpisodeId,
        programStateId: plan.programStateId,
        parentProgramRevisionId: plan.parentProgramRevisionId,
        proposedChangeClass: "refinement",
        proposedEdit: { workItems: [] },
      });
    });

    await pair.a.send({
      type: "program.revision.plan",
      version: PROGRAM_REVISION_MESSAGE_VERSION,
      requestId: "plan-1",
      sessionId: "session-1",
      planningEpisodeId: "episode-1",
      programStateId: "program-1",
      fromProgramStateRevision: 9,
      parentProgramRevisionId: "revision-1",
      semanticState: { currentRevision: { programRevisionId: "revision-1" } },
    });

    expect(resultPromise).toBeDefined();
    await expect(resultPromise!).resolves.toMatchObject({ outcome: "sealed", draftId: "draft-1" });
    expect(receivedProposal).toMatchObject({
      type: "program.revision.proposal",
      sessionId: "session-1",
      planningEpisodeId: "episode-1",
      parentProgramRevisionId: "revision-1",
    });
    client.close();
  });
});
