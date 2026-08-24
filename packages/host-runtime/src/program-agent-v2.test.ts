import { describe, expect, it } from "vitest";
import {
  PROGRAM_EXECUTION_V2_CAPABILITY,
  PROGRAM_STATE_V2_CAPABILITY,
  type AgentToHostMessageV2Aware,
  type CapabilityRequestV2,
  type HostToAgentMessageV2Aware,
  type ProgramAttemptAuthorityV2,
  type ProtocolTransport,
} from "@alcode/agent-protocol";
import {
  asProgramAttemptId,
  asProgramRevisionId,
  asProgramStateId,
  asProgramWorkItemId,
  type ProgramAttemptSemanticAssumptionsV1,
  type ProgramSemanticStateV1,
  type WorkAuthorityEnvelopeV1,
} from "@alcode/program-state";
import { asSessionId } from "@alcode/events";
import {
  ProgramAgentServiceV2,
  type ProgramAdaptiveExecutionCutV2,
  type ProgramAdaptiveExecutionCutSourceV2,
} from "./program-agent-v2.ts";

const programStateId = asProgramStateId("018f0000-0000-7000-8000-000000000951");
const dependencyId = asProgramWorkItemId("adaptive-dependency");
const workId = asProgramWorkItemId("adaptive-work");
const attemptId = asProgramAttemptId("adaptive-attempt");
const r1 = asProgramRevisionId("adaptive-r1");
const r2 = asProgramRevisionId("adaptive-r2");

function envelope(): WorkAuthorityEnvelopeV1 {
  return {
    objectiveBoundaryRef: { programStateId, rootProgramRevisionId: r1, anchorWorkItemId: workId },
    allowedRepositoryRoots: ["."],
    allowedEffectClasses: ["fs.read", "fs.write"],
    allowedExternalSystems: [],
    capabilityCeiling: ["edit", "read"],
    maximumTopologyExpansion: 8,
    mandatoryVerificationIds: [],
    forbiddenChangeKinds: ["delete_repository"],
  };
}

function semanticState(revision = r1, targetGeneration = 3): ProgramSemanticStateV1 {
  return {
    programStateId,
    currentRevision: {
      programRevisionId: revision,
      parentProgramRevisionId: revision === r1 ? null : r1,
      ordinal: revision === r1 ? 1 : 2,
      changeClass: revision === r1 ? "initial" : "refinement",
      acceptedAtStateRevision: revision === r1 ? 1 : 8,
      admissionEventId: revision === r1 ? "baseline" : "revision-2",
      sourceDraftId: revision === r1 ? null : "draft-r2",
      sourceDraftDigest: revision === r1 ? null : "digest-r2",
    },
    workItems: [
      {
        workItemId: dependencyId,
        creationOrder: 0,
        description: "Dependency",
        dependencyIds: [],
        affectedPaths: ["src/a.ts"],
        workItemGeneration: 1,
        requirementState: "required",
        topologyState: "leaf",
        satisfactionState: "satisfied",
        parentWorkItemId: null,
        authorityEnvelope: envelope(),
      },
      {
        workItemId: workId,
        creationOrder: 1,
        description: "Adaptive work",
        dependencyIds: [dependencyId],
        affectedPaths: ["src/b.ts"],
        workItemGeneration: targetGeneration,
        requirementState: "required",
        topologyState: "leaf",
        satisfactionState: "active",
        parentWorkItemId: null,
        authorityEnvelope: envelope(),
      },
    ],
    verification: [],
    verificationBindings: [],
    outputSlots: [],
    productionSteps: [],
  };
}

function assumptions(targetGeneration = 3): ProgramAttemptSemanticAssumptionsV1 {
  return {
    programAttemptId: attemptId,
    workItemId: workId,
    workItemGeneration: targetGeneration,
    directDependencies: [{
      workItemId: dependencyId,
      workItemGeneration: 1,
      required: true,
      satisfiedOrDischargedAtIssue: true,
    }],
    workAuthorityEnvelope: envelope(),
  };
}

function makeCut(revision = r1, targetGeneration = 3): ProgramAdaptiveExecutionCutV2 {
  return {
    facts: {
      semantic: {
        programStateRevision: 11,
        semanticState: semanticState(revision, targetGeneration),
        activeAttempt: assumptions(targetGeneration),
        lifecycle: "active",
        attachedSessionIds: ["session-adaptive"],
      },
      runtime: {
        programAttemptId: String(attemptId),
        sessionId: "session-adaptive",
        agentGeneration: 4,
        sessionActive: true,
        agentGenerationCurrent: true,
        recoveryClear: true,
        writerBarriersClear: true,
        quiescenceClear: true,
        executionBaseCurrent: true,
      },
    },
    projection: {
      objective: "Adaptive objective",
      work: {
        description: "Adaptive work",
        requirementState: "required",
        topologyState: "leaf",
        satisfactionState: "active",
        dependencyIds: [String(dependencyId)],
        affectedPaths: ["src/b.ts"],
        omittedAffectedPathCount: 0,
      },
      dependencies: [{
        workItemId: String(dependencyId),
        workItemGeneration: 1,
        requirementState: "required",
        satisfiedOrDischarged: true,
      }],
      blockers: [],
      executionBase: {
        workspaceEffectGeneration: 7,
        observation: {
          kind: "workspace-observation-v1",
          providerKind: "git",
          workspaceIdentity: "workspace-a",
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
      expectedProgramRevision: 99,
      programAttemptId: String(attemptId),
      workItemId: String(workId),
      agentGeneration: 4,
    },
  };
}

function transport(sent: HostToAgentMessageV2Aware[]): ProtocolTransport<HostToAgentMessageV2Aware, AgentToHostMessageV2Aware> {
  return {
    async send(message) { sent.push(structuredClone(message)); },
    onMessage() { return () => undefined; },
    async close() {},
  };
}

function cutSource(read: () => ProgramAdaptiveExecutionCutV2): ProgramAdaptiveExecutionCutSourceV2 {
  return {
    currentForSession: async () => structuredClone(read()),
    withProtectedCut: async (_sessionId, _generationId, work) => work(structuredClone(read())),
  };
}

function capability(authority: ProgramAttemptAuthorityV2): CapabilityRequestV2 {
  return {
    type: "capability.request",
    requestId: "cap-1",
    sessionId: "session-adaptive",
    toolCallId: "tool-call-1",
    toolName: "read",
    args: { path: "src/b.ts" },
    programAttemptAuthority: structuredClone(authority),
  };
}

describe("A1 adaptive Program execution V2 boundary", () => {
  it("dispatches V2 and retains authority across an unrelated semantic revision at capability admission", async () => {
    let cut = makeCut();
    const sent: HostToAgentMessageV2Aware[] = [];
    const service = new ProgramAgentServiceV2({
      cuts: cutSource(() => cut),
      progress: { admit: async () => ({ outcome: "admitted" }) },
    });
    service.attach({
      generationId: "connection-1",
      sessionId: "session-adaptive",
      capabilities: [PROGRAM_STATE_V2_CAPABILITY, PROGRAM_EXECUTION_V2_CAPABILITY],
      transport: transport(sent),
    });

    const projection = await service.currentAttemptProjection("session-adaptive", "connection-1");
    expect(projection?.authority.issuedUnderProgramRevisionId).toBe(String(r1));
    const execute = await service.requestCurrentAttemptExecution("session-adaptive", "connection-1");
    expect(execute?.version).toBe(2);
    expect(sent.at(-1)).toMatchObject({ type: "program.attempt.execute", version: 2 });

    cut = makeCut(r2);
    let operationalRevision: number | undefined;
    const result = await service.handleCapability(
      {
        message: capability(projection!.authority),
        generationId: "connection-1",
        sessionId: asSessionId("session-adaptive"),
      },
      async (request) => {
        operationalRevision = request.program?.expectedProgramRevision;
        return {
          type: "capability.result",
          requestId: "cap-1",
          sessionId: "session-adaptive",
          toolCallId: "tool-call-1",
          toolName: "read",
          outcome: "succeeded",
          result: { ok: true },
        };
      },
    );
    expect(result.outcome).toBe("succeeded");
    expect(operationalRevision).toBe(99);
    expect(projection!.authority.issuedUnderProgramRevisionId).toBe(String(r1));
    expect(String(cut.facts.semantic.semanticState.currentRevision.programRevisionId)).toBe(String(r2));
  });

  it("fails capability admission after target-generation or runtime-barrier changes without invoking execution", async () => {
    let cut = makeCut();
    let executions = 0;
    const service = new ProgramAgentServiceV2({
      cuts: cutSource(() => cut),
      progress: { admit: async () => ({ outcome: "admitted" }) },
    });
    service.attach({
      generationId: "connection-1",
      sessionId: "session-adaptive",
      capabilities: [PROGRAM_STATE_V2_CAPABILITY, PROGRAM_EXECUTION_V2_CAPABILITY],
      transport: transport([]),
    });
    const authority = (await service.currentAttemptProjection("session-adaptive", "connection-1"))!.authority;
    const execute = async () => {
      executions += 1;
      return {
        type: "capability.result" as const,
        requestId: "cap-1",
        sessionId: "session-adaptive",
        toolCallId: "tool-call-1",
        toolName: "read",
        outcome: "succeeded" as const,
      };
    };

    cut = makeCut(r2, 4);
    expect((await service.handleCapability({
      message: capability(authority),
      generationId: "connection-1",
      sessionId: asSessionId("session-adaptive"),
    }, execute))).toMatchObject({ outcome: "stale", errorCode: "program_execution_stale" });

    cut = makeCut(r2);
    cut.facts.runtime.writerBarriersClear = false;
    expect((await service.handleCapability({
      message: capability(authority),
      generationId: "connection-1",
      sessionId: asSessionId("session-adaptive"),
    }, execute))).toMatchObject({ outcome: "stale", errorCode: "program_execution_stale" });
    expect(executions).toBe(0);
  });

  it("rejects an old connection generation before protected progress or capability admission", async () => {
    const cut = makeCut();
    let progressCalls = 0;
    const service = new ProgramAgentServiceV2({
      cuts: cutSource(() => cut),
      progress: { admit: async () => { progressCalls += 1; return { outcome: "admitted" }; } },
    });
    service.attach({
      generationId: "connection-1",
      sessionId: "session-adaptive",
      capabilities: [PROGRAM_STATE_V2_CAPABILITY, PROGRAM_EXECUTION_V2_CAPABILITY],
      transport: transport([]),
    });
    const authority = (await service.currentAttemptProjection("session-adaptive", "connection-1"))!.authority;
    service.detach("connection-1");
    service.attach({
      generationId: "connection-2",
      sessionId: "session-adaptive",
      capabilities: [PROGRAM_STATE_V2_CAPABILITY, PROGRAM_EXECUTION_V2_CAPABILITY],
      transport: transport([]),
    });

    expect((await service.handleCapability({
      message: capability(authority),
      generationId: "connection-1",
      sessionId: asSessionId("session-adaptive"),
    }, async () => { throw new Error("must not execute"); }))).toMatchObject({ outcome: "stale" });
    expect(progressCalls).toBe(0);
  });
});
