import {
  PROGRAM_EXECUTION_V2_CAPABILITY,
  PROGRAM_EXECUTION_V2_MESSAGE_VERSION,
  PROGRAM_STATE_V2_CAPABILITY,
  assertProgramV2CapabilityDependencies,
  isProgramAttemptProjectionV2,
  type AgentToHostMessageV2Aware,
  type CapabilityRequestV2,
  type CapabilityResult,
  type ContextUpdate,
  type ContextUpdateV2,
  type HostToAgentMessageV2Aware,
  type ProgramAttemptExecuteV2,
  type ProgramAttemptProjectionV2,
  type ProgramProgressProposalV2,
  type ProgramProgressResultV2,
  type ProtocolTransport,
} from "@alcode/agent-protocol";
import type { SessionId } from "@alcode/events";
import { uuidv7 } from "@alcode/events";
import type { CapabilityBrokerRequest, ProgramCapabilityOperationContextV1 } from "./capability-broker.ts";
import {
  evaluateProgramAttemptAuthorityV2,
  issueProgramAttemptAuthorityV2,
  type ProgramAttemptAuthorityFactsV2,
} from "./program-attempt-authority-v2.ts";

const PROGRAM_V2_REPLAY_CACHE_MAX_ENTRIES = 256;
const PROGRAM_V2_RUNTIME_FAILURE_MAX_CHARS = 4096;

export interface ProgramAdaptiveExecutionCutV2 {
  facts: ProgramAttemptAuthorityFactsV2;
  projection: Omit<ProgramAttemptProjectionV2, "version" | "authority">;
  operationalProgramContext: ProgramCapabilityOperationContextV1;
}

export interface ProgramAdaptiveExecutionCutSourceV2 {
  currentForSession(
    sessionId: string,
    connectionGenerationId: string,
  ): Promise<ProgramAdaptiveExecutionCutV2 | undefined>;
  withProtectedCut<T>(
    sessionId: string,
    connectionGenerationId: string,
    work: (cut: ProgramAdaptiveExecutionCutV2 | undefined) => Promise<T>,
  ): Promise<T>;
}

export interface ProgramAdaptiveProgressAdmissionV2 {
  admit(input: {
    message: ProgramProgressProposalV2;
    cut: ProgramAdaptiveExecutionCutV2;
  }): Promise<{
    outcome: "admitted" | "stale" | "denied" | "failed";
    errorCode?: string;
    error?: string;
  }>;
}

export interface ProgramAgentServiceV2Options {
  cuts: ProgramAdaptiveExecutionCutSourceV2;
  progress: ProgramAdaptiveProgressAdmissionV2;
}

interface BindingV2 {
  generationId: string;
  sessionId: string;
  transport: ProtocolTransport<HostToAgentMessageV2Aware, AgentToHostMessageV2Aware>;
}

export class ProgramAgentV2ControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramAgentV2ControlError";
  }
}

function runtimeFailure(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  const normalized = text.length > 0 ? text : fallback;
  return normalized.length <= PROGRAM_V2_RUNTIME_FAILURE_MAX_CHARS
    ? normalized
    : `${normalized.slice(0, PROGRAM_V2_RUNTIME_FAILURE_MAX_CHARS - 3)}...`;
}

function capabilityResult(
  message: CapabilityRequestV2,
  outcome: CapabilityResult["outcome"],
  errorCode: string,
  error: string,
): CapabilityResult {
  return {
    type: "capability.result",
    requestId: message.requestId,
    sessionId: message.sessionId,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    outcome,
    errorCode,
    error,
  };
}

function progressResult(
  message: ProgramProgressProposalV2,
  outcome: ProgramProgressResultV2["outcome"],
  extras: Partial<Pick<ProgramProgressResultV2, "programStateId" | "programRevisionId" | "errorCode" | "error">> = {},
): ProgramProgressResultV2 {
  return {
    type: "program.progress.result",
    version: PROGRAM_EXECUTION_V2_MESSAGE_VERSION,
    requestId: message.requestId,
    sessionId: message.sessionId,
    outcome,
    ...extras,
  };
}

function operationalContextMatches(
  authority: ProgramProgressProposalV2["authority"] | CapabilityRequestV2["programAttemptAuthority"],
  context: ProgramCapabilityOperationContextV1,
): boolean {
  return context.programStateId === authority.programStateId
    && context.programAttemptId === authority.programAttemptId
    && context.workItemId === authority.workItemId
    && context.agentGeneration === authority.agentGeneration
    && Number.isSafeInteger(context.expectedProgramRevision)
    && context.expectedProgramRevision > 0;
}

function replayKey(generationId: string, sessionId: string, requestId: string): string {
  return `${generationId}:${sessionId}:${requestId}`;
}

function replayScopePrefix(generationId: string, sessionId: string): string {
  return `${generationId}:${sessionId}:`;
}

function replayWindowFull(
  completed: ReadonlyMap<string, unknown>,
  inFlight: ReadonlyMap<string, unknown>,
  prefix: string,
): boolean {
  let size = 0;
  for (const key of completed.keys()) if (key.startsWith(prefix)) size += 1;
  for (const key of inFlight.keys()) if (key.startsWith(prefix)) size += 1;
  return size >= PROGRAM_V2_REPLAY_CACHE_MAX_ENTRIES;
}

export class ProgramAgentServiceV2 {
  private readonly bindings = new Map<string, BindingV2>();
  private readonly capabilityResponses = new Map<string, CapabilityResult>();
  private readonly capabilityInFlight = new Map<string, Promise<CapabilityResult>>();
  private readonly progressResponses = new Map<string, ProgramProgressResultV2>();
  private readonly progressInFlight = new Map<string, Promise<ProgramProgressResultV2>>();

  constructor(private readonly options: ProgramAgentServiceV2Options) {}

  attach(input: {
    generationId: string;
    sessionId: string;
    capabilities: readonly string[];
    transport: ProtocolTransport<HostToAgentMessageV2Aware, AgentToHostMessageV2Aware>;
  }): string | undefined {
    if (!input.generationId || !input.sessionId) {
      throw new ProgramAgentV2ControlError("generationId and sessionId are required");
    }
    assertProgramV2CapabilityDependencies(input.capabilities);
    if (!input.capabilities.includes(PROGRAM_STATE_V2_CAPABILITY)
        || !input.capabilities.includes(PROGRAM_EXECUTION_V2_CAPABILITY)) {
      throw new ProgramAgentV2ControlError(
        `Adaptive Program execution requires ${PROGRAM_STATE_V2_CAPABILITY} and ${PROGRAM_EXECUTION_V2_CAPABILITY}`,
      );
    }
    const displaced = this.bindings.get(input.sessionId);
    const displacedGenerationId = displaced !== undefined && displaced.generationId !== input.generationId
      ? displaced.generationId
      : undefined;
    if (displacedGenerationId !== undefined) this.clearGeneration(displacedGenerationId);
    this.bindings.set(input.sessionId, {
      generationId: input.generationId,
      sessionId: input.sessionId,
      transport: input.transport,
    });
    return displacedGenerationId;
  }

  private clearGeneration(generationId: string): void {
    for (const [sessionId, binding] of this.bindings) {
      if (binding.generationId === generationId) this.bindings.delete(sessionId);
    }
    const prefix = `${generationId}:`;
    for (const cache of [
      this.capabilityResponses,
      this.capabilityInFlight,
      this.progressResponses,
      this.progressInFlight,
    ]) {
      for (const key of [...cache.keys()]) {
        if (key.startsWith(prefix)) cache.delete(key);
      }
    }
  }

  detach(generationId: string): void {
    this.clearGeneration(generationId);
  }

  isCurrentConnection(sessionId: string, generationId: string): boolean {
    const binding = this.bindings.get(sessionId);
    return binding?.generationId === generationId;
  }

  private requireBinding(sessionId: string, generationId: string): BindingV2 {
    const binding = this.bindings.get(sessionId);
    if (binding === undefined || binding.generationId !== generationId) {
      throw new ProgramAgentV2ControlError("Adaptive Program connection is not current");
    }
    return binding;
  }

  private async currentCut(sessionId: string, generationId: string): Promise<ProgramAdaptiveExecutionCutV2 | undefined> {
    this.requireBinding(sessionId, generationId);
    const cut = await this.options.cuts.currentForSession(sessionId, generationId);
    this.requireBinding(sessionId, generationId);
    return cut;
  }

  async currentAttemptProjection(
    sessionId: string,
    generationId: string,
  ): Promise<ProgramAttemptProjectionV2 | undefined> {
    const cut = await this.currentCut(sessionId, generationId);
    if (cut === undefined) return undefined;
    const authority = issueProgramAttemptAuthorityV2(cut.facts);
    if (!operationalContextMatches(authority, cut.operationalProgramContext)) {
      throw new ProgramAgentV2ControlError("Semantic and operational ProgramAttempt authority disagree");
    }
    const projection: ProgramAttemptProjectionV2 = {
      version: 2,
      authority,
      ...structuredClone(cut.projection),
    };
    if (!isProgramAttemptProjectionV2(projection)) {
      throw new ProgramAgentV2ControlError("Host produced an invalid ProgramAttemptProjectionV2");
    }
    return projection;
  }

  async enrichContextUpdate(
    base: Omit<ContextUpdate, "programAttempt">,
    sessionId: string,
    generationId: string,
  ): Promise<ContextUpdateV2> {
    const projection = await this.currentAttemptProjection(sessionId, generationId);
    return {
      ...base,
      ...(projection !== undefined ? { programAttempt: projection } : {}),
    };
  }

  async requestCurrentAttemptExecution(
    sessionId: string,
    generationId: string,
  ): Promise<ProgramAttemptExecuteV2 | undefined> {
    const projection = await this.currentAttemptProjection(sessionId, generationId);
    if (projection === undefined) return undefined;
    const binding = this.requireBinding(sessionId, generationId);
    const request: ProgramAttemptExecuteV2 = {
      type: "program.attempt.execute",
      version: PROGRAM_EXECUTION_V2_MESSAGE_VERSION,
      requestId: uuidv7(),
      sessionId,
      authority: structuredClone(projection.authority),
    };
    await binding.transport.send(request);
    return request;
  }

  private async computeProgress(
    message: ProgramProgressProposalV2,
    generationId: string,
  ): Promise<ProgramProgressResultV2> {
    if (!this.isCurrentConnection(message.sessionId, generationId)) {
      return progressResult(message, "stale", {
        errorCode: "program_execution_stale",
        error: "Agent generation is no longer current",
      });
    }
    return this.options.cuts.withProtectedCut(message.sessionId, generationId, async (cut) => {
      if (cut === undefined) {
        return progressResult(message, "stale", {
          errorCode: "program_execution_stale",
          error: "Adaptive ProgramAttempt is no longer current",
        });
      }
      const current = evaluateProgramAttemptAuthorityV2(message.authority, cut.facts);
      if (!current.current || !operationalContextMatches(message.authority, cut.operationalProgramContext)) {
        return progressResult(message, "stale", {
          errorCode: "program_execution_stale",
          error: current.current
            ? "Operational ProgramAttempt authority changed"
            : `ProgramAttempt authority stale: ${current.reason}`,
        });
      }
      const admitted = await this.options.progress.admit({ message, cut });
      return progressResult(message, admitted.outcome, {
        programStateId: message.authority.programStateId,
        programRevisionId: String(cut.facts.semantic.semanticState.currentRevision.programRevisionId),
        ...(admitted.errorCode !== undefined ? { errorCode: admitted.errorCode } : {}),
        ...(admitted.error !== undefined ? { error: admitted.error } : {}),
      });
    });
  }

  async handleProgress(
    message: ProgramProgressProposalV2,
    generationId: string,
  ): Promise<ProgramProgressResultV2> {
    const key = replayKey(generationId, message.sessionId, message.requestId);
    const cached = this.progressResponses.get(key);
    if (cached !== undefined) return structuredClone(cached);
    const existing = this.progressInFlight.get(key);
    if (existing !== undefined) return structuredClone(await existing);
    if (replayWindowFull(
      this.progressResponses,
      this.progressInFlight,
      replayScopePrefix(generationId, message.sessionId),
    )) {
      return progressResult(message, "denied", {
        errorCode: "program_execution_request_window_exhausted",
        error: "Adaptive Program progress replay window is full",
      });
    }
    const pending = this.computeProgress(message, generationId).catch((error) =>
      progressResult(message, "failed", {
        errorCode: "program_execution_runtime_failure",
        error: runtimeFailure(error, "Adaptive Program progress handling failed"),
      }));
    this.progressInFlight.set(key, pending);
    try {
      const result = await pending;
      if (this.isCurrentConnection(message.sessionId, generationId)) {
        this.progressResponses.set(key, structuredClone(result));
      }
      return result;
    } finally {
      this.progressInFlight.delete(key);
    }
  }

  private async computeCapability(
    input: {
      message: CapabilityRequestV2;
      generationId: string;
      sessionId: SessionId;
    },
    execute: (request: CapabilityBrokerRequest) => Promise<CapabilityResult>,
  ): Promise<CapabilityResult> {
    const { message, generationId } = input;
    if (!this.isCurrentConnection(message.sessionId, generationId)) {
      return capabilityResult(message, "stale", "program_execution_stale", "Agent generation is no longer current");
    }
    return this.options.cuts.withProtectedCut(message.sessionId, generationId, async (cut) => {
      if (cut === undefined) {
        return capabilityResult(message, "stale", "program_execution_stale", "Adaptive ProgramAttempt is no longer current");
      }
      const current = evaluateProgramAttemptAuthorityV2(message.programAttemptAuthority, cut.facts);
      if (!current.current || !operationalContextMatches(message.programAttemptAuthority, cut.operationalProgramContext)) {
        return capabilityResult(
          message,
          "stale",
          "program_execution_stale",
          current.current
            ? "Operational ProgramAttempt authority changed"
            : `ProgramAttempt authority stale: ${current.reason}`,
        );
      }
      return execute({
        sessionId: input.sessionId,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        args: structuredClone(message.args),
        ...(message.expectedCapabilityRevision !== undefined
          ? { expectedCapabilityRevision: message.expectedCapabilityRevision }
          : {}),
        program: structuredClone(cut.operationalProgramContext),
      });
    });
  }

  async handleCapability(
    input: {
      message: CapabilityRequestV2;
      generationId: string;
      sessionId: SessionId;
    },
    execute: (request: CapabilityBrokerRequest) => Promise<CapabilityResult>,
  ): Promise<CapabilityResult> {
    const key = replayKey(input.generationId, input.message.sessionId, input.message.requestId);
    const cached = this.capabilityResponses.get(key);
    if (cached !== undefined) return structuredClone(cached);
    const existing = this.capabilityInFlight.get(key);
    if (existing !== undefined) return structuredClone(await existing);
    if (replayWindowFull(
      this.capabilityResponses,
      this.capabilityInFlight,
      replayScopePrefix(input.generationId, input.message.sessionId),
    )) {
      return capabilityResult(
        input.message,
        "denied",
        "program_execution_request_window_exhausted",
        "Adaptive Program capability replay window is full",
      );
    }
    const pending = this.computeCapability(input, execute).catch((error) => capabilityResult(
      input.message,
      "failed",
      "program_execution_runtime_failure",
      runtimeFailure(error, "Adaptive Program capability handling failed"),
    ));
    this.capabilityInFlight.set(key, pending);
    try {
      const result = await pending;
      if (this.isCurrentConnection(input.message.sessionId, input.generationId)) {
        this.capabilityResponses.set(key, structuredClone(result));
      }
      return result;
    } finally {
      this.capabilityInFlight.delete(key);
    }
  }
}
