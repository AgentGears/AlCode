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
    executions: [],
    operations: [],
    queue: [],
    pendingInteractions: [],
  };
}

describe("application public reducer", () => {
  it("reduces ordered transcript, execution, operation, queue, and permission state", () => {
    const events: ApplicationEvent[] = [
      {
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        type: "transcript.message.appended",
        sessionId: "s1",
        fromCursor: 10,
        sequence: 11,
        occurredAt: "2026-08-12T00:00:00.000Z",
        cause: "user",
        message: { eventId: "e11", sequence: 11, role: "user", text: "hello" },
      },
      {
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        type: "execution.upserted",
        sessionId: "s1",
        fromCursor: 11,
        sequence: 20,
        occurredAt: "2026-08-12T00:00:01.000Z",
        cause: "host",
        execution: { executionId: "x1", sourceCommandId: "c0", status: "running", startedAt: "2026-08-12T00:00:01.000Z" },
      },
      {
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        type: "operation.upserted",
        sessionId: "s1",
        fromCursor: 20,
        sequence: 21,
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
        fromCursor: 21,
        sequence: 23,
        occurredAt: "2026-08-12T00:00:02.000Z",
        cause: "user",
        item: { queueItemId: "q2", sourceCommandId: "c2", position: 2, text: "later", admittedAt: "2026-08-12T00:00:02.000Z" },
      },
      {
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        type: "queue.item.upserted",
        sessionId: "s1",
        fromCursor: 23,
        sequence: 24,
        occurredAt: "2026-08-12T00:00:03.000Z",
        cause: "user",
        item: { queueItemId: "q1", sourceCommandId: "c1", position: 1, text: "first", admittedAt: "2026-08-12T00:00:03.000Z" },
      },
      {
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        type: "permission.interaction.upserted",
        sessionId: "s1",
        fromCursor: 24,
        sequence: 30,
        occurredAt: "2026-08-12T00:00:04.000Z",
        cause: "host",
        interaction: { interactionId: "p1", kind: "permission", status: "pending", toolName: "bash", description: "Run command" },
      },
    ];

    const result = reduceApplicationEvents(emptySnapshot(), events);
    expect(result.cursor).toBe(30);
    expect(result.transcript.map((message) => message.text)).toEqual(["hello"]);
    expect(result.session.activeExecutionId).toBe("x1");
    expect(result.queue.map((item) => item.queueItemId)).toEqual(["q1", "q2"]);
    expect(result.pendingInteractions.map((item) => item.interactionId)).toEqual(["p1"]);
  });

  it("refuses to guess across a public cursor gap", () => {
    const event: ApplicationEvent = {
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      type: "output.delta",
      sessionId: "s1",
      fromCursor: 11,
      sequence: 12,
      occurredAt: "2026-08-12T00:00:00.000Z",
      cause: "agent",
      text: "late",
    };

    expect(() => reduceApplicationEvents(emptySnapshot(), [event])).toThrow(ApplicationSequenceGapError);
  });
});
