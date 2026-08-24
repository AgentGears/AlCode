import { describe, expect, it } from "vitest";
import {
  asProgramAttemptId,
  asProgramRevisionId,
  asProgramStateId,
  asProgramWorkItemId,
  type ProgramAttemptSemanticAssumptionsV1,
  type ProgramSemanticStateV1,
  type ProgramSemanticWorkItemV1,
  type WorkAuthorityEnvelopeV1,
} from "@alcode/program-state";
import { issueProgramAttemptAuthorityV2 as issueProgramAttemptAuthorityV2FromPackage } from "@alcode/host-runtime";
import {
  evaluateProgramAttemptAuthorityV2,
  issueProgramAttemptAuthorityV2,
  type ProgramAttemptAuthorityFactsV2,
} from "./program-attempt-authority-v2.ts";
import type { ProgramSemanticCurrentSnapshotV1 } from "./program-revision.ts";

const programStateId = asProgramStateId("018f0000-0000-7000-8000-000000000941");
const dependencyId = asProgramWorkItemId("authority-dependency");
const workId = asProgramWorkItemId("authority-work");
const attemptId = asProgramAttemptId("authority-attempt");
const r1 = asProgramRevisionId("authority-r1");
const r2 = asProgramRevisionId("authority-r2");

function envelope(roots = ["."]): WorkAuthorityEnvelopeV1 {
  return {
    objectiveBoundaryRef: {
      programStateId,
      rootProgramRevisionId: r1,
      anchorWorkItemId: workId,
    },
    allowedRepositoryRoots: roots,
    allowedEffectClasses: ["fs.read", "fs.write"],
    allowedExternalSystems: [],
    capabilityCeiling: ["edit", "read"],
    maximumTopologyExpansion: 8,
    mandatoryVerificationIds: [],
    forbiddenChangeKinds: ["delete_repository"],
  };
}

function dependency(generation = 1): ProgramSemanticWorkItemV1 {
  return {
    workItemId: dependencyId,
    creationOrder: 0,
    description: "Prepare dependency",
    dependencyIds: [],
    affectedPaths: ["src/a.ts"],
    workItemGeneration: generation,
    requirementState: "required",
    topologyState: "leaf",
    satisfactionState: "satisfied",
    parentWorkItemId: null,
    authorityEnvelope: envelope(),
  };
}

function target(generation = 3, authorityEnvelope = envelope()): ProgramSemanticWorkItemV1 {
  return {
    workItemId: workId,
    creationOrder: 1,
    description: "Execute adaptive work",
    dependencyIds: [dependencyId],
    affectedPaths: ["src/b.ts"],
    workItemGeneration: generation,
    requirementState: "required",
    topologyState: "leaf",
    satisfactionState: "active",
    parentWorkItemId: null,
    authorityEnvelope,
  };
}

function semanticState(revision = r1, dependencyGeneration = 1, targetGeneration = 3, targetEnvelope = envelope()): ProgramSemanticStateV1 {
  return {
    programStateId,
    currentRevision: {
      programRevisionId: revision,
      parentProgramRevisionId: revision === r1 ? null : r1,
      ordinal: revision === r1 ? 1 : 2,
      changeClass: revision === r1 ? "initial" : "refinement",
      acceptedAtStateRevision: revision === r1 ? 1 : 8,
      admissionEventId: revision === r1 ? "authority-baseline" : "authority-r2-admission",
      sourceDraftId: revision === r1 ? null : "authority-draft-r2",
      sourceDraftDigest: revision === r1 ? null : "authority-digest-r2",
    },
    workItems: [dependency(dependencyGeneration), target(targetGeneration, targetEnvelope)],
    verification: [],
    verificationBindings: [],
    outputSlots: [],
    productionSteps: [],
  };
}

function assumptions(targetEnvelope = envelope()): ProgramAttemptSemanticAssumptionsV1 {
  return {
    programAttemptId: attemptId,
    workItemId: workId,
    workItemGeneration: 3,
    directDependencies: [{
      workItemId: dependencyId,
      workItemGeneration: 1,
      required: true,
      satisfiedOrDischargedAtIssue: true,
    }],
    workAuthorityEnvelope: targetEnvelope,
  };
}

function snapshot(state = semanticState(), activeAttempt: ProgramAttemptSemanticAssumptionsV1 | null = assumptions()): ProgramSemanticCurrentSnapshotV1 {
  return {
    programStateRevision: 7,
    semanticState: state,
    activeAttempt,
    lifecycle: "active",
    attachedSessionIds: ["session-authority"],
  };
}

function facts(semantic = snapshot()): ProgramAttemptAuthorityFactsV2 {
  return {
    semantic,
    runtime: {
      programAttemptId: String(attemptId),
      sessionId: "session-authority",
      agentGeneration: 4,
      sessionActive: true,
      agentGenerationCurrent: true,
      recoveryClear: true,
      writerBarriersClear: true,
      quiescenceClear: true,
      executionBaseCurrent: true,
    },
  };
}

describe("A1 ProgramAttemptAuthorityV2", () => {
  it("is exported through the public host-runtime package root", () => {
    expect(issueProgramAttemptAuthorityV2FromPackage).toBe(issueProgramAttemptAuthorityV2);
  });

  it("issues exact work/dependency/constraint receipts", () => {
    const authority = issueProgramAttemptAuthorityV2(facts());
    expect(authority.authorityVersion).toBe(2);
    expect(authority.issuedUnderProgramRevisionId).toBe(String(r1));
    expect(authority.workItemGeneration).toBe(3);
    expect(authority.dependencyReceipt.entries).toEqual([{
      workItemId: String(dependencyId),
      workItemGeneration: 1,
      required: true,
      satisfiedOrDischargedAtIssue: true,
    }]);
    expect(authority.constraintReceipt.mandatoryConstraintIds).toEqual([]);
  });

  it("uses the semantic kernel's ordinal dependency ordering", () => {
    const upper = asProgramWorkItemId("Z");
    const lower = asProgramWorkItemId("a");
    const upperDependency = { ...dependency(), workItemId: upper, creationOrder: 0 };
    const lowerDependency = { ...dependency(), workItemId: lower, creationOrder: 1 };
    const mixedTarget = { ...target(), creationOrder: 2, dependencyIds: [lower, upper] };
    const state: ProgramSemanticStateV1 = {
      ...semanticState(),
      workItems: [upperDependency, lowerDependency, mixedTarget],
    };
    const activeAttempt: ProgramAttemptSemanticAssumptionsV1 = {
      ...assumptions(),
      directDependencies: [
        { workItemId: upper, workItemGeneration: 1, required: true, satisfiedOrDischargedAtIssue: true },
        { workItemId: lower, workItemGeneration: 1, required: true, satisfiedOrDischargedAtIssue: true },
      ],
    };
    const authority = issueProgramAttemptAuthorityV2(facts(snapshot(state, activeAttempt)));
    expect(authority.dependencyReceipt.entries.map((entry) => entry.workItemId)).toEqual(["Z", "a"]);
  });

  it("fails closed before recursive discharge when the semantic dependency graph is invalid", () => {
    const cycleAId = asProgramWorkItemId("cycle-a");
    const cycleBId = asProgramWorkItemId("cycle-b");
    const cycleA: ProgramSemanticWorkItemV1 = {
      ...dependency(),
      workItemId: cycleAId,
      creationOrder: 0,
      dependencyIds: [cycleBId],
    };
    const cycleB: ProgramSemanticWorkItemV1 = {
      ...dependency(),
      workItemId: cycleBId,
      creationOrder: 1,
      dependencyIds: [cycleAId],
    };
    const cycleTarget: ProgramSemanticWorkItemV1 = {
      ...target(),
      creationOrder: 2,
      dependencyIds: [cycleAId],
    };
    const state: ProgramSemanticStateV1 = {
      ...semanticState(),
      workItems: [cycleA, cycleB, cycleTarget],
    };
    expect(() => issueProgramAttemptAuthorityV2(facts(snapshot(state, assumptions()))))
      .toThrow("semantic_state_invalid");
  });

  it("retains authority across an unrelated semantic ProgramRevision", () => {
    const authority = issueProgramAttemptAuthorityV2(facts());
    const later = snapshot(semanticState(r2), assumptions());
    expect(evaluateProgramAttemptAuthorityV2(authority, facts(later))).toEqual({ current: true });
    expect(authority.issuedUnderProgramRevisionId).toBe(String(r1));
    expect(String(later.semanticState.currentRevision.programRevisionId)).toBe(String(r2));
  });

  it("invalidates target and direct-dependency generation changes", () => {
    const authority = issueProgramAttemptAuthorityV2(facts());
    const targetChanged = snapshot(semanticState(r2, 1, 4), {
      ...assumptions(),
      workItemGeneration: 4,
    });
    expect(evaluateProgramAttemptAuthorityV2(authority, facts(targetChanged)))
      .toEqual({ current: false, reason: "work_generation_stale" });

    const dependencyChanged = snapshot(semanticState(r2, 2), {
      ...assumptions(),
      directDependencies: [{
        workItemId: dependencyId,
        workItemGeneration: 2,
        required: true,
        satisfiedOrDischargedAtIssue: true,
      }],
    });
    expect(evaluateProgramAttemptAuthorityV2(authority, facts(dependencyChanged)))
      .toEqual({ current: false, reason: "dependency_receipt_stale" });
  });

  it("invalidates an exact authority-envelope change", () => {
    const authority = issueProgramAttemptAuthorityV2(facts());
    const narrowed = envelope(["src"]);
    const changed = snapshot(semanticState(r2, 1, 3, narrowed), assumptions(narrowed));
    expect(evaluateProgramAttemptAuthorityV2(authority, facts(changed)))
      .toEqual({ current: false, reason: "constraint_receipt_stale" });
  });

  it.each([
    ["agentGenerationCurrent", false, "agent_generation_stale"],
    ["recoveryClear", false, "recovery_barrier"],
    ["writerBarriersClear", false, "writer_barrier"],
    ["quiescenceClear", false, "quiescence_barrier"],
    ["executionBaseCurrent", false, "execution_base_stale"],
  ] as const)("fails closed when %s is false", (field, value, reason) => {
    const original = facts();
    const authority = issueProgramAttemptAuthorityV2(original);
    const changed = facts();
    changed.runtime[field] = value;
    expect(evaluateProgramAttemptAuthorityV2(authority, changed)).toEqual({ current: false, reason });
  });

  it("does not issue authority without a current Attempt", () => {
    expect(() => issueProgramAttemptAuthorityV2(facts(snapshot(semanticState(), null))))
      .toThrow("attempt_missing");
  });
});
