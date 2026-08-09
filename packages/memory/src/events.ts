// Memory domain events — event type names and payload contracts.
//
// The memory package owns these event type names and payload contracts per
// the frozen event contract. The event infrastructure (@alcode/events) owns
// only the envelope. The Host owns event admission and durable state.
//
// Phase 0.2 established memory.created with payload v1 (memoryId, type, body).
// Phase 0.3 extends memory semantics. The preferred path is additive optional
// fields on payload v1 to preserve replay compatibility.

// ---------------------------------------------------------------------------
// memory.created (extended from Phase 0.2)
// ---------------------------------------------------------------------------

export interface MemoryCreatedPayload {
  /** Canonical memory ID: `<type>/<slug>.md` */
  memoryId: string;
  /** Internal type: "lesson" or "playbook" */
  type: string;
  /** Memory body / content */
  body: string;
  /** Short snake_case name */
  name: string;
  /** Confidence level (resolved numeric, 0-1) */
  confidence: number;
  /** Schema fields (lesson or playbook) as JSON-serializable object */
  fields: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// memory.reinforced — a recordUse or recordSeen occurred
// ---------------------------------------------------------------------------

export type ReinforcementKind = "seen" | "used" | "consolidated";

export interface MemoryReinforcedPayload {
  memoryId: string;
  /** What kind of reinforcement: seen, used, or consolidated (every 5th use) */
  kind: ReinforcementKind;
  /** New used_count or seen_count after reinforcement */
  count: number;
  /** New consolidation_count (only changes on "consolidated") */
  consolidationCount: number;
  /** Snapshot of recomputed strength */
  strength: number;
}

// ---------------------------------------------------------------------------
// memory.lifecycle — lifecycle transition
// ---------------------------------------------------------------------------

export interface MemoryLifecyclePayload {
  memoryId: string;
  /** Previous lifecycle state */
  from: string;
  /** New lifecycle state */
  to: string;
}

// ---------------------------------------------------------------------------
// Event type constants
// ---------------------------------------------------------------------------

export const MEMORY_EVENT_TYPES = {
  CREATED: "memory.created",
  REINFORCED: "memory.reinforced",
  ARCHIVED: "memory.archived",
  TOMBSTONED: "memory.tombstoned",
  DELETED: "memory.deleted",
  RESTORED: "memory.restored",
} as const;
