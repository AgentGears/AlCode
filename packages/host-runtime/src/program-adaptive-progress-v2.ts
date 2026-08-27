import type { ProgramProgressProposalV2 } from "@alcode/agent-protocol";
import {
  asProgramStateId as asEventProgramStateId,
  asWorkspaceId,
  mkEventId,
  uuidv7,
  type EventDraft,
  type PersistedDomainEvent,
  type SessionId,
} from "@alcode/events";
import {
  ProgramTransitionError,
  applyProgramTransition,
  asOperationId,
  asProgramEvidenceRefId,
  asVerificationObligationId,
  canonicalStringify,
  type ProgramEvidenceReference,
  type ProgramState,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import {
  adaptiveTransitionEventV2,
  materializeAdaptiveRetainedAttemptProgramStateV2,
  requireAdaptiveRawProgramStateV2,
} from "./program-adaptive-admission-v2.ts";
import type {
  ProgramAdaptiveExecutionCutV2,
  ProgramAdaptiveProgressAdmissionV2,
} from "./program-agent-v2.ts";
import type { ProgramSemanticCurrentStateSourceV1 } from "./program-revision.ts";

export class ProgramAdaptiveProgressControlErrorV2 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramAdaptiveProgressControlErrorV2";
  }
}

export class ProgramAdaptiveProgressStaleErrorV2 extends ProgramAdaptiveProgressControlErrorV2 {
  constructor(message: string) {
    super(message);
    this.name = "ProgramAdaptiveProgressStaleErrorV2";
  }
}

export interface ProgramAdaptiveProgressServiceOptionsV2 {
  store: WorkspaceEventStore;
  admission: CanonicalAdmissionQueue;
  currentState: ProgramSemanticCurrentStateSourceV1;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function replayAll(store: WorkspaceEventStore): Promise<PersistedDomainEvent<string, unknown>[]> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

function requireOwnedOperation(
  events: readonly PersistedDomainEvent<string, unknown>[],
  message: ProgramProgressProposalV2,
  operationId: string,
): void {
  const requested = events.find((event) => event.type === "operation.requested"
    && String(event.operationId ?? record(event.payload).operationId ?? "") === operationId);
  if (requested === undefined) throw new ProgramAdaptiveProgressControlErrorV2(`Unknown source operation ${operationId}`);
  const payload = record(requested.payload);
  if (String(requested.sessionId) !== message.sessionId
      || String(requested.programStateId ?? "") !== message.authority.programStateId
      || String(payload.programAttemptId ?? "") !== message.authority.programAttemptId
      || String(payload.workItemId ?? "") !== message.authority.workItemId
      || Number(payload.agentGeneration) !== message.authority.agentGeneration) {
    throw new ProgramAdaptiveProgressControlErrorV2("Source operation is not owned by the current adaptive ProgramAttempt");
  }
}

function requireArtifactOwnedByWork(state: ProgramState, workItemId: string, artifactRef: string): void {
  const artifact = state.artifacts.find((item) => item.artifactRef === artifactRef);
  if (artifact === undefined) throw new ProgramAdaptiveProgressControlErrorV2(`Unknown ArtifactRef ${artifactRef}`);
  if (artifact.productionStepId === null) {
    throw new ProgramAdaptiveProgressControlErrorV2("Adaptive progress cannot bind an unscoped ArtifactRef as decisive evidence");
  }
  const step = state.productionSteps.find((item) => item.productionStepId === artifact.productionStepId);
  if (step === undefined || String(step.producerWorkItemId) !== workItemId) {
    throw new ProgramAdaptiveProgressControlErrorV2("ArtifactRef is not produced by the current adaptive WorkItem");
  }
}

function requireVerification(state: ProgramState, id: string): void {
  const obligationId = asVerificationObligationId(id);
  if (!state.verification.some((item) => item.obligationId === obligationId)) {
    throw new ProgramAdaptiveProgressControlErrorV2(`Unknown current verification obligation ${id}`);
  }
}

function priorAdvisoryReport(
  events: readonly PersistedDomainEvent<string, unknown>[],
  message: ProgramProgressProposalV2,
  reportId: string,
): PersistedDomainEvent<string, unknown> | undefined {
  let reported: PersistedDomainEvent<string, unknown> | undefined;
  let resolved = false;
  for (const event of events) {
    if (String(event.programStateId ?? "") !== message.authority.programStateId) continue;
    const payload = record(event.payload);
    if (String(payload.reportId ?? "") !== reportId
        || String(payload.programAttemptId ?? "") !== message.authority.programAttemptId
        || String(payload.workItemId ?? "") !== message.authority.workItemId
        || Number(payload.agentGeneration) !== message.authority.agentGeneration) continue;
    if (event.type === "program.agent_advisory.reported") {
      reported = event;
      resolved = false;
    } else if (event.type === "program.agent_advisory.resolved") {
      resolved = true;
    }
  }
  return reported !== undefined && !resolved ? reported : undefined;
}

function advisoryDraft(
  store: WorkspaceEventStore,
  message: ProgramProgressProposalV2,
  advisory: ProgramProgressProposalV2["advisoryBlockers"][number],
): EventDraft<string, unknown> {
  const payload: Record<string, unknown> = {
    reportId: advisory.reportId,
    programAttemptId: message.authority.programAttemptId,
    workItemId: message.authority.workItemId,
    agentGeneration: message.authority.agentGeneration,
    advisoryOnly: true,
  };
  if (advisory.action === "report") {
    payload.scope = advisory.scope;
    payload.reason = advisory.reason;
  }
  return {
    eventId: mkEventId(),
    correlationId: message.authority.programAttemptId,
    workspaceId: asWorkspaceId(store.workspaceId),
    sessionId: message.sessionId as SessionId,
    programStateId: asEventProgramStateId(message.authority.programStateId),
    occurredAt: new Date().toISOString(),
    type: advisory.action === "report"
      ? "program.agent_advisory.reported"
      : "program.agent_advisory.resolved",
    payload,
    payloadSchemaVersion: 1,
    producer: { kind: "runtime", component: "program-adaptive-progress-v2" },
  };
}

function sameCut(current: Awaited<ReturnType<ProgramSemanticCurrentStateSourceV1["current"]>>, cut: ProgramAdaptiveExecutionCutV2): boolean {
  return current.programStateRevision === cut.facts.semantic.programStateRevision
    && String(current.semanticState.currentRevision.programRevisionId)
      === String(cut.facts.semantic.semanticState.currentRevision.programRevisionId)
    && canonicalStringify(current.activeAttempt) === canonicalStringify(cut.facts.semantic.activeAttempt);
}

export class ProgramAdaptiveProgressServiceV2 implements ProgramAdaptiveProgressAdmissionV2 {
  constructor(private readonly options: ProgramAdaptiveProgressServiceOptionsV2) {}

  async admit(input: {
    message: ProgramProgressProposalV2;
    cut: ProgramAdaptiveExecutionCutV2;
  }): Promise<{
    outcome: "admitted" | "stale" | "denied" | "failed";
    errorCode?: string;
    error?: string;
  }> {
    try {
      return await this.options.admission.enqueue(async () => {
        const { message, cut } = input;
        const current = await this.options.currentState.current(message.authority.programStateId);
        if (!sameCut(current, cut)
            || current.activeAttempt === null
            || String(current.activeAttempt.programAttemptId) !== message.authority.programAttemptId) {
          throw new ProgramAdaptiveProgressStaleErrorV2("Adaptive semantic/operational currentness changed before progress admission");
        }
        if (message.evidence.length === 0
            && message.advisoryBlockers.length === 0
            && !message.requestAwaitingVerification) {
          throw new ProgramAdaptiveProgressControlErrorV2("Adaptive progress proposal contains no intent");
        }

        const events = await replayAll(this.options.store);
        const raw = requireAdaptiveRawProgramStateV2(events, message.authority.programStateId);
        let next = materializeAdaptiveRetainedAttemptProgramStateV2(raw, current);
        const drafts: EventDraft<string, unknown>[] = [];

        for (const proposed of message.evidence) {
          if (proposed.sourceOperationId !== undefined) requireOwnedOperation(events, message, proposed.sourceOperationId);
          if (proposed.artifactRef !== undefined) {
            requireArtifactOwnedByWork(next, message.authority.workItemId, proposed.artifactRef);
          }
          if (proposed.verificationObligationId !== undefined) requireVerification(next, proposed.verificationObligationId);
          const evidence: ProgramEvidenceReference = {
            evidenceRefId: asProgramEvidenceRefId(uuidv7()),
            workItemId: next.activeAttempt!.workItemId,
            verificationObligationId: proposed.verificationObligationId === undefined
              ? null
              : asVerificationObligationId(proposed.verificationObligationId),
            sourceOperationId: proposed.sourceOperationId === undefined ? null : asOperationId(proposed.sourceOperationId),
            artifactRef: proposed.artifactRef ?? null,
          };
          next = applyProgramTransition(next, {
            kind: "evidence.add",
            expectedProgramRevision: next.revision,
            evidence,
          });
          drafts.push(adaptiveTransitionEventV2(
            this.options.store,
            message.sessionId as SessionId,
            next,
            "evidence.add",
            message.authority.programAttemptId,
            "program-adaptive-progress-v2",
          ));
        }

        const advisorySeen = new Set<string>();
        for (const advisory of message.advisoryBlockers) {
          if (advisorySeen.has(advisory.reportId)) {
            throw new ProgramAdaptiveProgressControlErrorV2(`Duplicate advisory reportId ${advisory.reportId}`);
          }
          advisorySeen.add(advisory.reportId);
          const existing = priorAdvisoryReport(events, message, advisory.reportId);
          if (advisory.action === "report" && existing !== undefined) {
            throw new ProgramAdaptiveProgressControlErrorV2(`Advisory reportId already active: ${advisory.reportId}`);
          }
          if (advisory.action === "resolve" && existing === undefined) {
            throw new ProgramAdaptiveProgressControlErrorV2(`Advisory reportId is not active: ${advisory.reportId}`);
          }
          drafts.push(advisoryDraft(this.options.store, message, advisory));
        }

        if (message.requestAwaitingVerification) {
          const attempt = next.activeAttempt;
          if (attempt === null || String(attempt.programAttemptId) !== message.authority.programAttemptId) {
            throw new ProgramAdaptiveProgressStaleErrorV2("Adaptive ProgramAttempt changed before awaiting-verification admission");
          }
          const work = next.workItems.find((item) => item.workItemId === attempt.workItemId);
          if (work === undefined || work.lifecycle !== "in_progress") {
            throw new ProgramAdaptiveProgressControlErrorV2("Only current in_progress adaptive work may request awaiting_verification");
          }
          next = applyProgramTransition(next, {
            kind: "work.lifecycle.set",
            expectedProgramRevision: next.revision,
            workItemId: attempt.workItemId,
            lifecycle: "awaiting_verification",
          });
          drafts.push(adaptiveTransitionEventV2(
            this.options.store,
            message.sessionId as SessionId,
            next,
            "work.lifecycle.set:awaiting_verification",
            message.authority.programAttemptId,
            "program-adaptive-progress-v2",
          ));
        }

        if (drafts.length > 0) await this.options.store.append(drafts);
        return { outcome: "admitted" as const };
      });
    } catch (error) {
      if (error instanceof ProgramAdaptiveProgressStaleErrorV2) {
        return { outcome: "stale", errorCode: "program_execution_stale", error: error.message };
      }
      if (error instanceof ProgramAdaptiveProgressControlErrorV2 || error instanceof ProgramTransitionError) {
        return { outcome: "denied", errorCode: "program_progress_invalid", error: error instanceof Error ? error.message : String(error) };
      }
      return { outcome: "failed", errorCode: "program_progress_failed", error: error instanceof Error ? error.message : String(error) };
    }
  }
}
