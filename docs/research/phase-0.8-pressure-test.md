# ALCODE Phase 0.8 — Contract Pressure Test

**Status:** design-level pressure test of `phase-0.8-decisions.md`. No implementation/runtime claims are made here.

**Date:** 2026-08-12

**Purpose:** test whether the selected Application Protocol semantics remain coherent under four high-pressure scenarios before freezing Phase 0.8 implementation acceptance criteria.

---

## Scenario A — Normal interactive coding turn

### Initial state

- Host session `S` is open and idle.
- Client `C1` holds public snapshot at cursor `42`.
- No pending queue item or interaction exists.

### Flow

```text
C1 → Host
input.submit {
  commandId: c-100,
  sessionId: S,
  requestedDisposition: START_NOW,
  text: "Fix the failing parser test"
}

Host
  durable command/admission barrier
  → decision accepted
  → admittedDisposition START_NOW
  → creates/uses operation O1

Host → clients
  event 43 input.admitted
  event 44 operation.started(O1)
  event 45 assistant/output delta      [live/disposable is allowed]
  event 46 capability.requested(...)
  event 47 capability.started(...)
  event 48 capability.completed(...)
  event 49 assistant.completed(...final canonical content...)
  event 50 operation.completed(O1)
```

### Required invariants

- Client acknowledgement is downstream of required Host admission/persistence.
- React derives transcript/activity from public snapshot/events; it does not create canonical transcript state.
- Capability lifecycle is structured, not fabricated Markdown.
- Provider EOF alone does not authorize the terminal operation state.
- Live render deltas may be coalesced without dropping semantic completion/effect events.

### Result

**PASS at design level.** D-08-01/02/03/10/11 provide a coherent path. No additional protocol primitive is required.

---

## Scenario B — User submits `GUIDE` and `QUEUE` while work is active

### Initial state

- Operation `O1` is running.
- Public cursor is `80`.
- No pending approval blocks `O1`.

### Flow 1 — GUIDE

```text
C1 → Host
input.submit {
  commandId: c-201,
  requestedDisposition: GUIDE,
  text: "Do not modify the generated files"
}

Host
  evaluates current operation/session ability to accept guidance
  → accepted
  → admittedDisposition GUIDE
  → associates guidance with O1

Host → clients
  input.admitted(commandId=c-201, admitted=GUIDE, target=O1)
  guidance.accepted(target=O1)
```

If the currently active Agent/runtime cannot consume guidance at that exact point, the Host may use a bounded fallback consistent with the frozen product semantics, but it must record the actual admitted disposition and reason; it must not silently pretend GUIDE occurred.

### Flow 2 — QUEUE

```text
C1 → Host
input.submit {
  commandId: c-202,
  requestedDisposition: QUEUE,
  text: "After that, update the docs"
}

Host
  → accepted
  → admittedDisposition QUEUE
  → queueItemId Q7
  → queuePosition 1

Host → clients
  queue.item.admitted(Q7, position=1)
```

`Q7` stays queued until the Host explicitly promotes/adopts it after O1 reaches the applicable terminal/admission boundary.

### Race: duplicate command

C1 retries `c-202` after a lost acknowledgement.

```text
Host → C1
command.decision = duplicate
existing queueItemId = Q7
```

No second queue item is created.

### Race: stale reorder

C1 observed `[Q7,Q8]`; another client/session action changes the queue to `[Q8,Q7]`; C1 sends a reorder based on stale expected queue state.

Host returns `stale` or equivalent authoritative rejection and a current public queue projection/cursor. React does not locally win the conflict.

### Required invariants

- `GUIDE` and `QUEUE` are explicit Host admission semantics.
- Queue order is Host-owned and survives reconnect.
- Requested/admitted disposition is observable.
- Duplicate command delivery is idempotent.
- Capability approval is not inferred from GUIDE/QUEUE/START_NOW.

### Result

**PASS at design level, with one implementation obligation:** Phase 0.8 must define how a Host-admitted GUIDE is delivered to the current replaceable Agent/runtime or how a non-deliverable GUIDE is explicitly rejected/falls back. This is expected 0.8 work, not a pre-phase blocker.

---

## Scenario C — UI disconnects during long-running work

### Initial state

- Operation `O3` is running.
- C1 has processed through cursor `120`.

### Flow

```text
C1 transport disappears
        X
        │
        │ no cancel command
        ▼
Host keeps O3 alive
  event 121 capability.started
  event 122 capability.completed
  event 123 assistant.completed
  event 124 operation.completed

C1 reconnects with cursor=120
```

### Recovery path A — replay available

```text
Host validates cursor continuity
→ returns/replays 121..124
→ C1 reducer reaches current state
```

### Recovery path B — replay unavailable/gap detected

```text
Host reports stale/gap
→ sends authoritative public snapshot @ cursor 124
→ C1 discards/rebases disposable journal
→ renders snapshot
```

### Race — live events arrive while recovery is running

The implementation must serialize/rebase recovery so C1 cannot apply events out of order. Acceptable designs include holding later events until snapshot/replay commit or restarting recovery from the new cursor.

### Explicit Stop after reconnect

C1 previously viewed `O3`, but by the time it reconnects `O4` has started. It sends:

```text
operation.cancel {
  commandId: c-301,
  expectedOperationId: O3
}
```

Host sees current target is no longer O3 and returns `stale`/`noop`; it does not stop O4.

### Required invariants

- disconnect/detach is not cancellation;
- Host work continues without a client;
- cursor gaps are detected, never guessed across;
- replay is an optimization, snapshot is authoritative fallback;
- stale stop cannot kill newer work.

### Result

**PASS at design level.** D-08-07/08 plus P-APP-07/09 cover the failure family seen repeatedly in ZCode/Craft/Cherry.

---

## Scenario D — Retry/model transition plus uncertain external effect

### Initial state

- Host operation `O5` is active.
- Provider/runtime attempt `A1` fails with a retryable pre-effect provider error.

### Flow 1 — provider retry

```text
O5
 ├─ attempt A1 → retryable provider failure
 └─ attempt A2 → provider/model B
```

The public UI may expose attempt identity/usage if available, but `O5` remains the logical operation. A1's late stream output cannot overwrite A2's canonical result.

### Flow 2 — possibly mutating Capability loses acknowledgement

During A2, a Capability starts an external mutation. The external system may have accepted the effect, but the Host cannot prove the outcome because the acknowledgement is lost.

The existing Host recovery doctrine yields an uncertain/indeterminate effect rather than automatic retry.

```text
Capability attempt
      │
      ├─ definitely no effect → retry policy may apply
      ├─ confirmed effect     → record confirmation
      └─ effect uncertain     → do NOT auto-retry
                                 ↓
                         reconciliation state
```

Host publishes structured uncertain/reconciliation state. React must not show a normal red “failed, retry” action that would imply the effect definitely did not happen.

If a pending user decision is required, it is represented as structured pending interaction state, not assistant prose.

### Negative evidence rule

No post-effect receipt in the log means only:

```text
no confirming receipt observed
```

unless the specific Capability can authoritatively reconcile the external system and establish no effect.

### Required invariants

- logical operation identity is not overwritten by physical retry attempts;
- retryable provider errors and uncertain external effects are different classes;
- uncertain mutation is not auto-retried;
- UI preserves orthogonal execution/effect/reconciliation state;
- pending recovery interaction is Host/public state.

### Result

**PASS at design level.** The contract does not require Phase 0.8 to invent new external adapters; it only requires the UI/protocol to faithfully project the existing Host uncertainty/recovery semantics.

---

## Cross-scenario findings

### Confirmed as 0.8-core

1. Host canonical authority; client projection journal is disposable.
2. Stable command identity and typed command decisions.
3. Explicit requested/admitted `START_NOW|GUIDE|QUEUE` semantics.
4. Host-owned durable queue ordering.
5. Capability permission is a separate axis from input admission.
6. Explicit cancel targeted to known operation; detach/disconnect is not cancel.
7. Cursor continuity, replay when safe, authoritative snapshot fallback.
8. Structured pending interaction state.
9. Public structured Capability/tool lifecycle and terminal operation state.
10. Honest uncertain-effect/reconciliation projection.

### Not required to pass these scenarios

- public remote wire encoding;
- protobuf/length-prefix framing;
- CRDT frontiers or tracking-token lattices;
- persistence of every token delta;
- time travel;
- memory/reasoning/context inspectors;
- full trace/Gantt UI;
- voice/notifications;
- scheduler/automation UI;
- remote workspaces;
- multi-agent workflow.

### Design issue resolved during pressure test

The earlier pattern catalog risked treating `GUIDE` as a permission mode and treating missing post-effect events as proof that an effect did not occur. Both are corrected in the decision memo and normalized catalog.

### Design issue intentionally left to implementation

A concrete live Agent runtime may have different support for mid-turn steering. Phase 0.8 owns the Host/product semantics, so implementation must either deliver a GUIDE through an existing safe Agent seam or return/record an explicit non-delivery/fallback result. It must not silently degrade semantics.

---

## Pressure-test decision

**The bounded semantic contract survives all four scenarios without moving authority into React or reopening the 0.0–0.7 foundation. Proceed to freeze a bounded Phase 0.8 implementation contract.**
