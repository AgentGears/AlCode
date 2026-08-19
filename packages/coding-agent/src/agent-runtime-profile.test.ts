import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AgentRuntime,
  StaticExtensionHost,
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

describe("S-01C default Agent runtime profile", () => {
  it("composes provider, cognition, and Program behavior without changing wire semantics", async () => {
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
    const composition = runCompositionFactory.create({
      sessionId: "session-1",
      context: durableContext(),
      latestProgramAttemptAuthority: () => authority,
    });
    expect(composition.provider).toBe(provider);

    const extensionHost = new StaticExtensionHost();
    await extensionHost.mount(composition.extensions);
    expect(extensionHost.getTools().map((tool) => tool.name)).toEqual(["read"]);

    await extensionHost.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        timestamp: 10,
      },
    });
    await extensionHost.emit({ type: "agent_end" });

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

    await runtime.dispose();
    expect(recording.closeCalls()).toBe(1);
  });

  it("rolls back the statically mounted profile and closes its protocol on later mount failure", async () => {
    const recording = createRecordingProtocol();
    const provider: ModelProvider = {
      async stream() {
        return emptyStream();
      },
    };
    const modules = createDefaultAgentRuntimeModules({
      protocol: recording.protocol,
      providerFactory: () => provider,
    });

    await expect(AgentRuntime.create({
      generationId: "generation-2",
      modules: [
        ...modules,
        {
          id: "test.fail-after-profile",
          mount() {
            throw new Error("mount failed");
          },
        },
      ],
    })).rejects.toMatchObject({
      name: "AgentRuntimeMountError",
      moduleId: "test.fail-after-profile",
    });
    expect(recording.closeCalls()).toBe(1);
  });

  it("keeps StaticExtensionHost as compatibility path while moving worker composition behind modules", () => {
    const worker = readFileSync(new URL("./agent-worker.ts", import.meta.url), "utf8");
    const profile = readFileSync(new URL("./agent-runtime-profile.ts", import.meta.url), "utf8");

    expect(worker).toContain("StaticExtensionHost");
    expect(worker).toContain("createDefaultAgentRuntimeModules");
    expect(worker).not.toContain("createCognitionExtension");
    expect(worker).not.toContain("TestModelProvider");
    expect(worker).not.toContain("programProgressExtension");
    expect(profile).not.toContain("ProtocolTransport");
    expect(profile).not.toContain("@alcode/host-runtime");
  });
});
