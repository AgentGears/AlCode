import {
  createServiceToken,
  type AgentExtension,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
  type ModelStream,
  type RuntimeModule,
} from "@alcode/agent-core";
import type {
  ContextProvide,
  HostToAgentMessage,
  ProgramAttemptProjectionV1,
} from "@alcode/agent-protocol";
import {
  createCognitionExtension,
  type CognitionHostClient,
} from "@alcode/cognition-extension";
import type { AgentProtocolClient } from "./agent-protocol-bridge.ts";
import { TestModelProvider } from "./test-model-provider.ts";

interface ScriptedTurn {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  stopReason?: "stop" | "length" | "tool_use" | "error" | "aborted";
  errorMessage?: string;
}

class ScriptedWorkerProvider implements ModelProvider {
  private index = 0;

  constructor(private readonly turns: readonly ScriptedTurn[]) {}

  async stream(_request: ModelRequest): Promise<ModelStream> {
    const turn = this.turns[this.index++] ?? {
      text: "ALCODE Agent is idle.",
      stopReason: "stop" as const,
    };
    const events: ModelEvent[] = [];
    if (turn.text !== undefined) events.push({ type: "text_delta", text: turn.text });
    for (const call of turn.toolCalls ?? []) {
      events.push({
        type: "tool_call",
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      });
    }
    events.push({
      type: "done",
      stopReason: turn.stopReason ?? ((turn.toolCalls?.length ?? 0) > 0 ? "tool_use" : "stop"),
      ...(turn.errorMessage !== undefined ? { errorMessage: turn.errorMessage } : {}),
    });
    return {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          async next(): Promise<IteratorResult<ModelEvent>> {
            const value = events[i++];
            return value === undefined
              ? { value: undefined, done: true }
              : { value, done: false };
          },
        };
      },
    };
  }
}

function createDefaultProvider(): ModelProvider {
  const raw = process.env.ALCODE_AGENT_SCRIPT;
  if (raw) {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("ALCODE_AGENT_SCRIPT must be a JSON array");
    }
    return new ScriptedWorkerProvider(parsed as ScriptedTurn[]);
  }
  return new TestModelProvider([
    { match: "hello", text: "Hello from ALCODE. The agent loop is running." },
    { match: "*", text: "ALCODE received your prompt." },
  ]);
}

export interface AgentProviderFactory {
  create(): ModelProvider;
}

export interface AgentProgramBehavior {
  submitPlanningProposal(
    begin: Extract<HostToAgentMessage, { type: "program.planning.begin" }>,
  ): Promise<void>;
  createProgressExtension(options: {
    sessionId: string;
    latestProgramAttemptAuthority: () => ProgramAttemptProjectionV1["authority"] | undefined;
  }): AgentExtension;
}

export interface AgentRunComposition {
  provider: ModelProvider;
  extensions: readonly AgentExtension[];
}

export interface AgentRunCompositionFactory {
  create(options: {
    sessionId: string;
    context: ContextProvide;
    latestProgramAttemptAuthority: () => ProgramAttemptProjectionV1["authority"] | undefined;
  }): AgentRunComposition;
}

export const AGENT_PROVIDER_FACTORY = createServiceToken<AgentProviderFactory>(
  "coding-agent.provider-factory.v1",
);
export const AGENT_PROGRAM_BEHAVIOR = createServiceToken<AgentProgramBehavior>(
  "coding-agent.program-behavior.v1",
);
export const AGENT_RUN_COMPOSITION_FACTORY = createServiceToken<AgentRunCompositionFactory>(
  "coding-agent.run-composition-factory.v1",
);

type DefaultProfileProtocolClient = Pick<
  AgentProtocolClient,
  | "close"
  | "submitProgramProposal"
  | "submitProgramProgress"
  | "requestCapability"
  | "recordAssistant"
  | "recordToolResult"
  | "reportIdle"
>;

export interface DefaultAgentRuntimeProfileOptions {
  protocol: DefaultProfileProtocolClient;
  providerFactory?: () => ModelProvider;
}

function createProtocolLifecycleModule(
  protocol: Pick<DefaultProfileProtocolClient, "close">,
): RuntimeModule {
  return {
    id: "coding-agent.protocol-lifecycle.v1",
    mount(scope) {
      scope.register(() => protocol.close());
    },
  };
}

function createProviderModule(
  providerFactory: () => ModelProvider,
): RuntimeModule {
  return {
    id: "coding-agent.provider.v1",
    mount(scope) {
      scope.provide(AGENT_PROVIDER_FACTORY, { create: providerFactory });
    },
  };
}

function createProgramBehaviorModule(
  protocol: Pick<DefaultProfileProtocolClient, "submitProgramProposal" | "submitProgramProgress">,
): RuntimeModule {
  return {
    id: "coding-agent.program-behavior.v1",
    mount(scope) {
      const behavior: AgentProgramBehavior = {
        async submitPlanningProposal(begin) {
          const result = await protocol.submitProgramProposal({
            sessionId: begin.sessionId,
            planningEpisodeId: begin.planningEpisodeId,
            proposal: {
              objective: begin.objective,
              workItems: [{
                workItemId: "work-1",
                creationOrder: 0,
                description: begin.objective,
                dependencyIds: [],
                affectedPaths: [],
              }],
              verification: [],
              outputSlots: [],
              productionSteps: [],
            },
          });
          if (result.outcome !== "sealed") {
            throw new Error(
              `Program proposal was not sealed: ${result.outcome}${result.error ? ` (${result.error})` : ""}`,
            );
          }
        },

        createProgressExtension(options) {
          return {
            name: "program-progress-v1",
            register(context) {
              context.onEvent(async (event) => {
                if (event.type !== "agent_end") return;
                const authority = options.latestProgramAttemptAuthority();
                if (authority === undefined) return;
                const result = await protocol.submitProgramProgress({
                  sessionId: options.sessionId,
                  authority,
                  evidence: [],
                  advisoryBlockers: [],
                  requestAwaitingVerification: true,
                });
                if (result.outcome !== "admitted") {
                  throw new Error(
                    `Program progress was not admitted: ${result.outcome}${result.error ? ` (${result.error})` : ""}`,
                  );
                }
              });
            },
          };
        },
      };
      scope.provide(AGENT_PROGRAM_BEHAVIOR, behavior);
    },
  };
}

function createRunCompositionModule(
  cognitionClient: CognitionHostClient,
): RuntimeModule {
  return {
    id: "coding-agent.run-composition.v1",
    mount(scope) {
      const providerFactory = scope.resolve(AGENT_PROVIDER_FACTORY);
      const programBehavior = scope.resolve(AGENT_PROGRAM_BEHAVIOR);
      const compositionFactory: AgentRunCompositionFactory = {
        create(options) {
          return {
            provider: providerFactory.create(),
            extensions: [
              programBehavior.createProgressExtension({
                sessionId: options.sessionId,
                latestProgramAttemptAuthority: options.latestProgramAttemptAuthority,
              }),
              createCognitionExtension({
                client: cognitionClient,
                sessionId: () => options.sessionId,
                toolNames: options.context.toolNames,
                durableTranscript: options.context.verbatim !== undefined,
              }),
            ],
          };
        },
      };
      scope.provide(AGENT_RUN_COMPOSITION_FACTORY, compositionFactory);
    },
  };
}

/**
 * Statically bundled S-01C profile. It composes Agent-local behavior only;
 * canonical execution authority remains behind the privileged Host protocol.
 */
export function createDefaultAgentRuntimeModules(
  options: DefaultAgentRuntimeProfileOptions,
): readonly RuntimeModule[] {
  return [
    createProtocolLifecycleModule(options.protocol),
    createProviderModule(options.providerFactory ?? createDefaultProvider),
    createProgramBehaviorModule(options.protocol),
    createRunCompositionModule(options.protocol),
  ];
}
