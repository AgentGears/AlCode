import type { WorkspaceEventStore } from "@alcode/storage";

export interface CapabilityInferenceProvenanceV1 {
  toolCallId: string;
  inferenceEpochId?: string;
  parentToolCallId?: string;
  localSubcallIndex?: number;
}

function validate(input: CapabilityInferenceProvenanceV1): CapabilityInferenceProvenanceV1 {
  if (!input.toolCallId) throw new Error("capability provenance requires toolCallId");
  if (input.inferenceEpochId !== undefined && !input.inferenceEpochId) {
    throw new Error("capability provenance inferenceEpochId must be non-empty");
  }
  const hasParent = input.parentToolCallId !== undefined;
  const hasIndex = input.localSubcallIndex !== undefined;
  if (hasParent !== hasIndex) {
    throw new Error("Code Mode capability provenance requires parentToolCallId and localSubcallIndex together");
  }
  if (hasParent && !input.parentToolCallId) {
    throw new Error("Code Mode parentToolCallId must be non-empty");
  }
  if (hasIndex && (!Number.isSafeInteger(input.localSubcallIndex) || input.localSubcallIndex! < 0)) {
    throw new Error("Code Mode localSubcallIndex must be a non-negative safe integer");
  }
  return structuredClone(input);
}

/**
 * Compatibility seam retained while A2 call sites converge. Correlation is now
 * persisted directly by CapabilityBroker; the canonical Workspace store is not
 * wrapped or mutated.
 */
export function installCapabilityInferenceProvenanceV1(_store: WorkspaceEventStore): void {}

/**
 * Validate the causal tuple at the adaptive routing edge without creating an
 * ambient authority/correlation channel. ProgramAgentServiceV2 forwards these
 * same fields explicitly to CapabilityBroker.
 */
export function withCapabilityInferenceProvenanceV1<T>(
  input: CapabilityInferenceProvenanceV1,
  work: () => Promise<T>,
): Promise<T> {
  validate(input);
  return work();
}
