import {
  INFERENCE_PROVIDER_DESCRIPTOR_MAX_BYTES,
  INFERENCE_PROVIDER_ID_MAX_BYTES,
  INFERENCE_PROVIDER_OBSERVATION_ID_MAX_BYTES,
  type CapabilityBinding,
  type InferenceProviderDescriptorV1,
  type InferenceProviderObservationV1,
  type InferenceTerminalOutcomeV1,
  type ProgramAttemptAuthorityAny,
  type ProgramAttemptExecutionBaseV1,
} from "@alcode/agent-protocol";
import { digestOf } from "@alcode/context";
import {
  asSessionId,
  asWorkspaceId,
  mkEventId,
  uuidv7,
  type EventDraft,
  type PersistedDomainEvent,
  type SessionId,
} from "@alcode/events";
import type { WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";

const encoder = new TextEncoder();
const FORBIDDEN_PROVIDER_CONFIG_KEY = /(api.?key|authorization|credential|password|secret|access.?token|refresh.?token)/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface InferenceCapabilityBindingSnapshotEntryV1 {
  toolName: string;
  binding: CapabilityBinding;
}

export interface InferenceEpochAuthorizationInputV1 {
  sessionId: string;
  connectionGenerationId: string;
  contextReceiptId: string;
  sourceEventSequence: number;
  providerDescriptor: InferenceProviderDescriptorV1;
  capabilityCatalogDigest: string;
  capabilityBindingSnapshot: readonly InferenceCapabilityBindingSnapshotEntryV1[];
  programAttemptAuthority?: ProgramAttemptAuthorityAny;
  executionBase?: ProgramAttemptExecutionBaseV1;
}

export interface InferenceEpochAuthorizationV1 {
  inferenceEpochId: string;
  capabilityBindingSnapshotDigest: string;
}

export type InferenceEpochInvocationStateV1 =
  | "authorized"
  | "prepared_indeterminate"
  | "response_observed"
  | "interrupted_indeterminate";

export interface InferenceEpochProjectionV1 {
  inferenceEpochId: string;
  sessionId: string;
  connectionGenerationId: string;
  contextReceiptId: string;
  sourceEventSequence: number;
  providerDescriptor: InferenceProviderDescriptorV1;
  capabilityCatalogDigest: string;
  capabilityBindingSnapshotDigest: string;
  capabilityBindingSnapshot: InferenceCapabilityBindingSnapshotEntryV1[];
  programAttemptAuthority?: ProgramAttemptAuthorityAny;
  executionBase?: ProgramAttemptExecutionBaseV1;
  invocationState: InferenceEpochInvocationStateV1;
  preparedAt?: string;
  providerObservation?: InferenceProviderObservationV1;
  terminalOutcome?: InferenceTerminalOutcomeV1;
  stopReason?: string;
  terminalAt?: string;
  interruptedAt?: string;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedNonEmpty(value: string, maxBytes: number): boolean {
  return value.length > 0 && encoder.encode(value).byteLength <= maxBytes;
}

function validateProviderDescriptor(descriptor: InferenceProviderDescriptorV1): void {
  if (!boundedNonEmpty(descriptor.provider, INFERENCE_PROVIDER_ID_MAX_BYTES)
      || !boundedNonEmpty(descriptor.model, INFERENCE_PROVIDER_ID_MAX_BYTES)
      || !boundedNonEmpty(descriptor.adapter, INFERENCE_PROVIDER_ID_MAX_BYTES)
      || !Number.isSafeInteger(descriptor.adapterVersion)
      || descriptor.adapterVersion <= 0
      || !SHA256_HEX.test(descriptor.semanticConfigDigest)
      || encoder.encode(JSON.stringify(descriptor)).byteLength > INFERENCE_PROVIDER_DESCRIPTOR_MAX_BYTES) {
    throw new Error("Invalid or oversized inference provider descriptor");
  }
  for (const [key, value] of Object.entries(descriptor.semanticConfig)) {
    if (!boundedNonEmpty(key, INFERENCE_PROVIDER_ID_MAX_BYTES) || FORBIDDEN_PROVIDER_CONFIG_KEY.test(key)) {
      throw new Error(`Forbidden provider semantic configuration key: ${key || "<empty>"}`);
    }
    if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`Invalid provider semantic configuration value for ${key}`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`Non-finite provider semantic configuration value for ${key}`);
    }
    if (typeof value === "string" && encoder.encode(value).byteLength > INFERENCE_PROVIDER_ID_MAX_BYTES) {
      throw new Error(`Oversized provider semantic configuration value for ${key}`);
    }
  }
  if (digestOf(descriptor.semanticConfig) !== descriptor.semanticConfigDigest) {
    throw new Error("Provider semantic configuration digest mismatch");
  }
}

function validateObservation(observation: InferenceProviderObservationV1 | undefined): void {
  if (observation === undefined) return;
  for (const value of [observation.requestId, observation.responseId]) {
    if (value !== undefined && !boundedNonEmpty(value, INFERENCE_PROVIDER_OBSERVATION_ID_MAX_BYTES)) {
      throw new Error("Invalid or oversized provider-native provenance identifier");
    }
  }
}

function canonicalBindingSnapshot(
  input: readonly InferenceCapabilityBindingSnapshotEntryV1[],
): InferenceCapabilityBindingSnapshotEntryV1[] {
  const sorted = input
    .map((entry) => structuredClone(entry))
    .sort((left, right) => left.toolName.localeCompare(right.toolName, "en"));
  const names = new Set<string>();
  for (const entry of sorted) {
    if (!entry.toolName || names.has(entry.toolName)) throw new Error("Invalid inference capability binding snapshot");
    names.add(entry.toolName);
    if (entry.binding.kind === "dynamic" && !entry.binding.revision) {
      throw new Error("Dynamic inference binding requires a revision");
    }
  }
  return sorted;
}

async function replayAll(store: WorkspaceEventStore): Promise<PersistedDomainEvent<string, unknown>[]> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

function projectInferenceEpochs(events: readonly PersistedDomainEvent<string, unknown>[]): Map<string, InferenceEpochProjectionV1> {
  const projected = new Map<string, InferenceEpochProjectionV1>();
  for (const event of events) {
    const payload = record(event.payload);
    const inferenceEpochId = typeof payload.inferenceEpochId === "string" ? payload.inferenceEpochId : undefined;
    if (inferenceEpochId === undefined) continue;

    if (event.type === "inference.epoch.authorized") {
      if (projected.has(inferenceEpochId)) throw new Error(`Duplicate inference epoch authorization: ${inferenceEpochId}`);
      const providerDescriptor = payload.providerDescriptor as InferenceProviderDescriptorV1;
      const capabilityBindingSnapshot = payload.capabilityBindingSnapshot as InferenceCapabilityBindingSnapshotEntryV1[];
      projected.set(inferenceEpochId, {
        inferenceEpochId,
        sessionId: String(event.sessionId ?? payload.sessionId ?? ""),
        connectionGenerationId: String(payload.connectionGenerationId ?? ""),
        contextReceiptId: String(payload.contextReceiptId ?? ""),
        sourceEventSequence: Number(payload.sourceEventSequence),
        providerDescriptor: structuredClone(providerDescriptor),
        capabilityCatalogDigest: String(payload.capabilityCatalogDigest ?? ""),
        capabilityBindingSnapshotDigest: String(payload.capabilityBindingSnapshotDigest ?? ""),
        capabilityBindingSnapshot: structuredClone(capabilityBindingSnapshot ?? []),
        ...(payload.programAttemptAuthority !== undefined
          ? { programAttemptAuthority: structuredClone(payload.programAttemptAuthority) as ProgramAttemptAuthorityAny }
          : {}),
        ...(payload.executionBase !== undefined
          ? { executionBase: structuredClone(payload.executionBase) as ProgramAttemptExecutionBaseV1 }
          : {}),
        invocationState: "authorized",
      });
      continue;
    }

    const current = projected.get(inferenceEpochId);
    if (current === undefined) throw new Error(`Inference lifecycle event precedes authorization: ${inferenceEpochId}`);
    if (event.type === "inference.invocation.prepared") {
      if (current.preparedAt !== undefined) continue;
      current.preparedAt = event.occurredAt;
      current.invocationState = "prepared_indeterminate";
      continue;
    }
    if (event.type === "inference.epoch.terminal") {
      current.terminalOutcome = payload.outcome as InferenceTerminalOutcomeV1;
      current.terminalAt = event.occurredAt;
      if (typeof payload.stopReason === "string") current.stopReason = payload.stopReason;
      if (payload.providerObservation !== undefined) {
        current.providerObservation = structuredClone(payload.providerObservation) as InferenceProviderObservationV1;
      }
      current.invocationState = "response_observed";
      continue;
    }
    if (event.type === "inference.epoch.interrupted") {
      current.interruptedAt = event.occurredAt;
      if (current.terminalOutcome === undefined) current.invocationState = "interrupted_indeterminate";
    }
  }
  return projected;
}

export class InferenceProvenanceControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InferenceProvenanceControlError";
  }
}

/**
 * A2 provenance-only Host service. It records causal inference facts in the
 * canonical event log and deliberately exposes no capability execution API.
 */
export class InferenceProvenanceServiceV1 {
  constructor(
    private readonly store: WorkspaceEventStore,
    private readonly admission: CanonicalAdmissionQueue,
  ) {}

  async authorize(input: InferenceEpochAuthorizationInputV1): Promise<InferenceEpochAuthorizationV1> {
    validateProviderDescriptor(input.providerDescriptor);
    if (!input.sessionId || !input.connectionGenerationId || !input.contextReceiptId
        || !Number.isSafeInteger(input.sourceEventSequence) || input.sourceEventSequence < 0
        || !input.capabilityCatalogDigest) {
      throw new InferenceProvenanceControlError("Incomplete inference authorization cut");
    }
    const bindingSnapshot = canonicalBindingSnapshot(input.capabilityBindingSnapshot);
    const bindingDigest = digestOf(bindingSnapshot);
    const idempotencyKey = `inference:authorize:${input.sessionId}:${input.connectionGenerationId}:${input.contextReceiptId}`;

    return this.admission.enqueue(async () => {
      const events = await replayAll(this.store);
      const existing = events.find((event) => event.idempotencyKey === idempotencyKey);
      if (existing !== undefined) {
        const payload = record(existing.payload);
        const inferenceEpochId = String(payload.inferenceEpochId ?? "");
        if (!inferenceEpochId) throw new InferenceProvenanceControlError("Malformed persisted inference authorization");
        return {
          inferenceEpochId,
          capabilityBindingSnapshotDigest: String(payload.capabilityBindingSnapshotDigest ?? ""),
        };
      }

      const inferenceEpochId = uuidv7();
      const draft: EventDraft<string, unknown> = {
        eventId: mkEventId(),
        idempotencyKey,
        workspaceId: asWorkspaceId(this.store.workspaceId),
        sessionId: asSessionId(input.sessionId),
        occurredAt: new Date().toISOString(),
        type: "inference.epoch.authorized",
        payload: {
          inferenceEpochId,
          connectionGenerationId: input.connectionGenerationId,
          contextReceiptId: input.contextReceiptId,
          sourceEventSequence: input.sourceEventSequence,
          providerDescriptor: structuredClone(input.providerDescriptor),
          capabilityCatalogDigest: input.capabilityCatalogDigest,
          capabilityBindingSnapshotDigest: bindingDigest,
          capabilityBindingSnapshot: bindingSnapshot,
          ...(input.programAttemptAuthority !== undefined
            ? { programAttemptAuthority: structuredClone(input.programAttemptAuthority) }
            : {}),
          ...(input.executionBase !== undefined ? { executionBase: structuredClone(input.executionBase) } : {}),
        },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "host-inference-provenance" },
      };
      await this.store.append([draft]);
      return { inferenceEpochId, capabilityBindingSnapshotDigest: bindingDigest };
    });
  }

  async requireCurrentEpoch(input: {
    inferenceEpochId: string;
    sessionId: string;
    connectionGenerationId: string;
    requirePrepared?: boolean;
  }): Promise<InferenceEpochProjectionV1> {
    const epochs = projectInferenceEpochs(await replayAll(this.store));
    const epoch = epochs.get(input.inferenceEpochId);
    if (epoch === undefined
        || epoch.sessionId !== input.sessionId
        || epoch.connectionGenerationId !== input.connectionGenerationId) {
      throw new InferenceProvenanceControlError("Inference epoch does not belong to the current Session/Agent generation");
    }
    if (epoch.terminalOutcome !== undefined || epoch.interruptedAt !== undefined) {
      throw new InferenceProvenanceControlError("Inference epoch is already terminal or interrupted");
    }
    if (input.requirePrepared === true && epoch.preparedAt === undefined) {
      throw new InferenceProvenanceControlError("Inference epoch was not durably prepared");
    }
    return structuredClone(epoch);
  }

  async prepare(input: {
    inferenceEpochId: string;
    sessionId: string;
    connectionGenerationId: string;
  }): Promise<void> {
    await this.requireCurrentEpoch({ ...input, requirePrepared: false });
    const idempotencyKey = `inference:prepared:${input.inferenceEpochId}`;
    await this.admission.enqueue(async () => {
      const events = await replayAll(this.store);
      if (events.some((event) => event.idempotencyKey === idempotencyKey)) return;
      const current = projectInferenceEpochs(events).get(input.inferenceEpochId);
      if (current === undefined
          || current.sessionId !== input.sessionId
          || current.connectionGenerationId !== input.connectionGenerationId
          || current.terminalOutcome !== undefined
          || current.interruptedAt !== undefined) {
        throw new InferenceProvenanceControlError("Inference epoch became stale before prepare");
      }
      const draft: EventDraft<string, unknown> = {
        eventId: mkEventId(),
        idempotencyKey,
        workspaceId: asWorkspaceId(this.store.workspaceId),
        sessionId: asSessionId(input.sessionId),
        occurredAt: new Date().toISOString(),
        type: "inference.invocation.prepared",
        payload: { inferenceEpochId: input.inferenceEpochId },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "host-inference-provenance" },
      };
      await this.store.append([draft]);
    });
  }

  async terminal(input: {
    inferenceEpochId: string;
    sessionId: string;
    connectionGenerationId: string;
    outcome: InferenceTerminalOutcomeV1;
    stopReason?: string;
    providerObservation?: InferenceProviderObservationV1;
  }): Promise<void> {
    validateObservation(input.providerObservation);
    await this.requireCurrentEpoch({ ...input, requirePrepared: true });
    const idempotencyKey = `inference:terminal:${input.inferenceEpochId}`;
    await this.admission.enqueue(async () => {
      const events = await replayAll(this.store);
      const existing = events.find((event) => event.idempotencyKey === idempotencyKey);
      if (existing !== undefined) return;
      const current = projectInferenceEpochs(events).get(input.inferenceEpochId);
      if (current === undefined || current.preparedAt === undefined
          || current.sessionId !== input.sessionId
          || current.connectionGenerationId !== input.connectionGenerationId
          || current.interruptedAt !== undefined
          || current.terminalOutcome !== undefined) {
        throw new InferenceProvenanceControlError("Inference epoch became stale before terminal record");
      }
      const draft: EventDraft<string, unknown> = {
        eventId: mkEventId(),
        idempotencyKey,
        workspaceId: asWorkspaceId(this.store.workspaceId),
        sessionId: asSessionId(input.sessionId),
        occurredAt: new Date().toISOString(),
        type: "inference.epoch.terminal",
        payload: {
          inferenceEpochId: input.inferenceEpochId,
          outcome: input.outcome,
          ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
          ...(input.providerObservation !== undefined
            ? { providerObservation: structuredClone(input.providerObservation) }
            : {}),
        },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "host-inference-provenance" },
      };
      await this.store.append([draft]);
    });
  }

  async interruptGeneration(sessionId: string, connectionGenerationId: string): Promise<void> {
    await this.admission.enqueue(async () => {
      const events = await replayAll(this.store);
      const epochs = projectInferenceEpochs(events);
      const drafts: EventDraft<string, unknown>[] = [];
      for (const epoch of epochs.values()) {
        if (epoch.sessionId !== sessionId
            || epoch.connectionGenerationId !== connectionGenerationId
            || epoch.terminalOutcome !== undefined
            || epoch.interruptedAt !== undefined) continue;
        drafts.push({
          eventId: mkEventId(),
          idempotencyKey: `inference:interrupted:${epoch.inferenceEpochId}`,
          workspaceId: asWorkspaceId(this.store.workspaceId),
          sessionId: asSessionId(sessionId),
          occurredAt: new Date().toISOString(),
          type: "inference.epoch.interrupted",
          payload: { inferenceEpochId: epoch.inferenceEpochId },
          payloadSchemaVersion: 1,
          producer: { kind: "runtime", component: "host-inference-provenance" },
        });
      }
      if (drafts.length > 0) await this.store.append(drafts);
    });
  }

  async get(inferenceEpochId: string): Promise<InferenceEpochProjectionV1 | undefined> {
    return structuredClone(projectInferenceEpochs(await replayAll(this.store)).get(inferenceEpochId));
  }

  async list(): Promise<InferenceEpochProjectionV1[]> {
    return [...projectInferenceEpochs(await replayAll(this.store)).values()]
      .map((epoch) => structuredClone(epoch))
      .sort((left, right) => left.inferenceEpochId.localeCompare(right.inferenceEpochId, "en"));
  }
}
