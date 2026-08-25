import { describe, expect, it } from "vitest";
import {
  PROGRAM_REVISION_CAPABILITY,
  PROGRAM_REVISION_MESSAGE_VERSION,
  PROGRAM_STATE_V2_CAPABILITY,
  createInMemoryTransportPair,
  type AgentToHostMessageV2Aware,
  type HostToAgentMessageV2Aware,
  type ProgramRevisionProposalResultWireV1,
} from "@alcode/agent-protocol";
import { asProgramRevisionId, asProgramStateId, type ProgramSemanticStateV1 } from "@alcode/program-state";
import { ProgramRevisionProtocolHostV1 } from "./program-revision-protocol-v1.ts";

const semanticState: ProgramSemanticStateV1 = {
  programStateId: asProgramStateId("018f0000-0000-7000-8000-000000000d01"),
  currentRevision: {
    programRevisionId: asProgramRevisionId("revision-1"),
    parentProgramRevisionId: null,
    ordinal: 1,
    changeClass: "initial",
    acceptedAtStateRevision: 8,
    admissionEventId: "baseline-event",
    sourceDraftId: null,
    sourceDraftDigest: null,
  },
  workItems: [],
  verification: [],
  verificationBindings: [],
  outputSlots: [],
  productionSteps: [],
};

describe("A1 program_revision_v1 Host protocol adapter", () => {
  it("runs Host planning -> Agent proposal -> Host sealed-result over negotiated capability", async () => {
    const pair = createInMemoryTransportPair<HostToAgentMessageV2Aware, AgentToHostMessageV2Aware>();
    let submitted: any;
    const planning = {
      async begin() {
        return {
          planningEpisodeId: "episode-1",
          requestId: "plan-request-1",
          sourceSessionId: "session-1",
          programStateId: String(semanticState.programStateId),
          fromProgramStateRevision: 8,
          parentProgramRevisionId: String(semanticState.currentRevision.programRevisionId),
          semanticState,
        };
      },
      async submitProposal(input: any) {
        submitted = input;
        return { draftId: "draft-1", draftDigest: "digest-1" };
      },
    };
    const host = new ProgramRevisionProtocolHostV1({ planning });
    host.attach({
      generationId: "connection-1",
      agentGeneration: 4,
      sessionId: "session-1",
      capabilities: [PROGRAM_STATE_V2_CAPABILITY, PROGRAM_REVISION_CAPABILITY],
      transport: pair.a,
    });
    pair.a.onMessage(async (message) => {
      if (message.type === "program.revision.proposal") await host.handleProposal(message, "connection-1");
    });

    let proposalResult: ProgramRevisionProposalResultWireV1 | undefined;
    pair.b.onMessage(async (message) => {
      if (message.type === "program.revision.plan") {
        await pair.b.send({
          type: "program.revision.proposal",
          version: PROGRAM_REVISION_MESSAGE_VERSION,
          requestId: "proposal-request-1",
          sessionId: message.sessionId,
          planningEpisodeId: message.planningEpisodeId,
          programStateId: message.programStateId,
          parentProgramRevisionId: message.parentProgramRevisionId,
          proposedChangeClass: "refinement",
          proposedEdit: { workItems: [] },
          rationale: "Exact advisory proposal",
        });
      } else if (message.type === "program.revision.proposal.result") {
        proposalResult = message;
      }
    });

    const plan = await host.begin({
      sessionId: "session-1",
      generationId: "connection-1",
      programStateId: String(semanticState.programStateId),
    });
    expect(plan.parentProgramRevisionId).toBe("revision-1");
    expect(proposalResult).toMatchObject({ outcome: "sealed", draftId: "draft-1", draftDigest: "digest-1" });
    expect(submitted.proposal).toMatchObject({
      planningEpisodeId: "episode-1",
      proposedChangeClass: "refinement",
      rationale: "Exact advisory proposal",
    });
  });

  it("fails capability negotiation closed and rejects displaced generations", async () => {
    const pair = createInMemoryTransportPair<HostToAgentMessageV2Aware, AgentToHostMessageV2Aware>();
    const host = new ProgramRevisionProtocolHostV1({
      planning: {
        async begin() { throw new Error("must not run"); },
        async submitProposal() { throw new Error("must not run"); },
      },
    });
    expect(() => host.attach({
      generationId: "connection-1",
      agentGeneration: 1,
      sessionId: "session-1",
      capabilities: [PROGRAM_STATE_V2_CAPABILITY],
      transport: pair.a,
    })).toThrow(/program_revision_v1/);

    host.attach({
      generationId: "connection-1",
      agentGeneration: 1,
      sessionId: "session-1",
      capabilities: [PROGRAM_STATE_V2_CAPABILITY, PROGRAM_REVISION_CAPABILITY],
      transport: pair.a,
    });
    host.detach("connection-1");
    await expect(host.begin({
      sessionId: "session-1",
      generationId: "connection-1",
      programStateId: String(semanticState.programStateId),
    })).rejects.toThrow(/not current/);
  });
});
