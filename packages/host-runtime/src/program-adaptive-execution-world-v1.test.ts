import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  asOperationId,
  asProgramStateId,
  asSessionId,
  asWorkspaceId,
  mkEventId,
  uuidv7,
  type EventDraft,
} from "@alcode/events";
import { openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import type { ExecutionWorldOperationProvenanceV1 } from "./execution-world.ts";
import { createProgramAdaptiveExecutionWorldCompositionV1 } from "./program-adaptive-execution-world-v1.ts";
import {
  ProgramDispatchStaleError,
  type ProgramRootOperationAuthorityV1,
} from "./program-dispatch.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

function provenance(workspaceId: string, generation: string): ExecutionWorldOperationProvenanceV1 {
  return {
    workspaceId,
    providerKind: "local-trusted",
    executionWorldGenerationId: generation,
    providerDescriptorDigest: "provider-digest",
    effectivePolicyDigest: "policy-digest",
  };
}

function attemptState(
  workspaceId: string,
  programAttemptId: string,
  workItemId: string,
  executionWorld: ExecutionWorldOperationProvenanceV1,
) {
  const executionBase = {
    workspaceEffectGeneration: 0,
    observation: {
      kind: "workspace-observation-v1" as const,
      providerKind: executionWorld.providerKind,
      workspaceIdentity: workspaceId,
      coverageDigest: "a5-adaptive-world",
      stateDigest: "same-bytes",
      executionWorld: structuredClone(executionWorld),
    },
  };
  return {
    activeAttempt: {
      programAttemptId,
      workItemId,
      initialExecutionBase: structuredClone(executionBase),
      expectedExecutionBase: executionBase,
    },
  };
}

async function replayAll(locked: LockedWorkspaceStore) {
  const events = [];
  for await (const event of locked.store.replay()) events.push(event);
  return events;
}

describeLocked("A5 adaptive execution-world composition", () => {
  let dir: string;
  let locked: LockedWorkspaceStore | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-a5-adaptive-world-"));
    locked = null;
  });

  afterEach(() => {
    try { locked?.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  it("atomically binds adaptive Attempt issuance and rejects a captured G0 Operation after G1 replacement", async () => {
    locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: asWorkspaceId(uuidv7()),
      repositoryId: "a5-adaptive-world",
    });
    const workspaceId = String(locked.store.workspaceId);
    let current = provenance(workspaceId, "g0");
    const composition = createProgramAdaptiveExecutionWorldCompositionV1(
      locked.store,
      { currentOperationProvenance: async () => structuredClone(current) },
    );
    const sessionId = asSessionId(uuidv7());
    const programStateId = asProgramStateId(uuidv7());
    const programAttemptId = "attempt-g0";
    const workItemId = "work-g0";

    await composition.store.append([{
      eventId: mkEventId(),
      workspaceId: asWorkspaceId(workspaceId),
      sessionId,
      programStateId,
      occurredAt: new Date().toISOString(),
      type: "program.transitioned",
      payload: {
        transitionKind: "attempt.issue",
        state: attemptState(workspaceId, programAttemptId, workItemId, current),
      },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "program-adaptive-admission-v2" },
    }]);

    let events = await replayAll(locked);
    const binding = events.find((event) => event.type === "program.attempt.execution_world.bound");
    expect(binding).toBeDefined();
    expect((binding?.payload as { executionWorld?: { executionWorldGenerationId?: string } }).executionWorld)
      .toMatchObject({ executionWorldGenerationId: "g0", workspaceId });

    const base: ProgramRootOperationAuthorityV1 = {
      resolveCurrentOperation: async () => null,
      appendRoutedRootOperation: async (input) => ({
        status: "appended",
        events: await composition.store.append(input.drafts),
        program: input.program ?? null,
      }),
      appendRootOperation: (_input, drafts) => composition.store.append(drafts),
      settleProgramMutation: async () => ({ state: null, events: [] }),
    };
    const authority = composition.wrapOperationAuthority(base);
    const operationDraft = (operationId: string): EventDraft<string, unknown> => ({
      eventId: mkEventId(),
      workspaceId: asWorkspaceId(workspaceId),
      sessionId,
      operationId: asOperationId(operationId),
      occurredAt: new Date().toISOString(),
      type: "operation.requested",
      payload: {
        operationId,
        programStateId: String(programStateId),
        expectedProgramRevision: 1,
        programAttemptId,
        workItemId,
        agentGeneration: 1,
        workspaceAccessClass: "read_only",
      },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "host-capability-broker" },
    });
    const program = {
      programStateId: String(programStateId),
      expectedProgramRevision: 1,
      programAttemptId,
      workItemId,
      agentGeneration: 1,
    };

    const admitted = await authority.appendRoutedRootOperation({
      sessionId,
      operationId: "op-g0",
      workspaceAccessClass: "read_only",
      program,
      executionWorld: provenance(workspaceId, "g0"),
      drafts: [operationDraft("op-g0")],
    });
    expect(admitted.status).toBe("appended");
    events = await replayAll(locked);
    const admittedRequest = events.find((event) =>
      event.type === "operation.requested" && String(event.operationId) === "op-g0");
    expect((admittedRequest?.payload as { executionWorld?: { executionWorldGenerationId?: string } }).executionWorld)
      .toMatchObject({ executionWorldGenerationId: "g0" });

    current = provenance(workspaceId, "g1");
    await expect(authority.appendRoutedRootOperation({
      sessionId,
      operationId: "op-stale",
      workspaceAccessClass: "read_only",
      program,
      executionWorld: provenance(workspaceId, "g0"),
      drafts: [operationDraft("op-stale")],
    })).rejects.toBeInstanceOf(ProgramDispatchStaleError);

    events = await replayAll(locked);
    expect(events.some((event) =>
      event.type === "operation.requested" && String(event.operationId) === "op-stale")).toBe(false);
  });

  it("rejects adaptive Attempt issuance when its observed G0 base races current G1", async () => {
    locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace-race.sqlite"),
      lockPath: join(dir, "workspace-race.lock"),
      workspaceId: asWorkspaceId(uuidv7()),
      repositoryId: "a5-adaptive-world-race",
    });
    const workspaceId = String(locked.store.workspaceId);
    const g0 = provenance(workspaceId, "g0");
    const g1 = provenance(workspaceId, "g1");
    const composition = createProgramAdaptiveExecutionWorldCompositionV1(
      locked.store,
      { currentOperationProvenance: async () => structuredClone(g1) },
    );
    const sessionId = asSessionId(uuidv7());
    const programStateId = asProgramStateId(uuidv7());

    await expect(composition.store.append([{
      eventId: mkEventId(),
      workspaceId: asWorkspaceId(workspaceId),
      sessionId,
      programStateId,
      occurredAt: new Date().toISOString(),
      type: "program.transitioned",
      payload: {
        transitionKind: "attempt.issue",
        state: attemptState(workspaceId, "attempt-race", "work-race", g0),
      },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "program-adaptive-admission-v2" },
    }])).rejects.toBeInstanceOf(ProgramDispatchStaleError);

    expect(await replayAll(locked)).toHaveLength(0);
  });
});
