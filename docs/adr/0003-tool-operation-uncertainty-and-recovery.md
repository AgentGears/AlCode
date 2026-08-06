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
requested → started → (terminal ExecutionOutcome + EffectCertainty, see below)
```

An operation's terminal state is a *pair*: what the execution concluded, and
how certain we are about the external effect. These must be modeled separately
because a cancelled or timed-out shell process may already have produced
partial external effects, and the prior draft conflated execution outcome
with effect certainty.

```ts
type ExecutionOutcome =
  | "succeeded"      // the execution itself completed nominally
  | "failed"         // the execution reported failure
  | "cancelled"      // the execution was cancelled
  | "timed_out";     // the execution exceeded its timeout

type EffectStatus =
  | "confirmed"        // evidence the effect occurred
  | "absent"           // evidence the effect did not occur
  | "indeterminate"    // cannot prove whether the effect occurred
  | "not_applicable";  // the operation has no external effect (read-only tools)
```

`unresolved` is a *reconciliation* status, not an effect status — see below.

Default mapping (tool-specific reconciliation can override):

| ExecutionOutcome | Default EffectStatus | Reason |
|---|---|---|
| `succeeded` | tool-declared (usually `confirmed`) | the tool reported success and returned a result |
| `failed` | `indeterminate` | a shell command can modify several files and then exit non-zero; failure can still leave partial effects |
| `cancelled` | `indeterminate` | a cancelled process may have produced partial effects |
| `timed_out` | `indeterminate` | a timed-out process may have produced partial effects |

Read-only tools (e.g. `read`, `grep`, `ls`, `find`) declare `not_applicable`,
which avoids pretending every operation mutates external state. `failed` is no
longer defaulted to `absent` — failure does not prove the effect did not occur.

On startup, any surviving `requested` or `started` operation from a prior
session is treated as `indeterminate` (the runtime cannot know whether the
tool actually ran). `cancelled`/`timed_out` operations from a prior session
keep `indeterminate` unless reconciliation proves otherwise.

- Any operation with `EffectCertainty: "indeterminate"` is **never
  auto-retried**. Auto-retry risks duplicating an effect that already happened.
- `indeterminate` is a real, persistent state, not a transient one.

## Decision — reconciliation (separate from effect status)

`EffectStatus` describes the effect; `ReconciliationStatus` describes whether
the operation needed reconciliation and where that process stands. These are
separate because a `confirmed` or `absent` effect needs no reconciliation,
while an `indeterminate` one does.

```ts
type ReconciliationStatus =
  | "not_required"   // effect status is confirmed/absent/not_applicable
  | "pending"        // indeterminate; reconciliation not yet run
  | "resolved"       // reconciliation produced evidence (effect status updated)
  | "unresolved";    // reconciliation ran but evidence was insufficient
```

An `indeterminate` operation does **not** transition to `confirmed` merely
because the process restarted. Reconciliation produces evidence and then:

- on success → `ReconciliationStatus: "resolved"` and `EffectStatus` updated
  to `confirmed` (effect occurred) or `absent` (effect did not occur);
- on insufficient evidence → `ReconciliationStatus: "unresolved"` and
  `EffectStatus` stays `indeterminate`, surfacing to the user for a decision.

Reconciliation is tool-specific. The `bash` tool may inspect repository state
(git status, file mtimes, presence of expected output); other tools define
their own reconciliation checks. Read-only tools have no reconciliation path
(their effect is `not_applicable`). If no tool-specific check exists, the
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
