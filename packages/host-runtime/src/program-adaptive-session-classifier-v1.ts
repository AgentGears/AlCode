import type { PersistedDomainEvent } from "@alcode/events";
import {
  assertValidProgramState,
  canonicalStringify,
  type ProgramState,
} from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import type { ProgramDispatchWorkspaceCoordinatorV1 } from "./program-dispatch.ts";

const CLASSIFICATION_RETRIES = 3;

export type ProgramAdaptiveSessionModeV1 = "none" | "fixed" | "adaptive";

export interface ProgramAdaptiveSessionClassificationV1 {
  mode: ProgramAdaptiveSessionModeV1;
  programStateId?: string;
  programStateRevision?: number;
}

export interface ProgramAdaptiveAdoptionRegistryV1 {
  isAdopted(programStateId: string): Promise<boolean>;
}

export interface ProgramAdaptiveSessionClassifierOptionsV1 {
  store: WorkspaceEventStore;
  workspaceCoordinator: ProgramDispatchWorkspaceCoordinatorV1;
  adoption: ProgramAdaptiveAdoptionRegistryV1;
}

export class ProgramAdaptiveSessionClassificationErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramAdaptiveSessionClassificationErrorV1";
  }
}

interface ActiveProgramClaimV1 {
  programStateId: string;
  state: ProgramState;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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

function activeProgramClaim(
  events: readonly PersistedDomainEvent<string, unknown>[],
  sessionId: string,
): ActiveProgramClaimV1 | undefined {
  const latest = new Map<string, ProgramState>();
  for (const event of events) {
    if (!isProgramStateEvent(event.type) || event.programStateId === undefined) continue;
    const state = record(event.payload).state as ProgramState | undefined;
    if (state === undefined) {
      throw new ProgramAdaptiveSessionClassificationErrorV1(`${event.type} lacks payload.state`);
    }
    assertValidProgramState(state);
    const programStateId = String(event.programStateId);
    if (String(state.programStateId) !== programStateId) {
      throw new ProgramAdaptiveSessionClassificationErrorV1(
        `${event.type} ProgramState identity disagrees with its envelope`,
      );
    }
    latest.set(programStateId, state);
  }

  const claims = [...latest.entries()]
    .filter(([, state]) => state.lifecycle === "active"
      && state.attachedSessionIds.some((attached) => String(attached) === sessionId))
    .sort(([left], [right]) => left.localeCompare(right, "en"));
  if (claims.length > 1) {
    throw new ProgramAdaptiveSessionClassificationErrorV1(
      `Multiple active Programs claim attached Session ${sessionId}`,
    );
  }
  const claim = claims[0];
  return claim === undefined ? undefined : { programStateId: claim[0], state: claim[1] };
}

function claimFingerprint(claim: ActiveProgramClaimV1 | undefined): string {
  if (claim === undefined) return "none";
  return canonicalStringify({
    programStateId: claim.programStateId,
    revision: claim.state.revision,
    lifecycle: claim.state.lifecycle,
    attachedSessionIds: claim.state.attachedSessionIds.map(String),
  });
}

/**
 * Durable product-mode classifier for the A1 V1/V2 boundary.
 *
 * Classification is derived only from canonical ProgramState attachment/lifecycle
 * and the explicit semantic-baseline adoption registry. It never infers adaptive
 * mode from ProgramState.revision, semantic-looking work, or Agent capabilities.
 * The bounded double sample detects both operational attachment churn and a
 * baseline-adoption race before returning a routing decision.
 */
export class ProgramAdaptiveSessionClassifierV1 {
  constructor(private readonly options: ProgramAdaptiveSessionClassifierOptionsV1) {}

  async classify(sessionId: string): Promise<ProgramAdaptiveSessionClassificationV1> {
    if (sessionId.length === 0) {
      throw new ProgramAdaptiveSessionClassificationErrorV1("sessionId must be non-empty");
    }

    return this.options.workspaceCoordinator.runExclusive(async () => {
      for (let attempt = 0; attempt < CLASSIFICATION_RETRIES; attempt++) {
        const before = activeProgramClaim(await replayAll(this.options.store), sessionId);
        const adoptedBefore = before === undefined
          ? false
          : await this.options.adoption.isAdopted(before.programStateId);

        const after = activeProgramClaim(await replayAll(this.options.store), sessionId);
        const adoptedAfter = after === undefined
          ? false
          : await this.options.adoption.isAdopted(after.programStateId);

        if (claimFingerprint(before) !== claimFingerprint(after)) continue;
        if (before === undefined || after === undefined) return { mode: "none" };
        if (before.programStateId !== after.programStateId || adoptedBefore !== adoptedAfter) continue;

        return {
          mode: adoptedAfter ? "adaptive" : "fixed",
          programStateId: after.programStateId,
          programStateRevision: after.state.revision,
        };
      }
      throw new ProgramAdaptiveSessionClassificationErrorV1(
        `Program routing for Session ${sessionId} changed during bounded classification`,
      );
    });
  }

  async isAdaptiveProgramSession(sessionId: string): Promise<boolean> {
    return (await this.classify(sessionId)).mode === "adaptive";
  }
}
