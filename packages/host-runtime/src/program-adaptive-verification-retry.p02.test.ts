import { describe, expect, it } from "vitest";
import type { EventDraft, PersistedDomainEvent } from "@alcode/events";
import {
  applyProgramTransition,
  asProgramAttemptId,
  asProgramRevisionId,
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  asVerificationObligationId,
  createProgramState,
  type ProgramSemanticStateV1,
  type WorkAuthorityEnvelopeV1,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import { planningCanonicalDigest } from "./planning-read.ts";
import {
  ProgramAdaptiveVerificationControlV2,
} from "./program-adaptive-verification-control-v2.ts";
import type { ProgramAdaptiveOperationalCurrentStateSourceV2 } from "./program-adaptive-operational-v2.ts";
import type { ProgramVerificationServiceV1 } from "./program-verification.ts";

const sessionId = asSessionId("018f0000-0000-7000-8000-00000000d201");
const programStateId = asProgramStateId("018f0000-0000-7000-8000-00000000d202");
const workItemId = asProgramWorkItemId("p02-retry-work");
const attemptId = asProgramAttemptId("p02-retry-attempt-1");
const obligationId = asVerificationObligationId("p02-retry-typecheck");
const revisionId = asProgramRevisionId("p02-retry-r1");
const operationId = "018f0000-0000-7000-8000-00000000d203";
const command = "pnpm --filter @alcode/host-runtime typecheck";
const canonicalArgs = { command } as const;
const executionBase = {
  workspaceEffectGeneration: 0,
  observation: {
    kind: "workspace-observation-v1" as const,
    providerKind: "test",
    workspaceIdentity: "018f0000-0000-7000-8000-00000000d204",
    coverageDigest: "coverage-p02-retry",
    stateDigest: "state-p02-retry",
  },
};

function authorityEnvelope(): WorkAuthorityEnvelopeV1 {
  return {
    objectiveBoundaryRef: {
      programStateId,
      rootProgramRevisionId: revisionId,
      anchorWorkItemId: workItemId,
    },
    allowedRepositoryRoots: ["."],
    allowedEffectClasses: ["fs.read", "fs.write"],
    allowedExternalSystems: [],
    capabilityCeiling: ["bash", "edit", "read"],
    maximumTopologyExpansion: 8,
    mandatoryVerificationIds: [obligationId],
    forbiddenChangeKinds: ["delete_repository"],
  };
}

function fixture() {
  const initial = createProgramState({
    programStateId,
    sourceSessionId: sessionId,
    objective: "Retry failed typed verification with Host-owned facts",
    workItems: [{
      workItemId,
      creationOrder: 0,
      description: "Fix the package and satisfy typecheck",
      dependencyIds: [],
      affectedPaths: ["packages/host-runtime/src/example.ts"],
    }],
    verification: [{
      obligationId,
      predicate: {
        kind: "operation_result",
        specId: "package_typecheck",
        specVersion: 1,
        canonicalArgs,
        canonicalArgsDigest: planningCanonicalDigest(canonicalArgs),
      },
      freshnessScope: { kind: "workspace" },
    }],
    outputSlots: [],
    productionSteps: [],
  });
  const issued = applyProgramTransition(initial, {
    kind: "attempt.issue",
    expectedProgramRevision: initial.revision,
    attempt: {
      programAttemptId: attemptId,
      workItemId,
      sessionId,
      agentGeneration: 1,
      initialExecutionBase: executionBase,
      expectedExecutionBase: executionBase,
    },
  });
  const awaiting = applyProgramTransition(issued, {
    kind: "work.lifecycle.set",
    expectedProgramRevision: issued.revision,
    workItemId,
    lifecycle: "awaiting_verification",
  });

  const semanticState: ProgramSemanticStateV1 = {
    programStateId,
    currentRevision: {
      programRevisionId: revisionId,
      parentProgramRevisionId: null,
      ordinal: 1,
      changeClass: "initial",
      acceptedAtStateRevision: awaiting.revision,
      admissionEventId: "p02-retry-semantic-admission",
      sourceDraftId: null,
      sourceDraftDigest: null,
    },
    workItems: [{
      ...awaiting.workItems[0]!,
      workItemGeneration: 1,
      requirementState: "required",
      topologyState: "leaf",
      satisfactionState: "awaiting_verification",
      parentWorkItemId: null,
      authorityEnvelope: authorityEnvelope(),
    }],
    verification: awaiting.verification,
    verificationBindings: [{
      obligationId,
      subject: { kind: "work_item", workItemId, workItemGeneration: 1 },
    }],
    outputSlots: [],
    productionSteps: [],
  };
  const current = {
    programStateRevision: awaiting.revision,
    semanticState,
    activeAttempt: {
      programAttemptId: attemptId,
      workItemId,
      workItemGeneration: 1,
      directDependencies: [],
      workAuthorityEnvelope: authorityEnvelope(),
    },
    lifecycle: "active" as const,
    attachedSessionIds: [String(sessionId)],
  };

  const events: PersistedDomainEvent<string, unknown>[] = [{
    sequence: 1,
    eventId: "p02-retry-program-state",
    workspaceId: "018f0000-0000-7000-8000-00000000d204",
    sessionId: String(sessionId),
    programStateId: String(programStateId),
    occurredAt: "2026-09-07T00:00:00.000Z",
    type: "program.transitioned",
    payload: { state: awaiting, transitionKind: "work.lifecycle.set:awaiting_verification" },
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "test" },
  } as unknown as PersistedDomainEvent<string, unknown>];
  const appendBatches: EventDraft<string, unknown>[][] = [];
  const store = {
    workspaceId: "018f0000-0000-7000-8000-00000000d204",
    replay: async function* () { for (const event of events) yield event; },
    append: async (drafts: readonly EventDraft<string, unknown>[]) => {
      appendBatches.push([...drafts]);
      const persisted = drafts.map((draft, index) => ({
        ...draft,
        sequence: events.length + index + 1,
      })) as PersistedDomainEvent<string, unknown>[];
      events.push(...persisted);
      return persisted;
    },
  } as unknown as WorkspaceEventStore;

  const currentState = {
    currentForSession: async () => structuredClone(current),
    current: async () => structuredClone(current),
  } as unknown as ProgramAdaptiveOperationalCurrentStateSourceV2;
  const verification = {
    satisfyOperationResult: async () => {
      events.push({
        sequence: events.length + 1,
        eventId: "p02-retry-operation-evidence",
        workspaceId: "018f0000-0000-7000-8000-00000000d204",
        sessionId: String(sessionId),
        programStateId: String(programStateId),
        operationId,
        occurredAt: "2026-09-07T00:00:01.000Z",
        type: "evidence.recorded",
        payload: {
          operationId,
          toolName: "bash",
          success: false,
          outcome: "succeeded",
          exitCode: 1,
          verificationCommand: command,
        },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "host-capability-broker" },
      } as unknown as PersistedDomainEvent<string, unknown>);
      return {
        status: "not_satisfied" as const,
        reason: "Host verification operation did not satisfy stable success semantics",
        operationId,
      };
    },
    satisfyWorkspacePathState: async () => { throw new Error("unexpected path verification"); },
    satisfyArtifactPresent: async () => { throw new Error("unexpected artifact verification"); },
    executeProductionStep: async () => { throw new Error("unexpected production step"); },
  } as unknown as ProgramVerificationServiceV1;

  return {
    events,
    appendBatches,
    control: new ProgramAdaptiveVerificationControlV2({
      store,
      admission: { enqueue: <T>(work: () => Promise<T>) => work() } as never,
      currentState,
      verification,
    }),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected record");
  return value as Record<string, unknown>;
}

describe("P-02 adaptive verification retry facts", () => {
  it("atomically emits Host-derived failure facts with Attempt retirement and pending retry", async () => {
    const { control, events, appendBatches } = fixture();

    await expect(control.drive(String(sessionId))).resolves.toEqual({ status: "advanced" });
    expect(appendBatches).toHaveLength(1);
    expect(appendBatches[0]!.map((draft) => draft.type)).toEqual([
      "program.verification.failed",
      "program.transitioned",
    ]);
    expect(appendBatches[0]!.slice(1).map((draft) => record(draft.payload).transitionKind)).toEqual([
      "attempt.interrupt:verification_failed",
    ]);

    const failure = appendBatches[0]![0]!;
    const payload = record(failure.payload);
    expect(payload).toMatchObject({
      programAttemptId: String(attemptId),
      workItemId: String(workItemId),
      verificationObligationId: String(obligationId),
      sourceOperationId: operationId,
      details: {
        kind: "host_verification_failure_v1",
        verifier: {
          predicateKind: "operation_result",
          specId: "package_typecheck",
          specVersion: 1,
        },
        operation: {
          operationId,
          outcome: "succeeded",
          exitCode: 1,
          verificationCommand: command,
        },
      },
    });
    expect(JSON.parse(String(payload.reason))).toMatchObject({
      kind: "host_verification_failure_v1",
      verifier: { specId: "package_typecheck", specVersion: 1 },
      operation: { operationId, exitCode: 1, verificationCommand: command },
      summary: "Host verification operation did not satisfy stable success semantics",
    });

    const programEvents = events.filter((event) => event.type === "program.transitioned");
    const terminalOperational = record(programEvents.at(-1)!.payload).state as ReturnType<typeof createProgramState>;
    expect(terminalOperational.activeAttempt).toBeNull();
    expect(terminalOperational.workItems[0]?.lifecycle).toBe("pending");
  });
});
