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

/** Exact logical whole-state currentness for an already-adopted adaptive Program. */
export interface ProgramAdaptiveCurrentStateRevisionSourceV1 {
  current(programStateId: string): Promise<{ programStateRevision: number }>;
}

/**
 * Routing authority used by the production V1/V2 runtime boundary. The selected
 * route and the routing action execute in one Workspace-exclusive section so a
 * baseline adoption cannot switch fixed -> adaptive between them.
 */
export interface ProgramAdaptiveSessionRoutingAuthorityV1 {
  withClassification<T>(
    sessionId: string,
    route: (classification: ProgramAdaptiveSessionClassificationV1) => Promise<T>,
  ): Promise<T>;
}

export interface ProgramAdaptiveSessionClassifierOptionsV1 {
  store: WorkspaceEventStore;
  workspaceCoordinator: ProgramDispatchWorkspaceCoordinatorV1;
  adoption: ProgramAdaptiveAdoptionRegistryV1;
  adaptiveCurrent: ProgramAdaptiveCurrentStateRevisionSourceV1;
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

interface ClassificationSampleV1 {
  claim: ActiveProgramClaimV1 | undefined;
  adopted: boolean;
  programStateRevision: number | undefined;
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

function sampleFingerprint(sample: ClassificationSampleV1): string {
  if (sample.claim === undefined) return "none";
  return canonicalStringify({
    programStateId: sample.claim.programStateId,
    rawRevision: sample.claim.state.revision,
    lifecycle: sample.claim.state.lifecycle,
    attachedSessionIds: sample.claim.state.attachedSessionIds.map(String),
    adopted: sample.adopted,
    programStateRevision: sample.programStateRevision ?? null,
  });
}

/**
 * Durable product-mode classifier for the A1 V1/V2 boundary.
 *
 * Classification is derived only from canonical ProgramState attachment/lifecycle
 * and explicit semantic-baseline adoption. It never infers adaptive mode from a
 * revision number, semantic-looking work, or Agent capabilities. For adaptive
 * Programs the returned CAS revision comes from logical adaptive currentness,
 * never the potentially lagging raw ProgramState event.
 */
export class ProgramAdaptiveSessionClassifierV1 implements ProgramAdaptiveSessionRoutingAuthorityV1 {
  constructor(private readonly options: ProgramAdaptiveSessionClassifierOptionsV1) {}

  private requireSessionId(sessionId: string): void {
    if (sessionId.length === 0) {
      throw new ProgramAdaptiveSessionClassificationErrorV1("sessionId must be non-empty");
    }
  }

  private async sample(sessionId: string): Promise<ClassificationSampleV1> {
    const claim = activeProgramClaim(await replayAll(this.options.store), sessionId);
    if (claim === undefined) return { claim: undefined, adopted: false, programStateRevision: undefined };

    const adopted = await this.options.adoption.isAdopted(claim.programStateId);
    if (!adopted) {
      return { claim, adopted: false, programStateRevision: claim.state.revision };
    }

    const current = await this.options.adaptiveCurrent.current(claim.programStateId);
    if (!Number.isSafeInteger(current.programStateRevision) || current.programStateRevision <= 0) {
      throw new ProgramAdaptiveSessionClassificationErrorV1(
        `Adaptive Program ${claim.programStateId} has invalid logical whole-state revision`,
      );
    }
    if (current.programStateRevision < claim.state.revision) {
      throw new ProgramAdaptiveSessionClassificationErrorV1(
        `Adaptive Program ${claim.programStateId} logical revision predates raw ProgramState`,
      );
    }
    return { claim, adopted: true, programStateRevision: current.programStateRevision };
  }

  private async classifyProtected(sessionId: string): Promise<ProgramAdaptiveSessionClassificationV1> {
    for (let attempt = 0; attempt < CLASSIFICATION_RETRIES; attempt++) {
      const before = await this.sample(sessionId);
      const after = await this.sample(sessionId);
      if (sampleFingerprint(before) !== sampleFingerprint(after)) continue;
      if (after.claim === undefined) return { mode: "none" };
      return {
        mode: after.adopted ? "adaptive" : "fixed",
        programStateId: after.claim.programStateId,
        programStateRevision: after.programStateRevision!,
      };
    }
    throw new ProgramAdaptiveSessionClassificationErrorV1(
      `Program routing for Session ${sessionId} changed during bounded classification`,
    );
  }

  async classify(sessionId: string): Promise<ProgramAdaptiveSessionClassificationV1> {
    this.requireSessionId(sessionId);
    return this.options.workspaceCoordinator.runExclusive(() => this.classifyProtected(sessionId));
  }

  async withClassification<T>(
    sessionId: string,
    route: (classification: ProgramAdaptiveSessionClassificationV1) => Promise<T>,
  ): Promise<T> {
    this.requireSessionId(sessionId);
    return this.options.workspaceCoordinator.runExclusive(async () =>
      route(await this.classifyProtected(sessionId)));
  }

  /** Informational helper. Production routing actions must use withClassification. */
  async isAdaptiveProgramSession(sessionId: string): Promise<boolean> {
    return (await this.classify(sessionId)).mode === "adaptive";
  }
}
