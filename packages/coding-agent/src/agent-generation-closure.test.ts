import { describe, expect, it } from "vitest";
import { ScopeNotOpenError } from "@alcode/agent-core";
import {
  PROGRAM_EXECUTION_MESSAGE_VERSION,
  type ContextProvide,
  type ProgramAttemptProjectionV1,
} from "@alcode/agent-protocol";
import { AgentRuntime } from "@alcode/agent-core";
import {
  AGENT_RUN_COMPOSITION_FACTORY,
  createDefaultAgentRuntimeModules,
  type DefaultAgentRuntimeProfileOptions,
} from "./agent-runtime-profile.ts";

function legacyContext(sessionId: string): ContextProvide {
  return {
    type: "context.provide",
    requestId: `context-${sessionId}`,
    sessionId,
    systemPrompt: "system",
    orientationRequired: false,
    toolNames: ["read"],
  };
}

function recordingProtocol() {
  const progress: unknown[] = [];
  const capabilities: unknown[] = [];
  let closeCalls = 0;
  const protocol: DefaultAgentRuntimeProfileOptions["protocol"] = {
    async close() {
      closeCalls += 1;
    },
    async submitProgramProposal(request) {
      return {
        type: "program.proposal.result",
        version: PROGRAM_EXECUTION_MESSAGE_VERSION,
        requestId: "proposal-result",
        sessionId: request.sessionId,
        planningEpisodeId: request.planningEpisodeId,
        outcome: "sealed",
      };
    },
    async submitProgramProgress(request) {
      progress.push(structuredClone(request));
      return {
        type: "program.progress.result",
        version: PROGRAM_EXECUTION_MESSAGE_VERSION,
        requestId: "progress-result",
        sessionId: request.sessionId,
        outcome: "admitted",
      };
    },
    async requestCapability(request) {
      capabilities.push(structuredClone(request));
      return {
        type: "capability.result",
        requestId: "capability-result",
        sessionId: request.sessionId,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        outcome: "succeeded",
      };
    },
    async recordAssistant() {},
    async recordToolResult() {},
    async reportIdle() {},
  };
  return {
    protocol,
    progress,
    capabilities,
    closeCalls: () => closeCalls,
  };
}

function authority(generation: number): ProgramAttemptProjectionV1["authority"] {
  return {
    programStateId: "program-1",
    expectedProgramRevision: generation,
    programAttemptId: `attempt-${generation}`,
    workItemId: "work-1",
    agentGeneration: generation,
  };
}

describe("S-01E Agent generation replacement closure", () => {
  it("withdraws generation A run-local publication and gives B fresh composition", async () => {
    const recordingA = recordingProtocol();
    const runtimeA = await AgentRuntime.create({
      generationId: "generation-A",
      modules: createDefaultAgentRuntimeModules({ protocol: recordingA.protocol }),
    });
    const factoryA = runtimeA.rootScope.resolve(AGENT_RUN_COMPOSITION_FACTORY);
    const compositionA = await factoryA.create({
      sessionId: "session-1",
      context: legacyContext("session-1"),
      latestProgramAttemptAuthority: () => authority(1),
    });
    const staleToolA = compositionA.tools[0]!;

    await compositionA.emit({ type: "agent_end" });
    expect(recordingA.progress).toHaveLength(1);
    await compositionA.dispose();
    await runtimeA.dispose();
    expect(recordingA.closeCalls()).toBe(1);

    await expect(compositionA.emit({ type: "agent_end" })).rejects.toBeInstanceOf(ScopeNotOpenError);
    await expect(staleToolA.execute({}, { toolCallId: "stale-a" })).rejects.toThrow();
    expect(recordingA.progress).toHaveLength(1);
    expect(recordingA.capabilities).toHaveLength(0);

    const recordingB = recordingProtocol();
    const runtimeB = await AgentRuntime.create({
      generationId: "generation-B",
      modules: createDefaultAgentRuntimeModules({ protocol: recordingB.protocol }),
    });
    const factoryB = runtimeB.rootScope.resolve(AGENT_RUN_COMPOSITION_FACTORY);
    const compositionB = await factoryB.create({
      sessionId: "session-1",
      context: legacyContext("session-1"),
      latestProgramAttemptAuthority: () => authority(2),
    });

    expect(runtimeB.generationId).not.toBe(runtimeA.generationId);
    expect(compositionB.tools[0]).not.toBe(staleToolA);
    await compositionB.tools[0]!.execute({}, { toolCallId: "fresh-b" });
    await compositionB.emit({ type: "agent_end" });
    expect(recordingB.capabilities).toHaveLength(1);
    expect(recordingB.progress).toHaveLength(1);

    await compositionB.dispose();
    await runtimeB.dispose();
    expect(recordingB.closeCalls()).toBe(1);
  });
});
