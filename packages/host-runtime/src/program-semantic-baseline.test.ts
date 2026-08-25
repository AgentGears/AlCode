import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  asProgramStateId as asEventProgramStateId,
  asWorkspaceId,
  mkEventId,
  type EventDraft,
  type PersistedDomainEvent,
  type SessionId,
} from "@alcode/events";
import {
  asExecutionBaseMismatchReceiptId,
  asProgramAttemptId,
  asProgramBlockerId,
  asProgramStateId,
  asProgramWorkItemId,
  asVerificationObligationId,
  createProgramState,
  type ProgramAttemptExecutionBase,
  type ProgramState,
} from "@alcode/program-state";
import { openLockedWorkspaceStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import type { ProgramDispatchWorkspaceCoordinatorV1 } from "./program-dispatch.ts";
import {
  ProgramSemanticBaselineBlockedError,
  ProgramSemanticBaselineStaleError,
  evaluateProgramSemanticBaselineQuiescenceV1,
  type ProgramLegacyBaselineAuthorityDimensionsV1,
} from "./program-semantic-baseline-kernel.ts";
import { ProgramSemanticBaselineRegistryV1 } from "./program-semantic-baseline-replay.ts";
import { ProgramSemanticBaselineServiceV1 } from "./program-semantic-baseline-service.ts";
import { HostSessionManager } from "./session-manager.ts";

const programStateId = asProgramStateId("018f0000-0000-7000-8000-000000000b01");
const workPendingId = asProgramWorkItemId("baseline-work-pending");
const workCompletedId = asProgramWorkItemId("baseline-work-completed");
const verificationId = asVerificationObligationId("baseline-verification");

const coordinator: ProgramDispatchWorkspaceCoordinatorV1 = {
  async runExclusive<T>(work: () => Promise<T>): Promise<T> { return work(); },
};

class MutableRecovery {
  clear = true;
  isClear(): boolean { return this.clear; }
}

class MutableAuthority {
  dimensions: ProgramLegacyBaselineAuthorityDimensionsV1 = {
    allowedRepositoryRoots: ["."],
    allowedEffectClasses: ["fs.read", "fs.write"],
    allowedExternalSystems: [],
    capabilityCeiling: ["edit", "read"],
    maximumTopologyExpansion: 8,
    mandatoryVerificationIds: [String(verificationId)],
    forbiddenChangeKinds: ["delete_repository"],
  };

  forWorkItem(): ProgramLegacyBaselineAuthorityDimensionsV1 {
    return structuredClone(this.dimensions);
  }
}

function legacyState(sessionId: SessionId): ProgramState {
  const state = createProgramState({
    programStateId,
    objective: "Preserve the legacy fixed-topology Program exactly while adopting adaptive semantics",
    sourceSessionId: sessionId,
    workItems: [
      {
        workItemId: workPendingId,
        creationOrder: 0,
        description: "Pending legacy work",
        dependencyIds: [workCompletedId],
        affectedPaths: ["src/pending.ts"],
      },
      {
        workItemId: workCompletedId,
        creationOrder: 1,
        description: "Completed legacy work",
        dependencyIds: [],
        affectedPaths: ["src/completed.ts"],
      },
    ],
    verification: [{
      obligationId: verificationId,
      predicate: { kind: "workspace_path_state", path: "src/pending.ts", requiredState: "file" },
      freshnessScope: { kind: "paths", entries: [{ path: "src/pending.ts", mode: "exact" }] },
    }],
    outputSlots: [],
    productionSteps: [],
  });
  state.revision = 7;
  state.workItems[1] = { ...state.workItems[1]!, lifecycle: "completed" };
  return state;
}

function executionBase(workspaceId = "018f0000-0000-7000-8000-000000000b02"): ProgramAttemptExecutionBase {
  return {
    workspaceEffectGeneration: 3,
    observation: {
      kind: "workspace-observation-v1",
      providerKind: "test",
      workspaceIdentity: workspaceId,
      coverageDigest: "complete",
      stateDigest: "state-3",
    },
  };
}

async function appendProgramCreated(
  admission: CanonicalAdmissionQueue,
  workspaceId: string,
  sessionId: SessionId,
  state: ProgramState,
): Promise<void> {
  const draft: EventDraft<string, unknown> = {
    eventId: mkEventId(),
    idempotencyKey: `program.created:${String(state.programStateId)}`,
    correlationId: "baseline-fixture",
    workspaceId: asWorkspaceId(workspaceId),
    sessionId,
    programStateId: asEventProgramStateId(String(state.programStateId)),
    occurredAt: new Date().toISOString(),
    type: "program.created",
    payload: { state },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-semantic-baseline-test" },
  };
  await admission.append([draft]);
}

async function appendProgramTransition(
  admission: CanonicalAdmissionQueue,
  workspaceId: string,
  sessionId: SessionId,
  state: ProgramState,
): Promise<void> {
  await admission.append([{
    eventId: mkEventId(),
    idempotencyKey: `program.transitioned:${String(state.programStateId)}:${state.revision}`,
    correlationId: "baseline-fixture-transition",
    workspaceId: asWorkspaceId(workspaceId),
    sessionId,
    programStateId: asEventProgramStateId(String(state.programStateId)),
    occurredAt: new Date().toISOString(),
    type: "program.transitioned",
    payload: { state, transitionKind: "fixture" },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-semantic-baseline-test" },
  }]);
}

async function allEvents(store: { replay(): AsyncIterable<any> }): Promise<any[]> {
  const events: any[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

async function fixture(stateMutator?: (state: ProgramState, workspaceId: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "alcode-semantic-baseline-"));
  const locked = await openLockedWorkspaceStore({
    databasePath: join(dir, "workspace.sqlite"),
    lockPath: join(dir, "workspace.lock"),
    workspaceId: "018f0000-0000-7000-8000-000000000b02",
    repositoryId: "program-semantic-baseline-test",
  });
  const admission = new CanonicalAdmissionQueue(locked.store);
  const sessions = new HostSessionManager(locked, admission);
  const session = await sessions.openOrResume();
  const state = legacyState(session.sessionId);
  stateMutator?.(state, locked.store.workspaceId);
  await appendProgramCreated(admission, locked.store.workspaceId, session.sessionId, state);
  const recovery = new MutableRecovery();
  const authority = new MutableAuthority();
  const service = new ProgramSemanticBaselineServiceV1({
    store: locked.store,
    admission,
    workspaceCoordinator: coordinator,
    recovery,
    authority,
  });
  return { locked, admission, session, state, recovery, authority, service };
}

function syntheticEvent(
  type: string,
  payload: Record<string, unknown>,
  options: { programStateId?: string } = {},
): PersistedDomainEvent<string, unknown> {
  return {
    eventId: "018f0000-0000-7000-8000-000000000b99",
    sequence: 1,
    workspaceId: "018f0000-0000-7000-8000-000000000b02",
    sessionId: "018f0000-0000-7000-8000-000000000b03",
    programStateId: options.programStateId ?? null,
    operationId: null,
    occurredAt: new Date().toISOString(),
    type,
    payload,
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "test" },
  } as PersistedDomainEvent<string, unknown>;
}

const describeLocked = process.platform === "win32" ? describe.skip : describe;

describeLocked("A1 quiescent legacy semantic baseline adoption", () => {
  it("seals and accepts one exact meaning-preserving baseline, then rebuilds adaptive identity after restart", async () => {
    const f = await fixture();
    const before = new ProgramSemanticBaselineRegistryV1(f.locked.store);
    await expect(before.isAdopted(String(programStateId))).resolves.toBe(false);

    const draft = await f.service.sealDraft({
      sourceSessionId: String(f.session.sessionId),
      programStateId: String(programStateId),
      expectedProgramStateRevision: 7,
    });

    expect(draft.cut).toMatchObject({
      kind: "program.semantic_baseline.adopted.v1",
      fromProgramStateRevision: 7,
      toProgramStateRevision: 8,
    });
    expect(draft.cut.semanticState.currentRevision).toMatchObject({
      ordinal: 1,
      changeClass: "initial",
      parentProgramRevisionId: null,
      acceptedAtStateRevision: 8,
      sourceDraftId: null,
      sourceDraftDigest: null,
    });
    expect(draft.cut.semanticState.workItems.map((work) => ({
      id: String(work.workItemId),
      generation: work.workItemGeneration,
      requirement: work.requirementState,
      topology: work.topologyState,
      satisfaction: work.satisfactionState,
      parent: work.parentWorkItemId,
    }))).toEqual([
      {
        id: String(workCompletedId),
        generation: 1,
        requirement: "required",
        topology: "leaf",
        satisfaction: "satisfied",
        parent: null,
      },
      {
        id: String(workPendingId),
        generation: 1,
        requirement: "required",
        topology: "leaf",
        satisfaction: "pending",
        parent: null,
      },
    ]);
    expect(draft.cut.semanticState.verification[0]).toEqual(f.state.verification[0]);
    expect(draft.cut.semanticState.verificationBindings).toEqual([
      { obligationId: verificationId, subject: { kind: "program" } },
    ]);
    expect(draft.cut.semanticState.workItems.every((work) =>
      work.authorityEnvelope.mandatoryVerificationIds.includes(verificationId))).toBe(true);
    expect(draft.cut.revisionImpact.unchangedWorkItems).toHaveLength(2);
    expect(draft.cut.revisionImpact.modifiedWorkItems).toEqual([]);
    expect(draft.cut.revisionImpact.staleVerification).toEqual([]);
    expect(draft.cut.revisionImpact.retainedVerification).toHaveLength(1);

    const accepted = await f.service.accept({
      commandId: "accept-baseline-1",
      clientId: "application-test",
      sourceSessionId: String(f.session.sessionId),
      programStateId: String(programStateId),
      draftId: draft.draftId,
      draftDigest: draft.draftDigest,
    });
    expect(accepted.status).toBe("adopted");
    expect(accepted.programStateRevision).toBe(8);

    await expect(f.service.accept({
      commandId: "accept-baseline-duplicate",
      clientId: "application-test",
      sourceSessionId: String(f.session.sessionId),
      programStateId: String(programStateId),
      draftId: draft.draftId,
      draftDigest: draft.draftDigest,
    })).resolves.toMatchObject({ status: "existing", programStateRevision: 8 });

    const restarted = new ProgramSemanticBaselineRegistryV1(f.locked.store);
    await expect(restarted.isAdopted(String(programStateId))).resolves.toBe(true);
    await expect(restarted.current(String(programStateId))).resolves.toEqual(draft.cut);
    const events = await allEvents(f.locked.store);
    expect(events.filter((event) => event.type === "program.semantic_baseline.adopted.v1")).toHaveLength(1);
    expect(events.filter((event) => event.type === "program.semantic_revision.admitted.v1")).toHaveLength(0);

    await expect(f.service.sealDraft({
      sourceSessionId: String(f.session.sessionId),
      programStateId: String(programStateId),
      expectedProgramStateRevision: 7,
    })).rejects.toThrow(/already adopted adaptive semantics/);
    await f.locked.close();
  });

  it("never converts an active V1 Attempt in place", async () => {
    const f = await fixture((state, workspaceId) => {
      const base = executionBase(workspaceId);
      state.workItems[0] = { ...state.workItems[0]!, lifecycle: "in_progress" };
      state.activeAttempt = {
        programAttemptId: asProgramAttemptId("baseline-active-attempt"),
        workItemId: workPendingId,
        sessionId: state.attachedSessionIds[0]!,
        agentGeneration: 1,
        initialExecutionBase: base,
        expectedExecutionBase: base,
      };
    });
    await expect(f.service.sealDraft({
      sourceSessionId: String(f.session.sessionId),
      programStateId: String(programStateId),
      expectedProgramStateRevision: 7,
    })).rejects.toMatchObject({ blockedBy: expect.arrayContaining(["active_attempt"]) });
    expect((await allEvents(f.locked.store)).some((event) => event.type === "program.semantic_baseline.adopted.v1")).toBe(false);
    await f.locked.close();
  });

  it("rechecks quiescence and Host authority at exact Application acceptance", async () => {
    const f = await fixture();
    const draft = await f.service.sealDraft({
      sourceSessionId: String(f.session.sessionId),
      programStateId: String(programStateId),
      expectedProgramStateRevision: 7,
    });
    f.recovery.clear = false;
    await expect(f.service.accept({
      commandId: "blocked-by-recovery",
      clientId: "application-test",
      sourceSessionId: String(f.session.sessionId),
      programStateId: String(programStateId),
      draftId: draft.draftId,
      draftDigest: draft.draftDigest,
    })).rejects.toBeInstanceOf(ProgramSemanticBaselineBlockedError);

    f.recovery.clear = true;
    f.authority.dimensions = {
      ...f.authority.dimensions,
      capabilityCeiling: ["read"],
    };
    await expect(f.service.accept({
      commandId: "stale-authority",
      clientId: "application-test",
      sourceSessionId: String(f.session.sessionId),
      programStateId: String(programStateId),
      draftId: draft.draftId,
      draftDigest: draft.draftDigest,
    })).rejects.toBeInstanceOf(ProgramSemanticBaselineStaleError);
    expect((await allEvents(f.locked.store)).some((event) =>
      event.type === "program.semantic_baseline.draft.invalidated.v1"
      && event.payload.reason === "authority_changed")).toBe(true);
    await f.locked.close();
  });

  it("invalidates exact baseline acceptance when the legacy ProgramState revision moves", async () => {
    const f = await fixture();
    const draft = await f.service.sealDraft({
      sourceSessionId: String(f.session.sessionId),
      programStateId: String(programStateId),
      expectedProgramStateRevision: 7,
    });
    const moved: ProgramState = {
      ...structuredClone(f.state),
      revision: 8,
      blockers: [{
        blockerId: asProgramBlockerId("baseline-blocker"),
        workItemId: workPendingId,
        reason: "Operational state changed after draft sealing",
        state: "open",
      }],
    };
    await appendProgramTransition(f.admission, f.locked.store.workspaceId, f.session.sessionId, moved);
    await expect(f.service.accept({
      commandId: "accept-stale-baseline",
      clientId: "application-test",
      sourceSessionId: String(f.session.sessionId),
      programStateId: String(programStateId),
      draftId: draft.draftId,
      draftDigest: draft.draftDigest,
    })).rejects.toBeInstanceOf(ProgramSemanticBaselineStaleError);
    expect((await allEvents(f.locked.store)).some((event) =>
      event.type === "program.semantic_baseline.draft.invalidated.v1"
      && event.payload.reason === "stale_parent")).toBe(true);
    await f.locked.close();
  });

  it("fails the protected cut closed for operation, effect, writer, recovery, and execution-base barriers", async () => {
    const f = await fixture();
    const state = f.state;
    const programId = String(state.programStateId);
    const operationRequested = syntheticEvent("operation.requested", {
      operationId: "op-1",
      toolName: "write",
      args: {},
      isReadOnly: false,
      workspaceAccessClass: "may_write",
    }, { programStateId: programId });
    expect(evaluateProgramSemanticBaselineQuiescenceV1(state, [operationRequested], true)).toEqual(
      expect.arrayContaining(["outstanding_program_operation", "writer_barrier"]),
    );

    const interrupted = syntheticEvent("operation.interrupted", { operationId: "op-1" }, { programStateId: programId });
    expect(evaluateProgramSemanticBaselineQuiescenceV1(state, [operationRequested, interrupted], true)).toEqual(
      expect.arrayContaining([
        "outstanding_program_operation",
        "indeterminate_effect_or_reconciliation",
        "writer_barrier",
      ]),
    );
    expect(evaluateProgramSemanticBaselineQuiescenceV1(state, [], false)).toContain("recovery_blocked");
    expect(evaluateProgramSemanticBaselineQuiescenceV1({ ...state, executionBaseUnavailable: true }, [], true))
      .toContain("execution_base_unavailable");

    const accepted = executionBase(f.locked.store.workspaceId);
    const current = { ...accepted, workspaceEffectGeneration: accepted.workspaceEffectGeneration + 1 };
    const mismatchState: ProgramState = {
      ...structuredClone(state),
      acceptedExecutionBase: accepted,
      executionBaseMismatch: {
        receiptId: asExecutionBaseMismatchReceiptId("baseline-mismatch"),
        programStateId: state.programStateId,
        expectedProgramRevision: state.revision,
        acceptedWorkspaceEffectGeneration: accepted.workspaceEffectGeneration,
        acceptedObservationIdentity: accepted.observation,
        currentWorkspaceEffectGeneration: current.workspaceEffectGeneration,
        currentObservationIdentity: current.observation,
        kind: "causal_generation_mismatch",
        verificationImpactComplete: true,
      },
    };
    expect(evaluateProgramSemanticBaselineQuiescenceV1(mismatchState, [], true)).toContain("execution_base_mismatch");
    await f.locked.close();
  });
});
