import type {
  EligibilityFacts,
  ProgramState,
  ProgramWorkItem,
  ProgramWorkItemId,
} from "./types.ts";

function hasOpenBlocker(state: ProgramState, workItemId: ProgramWorkItemId): boolean {
  return state.blockers.some(
    (blocker) =>
      blocker.state === "open" &&
      (blocker.workItemId === null || blocker.workItemId === workItemId),
  );
}

function dependenciesCompleted(state: ProgramState, work: ProgramWorkItem): boolean {
  if (work.dependencyIds.length === 0) return true;
  const byId = new Map(state.workItems.map((item) => [String(item.workItemId), item]));
  return work.dependencyIds.every(
    (dependencyId) => byId.get(String(dependencyId))?.lifecycle === "completed",
  );
}

/**
 * Derive the Program-local work that is structurally ready. This intentionally
 * does not represent Workspace reservation/recovery state; those Host facts are
 * supplied separately to `selectNextEligibleWork`.
 */
export function deriveReadyWorkItems(state: ProgramState): ProgramWorkItem[] {
  if (state.lifecycle !== "active") return [];
  if (state.activeAttempt !== null) return [];
  if (state.executionBaseMismatch !== null || state.executionBaseUnavailable) return [];

  return state.workItems.filter(
    (work) =>
      work.lifecycle === "pending" &&
      dependenciesCompleted(state, work) &&
      !hasOpenBlocker(state, work.workItemId),
  );
}

/** Stable first-slice order: canonical creation order, then UTF-16 id order. */
export function compareWorkSelectionOrder(a: ProgramWorkItem, b: ProgramWorkItem): number {
  if (a.creationOrder !== b.creationOrder) return a.creationOrder - b.creationOrder;
  const aId = String(a.workItemId);
  const bId = String(b.workItemId);
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/**
 * Select one work item only when all non-Program Host scheduler facts permit
 * dispatch. A busy Workspace does not create a hidden queue; it simply yields
 * no selected work in this pure derivation.
 */
export function selectNextEligibleWork(
  state: ProgramState,
  facts: EligibilityFacts,
): ProgramWorkItem | null {
  if (!facts.hasActiveAttachedExecutionEpisode) return null;
  if (!facts.workspaceReservationAvailable) return null;
  if (!facts.recoveryClear) return null;
  if (!facts.writerBarriersClear) return null;

  const ready = deriveReadyWorkItems(state);
  if (ready.length === 0) return null;
  return [...ready].sort(compareWorkSelectionOrder)[0] ?? null;
}
