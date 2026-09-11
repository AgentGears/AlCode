import { describe, expect, it } from "vitest";
import {
  PROGRAM_EXECUTION_V2_CAPABILITY,
  PROGRAM_STATE_V2_CAPABILITY,
  type CapabilityRequestV2,
  type CapabilityResult,
  type ProgramAttemptAuthorityV2,
} from "@alcode/agent-protocol";
import { asSessionId } from "@alcode/events";
import {
  asProgramAttemptId,
  asProgramRevisionId,
  asProgramStateId,
  asProgramWorkItemId,
  type WorkAuthorityEnvelopeV1,
} from "@alcode/program-state";
import {
  ProgramAgentServiceV2,
  type ProgramAdaptiveExecutionCutSourceV2,
  type ProgramAdaptiveExecutionCutV2,
} from "./program-agent-v2.ts";
import { issueProgramAttemptAuthorityV2 } from "./program-attempt-authority-v2.ts";

const programStateId = asProgramStateId("018f0000-0000-7000-8000-00000000a401");
const sessionId = "018f0000-0000-7000-8000-00000000a402";
const workItemId = asProgramWorkItemId("s02-4-work");
const attemptId = asProgramAttemptId("s02-4-attempt");
const revisionId = asProgramRevisionId("s02-4-revision");

function envelope(): WorkAuthorityEnvelopeV1 {
  return {
    objectiveBoundaryRef: {
      programStateId,
      rootProgramRevisionId: revisionId,
      anchorWorkItemId: workItemId,
    },
    allowedRepositoryRoots: ["."],
    allowedEffectClasses: ["fs.write"],
    allowedExternalSystems: [],
    capabilityCeiling: ["mutate"],
    maximumTopologyExpansion: 0,
    mandatoryVerificationIds: [],
    forbiddenChangeKinds: [],
  };
}

function executionCut(): ProgramAdaptiveExecutionCutV2 {
  const workAuthorityEnvelope = envelope();
  return {
    facts: {
      semantic: {
        programStateRevision: 7,
        semanticState: {
          programStateId,
          currentRevision: {
            programRevisionId: revisionId,
            parentProgramRevisionId: null,
            ordinal: 1,
            changeClass: "initial",
            acceptedAtStateRevision: 7,
            admissionEventId: "s02-4-revision-event",
            sourceDraftId: null,
            sourceDraftDigest: null,
          },
          workItems: [{
            workItemId,
            creationOrder: 0,
            description: "S02-4 mutation",
            dependencyIds: [],
            affectedPaths: ["src/s02-4.ts"],
            workItemGeneration: 1,
            requirementState: "required",
            topologyState: "leaf",
            satisfactionState: "active",
            parentWorkItemId: null,
            authorityEnvelope: workAuthorityEnvelope,
          }],
          verification: [],
          verificationBindings: [],
          outputSlots: [],
          productionSteps: [],
        },
        activeAttempt: {
          programAttemptId: attemptId,
          workItemId,
          workItemGeneration: 1,
          directDependencies: [],
          workAuthorityEnvelope,
        },
        lifecycle: "active",
        attachedSessionIds: [sessionId],
      },
      runtime: {
        programAttemptId: String(attemptId),
        sessionId,
        agentGeneration: 9,
        sessionActive: true,
        agentGenerationCurrent: true,
        recoveryClear: true,
        writerBarriersClear: true,
        quiescenceClear: true,
        executionBaseCurrent: true,
      },
    },
    projection: {} as ProgramAdaptiveExecutionCutV2["projection"],
    operationalProgramContext: {
      programStateId: String(programStateId),
      expectedProgramRevision: 7,
      programAttemptId: String(attemptId),
      workItemId: String(workItemId),
      agentGeneration: 9,
    },
  };
}

function cuts(cut: ProgramAdaptiveExecutionCutV2): ProgramAdaptiveExecutionCutSourceV2 {
  return {
    currentForSession: async () => structuredClone(cut),
    withProtectedCut: async (_sessionId, _generationId, work) => work(structuredClone(cut)),
  };
}

function capability(
  authority: ProgramAttemptAuthorityV2,
  requestId: string,
  toolCallId: string,
): CapabilityRequestV2 {
  return {
    type: "capability.request",
    requestId,
    sessionId,
    toolCallId,
    toolName: "mutate",
    args: { path: "src/s02-4.ts" },
    programAttemptAuthority: structuredClone(authority),
  };
}

function latch(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("S02-4 Host ProgramAttempt replacement proof", () => {
  it("lets an already-admitted capability settle after Agent replacement while later old-generation work fails stale", async () => {
    const cut = executionCut();
    const authority = issueProgramAttemptAuthorityV2(cut.facts);
    const service = new ProgramAgentServiceV2({
      cuts: cuts(cut),
      progress: { admit: async () => ({ outcome: "admitted" }) },
    });
    const transport = {
      async send() {},
      onMessage() { return () => undefined; },
      async close() {},
    } as never;

    service.attach({
      generationId: "connection-old",
      sessionId,
      capabilities: [PROGRAM_STATE_V2_CAPABILITY, PROGRAM_EXECUTION_V2_CAPABILITY],
      transport,
    });

    const admitted = latch();
    const release = latch();
    let executions = 0;
    const firstRequest = capability(authority, "cap-s02-4-1", "local-subcall-1");
    const first = service.handleCapability({
      message: firstRequest,
      generationId: "connection-old",
      sessionId: asSessionId(sessionId),
    }, async (): Promise<CapabilityResult> => {
      executions += 1;
      admitted.release();
      await release.promise;
      return {
        type: "capability.result",
        requestId: firstRequest.requestId,
        sessionId,
        toolCallId: firstRequest.toolCallId,
        toolName: firstRequest.toolName,
        outcome: "succeeded",
        operationId: "operation-admitted-before-agent-replacement",
        result: { durableHostTruth: true },
      };
    });

    await admitted.promise;
    service.attach({
      generationId: "connection-new",
      sessionId,
      capabilities: [PROGRAM_STATE_V2_CAPABILITY, PROGRAM_EXECUTION_V2_CAPABILITY],
      transport,
    });

    const laterRequest = capability(authority, "cap-s02-4-2", "local-subcall-2");
    const later = await service.handleCapability({
      message: laterRequest,
      generationId: "connection-old",
      sessionId: asSessionId(sessionId),
    }, async () => {
      executions += 1;
      throw new Error("stale generation must not execute");
    });
    expect(later).toMatchObject({
      outcome: "stale",
      errorCode: "program_execution_stale",
    });
    expect(executions).toBe(1);

    release.release();
    await expect(first).resolves.toMatchObject({
      outcome: "succeeded",
      operationId: "operation-admitted-before-agent-replacement",
      result: { durableHostTruth: true },
    });
    expect(executions).toBe(1);
  });
});
