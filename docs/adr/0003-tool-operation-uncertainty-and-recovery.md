# ADR 0003 — Tool Operation Uncertainty and Recovery

Status: **accepted** (Phase 0.0).
Resolves P0 finding: arbitrary tool mutations cannot guarantee exactly-once execution.

## Context

A crash can occur after a shell command mutated the repository but before
`tool.completed` was persisted. On restart, the runtime cannot safely assume
whether the command ran, failed, or partially ran. The earlier draft's
"exactly-once mutation" guarantee is unsupportable for arbitrary tool mutations.

## Decision — operation state machine

```
requested → started → succeeded | failed | cancelled | timed_out
                     ↘ indeterminate
```

- `indeterminate` is a real, persistent state, not a transient one.
- An `indeterminate` operation is **never auto-retried**. Auto-retry risks
  duplicating an effect that already happened.

## Decision — reconciliation

An `indeterminate` operation does **not** transition to `succeeded` merely
because the process restarted. It resolves only via a reconciliation operation
that produces evidence and then moves it to a terminal state:

- `reconciled_succeeded` — evidence shows the effect occurred correctly.
- `reconciled_failed` — evidence shows the effect did not occur or failed.
- `unresolved` — preserved indefinitely when evidence is insufficient.

Reconciliation is tool-specific. The `bash` tool may inspect repository state
(git status, file mtimes, presence of expected output); other tools define
their own reconciliation checks. If no tool-specific check exists, the
operation requires a user decision.

## Decision — the honest guarantee

> Effectively once where supported, otherwise detect and preserve uncertainty.

Restrict "exactly once" to operations with genuine idempotency keys or
transactional control. For arbitrary tool mutations, the system detects
uncertainty (`indeterminate`) and surfaces it rather than silently retrying
or silently assuming success.

## Consequences

- A user is never silently told a destructive operation succeeded when the
  runtime cannot prove it.
- Recovery from crash may surface `indeterminate` operations requiring
  reconciliation; this is intentional, not a bug.
- Tool authors must declare whether their tool supports automatic
  reconciliation and, if so, provide the check.
