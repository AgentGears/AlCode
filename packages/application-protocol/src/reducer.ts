import type {
  ApplicationEvent,
  ApplicationSnapshot,
  PublicPermissionInteraction,
  PublicQueueItem,
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

export class ApplicationSequenceGapError extends Error {
  constructor(readonly expected: number, readonly received: number) {
    super(`Application event sequence gap: expected ${expected}, received ${received}`);
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
  const expected = snapshot.cursor + 1;
  if (event.sequence !== expected) {
    throw new ApplicationSequenceGapError(expected, event.sequence);
  }

  switch (event.type) {
    case "transcript.message.appended":
      return { ...snapshot, cursor: event.sequence, transcript: [...snapshot.transcript, event.message] };

    case "operation.upserted": {
      const operations = upsertById(snapshot.operations, event.operation.operationId, (item) => item.operationId, event.operation);
      const activeOperation = operations.find((item) => item.lifecycleState !== "terminal");
      return {
        ...snapshot,
        cursor: event.sequence,
        operations,
        session: {
          ...snapshot.session,
          ...(activeOperation ? { activeOperationId: activeOperation.operationId } : { activeOperationId: undefined }),
        },
      };
    }

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
