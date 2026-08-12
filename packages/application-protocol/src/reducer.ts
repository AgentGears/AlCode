import type {
  ApplicationEvent,
  ApplicationSnapshot,
  PublicForegroundExecution,
  PublicPermissionInteraction,
  PublicQueueItem,
  PublicSessionState,
} from "./types.ts";

function upsertById<T>(items: readonly T[], id: string, getId: (item: T) => string, value: T): T[] {
  const index = items.findIndex((item) => getId(item) === id);
  if (index < 0) return [...items, value];
  const next = [...items];
  next[index] = value;
  return next;
}

function sortQueue(items: readonly PublicQueueItem[]): PublicQueueItem[] {
  return [...items].sort((a, b) => a.position - b.position || a.queueItemId.localeCompare(b.queueItemId));
}

function activeInteraction(items: readonly PublicPermissionInteraction[]): PublicPermissionInteraction[] {
  return items.filter((item) => item.status === "pending");
}

function withActiveExecution(session: PublicSessionState, executionId?: string): PublicSessionState {
  return executionId === undefined
    ? { sessionId: session.sessionId, status: session.status }
    : { ...session, activeExecutionId: executionId };
}

function currentExecution(executions: readonly PublicForegroundExecution[]): PublicForegroundExecution | undefined {
  return [...executions].reverse().find((item) => item.status !== "completed");
}

export class ApplicationSequenceGapError extends Error {
  constructor(readonly expected: number, readonly received: number) {
    super(`Application event sequence gap: expected prior cursor ${expected}, received ${received}`);
    this.name = "ApplicationSequenceGapError";
  }
}

export function reduceApplicationEvent(
  snapshot: ApplicationSnapshot,
  event: ApplicationEvent,
): ApplicationSnapshot {
  if (event.sessionId !== snapshot.sessionId) {
    throw new Error(`Application event session mismatch: ${event.sessionId} !== ${snapshot.sessionId}`);
  }
  if (event.fromCursor !== snapshot.cursor) {
    throw new ApplicationSequenceGapError(snapshot.cursor, event.fromCursor);
  }
  if (event.sequence <= event.fromCursor) {
    throw new Error(`Application event cursor must advance: ${event.fromCursor} -> ${event.sequence}`);
  }

  switch (event.type) {
    case "transcript.message.appended":
      return { ...snapshot, cursor: event.sequence, transcript: [...snapshot.transcript, event.message] };

    case "execution.upserted": {
      const executions = upsertById(snapshot.executions, event.execution.executionId, (item) => item.executionId, event.execution);
      return {
        ...snapshot,
        cursor: event.sequence,
        executions,
        session: withActiveExecution(snapshot.session, currentExecution(executions)?.executionId),
      };
    }

    case "operation.upserted":
      return {
        ...snapshot,
        cursor: event.sequence,
        operations: upsertById(snapshot.operations, event.operation.operationId, (item) => item.operationId, event.operation),
      };

    case "queue.item.upserted":
      return {
        ...snapshot,
        cursor: event.sequence,
        queue: sortQueue(upsertById(snapshot.queue, event.item.queueItemId, (item) => item.queueItemId, event.item)),
      };

    case "queue.item.removed":
      return {
        ...snapshot,
        cursor: event.sequence,
        queue: snapshot.queue.filter((item) => item.queueItemId !== event.queueItemId),
      };

    case "permission.interaction.upserted": {
      const interactions = upsertById(
        snapshot.pendingInteractions,
        event.interaction.interactionId,
        (item) => item.interactionId,
        event.interaction,
      );
      return { ...snapshot, cursor: event.sequence, pendingInteractions: activeInteraction(interactions) };
    }

    case "session.state.updated":
      return { ...snapshot, cursor: event.sequence, session: event.session };

    case "input.admitted":
    case "output.delta":
      return { ...snapshot, cursor: event.sequence };

    case "protocol.terminal":
      return {
        ...snapshot,
        cursor: event.sequence,
        session: { sessionId: snapshot.sessionId, status: "stopped" },
      };
  }
}

export function reduceApplicationEvents(
  snapshot: ApplicationSnapshot,
  events: readonly ApplicationEvent[],
): ApplicationSnapshot {
  return events.reduce((state, event) => reduceApplicationEvent(state, event), snapshot);
}
