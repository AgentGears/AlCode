import {
  ScopedAgentBehavior,
  createServiceToken,
  type AgentBehaviorContribution,
  type AgentEvent,
  type AgentTool,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
  type ModelStream,
  type RuntimeModule,
  type RuntimeScope,
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
import { runProgramPlanner } from "./program-planner.ts";
import { createProductionModelProvider } from "./provider-selection.ts";

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

function scriptedProviderFromEnvironment(name: string, raw: string): ModelProvider {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array`);
  }
  return new ScriptedWorkerProvider(parsed as ScriptedTurn[]);
}

function createDefaultProvider(): ModelProvider {
  const raw = process.env.ALCODE_AGENT_SCRIPT;
  if (raw) return scriptedProviderFromEnvironment("ALCODE_AGENT_SCRIPT", raw);
  return createProductionModelProvider();
}

function createDefaultPlanningProvider(): ModelProvider {
  const raw = process.env.ALCODE_PLANNING_SCRIPT;
  if (raw) return scriptedProviderFromEnvironment("ALCODE_PLANNING_SCRIPT", raw);
  return createProductionModelProvider();
}

export interface AgentProviderFactory {
  create(): ModelProvider;
}

export interface AgentProgramBehavior {
  submitPlanningProposal(
    begin: Extract<HostToAgentMessage, { type: "program.planning.begin" }>,
  ): Promise<void>;
  cancelPlanning(sessionId: string): Promise<void>;
  createProgressContribution(options: {
    sessionId: string;
    latestProgramAttemptAuthority: () => ProgramAttemptProjectionV1["authority"] | undefined;
  }): AgentBehaviorContribution;
}

export interface AgentRunComposition {
  readonly provider: ModelProvider;
  readonly tools: readonly AgentTool[];
  emit(event: AgentEvent): Promise<void>;
  dispose(): Promise<void>;
}

export interface AgentRunCompositionFactory {
  create(options: {
    sessionId: string;
    context: ContextProvide;
    latestProgramAttemptAuthority: () => ProgramAttemptProjectionV1["authority"] | undefined;
  }): Promise<AgentRunComposition>;
}

export class AgentRunCompositionMountError extends Error {
  constructor(
    cause: unknown,
    readonly cleanupError?: unknown,
  ) {
    super("Agent run composition failed to mount", { cause });
    this.name = "AgentRunCompositionMountError";
  }
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
  | "onHostMessage"
  | "requestProgramPlanningRead"
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
  planningProviderFactory?: () => ModelProvider;
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

interface ActivePlanningRun {
  planningEpisodeId: string;
  scope: RuntimeScope;
}

function createProgramBehaviorModule(
  protocol: Pick<
    DefaultProfileProtocolClient,
    "onHostMessage" | "requestProgramPlanningRead" | "submitProgramProposal" | "submitProgramProgress"
  >,
  planningProviderFactory: () => ModelProvider,
): RuntimeModule {
  return {
    id: "coding-agent.program-behavior.v1",
    mount(scope) {
      const activePlanning = new Map<string, ActivePlanningRun>();

      const cancelPlanning = async (sessionId: string): Promise<void> => {
        const active = activePlanning.get(sessionId);
        if (active === undefined) return;
        activePlanning.delete(sessionId);
        await active.scope.dispose();
      };

      const behavior: AgentProgramBehavior = {
        async submitPlanningProposal(begin) {
          await cancelPlanning(begin.sessionId);
          const planningScope = scope.child("agent_run");
          const admission = planningScope.admit();
          const active: ActivePlanningRun = {
            planningEpisodeId: begin.planningEpisodeId,
            scope: planningScope,
          };
          activePlanning.set(begin.sessionId, active);
          try {
            await runProgramPlanner({
              begin,
              provider: planningProviderFactory(),
              protocol,
              signal: admission.signal,
            });
          } catch (error) {
            if (planningScope.signal.aborted) return;
            throw error;
          } finally {
            if (activePlanning.get(begin.sessionId) === active) activePlanning.delete(begin.sessionId);
            admission.release();
            await planningScope.dispose();
          }
        },

        cancelPlanning,

        createProgressContribution(options) {
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

      const unsubscribe = protocol.onHostMessage((message) => {
        if (message.type !== "cancel") return;
        return behavior.cancelPlanning(message.sessionId).catch(() => undefined);
      });
      scope.register(unsubscribe);
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
        async create(options) {
          const runScope = scope.child("agent_run");
          const runAdmission = runScope.admit();
          const behavior = new ScopedAgentBehavior(runScope);
          let disposalPromise: Promise<void> | null = null;
          const dispose = (): Promise<void> => {
            if (disposalPromise !== null) return disposalPromise;
            runAdmission.release();
            disposalPromise = runScope.dispose();
            return disposalPromise;
          };

          try {
            await behavior.mount([
              programBehavior.createProgressContribution({
                sessionId: options.sessionId,
                latestProgramAttemptAuthority: options.latestProgramAttemptAuthority,
              }),
              createCognitionExtension({
                client: cognitionClient,
                sessionId: () => options.sessionId,
                toolNames: options.context.toolNames,
                durableTranscript: options.context.verbatim !== undefined,
              }),
            ]);
            const tools = behavior.getTools();
            const provider = providerFactory.create();
            return {
              provider,
              tools,
              emit: (event) => behavior.emit(event),
              dispose,
            };
          } catch (error) {
            let cleanupError: unknown | undefined;
            try {
              await dispose();
            } catch (cleanupFailure) {
              cleanupError = cleanupFailure;
            }
            throw new AgentRunCompositionMountError(error, cleanupError);
          }
        },
      };
      scope.provide(AGENT_RUN_COMPOSITION_FACTORY, compositionFactory);
    },
  };
}

/**
 * Statically bundled S-01 runtime profile. It composes Agent-local behavior
 * only; canonical execution authority remains behind the privileged Host
 * protocol. S-01E gives every run-local contribution an AgentRunScope owner.
 */
export function createDefaultAgentRuntimeModules(
  options: DefaultAgentRuntimeProfileOptions,
): readonly RuntimeModule[] {
  const executionProviderFactory = options.providerFactory ?? createDefaultProvider;
  const planningProviderFactory = options.planningProviderFactory
    ?? options.providerFactory
    ?? createDefaultPlanningProvider;
  return [
    createProtocolLifecycleModule(options.protocol),
    createProviderModule(executionProviderFactory),
    createProgramBehaviorModule(options.protocol, planningProviderFactory),
    createRunCompositionModule(options.protocol),
  ];
}
