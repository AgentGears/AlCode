import { describe, expect, it } from "vitest";
import {
  PROGRAM_REVISION_MESSAGE_VERSION,
  createInMemoryTransportPair,
  type AgentToHostMessageV2Aware,
  type HostToAgentMessageV2Aware,
  type ProtocolTransport,
} from "@alcode/agent-protocol";
import {
  ProgramRevisionProtocolClientPlanHandlerError,
  ProgramRevisionProtocolClientTimeoutError,
  ProgramRevisionProtocolClientValidationError,
  createProgramRevisionProtocolClientV1,
} from "./index.ts";

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

  it("routes rejected asynchronous plan handlers through the client error channel", async () => {
    const pair = createInMemoryTransportPair<HostToAgentMessageV2Aware, AgentToHostMessageV2Aware>();
    const client = createProgramRevisionProtocolClientV1(pair.b);
    const observed = new Promise<ProgramRevisionProtocolClientPlanHandlerError>((resolve) => {
      client.onError((error) => resolve(error));
    });
    client.onPlan(async () => {
      throw new Error("synthetic plan handler failure");
    });

    await pair.a.send({
      type: "program.revision.plan",
      version: PROGRAM_REVISION_MESSAGE_VERSION,
      requestId: "plan-error",
      sessionId: "session-error",
      planningEpisodeId: "episode-error",
      programStateId: "program-error",
      fromProgramStateRevision: 9,
      parentProgramRevisionId: "revision-error",
      semanticState: { currentRevision: { programRevisionId: "revision-error" } },
    });

    const error = await observed;
    expect(error).toBeInstanceOf(ProgramRevisionProtocolClientPlanHandlerError);
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toBe("synthetic plan handler failure");
    client.close();
  });

  it("bounds pending proposal lifetime when the Host never responds", async () => {
    const pair = createInMemoryTransportPair<HostToAgentMessageV2Aware, AgentToHostMessageV2Aware>();
    const client = createProgramRevisionProtocolClientV1(pair.b, { proposalTimeoutMs: 20 });
    const pending = client.submitProposal({
      sessionId: "session-timeout",
      planningEpisodeId: "episode-timeout",
      programStateId: "program-timeout",
      parentProgramRevisionId: "revision-timeout",
      proposedChangeClass: "correction",
      proposedEdit: { workItems: [] },
    });
    await expect(pending).rejects.toBeInstanceOf(ProgramRevisionProtocolClientTimeoutError);
    client.close();
  });

  it("handles a synchronous transport send failure without leaving an unresolved request", async () => {
    const transport: ProtocolTransport<AgentToHostMessageV2Aware, HostToAgentMessageV2Aware> = {
      send(): Promise<void> {
        throw new Error("synthetic send failure");
      },
      onMessage() { return () => undefined; },
      async close() {},
    };
    const client = createProgramRevisionProtocolClientV1(transport, { proposalTimeoutMs: 100 });
    await expect(client.submitProposal({
      sessionId: "session-failure",
      planningEpisodeId: "episode-failure",
      programStateId: "program-failure",
      parentProgramRevisionId: "revision-failure",
      proposedChangeClass: "refinement",
      proposedEdit: { workItems: [] },
    })).rejects.toThrow("synthetic send failure");
    client.close();
  });

  it("rejects an oversized proposal locally before checked Host IPC sees the frame", async () => {
    let sendCalls = 0;
    const transport: ProtocolTransport<AgentToHostMessageV2Aware, HostToAgentMessageV2Aware> = {
      async send() { sendCalls += 1; },
      onMessage() { return () => undefined; },
      async close() {},
    };
    const client = createProgramRevisionProtocolClientV1(transport);
    await expect(client.submitProposal({
      sessionId: "session-invalid",
      planningEpisodeId: "episode-invalid",
      programStateId: "program-invalid",
      parentProgramRevisionId: "revision-invalid",
      proposedChangeClass: "refinement",
      proposedEdit: { workItems: [] },
      rationale: "x".repeat(5000),
    })).rejects.toBeInstanceOf(ProgramRevisionProtocolClientValidationError);
    expect(sendCalls).toBe(0);
    client.close();
  });

  it("rejects cloneable but non-canonical proposal input before transport send", async () => {
    let sendCalls = 0;
    const transport: ProtocolTransport<AgentToHostMessageV2Aware, HostToAgentMessageV2Aware> = {
      async send() { sendCalls += 1; },
      onMessage() { return () => undefined; },
      async close() {},
    };
    const client = createProgramRevisionProtocolClientV1(transport);
    const result = client.submitProposal({
      sessionId: "session-noncanonical",
      planningEpisodeId: "episode-noncanonical",
      programStateId: "program-noncanonical",
      parentProgramRevisionId: "revision-noncanonical",
      proposedChangeClass: "correction",
      proposedEdit: { generatedAt: new Date("2026-08-25T00:00:00.000Z") },
    });

    await expect(result).rejects.toBeInstanceOf(ProgramRevisionProtocolClientValidationError);
    expect(sendCalls).toBe(0);
    client.close();
  });

  it("converts non-cloneable proposal input into an asynchronous validation rejection", async () => {
    let sendCalls = 0;
    const transport: ProtocolTransport<AgentToHostMessageV2Aware, HostToAgentMessageV2Aware> = {
      async send() { sendCalls += 1; },
      onMessage() { return () => undefined; },
      async close() {},
    };
    const client = createProgramRevisionProtocolClientV1(transport);
    const result = client.submitProposal({
      sessionId: "session-noncloneable",
      planningEpisodeId: "episode-noncloneable",
      programStateId: "program-noncloneable",
      parentProgramRevisionId: "revision-noncloneable",
      proposedChangeClass: "correction",
      proposedEdit: { callback: () => undefined },
    });

    await expect(result).rejects.toBeInstanceOf(ProgramRevisionProtocolClientValidationError);
    expect(sendCalls).toBe(0);
    client.close();
  });
});
