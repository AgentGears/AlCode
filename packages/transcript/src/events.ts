import { z } from "zod";
import {
  TranscriptTextContentSchema,
  TranscriptToolCallContentSchema,
} from "./messages.ts";

export const UserMessageAppendedPayloadSchema = z.object({
  text: z.string(),
  timestamp: z.number().finite().optional(),
}).strict();

export const AssistantMessageAppendedPayloadSchema = z.object({
  text: z.string(),
  content: z.array(z.union([TranscriptTextContentSchema, TranscriptToolCallContentSchema])).optional(),
  stopReason: z.enum(["stop", "length", "tool_use", "error", "aborted"]).optional(),
  errorMessage: z.string().optional(),
  timestamp: z.number().finite().optional(),
}).strict();

export const ToolResultAppendedPayloadSchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  content: z.array(TranscriptTextContentSchema),
  isError: z.boolean(),
  timestamp: z.number().finite(),
}).strict();

export type UserMessageAppendedPayload = z.infer<typeof UserMessageAppendedPayloadSchema>;
export type AssistantMessageAppendedPayload = z.infer<typeof AssistantMessageAppendedPayloadSchema>;
export type ToolResultAppendedPayload = z.infer<typeof ToolResultAppendedPayloadSchema>;

export type TranscriptEventType =
  | "user.message.appended"
  | "assistant.message.appended"
  | "tool.result.appended";

export interface TranscriptEventRecord {
  eventId: string;
  sequence: number;
  type: TranscriptEventType;
  payload: unknown;
  occurredAt: string;
  operationId?: string;
}

export function isTranscriptEventType(type: string): type is TranscriptEventType {
  return type === "user.message.appended"
    || type === "assistant.message.appended"
    || type === "tool.result.appended";
}
