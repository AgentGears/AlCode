// Ola differential golden corpus — executes TypeScript semantic functions
// against checked-in JSON fixtures produced from the Ola JS oracle.
// The fixtures are canonical; the frozen rollback rule says the fixture wins.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeStrength,
  applyRecordSeen,
  applyRecordUse,
  createInitialStats,
  rankByBlendedScore,
  isValidTransition,
} from "./index.ts";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf-8"));
}

const NOW = Date.UTC(2026, 6, 1);
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Strength/decay differential (narrow tolerance)
// ---------------------------------------------------------------------------

describe("differential: strength/decay (Ola golden corpus)", () => {
  const fixture = loadFixture("strength.json") as {
    cases: Array<{
      name: string;
      input: { confidence: number; consolidation_count: number; daysSinceUse: number };
      expected: number;
      tolerance: number;
    }>;
  };

  for (const c of fixture.cases) {
    it(c.name, () => {
      const refTime = NOW - c.input.daysSinceUse * MS_PER_DAY;
      const strength = computeStrength({
        confidence: c.input.confidence,
        consolidation_count: c.input.consolidation_count,
        last_used: c.input.daysSinceUse === 0 ? NOW : refTime,
        created_at: refTime,
      }, NOW);
      expect(Math.abs(strength - c.expected)).toBeLessThanOrEqual(c.tolerance);
    });
  }
});

// ---------------------------------------------------------------------------
// Reinforcement differential
// ---------------------------------------------------------------------------

describe("differential: reinforcement (Ola golden corpus)", () => {
  const fixture = loadFixture("reinforcement.json") as {
    cases: Array<{
      name: string;
      input: { operation: string; calls?: number; seenCalls?: number; usedCalls?: number };
      expected: Record<string, number | boolean>;
    }>;
  };

  for (const c of fixture.cases) {
    it(c.name, () => {
      const memId = "lesson/diff_test.md";
      let stats = createInitialStats(memId, "lesson", 0.8, NOW);

      if (c.input.operation === "seen") {
        for (let i = 0; i < (c.input.calls ?? 0); i++) {
          const r = applyRecordSeen(stats, NOW + i * 1000);
          stats = { ...stats, ...r };
        }
      } else if (c.input.operation === "used") {
        for (let i = 0; i < (c.input.calls ?? 0); i++) {
          const r = applyRecordUse(stats, NOW + i * 1000);
          stats = { ...stats, ...r };
        }
      } else if (c.input.operation === "mixed") {
        for (let i = 0; i < (c.input.seenCalls ?? 0); i++) {
          const r = applyRecordSeen(stats, NOW + i * 1000);
          stats = { ...stats, ...r };
        }
        for (let i = 0; i < (c.input.usedCalls ?? 0); i++) {
          const r = applyRecordUse(stats, NOW + i * 1000);
          stats = { ...stats, ...r };
        }
      }

      if (c.expected.seen_count !== undefined) expect(stats.seen_count).toBe(c.expected.seen_count);
      if (c.expected.used_count !== undefined) expect(stats.used_count).toBe(c.expected.used_count);
      if (c.expected.consolidation_count !== undefined) expect(stats.consolidation_count).toBe(c.expected.consolidation_count);
      if (c.expected.last_used_null === true) expect(stats.last_used).toBeNull();
      if (c.expected.last_used_null === false) expect(stats.last_used).not.toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// Lifecycle transition differential
// ---------------------------------------------------------------------------

describe("differential: lifecycle transitions (Ola golden corpus)", () => {
  const fixture = loadFixture("lifecycle.json") as {
    forwardTransitions: Array<{ from: string; to: string; allowed: boolean }>;
    restoreTransitions: Array<{ from: string; to: string; allowed: boolean }>;
    forbiddenTransitions: Array<{ from: string; to: string; allowed: boolean }>;
  };

  const allTransitions = [
    ...fixture.forwardTransitions,
    ...fixture.restoreTransitions,
    ...fixture.forbiddenTransitions,
  ];

  for (const t of allTransitions) {
    it(`${t.from} → ${t.to} should be ${t.allowed ? "allowed" : "forbidden"}`, () => {
      expect(isValidTransition(t.from as never, t.to as never)).toBe(t.allowed);
    });
  }
});

// ---------------------------------------------------------------------------
// Scoring differential
// ---------------------------------------------------------------------------

describe("differential: scoring (Ola golden corpus)", () => {
  const fixture = loadFixture("scoring.json") as {
    cases: Array<{
      name: string;
      input: {
        query: string;
        memoryName: string;
        confidence: number;
        usedCount: number;
        lastUsed: number | null;
        daysSinceCreation: number;
        tags?: string[];
      };
      expected: { final?: number; exact_match: boolean };
    }>;
  };

  for (const c of fixture.cases) {
    it(c.name, () => {
      const createdAt = NOW - c.input.daysSinceCreation * MS_PER_DAY;
      const stats = createInitialStats("lesson/diff_score.md", "lesson", c.input.confidence, createdAt);
      stats.used_count = c.input.usedCount;
      stats.last_used = c.input.lastUsed;

      const record = {
        type: "lesson" as const,
        memory_id: "lesson/diff_score.md",
        name: c.input.memoryName,
        stored_at: createdAt,
        fields: {
          lesson_name: c.input.memoryName,
          content: c.input.memoryName,
          domain: "test",
          tags: c.input.tags ?? [],
        } as Record<string, unknown>,
      } as unknown as import("./schema.ts").MemoryRecord;

      const statsMap = new Map([[record.memory_id, stats]]);
      const ranked = rankByBlendedScore([record], statsMap, c.input.query, NOW);

      if (c.expected.final !== undefined) {
        expect(ranked[0]!.score.final).toBe(c.expected.final);
      }
      expect(ranked[0]!.score.exact_match).toBe(c.expected.exact_match);
    });
  }
});

// ---------------------------------------------------------------------------
// Active-only retrieval differential (fail closed)
// ---------------------------------------------------------------------------

describe("differential: active-only retrieval (fail closed)", () => {
  it("archived memory is excluded even on exact match", () => {
    const record = {
      type: "lesson" as const,
      memory_id: "lesson/archived_exact.md",
      name: "archived_exact",
      stored_at: NOW,
      fields: { lesson_name: "archived_exact", content: "archived_exact", domain: "test" } as Record<string, unknown>,
    } as unknown as import("./schema.ts").MemoryRecord;

    const stats = createInitialStats("lesson/archived_exact.md", "lesson", 0.8, NOW);
    stats.lifecycle = "archived";

    const statsMap = new Map([[record.memory_id, stats]]);
    const ranked = rankByBlendedScore([record], statsMap, "archived_exact", NOW);
    expect(ranked.length).toBe(0);
  });

  it("memory with no stats row is excluded (fail closed)", () => {
    const record = {
      type: "lesson" as const,
      memory_id: "lesson/no_stats.md",
      name: "no_stats",
      stored_at: NOW,
      fields: { lesson_name: "no_stats", content: "no_stats", domain: "test" } as Record<string, unknown>,
    } as unknown as import("./schema.ts").MemoryRecord;

    // No stats row at all — fail closed
    const statsMap = new Map<string, never>();
    const ranked = rankByBlendedScore([record], statsMap, "no_stats", NOW);
    expect(ranked.length).toBe(0);
  });

  it("active memory with stats and exact match scores 1.0", () => {
    const record = {
      type: "lesson" as const,
      memory_id: "lesson/active_exact.md",
      name: "active_exact",
      stored_at: NOW,
      fields: { lesson_name: "active_exact", content: "active_exact", domain: "test" } as Record<string, unknown>,
    } as unknown as import("./schema.ts").MemoryRecord;

    const stats = createInitialStats("lesson/active_exact.md", "lesson", 0.8, NOW);
    const statsMap = new Map([[record.memory_id, stats]]);
    const ranked = rankByBlendedScore([record], statsMap, "active_exact", NOW);

    expect(ranked.length).toBe(1);
    expect(ranked[0]!.score.final).toBe(1.0);
  });
});
