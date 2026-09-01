import type { PersistedDomainEvent, SessionId as EventSessionId } from "@alcode/events";
import type { ProgramState } from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import {
  ProgramAdaptiveAdmissionControlErrorV2,
  adaptiveTransitionEventV2,
  materializeAdaptiveAgentReplacementRecoveryV2,
  requireAdaptiveRawProgramStateV2,
  type ProgramAdaptiveAgentReplacementRecoveryResultV2,
  type ProgramAdaptiveAdmissionServiceV2,
} from "./program-adaptive-admission-v2.ts";
import { recoverAdaptiveProgramCurrentSnapshotV2 } from "./program-adaptive-operational-v2.ts";
import type { ProgramDispatchWorkspaceCoordinatorV1 } from "./program-dispatch.ts";
import type { ProgramSemanticCurrentSnapshotV1 } from "./program-revision.ts";

export interface ProgramAdaptiveAgentReplacementAuthorityOptionsV3 {
  store: WorkspaceEventStore;
  admission: CanonicalAdmissionQueue;
  workspaceCoordinator: ProgramDispatchWorkspaceCoordinatorV1;
}

export interface ProgramAdaptiveReplacementCandidateV3 {
  programStateId: string;
  current: ProgramSemanticCurrentSnapshotV1;
}

export type ProgramAdaptiveReplacementSelectionV3 =
  | { status: "not_program" }
  | { status: "not_active" }
  | { status: "no_active_attempt" }
  | { status: "selected"; candidate: ProgramAdaptiveReplacementCandidateV3 };

export interface ProgramAdaptiveWorkspaceRestartRecoveryItemV3 {
  programStateId: string;
  programAttemptId: string;
  sessionId: string;
}

export interface ProgramAdaptiveWorkspaceRestartRecoveryResultV3 {
  recovered: ProgramAdaptiveWorkspaceRestartRecoveryItemV3[];
}

/**
 * Replacement ownership belongs to a retained active Attempt, not merely to an
 * attached Program. Terminal Programs may remain attached for continuity, and
 * active Programs without a retained Attempt carry status truth but no Agent
 * generation authority. Only active Programs with retained Attempts compete
 * for replacement recovery ownership.
 */
export function selectAdaptiveAgentReplacementCandidateV3(
  attached: readonly ProgramAdaptiveReplacementCandidateV3[],
  sessionId: string,
): ProgramAdaptiveReplacementSelectionV3 {
  if (attached.length === 0) return { status: "not_program" };

  const active = attached.filter((candidate) => candidate.current.lifecycle === "active");
  const owners = active.filter((candidate) => candidate.current.activeAttempt !== null);
  if (owners.length > 1) {
    throw new ProgramAdaptiveAdmissionControlErrorV2(
      `Multiple active adaptive Attempts claim attached Session ${sessionId}`,
    );
  }
  const owner = owners[0];
  if (owner !== undefined) return { status: "selected", candidate: owner };
  if (active.length > 0) return { status: "no_active_attempt" };
  return { status: "not_active" };
}

/**
 * A successful process-scoped Workspace lock acquisition proves that no prior
 * product process can still execute the retained Agent generation. Derive the
 * abandoned Session only from canonical Attempt ownership; never let the new
 * process assert an old Session identifier as recovery authority.
 */
export function requireAdaptiveWorkspaceRestartAttemptOwnerV3(
  programStateId: string,
  current: ProgramSemanticCurrentSnapshotV1,
  rawAttempt: ProgramState["activeAttempt"],
): string | null {
  if (current.lifecycle !== "active" || current.activeAttempt === null) return null;
  if (rawAttempt === null) {
    throw new ProgramAdaptiveAdmissionControlErrorV2(
      `Adaptive Workspace restart Program ${programStateId} lost its retained raw Attempt`,
    );
  }
  if (String(rawAttempt.programAttemptId) !== String(current.activeAttempt.programAttemptId)
      || String(rawAttempt.workItemId) !== String(current.activeAttempt.workItemId)) {
    throw new ProgramAdaptiveAdmissionControlErrorV2(
      `Adaptive Workspace restart Program ${programStateId} has stale Attempt ownership`,
    );
  }
  const sessionId = String(rawAttempt.sessionId);
  if (!current.attachedSessionIds.includes(sessionId)) {
    throw new ProgramAdaptiveAdmissionControlErrorV2(
      `Adaptive Workspace restart Attempt owner ${sessionId} is not attached to Program ${programStateId}`,
    );
  }
  return sessionId;
}

function isProgramStateEvent(type: string): boolean {
  return type === "program.created" || type === "program.transitioned"
    || type === "program.completed" || type === "program.cancelled";
}

async function replayAll(store: WorkspaceEventStore): Promise<PersistedDomainEvent<string, unknown>[]> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

function programStateIds(events: readonly PersistedDomainEvent<string, unknown>[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (!isProgramStateEvent(event.type) || event.programStateId === undefined) continue;
    ids.add(String(event.programStateId));
  }
  return [...ids].sort((left, right) => left.localeCompare(right, "en"));
}

export class ProgramAdaptiveAgentReplacementAuthorityV3 {
  constructor(private readonly options: ProgramAdaptiveAgentReplacementAuthorityOptionsV3) {}

  recoverAgentReplacement(sessionId: string): Promise<ProgramAdaptiveAgentReplacementRecoveryResultV2> {
    return this.options.workspaceCoordinator.runExclusive(async () =>
      this.options.admission.enqueue(async () => {
        const events = await replayAll(this.options.store);
        const attached: ProgramAdaptiveReplacementCandidateV3[] = [];
        for (const programStateId of programStateIds(events)) {
          const current = recoverAdaptiveProgramCurrentSnapshotV2(events, programStateId);
          if (current === undefined || !current.attachedSessionIds.includes(sessionId)) continue;
          attached.push({ programStateId, current });
        }

        const selection = selectAdaptiveAgentReplacementCandidateV3(attached, sessionId);
        if (selection.status !== "selected") return selection;

        const selected = selection.candidate;
        const raw = requireAdaptiveRawProgramStateV2(events, selected.programStateId);
        if (raw.activeAttempt === null || String(raw.activeAttempt.sessionId) !== sessionId) {
          return { status: "not_attempt_owner" };
        }

        const recovered = materializeAdaptiveAgentReplacementRecoveryV2(
          raw,
          selected.current,
          sessionId,
        );
        const persisted = await this.options.store.append([
          adaptiveTransitionEventV2(
            this.options.store,
            sessionId as EventSessionId,
            recovered.recovered,
            "attempt.interrupt:agent_replaced",
            recovered.programAttemptId,
            "program-adaptive-recovery-v2",
          ),
        ]);
        if (persisted.length !== 1) {
          throw new ProgramAdaptiveAdmissionControlErrorV2(
            "Adaptive replacement recovery admission was not atomic",
          );
        }
        return {
          status: "recovered",
          programStateId: selected.programStateId,
          programAttemptId: recovered.programAttemptId,
        };
      }));
  }

  /**
   * Recover every retained adaptive Attempt after this process has acquired the
   * exclusive Workspace lock and before generic Phase-1 recovery runs. The old
   * Session owner is derived from each raw canonical Attempt. All recovery
   * drafts are prepared before the single append so an ambiguous Program fails
   * the whole Workspace restart closed without partially retiring authority.
   */
  recoverWorkspaceRestart(): Promise<ProgramAdaptiveWorkspaceRestartRecoveryResultV3> {
    return this.options.workspaceCoordinator.runExclusive(async () =>
      this.options.admission.enqueue(async () => {
        const events = await replayAll(this.options.store);
        const prepared: Array<{
          draft: ReturnType<typeof adaptiveTransitionEventV2>;
          item: ProgramAdaptiveWorkspaceRestartRecoveryItemV3;
        }> = [];

        for (const programStateId of programStateIds(events)) {
          const current = recoverAdaptiveProgramCurrentSnapshotV2(events, programStateId);
          if (current === undefined) continue;
          const raw = requireAdaptiveRawProgramStateV2(events, programStateId);
          const sessionId = requireAdaptiveWorkspaceRestartAttemptOwnerV3(
            programStateId,
            current,
            raw.activeAttempt,
          );
          if (sessionId === null) continue;

          const recovered = materializeAdaptiveAgentReplacementRecoveryV2(raw, current, sessionId);
          prepared.push({
            draft: adaptiveTransitionEventV2(
              this.options.store,
              sessionId as EventSessionId,
              recovered.recovered,
              "attempt.interrupt:agent_replaced",
              recovered.programAttemptId,
              "program-adaptive-recovery-v2",
            ),
            item: {
              programStateId,
              programAttemptId: recovered.programAttemptId,
              sessionId,
            },
          });
        }

        if (prepared.length === 0) return { recovered: [] };
        const persisted = await this.options.store.append(prepared.map(({ draft }) => draft));
        if (persisted.length !== prepared.length) {
          throw new ProgramAdaptiveAdmissionControlErrorV2(
            "Adaptive Workspace restart recovery admission was not atomic",
          );
        }
        return { recovered: prepared.map(({ item }) => item) };
      }));
  }
}

/**
 * Preserve the complete adaptive admission surface while replacing only the
 * Agent-replacement recovery authority exposed by the supported production
 * entry. The empty Proxy target avoids descriptor authority inherited from the
 * concrete service instance.
 */
export function withAdaptiveAgentReplacementAuthorityV3(
  base: ProgramAdaptiveAdmissionServiceV2,
  replacement: ProgramAdaptiveAgentReplacementAuthorityV3,
): ProgramAdaptiveAdmissionServiceV2 {
  return new Proxy({} as ProgramAdaptiveAdmissionServiceV2, {
    get(_target, property) {
      if (property === "recoverAgentReplacement") {
        return replacement.recoverAgentReplacement.bind(replacement);
      }
      const value = Reflect.get(base, property, base) as unknown;
      return typeof value === "function" ? value.bind(base) : value;
    },
  }) as ProgramAdaptiveAdmissionServiceV2;
}
