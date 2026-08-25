import { describe, expect, it } from "vitest";
import {
  PROGRAM_REVISION_CAPABILITY,
  PROGRAM_REVISION_MESSAGE_VERSION,
  PROGRAM_STATE_V2_CAPABILITY,
  createInMemoryTransportPair,
  isProgramRevisionProposalResultWireV1,
  type AgentToHostMessageV2Aware,
  type HostToAgentMessageV2Aware,
  type ProgramRevisionProposalResultWireV1,
  type ProgramRevisionProposalWireV1,
  type ProtocolTransport,
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

function proposal(requestId = "proposal-request-1"): ProgramRevisionProposalWireV1 {
  return {
    type: "program.revision.proposal",
    version: PROGRAM_REVISION_MESSAGE_VERSION,
    requestId,
    sessionId: "session-1",
    planningEpisodeId: "episode-1",
    programStateId: String(semanticState.programStateId),
    parentProgramRevisionId: String(semanticState.currentRevision.programRevisionId),
    proposedChangeClass: "refinement",
    proposedEdit: { workItems: [] },
    rationale: "Exact advisory proposal",
  };
}

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
      cancel() {},
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
        cancel() {},
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

  it("deduplicates concurrent duplicate proposal request IDs before Host draft sealing", async () => {
    const pair = createInMemoryTransportPair<HostToAgentMessageV2Aware, AgentToHostMessageV2Aware>();
    let submitCalls = 0;
    let started!: () => void;
    let release!: () => void;
    const submitStarted = new Promise<void>((resolve) => { started = resolve; });
    const submitRelease = new Promise<void>((resolve) => { release = resolve; });
    const host = new ProgramRevisionProtocolHostV1({
      planning: {
        async begin() { throw new Error("not used"); },
        cancel() {},
        async submitProposal() {
          submitCalls += 1;
          started();
          await submitRelease;
          return { draftId: "dedup-draft", draftDigest: "dedup-digest" };
        },
      },
    });
    host.attach({
      generationId: "connection-1",
      agentGeneration: 4,
      sessionId: "session-1",
      capabilities: [PROGRAM_STATE_V2_CAPABILITY, PROGRAM_REVISION_CAPABILITY],
      transport: pair.a,
    });

    const message = proposal("duplicate-request");
    const first = host.handleProposal(message, "connection-1");
    await submitStarted;
    const duplicate = host.handleProposal(structuredClone(message), "connection-1");
    expect(submitCalls).toBe(1);
    release();

    await expect(first).resolves.toMatchObject({ outcome: "sealed", draftId: "dedup-draft" });
    await expect(duplicate).resolves.toMatchObject({ outcome: "sealed", draftId: "dedup-draft" });
    expect(submitCalls).toBe(1);
  });

  it("cancels the exact planning episode when plan delivery fails", async () => {
    let cancelled: unknown;
    const transport: ProtocolTransport<HostToAgentMessageV2Aware, AgentToHostMessageV2Aware> = {
      async send(message) {
        if (message.type === "program.revision.plan") throw new Error("synthetic plan delivery failure");
      },
      onMessage() { return () => undefined; },
      async close() {},
    };
    const host = new ProgramRevisionProtocolHostV1({
      planning: {
        async begin() {
          return {
            planningEpisodeId: "episode-undelivered",
            requestId: "plan-undelivered",
            sourceSessionId: "session-1",
            programStateId: String(semanticState.programStateId),
            fromProgramStateRevision: 8,
            parentProgramRevisionId: String(semanticState.currentRevision.programRevisionId),
            semanticState,
          };
        },
        cancel(input) { cancelled = input; },
        async submitProposal() { throw new Error("must not run"); },
      },
    });
    host.attach({
      generationId: "connection-1",
      agentGeneration: 4,
      sessionId: "session-1",
      capabilities: [PROGRAM_STATE_V2_CAPABILITY, PROGRAM_REVISION_CAPABILITY],
      transport,
    });

    await expect(host.begin({
      sessionId: "session-1",
      generationId: "connection-1",
      programStateId: String(semanticState.programStateId),
    })).rejects.toThrow("synthetic plan delivery failure");
    expect(cancelled).toEqual({
      planningEpisodeId: "episode-undelivered",
      sourceSessionId: "session-1",
      connectionGenerationId: "connection-1",
      agentGeneration: 4,
    });
  });

  it("cancels delivered planning episodes when a generation detaches before proposal", async () => {
    const pair = createInMemoryTransportPair<HostToAgentMessageV2Aware, AgentToHostMessageV2Aware>();
    let cancelled: unknown;
    const host = new ProgramRevisionProtocolHostV1({
      planning: {
        async begin() {
          return {
            planningEpisodeId: "episode-delivered",
            requestId: "plan-delivered",
            sourceSessionId: "session-1",
            programStateId: String(semanticState.programStateId),
            fromProgramStateRevision: 8,
            parentProgramRevisionId: String(semanticState.currentRevision.programRevisionId),
            semanticState,
          };
        },
        cancel(input) { cancelled = input; },
        async submitProposal() { throw new Error("must not run"); },
      },
    });
    host.attach({
      generationId: "connection-delivered",
      agentGeneration: 5,
      sessionId: "session-1",
      capabilities: [PROGRAM_STATE_V2_CAPABILITY, PROGRAM_REVISION_CAPABILITY],
      transport: pair.a,
    });

    await expect(host.begin({
      sessionId: "session-1",
      generationId: "connection-delivered",
      programStateId: String(semanticState.programStateId),
    })).resolves.toMatchObject({ planningEpisodeId: "episode-delivered" });
    expect(cancelled).toBeUndefined();

    host.detach("connection-delivered");
    expect(cancelled).toEqual({
      planningEpisodeId: "episode-delivered",
      sourceSessionId: "session-1",
      connectionGenerationId: "connection-delivered",
      agentGeneration: 5,
    });
  });

  it("emits a wire-valid nonempty failure when Host planning throws an empty error message", async () => {
    const pair = createInMemoryTransportPair<HostToAgentMessageV2Aware, AgentToHostMessageV2Aware>();
    let delivered: ProgramRevisionProposalResultWireV1 | undefined;
    pair.b.onMessage((message) => {
      if (message.type === "program.revision.proposal.result") delivered = message;
    });
    const host = new ProgramRevisionProtocolHostV1({
      planning: {
        async begin() { throw new Error("not used"); },
        cancel() {},
        async submitProposal() { throw new Error(""); },
      },
    });
    host.attach({
      generationId: "connection-empty-error",
      agentGeneration: 6,
      sessionId: "session-1",
      capabilities: [PROGRAM_STATE_V2_CAPABILITY, PROGRAM_REVISION_CAPABILITY],
      transport: pair.a,
    });

    const response = await host.handleProposal(proposal("empty-error-request"), "connection-empty-error");
    expect(response).toMatchObject({
      outcome: "failed",
      errorCode: "program_revision_runtime_failure",
      error: "Unknown revision protocol failure",
    });
    expect(isProgramRevisionProposalResultWireV1(response)).toBe(true);
    expect(delivered).toEqual(response);
  });
});
