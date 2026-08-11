import {
  asWorkspaceId,
  mkEventId,
  mkSessionId,
  uuidv7,
  type EventDraft,
  type PersistedDomainEvent,
  type SessionId,
} from "@alcode/events";
import type {
  LockedWorkspaceStore,
  ProjectionDefinition,
  ProjectionTransaction,
  StatementDefinition,
} from "@alcode/storage";

export class HostSessionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostSessionStateError";
  }
}

const sessionStatements: readonly StatementDefinition[] = [
  {
    name: "insert-session",
    sql: `INSERT INTO sessions (session_id, workspace_id, started_at, stopped_at)
      VALUES (?, ?, ?, NULL)`,
  },
  {
    name: "update-session-stopped",
    sql: `UPDATE sessions SET stopped_at = ?
      WHERE session_id = ? AND stopped_at IS NULL`,
  },
];

function createHostSessionsProjection(workspaceId: string): ProjectionDefinition {
  return {
    name: "sessions",
    schemaVersion: 1,
    classification: "derived",
    statements: sessionStatements,
    apply(event: PersistedDomainEvent<string, unknown>, tx: ProjectionTransaction): void {
      switch (event.type) {
        case "runtime.session.started": {
          const p = event.payload as { sessionId: string };
          tx.exec("insert-session", p.sessionId, workspaceId, event.occurredAt);
          break;
        }
        case "runtime.session.stopped": {
          const p = event.payload as { sessionId: string };
          const changes = tx.exec("update-session-stopped", event.occurredAt, p.sessionId);
          if (changes !== 1) {
            throw new HostSessionStateError(
              `runtime.session.stopped for ${p.sessionId}: expected one active session row`,
            );
          }
          break;
        }
        default:
          break;
      }
    },
  };
}

export interface HostSessionState {
  sessionId: SessionId;
  started: boolean;
  stopped: boolean;
}

export interface HostSessionHandle {
  sessionId: SessionId;
  resumed: boolean;
}

export interface CompletionEvidence {
  sourceEventSequence: number;
  blockingFindingIds?: string[];
}

export class HostSessionManager {
  constructor(private readonly lockedStore: LockedWorkspaceStore) {}

  private get store() {
    return this.lockedStore.store;
  }

  private catchUp(): void {
    this.store.getProjectionRunner().catchUp(createHostSessionsProjection(this.store.workspaceId));
  }

  async getState(sessionId: SessionId): Promise<HostSessionState> {
    let started = false;
    let stopped = false;
    for await (const event of this.store.replay()) {
      if (event.sessionId !== (sessionId as string)) continue;
      if (event.type === "runtime.session.started") started = true;
      if (event.type === "runtime.session.stopped") stopped = true;
    }
    return { sessionId, started, stopped };
  }

  async openOrResume(sessionId?: SessionId): Promise<HostSessionHandle> {
    const resolved = sessionId ?? mkSessionId();
    const state = await this.getState(resolved);

    if (state.started && state.stopped) {
      throw new HostSessionStateError(`Cannot resume stopped session ${resolved as string}`);
    }
    if (state.started) {
      this.catchUp();
      return { sessionId: resolved, resumed: true };
    }

    const draft: EventDraft<string, unknown> = {
      eventId: mkEventId(),
      idempotencyKey: `runtime.session.started:${resolved as string}`,
      correlationId: uuidv7(),
      workspaceId: asWorkspaceId(this.store.workspaceId),
      sessionId: resolved,
      occurredAt: new Date().toISOString(),
      type: "runtime.session.started",
      payload: { sessionId: resolved as string },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "host-session-manager" },
    };
    await this.store.append([draft]);
    this.catchUp();
    return { sessionId: resolved, resumed: false };
  }

  async stop(
    sessionId: SessionId,
    reason: "completed" | "cancelled" | "host_shutdown",
    evidence?: CompletionEvidence,
  ): Promise<void> {
    const state = await this.getState(sessionId);
    if (!state.started || state.stopped) {
      throw new HostSessionStateError(`Cannot stop inactive session ${sessionId as string}`);
    }

    const payload: Record<string, unknown> = {
      sessionId: sessionId as string,
      reason,
    };
    if (evidence) payload.completionEvidence = evidence;

    await this.store.append([{
      eventId: mkEventId(),
      idempotencyKey: `runtime.session.stopped:${sessionId as string}`,
      correlationId: uuidv7(),
      workspaceId: asWorkspaceId(this.store.workspaceId),
      sessionId,
      occurredAt: new Date().toISOString(),
      type: "runtime.session.stopped",
      payload,
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "host-session-manager" },
    }]);
    this.catchUp();
  }
}
