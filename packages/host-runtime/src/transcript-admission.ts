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

export const INTERRUPTED_TOOL_RESULT_TEXT =
  "Host recovery closed a tool call whose Agent generation ended before its durable tool result was admitted. " +
  "This transcript entry asserts no execution outcome or external effect; current Host-owned Operation, recovery, and Program state remain authoritative.";

export interface InterruptedToolResultInputV1 {
  toolCallId: string;
  toolName: string;
}

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

async function replayAll(store: WorkspaceEventStore): Promise<PersistedDomainEvent<string, unknown>[]> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of store.replay()) events.push(event);
  return events;
}

function pendingToolNames(current: ReturnType<typeof reduceSessionTranscript>): Map<string, string> {
  const wanted = new Set(current.pendingToolCallIds);
  const names = new Map<string, string>();
  for (const message of current.messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "toolCall" && wanted.has(block.id)) names.set(block.id, block.name);
    }
  }
  return names;
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

  /**
   * Close one durable transcript tool-call gap after the Agent generation that
   * owned the call has ended. This is protocol-structure recovery only: the
   * synthetic error result deliberately asserts no Operation outcome or effect.
   */
  admitInterruptedToolResult(
    sessionId: SessionId,
    input: InterruptedToolResultInputV1,
  ): Promise<PersistedDomainEvent<string, unknown>> {
    if (input.toolCallId.length === 0 || input.toolName.length === 0) {
      return Promise.reject(new Error("interrupted transcript recovery requires toolCallId and toolName"));
    }
    const idempotencyKey = `transcript:agent_interrupted:${String(sessionId)}:${input.toolCallId}`;
    return this.admission.enqueue(async () => {
      const events = await replayAll(this.store);
      const existing = events.find((event) => event.idempotencyKey === idempotencyKey);
      if (existing !== undefined) return existing;

      const current = reduceSessionTranscript(events, String(sessionId));
      const timestamp = Date.now();
      const payload = {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        content: [{ type: "text" as const, text: INTERRUPTED_TOOL_RESULT_TEXT }],
        isError: true,
        timestamp,
      };
      assertRichTranscriptTransition(current, "tool.result.appended", payload);
      const draft: EventDraft<string, unknown> = {
        eventId: mkEventId(),
        idempotencyKey,
        workspaceId: asWorkspaceId(this.store.workspaceId),
        sessionId,
        occurredAt: occurredAtFromTimestamp(timestamp),
        type: "tool.result.appended",
        payload,
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "transcript-agent-replacement-recovery" },
      };
      const [persisted] = await this.store.append([draft]);
      if (persisted === undefined) throw new Error("interrupted transcript recovery was not persisted");
      this.store.getProjectionRunner().catchUp(createTranscriptProjection(this.store.workspaceId));
      return persisted;
    });
  }

  /**
   * Recover every dangling tool call in one dead-generation transcript before a
   * replacement Agent receives context. The fixed error result is deliberately
   * non-authoritative for Operation/effect truth.
   */
  async recoverInterruptedToolResults(sessionId: SessionId): Promise<string[]> {
    const before = reduceSessionTranscript(await replayAll(this.store), String(sessionId));
    if (before.status === "complete") return [];
    const names = pendingToolNames(before);
    const recovered = [...before.pendingToolCallIds].sort((a, b) => a.localeCompare(b, "en"));
    for (const toolCallId of recovered) {
      const toolName = names.get(toolCallId);
      if (toolName === undefined) {
        throw new Error(`Pending transcript tool call ${toolCallId} lacks its canonical tool name`);
      }
      await this.admitInterruptedToolResult(sessionId, { toolCallId, toolName });
    }
    const after = reduceSessionTranscript(await replayAll(this.store), String(sessionId));
    if (after.status !== "complete" || after.pendingToolCallIds.length !== 0) {
      throw new Error(
        `Replacement transcript remains incomplete after recovery: ${after.pendingToolCallIds.join(",")}`,
      );
    }
    return recovered;
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
