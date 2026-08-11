import {
  AssistantMessageAppendedPayloadSchema,
  ToolResultAppendedPayloadSchema,
  UserMessageAppendedPayloadSchema,
  type TranscriptEventRecord,
} from "./events.ts";
import {
  TranscriptAssistantMessageSchema,
  TranscriptToolResultMessageSchema,
  TranscriptUserMessageSchema,
  assistantText,
  type TranscriptMessage,
} from "./messages.ts";

export type TranscriptFidelity = "exact" | "legacy_text_only";
export type TranscriptCompleteness = "complete" | "incomplete";

export interface ReducedTranscript {
  messages: TranscriptMessage[];
  status: TranscriptCompleteness;
  pendingToolCallIds: string[];
  fidelity: TranscriptFidelity;
  lastSequence: number;
}

function timestampFromOccurredAt(occurredAt: string): number {
  const timestamp = new Date(occurredAt).getTime();
  if (!Number.isFinite(timestamp)) throw new Error(`invalid transcript occurredAt: ${occurredAt}`);
  return timestamp;
}

export function reduceTranscript(events: readonly TranscriptEventRecord[]): ReducedTranscript {
  const messages: TranscriptMessage[] = [];
  const pending = new Map<string, string>();
  const seenToolCallIds = new Set<string>();
  let fidelity: TranscriptFidelity = "exact";
  let lastSequence = 0;

  for (const event of events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= lastSequence) {
      throw new Error(`transcript sequence must be strictly increasing: ${event.sequence} after ${lastSequence}`);
    }
    lastSequence = event.sequence;

    switch (event.type) {
      case "user.message.appended": {
        const payload = UserMessageAppendedPayloadSchema.parse(event.payload);
        const exact = payload.timestamp !== undefined;
        if (!exact) fidelity = "legacy_text_only";
        messages.push(TranscriptUserMessageSchema.parse({
          role: "user",
          content: [{ type: "text", text: payload.text }],
          timestamp: payload.timestamp ?? timestampFromOccurredAt(event.occurredAt),
        }));
        break;
      }

      case "assistant.message.appended": {
        const payload = AssistantMessageAppendedPayloadSchema.parse(event.payload);
        const exact = payload.content !== undefined
          && payload.stopReason !== undefined
          && payload.timestamp !== undefined;
        if (!exact) fidelity = "legacy_text_only";

        const content = payload.content ?? [{ type: "text" as const, text: payload.text }];
        if (payload.content !== undefined && assistantText(payload.content) !== payload.text) {
          throw new Error("assistant transcript text/content mismatch");
        }
        for (const block of content) {
          if (block.type !== "toolCall") continue;
          if (seenToolCallIds.has(block.id)) {
            throw new Error(`duplicate transcript tool call id: ${block.id}`);
          }
          seenToolCallIds.add(block.id);
          pending.set(block.id, block.name);
        }

        messages.push(TranscriptAssistantMessageSchema.parse({
          role: "assistant",
          content,
          stopReason: payload.stopReason ?? "stop",
          ...(payload.errorMessage !== undefined ? { errorMessage: payload.errorMessage } : {}),
          timestamp: payload.timestamp ?? timestampFromOccurredAt(event.occurredAt),
        }));
        break;
      }

      case "tool.result.appended": {
        const payload = ToolResultAppendedPayloadSchema.parse(event.payload);
        const expectedToolName = pending.get(payload.toolCallId);
        if (expectedToolName === undefined) {
          throw new Error(`tool result references unresolved/unknown tool call: ${payload.toolCallId}`);
        }
        if (expectedToolName !== payload.toolName) {
          throw new Error(`tool result name mismatch for ${payload.toolCallId}: expected ${expectedToolName}, got ${payload.toolName}`);
        }
        pending.delete(payload.toolCallId);
        messages.push(TranscriptToolResultMessageSchema.parse({
          role: "toolResult",
          toolCallId: payload.toolCallId,
          toolName: payload.toolName,
          content: payload.content,
          isError: payload.isError,
          timestamp: payload.timestamp,
        }));
        break;
      }
    }
  }

  const pendingToolCallIds = [...pending.keys()].sort();
  return {
    messages,
    status: pendingToolCallIds.length === 0 ? "complete" : "incomplete",
    pendingToolCallIds,
    fidelity,
    lastSequence,
  };
}
