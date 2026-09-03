import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  asProgramAttemptId,
  asProgramRevisionId,
  asProgramStateId,
  asProgramWorkItemId,
  asVerificationObligationId,
  type ProgramSemanticStateV1,
  type ProgramSemanticWorkItemV1,
  type VerificationObligation,
  type VerificationSemanticBindingV1,
  type WorkAuthorityEnvelopeV1,
} from "@alcode/program-state";
import {
  ProgramAdaptiveExecutionControlV2,
  ProgramSemanticCompletionServiceV2,
  ProgramSemanticExecutionSchedulerV2,
  evaluateAdaptiveCompletionOracleV2,
  type ProgramAdaptiveAttemptAdmissionV2,
  type ProgramAdaptiveCompletionFactsV2,
  type ProgramAdaptiveEligibilityFactsV2,
  type ProgramAdaptiveSemanticSessionStateSourceV2,
} from "./program-adaptive-control-v2.ts";
import type { ProgramSemanticCurrentSnapshotV1 } from "./program-revision.ts";

const programStateId = asProgramStateId("018f0000-0000-7000-8000-000000000a01");
const sessionId = "018f0000-0000-7000-8000-000000000a02";
const r1 = asProgramRevisionId("adaptive-control-r1");
const rootId = asProgramWorkItemId("adaptive-root");
const childAId = asProgramWorkItemId("adaptive-child-a");
const childBId = asProgramWorkItemId("adaptive-child-b");

function envelope(): WorkAuthorityEnvelopeV1 {
  return {
    objectiveBoundaryRef: {
      programStateId,
      rootProgramRevisionId: r1,
      anchorWorkItemId: rootId,
    },
    allowedRepositoryRoots: ["."],
    allowedEffectClasses: ["fs.read", "fs.write"],
    allowedExternalSystems: [],
    capabilityCeiling: ["edit", "read"],
    maximumTopologyExpansion: 8,
    mandatoryVerificationIds: [],
    forbiddenChangeKinds: ["delete_repository"],
  };
}

function work(input: {
  id: ReturnType<typeof asProgramWorkItemId>;
  creationOrder: number;
  satisfactionState: ProgramSemanticWorkItemV1["satisfactionState"];
  topologyState?: ProgramSemanticWorkItemV1["topologyState"];
  parentWorkItemId?: ProgramSemanticWorkItemV1["parentWorkItemId"];
  dependencyIds?: ProgramSemanticWorkItemV1["dependencyIds"];
}): ProgramSemanticWorkItemV1 {
  return {
    workItemId: input.id,
    creationOrder: input.creationOrder,
    description: String(input.id),
    dependencyIds: input.dependencyIds ?? [],
    affectedPaths: [`src/${input.creationOrder}.ts`],
    workItemGeneration: 1,
    requirementState: "required",
    topologyState: input.topologyState ?? "leaf",
    satisfactionState: input.satisfactionState,
    parentWorkItemId: input.parentWorkItemId ?? null,
    authorityEnvelope: envelope(),
  };
}

function semanticState(
  workItems: ProgramSemanticWorkItemV1[],
  verification: VerificationObligation[] = [],
  verificationBindings: VerificationSemanticBindingV1[] = [],
): ProgramSemanticStateV1 {
  return {
    programStateId,
    currentRevision: {
      programRevisionId: r1,
      parentProgramRevisionId: null,
      ordinal: 1,
      changeClass: "initial",
      acceptedAtStateRevision: 1,
      admissionEventId: "baseline",
      sourceDraftId: null,
      sourceDraftDigest: null,
    },
    workItems,
    verification,
    verificationBindings,
    outputSlots: [],
    productionSteps: [],
  };
}

function snapshot(
  state: ProgramSemanticStateV1,
  overrides: Partial<ProgramSemanticCurrentSnapshotV1> = {},
): ProgramSemanticCurrentSnapshotV1 {
  return {
    programStateRevision: 17,
    semanticState: state,
    activeAttempt: null,
    lifecycle: "active",
    attachedSessionIds: [sessionId],
    ...overrides,
  };
}

const greenEligibility: ProgramAdaptiveEligibilityFactsV2 = {
  hasActiveAttachedExecutionEpisode: true,
  workspaceReservationAvailable: true,
  recoveryClear: true,
  writerBarriersClear: true,
  quiescenceClear: true,
  executionBaseCurrent: true,
  openCanonicalBlockers: [],
};

const greenCompletion: ProgramAdaptiveCompletionFactsV2 = {
  recoveryClear: true,
  hasOpenCanonicalBlocker: false,
  executionBaseMismatch: false,
  executionBaseUnavailable: false,
  executionBaseCurrent: true,
  noOutstandingProgramOperations: true,
  noIndeterminateEffectsOrReconciliation: true,
  noOutstandingWriterBarrier: true,
  noRetryableDurableWork: true,
  artifactIntegrityCurrent: true,
};

const coordinator = {
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> { return fn(); },
};

function source(current: ProgramSemanticCurrentSnapshotV1): ProgramAdaptiveSemanticSessionStateSourceV2 {
  return { currentForSession: async () => structuredClone(current) };
}

describe("A1 adaptive semantic eligibility and Completion", () => {
  it("issues the first adaptive Attempt from canonical Attempt history even after whole-state revision churn", async () => {
    const current = snapshot(semanticState([
      work({ id: rootId, creationOrder: 4, satisfactionState: "pending" }),
    ]), { programStateRevision: 17 });
    let issued: Parameters<ProgramAdaptiveAttemptAdmissionV2["issue"]>[0] | undefined;
    const scheduler = new ProgramSemanticExecutionSchedulerV2({
      workspaceCoordinator: coordinator,
      semantic: source(current),
      operational: { currentForSession: async () => greenEligibility },
      attemptHistory: { hasAnyAttempt: async () => false },
      agents: { currentAgentGeneration: () => 9 },
      attempts: {
        issue: async (input) => {
          issued = input;
          return { status: "issued", programAttemptId: "attempt-first" };
        },
      },
    });

    const result = await scheduler.dispatchNext(sessionId);
    expect(result).toMatchObject({
      status: "issued",
      dispatchKind: "first",
      workItemId: String(rootId),
      programStateRevision: 17,
      programRevisionId: String(r1),
    });
    expect(issued).toMatchObject({
      expectedProgramStateRevision: 17,
      expectedProgramRevisionId: String(r1),
      dispatchKind: "first",
      agentGeneration: 9,
    });
  });

  it("labels later dispatch from durable Attempt history and chooses deterministic ready work", async () => {
    const later = asProgramWorkItemId("z-later");
    const earlier = asProgramWorkItemId("a-earlier");
    const current = snapshot(semanticState([
      work({ id: later, creationOrder: 8, satisfactionState: "pending" }),
      work({ id: earlier, creationOrder: 2, satisfactionState: "pending" }),
    ]));
    const scheduler = new ProgramSemanticExecutionSchedulerV2({
      workspaceCoordinator: coordinator,
      semantic: source(current),
      operational: { currentForSession: async () => greenEligibility },
      attemptHistory: { hasAnyAttempt: async () => true },
      agents: { currentAgentGeneration: () => 3 },
      attempts: { issue: async () => ({ status: "issued", programAttemptId: "attempt-next" }) },
    });
    await expect(scheduler.dispatchNext(sessionId)).resolves.toMatchObject({
      status: "issued",
      dispatchKind: "successor",
      workItemId: String(earlier),
    });
  });

  it("never issues same-Workspace parallel authority when the reservation is unavailable", async () => {
    let calls = 0;
    const current = snapshot(semanticState([
      work({ id: rootId, creationOrder: 0, satisfactionState: "pending" }),
    ]));
    const scheduler = new ProgramSemanticExecutionSchedulerV2({
      workspaceCoordinator: coordinator,
      semantic: source(current),
      operational: {
        currentForSession: async () => ({ ...greenEligibility, workspaceReservationAvailable: false }),
      },
      attemptHistory: { hasAnyAttempt: async () => false },
      agents: { currentAgentGeneration: () => 2 },
      attempts: {
        issue: async () => {
          calls += 1;
          return { status: "issued", programAttemptId: "must-not-issue" };
        },
      },
    });
    await expect(scheduler.dispatchNext(sessionId)).resolves.toEqual({
      status: "operationally_blocked",
      reason: "workspace_busy",
    });
    expect(calls).toBe(0);
  });

  it("skips a work-scoped canonical blocker and can issue an independent ready branch", async () => {
    const blocked = asProgramWorkItemId("blocked-ready");
    const independent = asProgramWorkItemId("independent-ready");
    const current = snapshot(semanticState([
      work({ id: blocked, creationOrder: 0, satisfactionState: "pending" }),
      work({ id: independent, creationOrder: 1, satisfactionState: "pending" }),
    ]));
    const scheduler = new ProgramSemanticExecutionSchedulerV2({
      workspaceCoordinator: coordinator,
      semantic: source(current),
      operational: {
        currentForSession: async () => ({
          ...greenEligibility,
          openCanonicalBlockers: [{ workItemId: String(blocked) }],
        }),
      },
      attemptHistory: { hasAnyAttempt: async () => false },
      agents: { currentAgentGeneration: () => 2 },
      attempts: { issue: async () => ({ status: "issued", programAttemptId: "attempt-independent" }) },
    });
    await expect(scheduler.dispatchNext(sessionId)).resolves.toMatchObject({
      status: "issued",
      workItemId: String(independent),
    });
  });

  it("blocks Completion while any descendant of a required decomposed parent is incomplete", () => {
    const current = snapshot(semanticState([
      work({ id: rootId, creationOrder: 0, topologyState: "decomposed", satisfactionState: "pending" }),
      work({ id: childAId, creationOrder: 1, parentWorkItemId: rootId, satisfactionState: "satisfied" }),
      work({ id: childBId, creationOrder: 2, parentWorkItemId: rootId, satisfactionState: "pending" }),
    ]));
    const result = evaluateAdaptiveCompletionOracleV2(current, greenCompletion);
    expect(result.eligible).toBe(false);
    expect(result.blockedBy).toContain("required_work_incomplete");
  });

  it("allows recursive non-vacuous decomposition discharge when every current descendant is satisfied", () => {
    const current = snapshot(semanticState([
      work({ id: rootId, creationOrder: 0, topologyState: "decomposed", satisfactionState: "pending" }),
      work({ id: childAId, creationOrder: 1, parentWorkItemId: rootId, satisfactionState: "satisfied" }),
      work({ id: childBId, creationOrder: 2, parentWorkItemId: rootId, satisfactionState: "satisfied" }),
    ]));
    const result = evaluateAdaptiveCompletionOracleV2(current, greenCompletion);
    expect(result).toEqual({ eligible: true, blockedBy: [] });
  });

  it("fails Completion closed for a vacuous zero-child decomposition", () => {
    const current = snapshot(semanticState([
      work({ id: rootId, creationOrder: 0, topologyState: "decomposed", satisfactionState: "pending" }),
    ]));
    const result = evaluateAdaptiveCompletionOracleV2(current, greenCompletion);
    expect(result.eligible).toBe(false);
    expect(result.blockedBy).toContain("structural_invariant_violation");
    expect(result.blockedBy).toContain("required_work_incomplete");
  });

  it("requires current verification for the current semantic subject", () => {
    const obligationId = asVerificationObligationId("semantic-verification");
    const verification: VerificationObligation[] = [{
      obligationId,
      predicate: { kind: "workspace_path_state", path: "src/0.ts", requiredState: "file" },
      freshnessScope: { kind: "paths", entries: [{ path: "src/0.ts", mode: "exact" }] },
      subjectGeneration: 1,
      satisfaction: null,
      waiver: null,
    }];
    const bindings: VerificationSemanticBindingV1[] = [{ obligationId, subject: { kind: "program" } }];
    const current = snapshot(semanticState([
      work({ id: rootId, creationOrder: 0, satisfactionState: "satisfied" }),
    ], verification, bindings));
    const result = evaluateAdaptiveCompletionOracleV2(current, greenCompletion);
    expect(result.eligible).toBe(false);
    expect(result.blockedBy).toContain("verification_not_current");
  });

  it("admits semantic Completion at the exact whole-state and semantic head without consulting pending drafts", async () => {
    const sourceText = readFileSync(new URL("./program-adaptive-control-v2.ts", import.meta.url), "utf8");
    expect(sourceText).toContain("Pending semantic drafts are");
    expect(sourceText).not.toContain("pendingForSession(");
    expect(sourceText).not.toContain("ProgramRevisionControlServiceV1");
    const current = snapshot(semanticState([
      work({ id: rootId, creationOrder: 0, satisfactionState: "satisfied" }),
    ]), { programStateRevision: 23 });
    let admitted: { expectedProgramStateRevision: number; expectedProgramRevisionId: string } | undefined;
    const completion = new ProgramSemanticCompletionServiceV2({
      workspaceCoordinator: coordinator,
      semantic: source(current),
      operational: { currentForSession: async () => greenCompletion },
      admission: {
        complete: async (input) => {
          admitted = input;
          return { status: "completed" };
        },
      },
    });
    await expect(completion.complete(sessionId)).resolves.toEqual({ status: "completed", duplicate: false });
    expect(admitted).toMatchObject({
      expectedProgramStateRevision: 23,
      expectedProgramRevisionId: String(r1),
    });
  });

  it("keeps recovery and legacy operational safety facts in the semantic Completion cut", () => {
    const current = snapshot(semanticState([
      work({ id: rootId, creationOrder: 0, satisfactionState: "satisfied" }),
    ]));
    const result = evaluateAdaptiveCompletionOracleV2(current, { ...greenCompletion, recoveryClear: false });
    expect(result.eligible).toBe(false);
    expect(result.blockedBy).toContain("recovery_blocked");
  });

  it("on idle dispatches semantic successor work before attempting terminal Completion", async () => {
    let completionCalls = 0;
    const control = new ProgramAdaptiveExecutionControlV2({
      scheduler: {
        dispatchNext: async () => ({
          status: "issued",
          programAttemptId: "next-attempt",
          dispatchKind: "successor",
          workItemId: String(rootId),
          workItemGeneration: 1,
          programStateRevision: 19,
          programRevisionId: String(r1),
        }),
      },
      completion: {
        complete: async () => {
          completionCalls += 1;
          return { status: "completed", duplicate: false };
        },
      },
    });
    await expect(control.handleAgentIdle(sessionId)).resolves.toEqual({
      status: "handled",
      terminal: "none",
      reason: "successor_dispatched",
    });
    expect(completionCalls).toBe(0);
  });

  it("redrives Completion after final progress retires the Attempt behind an earlier idle", async () => {
    let attemptActive = true;
    let completionCalls = 0;
    const control = new ProgramAdaptiveExecutionControlV2({
      scheduler: {
        dispatchNext: async () => attemptActive
          ? ({ status: "already_started", programAttemptId: "attempt-final" } as const)
          : ({
              status: "no_ready_work",
              programStateRevision: 8,
              programRevisionId: "revision-final",
            } as const),
      },
      completion: {
        complete: async () => {
          completionCalls += 1;
          return { status: "completed", duplicate: false } as const;
        },
      },
    });

    await expect(control.handleAgentIdle(sessionId)).resolves.toEqual({
      status: "handled",
      terminal: "none",
      reason: "active_attempt",
    });
    expect(completionCalls).toBe(0);

    // Final progress wins after the fire-and-forget idle callback has already
    // observed the Attempt. Product redrive must now close without another idle.
    attemptActive = false;
    await expect(control.ensureCurrentAttempt(sessionId)).resolves.toEqual({
      status: "program_not_active",
      lifecycle: "completed",
    });
    expect(completionCalls).toBe(1);
  });
});
