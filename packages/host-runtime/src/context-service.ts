import {
  canonicalJson,
  chars4Estimate,
  compileGraphContext,
  digestOf,
  type ContextBudget,
  type ContextMode,
  type ContextProjectionReceipt,
  type WorkspaceContextProvider,
  type WorkspaceObservation,
} from "@alcode/context";
import {
  asSessionId,
  asWorkspaceId,
  mkEventId,
  type EventDraft,
} from "@alcode/events";
import type { ContextUpdate } from "@alcode/agent-protocol";
import type { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { HostContextSourceReader } from "./context-source.ts";

export interface HostContextServiceOptions {
  requestedMode?: ContextMode;
  graphBudget?: ContextBudget;
  workspaceContextProvider?: WorkspaceContextProvider;
  policyVersion?: string;
}

export interface RefreshContextInput {
  requestId: string;
  sessionId: string;
  baseSystemPrompt: string;
  toolDefinitions: readonly unknown[];
  graphCapable: boolean;
}

function unavailableWorkspace(reasonCode: string): WorkspaceObservation {
  return {
    status: "failed",
    observedAt: new Date().toISOString(),
    providerVersion: "unavailable-v1",
    reasonCode,
  };
}

function emptyExcludedSummary() {
  const empty = () => ({ candidateCount: 0, excludedCount: 0, reasonCounts: {} as Record<string, number> });
  return { transcript: empty(), reasoning: empty(), memory: empty() };
}

export class HostContextService {
  private readonly requestedMode: ContextMode;
  private readonly policyVersion: string;

  constructor(
    private readonly workspaceId: string,
    private readonly sourceReader: HostContextSourceReader,
    private readonly admission: CanonicalAdmissionQueue,
    private readonly options: HostContextServiceOptions = {},
  ) {
    this.requestedMode = options.requestedMode ?? "verbatim";
    this.policyVersion = options.policyVersion ?? "phase-0.7-policy-v1";
    if (this.requestedMode === "graph" && !options.graphBudget) {
      throw new Error("graph context mode requires an explicit graphBudget");
    }
  }

  async refresh(input: RefreshContextInput): Promise<ContextUpdate> {
    const source = await this.sourceReader.snapshot(input.sessionId);
    if (source.transcriptStatus !== "complete") {
      throw new Error(`context is not continuable; pending tool calls: ${source.pendingToolCallIds.join(",")}`);
    }

    const baseSystemPromptDigest = digestOf(input.baseSystemPrompt);
    const toolDefinitionsDigest = digestOf(input.toolDefinitions);
    const policyConfigDigest = digestOf({
      requestedMode: this.requestedMode,
      graphBudget: this.options.graphBudget ?? null,
      policyVersion: this.policyVersion,
    });
    const fixedRequestRenderedChars = canonicalJson({
      baseSystemPrompt: input.baseSystemPrompt,
      toolDefinitions: input.toolDefinitions,
    }).length;

    let effectiveMode: "verbatim-v1" | "graph-v1" = "verbatim-v1";
    let messages = source.messages.map((message) => structuredClone(message));
    let systemPrompt = input.baseSystemPrompt;
    let receipt: ContextProjectionReceipt;

    if (this.requestedMode === "graph") {
      if (!input.graphCapable) {
        const workspace = unavailableWorkspace("context_not_observed_unsupported_capability");
        const deliveredRenderedChars = fixedRequestRenderedChars + canonicalJson(messages).length;
        receipt = {
          receiptVersion: "context-receipt-v1",
          source: {
            sourceEventSequence: source.sourceEventSequence,
            workspaceObservation: workspace,
            requestEnvironmentDigest: digestOf({
              baseSystemPromptDigest,
              toolDefinitionsDigest,
              policyConfigDigest,
              requestedMode: this.requestedMode,
              compilerVersion: "graph-v1",
            }),
            baseSystemPromptDigest,
            toolDefinitionsDigest,
            policyConfigDigest,
          },
          attempt: {
            requestedMode: "graph",
            candidateCount: 0,
            candidateUniverseDigest: digestOf([]),
            requiredRenderedChars: 0,
            optionalSelectedRenderedChars: 0,
            maxGraphRenderedChars: this.options.graphBudget!.maxGraphRenderedChars,
            selected: [],
            excludedSummary: emptyExcludedSummary(),
          },
          delivery: {
            effectiveMode: "verbatim-v1",
            deliveredRenderedChars,
            deliveredEstimatedTokens: chars4Estimate(deliveredRenderedChars),
            messagesDigest: digestOf(messages),
            systemAppendixDigest: digestOf(""),
            observationDigest: digestOf({
              effectiveMode: "verbatim-v1",
              sourceEventSequence: source.sourceEventSequence,
              baseSystemPromptDigest,
              toolDefinitionsDigest,
              messagesDigest: digestOf(messages),
              systemAppendixDigest: digestOf(""),
            }),
            graphBoundSatisfied: null,
          },
          fallback: { used: true, reason: "unsupported_context_capability" },
        };
      } else {
        const workspace = this.options.workspaceContextProvider
          ? await this.options.workspaceContextProvider.observe()
          : unavailableWorkspace("workspace_provider_unavailable");
        const compiled = compileGraphContext({
          source,
          workspace,
          budget: this.options.graphBudget!,
          fixedRequestRenderedChars,
          requestEnvironment: {
            baseSystemPromptDigest,
            toolDefinitionsDigest,
            compilerVersion: "graph-v1",
            policyConfigDigest,
          },
        });
        effectiveMode = compiled.effectiveMode;
        messages = compiled.historyMessages.map((message) => structuredClone(message));
        systemPrompt = compiled.effectiveMode === "graph-v1"
          ? `${input.baseSystemPrompt}\n\n${compiled.systemAppendix}`
          : input.baseSystemPrompt;
        receipt = compiled.receipt;
      }
    } else {
      const workspace = unavailableWorkspace("not_observed_verbatim");
      const messagesDigest = digestOf(messages);
      const systemAppendixDigest = digestOf("");
      const deliveredRenderedChars = fixedRequestRenderedChars + canonicalJson(messages).length;
      receipt = {
        receiptVersion: "context-receipt-v1",
        source: {
          sourceEventSequence: source.sourceEventSequence,
          workspaceObservation: workspace,
          requestEnvironmentDigest: digestOf({
            baseSystemPromptDigest,
            toolDefinitionsDigest,
            policyConfigDigest,
            requestedMode: "verbatim",
          }),
          baseSystemPromptDigest,
          toolDefinitionsDigest,
          policyConfigDigest,
        },
        attempt: {
          requestedMode: "verbatim",
          candidateCount: 0,
          candidateUniverseDigest: digestOf([]),
          requiredRenderedChars: 0,
          optionalSelectedRenderedChars: 0,
          maxGraphRenderedChars: 0,
          selected: [],
          excludedSummary: emptyExcludedSummary(),
        },
        delivery: {
          effectiveMode: "verbatim-v1",
          deliveredRenderedChars,
          deliveredEstimatedTokens: chars4Estimate(deliveredRenderedChars),
          messagesDigest,
          systemAppendixDigest,
          observationDigest: digestOf({
            effectiveMode: "verbatim-v1",
            sourceEventSequence: source.sourceEventSequence,
            baseSystemPromptDigest,
            toolDefinitionsDigest,
            messagesDigest,
            systemAppendixDigest,
          }),
          graphBoundSatisfied: null,
        },
        fallback: { used: false },
      };
    }

    const eventId = mkEventId();
    const receiptId = eventId as string;
    const payload = {
      receiptId,
      requestedMode: receipt.attempt.requestedMode,
      effectiveMode: receipt.delivery.effectiveMode,
      compilerVersion: this.requestedMode === "graph" ? "graph-v1" : "verbatim-v1",
      source: receipt.source,
      attempt: receipt.attempt,
      delivery: receipt.delivery,
      fallback: receipt.fallback,
    };
    const draft: EventDraft<string, unknown> = {
      eventId,
      idempotencyKey: `context:${input.sessionId}:${input.requestId}`,
      workspaceId: asWorkspaceId(this.workspaceId),
      sessionId: asSessionId(input.sessionId),
      occurredAt: new Date().toISOString(),
      type: "context.projection_compiled",
      payload,
      payloadSchemaVersion: 1,
      producer: { kind: "projection", projectionName: "host-context" },
      correlationId: input.requestId,
    };
    const [persisted] = await this.admission.append([draft]);
    if (!persisted) throw new Error("context receipt was not persisted");

    return {
      type: "context.update",
      requestId: input.requestId,
      sessionId: input.sessionId,
      receiptId,
      effectiveMode,
      sourceEventSequence: source.sourceEventSequence,
      systemPrompt,
      messages: messages as ContextUpdate["messages"],
    };
  }
}
