# ALCODE A1 — Capacity and Hard-Limit Study

**Status:** Freeze evidence; no runtime implementation authority by itself.  
**Prepared:** 2026-08-24 against `main@5c6ab80af906d7baea11e0487580d9b7b2364276`.  
**Purpose:** Resolve the numeric-limit freeze blocker in `docs/a1-adaptive-program-plan.md`.

## 1. Decision summary

The A1 first slice should freeze these limits:

| Limit | Frozen value |
|---|---:|
| current WorkItems | 128 (unchanged) |
| total dependency edges | 1,024 (unchanged) |
| canonical current ProgramState | 4 MiB (unchanged) |
| Agent Attempt projection | 128 KiB (unchanged) |
| Application Program projection | 256 KiB (unchanged) |
| maximum decomposition depth | **8** |
| maximum direct children introduced by one decomposition | **8** |
| admitted semantic ProgramRevisions per Program, including initial/baseline | **32** |
| semantic revision proposal | **3 MiB** |
| canonical RevisionImpact | **256 KiB** |
| sealed pending semantic draft | **4 MiB** |
| one WorkAuthorityEnvelope | **8 KiB** |
| semantic revision advisory rationale/rejection diagnostic text | **4 KiB** |

No existing Phase-1 ceiling is raised by A1.

## 2. Repository baseline

`packages/program-state/src/limits.ts` already freezes the relevant envelope: 128 WorkItems, 32 direct dependencies per WorkItem, 1,024 total edges, 256 verification obligations, 2,048 evidence refs, 256 retained artifacts, 64 outputs/production steps, 4,096 total path-bearing entries, 1 MiB normalized path text, 512 KiB human text, 512 KiB predicate/production args, 4 MiB canonical ProgramState, 128 KiB Agent Attempt projection, and 256 KiB Application Program projection.

`packages/program-state/src/canonical.ts` defines deterministic canonical JSON. `packages/host-runtime/src/program-agent.ts` independently enforces the 128 KiB Attempt projection. These remain compatibility ceilings, not targets to expand.

## 3. Measurement method

The study reconstructed the current `ProgramState` wire shape from `packages/program-state/src/types.ts` and used equivalent canonical JSON size accounting for synthetic ASCII fixtures: lexicographically sorted object keys, compact separators, UTF-8 byte count.

The synthetic near-boundary Phase-1 fixture intentionally combines high cardinalities rather than representing an average Program:

- 128 WorkItems;
- 1,012 dependency edges using up to eight preceding dependencies per WorkItem;
- 256 verification obligations;
- 2,048 evidence refs;
- 256 artifacts;
- 64 output slots and 64 production steps;
- 64 blockers;
- 4,096 total path-bearing entries;
- approximately 983 KiB normalized path text;
- approximately 511 KiB objective/work/blocker text;
- approximately 499 KiB operation-verifier canonical arguments.

The A1 extension model then adds the semantics already fixed by the candidate plan: per-WorkItem generation/requirement/topology/parent data, a mechanically comparable authority envelope, semantic verification subject bindings, current ProgramRevision head, a large current RevisionImpact, and pending semantic-control slot.

This is capacity analysis, not production A1 code.

## 4. Measured results

| Fixture | Canonical bytes | Size | Ceiling | Headroom |
|---|---:|---:|---:|---:|
| near-boundary Phase-1 current state | 2,863,812 | 2.731 MiB | 4 MiB | 1.269 MiB |
| same state + representative A1 metadata + large impact | 3,143,758 | 2.998 MiB | 4 MiB | **1.002 MiB** |
| deliberately over-populated RevisionImpact | 159,017 | 155.3 KiB | 256 KiB | **100.7 KiB** |
| near-full semantic revision proposal | 2,466,644 | 2.352 MiB | 3 MiB | **663.2 KiB** |
| proposal + over-populated impact + 8 KiB seal/control | 2,633,853 | 2.512 MiB | 4 MiB draft | **~1.488 MiB** |
| representative mechanically rich WorkAuthorityEnvelope | 1,499 | 1.46 KiB | 8 KiB | **~6.54 KiB** |

The over-populated RevisionImpact deliberately fills categories that cannot all be simultaneously maximal in a valid transition: 128 modified + 128 added + 128 superseded + 128 withdrawn WorkItem refs, all five 256-entry verification-impact classes, and all four 64-entry output-impact classes. It is a conservative serialization bound.

## 5. Why decomposition depth = 8

Depth is principally a control/termination bound rather than a state-byte bound. A1 uses recursive derived discharge, so a depth ceiling gives the pure kernel a hard traversal bound and prevents a repeated one-child decomposition chain while total WorkItems remain below 128.

Eight levels are conservative for the first slice: recursive discharge is bounded by eight semantic edges, the number is materially below the 128-node graph ceiling, and all A1 revisions require exact Application acceptance. Root depth is 0; proposing a child at depth 9 rejects.

## 6. Why fan-out = 8

The current Application Program projection exposes at most 16 WorkItems before omissions. A parent plus eight immediate children remains visible together while leaving room for nearby work.

Fan-out eight also composes with the 128-WorkItem ceiling:

```text
starting from one WorkItem
1 + 8 * 15 = 121
1 + 8 * 16 = 129 > 128
```

A Program therefore cannot perform more than fifteen maximal eight-child decompositions from a one-item start without hitting the existing WorkItem ceiling. This reinforces progressive rather than explosive topology growth.

## 7. Why 32 semantic revisions

Semantic history is append-only and each accepted A1 semantic transition is one atomic canonical event. At the measured near-boundary A1 state (~2.998 MiB), 32 maximal semantic snapshots represent roughly 96 MiB of pathological snapshot payload before event-envelope overhead. The bound is large but finite; 64 or 256 would multiply worst-case history without first-slice value.

Topology arithmetic also supports 32: fan-out eight allows at most fifteen maximal pure decompositions before the WorkItem ceiling is reached from a one-item start. Thirty-two revisions leave more than one additional correction/amendment per maximal decomposition while still terminating semantic churn.

The count includes initial A1 revision or explicit legacy baseline. WorkItemGeneration needs no separate A1 cap because one identity can advance at most once per semantic revision.

## 8. Proposal, impact, draft, and envelope limits

### Proposal — 3 MiB

The near-full synthetic proposal includes 128 WorkItems under high text/path pressure, 256 verification definitions, outputs/production definitions, A1 identity/generation metadata, envelopes, and semantic subjects. It is 2.352 MiB. A 3 MiB cap leaves ~663 KiB (~21.6%) headroom and remains below the existing 4 MiB initial Program proposal scale. Resulting canonical state must independently pass the 4 MiB ProgramState cap.

### RevisionImpact — 256 KiB

The intentionally over-populated impact is 155.3 KiB. A 256 KiB cap leaves 100.7 KiB (~39.3%) headroom.

### Sealed draft — 4 MiB

The near-full proposal + over-populated impact + 8 KiB control allowance is ~2.512 MiB. A 4 MiB durable-draft cap leaves ~1.488 MiB headroom and aligns with the repository's existing Program proposal scale without enlarging current ProgramState.

### WorkAuthorityEnvelope — 8 KiB

The representative envelope uses four repository roots, eight effect classes, four external systems, sixteen capabilities, eight mandatory verification IDs, and eight forbidden kinds; it is 1.46 KiB. An 8 KiB cap provides >5x headroom while preventing repeated envelopes across 128 WorkItems from becoming an unbounded hidden dimension. The global 4 MiB state ceiling remains the final backstop.

## 9. Required rejection behavior

Before canonical admission, A1 must deterministically reject any resulting/proposed state exceeding:

- decomposition depth 8;
- eight direct children introduced by one decomposition;
- 32 semantic revisions including initial/baseline;
- 3 MiB revision proposal;
- 256 KiB RevisionImpact;
- 4 MiB sealed pending draft;
- 8 KiB WorkAuthorityEnvelope;
- any unchanged Phase-1 Program limit.

Repeated small revisions may not bypass revision-count, topology, or current-state ceilings.

## 10. Performance interpretation

This study does not freeze arbitrary latency SLOs. A1 should record semantic validation duration, impact-derivation duration, canonical bytes, and rebuild/replay duration in the gate, but correctness limits are frozen independently of eventual machine performance.

## 11. Conclusion

The existing Phase-1 capacity envelope is sufficient for A1 without raising current WorkItem, edge, state, Agent-projection, or Application-projection ceilings. The proposed A1 additions stay below the 4 MiB current-state boundary with approximately 1 MiB headroom in a deliberately dense fixture.

The numeric freeze blocker is resolved by the values in Section 1.
