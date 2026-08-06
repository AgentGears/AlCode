# ALCODE Operation Recovery Model

Status: **Phase 0 foundation**. Operationalizes ADR 0001 (transaction
semantics) and ADR 0003 (tool operation uncertainty).

## Startup recovery

On opening a workspace:

1. Acquire the OS lock (ADR 0002). If held, refuse and report the owner.
2. Open `workspace.sqlite`.
3. For each projection, read its cursor (`last_applied_event_sequence`).
4. **Replay from every lagging cursor** — for each projection, apply events
   with `sequence > cursor.lastApplied`, idempotently, advancing the cursor in
   the same transaction as the writes.
5. **Recover interrupted operations** — scan the `operations` table for
   non-terminal states (`requested`, `started`) and any operation marked
   `indeterminate` by a prior crash.

## Operation state transitions

```
requested → started → succeeded | failed | cancelled | timed_out
                     ↘ indeterminate
```

On startup, an operation in `requested` or `started` from a prior session is
treated as `indeterminate` (the runtime cannot know whether the tool actually
ran). It is **not auto-retried**.

## Indeterminate resolution

An `indeterminate` operation resolves only via reconciliation that produces
evidence:

- `reconciled_succeeded` — evidence the effect occurred correctly (e.g., for
  `bash`: git status shows the expected change, file mtimes match, expected
  output exists).
- `reconciled_failed` — evidence the effect did not occur or failed.
- `unresolved` — preserved indefinitely when evidence is insufficient;
  surfaces to the user for a decision.

Reconciliation is **tool-specific**. Tool authors declare whether their tool
supports automatic reconciliation and provide the check. A tool with no
reconciliation check leaves operations `unresolved` until a user decides.

## Crash test matrix (enforced by Phase 0.2 tests)

The runtime must recover correctly from a crash at each boundary:

- after event append, before projection completion
- after tool start, before tool-result commit
- after external repository mutation, before `tool.completed`
- before final commit of a turn
- during a projection update (mid-transaction)
- during memory consolidation

Recovery is correct when:
- no events are duplicated (`eventId` idempotence);
- every lagging projection catches up to the event sequence;
- critical projections are caught up before any operation is reported complete;
- `indeterminate` operations are surfaced, not silently retried.

## What recovery does NOT do

- **Auto-retry `indeterminate` operations.** The whole point of the state is
  to avoid duplicating effects that may already have happened.
- **Silently assume a tool succeeded.** Uncertainty is preserved and surfaced.
- **Roll back repository mutations.** External side effects (files written,
  shells run, network calls made) are not reversible by the runtime. The
  recovery contract is *detect and preserve uncertainty*, not undo.
