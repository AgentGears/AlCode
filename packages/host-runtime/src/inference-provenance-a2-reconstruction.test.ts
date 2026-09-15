import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestOf } from "@alcode/context";
import { asSessionId, asWorkspaceId, mkEventId, uuidv7 } from "@alcode/events";
import { openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { HostRuntime } from "./host.ts";
import { InferenceProvenanceServiceV1 } from "./inference-provenance.ts";
import { reconstructInferenceProvenanceV1 } from "./inference-provenance-reconstruction.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

function descriptor(model: string) {
  const semanticConfig = { deterministic: true, modelRevision: model };
  return {
    provider: "deterministic-fixture",
    model,
    adapter: "alcode-a2-reconstruction-fixture",
    adapterVersion: 1,
    semanticConfig,
    semanticConfigDigest: digestOf(semanticConfig),
  };
}

describeLocked("A2 complete inference provenance reconstruction", () => {
  let dir: string;
  let locked: LockedWorkspaceStore | null;
  let workspaceId: ReturnType<typeof asWorkspaceId>;
  let repositoryId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-a2-reconstruct-"));
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

  async function contextReceipt(
    store: LockedWorkspaceStore,
    sessionId: string,
  ): Promise<{ receiptId: string; sourceEventSequence: number }> {
    const sourceEventSequence = await store.store.headSequence();
    const eventId = mkEventId();
    await store.store.append([{
      eventId,
      workspaceId,
      sessionId: asSessionId(sessionId),
      occurredAt: new Date().toISOString(),
      type: "context.projection_compiled",
      payload: { receiptId: String(eventId) },
      payloadSchemaVersion: 1,
      producer: { kind: "projection", projectionName: "a2-reconstruction-test" },
    }]);
    return { receiptId: String(eventId), sourceEventSequence };
  }

  it("rebuilds assistant plus three explicit Code Mode subcalls and their distinct Operations after restart", async () => {
    locked = await openStore();
    const host = new HostRuntime({
      store: locked,
      capabilities: [{
        name: "inspect",
        description: "A2 deterministic operation fixture",
        workspaceAccessClass: "read_only",
        async execute(args) {
          return { result: structuredClone(args) };
        },
      }],
    });
    await host.startup();
    const session = await host.openOrResumeSession();
    const sessionId = String(session.sessionId);
    const receipt = await contextReceipt(locked, sessionId);
    const authorized = await host.inferenceProvenance.authorize({
      sessionId,
      connectionGenerationId: "generation-a2",
      contextReceiptId: receipt.receiptId,
      sourceEventSequence: receipt.sourceEventSequence,
      providerDescriptor: descriptor("model-a"),
      capabilityCatalogDigest: "catalog-a2",
      capabilityBindingSnapshot: [
        { toolName: "inspect", binding: { kind: "static" } },
      ],
    }, { assertCurrent: () => undefined });
    await host.inferenceProvenance.prepare({
      inferenceEpochId: authorized.inferenceEpochId,
      sessionId,
      connectionGenerationId: "generation-a2",
    });

    const assistantEventId = mkEventId();
    await locked.store.append([{
      eventId: assistantEventId,
      workspaceId,
      sessionId: asSessionId(sessionId),
      occurredAt: new Date().toISOString(),
      type: "assistant.message.appended",
      payload: {
        inferenceEpochId: authorized.inferenceEpochId,
        text: "run three local subcalls",
      },
      payloadSchemaVersion: 1,
      producer: { kind: "model", provider: "a2-reconstruction-test" },
    }]);

    const operations = [];
    for (let index = 1; index <= 3; index++) {
      const result = await host.capabilityBroker.execute({
        sessionId: session.sessionId,
        toolCallId: `opaque-subcall-${index}`,
        toolName: "inspect",
        args: { index },
        inferenceEpochId: authorized.inferenceEpochId,
        parentToolCallId: "opaque-outer-run-code",
        localSubcallIndex: index,
      });
      expect(result.outcome).toBe("succeeded");
      operations.push(result.operationId);
    }
    expect(new Set(operations).size).toBe(3);

    const beforeRestart = await reconstructInferenceProvenanceV1(locked.store);
    expect(beforeRestart).toHaveLength(1);
    expect(beforeRestart[0]).toMatchObject({
      inferenceEpochId: authorized.inferenceEpochId,
      contextReceiptId: receipt.receiptId,
      assistantEventId: String(assistantEventId),
      invocationState: "response_observed",
    });
    expect(beforeRestart[0]?.calls).toEqual([
      {
        toolCallId: "opaque-subcall-1",
        toolName: "inspect",
        operationId: operations[0],
        parentToolCallId: "opaque-outer-run-code",
        localSubcallIndex: 1,
      },
      {
        toolCallId: "opaque-subcall-2",
        toolName: "inspect",
        operationId: operations[1],
        parentToolCallId: "opaque-outer-run-code",
        localSubcallIndex: 2,
      },
      {
        toolCallId: "opaque-subcall-3",
        toolName: "inspect",
        operationId: operations[2],
        parentToolCallId: "opaque-outer-run-code",
        localSubcallIndex: 3,
      },
    ]);

    locked.close();
    locked = null;
    locked = await openStore();
    expect(await reconstructInferenceProvenanceV1(locked.store)).toEqual(beforeRestart);
  });

  it("keeps dynamic ABA snapshots distinct and rejects foreign/historical epoch ownership", async () => {
    locked = await openStore();
    const service = new InferenceProvenanceServiceV1(
      locked.store,
      new CanonicalAdmissionQueue(locked.store),
    );
    const sessionId = uuidv7();

    const firstReceipt = await contextReceipt(locked, sessionId);
    const first = await service.authorize({
      sessionId,
      connectionGenerationId: "generation-g0",
      contextReceiptId: firstReceipt.receiptId,
      sourceEventSequence: firstReceipt.sourceEventSequence,
      providerDescriptor: descriptor("model-a"),
      capabilityCatalogDigest: "catalog-g0",
      capabilityBindingSnapshot: [
        { toolName: "dynamic.inspect", binding: { kind: "dynamic", revision: "G0" } },
      ],
    }, { assertCurrent: () => undefined });

    const secondReceipt = await contextReceipt(locked, sessionId);
    const second = await service.authorize({
      sessionId,
      connectionGenerationId: "generation-g1",
      contextReceiptId: secondReceipt.receiptId,
      sourceEventSequence: secondReceipt.sourceEventSequence,
      providerDescriptor: descriptor("model-a"),
      capabilityCatalogDigest: "catalog-g1",
      capabilityBindingSnapshot: [
        { toolName: "dynamic.inspect", binding: { kind: "dynamic", revision: "G1" } },
      ],
    }, { assertCurrent: () => undefined });

    expect(first.capabilityBindingSnapshotDigest).not.toBe(second.capabilityBindingSnapshotDigest);
    expect((await service.get(first.inferenceEpochId))?.capabilityBindingSnapshot)
      .toEqual([{ toolName: "dynamic.inspect", binding: { kind: "dynamic", revision: "G0" } }]);
    expect((await service.get(second.inferenceEpochId))?.capabilityBindingSnapshot)
      .toEqual([{ toolName: "dynamic.inspect", binding: { kind: "dynamic", revision: "G1" } }]);

    await service.prepare({
      inferenceEpochId: first.inferenceEpochId,
      sessionId,
      connectionGenerationId: "generation-g0",
    });
    await expect(service.requireCurrentEpoch({
      inferenceEpochId: first.inferenceEpochId,
      sessionId,
      connectionGenerationId: "generation-g1",
      requirePrepared: true,
    })).rejects.toThrow(/does not belong to the current Session\/Agent generation/);
    await expect(service.requireCurrentEpoch({
      inferenceEpochId: uuidv7(),
      sessionId,
      connectionGenerationId: "generation-g1",
      requirePrepared: true,
    })).rejects.toThrow(/does not belong to the current Session\/Agent generation/);
  });
});
