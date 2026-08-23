// Replaceable Agent process. The worker owns only the model loop and a
// disposable in-memory message cache hydrated from Host-provided durability.
// It does NOT import storage, workspace, memory, reasoning, or Host runtime.

import { randomUUID } from "node:crypto";
import {
  AgentRuntime,
  runAgentLoop,
  type Message,
} from "@alcode/agent-core";
import {
  AGENT_PROTOCOL_VERSION,
  DYNAMIC_CAPABILITY_BINDING_CAPABILITY,
  DURABLE_TRANSCRIPT_CAPABILITY,
  GRAPH_CONTEXT_CAPABILITY,
  PROGRAM_EXECUTION_CAPABILITY,
  PROGRAM_STATE_CAPABILITY,
  type ContextProvide,
  type HostToAgentMessage,
  type ProgramAttemptAuthorityV1,
  type ProgramAttemptProjectionV1,
} from "@alcode/agent-protocol";
import { createProcessAgentProtocolBridge } from "./agent-protocol-bridge.ts";
import {
  AGENT_PROGRAM_BEHAVIOR,
  AGENT_RUN_COMPOSITION_FACTORY,
  createDefaultAgentRuntimeModules,
  type AgentRunComposition,
} from "./agent-runtime-profile.ts";
import {
  createInferenceCapabilityProjection,
  type InferenceCapabilityProjection,
} from "./inference-runtime.ts";
import { requestInferenceContext } from "./inference-context.ts";
import {
  PROGRAM_EXECUTION_PROMPT,
  renderProgramAttemptContext,
} from "./program-attempt-context.ts";
import { RecoverableRunQueueV1 } from "./recoverable-run-queue.ts";

class ProgramAttemptExecutionStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramAttemptExecutionStaleError";
  }
}

function sameProgramAttemptIdentity(
  left: ProgramAttemptAuthorityV1,
  right: ProgramAttemptAuthorityV1,
): boolean {
  return left.programStateId === right.programStateId
    && left.programAttemptId === right.programAttemptId
    && left.workItemId === right.workItemId
    && left.agentGeneration === right.agentGeneration;
}

function sameProgramAttemptAuthority(
  left: ProgramAttemptAuthorityV1,
  right: ProgramAttemptAuthorityV1,
): boolean {
  return sameProgramAttemptIdentity(left, right)
    && left.expectedProgramRevision === right.expectedProgramRevision;
}

async function main(): Promise<void> {
  const generationId = process.env.ALCODE_AGENT_GENERATION_ID;
  if (!generationId) throw new Error("ALCODE_AGENT_GENERATION_ID is required");
  const protocol = createProcessAgentProtocolBridge();
  const runtime = await AgentRuntime.create({
    generationId,
    modules: createDefaultAgentRuntimeModules({ protocol }),
  });
  const programBehavior = runtime.rootScope.resolve(AGENT_PROGRAM_BEHAVIOR);
  const runCompositionFactory = runtime.rootScope.resolve(AGENT_RUN_COMPOSITION_FACTORY);
  let sessionId: string | null = null;
  let context: ContextProvide | null = null;
  let history: Message[] = [];
  let abortController = new AbortController();
  const runQueue = new RecoverableRunQueueV1();
  const inFlightProgramAttempts = new Set<string>();

  const reportError = async (message: string, activeSessionId?: string): Promise<void> => {
    await protocol.reportError(message, activeSessionId);
  };

  await protocol.announceHello(generationId, [
    "capability.request",
    "criterion.evidence",
    "agent.idle",
    DURABLE_TRANSCRIPT_CAPABILITY,
    GRAPH_CONTEXT_CAPABILITY,
    DYNAMIC_CAPABILITY_BINDING_CAPABILITY,
    PROGRAM_STATE_CAPABILITY,
    PROGRAM_EXECUTION_CAPABILITY,
  ]);

  const runInput = async (
    text: string,
    timestamp?: number,
    requiredProgramAttemptAuthority?: ProgramAttemptAuthorityV1,
  ): Promise<void> => {
    if (!sessionId || !context) throw new Error("Agent received input before session/context bootstrap");
    if (context.verbatim?.status === "incomplete") {
      throw new Error(`context incomplete: unresolved tool calls ${context.verbatim.pendingToolCallIds.join(", ")}`);
    }
    const localSessionId = sessionId;
    const localContext = context;
    const runAbortController = abortController;
    let latestProgramAttemptAuthority: ProgramAttemptProjectionV1["authority"] | undefined;
    let activeInferenceProjection: InferenceCapabilityProjection | null = null;
    let composition: AgentRunComposition | null = null;
    let firstInferenceCut = true;
    const disposeActiveInferenceScope = async (): Promise<void> => {
      const projection = activeInferenceProjection;
      activeInferenceProjection = null;
      if (projection !== null) await projection.dispose();
    };

    try {
      composition = await runCompositionFactory.create({
        sessionId: localSessionId,
        context: localContext,
        latestProgramAttemptAuthority: () => latestProgramAttemptAuthority,
      });
      const completeHistory = await runAgentLoop(text, {
        systemPrompt: localContext.systemPrompt,
        provider: composition.provider,
        tools: [...composition.tools],
        emit: (event) => composition!.emit(event),
        signal: runAbortController.signal,
        initialMessages: history,
        ...(localContext.verbatim !== undefined
          ? {
              beforeInference: async () => {
                // Defensive closure keeps at most one live inference scope even
                // if a future loop implementation skips the lifecycle callback.
                await disposeActiveInferenceScope();
                const refreshed = await requestInferenceContext(protocol, localSessionId, runAbortController.signal);
                const refreshedAttempt = refreshed.programAttempt;
                if (requiredProgramAttemptAuthority !== undefined) {
                  const currentAuthority = refreshedAttempt?.authority;
                  if (currentAuthority === undefined || refreshedAttempt?.work.lifecycle !== "in_progress") {
                    throw new ProgramAttemptExecutionStaleError("Requested ProgramAttempt is no longer executable");
                  }
                  if (firstInferenceCut) {
                    if (!sameProgramAttemptAuthority(currentAuthority, requiredProgramAttemptAuthority)) {
                      throw new ProgramAttemptExecutionStaleError("Requested ProgramAttempt authority is stale at first inference cut");
                    }
                  } else if (!sameProgramAttemptIdentity(currentAuthority, requiredProgramAttemptAuthority)
                      || currentAuthority.expectedProgramRevision < requiredProgramAttemptAuthority.expectedProgramRevision) {
                    throw new ProgramAttemptExecutionStaleError("Requested ProgramAttempt lost current Host authority");
                  }
                  firstInferenceCut = false;
                }
                latestProgramAttemptAuthority = currentAuthorityOrUndefined(refreshedAttempt);
                const projection = createInferenceCapabilityProjection({
                  runtime,
                  client: protocol,
                  sessionId: localSessionId,
                  catalog: refreshed.toolCatalog,
                  programAttemptAuthority: refreshedAttempt?.authority,
                });
                activeInferenceProjection = projection;
                return {
                  systemPrompt: renderProgramAttemptContext(
                    refreshed.systemPrompt,
                    refreshedAttempt,
                    requiredProgramAttemptAuthority !== undefined,
                  ),
                  messages: refreshed.messages,
                  ...(projection.tools !== undefined ? { tools: [...projection.tools] } : {}),
                };
              },
              afterInference: disposeActiveInferenceScope,
            }
          : {}),
        ...(timestamp !== undefined ? { promptTimestamp: timestamp } : {}),
      });
      history = completeHistory as Message[];
    } catch (error) {
      if (!(error instanceof ProgramAttemptExecutionStaleError)) {
        await reportError(error instanceof Error ? error.message : String(error), localSessionId);
      }
    } finally {
      try {
        await disposeActiveInferenceScope();
      } catch (error) {
        try {
          await reportError(
            `Inference scope disposal failed: ${error instanceof Error ? error.message : String(error)}`,
            localSessionId,
          );
        } catch {
          // The Host may already be closing the generation protocol.
        }
      }
      if (composition !== null) {
        try {
          await composition.dispose();
        } catch (error) {
          try {
            await reportError(
              `Agent run scope disposal failed: ${error instanceof Error ? error.message : String(error)}`,
              localSessionId,
            );
          } catch {
            // The Host may already be closing the generation protocol.
          }
        }
      }
    }
  };

  function currentAuthorityOrUndefined(
    projection: ProgramAttemptProjectionV1 | undefined,
  ): ProgramAttemptProjectionV1["authority"] | undefined {
    return projection?.authority;
  }

  protocol.onHostMessage((message: HostToAgentMessage) => {
    switch (message.type) {
      case "host.hello":
        if (message.protocolVersion !== AGENT_PROTOCOL_VERSION) {
          throw new Error(`Host protocol version ${message.protocolVersion} is incompatible`);
        }
        break;
      case "session.open":
      case "session.resume":
        sessionId = message.sessionId;
        break;
      case "context.provide":
        context = message;
        history = message.verbatim ? structuredClone(message.verbatim.messages) as Message[] : [];
        break;
      case "program.planning.begin":
        void programBehavior.submitPlanningProposal(message).catch((error) => {
          return reportError(error instanceof Error ? error.message : String(error), message.sessionId);
        });
        break;
      case "program.attempt.execute": {
        if (message.sessionId !== sessionId || message.authority.agentGeneration <= 0) {
          void reportError("program.attempt.execute authority/session mismatch", message.sessionId).catch(() => undefined);
          break;
        }
        const attemptKey = `${message.authority.programStateId}:${message.authority.programAttemptId}:${message.authority.agentGeneration}`;
        if (inFlightProgramAttempts.has(attemptKey)) break;
        inFlightProgramAttempts.add(attemptKey);
        void runQueue.enqueue(
          () => runInput(PROGRAM_EXECUTION_PROMPT, undefined, structuredClone(message.authority)),
          (error) => reportError(error instanceof Error ? error.message : String(error), message.sessionId),
          () => { inFlightProgramAttempts.delete(attemptKey); },
        );
        break;
      }
      case "input.admitted":
        if (message.sessionId !== sessionId) throw new Error("input.admitted session mismatch");
        void runQueue.enqueue(
          () => runInput(message.text, message.timestamp),
          (error) => reportError(error instanceof Error ? error.message : String(error), message.sessionId),
        );
        break;
      case "cancel":
        if (message.sessionId === sessionId) {
          abortController.abort(message.reason);
          abortController = new AbortController();
        }
        break;
      case "shutdown":
        abortController.abort(message.reason);
        void runtime.dispose().finally(() => process.exit(0));
        break;
      case "context.update":
      case "capability.result":
      case "transcript.admitted":
      case "program.planning.read.result":
      case "program.proposal.result":
      case "program.progress.result":
        break;
    }
  });
}

main().catch((error) => {
  try {
    if (typeof process.send === "function") {
      process.send({
        type: "agent.error",
        requestId: randomUUID(),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    process.exit(1);
  }
});
