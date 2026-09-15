import type { WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import {
  InferenceProvenanceServiceV1,
  type InferenceEpochProjectionV1,
} from "./inference-provenance.ts";

export interface InferenceOperationCallProjectionV1 {
  toolCallId: string;
  toolName: string;
  operationId: string;
  parentToolCallId?: string;
  localSubcallIndex?: number;
}

export interface ReconstructableInferenceEpochV1 extends InferenceEpochProjectionV1 {
  assistantEventId?: string;
  calls: InferenceOperationCallProjectionV1[];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Rebuild the complete A2 causal projection from canonical Workspace events.
 * This is read-only reconstruction: it cannot execute a capability, renew a
 * binding, revive an Agent generation, or otherwise mint authority.
 */
export async function reconstructInferenceProvenanceV1(
  store: WorkspaceEventStore,
): Promise<ReconstructableInferenceEpochV1[]> {
  const lifecycle = new InferenceProvenanceServiceV1(
    store,
    new CanonicalAdmissionQueue(store),
  );
  const epochs = (await lifecycle.list()).map((epoch) => ({
    ...epoch,
    calls: [] as InferenceOperationCallProjectionV1[],
  }));
  const byId = new Map(epochs.map((epoch) => [epoch.inferenceEpochId, epoch]));

  for await (const event of store.replay()) {
    const payload = record(event.payload);
    const inferenceEpochId = nonEmptyString(payload.inferenceEpochId)
      ? payload.inferenceEpochId
      : undefined;
    if (inferenceEpochId === undefined) continue;

    const epoch = byId.get(inferenceEpochId);
    if (event.type === "assistant.message.appended") {
      if (epoch === undefined) {
        throw new Error(`Inference-bound assistant event references unknown epoch: ${inferenceEpochId}`);
      }
      if (event.sessionId !== undefined && String(event.sessionId) !== epoch.sessionId) {
        throw new Error(`Inference-bound assistant event session mismatch: ${inferenceEpochId}`);
      }
      const eventId = String(event.eventId);
      if (epoch.assistantEventId !== undefined && epoch.assistantEventId !== eventId) {
        throw new Error(`Inference epoch has multiple durable assistant outputs: ${inferenceEpochId}`);
      }
      epoch.assistantEventId = eventId;
      continue;
    }

    if (event.type !== "operation.requested") continue;
    if (epoch === undefined) {
      throw new Error(`Inference-bound Operation references unknown epoch: ${inferenceEpochId}`);
    }
    if (event.sessionId !== undefined && String(event.sessionId) !== epoch.sessionId) {
      throw new Error(`Inference-bound Operation session mismatch: ${inferenceEpochId}`);
    }
    if (!nonEmptyString(payload.operationId)
        || !nonEmptyString(payload.toolCallId)
        || !nonEmptyString(payload.toolName)) {
      throw new Error(`Malformed inference-bound operation.requested event: ${String(event.eventId)}`);
    }

    const hasParent = payload.parentToolCallId !== undefined;
    const hasIndex = payload.localSubcallIndex !== undefined;
    if (hasParent !== hasIndex
        || (hasParent && !nonEmptyString(payload.parentToolCallId))
        || (hasIndex && (!Number.isSafeInteger(payload.localSubcallIndex)
          || Number(payload.localSubcallIndex) < 0))) {
      throw new Error(`Malformed Code Mode lineage on operation.requested event: ${String(event.eventId)}`);
    }

    epoch.calls.push({
      operationId: payload.operationId,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      ...(hasParent ? { parentToolCallId: payload.parentToolCallId as string } : {}),
      ...(hasIndex ? { localSubcallIndex: Number(payload.localSubcallIndex) } : {}),
    });
  }

  return epochs.sort((left, right) => left.inferenceEpochId.localeCompare(right.inferenceEpochId, "en"));
}
