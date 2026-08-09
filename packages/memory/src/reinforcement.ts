// Reinforcement + lifecycle — ported exactly from Ola's strength.js.
//
// recordSeen and recordUse are separate public operations, not a shared
// function with a boolean. This is load-bearing for Contract 4.
//
// recordSeen: seen_count++, last_seen=now. Does NOT touch strength.
// recordUse: used_count++, last_used=now, consolidation_count++ on every
//   5th use, strength snapshot updated. Affects decay through consolidation.

import type { MemoryStats, MemoryLifecycle, MemoryInternalType } from "./schema.ts";
import { computeStrength, USES_PER_CONSOLIDATION } from "./decay.ts";

// ---------------------------------------------------------------------------
// recordSeen — informational, no strength change
// ---------------------------------------------------------------------------

/**
 * The result of a recordSeen operation: the updated stats fields.
 * Does NOT change strength, used_count, last_used, or consolidation_count.
 */
export function applyRecordSeen(
  stats: MemoryStats,
  now: number,
): { seen_count: number; last_seen: number; updated_at: number } {
  return {
    seen_count: stats.seen_count + 1,
    last_seen: now,
    updated_at: now,
  };
}

// ---------------------------------------------------------------------------
// recordUse — reinforces, affects strength via consolidation
// ---------------------------------------------------------------------------

/**
 * The result of a recordUse operation: the updated stats fields.
 * Changes: used_count++, last_used=now, consolidation_count++ if the new
 * used_count is a multiple of USES_PER_CONSOLIDATION, strength snapshot,
 * updated_at=now.
 */
export function applyRecordUse(
  stats: MemoryStats,
  now: number,
  source?: string,
): {
  used_count: number;
  consolidation_count: number;
  last_used: number;
  strength: number;
  updated_at: number;
  isConsolidation: boolean;
} {
  const newUsedCount = (stats.used_count || 0) + 1;
  const isConsolidation = newUsedCount % USES_PER_CONSOLIDATION === 0;
  const newConsolidation = stats.consolidation_count + (isConsolidation ? 1 : 0);

  const newStrength = computeStrength(
    {
      confidence: stats.confidence,
      consolidation_count: newConsolidation,
      last_used: now,
      created_at: now, // COALESCE picks last_used=now since it's non-null
    },
    now,
  );

  return {
    used_count: newUsedCount,
    consolidation_count: newConsolidation,
    last_used: now,
    strength: newStrength,
    updated_at: now,
    isConsolidation,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

const FORWARD_TRANSITIONS: Record<string, MemoryLifecycle> = {
  active: "archived",
  archived: "tombstoned",
  tombstoned: "deleted",
};

export function isValidTransition(from: MemoryLifecycle, to: MemoryLifecycle): boolean {
  if (from === to) return false;
  if (FORWARD_TRANSITIONS[from] === to) return true;
  // The one allowed restore
  if (from === "archived" && to === "active") return true;
  return false;
}

export function assertValidTransition(from: MemoryLifecycle, to: MemoryLifecycle): void {
  if (!isValidTransition(from, to)) {
    throw new Error(
      `Invalid lifecycle transition: ${from} → ${to}. ` +
        `Valid: active→archived, archived→tombstoned, tombstoned→deleted, archived→active.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Stats factory — create initial stats for a new memory
// ---------------------------------------------------------------------------

export function createInitialStats(
  memoryId: string,
  type: MemoryInternalType,
  confidence: number,
  now: number,
): MemoryStats {
  return {
    memory_id: memoryId,
    type,
    confidence,
    last_seen: null,
    last_used: null,
    seen_count: 0,
    used_count: 0,
    consolidation_count: 0,
    strength: computeStrength(
      {
        confidence,
        consolidation_count: 0,
        last_used: null,
        created_at: now,
      },
      now,
    ),
    lifecycle: "active",
    created_at: now,
    updated_at: now,
  };
}
