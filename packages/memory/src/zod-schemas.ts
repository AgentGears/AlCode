// Zod schemas for lesson and playbook memory records.
// See docs/phase-0-spec.md §0.3 and the Ola schemas at
// C:/Next-Era/Ola/schemas/lessons.yaml and playbooks.yaml.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Lesson schema — "what one task taught"
// ---------------------------------------------------------------------------

export const LessonFieldsSchema = z.object({
  lesson_name: z.string().min(1).max(64),
  outcome: z.enum(["success", "partial", "failure", "unfinished", "unknown"]),
  stage_anchor: z.enum(["opening", "pre_tool", "before_write", "terminal"]),
  retrieval_anchor: z.string(),
  not_applicable_when: z.string(),
  domain: z.string(),
  tools_used: z.array(z.string()).optional().default([]),
  verification_boundary: z.string(),
  quality_notes: z.string().optional().default(""),
  content: z.string(),
});

// ---------------------------------------------------------------------------
// Playbook schema — "refined judgment distilled from many lessons"
// ---------------------------------------------------------------------------

export const PlaybookFieldsSchema = z.object({
  playbook_name: z.string().min(1).max(64),
  status: z.enum(["provisional", "active", "superseded", "deprecated"]).default("provisional"),
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
  retrieval_anchor: z.string(),
  not_applicable_when: z.string(),
  tags: z.array(z.string()),
  evidence_basis: z.string(),
  supersedes: z.string().optional().default(""),
  content: z.string(),
});

// ---------------------------------------------------------------------------
// MemoryRecord schema (immutable record) — discriminated union on `type`
// ---------------------------------------------------------------------------

const LessonRecordSchema = z.object({
  type: z.literal("lesson"),
  memory_id: z.string(),
  name: z.string(),
  fields: LessonFieldsSchema,
  stored_at: z.number(),
  sourceEventIds: z.array(z.string()).optional(),
});

const PlaybookRecordSchema = z.object({
  type: z.literal("playbook"),
  memory_id: z.string(),
  name: z.string(),
  fields: PlaybookFieldsSchema,
  stored_at: z.number(),
  sourceEventIds: z.array(z.string()).optional(),
});

/** Discriminated union: type=lesson requires LessonFields, type=playbook requires PlaybookFields. */
export const MemoryRecordSchema = z.discriminatedUnion("type", [LessonRecordSchema, PlaybookRecordSchema]);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type LessonFieldsZod = z.infer<typeof LessonFieldsSchema>;
export type PlaybookFieldsZod = z.infer<typeof PlaybookFieldsSchema>;
export type MemoryRecordZod = z.infer<typeof MemoryRecordSchema>;

/** Validate a lesson fields object. Returns the parsed object or throws ZodError. */
export function validateLessonFields(fields: unknown): LessonFieldsZod {
  return LessonFieldsSchema.parse(fields);
}

/** Validate a playbook fields object. Returns the parsed object or throws ZodError. */
export function validatePlaybookFields(fields: unknown): PlaybookFieldsZod {
  return PlaybookFieldsSchema.parse(fields);
}
