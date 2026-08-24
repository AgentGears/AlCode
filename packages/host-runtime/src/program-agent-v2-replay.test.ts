import { describe, expect, it } from "vitest";
import {
  PROGRAM_EXECUTION_V2_CAPABILITY,
  PROGRAM_STATE_V2_CAPABILITY,
  type AgentToHostMessageV2Aware,
  type CapabilityRequestV2,
  type HostToAgentMessageV2Aware,
  type ProgramAttemptAuthorityV2,
  type ProgramProgressProposalV2,
  type ProtocolTransport,
} from "@alcode/agent-protocol";
import {
  asProgramAttemptId,
  asProgramRevisionId,
  asProgramStateId,
  asProgramWorkItemId,
  type ProgramSemanticStateV1,
  type WorkAuthorityEnvelopeV1,
} from "@alcode/program-state";
import { asSessionId } from "@alcode/events";
import {
  ProgramAgentServiceV2,
  type ProgramAdaptiveExecutionCutSourceV2,
  type ProgramAdaptiveExecutionCutV2,
} from "./program-agent-v2.ts";

const sessionId = "018f0000-0000-7000-8000-000000000962";
const programStateId = asProgramStateId("018f0000-0000-7000-8000-000000000961");
const workItemId = asProgramWorkItemId("replay-work");
const attemptId = asProgramAttemptId("replay-attempt");
const revisionId = asProgramRevisionId("replay-r1");

function envelope(): WorkAuthorityEnvelopeV1 {
  return {
    objectiveBoundaryRef: {
      programStateId,
      rootProgramRevisionId: revisionId,
      anchorWorkItemId: workItemId,
    },
    allowedRepositoryRoots: ["."],
    allowedEffectClasses: ["fs.read", "fs.write"],
    allowedExternalSystems: [],
    capabilityCeiling: ["edit", "read"],
    maximumTopologyExpansion: 8,
    mandatoryVerificationIds: [],
    forbiddenChangeKinds: ["delete_repository"],
  };
}

function semanticState(): ProgramSemanticStateV1 {
  return {
    programStateId,
    currentRevision: {
      programRevisionId: revisionId,
      parentProgramRevisionId: null,
      ordinal: 1,
      changeClass: "initial",
      acceptedAtStateRevision: 1,
      admissionEventId: "baseline",
      sourceDraftId: null,
      sourceDraftDigest: null,
    },
    workItems: [{
      workItemId,
      creationOrder: 0,
      description: "Replay-safe adaptive work",
      dependencyIds: [],
      affectedPaths: ["src/replay.ts"],
      workItemGeneration: 1,
      requirementState: "required",
      topologyState: "leaf",
      satisfactionState: "active",
      parentWorkItemId: null,
      authorityEnvelope: envelope(),
    }],
    verification: [],
    verificationBindings: [],
    outputSlots: [],
    productionSteps: [],
  };
}

function makeCut(): ProgramAdaptiveExecutionCutV2 {
  return {
    facts: {
      semantic: {
        programStateRevision: 1,
        semanticState: semanticState(),
        activeAttempt: {
          programAttemptId: attemptId,
          workItemId,
          workItemGeneration: 1,
          directDependencies: [],
          workAuthorityEnvelope: envelope(),
        },
        lifecycle: "active",
        attachedSessionIds: [sessionId],
      },
      runtime: {
        programAttemptId: String(attemptId),
        sessionId,
        agentGeneration: 1,
        sessionActive: true,
        agentGenerationCurrent: true,
        recoveryClear: true,
        writerBarriersClear: true,
        quiescenceClear: true,
        executionBaseCurrent: true,
      },
    },
    projection: {
      objective: "Replay-safe adaptive objective",
      work: {
        description: "Replay-safe adaptive work",
        requirementState: "required",
        topologyState: "leaf",
        satisfactionState: "active",
        dependencyIds: [],
        affectedPaths: ["src/replay.ts"],
        omittedAffectedPathCount: 0,
      },
      dependencies: [],
      blockers: [],
      executionBase: {
        workspaceEffectGeneration: 1,
        observation: {
          kind: "workspace-observation-v1",
          providerKind: "git",
          workspaceIdentity: "workspace-replay",
          coverageDigest: "coverage",
          stateDigest: "state",
        },
      },
      verification: [],
      outputSlots: [],
      productionSteps: [],
      decisiveEvidence: [],
      artifacts: [],
      control: { executionBaseMismatch: false, executionBaseUnavailable: false },
      omissions: { verification: 0, blockers: 0, evidence: 0, artifacts: 0 },
      stopConditions: {
        attemptMustRemainCurrent: true,
        rebaseRequiredOnExecutionBaseMismatch: true,
        hostOwnsVerificationAndCompletion: true,
      },
    },
    operationalProgramContext: {
      programStateId: String(programStateId),
      expectedProgramRevision: 1,
      programAttemptId: String(attemptId),
      workItemId: String(workItemId),
      agentGeneration: 1,
    },
  };
}

function transport(sent: HostToAgentMessageV2Aware[] = []): ProtocolTransport<HostToAgentMessageV2Aware, AgentToHostMessageV2Aware> {
  return {
    async send(message) { sent.push(structuredClone(message)); },
    onMessage() { return () => undefined; },
    async close() {},
  };
}

function cuts(read: () => ProgramAdaptiveExecutionCutV2): ProgramAdaptiveExecutionCutSourceV2 {
  return {
    currentForSession: async () => structuredClone(read()),
    withProtectedCut: async (_session, _generation, work) => work(structuredClone(read())),
  };
}

function capability(authority: ProgramAttemptAuthorityV2, index: number): CapabilityRequestV2 {
  return {
    type: "capability.request",
    requestId: `cap-${index}`,
    sessionId,
    toolCallId: `tool-${index}`,
    toolName: "read",
    args: { path: "src/replay.ts" },
    programAttemptAuthority: structuredClone(authority),
  };
}

function progress(authority: ProgramAttemptAuthorityV2, index: number): ProgramProgressProposalV2 {
  return {
    type: "program.progress",
    version: 2,
    requestId: `progress-${index}`,
    sessionId,
    authority: structuredClone(authority),
    evidence: [],
    advisoryBlockers: [],
    requestAwaitingVerification: true,
  };
}

describe("A1 adaptive V2 replay-window and generation safety", () => {
  it("closes the capability replay window without forgetting retained request IDs", async () => {
    const cut = makeCut();
    let executions = 0;
    const service = new ProgramAgentServiceV2({
      cuts: cuts(() => cut),
      progress: { admit: async () => ({ outcome: "admitted" }) },
    });
    service.attach({
      generationId: "generation-1",
      sessionId,
      capabilities: [PROGRAM_STATE_V2_CAPABILITY, PROGRAM_EXECUTION_V2_CAPABILITY],
      transport: transport(),
    });
    const authority = (await service.currentAttemptProjection(sessionId, "generation-1"))!.authority;

    for (let index = 0; index < 256; index += 1) {
      const request = capability(authority, index);
      const result = await service.handleCapability({
        message: request,
        generationId: "generation-1",
        sessionId: asSessionId(sessionId),
      }, async () => {
        executions += 1;
        return {
          type: "capability.result",
          requestId: request.requestId,
          sessionId,
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          outcome: "succeeded",
          result: { index },
        };
      });
      expect(result.outcome).toBe("succeeded");
    }

    const overflow = capability(authority, 256);
    expect(await service.handleCapability({
      message: overflow,
      generationId: "generation-1",
      sessionId: asSessionId(sessionId),
    }, async () => { throw new Error("closed replay window must not execute"); })).toMatchObject({
      outcome: "denied",
      errorCode: "program_execution_request_window_exhausted",
    });

    const first = capability(authority, 0);
    expect(await service.handleCapability({
      message: first,
      generationId: "generation-1",
      sessionId: asSessionId(sessionId),
    }, async () => { throw new Error("retained replay must not execute"); })).toMatchObject({
      outcome: "succeeded",
      result: { index: 0 },
    });
    expect(executions).toBe(256);
  });

  it("closes the progress replay window without forgetting retained request IDs", async () => {
    const cut = makeCut();
    let admissions = 0;
    const service = new ProgramAgentServiceV2({
      cuts: cuts(() => cut),
      progress: { admit: async () => { admissions += 1; return { outcome: "admitted" }; } },
    });
    service.attach({
      generationId: "generation-1",
      sessionId,
      capabilities: [PROGRAM_STATE_V2_CAPABILITY, PROGRAM_EXECUTION_V2_CAPABILITY],
      transport: transport(),
    });
    const authority = (await service.currentAttemptProjection(sessionId, "generation-1"))!.authority;

    for (let index = 0; index < 256; index += 1) {
      expect(await service.handleProgress(progress(authority, index), "generation-1")).toMatchObject({ outcome: "admitted" });
    }
    expect(await service.handleProgress(progress(authority, 256), "generation-1")).toMatchObject({
      outcome: "denied",
      errorCode: "program_execution_request_window_exhausted",
    });
    expect(await service.handleProgress(progress(authority, 0), "generation-1")).toMatchObject({ outcome: "admitted" });
    expect(admissions).toBe(256);
  });

  it("revalidates the connection generation after an asynchronous current-cut read", async () => {
    const cut = makeCut();
    let releaseRead!: (value: ProgramAdaptiveExecutionCutV2) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const delayedCuts: ProgramAdaptiveExecutionCutSourceV2 = {
      currentForSession: async () => {
        markStarted();
        return new Promise<ProgramAdaptiveExecutionCutV2>((resolve) => { releaseRead = resolve; });
      },
      withProtectedCut: async (_session, _generation, work) => work(structuredClone(cut)),
    };
    const service = new ProgramAgentServiceV2({
      cuts: delayedCuts,
      progress: { admit: async () => ({ outcome: "admitted" }) },
    });
    service.attach({
      generationId: "generation-1",
      sessionId,
      capabilities: [PROGRAM_STATE_V2_CAPABILITY, PROGRAM_EXECUTION_V2_CAPABILITY],
      transport: transport(),
    });

    const pending = service.currentAttemptProjection(sessionId, "generation-1");
    await started;
    service.detach("generation-1");
    service.attach({
      generationId: "generation-2",
      sessionId,
      capabilities: [PROGRAM_STATE_V2_CAPABILITY, PROGRAM_EXECUTION_V2_CAPABILITY],
      transport: transport(),
    });
    releaseRead(structuredClone(cut));
    await expect(pending).rejects.toThrow("Adaptive Program connection is not current");
  });

  it("clears displaced-generation replay state before replacement becomes current", async () => {
    const cut = makeCut();
    const service = new ProgramAgentServiceV2({
      cuts: cuts(() => cut),
      progress: { admit: async () => ({ outcome: "admitted" }) },
    });
    service.attach({
      generationId: "generation-1",
      sessionId,
      capabilities: [PROGRAM_STATE_V2_CAPABILITY, PROGRAM_EXECUTION_V2_CAPABILITY],
      transport: transport(),
    });
    const authority = (await service.currentAttemptProjection(sessionId, "generation-1"))!.authority;
    const first = capability(authority, 0);
    expect(await service.handleCapability({
      message: first,
      generationId: "generation-1",
      sessionId: asSessionId(sessionId),
    }, async () => ({
      type: "capability.result",
      requestId: first.requestId,
      sessionId,
      toolCallId: first.toolCallId,
      toolName: first.toolName,
      outcome: "succeeded",
      result: { generation: 1 },
    }))).toMatchObject({ outcome: "succeeded" });

    service.attach({
      generationId: "generation-2",
      sessionId,
      capabilities: [PROGRAM_STATE_V2_CAPABILITY, PROGRAM_EXECUTION_V2_CAPABILITY],
      transport: transport(),
    });

    expect(await service.handleCapability({
      message: first,
      generationId: "generation-1",
      sessionId: asSessionId(sessionId),
    }, async () => { throw new Error("displaced generation must not execute"); })).toMatchObject({
      outcome: "stale",
      errorCode: "program_execution_stale",
    });
    expect(service.isCurrentConnection(sessionId, "generation-2")).toBe(true);
    expect(service.isCurrentConnection(sessionId, "generation-1")).toBe(false);
  });

  it("caches capability runtime failures so replay cannot re-execute uncertain work", async () => {
    const cut = makeCut();
    let executions = 0;
    const service = new ProgramAgentServiceV2({
      cuts: cuts(() => cut),
      progress: { admit: async () => ({ outcome: "admitted" }) },
    });
    service.attach({
      generationId: "generation-1",
      sessionId,
      capabilities: [PROGRAM_STATE_V2_CAPABILITY, PROGRAM_EXECUTION_V2_CAPABILITY],
      transport: transport(),
    });
    const authority = (await service.currentAttemptProjection(sessionId, "generation-1"))!.authority;
    const request = capability(authority, 900);
    const invoke = () => service.handleCapability({
      message: request,
      generationId: "generation-1",
      sessionId: asSessionId(sessionId),
    }, async () => {
      executions += 1;
      throw new Error("broker exploded after uncertain work");
    });

    expect(await invoke()).toMatchObject({
      outcome: "failed",
      errorCode: "program_execution_runtime_failure",
      error: "broker exploded after uncertain work",
    });
    expect(await invoke()).toMatchObject({
      outcome: "failed",
      errorCode: "program_execution_runtime_failure",
    });
    expect(executions).toBe(1);
  });

  it("caches progress runtime failures so duplicate progress cannot re-admit", async () => {
    const cut = makeCut();
    let admissions = 0;
    const service = new ProgramAgentServiceV2({
      cuts: cuts(() => cut),
      progress: {
        admit: async () => {
          admissions += 1;
          throw new Error("progress admission failed after uncertainty");
        },
      },
    });
    service.attach({
      generationId: "generation-1",
      sessionId,
      capabilities: [PROGRAM_STATE_V2_CAPABILITY, PROGRAM_EXECUTION_V2_CAPABILITY],
      transport: transport(),
    });
    const authority = (await service.currentAttemptProjection(sessionId, "generation-1"))!.authority;
    const request = progress(authority, 900);

    expect(await service.handleProgress(request, "generation-1")).toMatchObject({
      outcome: "failed",
      errorCode: "program_execution_runtime_failure",
      error: "progress admission failed after uncertainty",
    });
    expect(await service.handleProgress(request, "generation-1")).toMatchObject({
      outcome: "failed",
      errorCode: "program_execution_runtime_failure",
    });
    expect(admissions).toBe(1);
  });
});
