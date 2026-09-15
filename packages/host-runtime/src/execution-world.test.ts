import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestOf } from "@alcode/context";
import { asWorkspaceId, uuidv7 } from "@alcode/events";
import { openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import {
  ExecutionWorldControlError,
  ExecutionWorldServiceV1,
  type ExecutionContainmentPolicyDescriptorV1,
  type ExecutionProviderDescriptorV1,
} from "./execution-world.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

async function openStore(dir: string): Promise<LockedWorkspaceStore> {
  return openLockedWorkspaceStore({
    databasePath: join(dir, "workspace.sqlite"),
    lockPath: join(dir, "workspace.lock"),
    workspaceId: asWorkspaceId(uuidv7()),
    repositoryId: uuidv7(),
  });
}

const localProvider: ExecutionProviderDescriptorV1 = {
  providerKind: "local-trusted",
  adapter: "alcode-local-workspace",
  adapterVersion: 1,
  semanticConfig: { transport: "host-process", hostileCodeIsolation: false },
};

const localPolicy: ExecutionContainmentPolicyDescriptorV1 = {
  profile: "local-trusted-v1",
  semanticConfig: { network: "host", filesystem: "workspace-root", secrets: "host-policy" },
};

function readiness(label: string) {
  return { readinessEvidenceDigest: digestOf({ kind: "test-readiness", label }) };
}

function closure(label: string) {
  return {
    closureEvidenceDigest: digestOf({ kind: "test-closure", label }),
    bindingUnavailable: true as const,
  };
}

describeLocked("A5 execution-world generation lifecycle", () => {
  let dir: string;
  let locked: LockedWorkspaceStore | null;
  let sessionId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-a5-world-"));
    locked = null;
    sessionId = uuidv7();
  });

  afterEach(() => {
    try { locked?.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("mints a fresh non-reusable generation and does not treat preparation as activation", async () => {
    locked = await openStore(dir);
    const service = new ExecutionWorldServiceV1(locked.store, new CanonicalAdmissionQueue(locked.store));
    const workspaceId = String(locked.store.workspaceId);

    const prepared = await service.prepareActivation({
      activationRequestId: "local-start-1",
      workspaceId,
      sessionId,
      providerDescriptor: localProvider,
      effectivePolicy: localPolicy,
    });
    const retry = await service.prepareActivation({
      activationRequestId: "local-start-1",
      workspaceId,
      sessionId,
      providerDescriptor: localProvider,
      effectivePolicy: localPolicy,
    });

    expect(retry).toEqual(prepared);
    expect((await service.requireGeneration(prepared.executionWorldGenerationId)).state).toBe("prepared");
    await expect(service.requireCurrent()).rejects.toBeInstanceOf(ExecutionWorldControlError);

    const active = await service.observeActivation({
      executionWorldGenerationId: prepared.executionWorldGenerationId,
      evidence: readiness("g0"),
    });
    expect(active.state).toBe("active");
    expect(active.isCurrent).toBe(true);
    expect(active.lifecycleSessionId).toBe(sessionId);
    expect(await service.currentOperationProvenance()).toEqual(prepared);
  });

  it("makes same-bytes recreation a freshness cut and never revives G0", async () => {
    locked = await openStore(dir);
    const service = new ExecutionWorldServiceV1(locked.store, new CanonicalAdmissionQueue(locked.store));
    const workspaceId = String(locked.store.workspaceId);

    const g0 = await service.prepareActivation({
      activationRequestId: "g0", workspaceId, sessionId,
      providerDescriptor: localProvider, effectivePolicy: localPolicy,
    });
    await service.observeActivation({ executionWorldGenerationId: g0.executionWorldGenerationId, evidence: readiness("same-bytes") });

    const g1 = await service.prepareActivation({
      activationRequestId: "g1", workspaceId, sessionId,
      providerDescriptor: localProvider, effectivePolicy: localPolicy,
    });
    expect(g1.executionWorldGenerationId).not.toBe(g0.executionWorldGenerationId);
    await service.observeActivation({ executionWorldGenerationId: g1.executionWorldGenerationId, evidence: readiness("same-bytes") });

    await expect(service.requireCurrent(g0.executionWorldGenerationId)).rejects.toThrow("not current");
    expect((await service.requireCurrent(g1.executionWorldGenerationId)).identity).toEqual(g1);
    const rebuilt = await service.rebuild();
    expect(rebuilt.currentGenerationId).toBe(g1.executionWorldGenerationId);
    expect(rebuilt.generations.get(g0.executionWorldGenerationId)?.isCurrent).toBe(false);
  });

  it("preserves teardown uncertainty until positive closure evidence exists", async () => {
    locked = await openStore(dir);
    const service = new ExecutionWorldServiceV1(locked.store, new CanonicalAdmissionQueue(locked.store));
    const world = await service.prepareActivation({
      activationRequestId: "close-me", workspaceId: String(locked.store.workspaceId), sessionId,
      providerDescriptor: localProvider, effectivePolicy: localPolicy,
    });
    await service.observeActivation({ executionWorldGenerationId: world.executionWorldGenerationId, evidence: readiness("close") });
    const retiring = await service.requestRetirement(world.executionWorldGenerationId);
    expect(retiring.state).toBe("retiring");
    expect(retiring.closedAt).toBeUndefined();
    await expect(service.requireCurrent()).rejects.toThrow("not current");

    const closed = await service.observeClosure({
      executionWorldGenerationId: world.executionWorldGenerationId,
      evidence: closure("close"),
    });
    expect(closed.state).toBe("closed");
    expect(closed.closureEvidence?.bindingUnavailable).toBe(true);
  });

  it("rebuilds lifecycle and current-generation projection exactly after restart", async () => {
    locked = await openStore(dir);
    const first = new ExecutionWorldServiceV1(locked.store, new CanonicalAdmissionQueue(locked.store));
    const world = await first.prepareActivation({
      activationRequestId: "restart", workspaceId: String(locked.store.workspaceId), sessionId,
      providerDescriptor: localProvider, effectivePolicy: localPolicy,
    });
    await first.observeActivation({ executionWorldGenerationId: world.executionWorldGenerationId, evidence: readiness("restart") });
    const before = await first.rebuild();

    const restarted = new ExecutionWorldServiceV1(locked.store, new CanonicalAdmissionQueue(locked.store));
    const after = await restarted.rebuild();
    expect(after.currentGenerationId).toBe(before.currentGenerationId);
    expect([...after.generations.entries()]).toEqual([...before.generations.entries()]);
  });

  it("fails closed on secret-bearing durable semantic configuration", async () => {
    locked = await openStore(dir);
    const service = new ExecutionWorldServiceV1(locked.store, new CanonicalAdmissionQueue(locked.store));
    await expect(service.prepareActivation({
      activationRequestId: "secret", workspaceId: String(locked.store.workspaceId), sessionId,
      providerDescriptor: { ...localProvider, semanticConfig: { apiKey: "must-not-persist" } },
      effectivePolicy: localPolicy,
    })).rejects.toThrow("Forbidden execution semantic configuration key");
  });

  it("rejects activation request-id reuse with changed provider/policy semantics", async () => {
    locked = await openStore(dir);
    const service = new ExecutionWorldServiceV1(locked.store, new CanonicalAdmissionQueue(locked.store));
    const input = {
      activationRequestId: "stable-request", workspaceId: String(locked.store.workspaceId), sessionId,
      providerDescriptor: localProvider, effectivePolicy: localPolicy,
    };
    await service.prepareActivation(input);
    await expect(service.prepareActivation({
      ...input,
      effectivePolicy: { ...localPolicy, semanticConfig: { ...localPolicy.semanticConfig, network: "deny" } },
    })).rejects.toThrow("reused with different execution semantics");
  });
});
