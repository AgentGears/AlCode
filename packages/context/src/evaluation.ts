import { graphToJSON } from "@alcode/reasoning";
import { canonicalJson, digestOf } from "./canonical.ts";
import { compileGraphContext } from "./compiler.ts";
import type {
  CompileGraphContextRequest,
  ContextProjectionReceipt,
  ContextSourceSnapshot,
  WorkspaceObservation,
} from "./types.ts";

export interface ContextEvaluationOracle {
  requiredText?: string[];
  excludedText?: string[];
}

export interface ContextEvaluationMetrics {
  fixtureId: string;
  initialStateDigest: string;
  baseline: {
    effectiveMode: "verbatim-v1";
    deliveredRenderedChars: number;
    deliveredEstimatedTokens: number;
  };
  graph: {
    effectiveMode: "verbatim-v1" | "graph-v1";
    graphRenderedChars: number;
    deliveredRenderedChars: number;
    deliveredEstimatedTokens: number;
    fallbackReason: string | null;
    requiredFactsPreserved: boolean;
    excludedFactsAbsent: boolean;
    oracleSucceeded: boolean;
    receiptDigest: string;
  };
}

function serializableSource(source: ContextSourceSnapshot): unknown {
  return {
    sessionId: source.sessionId,
    sourceEventSequence: source.sourceEventSequence,
    messages: source.messages,
    transcriptStatus: source.transcriptStatus,
    pendingToolCallIds: source.pendingToolCallIds,
    graph: graphToJSON(source.graph),
    diagnostics: source.diagnostics,
    memories: source.memories,
    memoryStats: [...source.memoryStats.entries()].sort(([a], [b]) => a.localeCompare(b)),
    operations: source.operations,
    incompleteWorkCount: source.incompleteWorkCount,
    currentUserText: source.currentUserText,
    currentUserTimestamp: source.currentUserTimestamp,
  };
}

function renderObservation(systemAppendix: string, messages: readonly unknown[]): string {
  return `${systemAppendix}\n${canonicalJson(messages)}`;
}

export function evaluateContextPair(input: {
  fixtureId: string;
  source: ContextSourceSnapshot;
  workspace: WorkspaceObservation;
  graphRequest: Omit<CompileGraphContextRequest, "source" | "workspace">;
  oracle?: ContextEvaluationOracle;
}): ContextEvaluationMetrics {
  const pristineSource = structuredClone(input.source);
  const baselineSource = structuredClone(pristineSource);
  const graphSource = structuredClone(pristineSource);
  const stateDigest = digestOf(serializableSource(pristineSource));
  if (digestOf(serializableSource(baselineSource)) !== stateDigest || digestOf(serializableSource(graphSource)) !== stateDigest) {
    throw new Error("evaluation pair did not start from equivalent immutable state");
  }

  const baselineRenderedChars =
    (input.graphRequest.fixedRequestRenderedChars ?? 0) +
    canonicalJson(baselineSource.messages).length;
  const baselineEstimatedTokens = Math.ceil(baselineRenderedChars / 4);

  const result = compileGraphContext({
    ...input.graphRequest,
    source: graphSource,
    workspace: structuredClone(input.workspace),
  });
  const rendered = renderObservation(result.systemAppendix, result.historyMessages);
  const required = input.oracle?.requiredText ?? [];
  const excluded = input.oracle?.excludedText ?? [];
  const requiredFactsPreserved = required.every((text) => rendered.includes(text));
  const excludedFactsAbsent = excluded.every((text) => !rendered.includes(text));
  const oracleSucceeded = requiredFactsPreserved && excludedFactsAbsent;

  return {
    fixtureId: input.fixtureId,
    initialStateDigest: stateDigest,
    baseline: {
      effectiveMode: "verbatim-v1",
      deliveredRenderedChars: baselineRenderedChars,
      deliveredEstimatedTokens: baselineEstimatedTokens,
    },
    graph: {
      effectiveMode: result.effectiveMode,
      graphRenderedChars: result.graphRenderedChars,
      deliveredRenderedChars: result.deliveredRenderedChars,
      deliveredEstimatedTokens: result.estimatedTokens,
      fallbackReason: result.effectiveMode === "verbatim-v1" ? result.reason : null,
      requiredFactsPreserved,
      excludedFactsAbsent,
      oracleSucceeded,
      receiptDigest: digestOf(result.receipt satisfies ContextProjectionReceipt),
    },
  };
}

/** Evaluation evidence is descriptive only; product-default promotion is external authorization. */
export function evaluationPromotesDefault(_metrics: readonly ContextEvaluationMetrics[]): false {
  return false;
}
