import {
  VERBATIM_COMPILER_VERSION,
  type VerbatimContextEnvelope,
} from "@alcode/agent-protocol";
import type { TranscriptSnapshot } from "@alcode/storage";

export class ContextIncompleteError extends Error {
  constructor(readonly pendingToolCallIds: readonly string[]) {
    super(`context incomplete: unresolved tool calls ${pendingToolCallIds.join(", ")}`);
    this.name = "ContextIncompleteError";
  }
}

export function compileVerbatimContext(snapshot: TranscriptSnapshot): VerbatimContextEnvelope {
  return {
    compilerVersion: VERBATIM_COMPILER_VERSION,
    sourceEventSequence: snapshot.sourceEventSequence,
    // Copy through JSON-compatible structure so the Agent receives a disposable
    // value rather than a Host read-model object graph.
    messages: structuredClone(snapshot.messages),
    status: snapshot.status,
    pendingToolCallIds: [...snapshot.pendingToolCallIds],
    fidelity: snapshot.fidelity,
  };
}

export function assertContextContinuable(context: VerbatimContextEnvelope): void {
  if (context.status === "incomplete") {
    throw new ContextIncompleteError(context.pendingToolCallIds);
  }
}
