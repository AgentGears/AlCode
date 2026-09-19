import { digestOf } from "@alcode/context";
import {
  asSessionId,
  asWorkspaceId,
  mkEventId,
  uuidv7,
  type EventDraft,
  type PersistedDomainEvent,
} from "@alcode/events";
import type { WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";

const encoder = new TextEncoder();
const SHA256_HEX = /^[0-9a-f]{64}$/;
const FORBIDDEN_SEMANTIC_KEY = /(api.?key|authorization|credential|password|secret|access.?token|refresh.?token|private.?key)/i;
const MAX_IDENTIFIER_BYTES = 512;
const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const MAX_EVIDENCE_BYTES = 2 * 1024;
const MAX_SEMANTIC_DEPTH = 8;

export type ExecutionSemanticValueV1 =
  | null
  | boolean
  | number
  | string
  | ExecutionSemanticValueV1[]
  | { [key: string]: ExecutionSemanticValueV1 };

export interface ExecutionProviderDescriptorV1 {
  providerKind: string;
  adapter: string;
  adapterVersion: number;
  semanticConfig: { [key: string]: ExecutionSemanticValueV1 };
}

export interface ExecutionContainmentPolicyDescriptorV1 {
  profile: string;
  semanticConfig: { [key: string]: ExecutionSemanticValueV1 };
}

export interface ExecutionWorldIdentityV1 {
  workspaceId: string;
  providerKind: string;
  executionWorldGenerationId: string;
  providerDescriptorDigest: string;
  effectivePolicyDigest: string;
}

export interface ExecutionWorldActivationEvidenceV1 {
  readinessEvidenceDigest: string;
  providerNativeInstanceId?: string;
}

export interface ExecutionWorldClosureEvidenceV1 {
  closureEvidenceDigest: string;
  bindingUnavailable: true;
  providerNativeInstanceId?: string;
}

export type ExecutionWorldLifecycleStateV1 =
  | "prepared"
  | "active"
  | "retiring"
  | "closed"
  | "lost_or_unknown";

export interface ExecutionWorldProjectionV1 {
  identity: ExecutionWorldIdentityV1;
  providerDescriptor: ExecutionProviderDescriptorV1;
  effectivePolicy: ExecutionContainmentPolicyDescriptorV1;
  activationRequestId: string;
  lifecycleSessionId: string;
  state: ExecutionWorldLifecycleStateV1;
  isCurrent: boolean;
  preparedAt: string;
  activatedAt?: string;
  activationEvidence?: ExecutionWorldActivationEvidenceV1;
  retirementRequestedAt?: string;
  closedAt?: string;
  closureEvidence?: ExecutionWorldClosureEvidenceV1;
  lostAt?: string;
  lostReasonCode?: string;
}

export interface ExecutionWorldProjectionSetV1 {
  currentGenerationId: string | undefined;
  generations: Map<string, ExecutionWorldProjectionV1>;
}

export interface PrepareExecutionWorldActivationInputV1 {
  activationRequestId: string;
  workspaceId: string;
  sessionId: string;
  providerDescriptor: ExecutionProviderDescriptorV1;
  effectivePolicy: ExecutionContainmentPolicyDescriptorV1;
}

export interface ExecutionWorldOperationProvenanceV1 {
  workspaceId: string;
  providerKind: string;
  executionWorldGenerationId: string;
  providerDescriptorDigest: string;
  effectivePolicyDigest: string;
}

export interface ExecutionWorldCurrentnessGuardV1 {
  assertCurrent(): void;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedNonEmpty(value: string, maxBytes = MAX_IDENTIFIER_BYTES): boolean {
  return value.length > 0 && encoder.encode(value).byteLength <= maxBytes;
}

function validateSemanticValue(value: ExecutionSemanticValueV1, depth: number): void {
  if (depth > MAX_SEMANTIC_DEPTH) throw new ExecutionWorldControlError("Execution semantic configuration is too deeply nested");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ExecutionWorldControlError("Execution semantic configuration contains a non-finite number");
    return;
  }
  if (typeof value === "string") {
    if (encoder.encode(value).byteLength > MAX_DESCRIPTOR_BYTES) {
      throw new ExecutionWorldControlError("Execution semantic configuration contains an oversized string");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) validateSemanticValue(entry, depth + 1);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!boundedNonEmpty(key) || FORBIDDEN_SEMANTIC_KEY.test(key)) {
      throw new ExecutionWorldControlError(`Forbidden execution semantic configuration key: ${key || "<empty>"}`);
    }
    validateSemanticValue(entry, depth + 1);
  }
}

function validateProviderDescriptor(descriptor: ExecutionProviderDescriptorV1): void {
  if (!boundedNonEmpty(descriptor.providerKind)
      || !boundedNonEmpty(descriptor.adapter)
      || !Number.isSafeInteger(descriptor.adapterVersion)
      || descriptor.adapterVersion <= 0) {
    throw new ExecutionWorldControlError("Invalid execution provider descriptor");
  }
  validateSemanticValue(descriptor.semanticConfig, 0);
  if (encoder.encode(JSON.stringify(descriptor)).byteLength > MAX_DESCRIPTOR_BYTES) {
    throw new ExecutionWorldControlError("Execution provider descriptor is oversized");
  }
}

function validatePolicy(policy: ExecutionContainmentPolicyDescriptorV1): void {
  if (!boundedNonEmpty(policy.profile)) throw new ExecutionWorldControlError("Invalid execution containment profile");
  validateSemanticValue(policy.semanticConfig, 0);
  if (encoder.encode(JSON.stringify(policy)).byteLength > MAX_DESCRIPTOR_BYTES) {
    throw new ExecutionWorldControlError("Execution containment policy descriptor is oversized");
  }
}

function validateDigest(value: string, label: string): void {
  if (!SHA256_HEX.test(value)) throw new ExecutionWorldControlError(`Invalid ${label} digest`);
}

function validateNativeId(value: string | undefined): void {
  if (value !== undefined && !boundedNonEmpty(value, MAX_EVIDENCE_BYTES)) {
    throw new ExecutionWorldControlError("Invalid or oversized provider-native execution-world identifier");
  }
}

function activationEvidenceMatches(
  value: unknown,
  expected: ExecutionWorldActivationEvidenceV1,
): boolean {
  const actual = record(value);
  return actual.readinessEvidenceDigest === expected.readinessEvidenceDigest
    && actual.providerNativeInstanceId === expected.providerNativeInstanceId;
}

function closureEvidenceMatches(
  value: unknown,
  expected: ExecutionWorldClosureEvidenceV1,
): boolean {
  const actual = record(value);
  return actual.closureEvidenceDigest === expected.closureEvidenceDigest
    && actual.bindingUnavailable === true
    && actual.providerNativeInstanceId === expected.providerNativeInstanceId;
}

function providerDescriptorDigest(descriptor: ExecutionProviderDescriptorV1): string {
  return digestOf(descriptor);
}

function effectivePolicyDigest(policy: ExecutionContainmentPolicyDescriptorV1): string {
  return digestOf(policy);
}

async function replayAll(store: WorkspaceEventStore): Promise<PersistedDomainEvent<string, unknown>[]> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

export function projectExecutionWorldsV1(
  events: readonly PersistedDomainEvent<string, unknown>[],
): ExecutionWorldProjectionSetV1 {
  const generations = new Map<string, ExecutionWorldProjectionV1>();
  let currentGenerationId: string | undefined;

  for (const event of events) {
    const payload = record(event.payload);
    const generationId = typeof payload.executionWorldGenerationId === "string"
      ? payload.executionWorldGenerationId
      : undefined;
    if (generationId === undefined) continue;

    if (event.type === "execution.world.activation.prepared") {
      if (generations.has(generationId)) {
        throw new ExecutionWorldControlError(`Duplicate execution-world generation: ${generationId}`);
      }
      const identity = structuredClone(payload.identity) as ExecutionWorldIdentityV1;
      if (identity.executionWorldGenerationId !== generationId) {
        throw new ExecutionWorldControlError(`Malformed execution-world identity: ${generationId}`);
      }
      generations.set(generationId, {
        identity,
        providerDescriptor: structuredClone(payload.providerDescriptor) as ExecutionProviderDescriptorV1,
        effectivePolicy: structuredClone(payload.effectivePolicy) as ExecutionContainmentPolicyDescriptorV1,
        activationRequestId: String(payload.activationRequestId ?? ""),
        lifecycleSessionId: String(event.sessionId),
        state: "prepared",
        isCurrent: false,
        preparedAt: event.occurredAt,
      });
      continue;
    }

    const generation = generations.get(generationId);
    if (generation === undefined) {
      throw new ExecutionWorldControlError(`Execution-world lifecycle event precedes preparation: ${generationId}`);
    }

    if (event.type === "execution.world.activation.observed") {
      generation.state = "active";
      generation.activatedAt = event.occurredAt;
      generation.activationEvidence = structuredClone(payload.evidence) as ExecutionWorldActivationEvidenceV1;
      currentGenerationId = generationId;
      continue;
    }
    if (event.type === "execution.world.retirement.requested") {
      generation.state = "retiring";
      generation.retirementRequestedAt ??= event.occurredAt;
      if (currentGenerationId === generationId) currentGenerationId = undefined;
      continue;
    }
    if (event.type === "execution.world.closure.observed") {
      generation.state = "closed";
      generation.closedAt = event.occurredAt;
      generation.closureEvidence = structuredClone(payload.evidence) as ExecutionWorldClosureEvidenceV1;
      if (currentGenerationId === generationId) currentGenerationId = undefined;
      continue;
    }
    if (event.type === "execution.world.lost") {
      generation.state = "lost_or_unknown";
      generation.lostAt ??= event.occurredAt;
      generation.lostReasonCode = String(payload.reasonCode ?? "unknown");
      if (currentGenerationId === generationId) currentGenerationId = undefined;
    }
  }

  for (const generation of generations.values()) {
    generation.isCurrent = generation.identity.executionWorldGenerationId === currentGenerationId
      && generation.state === "active";
  }
  return { currentGenerationId, generations };
}

export class ExecutionWorldControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionWorldControlError";
  }
}

/** Host-owned A5 execution-world identity/lifecycle authority. */
export class ExecutionWorldServiceV1 {
  constructor(
    private readonly store: WorkspaceEventStore,
    private readonly admission: CanonicalAdmissionQueue,
  ) {}

  async prepareActivation(input: PrepareExecutionWorldActivationInputV1): Promise<ExecutionWorldIdentityV1> {
    if (!boundedNonEmpty(input.activationRequestId) || !boundedNonEmpty(input.sessionId)) {
      throw new ExecutionWorldControlError("Activation request and lifecycle Session identities are required");
    }
    if (input.workspaceId !== String(this.store.workspaceId)) {
      throw new ExecutionWorldControlError("Execution-world Workspace does not match the canonical store");
    }
    validateProviderDescriptor(input.providerDescriptor);
    validatePolicy(input.effectivePolicy);
    const descriptorDigest = providerDescriptorDigest(input.providerDescriptor);
    const policyDigest = effectivePolicyDigest(input.effectivePolicy);
    const idempotencyKey = `execution-world:activation:prepare:${input.activationRequestId}`;

    return this.admission.enqueue(async () => {
      const events = await replayAll(this.store);
      const existing = events.find((event) => event.idempotencyKey === idempotencyKey);
      if (existing !== undefined) {
        const payload = record(existing.payload);
        const identity = structuredClone(payload.identity) as ExecutionWorldIdentityV1;
        if (identity.workspaceId !== input.workspaceId
            || String(existing.sessionId) !== input.sessionId
            || identity.providerKind !== input.providerDescriptor.providerKind
            || identity.providerDescriptorDigest !== descriptorDigest
            || identity.effectivePolicyDigest !== policyDigest) {
          throw new ExecutionWorldControlError("Activation request identity was reused with different execution semantics");
        }
        return identity;
      }

      const executionWorldGenerationId = uuidv7();
      const identity: ExecutionWorldIdentityV1 = {
        workspaceId: input.workspaceId,
        providerKind: input.providerDescriptor.providerKind,
        executionWorldGenerationId,
        providerDescriptorDigest: descriptorDigest,
        effectivePolicyDigest: policyDigest,
      };
      const draft: EventDraft<string, unknown> = {
        eventId: mkEventId(),
        idempotencyKey,
        workspaceId: asWorkspaceId(this.store.workspaceId),
        sessionId: asSessionId(input.sessionId),
        occurredAt: new Date().toISOString(),
        type: "execution.world.activation.prepared",
        payload: {
          executionWorldGenerationId,
          activationRequestId: input.activationRequestId,
          identity,
          providerDescriptor: structuredClone(input.providerDescriptor),
          effectivePolicy: structuredClone(input.effectivePolicy),
        },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "host-execution-world" },
      };
      await this.store.append([draft]);
      return structuredClone(identity);
    });
  }

  async observeActivation(input: {
    executionWorldGenerationId: string;
    evidence: ExecutionWorldActivationEvidenceV1;
    guard?: ExecutionWorldCurrentnessGuardV1;
  }): Promise<ExecutionWorldProjectionV1> {
    validateDigest(input.evidence.readinessEvidenceDigest, "readiness evidence");
    validateNativeId(input.evidence.providerNativeInstanceId);
    const idempotencyKey = `execution-world:activation:observed:${input.executionWorldGenerationId}`;

    await this.admission.enqueue(async () => {
      const events = await replayAll(this.store);
      const existing = events.find((event) => event.idempotencyKey === idempotencyKey);
      if (existing !== undefined) {
        const payload = record(existing.payload);
        if (!activationEvidenceMatches(payload.evidence, input.evidence)) {
          throw new ExecutionWorldControlError(
            "Execution-world activation observation was retried with different physical evidence",
          );
        }
        return;
      }
      const generation = projectExecutionWorldsV1(events).generations.get(input.executionWorldGenerationId);
      if (generation === undefined || generation.state !== "prepared") {
        throw new ExecutionWorldControlError("Execution-world activation can only be observed from prepared state");
      }
      input.guard?.assertCurrent();
      const draft: EventDraft<string, unknown> = {
        eventId: mkEventId(),
        idempotencyKey,
        workspaceId: asWorkspaceId(this.store.workspaceId),
        sessionId: asSessionId(generation.lifecycleSessionId),
        occurredAt: new Date().toISOString(),
        type: "execution.world.activation.observed",
        payload: {
          executionWorldGenerationId: input.executionWorldGenerationId,
          evidence: structuredClone(input.evidence),
        },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "host-execution-world" },
      };
      await this.store.append([draft]);
    });
    return this.requireGeneration(input.executionWorldGenerationId);
  }

  async requestRetirement(executionWorldGenerationId: string): Promise<ExecutionWorldProjectionV1> {
    const idempotencyKey = `execution-world:retirement:requested:${executionWorldGenerationId}`;
    await this.admission.enqueue(async () => {
      const events = await replayAll(this.store);
      if (events.some((event) => event.idempotencyKey === idempotencyKey)) return;
      const generation = projectExecutionWorldsV1(events).generations.get(executionWorldGenerationId);
      if (generation === undefined || generation.state !== "active") {
        throw new ExecutionWorldControlError("Only an active execution-world generation may be retired");
      }
      const draft: EventDraft<string, unknown> = {
        eventId: mkEventId(), idempotencyKey,
        workspaceId: asWorkspaceId(this.store.workspaceId),
        sessionId: asSessionId(generation.lifecycleSessionId),
        occurredAt: new Date().toISOString(),
        type: "execution.world.retirement.requested",
        payload: { executionWorldGenerationId },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "host-execution-world" },
      };
      await this.store.append([draft]);
    });
    return this.requireGeneration(executionWorldGenerationId);
  }

  async observeClosure(input: {
    executionWorldGenerationId: string;
    evidence: ExecutionWorldClosureEvidenceV1;
  }): Promise<ExecutionWorldProjectionV1> {
    validateDigest(input.evidence.closureEvidenceDigest, "closure evidence");
    validateNativeId(input.evidence.providerNativeInstanceId);
    if (input.evidence.bindingUnavailable !== true) {
      throw new ExecutionWorldControlError("Positive closure requires generation binding unavailability evidence");
    }
    const idempotencyKey = `execution-world:closure:observed:${input.executionWorldGenerationId}`;
    await this.admission.enqueue(async () => {
      const events = await replayAll(this.store);
      const existing = events.find((event) => event.idempotencyKey === idempotencyKey);
      if (existing !== undefined) {
        const payload = record(existing.payload);
        if (!closureEvidenceMatches(payload.evidence, input.evidence)) {
          throw new ExecutionWorldControlError(
            "Execution-world closure observation was retried with different physical evidence",
          );
        }
        return;
      }
      const generation = projectExecutionWorldsV1(events).generations.get(input.executionWorldGenerationId);
      if (generation === undefined || (generation.state !== "retiring" && generation.state !== "lost_or_unknown")) {
        throw new ExecutionWorldControlError("Execution-world closure requires retiring or lost/unknown state");
      }
      const draft: EventDraft<string, unknown> = {
        eventId: mkEventId(), idempotencyKey,
        workspaceId: asWorkspaceId(this.store.workspaceId),
        sessionId: asSessionId(generation.lifecycleSessionId),
        occurredAt: new Date().toISOString(),
        type: "execution.world.closure.observed",
        payload: { executionWorldGenerationId: input.executionWorldGenerationId, evidence: structuredClone(input.evidence) },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "host-execution-world" },
      };
      await this.store.append([draft]);
    });
    return this.requireGeneration(input.executionWorldGenerationId);
  }

  async markLost(input: { executionWorldGenerationId: string; reasonCode: string }): Promise<ExecutionWorldProjectionV1> {
    if (!boundedNonEmpty(input.reasonCode)) throw new ExecutionWorldControlError("Execution-world loss reason is required");
    const idempotencyKey = `execution-world:lost:${input.executionWorldGenerationId}`;
    await this.admission.enqueue(async () => {
      const events = await replayAll(this.store);
      const existing = events.find((event) => event.idempotencyKey === idempotencyKey);
      if (existing !== undefined) {
        const payload = record(existing.payload);
        if (payload.reasonCode !== input.reasonCode) {
          throw new ExecutionWorldControlError(
            "Execution-world loss was retried with a different reason",
          );
        }
        return;
      }
      const generation = projectExecutionWorldsV1(events).generations.get(input.executionWorldGenerationId);
      if (generation === undefined || generation.state === "closed") {
        throw new ExecutionWorldControlError("Unknown or already closed execution-world generation");
      }
      const draft: EventDraft<string, unknown> = {
        eventId: mkEventId(), idempotencyKey,
        workspaceId: asWorkspaceId(this.store.workspaceId),
        sessionId: asSessionId(generation.lifecycleSessionId),
        occurredAt: new Date().toISOString(),
        type: "execution.world.lost",
        payload: { executionWorldGenerationId: input.executionWorldGenerationId, reasonCode: input.reasonCode },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "host-execution-world" },
      };
      await this.store.append([draft]);
    });
    return this.requireGeneration(input.executionWorldGenerationId);
  }

  async rebuild(): Promise<ExecutionWorldProjectionSetV1> {
    return projectExecutionWorldsV1(await replayAll(this.store));
  }

  async requireGeneration(executionWorldGenerationId: string): Promise<ExecutionWorldProjectionV1> {
    const generation = (await this.rebuild()).generations.get(executionWorldGenerationId);
    if (generation === undefined) throw new ExecutionWorldControlError("Unknown execution-world generation");
    return structuredClone(generation);
  }

  async requireCurrent(executionWorldGenerationId?: string): Promise<ExecutionWorldProjectionV1> {
    const projection = await this.rebuild();
    const currentId = projection.currentGenerationId;
    if (currentId === undefined || (executionWorldGenerationId !== undefined && executionWorldGenerationId !== currentId)) {
      throw new ExecutionWorldControlError("Execution-world generation is not current");
    }
    const current = projection.generations.get(currentId);
    if (current === undefined || current.state !== "active") {
      throw new ExecutionWorldControlError("Current execution-world generation is not active");
    }
    return structuredClone(current);
  }

  async currentOperationProvenance(): Promise<ExecutionWorldOperationProvenanceV1> {
    return structuredClone((await this.requireCurrent()).identity);
  }
}
