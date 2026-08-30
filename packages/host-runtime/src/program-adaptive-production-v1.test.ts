import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ProgramAttemptProjectionV1 } from "@alcode/agent-protocol";
import type { PersistedDomainEvent } from "@alcode/events";
import {
  applyProgramTransition,
  asProgramAttemptId,
  asProgramRevisionId,
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  createProgramState,
  type ProgramSemanticStateV1,
  type WorkAuthorityEnvelopeV1,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import { issueProgramAttemptAuthorityV2 } from "./program-attempt-authority-v2.ts";
import { ProgramAdaptiveRootOperationAuthorityV2 } from "./program-adaptive-operation-v2.ts";
import type { ProgramRootOperationAuthorityV1 } from "./program-dispatch.ts";
import {
  ProgramAdaptiveOperationalCurrentStateSourceV2,
  validatePostSemanticProgramStateSequenceV2,
} from "./program-adaptive-operational-v2.ts";
import {
  ProgramAdaptiveProductionCompositionErrorV1,
  ProgramAdaptiveProductionCutSourceV1,
  adaptiveRawProgramRevisionV1,
} from "./program-adaptive-production-v1.ts";

const sessionId = "018f0000-0000-7000-8000-000000000c01";
const programStateId = asProgramStateId("018f0000-0000-7000-8000-000000000c02");
const dependencyId = asProgramWorkItemId("adaptive-production-dependency");
const workItemId = asProgramWorkItemId("adaptive-production-work");
const attemptId = asProgramAttemptId("adaptive-production-attempt");
const revisionId = asProgramRevisionId("adaptive-production-r7");

function envelope(): WorkAuthorityEnvelopeV1 {
  return {
    objectiveBoundaryRef: {
      programStateId,
      rootProgramRevisionId: revisionId,
      anchorWorkItemId: workItemId,
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

function semanticState(): ProgramSemanticStateV1 {
  return {
    programStateId,
    currentRevision: {
      programRevisionId: revisionId,
      parentProgramRevisionId: asProgramRevisionId("adaptive-production-r6"),
      ordinal: 7,
      changeClass: "refinement",
      acceptedAtStateRevision: 37,
      admissionEventId: "semantic-admission-7",
      sourceDraftId: "semantic-draft-7",
      sourceDraftDigest: "semantic-digest-7",
    },
    workItems: [
      {
        workItemId: dependencyId,
        creationOrder: 0,
        description: "Current completed dependency",
        dependencyIds: [],
        affectedPaths: ["src/dependency.ts"],
        workItemGeneration: 3,
        requirementState: "required",
        topologyState: "leaf",
        satisfactionState: "satisfied",
        parentWorkItemId: null,
        authorityEnvelope: envelope(),
      },
      {
        workItemId,
        creationOrder: 1,
        description: "Current semantic target",
        dependencyIds: [dependencyId],
        affectedPaths: ["src/current.ts"],
        workItemGeneration: 4,
        requirementState: "required",
        topologyState: "leaf",
        satisfactionState: "active",
        parentWorkItemId: null,
        authorityEnvelope: envelope(),
      },
    ],
    verification: [],
    verificationBindings: [],
    outputSlots: [],
    productionSteps: [],
  };
}

function semanticSnapshot() {
  return {
    programStateRevision: 37,
    semanticState: semanticState(),
    activeAttempt: {
      programAttemptId: attemptId,
      workItemId,
      workItemGeneration: 4,
      directDependencies: [{
        workItemId: dependencyId,
        workItemGeneration: 3,
        required: true as const,
        satisfiedOrDischargedAtIssue: true as const,
      }],
      workAuthorityEnvelope: envelope(),
    },
    lifecycle: "active" as const,
    attachedSessionIds: [sessionId],
  };
}

function legacyProjection(): ProgramAttemptProjectionV1 {
  return {
    version: 1,
    authority: {
      programStateId: String(programStateId),
      expectedProgramRevision: 21,
      programAttemptId: String(attemptId),
      workItemId: String(workItemId),
      agentGeneration: 9,
    },
    objective: "Adaptive production objective",
    work: {
      description: "Legacy operational description",
      lifecycle: "in_progress",
      dependencyIds: [String(dependencyId)],
      affectedPaths: ["src/current.ts"],
      omittedAffectedPathCount: 0,
    },
    dependencies: [{ workItemId: String(dependencyId), lifecycle: "completed" }],
    blockers: [],
    executionBase: {
      workspaceEffectGeneration: 2,
      observation: {
        kind: "workspace-observation-v1",
        providerKind: "git",
        workspaceIdentity: "workspace-adaptive-production",
        coverageDigest: "coverage-2",
        stateDigest: "state-2",
      },
    },
    verification: [],
    outputSlots: [],
    productionSteps: [],
    decisiveEvidence: [],
    artifacts: [],
    control: { executionBaseMismatch: false, executionBaseUnavailable: false },
    omissions: { verification: 0, blockers: 0, evidence: 0, artifacts: 0 },
    stopConditions: {
      attemptMustRemainCurrent: true,
      rebaseRequiredOnExecutionBaseMismatch: true,
      hostOwnsVerificationAndCompletion: true,
    },
  };
}

const coordinator = {
  async runExclusive<T>(work: () => Promise<T>): Promise<T> { return work(); },
};

function cutSource(overrides: { operationAttemptId?: string } = {}) {
  const semantic = {
    currentForSession: async () => structuredClone(semanticSnapshot()),
  } as unknown as ProgramAdaptiveOperationalCurrentStateSourceV2;
  const operations = {
    resolveCurrentOperation: async () => ({
      programStateId: String(programStateId),
      expectedProgramRevision: 21,
      programAttemptId: overrides.operationAttemptId ?? String(attemptId),
      workItemId: String(workItemId),
      agentGeneration: 9,
    }),
  } as unknown as ProgramRootOperationAuthorityV1;
  return new ProgramAdaptiveProductionCutSourceV1({
    workspaceCoordinator: coordinator,
    semantic,
    operational: {
      currentForSession: async () => ({
        hasActiveAttachedExecutionEpisode: true,
        workspaceReservationAvailable: true,
        recoveryClear: true,
        writerBarriersClear: true,
        quiescenceClear: true,
        executionBaseCurrent: true,
        openCanonicalBlockers: [],
      }),
    },
    agents: {
      currentAttemptProjection: async () => legacyProjection(),
      isCurrentConnection: () => true,
      currentAgentGeneration: () => 9,
    },
    operations,
  });
}

function rawProgramState(revision: number) {
  const state = createProgramState({
    programStateId,
    sourceSessionId: sessionId as never,
    objective: "Raw adaptive revision",
    workItems: [{
      workItemId,
      creationOrder: 0,
      description: "Raw work",
      dependencyIds: [],
      affectedPaths: ["src/raw.ts"],
    }],
    verification: [],
    outputSlots: [],
    productionSteps: [],
  });
  return { ...state, revision };
}

function storeWithRawRevision(revision: number): WorkspaceEventStore {
  const state = rawProgramState(revision);
  const event = {
    sequence: 1,
    eventId: "raw-program-state-event",
    workspaceId: "workspace-adaptive-production",
    sessionId,
    programStateId: String(programStateId),
    occurredAt: "2026-08-29T00:00:00.000Z",
    type: "program.created",
    payload: { state },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "test" },
  } as unknown as PersistedDomainEvent<string, unknown>;
  return {
    workspaceId: "workspace-adaptive-production",
    replay: async function* () { yield event; },
  } as unknown as WorkspaceEventStore;
}

function adaptiveVerificationOperationFixture() {
  const executionBase = {
    workspaceEffectGeneration: 0,
    observation: {
      kind: "workspace-observation-v1" as const,
      providerKind: "test",
      workspaceIdentity: "workspace-adaptive-production",
      coverageDigest: "coverage-verification",
      stateDigest: "state-verification",
    },
  };
  const initial = createProgramState({
    programStateId,
    sourceSessionId: asSessionId(sessionId),
    objective: "Adaptive verification operation CAS",
    workItems: [{
      workItemId,
      creationOrder: 0,
      description: "Verify retained adaptive work",
      dependencyIds: [],
      affectedPaths: ["src/current.ts"],
    }],
    verification: [],
    outputSlots: [],
    productionSteps: [],
  });
  const issued = applyProgramTransition(initial, {
    kind: "attempt.issue",
    expectedProgramRevision: initial.revision,
    attempt: {
      programAttemptId: attemptId,
      workItemId,
      sessionId: asSessionId(sessionId),
      agentGeneration: 9,
      initialExecutionBase: executionBase,
      expectedExecutionBase: executionBase,
    },
  });
  const raw = { ...issued, revision: 21 };
  const events: PersistedDomainEvent<string, unknown>[] = [
    {
      sequence: 1,
      eventId: "adaptive-verification-session-started",
      workspaceId: "workspace-adaptive-production",
      sessionId,
      occurredAt: "2026-08-29T00:00:00.000Z",
      type: "runtime.session.started",
      payload: { sessionId },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "test" },
    } as unknown as PersistedDomainEvent<string, unknown>,
    {
      sequence: 2,
      eventId: "adaptive-verification-raw-program",
      workspaceId: "workspace-adaptive-production",
      sessionId,
      programStateId: String(programStateId),
      occurredAt: "2026-08-29T00:00:01.000Z",
      type: "program.transitioned",
      payload: { state: raw, transitionKind: "attempt.issue" },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "test" },
    } as unknown as PersistedDomainEvent<string, unknown>,
  ];
  const store = {
    workspaceId: "workspace-adaptive-production",
    replay: async function* () { for (const event of events) yield event; },
    append: async (drafts: readonly unknown[]) => {
      const persisted = drafts.map((draft, index) => ({
        ...(draft as Record<string, unknown>),
        sequence: events.length + index + 1,
      })) as unknown as PersistedDomainEvent<string, unknown>[];
      events.push(...persisted);
      return persisted;
    },
  } as unknown as WorkspaceEventStore;
  const delegate = {
    resolveCurrentOperation: async () => null,
    appendRoutedRootOperation: async () => { throw new Error("unexpected fixed-topology delegation"); },
    appendRootOperation: async () => { throw new Error("unexpected fixed-topology delegation"); },
    settleProgramMutation: async () => { throw new Error("unexpected fixed-topology delegation"); },
  } as unknown as ProgramRootOperationAuthorityV1;
  const authority = new ProgramAdaptiveRootOperationAuthorityV2({
    store,
    admission: { enqueue: <T>(work: () => Promise<T>) => work() } as never,
    workspaceCoordinator: coordinator,
    observations: { observe: async () => ({ status: "complete" as const, base: executionBase }) },
    currentState: { current: async () => structuredClone(semanticSnapshot()) },
    agentGenerations: { isCurrent: async () => true },
    recovery: { isClear: async () => true },
    delegate,
  });
  const input = (expectedProgramRevision: number) => ({
    sessionId: sessionId as never,
    operationId: "adaptive-host-verification-operation",
    workspaceAccessClass: "read_only" as const,
    program: {
      programStateId: String(programStateId),
      expectedProgramRevision,
      programAttemptId: String(attemptId),
      workItemId: String(workItemId),
      agentGeneration: 9,
    },
    drafts: [{
      eventId: "adaptive-host-verification-request",
      workspaceId: "workspace-adaptive-production",
      sessionId,
      operationId: "adaptive-host-verification-operation",
      occurredAt: "2026-08-29T00:00:02.000Z",
      type: "operation.requested",
      payload: {
        operationId: "adaptive-host-verification-operation",
        workspaceAccessClass: "read_only",
        programVerificationInvocation: {
          kind: "operation_result",
          specId: "verify-spec",
          specVersion: 1,
          canonicalArgsDigest: "verify-digest",
          verificationObligationId: "verify-current",
          subjectGeneration: 1,
        },
      },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "host-capability-broker" },
    }],
  }) as unknown as Parameters<ProgramAdaptiveRootOperationAuthorityV2["appendRoutedRootOperation"]>[0];
  return { authority, events, input };
}

describe("A1 production adaptive runtime composition", () => {
  it("builds V2 authority from semantic generations while preserving the independent operational CAS lease", async () => {
    const cut = await cutSource().currentForSession(sessionId, "connection-9");
    expect(cut).toBeDefined();
    expect(cut!.operationalProgramContext.expectedProgramRevision).toBe(21);
    expect(cut!.facts.semantic.programStateRevision).toBe(37);
    expect(cut!.projection.work).toMatchObject({
      description: "Current semantic target",
      satisfactionState: "active",
      dependencyIds: [String(dependencyId)],
    });
    expect(cut!.projection.dependencies).toEqual([{
      workItemId: String(dependencyId),
      workItemGeneration: 3,
      requirementState: "required",
      satisfiedOrDischarged: true,
    }]);

    const authority = issueProgramAttemptAuthorityV2(cut!.facts);
    expect(authority).toMatchObject({
      issuedUnderProgramRevisionId: String(revisionId),
      programAttemptId: String(attemptId),
      workItemId: String(workItemId),
      workItemGeneration: 4,
      agentGeneration: 9,
    });
    expect(authority.dependencyReceipt.entries).toEqual([{
      workItemId: String(dependencyId),
      workItemGeneration: 3,
      required: true,
      satisfiedOrDischargedAtIssue: true,
    }]);
  });

  it("fails closed when raw operational ownership disagrees with semantic Attempt identity", async () => {
    await expect(cutSource({ operationAttemptId: "different-attempt" })
      .currentForSession(sessionId, "connection-9"))
      .rejects.toBeInstanceOf(ProgramAdaptiveProductionCompositionErrorV1);
  });

  it("treats adaptive verification transitions as exact trusted post-semantic anchors", () => {
    const state = rawProgramState(38);
    const verificationAnchor = {
      sequence: 10,
      eventId: "verification-anchor",
      workspaceId: "workspace-adaptive-production",
      sessionId,
      programStateId: String(programStateId),
      occurredAt: "2026-08-29T00:00:01.000Z",
      type: "program.transitioned",
      payload: { state, transitionKind: "attempt.interrupt:verified" },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "program-adaptive-verification-v2" },
    } as unknown as PersistedDomainEvent<string, unknown>;
    expect(validatePostSemanticProgramStateSequenceV2(
      [verificationAnchor],
      String(programStateId),
      9,
      37,
    )?.state.revision).toBe(38);
  });

  it("reads the raw operational CAS revision instead of the semantic/Application max revision", async () => {
    expect(await adaptiveRawProgramRevisionV1(storeWithRawRevision(21), String(programStateId))).toBe(21);
  });

  it("binds trusted Host verification operations to the raw CAS revision after exact semantic-currentness validation", async () => {
    const fixture = adaptiveVerificationOperationFixture();
    const result = await fixture.authority.appendRoutedRootOperation(fixture.input(37));
    expect(result.status).toBe("appended");
    if (result.status !== "appended") throw new Error("expected appended verification operation");
    expect(result.program?.expectedProgramRevision).toBe(21);
    const requested = result.events.find((event) => event.type === "operation.requested");
    expect((requested?.payload as Record<string, unknown>).expectedProgramRevision).toBe(21);
  });

  it("does not use the raw CAS bridge to admit a stale semantic Host verification request", async () => {
    const fixture = adaptiveVerificationOperationFixture();
    await expect(fixture.authority.appendRoutedRootOperation(fixture.input(36)))
      .rejects.toThrow("Adaptive Host verification semantic revision mismatch: expected 36, current 37");
    expect(fixture.events).toHaveLength(2);
  });

  it("binds trusted Host artifact production to the same raw CAS revision", async () => {
    const fixture = adaptiveVerificationOperationFixture();
    const input = fixture.input(37);
    const requested = input.drafts[0]! as unknown as { payload: Record<string, unknown> };
    requested.payload.programVerificationInvocation = {
      kind: "artifact_production",
      specId: "produce-spec",
      specVersion: 1,
      canonicalArgsDigest: "produce-digest",
      productionStepId: "produce-current",
      outputSlotId: "slot-current",
    };
    const result = await fixture.authority.appendRoutedRootOperation(input);
    expect(result.status).toBe("appended");
    if (result.status !== "appended") throw new Error("expected appended artifact-production operation");
    expect(result.program?.expectedProgramRevision).toBe(21);
  });

  it("composes around the existing V1 Host and installs a delegating adaptive operation authority", () => {
    const source = readFileSync(new URL("./program-adaptive-production-v1.ts", import.meta.url), "utf8");
    expect(source).not.toContain("new HostRuntime(");
    expect(source).toContain("fixed.host.setProgramOperationAuthority(operationAuthority);");
    expect(source).toContain("delegate: fixed.dispatch");
    expect(source).toContain("adoption: baseline");
    expect(source).toContain("attemptHistory: currentState");
    expect(source).toContain("currentOperationalRevision");
    expect(source).not.toContain("revision === 1");
  });
});
