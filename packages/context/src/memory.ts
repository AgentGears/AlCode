import {
  computeBlendedScore,
  isExactMatch,
  relevanceScore,
  structuralScore,
  tokenize,
  type MemoryRecord,
  type MemoryStats,
  type RetrievalQueryContext,
} from "@alcode/memory";
import type {
  MemoryContextAnchor,
  ReasoningFrontier,
  SelectedMemory,
} from "./types.ts";

export function buildMemoryAnchors(
  currentUserText: string,
  frontier: ReasoningFrontier,
): MemoryContextAnchor[] {
  const anchors: MemoryContextAnchor[] = [];
  const user = currentUserText.trim();
  if (user) anchors.push({ kind: "current_user", sourceId: "current_user", text: user });
  if (frontier.objective?.label.trim()) {
    anchors.push({ kind: "objective", sourceId: frontier.objective.id, text: frontier.objective.label.trim() });
  }
  for (const hypothesis of frontier.hypotheses) {
    const text = hypothesis.label.trim();
    if (text) anchors.push({ kind: "hypothesis", sourceId: hypothesis.id, text });
  }

  const seen = new Set<string>();
  return anchors.filter((anchor) => {
    const key = `${anchor.kind}\0${anchor.sourceId}\0${anchor.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isEligible(record: MemoryRecord, anchor: string, queryContext?: RetrievalQueryContext): boolean {
  const tokens = tokenize(anchor);
  return isExactMatch(record, anchor, tokens) ||
    relevanceScore(record, tokens) > 0 ||
    structuralScore(record, tokens, queryContext) > 0;
}

function anchorTieKey(anchor: MemoryContextAnchor): string {
  return `${anchor.kind}:${anchor.sourceId}:${anchor.text}`;
}

export function selectRelevantMemories(
  records: readonly MemoryRecord[],
  statsMap: ReadonlyMap<string, MemoryStats>,
  anchors: readonly MemoryContextAnchor[],
  now: number,
  queryContext?: RetrievalQueryContext,
): SelectedMemory[] {
  const selected = new Map<string, SelectedMemory>();

  for (const anchor of anchors) {
    const tokens = tokenize(anchor.text);
    for (const record of records) {
      const stats = statsMap.get(record.memory_id);
      if (!stats || stats.lifecycle !== "active") continue;
      if (!isEligible(record, anchor.text, queryContext)) continue;
      const { breakdown } = computeBlendedScore(record, stats, anchor.text, tokens, now, queryContext);
      const current = selected.get(record.memory_id);
      if (!current || breakdown.final > current.score.final ||
          (breakdown.final === current.score.final && anchorTieKey(anchor).localeCompare(anchorTieKey(current.anchor)) < 0)) {
        selected.set(record.memory_id, {
          memoryId: record.memory_id,
          anchor: structuredClone(anchor),
          score: breakdown,
          record,
        });
      }
    }
  }

  return [...selected.values()].sort((a, b) =>
    b.score.final - a.score.final ||
    a.memoryId.localeCompare(b.memoryId) ||
    anchorTieKey(a.anchor).localeCompare(anchorTieKey(b.anchor)));
}
