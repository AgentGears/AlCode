// Memory schema — Ola-derived data types for the @alcode/memory engine.
//
// The key architectural split from Ola: immutable content/provenance lives
// separately from mutable usage/strength/lifecycle statistics. A MemoryRecord
// never changes after creation; a MemoryStats row changes on every access.
//
// See the Ola inventory at C:/Next-Era/Ola/hooks/lib/strength.js for the
// authoritative source of every field and value.

// ---------------------------------------------------------------------------
// Internal types (wire type → internal type)
// ---------------------------------------------------------------------------

export type MemoryWireType = "experience" | "trajectory";
export type MemoryInternalType = "playbook" | "lesson";

export function toInternalType(wireType: MemoryWireType): MemoryInternalType {
  return wireType === "experience" ? "playbook" : "lesson";
}

// ---------------------------------------------------------------------------
// Lesson schema — "what one task taught"
// ---------------------------------------------------------------------------

export type LessonOutcome = "success" | "partial" | "failure" | "unfinished" | "unknown";
export type StageAnchor = "opening" | "pre_tool" | "before_write" | "terminal";

export interface LessonFields {
  lesson_name: string;
  outcome: LessonOutcome;
  stage_anchor: StageAnchor;
  retrieval_anchor: string;
  not_applicable_when: string;
  domain: string;
  tools_used?: string[];
  verification_boundary: string;
  quality_notes?: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Playbook schema — "refined judgment distilled from many lessons"
// ---------------------------------------------------------------------------

export type PlaybookStatus = "provisional" | "active" | "superseded" | "deprecated";
export type PlaybookConfidence = "low" | "medium" | "high";

export interface PlaybookFields {
  playbook_name: string;
  status: PlaybookStatus;
  confidence: PlaybookConfidence;
  retrieval_anchor: string;
  not_applicable_when: string;
  tags: string[];
  evidence_basis: string;
  supersedes?: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Immutable MemoryRecord — content + provenance, never changes
// ---------------------------------------------------------------------------

export interface MemoryRecord {
  type: MemoryInternalType;
  memory_id: string;
  name: string;
  fields: LessonFields | PlaybookFields;
  stored_at: number;
}

// ---------------------------------------------------------------------------
// Mutable MemoryStats — usage, strength, lifecycle (sidecar)
// ---------------------------------------------------------------------------

export type MemoryLifecycle = "active" | "archived" | "tombstoned" | "deleted";

export interface MemoryStats {
  memory_id: string;
  type: MemoryInternalType;
  confidence: number;
  last_seen: number | null;
  last_used: number | null;
  seen_count: number;
  used_count: number;
  consolidation_count: number;
  strength: number;
  lifecycle: MemoryLifecycle;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// MemoryEvent — audit log entry
// ---------------------------------------------------------------------------

export type MemoryEventType =
  | "created"
  | "seen"
  | "used"
  | "consolidated"
  | "archived"
  | "tombstoned"
  | "deleted"
  | "active";

export interface MemoryEvent {
  memory_id: string;
  event_type: MemoryEventType;
  source: string | null;
  reason: string | null;
  timestamp: number;
  metadata_json: string | null;
}

// ---------------------------------------------------------------------------
// Scored result from retrieval
// ---------------------------------------------------------------------------

export interface MemoryScoreBreakdown {
  final: number;
  relevance: number;
  structural: number;
  strength: number;
  exact_match: boolean;
}

export interface ScoredMemory {
  record: MemoryRecord;
  stats: MemoryStats | null;
  score: MemoryScoreBreakdown;
}

// ---------------------------------------------------------------------------
// Query context (optional, for structural scoring)
// ---------------------------------------------------------------------------

export interface RetrievalQueryContext {
  domain?: string;
}
