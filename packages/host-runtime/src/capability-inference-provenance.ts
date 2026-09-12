import { AsyncLocalStorage } from "node:async_hooks";
import type { EventDraft } from "@alcode/events";
import type { WorkspaceEventStore } from "@alcode/storage";
import { CapabilityBroker, type CapabilityBrokerRequest } from "./capability-broker.ts";

declare module "./capability-broker.ts" {
  interface CapabilityBrokerRequest {
    inferenceEpochId?: string;
    parentToolCallId?: string;
    localSubcallIndex?: number;
  }
}

export interface CapabilityInferenceProvenanceV1 {
  toolCallId: string;
  inferenceEpochId?: string;
  parentToolCallId?: string;
  localSubcallIndex?: number;
}

const correlation = new AsyncLocalStorage<CapabilityInferenceProvenanceV1>();
const installedStores = new WeakSet<object>();
const BROKER_PATCH = Symbol.for("alcode.a2.capability-inference-provenance.v1");

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

function withCorrelation(
  draft: EventDraft<string, unknown>,
  current: CapabilityInferenceProvenanceV1,
): EventDraft<string, unknown> {
  if (draft.type !== "operation.requested") return draft;
  const payload = typeof draft.payload === "object" && draft.payload !== null && !Array.isArray(draft.payload)
    ? draft.payload as Record<string, unknown>
    : {};
  for (const [key, expected] of Object.entries(current)) {
    if (expected === undefined) continue;
    const existing = payload[key];
    if (existing !== undefined && existing !== expected) {
      throw new Error(`operation.requested provenance conflict for ${key}`);
    }
  }
  return {
    ...draft,
    payload: {
      ...payload,
      toolCallId: current.toolCallId,
      ...(current.inferenceEpochId !== undefined ? { inferenceEpochId: current.inferenceEpochId } : {}),
      ...(current.parentToolCallId !== undefined ? { parentToolCallId: current.parentToolCallId } : {}),
      ...(current.localSubcallIndex !== undefined ? { localSubcallIndex: current.localSubcallIndex } : {}),
    },
  };
}

/**
 * Install one Host-owned append interceptor on the canonical Workspace store.
 * It is inert outside a broker execution scope. Because Program routing and the
 * broker share this exact store object, the same correlation is persisted for
 * ordinary and Program-linked Operations without granting execution authority.
 */
export function installCapabilityInferenceProvenanceV1(store: WorkspaceEventStore): void {
  if (installedStores.has(store as object)) return;
  installedStores.add(store as object);
  const append = store.append.bind(store);
  store.append = ((drafts: EventDraft<string, unknown>[]) => {
    const current = correlation.getStore();
    return append(current === undefined
      ? drafts
      : drafts.map((draft) => withCorrelation(draft, current)));
  }) as WorkspaceEventStore["append"];
}

export function withCapabilityInferenceProvenanceV1<T>(
  input: CapabilityInferenceProvenanceV1,
  work: () => Promise<T>,
): Promise<T> {
  return correlation.run(validate(input), work);
}

/**
 * CapabilityBroker already owns execution/admission. This patch only binds its
 * existing request correlation to the canonical append interval. It neither
 * authorizes the request nor changes Operation/effect settlement semantics.
 */
function installBrokerScopeV1(): void {
  const prototype = CapabilityBroker.prototype as unknown as Record<PropertyKey, unknown>;
  if (prototype[BROKER_PATCH] === true) return;
  const original = CapabilityBroker.prototype.execute;
  Object.defineProperty(prototype, BROKER_PATCH, { value: true, configurable: false });
  CapabilityBroker.prototype.execute = function executeWithInferenceProvenance(
    request: CapabilityBrokerRequest,
  ) {
    return withCapabilityInferenceProvenanceV1({
      toolCallId: request.toolCallId,
      ...(request.inferenceEpochId !== undefined ? { inferenceEpochId: request.inferenceEpochId } : {}),
      ...(request.parentToolCallId !== undefined ? { parentToolCallId: request.parentToolCallId } : {}),
      ...(request.localSubcallIndex !== undefined ? { localSubcallIndex: request.localSubcallIndex } : {}),
    }, () => original.call(this, request));
  };
}

installBrokerScopeV1();
