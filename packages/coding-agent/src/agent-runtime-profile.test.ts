import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AgentRuntime,
  ScopeNotOpenError,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
  type ModelStream,
} from "@alcode/agent-core";
import {
  PROGRAM_EXECUTION_MESSAGE_VERSION,
  VERBATIM_COMPILER_VERSION,
  type ContextProvide,
  type HostToAgentMessage,
  type ProgramAttemptProjectionV1,
} from "@alcode/agent-protocol";
import {
  AGENT_PROGRAM_BEHAVIOR,
  AGENT_RUN_COMPOSITION_FACTORY,
  AgentRunCompositionMountError,
  createDefaultAgentRuntimeModules,
  type DefaultAgentRuntimeProfileOptions,
} from "./agent-runtime-profile.ts";
import { PROGRAM_PROPOSAL_TOOL_NAME } from "./program-planner.ts";

function streamOf(events: readonly ModelEvent[]): ModelStream {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next(): Promise<IteratorResult<ModelEvent>> {
          const value = events[index++];
          return value === undefined
            ? { value: undefined, done: true }
            : { value, done: false };
        },
      };
    },
  };
}

function emptyStream(): ModelStream {
  return streamOf([]);
}

function objectiveFromRequest(request: ModelRequest): string {
  const user = [...request.messages].reverse().find((message) => message.role === "user");
  const text = user?.role === "user"
    ? user.content.find((content) => content.type === "text")?.text
    : undefined;
  return text ?? "missing objective";
}

function createPlanningAwareProvider(): ModelProvider {
  return {
    async stream(request) {
      if (!request.tools.some((tool) => tool.name === PROGRAM_PROPOSAL_TOOL_NAME)) return emptyStream();
      const objective = objectiveFromRequest(request);
      return streamOf([
        {
          type: "tool_call",
          id: "planning-proposal-1",
          name: PROGRAM_PROPOSAL_TOOL_NAME,
          arguments: {
            objective,
            workItems: [{
              workItemId: "work-1",
              creationOrder: 0,
              description: objective,
              dependencyIds: [],
              affectedPaths: [],
            }],
            verification: [],
            outputSlots: [],
            productionSteps: [],
          },
        },
        { type: "done", stopReason: "tool_use" },
      ]);
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
  const hostHandlers = new Set<(message: HostToAgentMessage) => void | Promise<void>>();
  let closeCalls = 0;

  const protocol: DefaultAgentRuntimeProfileOptions["protocol"] = {
    async close() {
      closeCalls += 1;
    },
    onHostMessage(handler) {
      hostHandlers.add(handler);
      return () => hostHandlers.delete(handler);
    },
    async requestProgramPlanningRead(request) {
      return {
        type: "program.planning.read.result",
        version: PROGRAM_EXECUTION_MESSAGE_VERSION,
        requestId: "planning-read-result",
        sessionId: request.sessionId,
        planningEpisodeId: request.planningEpisodeId,
        outcome: "denied",
        errorCode: "unexpected_planning_read",
        error: "No planning reads are advertised in this test",
      };
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
    const provider = createPlanningAwareProvider();
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
      planningCatalog: { digest: "planning-empty", reads: [] },
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

  it("cancels an active planning scope without waiting for a provider turn to complete normally", async () => {
    const recording = createRecordingProtocol();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let observedSignal: AbortSignal | undefined;
    const planningProvider: ModelProvider = {
      async stream(request) {
        observedSignal = request.signal;
        started();
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<ModelEvent>> {
                return new Promise((_, reject) => {
                  const signal = request.signal;
                  if (signal?.aborted) {
                    reject(signal.reason);
                    return;
                  }
                  signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
                });
              },
            };
          },
        };
      },
    };
    const executionProvider: ModelProvider = { async stream() { return emptyStream(); } };
    const runtime = await AgentRuntime.create({
      generationId: "generation-planning-cancel",
      modules: createDefaultAgentRuntimeModules({
        protocol: recording.protocol,
        providerFactory: () => executionProvider,
        planningProviderFactory: () => planningProvider,
      }),
    });
    const programBehavior = runtime.rootScope.resolve(AGENT_PROGRAM_BEHAVIOR);
    const planning = programBehavior.submitPlanningProposal({
      type: "program.planning.begin",
      version: PROGRAM_EXECUTION_MESSAGE_VERSION,
      requestId: "planning-cancel",
      sessionId: "session-1",
      planningEpisodeId: "episode-cancel",
      objective: "Cancel this planning run",
      planningCatalog: { digest: "planning-empty", reads: [] },
    });
    await startedPromise;
    await programBehavior.cancelPlanning("session-1");
    await planning;
    expect(observedSignal?.aborted).toBe(true);
    expect(recording.proposals).toHaveLength(0);
    await runtime.dispose();
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

  it("removes deterministic proposal fallback and legacy extension authority from the production/public Agent path", () => {
    const worker = readFileSync(new URL("./agent-worker.ts", import.meta.url), "utf8");
    const profile = readFileSync(new URL("./agent-runtime-profile.ts", import.meta.url), "utf8");
    const planner = readFileSync(new URL("./program-planner.ts", import.meta.url), "utf8");
    const agentCoreIndex = readFileSync(new URL("../../agent-core/src/index.ts", import.meta.url), "utf8");

    expect(worker).toContain("createDefaultAgentRuntimeModules");
    expect(worker).not.toContain("StaticExtensionHost");
    expect(worker).not.toContain("createCognitionExtension");
    expect(profile).toContain("ScopedAgentBehavior");
    expect(profile).toContain("runProgramPlanner");
    expect(profile).toContain("createProductionModelProvider");
    expect(profile).not.toContain("TestModelProvider");
    expect(profile).not.toContain("AgentExtension");
    expect(profile).not.toContain("ProtocolTransport");
    expect(profile).not.toContain("@alcode/host-runtime");
    expect(profile).not.toContain('workItemId: "work-1"');
    expect(planner).toContain("submit_program_proposal");
    expect(agentCoreIndex).not.toContain("StaticExtensionHost");
    expect(agentCoreIndex).not.toContain("AgentExtension");
    expect(agentCoreIndex).not.toContain("ExtensionContext");
  });
});
