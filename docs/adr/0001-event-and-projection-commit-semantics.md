# ADR 0001 — Event Append and Projection Commit Semantics

Status: **accepted** (Phase 0.0).
Resolves P0 finding: transaction semantics ambiguity.

## Context

The hard rules imply exact transactional correlation between event append and
projection update. Elsewhere, recovery tests require surviving a crash after
event append but before projection completion. Those describe different commit
models and the earlier draft left the behavior implicit.

## Decision

1. **Append immutable events in one transaction.** This assigns `sequence`
   and `recordedAt`. The append is idempotent on `eventId`.
2. **Apply each projection idempotently in a separate transaction.**
3. **Advance that projection's cursor in the same transaction as its updates.**
4. **Do not report an operation as fully committed until all correctness-critical
   projections have caught up.**
5. **On startup, replay from every lagging cursor.**

## Projection classification (three states, not two)

- **Inline state** — updated atomically with event append; part of the write
  model. Rare. Example: the sequence allocator. Any projection updated
  atomically with append must be explicitly classified as inline, never implicit.
- **Critical projection** — separate transaction, but the operation is **not
  reported complete** until this projection has caught up. Example: the
  operations registry (an operation's status must be readable before a tool
  call returns).
- **Derived projection** — separate transaction, may lag without blocking
  operation completion. Example: reasoning graph, memory store, transcript.
  Rebuilt from events on demand.

## Consequences

- An operation that has emitted its events but whose critical projection has
  not caught up is "appended but not complete" — a real, queryable state.
- A crash between append and a derived projection's commit leaves the derived
  projection lagging; startup replay catches it up. No data loss; no
  duplication (append is idempotent on `eventId`).
- A derived projection can be deleted and rebuilt from events; the rebuild is
  deterministic because the projection is a pure function of events.
- Projections must be idempotent: applying the same event twice yields the
  same state as applying it once. This is required for safe replay.
