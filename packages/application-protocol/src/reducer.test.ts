import { describe, expect, it } from "vitest";
import {
  APPLICATION_PROTOCOL_VERSION,
  ApplicationSequenceGapError,
  reduceApplicationEvents,
  type ApplicationSnapshot,
  type ApplicationEvent,
} from "./index.ts";

function emptySnapshot(): ApplicationSnapshot {
  return {
    protocolVersion: APPLICATION_PROTOCOL_VERSION,
    sessionId: "s1",
    cursor: 10,
    session: { sessionId: "s1", status: "active" },
    transcript: [],
    operations: [],
    queue: [],
    pendingInteractions: [],
  };
}

describe("application public reducer", () => {
  it("reduces ordered transcript, operation, queue, and permission state", () => {
    const events: ApplicationEvent[] = [
      {
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        type: "transcript.message.appended",
        sessionId: "s1",
        sequence: 11,
        occurredAt: "2026-08-12T00:00:00.000Z",
        cause: "user",
        message: { eventId: "e11", sequence: 11, role: "user", text: "hello" },
      },
      {
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        type: "operation.upserted",
        sessionId: "s1",
        sequence: 12,
        occurredAt: "2026-08-12T00:00:01.000Z",
        cause: "host",
        operation: {
          operationId: "o1",
          toolName: "bash",
          lifecycleState: "started",
          executionOutcome: null,
          effectStatus: "indeterminate",
          reconciliationStatus: "not_required",
          startedAt: "2026-08-12T00:00:01.000Z",
          completedAt: null,
        },
      },
      {
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        type: "queue.item.upserted",
        sessionId: "s1",
        sequence: 13,
        occurredAt: "2026-08-12T00:00:02.000Z",
        cause: "user",
        item: { queueItemId: "q2", sourceCommandId: "c2", position: 2, text: "later", admittedAt: "2026-08-12T00:00:02.000Z" },
      },
      {
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        type: "queue.item.upserted",
        sessionId: "s1",
        sequence: 14,
        occurredAt: "2026-08-12T00:00:03.000Z",
        cause: "user",
        item: { queueItemId: "q1", sourceCommandId: "c1", position: 1, text: "first", admittedAt: "2026-08-12T00:00:03.000Z" },
      },
      {
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        type: "permission.interaction.upserted",
        sessionId: "s1",
        sequence: 15,
        occurredAt: "2026-08-12T00:00:04.000Z",
        cause: "host",
        interaction: { interactionId: "p1", kind: "permission", status: "pending", toolName: "bash", description: "Run command" },
      },
    ];

    const result = reduceApplicationEvents(emptySnapshot(), events);
    expect(result.cursor).toBe(15);
    expect(result.transcript.map((message) => message.text)).toEqual(["hello"]);
    expect(result.session.activeOperationId).toBe("o1");
    expect(result.queue.map((item) => item.queueItemId)).toEqual(["q1", "q2"]);
    expect(result.pendingInteractions.map((item) => item.interactionId)).toEqual(["p1"]);
  });

  it("refuses to guess across a sequence gap", () => {
    const event: ApplicationEvent = {
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      type: "output.delta",
      sessionId: "s1",
      sequence: 12,
      occurredAt: "2026-08-12T00:00:00.000Z",
      cause: "agent",
      text: "late",
    };

    expect(() => reduceApplicationEvents(emptySnapshot(), [event])).toThrow(ApplicationSequenceGapError);
  });
});
