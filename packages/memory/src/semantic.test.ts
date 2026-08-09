// Semantic formula tests — ported from Ola's test-contracts.cjs assertions.
// These are the behavioral oracle regressions. Every formula value must
// match Ola's exact expected ranges.

import { describe, expect, it } from "vitest";
import {
  resolveConfidence,
  computeStrength,
  DECAY_RATE,
  CONSOLIDATION_FACTOR,
  USES_PER_CONSOLIDATION,
  ARCHIVE_STRENGTH_THRESHOLD,
  WEIGHTS,
  tokenize,
  searchableText,
  relevanceScore,
  structuralScore,
  isExactMatch,
  rankByBlendedScore,
  applyRecordSeen,
  applyRecordUse,
  isValidTransition,
  createInitialStats,
  formatMemoryId,
  parseMemoryId,
  slugFromTimestamp,
  toInternalType,
  type MemoryRecord,
  type MemoryStats,
} from "./index.ts";

// Fixed reference time for deterministic tests: 2026-07-01T00:00:00.000Z
const NOW = Date.UTC(2026, 6, 1);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants match Ola", () => {
  it("decay rate is 0.1", () => {
    expect(DECAY_RATE).toBe(0.1);
  });

  it("consolidation factor is 0.2", () => {
    expect(CONSOLIDATION_FACTOR).toBe(0.2);
  });

  it("uses per consolidation is 5", () => {
    expect(USES_PER_CONSOLIDATION).toBe(5);
  });

  it("archive strength threshold is 0.1", () => {
    expect(ARCHIVE_STRENGTH_THRESHOLD).toBe(0.1);
  });

  it("scoring weights sum to 1.0", () => {
    const sum = WEIGHTS.relevance + WEIGHTS.structural + WEIGHTS.strength;
    expect(Math.abs(sum - 1.0)).toBeLessThan(1e-9);
  });

  it("scoring weights match Ola", () => {
    expect(WEIGHTS.relevance).toBe(0.65);
    expect(WEIGHTS.structural).toBe(0.20);
    expect(WEIGHTS.strength).toBe(0.15);
  });
});

// ---------------------------------------------------------------------------
// Confidence resolution
// ---------------------------------------------------------------------------

describe("resolveConfidence", () => {
  it("maps playbook levels", () => {
    expect(resolveConfidence("low")).toBe(0.4);
    expect(resolveConfidence("medium")).toBe(0.7);
    expect(resolveConfidence("high")).toBe(0.9);
  });

  it("maps lesson outcomes", () => {
    expect(resolveConfidence("success")).toBe(0.8);
    expect(resolveConfidence("partial")).toBe(0.5);
    expect(resolveConfidence("failure")).toBe(0.3);
    expect(resolveConfidence("unfinished")).toBe(0.5);
    expect(resolveConfidence("unknown")).toBe(0.5);
  });

  it("clamps numeric to [0,1]", () => {
    expect(resolveConfidence(0.65)).toBe(0.65);
    expect(resolveConfidence(1.5)).toBe(1);
    expect(resolveConfidence(-0.3)).toBe(0);
  });

  it("defaults to 0.5 for unknown", () => {
    expect(resolveConfidence(undefined)).toBe(0.5);
    expect(resolveConfidence("nonexistent")).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Strength / Ebbinghaus decay
// ---------------------------------------------------------------------------

describe("computeStrength", () => {
  it("confidence 0.9, 0 days, consolidation 0 → ≈0.9", () => {
    const s = computeStrength({
      confidence: 0.9,
      consolidation_count: 0,
      last_used: NOW,
      created_at: NOW,
    }, NOW);
    expect(s).toBeGreaterThanOrEqual(0.89);
    expect(s).toBeLessThanOrEqual(0.91);
  });

  it("confidence 0.9, 7 days, consolidation 0 → ≈0.447", () => {
    const sevenDaysAgo = NOW - 7 * 86_400_000;
    const s = computeStrength({
      confidence: 0.9,
      consolidation_count: 0,
      last_used: sevenDaysAgo,
      created_at: sevenDaysAgo,
    }, NOW);
    // 0.9 × exp(−0.7) ≈ 0.447
    expect(s).toBeGreaterThanOrEqual(0.40);
    expect(s).toBeLessThanOrEqual(0.50);
  });

  it("confidence 0.9, 7 days, consolidation 5 → ≈0.634", () => {
    const sevenDaysAgo = NOW - 7 * 86_400_000;
    const s = computeStrength({
      confidence: 0.9,
      consolidation_count: 5,
      last_used: sevenDaysAgo,
      created_at: sevenDaysAgo,
    }, NOW);
    // divisor = 1 + 0.2×5 = 2.0; 0.9 × exp(−0.35) ≈ 0.634
    expect(s).toBeGreaterThanOrEqual(0.58);
    expect(s).toBeLessThanOrEqual(0.68);
  });

  it("falls back to created_at when last_used is null", () => {
    const threeDaysAgo = NOW - 3 * 86_400_000;
    const s = computeStrength({
      confidence: 0.7,
      consolidation_count: 0,
      last_used: null,
      created_at: threeDaysAgo,
    }, NOW);
    // 0.7 × exp(−0.3) ≈ 0.519
    expect(s).toBeGreaterThan(0.4);
    expect(s).toBeLessThan(0.6);
  });

  it("clamps to [0, 1]", () => {
    const s = computeStrength({
      confidence: 2.0,
      consolidation_count: 0,
      last_used: NOW,
      created_at: NOW,
    }, NOW);
    expect(s).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  it("splits on non-alphanumeric and drops length ≤ 1", () => {
    expect(tokenize("hello world")).toEqual(["hello", "world"]);
    expect(tokenize("a b c")).toEqual([]);
    // The tokenizer's allowed charset includes _/. so dots and underscores
    // are preserved within tokens, not treated as delimiters.
    expect(tokenize("auth token file.ts")).toEqual(["auth", "token", "file.ts"]);
  });

  it("lowercases", () => {
    expect(tokenize("Hello WORLD")).toEqual(["hello", "world"]);
  });

  it("empty string returns empty array", () => {
    expect(tokenize("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<MemoryRecord>): MemoryRecord {
  return {
    type: "lesson",
    memory_id: "lesson/test_2026-07-01T000000000Z.md",
    name: "test",
    stored_at: NOW,
    fields: {
      lesson_name: "test",
      outcome: "success",
      stage_anchor: "terminal",
      retrieval_anchor: "test anchor",
      not_applicable_when: "never",
      domain: "testing",
      content: "test content",
      verification_boundary: "tests pass",
    },
    ...overrides,
  };
}

describe("relevanceScore", () => {
  it("returns 1.0 when all query tokens match", () => {
    const record = makeRecord({});
    expect(relevanceScore(record, tokenize("test content"))).toBe(1);
  });

  it("returns 0 when no tokens match", () => {
    const record = makeRecord({});
    expect(relevanceScore(record, tokenize("xyzzy"))).toBe(0);
  });

  it("returns 0 for empty query", () => {
    const record = makeRecord({});
    expect(relevanceScore(record, [])).toBe(0);
  });
});

describe("isExactMatch", () => {
  it("matches memory_id in query", () => {
    const record = makeRecord({});
    expect(isExactMatch(record, "lesson/test_2026-07-01T000000000Z.md", [])).toBe(true);
  });

  it("matches exact name", () => {
    const record = makeRecord({});
    expect(isExactMatch(record, "test", ["test"])).toBe(true);
  });

  it("matches quoted name", () => {
    const record = makeRecord({});
    expect(isExactMatch(record, '"test" something else', ['"test"', "something", "else"])).toBe(true);
  });

  it("matches single-tag exact query", () => {
    const record = makeRecord({
      type: "playbook",
      fields: {
        playbook_name: "tagged",
        status: "active",
        confidence: "medium",
        retrieval_anchor: "anchor",
        not_applicable_when: "never",
        tags: ["auth", "security"],
        evidence_basis: "test",
        content: "test",
      },
    });
    expect(isExactMatch(record, "auth", ["auth"])).toBe(true);
  });

  it("does not match unrelated query", () => {
    const record = makeRecord({});
    expect(isExactMatch(record, "unrelated", ["unrelated"])).toBe(false);
  });
});

describe("rankByBlendedScore", () => {
  it("exact match ranks first with final=1.0", () => {
    const record = makeRecord({});
    const statsMap = new Map<string, MemoryStats>();
    const ranked = rankByBlendedScore([record], statsMap, "test", NOW);
    expect(ranked[0]!.score.final).toBe(1);
    expect(ranked[0]!.score.exact_match).toBe(true);
  });

  it("higher strength ranks higher for same relevance", () => {
    const record1 = makeRecord({ memory_id: "lesson/a.md", name: "a" });
    const record2 = makeRecord({ memory_id: "lesson/b.md", name: "b" });
    const statsMap = new Map<string, MemoryStats>([
      ["lesson/a.md", createInitialStats("lesson/a.md", "lesson", 0.9, NOW)],
      ["lesson/b.md", createInitialStats("lesson/b.md", "lesson", 0.3, NOW)],
    ]);
    // Both have same relevance (no query tokens match names a/b)
    const ranked = rankByBlendedScore([record1, record2], statsMap, "test content", NOW);
    // Higher confidence → higher strength → higher blended score
    expect(ranked[0]!.score.strength).toBeGreaterThanOrEqual(ranked[1]!.score.strength);
  });
});

// ---------------------------------------------------------------------------
// recordSeen vs recordUse
// ---------------------------------------------------------------------------

describe("recordSeen", () => {
  it("increments seen_count, sets last_seen, does NOT touch strength", () => {
    const stats = createInitialStats("lesson/test.md", "lesson", 0.8, NOW);
    const before = stats.strength;
    const result = applyRecordSeen(stats, NOW + 1000);

    expect(result.seen_count).toBe(1);
    expect(result.last_seen).toBe(NOW + 1000);
    // Does NOT include used_count, strength, consolidation_count
    expect(result).not.toHaveProperty("used_count");
    expect(result).not.toHaveProperty("strength");
    expect(result).not.toHaveProperty("consolidation_count");
  });
});

describe("recordUse", () => {
  it("increments used_count, sets last_used, updates strength", () => {
    const stats = createInitialStats("lesson/test.md", "lesson", 0.8, NOW);
    const result = applyRecordUse(stats, NOW + 1000);

    expect(result.used_count).toBe(1);
    expect(result.last_used).toBe(NOW + 1000);
    expect(result.strength).toBeGreaterThan(0);
    expect(result.isConsolidation).toBe(false);
  });

  it("increments consolidation_count every 5th use", () => {
    let stats = createInitialStats("lesson/test.md", "lesson", 0.8, NOW);

    // 4 uses — no consolidation
    for (let i = 1; i <= 4; i++) {
      const result = applyRecordUse(stats, NOW + i * 1000);
      stats = { ...stats, ...result };
      expect(result.isConsolidation).toBe(false);
    }
    expect(stats.consolidation_count).toBe(0);
    expect(stats.used_count).toBe(4);

    // 5th use — consolidation!
    const result = applyRecordUse(stats, NOW + 5000);
    expect(result.isConsolidation).toBe(true);
    expect(result.consolidation_count).toBe(1);
    expect(result.used_count).toBe(5);
  });

  it("recordSeen does NOT affect recordUse's used_count", () => {
    let stats = createInitialStats("lesson/test.md", "lesson", 0.8, NOW);

    // 5 recordSeen calls
    for (let i = 0; i < 5; i++) {
      const result = applyRecordSeen(stats, NOW + i * 1000);
      stats = { ...stats, ...result };
    }

    expect(stats.seen_count).toBe(5);
    expect(stats.used_count).toBe(0); // unchanged
    expect(stats.last_used).toBe(null); // unchanged

    // Now one recordUse
    const useResult = applyRecordUse(stats, NOW + 10000);
    expect(useResult.used_count).toBe(1);
    expect(useResult.last_used).toBe(NOW + 10000);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

describe("lifecycle transitions", () => {
  it("allows active → archived", () => {
    expect(isValidTransition("active", "archived")).toBe(true);
  });

  it("allows archived → tombstoned", () => {
    expect(isValidTransition("archived", "tombstoned")).toBe(true);
  });

  it("allows tombstoned → deleted", () => {
    expect(isValidTransition("tombstoned", "deleted")).toBe(true);
  });

  it("allows archived → active (restore)", () => {
    expect(isValidTransition("archived", "active")).toBe(true);
  });

  it("rejects active → tombstoned (no skipping)", () => {
    expect(isValidTransition("active", "tombstoned")).toBe(false);
  });

  it("rejects tombstoned → active (no restore from tombstone)", () => {
    expect(isValidTransition("tombstoned", "active")).toBe(false);
  });

  it("rejects deleted → anything", () => {
    expect(isValidTransition("deleted", "active")).toBe(false);
    expect(isValidTransition("deleted", "archived")).toBe(false);
  });

  it("rejects same-state transitions", () => {
    expect(isValidTransition("active", "active")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe("formatMemoryId", () => {
  it("constructs type/slug.md", () => {
    expect(formatMemoryId("lesson", "my_lesson")).toBe("lesson/my_lesson.md");
    expect(formatMemoryId("playbook", "auth_playbook.md")).toBe("playbook/auth_playbook.md");
  });

  it("rejects invalid type", () => {
    expect(() => formatMemoryId("invalid" as never, "slug")).toThrow();
  });

  it("rejects empty slug", () => {
    expect(() => formatMemoryId("lesson", "")).toThrow();
  });
});

describe("parseMemoryId", () => {
  it("splits on first /", () => {
    expect(parseMemoryId("lesson/test.md")).toEqual({ type: "lesson", slug: "test.md" });
  });
});

describe("slugFromTimestamp", () => {
  it("strips colons and dots from ISO timestamp", () => {
    const slug = slugFromTimestamp("my_lesson", "2026-07-01T02:14:55.123Z");
    expect(slug).toBe("my_lesson_2026-07-01T021455123Z");
  });
});

describe("toInternalType", () => {
  it("experience → playbook", () => {
    expect(toInternalType("experience")).toBe("playbook");
  });

  it("trajectory → lesson", () => {
    expect(toInternalType("trajectory")).toBe("lesson");
  });
});
