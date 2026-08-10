// Strength + Ebbinghaus decay — ported exactly from Ola's computeStrength at
// C:/Next-Era/Ola/hooks/lib/strength.js:77-90.
//
// strength = confidence × exp(−DECAY_RATE × daysSinceUse / consolidationDivisor)
// clamped to [0, 1].

// ---------------------------------------------------------------------------
// Constants (exact values from Ola)
// ---------------------------------------------------------------------------

export const DECAY_RATE = 0.1;
export const CONSOLIDATION_FACTOR = 0.2;
export const USES_PER_CONSOLIDATION = 5;
export const ARCHIVE_STRENGTH_THRESHOLD = 0.1;
export const TOMBSTONE_STRENGTH_THRESHOLD = 0.02;
export const ARCHIVE_AGE_DAYS = 7;

export const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Confidence resolution (exact from Ola's resolveConfidence + CONFIDENCE_MAP)
// ---------------------------------------------------------------------------

const CONFIDENCE_MAP: Record<string, number> = {
  // Playbook confidence levels
  low: 0.4,
  medium: 0.7,
  high: 0.9,
  // Lesson outcome levels
  success: 0.8,
  partial: 0.5,
  failure: 0.3,
  unfinished: 0.5,
  unknown: 0.5,
};

export function resolveConfidence(level: string | number | undefined): number {
  if (level === undefined || level === null) return 0.5;
  if (typeof level === "number") {
    return Math.max(0, Math.min(1, level));
  }
  const mapped = CONFIDENCE_MAP[level];
  if (mapped !== undefined) return mapped;
  const parsed = parseFloat(level);
  if (!isNaN(parsed)) return Math.max(0, Math.min(1, parsed));
  return 0.5;
}

// ---------------------------------------------------------------------------
// computeStrength — pure function, accepts explicit time
// ---------------------------------------------------------------------------

export interface StrengthInput {
  confidence: number;
  consolidation_count: number;
  last_used: number | null;
  created_at: number;
}

/**
 * Compute the current strength of a memory using Ebbinghaus decay.
 *
 * Formula: confidence × exp(−DECAY_RATE × daysSinceUse / (1 + CONSOLIDATION_FACTOR × consolidationCount))
 * clamped to [0, 1].
 *
 * `daysSinceUse = max(0, (now − COALESCE(last_used, created_at, now)) / MS_PER_DAY)`
 *
 * @param input - the memory's stats fields needed for computation
 * @param now   - current time in ms epoch (passed explicitly for determinism)
 */
export function computeStrength(input: StrengthInput, now: number): number {
  const confidence = input.confidence !== undefined ? input.confidence : 0.5;
  const consolidationCount = input.consolidation_count || 0;
  const refMs = input.last_used || input.created_at || now;
  const daysSinceUse = Math.max(0, (now - refMs) / MS_PER_DAY);
  const consolidationDivisor = 1 + CONSOLIDATION_FACTOR * consolidationCount;
  const strength = confidence * Math.exp(-DECAY_RATE * daysSinceUse / consolidationDivisor);
  return Math.max(0, Math.min(1, strength));
}

// ---------------------------------------------------------------------------
// Auto-suggest thresholds
// ---------------------------------------------------------------------------

export interface SuggestArchiveInput {
  lifecycle: string;
  strength: number;
  used_count: number;
  created_at: number;
}

export function shouldSuggestArchive(input: SuggestArchiveInput, now: number): boolean {
  if (input.lifecycle !== "active") return false;
  if (input.strength >= ARCHIVE_STRENGTH_THRESHOLD) return false;
  if (input.used_count > 0) return false;
  const ageDays = (now - input.created_at) / MS_PER_DAY;
  return ageDays >= ARCHIVE_AGE_DAYS;
}

export function shouldSuggestTombstone(lifecycle: string, strength: number): boolean {
  return lifecycle === "archived" && strength < TOMBSTONE_STRENGTH_THRESHOLD;
}
