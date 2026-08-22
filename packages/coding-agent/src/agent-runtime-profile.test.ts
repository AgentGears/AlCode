import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AgentRuntime,
  ScopeNotOpenError,
  type ModelProvider,
  type ModelStream,
} from "@alcode/agent-core";
import {
  PROGRAM_EXECUTION_MESSAGE_VERSION,
  VERBATIM_COMPILER_VERSION,
  type ContextProvide,
  type ProgramAttemptProjectionV1,
} from "@alcode/agent-protocol";
import {
  AGENT_PROGRAM_BEHAVIOR,
  AGENT_RUN_COMPOSITION_FACTORY,
  AgentRunCompositionMountError,
  createDefaultAgentRuntimeModules,
  type DefaultAgentRuntimeProfileOptions,
} from "./agent-runtime-profile.ts";

function emptyStream(): ModelStream {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { value: undefined, done: true } as const;
        },
      };
    },
  };
}

function createRecordingProtocol() {
  const proposals: unknown[] = [];
  const progress: unknown[] = [];
  const assistants: unknown[] = [];
  const toolResults: unknown[] = [];
  const idle: unknown[] = [];
  const capabilities: unknown[] = [];
  let closeCalls = 0;

  const protocol: DefaultAgentRuntimeProfileOptions["protocol"] = {
    async close() {
      closeCalls += 1;
    },
    async submitProgramProposal(request) {
      proposals.push(structuredClone(request));
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
    async recordAssistant(record) {
      assistants.push(structuredClone(record));
    },
    async recordToolResult(record) {
      toolResults.push(structuredClone(record));
    },
    async reportIdle(record) {
      idle.push(structuredClone(record));
    },
  };

  return {
    protocol,
    proposals,
    progress,
    assistants,
    toolResults,
    idle,
    capabilities,
    closeCalls: () => closeCalls,
  };
}

function durableContext(): ContextProvide {
  return {
    type: "context.provide",
    requestId: "context-1",
    sessionId: "session-1",
    systemPrompt: "system",
    orientationRequired: false,
    toolNames: ["read"],
    verbatim: {
      compilerVersion: VERBATIM_COMPILER_VERSION,
      sourceEventSequence: 1,
      messages: [],
      status: "complete",
      pendingToolCallIds: [],
      fidelity: "exact",
    },
  };
}

describe("S-01E default Agent runtime profile", () => {
  it("preserves cognition and Program wire semantics on the scoped run path", async () => {
    const recording = createRecordingProtocol();
    const provider: ModelProvider = {
      async stream() {
        return emptyStream();
      },
    };
    const runtime = await AgentRuntime.create({
      generationId: "generation-1",
      modules: createDefaultAgentRuntimeModules({
        protocol: recording.protocol,
        providerFactory: () => provider,
      }),
    });

    expect(runtime.mountedModuleIds).toEqual([
      "coding-agent.protocol-lifecycle.v1",
      "coding-agent.provider.v1",
      "coding-agent.program-behavior.v1",
      "coding-agent.run-composition.v1",
    ]);

    const programBehavior = runtime.rootScope.resolve(AGENT_PROGRAM_BEHAVIOR);
    await programBehavior.submitPlanningProposal({
      type: "program.planning.begin",
      version: PROGRAM_EXECUTION_MESSAGE_VERSION,
      requestId: "planning-1",
      sessionId: "session-1",
      planningEpisodeId: "episode-1",
      objective: "Implement the objective",
    });
    expect(recording.proposals).toEqual([{
      sessionId: "session-1",
      planningEpisodeId: "episode-1",
      proposal: {
        objective: "Implement the objective",
        workItems: [{
          workItemId: "work-1",
          creationOrder: 0,
          description: "Implement the objective",
          dependencyIds: [],
          affectedPaths: [],
        }],
        verification: [],
        outputSlots: [],
        productionSteps: [],
      },
    }]);

    const authority: ProgramAttemptProjectionV1["authority"] = {
      programStateId: "program-1",
      expectedProgramRevision: 7,
      programAttemptId: "attempt-1",
      workItemId: "work-1",
      agentGeneration: 3,
    };
    const runCompositionFactory = runtime.rootScope.resolve(AGENT_RUN_COMPOSITION_FACTORY);
    const composition = await runCompositionFactory.create({
      sessionId: "session-1",
      context: durableContext(),
      latestProgramAttemptAuthority: () => authority,
    });
    expect(composition.provider).toBe(provider);
    expect(composition.tools.map((tool) => tool.name)).toEqual(["read"]);

    await composition.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        timestamp: 10,
      },
    });
    await composition.emit({ type: "agent_end" });

    expect(recording.assistants).toEqual([{
      sessionId: "session-1",
      text: "done",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
      timestamp: 10,
      durable: true,
    }]);
    expect(recording.progress).toEqual([{
      sessionId: "session-1",
      authority,
      evidence: [],
      advisoryBlockers: [],
      requestAwaitingVerification: true,
    }]);

    const capturedTool = composition.tools[0]!;
    await capturedTool.execute({}, { toolCallId: "legacy-static-call" });
    expect(recording.capabilities).toHaveLength(1);

    await composition.dispose();
    await expect(composition.emit({ type: "agent_end" })).rejects.toBeInstanceOf(ScopeNotOpenError);
    await expect(capturedTool.execute({}, {})).rejects.toThrow();

    await runtime.dispose();
    expect(recording.closeCalls()).toBe(1);
  });

  it("holds generation disposal until the active run releases its lifecycle admission", async () => {
    const recording = createRecordingProtocol();
    const provider: ModelProvider = {
      async stream() {
        return emptyStream();
      },
    };
    const runtime = await AgentRuntime.create({
      generationId: "generation-2",
      modules: createDefaultAgentRuntimeModules({
        protocol: recording.protocol,
        providerFactory: () => provider,
      }),
    });
    const factory = runtime.rootScope.resolve(AGENT_RUN_COMPOSITION_FACTORY);
    const composition = await factory.create({
      sessionId: "session-1",
      context: durableContext(),
      latestProgramAttemptAuthority: () => undefined,
    });

    const disposal = runtime.dispose();
    expect(runtime.rootScope.state).toBe("closing");
    let settled = false;
    void disposal.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(recording.closeCalls()).toBe(0);

    await composition.dispose();
    await disposal;
    expect(recording.closeCalls()).toBe(1);
  });

  it("rolls back a partially mounted run and releases its lifecycle admission when provider creation fails", async () => {
    const recording = createRecordingProtocol();
    const runtime = await AgentRuntime.create({
      generationId: "generation-3",
      modules: createDefaultAgentRuntimeModules({
        protocol: recording.protocol,
        providerFactory: () => {
          throw new Error("provider construction failed");
        },
      }),
    });
    const factory = runtime.rootScope.resolve(AGENT_RUN_COMPOSITION_FACTORY);

    await expect(factory.create({
      sessionId: "session-1",
      context: durableContext(),
      latestProgramAttemptAuthority: () => undefined,
    })).rejects.toBeInstanceOf(AgentRunCompositionMountError);

    await runtime.dispose();
    expect(recording.closeCalls()).toBe(1);
  });

  it("removes the legacy extension host and silent test provider from the production/public Agent composition path", () => {
    const worker = readFileSync(new URL("./agent-worker.ts", import.meta.url), "utf8");
    const profile = readFileSync(new URL("./agent-runtime-profile.ts", import.meta.url), "utf8");
    const agentCoreIndex = readFileSync(new URL("../../agent-core/src/index.ts", import.meta.url), "utf8");

    expect(worker).toContain("createDefaultAgentRuntimeModules");
    expect(worker).not.toContain("StaticExtensionHost");
    expect(worker).not.toContain("createCognitionExtension");
    expect(profile).toContain("ScopedAgentBehavior");
    expect(profile).toContain("createProductionModelProvider");
    expect(profile).not.toContain("TestModelProvider");
    expect(profile).not.toContain("AgentExtension");
    expect(profile).not.toContain("ProtocolTransport");
    expect(profile).not.toContain("@alcode/host-runtime");
    expect(agentCoreIndex).not.toContain("StaticExtensionHost");
    expect(agentCoreIndex).not.toContain("AgentExtension");
    expect(agentCoreIndex).not.toContain("ExtensionContext");
  });
});
