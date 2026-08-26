import type {
  AssistantMessage,
  Message,
  ModelProvider,
  ToolCallContent,
  ToolDefinition,
  ToolResultMessage,
} from "@alcode/agent-core";
import type {
  ProgramRevisionPlanWireV1,
  ProgramRevisionProposalResultWireV1,
} from "@alcode/agent-protocol";
import {
  ProgramRevisionProtocolClientValidationError,
  type ProgramRevisionProposalClientInputV1,
  type ProgramRevisionProtocolClientV1,
} from "./program-revision-protocol-client-v1.ts";

export const PROGRAM_REVISION_PLANNER_MAX_TURNS = 8;
export const PROGRAM_REVISION_PROPOSAL_TOOL_NAME = "submit_program_revision_proposal";

export class ProgramRevisionPlannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramRevisionPlannerError";
  }
}

export class ProgramRevisionPlannerStaleError extends ProgramRevisionPlannerError {
  constructor(message: string) {
    super(message);
    this.name = "ProgramRevisionPlannerStaleError";
  }
}

export class ProgramRevisionPlannerCancelledError extends ProgramRevisionPlannerError {
  constructor() {
    super("Revision planning was cancelled");
    this.name = "ProgramRevisionPlannerCancelledError";
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProgramRevisionPlannerCancelledError();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringify(value: unknown): string {
  try { return JSON.stringify(value); } catch { return JSON.stringify({ error: "value_not_serializable" }); }
}

function proposalFromArguments(
  value: unknown,
  plan: ProgramRevisionPlanWireV1,
): Omit<ProgramRevisionProposalClientInputV1, "sessionId" | "planningEpisodeId" | "programStateId" | "parentProgramRevisionId">
  | { error: string } {
  const input = record(value);
  if (input === undefined) return { error: "revision proposal arguments must be an object" };
  const allowed = new Set(["proposedChangeClass", "proposedEdit", "rationale"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    return { error: "revision proposal arguments contain unknown fields" };
  }
  if (input.proposedChangeClass !== "refinement"
      && input.proposedChangeClass !== "correction"
      && input.proposedChangeClass !== "scope_amendment") {
    return { error: "proposedChangeClass must be refinement, correction, or scope_amendment" };
  }
  const edit = record(input.proposedEdit);
  if (edit === undefined) return { error: "proposedEdit must be an object" };
  if (input.rationale !== undefined && (typeof input.rationale !== "string" || input.rationale.length === 0)) {
    return { error: "rationale must be a non-empty string when present" };
  }
  void plan;
  return {
    proposedChangeClass: input.proposedChangeClass,
    proposedEdit: structuredClone(edit),
    ...(typeof input.rationale === "string" ? { rationale: input.rationale } : {}),
  };
}

function proposalTool(): ToolDefinition {
  return {
    name: PROGRAM_REVISION_PROPOSAL_TOOL_NAME,
    description: "Submit one bounded semantic revision proposal. The Host owns canonical IDs, identity dispositions, RevisionImpact, Attempt retention, validation, sealing, and Application acceptance.",
    inputSchema: {
      type: "object",
      properties: {
        proposedChangeClass: { enum: ["refinement", "correction", "scope_amendment"] },
        proposedEdit: { type: "object" },
        rationale: { type: "string" },
      },
      required: ["proposedChangeClass", "proposedEdit"],
    },
  };
}

function systemPrompt(plan: ProgramRevisionPlanWireV1): string {
  return [
    "You are the ALCODE semantic Program revision planner inside one exact Host-requested planning episode.",
    `You must eventually call ${PROGRAM_REVISION_PROPOSAL_TOOL_NAME} with one candidate edit against the exact semantic state below.`,
    "Do not invent canonical ProgramRevision IDs, WorkItem identity dispositions, RevisionImpact, Attempt retention/invalidation, verification impact, or acceptance outcomes; the Host derives those mechanically.",
    "Do not claim that a proposal is current Program meaning. A Host-sealed draft remains noncanonical until exact Application acceptance.",
    `Planning episode: ${plan.planningEpisodeId}`,
    `ProgramState: ${plan.programStateId}`,
    `Parent ProgramRevision: ${plan.parentProgramRevisionId}`,
    `Whole-state revision at planning: ${plan.fromProgramStateRevision}`,
    `Current semantic state: ${stringify(plan.semanticState)}`,
  ].join("\n");
}

async function streamAssistant(
  provider: ModelProvider,
  prompt: string,
  messages: readonly Message[],
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  throwIfCancelled(signal);
  const stream = await provider.stream({
    systemPrompt: prompt,
    messages: messages.map((message) => structuredClone(message)),
    tools: [proposalTool()],
    ...(signal !== undefined ? { signal } : {}),
  });
  throwIfCancelled(signal);
  const content: AssistantMessage["content"] = [];
  let text = "";
  let stopReason: AssistantMessage["stopReason"] = "stop";
  let errorMessage: string | undefined;
  for await (const event of stream) {
    throwIfCancelled(signal);
    if (event.type === "text_delta") text += event.text;
    else if (event.type === "tool_call") {
      content.push({ type: "toolCall", id: event.id, name: event.name, arguments: structuredClone(event.arguments) });
    } else if (event.type === "done") {
      stopReason = event.stopReason;
      errorMessage = event.errorMessage;
    } else if (event.type === "error") {
      stopReason = "error";
      errorMessage = event.message;
    }
  }
  throwIfCancelled(signal);
  if (text.length > 0) content.unshift({ type: "text", text });
  if (content.length === 0) content.push({ type: "text", text: "" });
  return {
    role: "assistant",
    content,
    stopReason,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function toolResult(call: ToolCallContent, value: unknown, isError: boolean): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: stringify(value) }],
    isError,
    timestamp: Date.now(),
  };
}

export async function runProgramRevisionPlanner(options: {
  plan: ProgramRevisionPlanWireV1;
  provider: ModelProvider;
  client: Pick<ProgramRevisionProtocolClientV1, "submitProposal">;
  signal?: AbortSignal;
  maxTurns?: number;
}): Promise<{ outcome: "sealed"; turns: number }> {
  const maxTurns = options.maxTurns ?? PROGRAM_REVISION_PLANNER_MAX_TURNS;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
    throw new ProgramRevisionPlannerError("maxTurns must be a positive safe integer");
  }
  const messages: Message[] = [{
    role: "user",
    content: [{ type: "text", text: "Propose the required semantic Program revision against the exact Host state." }],
    timestamp: Date.now(),
  }];
  const prompt = systemPrompt(options.plan);

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    throwIfCancelled(options.signal);
    const assistant = await streamAssistant(options.provider, prompt, messages, options.signal);
    throwIfCancelled(options.signal);
    messages.push(assistant);
    if (assistant.stopReason === "error") {
      throw new ProgramRevisionPlannerError(`Revision planning provider failed${assistant.errorMessage ? `: ${assistant.errorMessage}` : ""}`);
    }
    const calls = assistant.content.filter((item): item is ToolCallContent => item.type === "toolCall");
    if (calls.length === 0) {
      throw new ProgramRevisionPlannerError("Revision planning model ended without submitting the advertised proposal tool");
    }
    for (const call of calls) {
      throwIfCancelled(options.signal);
      if (call.name !== PROGRAM_REVISION_PROPOSAL_TOOL_NAME) {
        messages.push(toolResult(call, { outcome: "denied", error: "unknown revision planning tool" }, true));
        continue;
      }
      const proposed = proposalFromArguments(call.arguments, options.plan);
      if ("error" in proposed) {
        messages.push(toolResult(call, { outcome: "denied", correctable: true, error: proposed.error }, true));
        continue;
      }
      // Cancellation is authoritative only before Host submission. Once this
      // call begins, the Host may have consumed the exact planning episode, so
      // we must await and reconcile its terminal result rather than abandon it.
      throwIfCancelled(options.signal);
      let result: ProgramRevisionProposalResultWireV1;
      try {
        result = await options.client.submitProposal({
          sessionId: options.plan.sessionId,
          planningEpisodeId: options.plan.planningEpisodeId,
          programStateId: options.plan.programStateId,
          parentProgramRevisionId: options.plan.parentProgramRevisionId,
          ...proposed,
        });
      } catch (error) {
        if (error instanceof ProgramRevisionProtocolClientValidationError) {
          messages.push(toolResult(call, {
            outcome: "denied",
            correctable: true,
            error: error.message,
          }, true));
          continue;
        }
        throw error;
      }
      if (result.outcome === "sealed") return { outcome: "sealed", turns: turn };
      if (result.outcome === "stale") {
        throw new ProgramRevisionPlannerStaleError(result.error ?? "Semantic revision planning authority became stale");
      }
      if (result.outcome === "failed") {
        throw new ProgramRevisionPlannerError(result.error ?? "Semantic revision proposal failed");
      }
      throw new ProgramRevisionPlannerError(
        result.error ?? "Semantic revision proposal was denied by Host; the planning episode is consumed",
      );
    }
  }
  throw new ProgramRevisionPlannerError(`Revision planning exceeded ${maxTurns} turns without sealing a draft`);
}
