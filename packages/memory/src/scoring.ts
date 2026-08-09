// Scoring + retrieval — ported exactly from Ola's retrieval.js.
//
// Blended score: 0.65 × relevance + 0.20 × structural + 0.15 × strength.
// Exact-match override: if isExactMatch, final = 1.0 (blend bypassed).

import type {
  MemoryRecord,
  MemoryStats,
  ScoredMemory,
  MemoryScoreBreakdown,
  RetrievalQueryContext,
} from "./schema.ts";
import { computeStrength, type StrengthInput } from "./decay.ts";

// ---------------------------------------------------------------------------
// Weights (exact from Ola)
// ---------------------------------------------------------------------------

export const WEIGHTS = {
  relevance: 0.65,
  structural: 0.20,
  strength: 0.15,
} as const;

// ---------------------------------------------------------------------------
// Tokenization + searchable text
// ---------------------------------------------------------------------------

export function tokenize(text: string): string[] {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9_/.]+/)
    .filter((t) => t.length > 1);
}

export function searchableText(record: MemoryRecord): string {
  const fields = record.fields as unknown as Record<string, unknown>;
  const name = fields.lesson_name ?? fields.playbook_name ?? "";
  const domain = fields.domain ?? "";
  const tags = Array.isArray(fields.tags) ? (fields.tags as string[]).join(" ") : "";
  const content = typeof fields.content === "string" ? fields.content.slice(0, 500) : "";
  return [record.memory_id, fields.retrieval_anchor ?? "", name, domain, tags, content]
    .join(" ")
    .trim();
}

// ---------------------------------------------------------------------------
// Component scores
// ---------------------------------------------------------------------------

export function relevanceScore(record: MemoryRecord, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const haystack = searchableText(record).toLowerCase();
  const haystackTokens = new Set(tokenize(haystack));
  let matched = 0;
  for (const qt of queryTokens) {
    if (haystackTokens.has(qt) || haystack.includes(qt)) {
      matched++;
    }
  }
  return matched / queryTokens.length;
}

export function structuralScore(
  record: MemoryRecord,
  queryTokens: string[],
  queryContext?: RetrievalQueryContext,
): number {
  let score = 0;
  let components = 0;
  const fields = record.fields as unknown as Record<string, unknown>;
  const tags = Array.isArray(fields.tags) ? (fields.tags as string[]) : [];

  if (tags.length > 0) {
    const tagSet = new Set(tags.map((t) => String(t).toLowerCase()));
    const tagHits = queryTokens.filter((qt) => tagSet.has(qt)).length;
    score += Math.min(1, tagHits / Math.max(1, queryTokens.length));
    components++;
  }

  if (fields.domain && queryContext?.domain) {
    if (String(fields.domain).toLowerCase() === String(queryContext.domain).toLowerCase()) {
      score += 1;
    }
    components++;
  }

  return components > 0 ? score / components : 0;
}

// ---------------------------------------------------------------------------
// Exact-match detection
// ---------------------------------------------------------------------------

export function isExactMatch(
  record: MemoryRecord,
  query: string,
  queryTokens: string[],
): boolean {
  const q = query.toLowerCase().trim();
  if (record.memory_id && q.includes(record.memory_id.toLowerCase())) return true;

  const fields = record.fields as unknown as Record<string, unknown>;
  const name = (fields.lesson_name ?? fields.playbook_name ?? "").toString().toLowerCase();
  if (name && (q === name || q.includes(`"${name}"`))) return true;

  if (queryTokens.length === 1 && Array.isArray(fields.tags)) {
    if ((fields.tags as string[]).some((t) => String(t).toLowerCase() === queryTokens[0])) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Blended score + ranking
// ---------------------------------------------------------------------------

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export function computeBlendedScore(
  record: MemoryRecord,
  stats: MemoryStats | null,
  query: string,
  queryTokens: string[],
  now: number,
  queryContext?: RetrievalQueryContext,
): { breakdown: MemoryScoreBreakdown; strength: number } {
  const exact = isExactMatch(record, query, queryTokens);
  const rel = exact ? 1.0 : relevanceScore(record, queryTokens);
  const struct = structuralScore(record, queryTokens, queryContext);

  let strength = 0;
  if (stats) {
    const input: StrengthInput = {
      confidence: stats.confidence,
      consolidation_count: stats.consolidation_count,
      last_used: stats.last_used,
      created_at: stats.created_at,
    };
    strength = computeStrength(input, now);
  }

  let finalScore: number;
  if (exact) {
    finalScore = 1.0;
  } else {
    finalScore = WEIGHTS.relevance * rel + WEIGHTS.structural * struct + WEIGHTS.strength * strength;
  }

  return {
    breakdown: {
      final: round3(finalScore),
      relevance: round3(rel),
      structural: round3(struct),
      strength: round3(strength),
      exact_match: exact,
    },
    strength: round3(strength),
  };
}

/**
 * Rank memories by blended score, descending. Exact matches always rank first.
 *
 * Only active memories participate: records whose stats lifecycle is not
 * "active" are excluded before scoring. A memory with no stats row is
 * treated as active (it has not been lifecycle-managed yet).
 */
export function rankByBlendedScore(
  records: MemoryRecord[],
  statsMap: Map<string, MemoryStats>,
  query: string,
  now: number,
  options?: { limit?: number; queryContext?: RetrievalQueryContext },
): ScoredMemory[] {
  const queryTokens = tokenize(query);

  // Filter: exclude inactive memories (archived/tombstoned/deleted).
  // A memory with no stats row is treated as active.
  const activeRecords = records.filter((record) => {
    const stats = statsMap.get(record.memory_id);
    if (!stats) return true; // no stats = never lifecycle-managed = active
    return stats.lifecycle === "active";
  });

  const scored: ScoredMemory[] = activeRecords.map((record) => {
    const stats = statsMap.get(record.memory_id) ?? null;
    const { breakdown, strength: _strength } = computeBlendedScore(
      record,
      stats,
      query,
      queryTokens,
      now,
      options?.queryContext,
    );
    return { record, stats, score: breakdown };
  });

  scored.sort((a, b) => b.score.final - a.score.final);

  const limit = options?.limit ?? 0;
  return limit > 0 ? scored.slice(0, limit) : scored;
}
