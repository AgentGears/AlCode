import {
  asEventId,
  asProgramStateId as asEventProgramStateId,
  asSessionId,
  asWorkspaceId,
  uuidv7,
  type EventDraft,
} from "@alcode/events";
import { asProgramStateId } from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import type {
  ProgramDispatchWorkspaceCoordinatorV1,
  ProgramRecoveryAuthorityV1,
} from "./program-dispatch.ts";
import { planningCanonicalDigest } from "./planning-read.ts";
import {
  PROGRAM_SEMANTIC_BASELINE_DRAFT_PROFILE,
  ProgramSemanticBaselineBlockedError,
  ProgramSemanticBaselineControlError,
  ProgramSemanticBaselineStaleError,
  assertProgramSemanticBaselineDraftV1,
  baselineRequireNonEmpty,
  baselineRequirePositive,
  baselineSameCanonical,
  buildProgramSemanticBaselineCutV1,
  evaluateProgramSemanticBaselineQuiescenceV1,
  type ProgramLegacyBaselineAuthoritySourceV1,
  type ProgramSemanticBaselineAcceptCommandV1,
  type ProgramSemanticBaselineAcceptedResultV1,
  type ProgramSemanticBaselineDraftV1,
  type ProgramSemanticBaselineSealCommandV1,
} from "./program-semantic-baseline-kernel.ts";
import {
  adoptedProgramSemanticBaselineControlV1,
  invalidateProgramSemanticBaselineDraftEvent,
  latestLegacyProgramStateForBaseline,
  pendingProgramSemanticBaselineControlV1,
  reduceProgramSemanticBaselineControlsV1,
  replayProgramBaselineEvents,
  requireBaselineApplicationSession,
  sealedProgramSemanticBaselineDraftEvent,
} from "./program-semantic-baseline-replay.ts";

export interface ProgramSemanticBaselineServiceOptionsV1 {
  store: WorkspaceEventStore;
  admission: CanonicalAdmissionQueue;
  workspaceCoordinator: ProgramDispatchWorkspaceCoordinatorV1;
  recovery: ProgramRecoveryAuthorityV1;
  authority: ProgramLegacyBaselineAuthoritySourceV1;
}

export class ProgramSemanticBaselineServiceV1 {
  constructor(private readonly options: ProgramSemanticBaselineServiceOptionsV1) {}

  async sealDraft(command: ProgramSemanticBaselineSealCommandV1): Promise<ProgramSemanticBaselineDraftV1> {
    baselineRequireNonEmpty("sourceSessionId", command.sourceSessionId);
    const programStateId = String(asProgramStateId(command.programStateId));
    baselineRequirePositive("expectedProgramStateRevision", command.expectedProgramStateRevision);

    return this.options.workspaceCoordinator.runExclusive(() =>
      this.options.admission.enqueue(async () => {
        const events = await replayProgramBaselineEvents(this.options.store);
        const controls = reduceProgramSemanticBaselineControlsV1(events);
        if (adoptedProgramSemanticBaselineControlV1(controls, programStateId) !== undefined) {
          throw new ProgramSemanticBaselineStaleError(`Program ${programStateId} already adopted adaptive semantics`);
        }
        const state = latestLegacyProgramStateForBaseline(events, programStateId);
        requireBaselineApplicationSession(events, state, command.sourceSessionId);
        if (state.revision !== command.expectedProgramStateRevision) {
          throw new ProgramSemanticBaselineStaleError(
            `Baseline expected ProgramState revision ${command.expectedProgramStateRevision}; current is ${state.revision}`,
          );
        }
        const pending = pendingProgramSemanticBaselineControlV1(controls, programStateId);
        if (pending !== undefined) {
          if (pending.draft.fromProgramStateRevision === state.revision
            && pending.draft.sourceSessionId === command.sourceSessionId) {
            return structuredClone(pending.draft);
          }
          await this.options.store.append([
            invalidateProgramSemanticBaselineDraftEvent(this.options.store, pending.draft, "stale_parent"),
          ]);
        }

        const blockedBy = evaluateProgramSemanticBaselineQuiescenceV1(
          state,
          events,
          await this.options.recovery.isClear(),
        );
        if (blockedBy.length > 0) throw new ProgramSemanticBaselineBlockedError(blockedBy);

        const draftId = uuidv7();
        const initialProgramRevisionId = uuidv7();
        const admissionEventId = uuidv7();
        const cut = await buildProgramSemanticBaselineCutV1(
          state,
          this.options.authority,
          initialProgramRevisionId,
          admissionEventId,
        );
        const body: Omit<ProgramSemanticBaselineDraftV1, "draftDigest"> = {
          profile: PROGRAM_SEMANTIC_BASELINE_DRAFT_PROFILE,
          draftId,
          sourceSessionId: command.sourceSessionId,
          programStateId,
          fromProgramStateRevision: state.revision,
          initialProgramRevisionId,
          admissionEventId,
          cut,
        };
        const draft: ProgramSemanticBaselineDraftV1 = {
          ...body,
          draftDigest: planningCanonicalDigest(body),
        };
        assertProgramSemanticBaselineDraftV1(draft, state);
        const persisted = await this.options.store.append([
          sealedProgramSemanticBaselineDraftEvent(this.options.store, draft),
        ]);
        if (persisted.length !== 1) throw new ProgramSemanticBaselineControlError("Baseline draft sealing failed");
        return structuredClone(draft);
      }));
  }

  async accept(command: ProgramSemanticBaselineAcceptCommandV1): Promise<ProgramSemanticBaselineAcceptedResultV1> {
    baselineRequireNonEmpty("commandId", command.commandId);
    baselineRequireNonEmpty("clientId", command.clientId);
    baselineRequireNonEmpty("sourceSessionId", command.sourceSessionId);
    const programStateId = String(asProgramStateId(command.programStateId));
    baselineRequireNonEmpty("draftId", command.draftId);
    baselineRequireNonEmpty("draftDigest", command.draftDigest);

    return this.options.workspaceCoordinator.runExclusive(() =>
      this.options.admission.enqueue(async () => {
        const events = await replayProgramBaselineEvents(this.options.store);
        const controls = reduceProgramSemanticBaselineControlsV1(events);
        const control = controls.get(command.draftId);
        if (control === undefined || control.draft.programStateId !== programStateId) {
          throw new ProgramSemanticBaselineStaleError(`Unknown semantic baseline draft ${command.draftId}`);
        }
        const draft = control.draft;
        if (draft.sourceSessionId !== command.sourceSessionId) {
          throw new ProgramSemanticBaselineStaleError("Baseline draft belongs to another Application session");
        }
        if (draft.draftDigest !== command.draftDigest) {
          throw new ProgramSemanticBaselineStaleError("Baseline acceptance digest is stale");
        }
        if (control.status === "accepted") {
          return {
            status: "existing",
            programStateId,
            programStateRevision: control.acceptedProgramStateRevision!,
            programRevisionId: control.acceptedProgramRevisionId!,
            draftId: draft.draftId,
            draftDigest: draft.draftDigest,
          };
        }
        if (control.status !== "pending") {
          throw new ProgramSemanticBaselineStaleError(`Baseline draft ${draft.draftId} is no longer pending`);
        }
        const adopted = adoptedProgramSemanticBaselineControlV1(controls, programStateId);
        if (adopted !== undefined && adopted.draft.draftId !== draft.draftId) {
          throw new ProgramSemanticBaselineStaleError(`Program ${programStateId} already adopted another baseline`);
        }

        const state = latestLegacyProgramStateForBaseline(events, programStateId);
        const invalidateAndStale = async (reason: string, message: string): Promise<never> => {
          await this.options.store.append([
            invalidateProgramSemanticBaselineDraftEvent(this.options.store, draft, reason),
          ]);
          throw new ProgramSemanticBaselineStaleError(message);
        };
        try {
          requireBaselineApplicationSession(events, state, command.sourceSessionId);
        } catch (error) {
          if (error instanceof ProgramSemanticBaselineStaleError) {
            return invalidateAndStale("application_session_stale", error.message);
          }
          throw error;
        }
        if (state.revision !== draft.fromProgramStateRevision) {
          return invalidateAndStale("stale_parent", "Baseline draft targets a stale ProgramState revision");
        }

        const blockedBy = evaluateProgramSemanticBaselineQuiescenceV1(
          state,
          events,
          await this.options.recovery.isClear(),
        );
        if (blockedBy.length > 0) throw new ProgramSemanticBaselineBlockedError(blockedBy);
        assertProgramSemanticBaselineDraftV1(draft, state);

        // Authority/policy is external to legacy ProgramState. Rebuild and compare
        // before admission so a stale permissive authority envelope cannot survive.
        const currentCut = await buildProgramSemanticBaselineCutV1(
          state,
          this.options.authority,
          draft.initialProgramRevisionId,
          draft.admissionEventId,
        );
        if (!baselineSameCanonical(currentCut, draft.cut)) {
          return invalidateAndStale("authority_changed", "Host baseline authority changed after draft sealing");
        }

        const admitted: EventDraft<string, unknown> = {
          eventId: asEventId(draft.admissionEventId),
          idempotencyKey: `program.semantic_baseline.adopted.v1:${programStateId}`,
          correlationId: command.commandId,
          workspaceId: asWorkspaceId(this.options.store.workspaceId),
          sessionId: asSessionId(command.sourceSessionId),
          programStateId: asEventProgramStateId(programStateId),
          occurredAt: new Date().toISOString(),
          type: "program.semantic_baseline.adopted.v1",
          payload: {
            cut: draft.cut,
            draftId: draft.draftId,
            draftDigest: draft.draftDigest,
            applicationCommandId: command.commandId,
            applicationClientId: command.clientId,
          },
          payloadSchemaVersion: 1,
          producer: { kind: "runtime", component: "program-semantic-baseline" },
        };
        const persisted = await this.options.store.append([admitted]);
        if (persisted.length !== 1) throw new ProgramSemanticBaselineControlError("Semantic baseline adoption failed");
        return {
          status: "adopted",
          programStateId,
          programStateRevision: draft.cut.toProgramStateRevision,
          programRevisionId: draft.initialProgramRevisionId,
          draftId: draft.draftId,
          draftDigest: draft.draftDigest,
          cut: structuredClone(draft.cut),
        };
      }));
  }
}

/** Explicit Application authority boundary for legacy -> adaptive baseline adoption. */
export class HostProgramSemanticBaselineApplicationControlV1 {
  constructor(private readonly baseline: ProgramSemanticBaselineServiceV1) {}

  seal(command: ProgramSemanticBaselineSealCommandV1): Promise<ProgramSemanticBaselineDraftV1> {
    return this.baseline.sealDraft(command);
  }

  accept(command: ProgramSemanticBaselineAcceptCommandV1): Promise<ProgramSemanticBaselineAcceptedResultV1> {
    return this.baseline.accept(command);
  }
}
