// @alcode/memory — the Ola-equivalent memory semantic engine.
//
// Owns: scoring, retrieval, decay, reinforcement, lifecycle, consolidation
// policy. Does NOT own event admission, SQLite, or agent-tool APIs.
//
// All semantic functions are pure: they accept explicit state and time and
// return deterministic output. Date.now() is never called inside a formula;
// `now` is always passed as an argument so differential fixtures reproduce
// exactly.
//
// See docs/adr/0005-runtime-ownership-boundaries.md §Host↔Memory.

// Schema types
export type {
  MemoryWireType,
  MemoryInternalType,
  LessonOutcome,
  StageAnchor,
  LessonFields,
  PlaybookStatus,
  PlaybookConfidence,
  PlaybookFields,
  MemoryRecord,
  MemoryStats,
  MemoryLifecycle,
  MemoryEvent,
  MemoryEventType,
  MemoryScoreBreakdown,
  ScoredMemory,
  RetrievalQueryContext,
} from "./schema.ts";
export { toInternalType } from "./schema.ts";

// Identity
export { formatMemoryId, parseMemoryId, slugFromTimestamp } from "./identity.ts";

// Decay + strength
export {
  DECAY_RATE,
  CONSOLIDATION_FACTOR,
  USES_PER_CONSOLIDATION,
  ARCHIVE_STRENGTH_THRESHOLD,
  TOMBSTONE_STRENGTH_THRESHOLD,
  ARCHIVE_AGE_DAYS,
  MS_PER_DAY,
  resolveConfidence,
  computeStrength,
  shouldSuggestArchive,
  shouldSuggestTombstone,
  type StrengthInput,
  type SuggestArchiveInput,
} from "./decay.ts";

// Scoring + retrieval
export {
  WEIGHTS,
  tokenize,
  searchableText,
  relevanceScore,
  structuralScore,
  isExactMatch,
  computeBlendedScore,
  rankByBlendedScore,
} from "./scoring.ts";

// Reinforcement + lifecycle
export {
  applyRecordSeen,
  applyRecordUse,
  isValidTransition,
  assertValidTransition,
  createInitialStats,
} from "./reinforcement.ts";

// Events
export {
  MEMORY_EVENT_TYPES,
  type MemoryCreatedPayload,
  type MemoryReinforcedPayload,
  type MemoryLifecyclePayload,
  type ReinforcementKind,
} from "./events.ts";
