import {
  type AssistantMessage,
  type Message,
  type ModelProvider,
  type ToolCallContent,
  type ToolDefinition,
  type ToolResultMessage,
} from "@alcode/agent-core";
import {
  PROGRAM_PROPOSAL_MAX_BYTES,
  type ProgramCreationProposalWireV1,
  type ProgramPlanningBegin,
  type ProgramPlanningReadDescriptorV1,
} from "@alcode/agent-protocol";
import type { AgentProtocolClient } from "./agent-protocol-bridge.ts";

export const PROGRAM_PLANNER_MAX_TURNS = 12;
export const PROGRAM_PLANNER_MAX_TOOL_CALLS = 48;
export const PROGRAM_PROPOSAL_TOOL_NAME = "submit_program_proposal";
const CORRECTABLE_PROPOSAL_ERROR_CODE = "program_proposal_invalid";

const encoder = new TextEncoder();

export class ProgramPlannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramPlannerError";
  }
}

export class ProgramPlannerStaleError extends ProgramPlannerError {
  constructor(message: string) {
    super(message);
    this.name = "ProgramPlannerStaleError";
  }
}

export class ProgramPlannerBoundsError extends ProgramPlannerError {
  constructor(message: string) {
    super(message);
    this.name = "ProgramPlannerBoundsError";
  }
}

export class ProgramPlannerCancelledError extends ProgramPlannerError {
  constructor(message = "Program planning was cancelled") {
    super(message);
    this.name = "ProgramPlannerCancelledError";
  }
}

export interface ProgramPlannerOptions {
  begin: ProgramPlanningBegin;
  provider: ModelProvider;
  protocol: Pick<AgentProtocolClient, "requestProgramPlanningRead" | "submitProgramProposal">;
  signal?: AbortSignal;
  maxTurns?: number;
  maxToolCalls?: number;
}

export interface ProgramPlannerResult {
  outcome: "sealed";
  turns: number;
  toolCalls: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: "value_not_serializable" });
  }
}

function abortReason(signal: AbortSignal | undefined): ProgramPlannerCancelledError {
  if (signal?.reason instanceof Error) return new ProgramPlannerCancelledError(signal.reason.message);
  return new ProgramPlannerCancelledError(signal?.reason === undefined ? undefined : String(signal.reason));
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function proposalFromArguments(
  input: unknown,
  expectedObjective: string,
): ProgramCreationProposalWireV1 | { error: string } {
  const value = record(input);
  if (value === undefined) return { error: "proposal arguments must be an object" };
  const allowed = new Set(["objective", "workItems", "verification", "outputSlots", "productionSteps"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return { error: "proposal arguments contain unknown fields" };
  }
  if (typeof value.objective !== "string" || value.objective.length === 0) {
    return { error: "proposal objective must be a non-empty string" };
  }
  if (value.objective !== expectedObjective) {
    return { error: "proposal objective must exactly match the Host planning objective" };
  }
  if (!Array.isArray(value.workItems)
      || !Array.isArray(value.verification)
      || !Array.isArray(value.outputSlots)
      || !Array.isArray(value.productionSteps)) {
    return { error: "proposal workItems, verification, outputSlots, and productionSteps must be arrays" };
  }
  const proposal: ProgramCreationProposalWireV1 = {
    objective: value.objective,
    workItems: structuredClone(value.workItems),
    verification: structuredClone(value.verification),
    outputSlots: structuredClone(value.outputSlots),
    productionSteps: structuredClone(value.productionSteps),
  };
  const serialized = stringify(proposal);
  if (encoder.encode(serialized).byteLength > PROGRAM_PROPOSAL_MAX_BYTES) {
    return { error: `proposal exceeds ${PROGRAM_PROPOSAL_MAX_BYTES} serialized bytes` };
  }
  return proposal;
}

function verifierProposalSchema(begin: ProgramPlanningBegin): Record<string, unknown> {
  const catalog = begin.verifierCatalog;
  if (catalog === undefined) return { type: "object" };
  return {
    type: "object",
    properties: {
      obligationId: { type: "string" },
      verifier: {
        oneOf: catalog.verifiers.map((descriptor) => ({
          type: "object",
          properties: {
            specId: { const: descriptor.specId },
            specVersion: { const: descriptor.specVersion },
          },
          required: ["specId", "specVersion"],
        })),
      },
      args: { type: "object" },
      freshnessScope: { type: "object" },
    },
    required: ["obligationId", "verifier", "args", "freshnessScope"],
  };
}

function proposalTool(begin: ProgramPlanningBegin): ToolDefinition {
  return {
    name: PROGRAM_PROPOSAL_TOOL_NAME,
    description: "Submit one candidate canonical Program to the Host for validation and sealing. The Host, not the model, owns admission, verifier canonicalization, and acceptance.",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string" },
        workItems: { type: "array", items: { type: "object" } },
        verification: {
          type: "array",
          ...(begin.verifierCatalog !== undefined ? { minItems: 1 } : {}),
          items: verifierProposalSchema(begin),
        },
        outputSlots: { type: "array", items: { type: "object" } },
        productionSteps: { type: "array", items: { type: "object" } },
      },
      required: ["objective", "workItems", "verification", "outputSlots", "productionSteps"],
    },
  };
}

function planningTools(begin: ProgramPlanningBegin): {
  tools: ToolDefinition[];
  reads: Map<string, ProgramPlanningReadDescriptorV1>;
} {
  const catalog = begin.planningCatalog;
  if (catalog === undefined) {
    throw new ProgramPlannerError("Host did not provide the required planning catalog");
  }
  const reads = new Map<string, ProgramPlanningReadDescriptorV1>();
  const tools: ToolDefinition[] = [];
  for (const descriptor of catalog.reads) {
    if (descriptor.definition.name === PROGRAM_PROPOSAL_TOOL_NAME) {
      throw new ProgramPlannerError(`Host planning catalog conflicts with reserved tool ${PROGRAM_PROPOSAL_TOOL_NAME}`);
    }
    if (reads.has(descriptor.definition.name)) {
      throw new ProgramPlannerError(`Host planning catalog repeats model tool ${descriptor.definition.name}`);
    }
    const cloned = structuredClone(descriptor);
    reads.set(cloned.definition.name, cloned);
    tools.push({
      name: cloned.definition.name,
      description: cloned.definition.description,
      inputSchema: cloned.definition.inputSchema,
    });
  }
  tools.push(proposalTool(begin));
  return { tools, reads };
}

function planningSystemPrompt(begin: ProgramPlanningBegin): string {
  const verifierLines = begin.verifierCatalog === undefined
    ? []
    : [
        "Declare at least one verification obligation using only the exact Host verifier catalog below.",
        "Each verification entry must be {obligationId, verifier:{specId,specVersion}, args, freshnessScope}. The Host canonicalizes verifier arguments and computes trusted digests; do not invent verifier identities or claim verifier satisfaction.",
        `Verifier catalog digest: ${begin.verifierCatalog.digest}`,
        `Verifier catalog: ${stringify(begin.verifierCatalog.verifiers)}`,
      ];
  return [
    "You are the ALCODE Program planner operating inside one bounded Host planning episode.",
    "Use only the planning tools advertised in this request to inspect the workspace.",
    `You must eventually call ${PROGRAM_PROPOSAL_TOOL_NAME} with one candidate Program whose objective exactly matches the caller objective.`,
    ...verifierLines,
    "The Host validates every semantic read and proposal. A tool rejection may provide correctable facts; correct and resubmit only while this same episode remains current.",
    "A sealed proposal ends planning immediately. Do not claim that the Program is accepted, executed, verified, or complete; those decisions remain Host/Application authority.",
    `Planning episode: ${begin.planningEpisodeId}`,
    `Planning catalog digest: ${begin.planningCatalog?.digest ?? "missing"}`,
  ].join("\n");
}

async function streamAssistant(
  provider: ModelProvider,
  systemPrompt: string,
  messages: readonly Message[],
  tools: readonly ToolDefinition[],
  signal?: AbortSignal,
): Promise<AssistantMessage> {
  assertNotCancelled(signal);
  const request = {
    systemPrompt,
    messages: messages.map((message) => structuredClone(message)),
    tools: tools.map((tool) => structuredClone(tool)),
    ...(signal !== undefined ? { signal } : {}),
  };
  const stream = await provider.stream(request);
  const content: AssistantMessage["content"] = [];
  let stopReason: AssistantMessage["stopReason"] = "stop";
  let errorMessage: string | undefined;
  let text = "";
  for await (const event of stream) {
    assertNotCancelled(signal);
    if (event.type === "text_delta") {
      text += event.text;
    } else if (event.type === "tool_call") {
      content.push({
        type: "toolCall",
        id: event.id,
        name: event.name,
        arguments: structuredClone(event.arguments),
      });
    } else if (event.type === "done") {
      stopReason = event.stopReason;
      errorMessage = event.errorMessage;
    } else if (event.type === "error") {
      stopReason = "error";
      errorMessage = event.message;
    }
  }
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

function toolResult(
  call: ToolCallContent,
  value: unknown,
  isError: boolean,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: stringify(value) }],
    isError,
    timestamp: Date.now(),
  };
}

export async function runProgramPlanner(options: ProgramPlannerOptions): Promise<ProgramPlannerResult> {
  const maxTurns = options.maxTurns ?? PROGRAM_PLANNER_MAX_TURNS;
  const maxToolCalls = options.maxToolCalls ?? PROGRAM_PLANNER_MAX_TOOL_CALLS;
  if (!Number.isSafeInteger(maxTurns) || maxTurns <= 0) throw new ProgramPlannerBoundsError("maxTurns must be a positive safe integer");
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls <= 0) throw new ProgramPlannerBoundsError("maxToolCalls must be a positive safe integer");
  const { tools, reads } = planningTools(options.begin);
  const messages: Message[] = [{
    role: "user",
    content: [{ type: "text", text: options.begin.objective }],
    timestamp: Date.now(),
  }];
  const systemPrompt = planningSystemPrompt(options.begin);
  let toolCalls = 0;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    assertNotCancelled(options.signal);
    const assistant = await streamAssistant(
      options.provider,
      systemPrompt,
      messages,
      tools,
      options.signal,
    );
    messages.push(assistant);
    if (assistant.stopReason === "error") {
      throw new ProgramPlannerError(`Planning provider failed${assistant.errorMessage ? `: ${assistant.errorMessage}` : ""}`);
    }
    if (assistant.stopReason === "aborted") throw abortReason(options.signal);
    const calls = assistant.content.filter((item): item is ToolCallContent => item.type === "toolCall");
    if (calls.length === 0) {
      throw new ProgramPlannerError("Planning model ended a turn without submitting or invoking an advertised planning tool");
    }

    for (const call of calls) {
      assertNotCancelled(options.signal);
      toolCalls += 1;
      if (toolCalls > maxToolCalls) {
        throw new ProgramPlannerBoundsError(`Program planning exceeded ${maxToolCalls} tool calls`);
      }

      if (call.name === PROGRAM_PROPOSAL_TOOL_NAME) {
        const proposal = proposalFromArguments(call.arguments, options.begin.objective);
        if ("error" in proposal) {
          messages.push(toolResult(call, { outcome: "denied", correctable: true, error: proposal.error }, true));
          continue;
        }
        const response = await options.protocol.submitProgramProposal({
          sessionId: options.begin.sessionId,
          planningEpisodeId: options.begin.planningEpisodeId,
          proposal,
        });
        if (response.outcome === "sealed") {
          return { outcome: "sealed", turns: turn, toolCalls };
        }
        if (response.outcome === "stale") {
          throw new ProgramPlannerStaleError(response.error ?? "Planning proposal authority became stale");
        }
        if (response.outcome === "denied" && response.errorCode === CORRECTABLE_PROPOSAL_ERROR_CODE) {
          messages.push(toolResult(call, {
            outcome: response.outcome,
            correctable: true,
            errorCode: response.errorCode,
            error: response.error,
          }, true));
          continue;
        }
        throw new ProgramPlannerError(
          `Program proposal was not sealable: ${response.outcome}${response.error ? ` (${response.error})` : ""}`,
        );
      }

      const descriptor = reads.get(call.name);
      if (descriptor === undefined) {
        messages.push(toolResult(call, {
          outcome: "denied",
          error: `Tool ${call.name} is not in the Host planning catalog`,
        }, true));
        continue;
      }
      const response = await options.protocol.requestProgramPlanningRead({
        sessionId: options.begin.sessionId,
        planningEpisodeId: options.begin.planningEpisodeId,
        readContractId: descriptor.readContractId,
        readContractVersion: descriptor.readContractVersion,
        args: structuredClone(call.arguments),
      });
      if (response.outcome === "succeeded") {
        messages.push(toolResult(call, { outcome: "succeeded", result: response.result }, false));
      } else if (response.outcome === "stale") {
        throw new ProgramPlannerStaleError(response.error ?? "Planning read authority became stale");
      } else if (response.outcome === "denied") {
        messages.push(toolResult(call, {
          outcome: "denied",
          errorCode: response.errorCode,
          error: response.error,
        }, true));
      } else {
        throw new ProgramPlannerError(`Planning read failed${response.error ? `: ${response.error}` : ""}`);
      }
    }
  }

  throw new ProgramPlannerBoundsError(`Program planning exceeded ${maxTurns} provider turns without a sealed proposal`);
}
