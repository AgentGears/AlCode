import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestOf } from "@alcode/context";
import { asSessionId, asWorkspaceId, mkEventId, uuidv7 } from "@alcode/events";
import { openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { HostRuntime } from "./host.ts";
import {
  InferenceProvenanceControlError,
  InferenceProvenanceServiceV1,
  type InferenceEpochAuthorizationInputV1,
} from "./inference-provenance.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function providerDescriptor(provider: string, model: string) {
  const semanticConfig = provider === "anthropic"
    ? { temperature: 0, maxTokens: 1024 }
    : { deterministic: true, fixtureVersion: 1 };
  return {
    provider,
    model,
    adapter: provider === "anthropic" ? "alcode-anthropic" : "alcode-deterministic-fixture",
    adapterVersion: 1,
    semanticConfig,
    semanticConfigDigest: digestOf(semanticConfig),
  };
}

function authorization(
  sessionId: string,
  connectionGenerationId: string,
  contextReceiptId: string,
  provider: string,
): InferenceEpochAuthorizationInputV1 {
  return {
    sessionId,
    connectionGenerationId,
    contextReceiptId,
    sourceEventSequence: 7,
    providerDescriptor: providerDescriptor(
      provider,
      provider === "anthropic" ? "claude-fixture" : "deterministic-model-v1",
    ),
    capabilityCatalogDigest: `catalog-${contextReceiptId}`,
    capabilityBindingSnapshot: [
      { toolName: "inspect", binding: { kind: "static" } },
      { toolName: "dynamic.inspect", binding: { kind: "dynamic", revision: `rev-${contextReceiptId}` } },
    ],
  };
}

describeLocked("A2 inference provenance", () => {
  let dir: string;
  let locked: LockedWorkspaceStore | null;
  let workspaceId: ReturnType<typeof asWorkspaceId>;
  let repositoryId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-a2-inference-"));
    locked = null;
    workspaceId = asWorkspaceId(uuidv7());
    repositoryId = uuidv7();
  });

  afterEach(() => {
    try { locked?.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  async function openStore(): Promise<LockedWorkspaceStore> {
    return openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId,
      repositoryId,
    });
  }

  it("mints fresh epochs, preserves provider uncertainty honestly, and rebuilds exactly from canonical events", async () => {
    locked = await openStore();
    const admission = new CanonicalAdmissionQueue(locked.store);
    const service = new InferenceProvenanceServiceV1(locked.store, admission);
    const sessionId = uuidv7();

    const first = await service.authorize(authorization(sessionId, "generation-a", "receipt-1", "anthropic"));
    const second = await service.authorize(authorization(sessionId, "generation-a", "receipt-2", "fixture-provider"));
    expect(second.inferenceEpochId).not.toBe(first.inferenceEpochId);

    await service.prepare({
      inferenceEpochId: first.inferenceEpochId,
      sessionId,
      connectionGenerationId: "generation-a",
    });
    expect((await service.get(first.inferenceEpochId))?.invocationState).toBe("prepared_indeterminate");

    await service.terminal({
      inferenceEpochId: first.inferenceEpochId,
      sessionId,
      connectionGenerationId: "generation-a",
      outcome: "provider_error",
      stopReason: "error",
    });
    const terminalWithoutObservation = await service.get(first.inferenceEpochId);
    expect(terminalWithoutObservation).toMatchObject({
      invocationState: "prepared_indeterminate",
      terminalOutcome: "provider_error",
    });
    expect(terminalWithoutObservation?.providerObservation).toBeUndefined();

    await service.prepare({
      inferenceEpochId: second.inferenceEpochId,
      sessionId,
      connectionGenerationId: "generation-a",
    });
    await service.terminal({
      inferenceEpochId: second.inferenceEpochId,
      sessionId,
      connectionGenerationId: "generation-a",
      outcome: "completed",
      providerObservation: { requestId: "fixture-request-1", responseId: "fixture-response-1" },
    });
    expect((await service.get(second.inferenceEpochId))?.invocationState).toBe("response_observed");

    const beforeRestart = await service.list();
    locked.close();
    locked = null;

    locked = await openStore();
    const rebuilt = new InferenceProvenanceServiceV1(
      locked.store,
      new CanonicalAdmissionQueue(locked.store),
    );
    expect(await rebuilt.list()).toEqual(beforeRestart);
  });

  it("keeps replacement a causal cut and rejects historical or wrong-generation epochs", async () => {
    locked = await openStore();
    const service = new InferenceProvenanceServiceV1(
      locked.store,
      new CanonicalAdmissionQueue(locked.store),
    );
    const sessionId = uuidv7();
    const authorized = await service.authorize(
      authorization(sessionId, "generation-old", "receipt-replaced", "anthropic"),
    );
    await service.prepare({
      inferenceEpochId: authorized.inferenceEpochId,
      sessionId,
      connectionGenerationId: "generation-old",
    });

    await expect(service.requireCurrentEpoch({
      inferenceEpochId: authorized.inferenceEpochId,
      sessionId,
      connectionGenerationId: "generation-new",
      requirePrepared: true,
    })).rejects.toBeInstanceOf(InferenceProvenanceControlError);

    await service.interruptGeneration(sessionId, "generation-old");
    expect((await service.get(authorized.inferenceEpochId))?.invocationState)
      .toBe("interrupted_indeterminate");
    await expect(service.requireCurrentEpoch({
      inferenceEpochId: authorized.inferenceEpochId,
      sessionId,
      connectionGenerationId: "generation-old",
      requirePrepared: true,
    })).rejects.toBeInstanceOf(InferenceProvenanceControlError);
  });

  it("rejects secret-bearing provider semantic configuration", async () => {
    locked = await openStore();
    const service = new InferenceProvenanceServiceV1(
      locked.store,
      new CanonicalAdmissionQueue(locked.store),
    );
    const semanticConfig = { apiKey: "must-never-be-canonical" };
    const input = authorization(uuidv7(), "generation-a", "receipt-secret", "anthropic");
    input.providerDescriptor = {
      ...input.providerDescriptor,
      semanticConfig,
      semanticConfigDigest: digestOf(semanticConfig),
    };
    await expect(service.authorize(input)).rejects.toThrow(/Forbidden provider semantic configuration key/);
  });

  it("persists direct and Code Mode causal tuples on operation.requested without attributing Host-only work", async () => {
    locked = await openStore();
    const host = new HostRuntime({
      store: locked,
      capabilities: [{
        name: "inspect",
        description: "A2 deterministic read-only capability",
        workspaceAccessClass: "read_only",
        async execute(args) {
          return { result: { args: structuredClone(args) } };
        },
      }],
    });
    await host.startup();
    const session = await host.openOrResumeSession();

    const direct = await host.capabilityBroker.execute({
      sessionId: session.sessionId,
      toolCallId: "tool-direct",
      toolName: "inspect",
      args: { path: "direct" },
      inferenceEpochId: "epoch-model-1",
    });
    expect(direct.outcome).toBe("succeeded");

    const nested = await host.capabilityBroker.execute({
      sessionId: session.sessionId,
      toolCallId: "opaque-nested-tool-id",
      toolName: "inspect",
      args: { path: "nested" },
      inferenceEpochId: "epoch-model-1",
      parentToolCallId: "outer-run-code",
      localSubcallIndex: 2,
    });
    expect(nested.outcome).toBe("succeeded");
    expect(nested.operationId).not.toBe(direct.operationId);

    const malformed = await host.capabilityBroker.execute({
      sessionId: session.sessionId,
      toolCallId: "malformed",
      toolName: "inspect",
      args: {},
      inferenceEpochId: "epoch-model-1",
      parentToolCallId: "outer-run-code",
    });
    expect(malformed).toMatchObject({
      outcome: "denied",
      errorCode: "inference_provenance_invalid",
    });

    const hostOnly = await host.capabilityBroker.execute({
      sessionId: session.sessionId,
      toolCallId: "host-verifier-like-work",
      toolName: "inspect",
      args: { path: "host-only" },
    });
    expect(hostOnly.outcome).toBe("succeeded");

    const requested: Array<Record<string, unknown>> = [];
    for await (const event of locked.store.replay()) {
      if (event.type === "operation.requested") requested.push(record(event.payload));
    }
    expect(requested).toHaveLength(3);
    expect(requested[0]).toMatchObject({
      operationId: direct.operationId,
      toolCallId: "tool-direct",
      inferenceEpochId: "epoch-model-1",
    });
    expect(requested[1]).toMatchObject({
      operationId: nested.operationId,
      toolCallId: "opaque-nested-tool-id",
      inferenceEpochId: "epoch-model-1",
      parentToolCallId: "outer-run-code",
      localSubcallIndex: 2,
    });
    expect(requested[2]).toMatchObject({
      operationId: hostOnly.operationId,
      toolCallId: "host-verifier-like-work",
    });
    expect(requested[2]).not.toHaveProperty("inferenceEpochId");
    expect(requested.some((payload) => payload.toolCallId === "malformed")).toBe(false);
  });

  it("marks durable assistant evidence as response-observed only after a prepared epoch", async () => {
    locked = await openStore();
    const service = new InferenceProvenanceServiceV1(
      locked.store,
      new CanonicalAdmissionQueue(locked.store),
    );
    const sessionId = uuidv7();
    const authorized = await service.authorize(
      authorization(sessionId, "generation-a", "receipt-assistant", "anthropic"),
    );
    await service.prepare({
      inferenceEpochId: authorized.inferenceEpochId,
      sessionId,
      connectionGenerationId: "generation-a",
    });

    await locked.store.append([{
      eventId: mkEventId(),
      workspaceId,
      sessionId: asSessionId(sessionId),
      occurredAt: new Date().toISOString(),
      type: "assistant.message.appended",
      payload: {
        inferenceEpochId: authorized.inferenceEpochId,
        text: "observed assistant output",
      },
      payloadSchemaVersion: 1,
      producer: { kind: "model", component: "a2-test" },
    }]);

    expect((await service.get(authorized.inferenceEpochId))?.invocationState).toBe("response_observed");
  });
});
