# ALCODE Operation Recovery Model

Status: **implemented through Phase 0.5**. Operationalizes ADR 0001
(transaction semantics), ADR 0002 (workspace ownership), ADR 0003 (tool
operation uncertainty), and the Host/Agent ownership boundary in ADR 0005.

## Startup recovery

On opening a workspace, the Host:

1. Acquires the OS lock (ADR 0002). If held, refuse and report the owner.
2. Opens `workspace.sqlite`.
3. For each projection, reads its cursor (`last_applied_event_sequence`).
4. **Replays every lagging projection** — apply events with
   `sequence > cursor.lastApplied` idempotently, advancing the cursor in the
   same transaction as the projection writes.
5. **Recovers interrupted operations** — any prior-session requested/started
   operation whose external effect may have occurred becomes explicit
   indeterminate/pending state; it is never automatically retried.
6. **Recovers bounded durable cognition work** from canonical `runtime.work.*`
   events. Only work explicitly marked retry-eligible may be retried, and its
   semantic commit must remain idempotent (Phase 0.5 proves this for
   `memory.consolidation`).
7. If a durable session has `runtime.session.started` and no corresponding
   stop, resumes that session rather than starting a duplicate one.
8. A replacement Agent attaches through the Agent Protocol and orients from
   Host-owned durable state. Agent process replacement is not itself a recovery
   of canonical state because the Agent never owned that state.

## Operation state transitions

An operation's terminal state is described by three values (see ADR 0003):

- **ExecutionOutcome**: `succeeded` | `failed` | `cancelled` | `timed_out`
- **EffectStatus**: `confirmed` | `absent` | `indeterminate` | `not_applicable`
- **ReconciliationStatus**: `not_required` | `pending` | `resolved` | `unresolved`

Default mapping: `succeeded` → tool-declared (usually `confirmed`); `failed`,
`cancelled`, `timed_out` → `indeterminate` when effects could have occurred.
Read-only tools declare `not_applicable`.

On startup, any surviving `requested` or `started` operation from a prior Host
lifetime is treated as `EffectStatus: "indeterminate"`,
`ReconciliationStatus: "pending"` when the runtime cannot prove whether the
tool actually ran. `cancelled`/`timed_out` operations keep uncertainty unless
reconciliation proves otherwise. None of these are auto-retried.

## Indeterminate resolution

An `indeterminate` operation resolves only via reconciliation that produces
evidence:

- on sufficient evidence → `ReconciliationStatus: "resolved"` and
  `EffectStatus` becomes `confirmed` (effect occurred) or `absent` (effect did
  not occur);
- on insufficient evidence → `ReconciliationStatus: "unresolved"`,
  `EffectStatus` remains `indeterminate`, and the uncertainty is surfaced for a
  decision.

Reconciliation is **tool/capability-specific**. Read-only tools have no
mutation reconciliation path (`not_applicable`). A mutating capability without
sufficient reconciliation evidence remains unresolved rather than being
silently rerun.

## Agent replacement continuity (Phase 0.5)

The Host and Agent have different lifetimes:

```text
Host session S
  ├─ Agent generation A
  │    exits / is killed
  ├─ Host-owned operation O may finish durably
  └─ Agent generation B
       session.resume
       → orient
       → continue
```

Agent A exiting does **not** append `runtime.session.stopped`. Operation IDs,
canonical events, memory state, reasoning state, and session identity remain
Host-owned. If a Host capability completes after Agent A disappears, the Host
persists the terminal operation/evidence state even if result delivery to A is
impossible. Agent B then resumes against that durable state.

## Durable work recovery (Phase 0.5)

Bounded cognition work is different from uncertain environmental mutation.
Work has canonical requested/claimed/completed/failed/interrupted state and an
explicit retry-eligibility decision.

For the Phase 0.5 `memory.consolidation` case:

```text
work.requested
→ work.claimed
→ idempotent memory semantic event
→ crash before work.completed
→ reopen: work interrupted + retry eligible
→ retry same semantic admission identity
→ no duplicate reinforcement
→ work.completed
```

This does **not** authorize automatic retry of an indeterminate tool operation.
It proves retry only where the work contract explicitly allows it and the
semantic effect has an idempotency key.

## Crash/replacement test matrix

Phase 0.2 persistence/operation recovery covers:

- after event append, before projection completion;
- after tool/operation start, before terminal result commit;
- after external repository mutation, before terminal commit;
- during a projection transaction;
- close/reopen and replay without duplicate events.

Phase 0.5 additionally proves:

- Agent process loss while Host-owned capability work is in flight;
- replacement Agent resumes the same session and orients from durable state;
- Host reopen preserves uncertain mutation as pending/indeterminate with no
  automatic retry;
- interrupted retry-eligible memory consolidation completes without duplicate
  semantic effect.

Recovery is correct when:

- no canonical events are duplicated (`eventId`/domain idempotency);
- every required projection catches up to the event sequence;
- critical projections are visible before an operation is reported complete;
- uncertain environmental effects remain explicit and are not auto-retried;
- replacement Agent processes do not create replacement durable sessions;
- retry-eligible durable cognition work cannot duplicate its semantic effect.

## What recovery does NOT do

- **Auto-retry indeterminate environmental operations.** The whole point of
  the state is to avoid duplicating effects that may already have happened.
- **Silently assume a tool succeeded.** Uncertainty is preserved and surfaced.
- **Roll back repository mutations.** External side effects are not generally
  reversible by the runtime; the contract is detect/preserve uncertainty, not
  undo.
- **Treat Agent process death as session completion.** Completion remains Host
  authority under the frozen Phase 0.5 policy.
