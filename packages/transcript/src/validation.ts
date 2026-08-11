import {
  AssistantMessageAppendedPayloadSchema,
  ToolResultAppendedPayloadSchema,
  UserMessageAppendedPayloadSchema,
  type TranscriptEventType,
} from "./events.ts";
import { assistantText, type TranscriptMessage } from "./messages.ts";
import type { ReducedTranscript } from "./reducer.ts";

function toolCalls(messages: readonly TranscriptMessage[]): Map<string, string> {
  const calls = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      if (calls.has(block.id)) throw new Error(`duplicate transcript tool call id: ${block.id}`);
      calls.set(block.id, block.name);
    }
  }
  return calls;
}

export function assertRichTranscriptTransition(
  current: ReducedTranscript,
  type: TranscriptEventType,
  payload: unknown,
): void {
  switch (type) {
    case "user.message.appended": {
      const parsed = UserMessageAppendedPayloadSchema.parse(payload);
      if (parsed.timestamp === undefined) {
        throw new Error("new rich user transcript event requires timestamp");
      }
      return;
    }

    case "assistant.message.appended": {
      const parsed = AssistantMessageAppendedPayloadSchema.parse(payload);
      if (parsed.content === undefined || parsed.stopReason === undefined || parsed.timestamp === undefined) {
        throw new Error("new rich assistant transcript event requires content, stopReason, and timestamp");
      }
      if (assistantText(parsed.content) !== parsed.text) {
        throw new Error("assistant transcript text/content mismatch");
      }
      const existing = toolCalls(current.messages);
      const candidate = new Set<string>();
      for (const block of parsed.content) {
        if (block.type !== "toolCall") continue;
        if (existing.has(block.id) || candidate.has(block.id)) {
          throw new Error(`duplicate transcript tool call id: ${block.id}`);
        }
        candidate.add(block.id);
      }
      return;
    }

    case "tool.result.appended": {
      const parsed = ToolResultAppendedPayloadSchema.parse(payload);
      const calls = toolCalls(current.messages);
      if (!current.pendingToolCallIds.includes(parsed.toolCallId)) {
        throw new Error(`tool result references unresolved/unknown tool call: ${parsed.toolCallId}`);
      }
      const expectedToolName = calls.get(parsed.toolCallId);
      if (expectedToolName !== parsed.toolName) {
        throw new Error(`tool result name mismatch for ${parsed.toolCallId}: expected ${expectedToolName ?? "unknown"}, got ${parsed.toolName}`);
      }
      return;
    }
  }
}
