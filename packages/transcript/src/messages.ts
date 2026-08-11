import { z } from "zod";

export const TranscriptTextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
}).strict();

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(JsonValueSchema),
  z.record(JsonValueSchema),
]));

export const TranscriptToolCallContentSchema = z.object({
  type: z.literal("toolCall"),
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(JsonValueSchema),
}).strict();

export const TranscriptUserMessageSchema = z.object({
  role: z.literal("user"),
  content: z.array(TranscriptTextContentSchema),
  timestamp: z.number().finite(),
}).strict();

export const TranscriptAssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.array(z.union([TranscriptTextContentSchema, TranscriptToolCallContentSchema])),
  stopReason: z.enum(["stop", "length", "tool_use", "error", "aborted"]),
  errorMessage: z.string().optional(),
  timestamp: z.number().finite(),
}).strict();

export const TranscriptToolResultMessageSchema = z.object({
  role: z.literal("toolResult"),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  content: z.array(TranscriptTextContentSchema),
  isError: z.boolean(),
  timestamp: z.number().finite(),
}).strict();

export const TranscriptMessageSchema = z.discriminatedUnion("role", [
  TranscriptUserMessageSchema,
  TranscriptAssistantMessageSchema,
  TranscriptToolResultMessageSchema,
]);

export type TranscriptTextContent = z.infer<typeof TranscriptTextContentSchema>;
export type TranscriptToolCallContent = z.infer<typeof TranscriptToolCallContentSchema>;
export type TranscriptUserMessage = z.infer<typeof TranscriptUserMessageSchema>;
export type TranscriptAssistantMessage = z.infer<typeof TranscriptAssistantMessageSchema>;
export type TranscriptToolResultMessage = z.infer<typeof TranscriptToolResultMessageSchema>;
export type TranscriptMessage = z.infer<typeof TranscriptMessageSchema>;

export function assistantText(content: readonly (TranscriptTextContent | TranscriptToolCallContent)[]): string {
  return content
    .filter((block): block is TranscriptTextContent => block.type === "text")
    .map((block) => block.text)
    .join("");
}
