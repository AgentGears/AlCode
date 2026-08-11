import {
  type AssistantMessageProduced,
  type ToolResultProduced,
} from "@alcode/agent-protocol";
import {
  asWorkspaceId,
  mkEventId,
  type EventDraft,
  type PersistedDomainEvent,
  type SessionId,
} from "@alcode/events";
import {
  createTranscriptProjection,
  type WorkspaceEventStore,
} from "@alcode/storage";
import {
  assertRichTranscriptTransition,
  isTranscriptEventType,
  reduceTranscript,
  type TranscriptEventRecord,
} from "@alcode/transcript";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";

function occurredAtFromTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp)) throw new Error("transcript timestamp must be finite");
  const iso = new Date(timestamp).toISOString();
  if (iso === "Invalid Date") throw new Error("invalid transcript timestamp");
  return iso;
}

function reduceSessionTranscript(
  events: readonly PersistedDomainEvent<string, unknown>[],
  sessionId: string,
) {
  const transcriptEvents: TranscriptEventRecord[] = events
    .filter((event) => event.sessionId === sessionId && isTranscriptEventType(event.type))
    .map((event) => ({
      eventId: event.eventId,
      sequence: event.sequence,
      type: event.type as TranscriptEventRecord["type"],
      payload: event.payload,
      occurredAt: event.occurredAt,
      ...(event.operationId !== undefined ? { operationId: event.operationId } : {}),
    }));
  return reduceTranscript(transcriptEvents);
}

export class TranscriptAdmissionService {
  constructor(
    private readonly store: WorkspaceEventStore,
    private readonly admission: CanonicalAdmissionQueue,
  ) {}

  admitAssistant(
    generationId: string,
    sessionId: SessionId,
    message: AssistantMessageProduced,
  ): Promise<PersistedDomainEvent<string, unknown>> {
    if (message.content === undefined || message.stopReason === undefined || message.timestamp === undefined) {
      return Promise.reject(new Error("durable_transcript_v1 assistant message requires content, stopReason, and timestamp"));
    }
    const payload = {
      text: message.text,
      content: message.content,
      stopReason: message.stopReason,
      ...(message.errorMessage !== undefined ? { errorMessage: message.errorMessage } : {}),
      timestamp: message.timestamp,
    };
    return this.admit(
      generationId,
      sessionId,
      message.requestId,
      "assistant.message.appended",
      payload,
      occurredAtFromTimestamp(message.timestamp),
      { kind: "model", provider: `agent:${generationId}` },
    );
  }

  admitToolResult(
    generationId: string,
    sessionId: SessionId,
    message: ToolResultProduced,
  ): Promise<PersistedDomainEvent<string, unknown>> {
    const payload = {
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content,
      isError: message.isError,
      timestamp: message.timestamp,
    };
    return this.admit(
      generationId,
      sessionId,
      message.requestId,
      "tool.result.appended",
      payload,
      occurredAtFromTimestamp(message.timestamp),
      { kind: "runtime", component: `agent:${generationId}` },
    );
  }

  private admit(
    generationId: string,
    sessionId: SessionId,
    requestId: string,
    type: "assistant.message.appended" | "tool.result.appended",
    payload: unknown,
    occurredAt: string,
    producer: EventDraft<string, unknown>["producer"],
  ): Promise<PersistedDomainEvent<string, unknown>> {
    return this.admission.enqueue(async () => {
      const idempotencyKey = `transcript:${generationId}:${requestId}`;
      const draft: EventDraft<string, unknown> = {
        eventId: mkEventId(),
        idempotencyKey,
        workspaceId: asWorkspaceId(this.store.workspaceId),
        sessionId,
        occurredAt,
        type,
        payload,
        payloadSchemaVersion: 1,
        producer,
      };

      // Take one canonical snapshot while holding Host admission serialization.
      const head = await this.store.headSequence();
      const events: PersistedDomainEvent<string, unknown>[] = [];
      let cursor = 0;
      while (cursor < head) {
        const batch = this.store.getVerifiedEvents(cursor, 512).filter((event) => event.sequence <= head);
        if (batch.length === 0) break;
        events.push(...batch);
        cursor = batch[batch.length - 1]!.sequence;
      }

      // A retry must reach the event-store fingerprint oracle before semantic
      // transition validation, because the transition is already reflected in
      // the current transcript and would otherwise look like a duplicate.
      const existing = events.find((event) => event.idempotencyKey === idempotencyKey);
      if (existing) {
        const persisted = await this.store.append([draft]);
        this.store.getProjectionRunner().catchUp(createTranscriptProjection(this.store.workspaceId));
        return persisted[0]!;
      }

      const current = reduceSessionTranscript(events, sessionId as string);
      assertRichTranscriptTransition(current, type, payload);

      const persisted = await this.store.append([draft]);
      this.store.getProjectionRunner().catchUp(createTranscriptProjection(this.store.workspaceId));
      return persisted[0]!;
    });
  }
}
