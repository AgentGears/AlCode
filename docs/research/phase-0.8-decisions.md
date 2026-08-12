# ALCODE Phase 0.8 — Application Protocol Decision Memo

**Status:** architecture synthesis for the next planned roadmap unit. This memo selects the bounded semantic direction for Phase 0.8; it does **not** start implementation by itself.

**Date:** 2026-08-12

**Canonical constraints consulted:**
- `docs/roadmap.md` on `main`: Host owns canonical admission/state, policy, Agent supervision, capabilities, durability/recovery, transcript/context, and completion; Phase 0.8 is Application Protocol + React experience.
- `docs/phase-0-spec.md` on `main`: define application transport before UI; ordered events, reconnect/resume, cancellation, duplicate handling, tool progress, permissions, completion; `START_NOW`, `GUIDE`, `QUEUE` belong at the application/Host boundary; frontend never reads the durable DB as authority.
- Closed Phase 0.0–0.7 contracts remain unchanged.

**Research inputs:** normalized Phase 0.8 pattern catalog plus direct source studies of ZCode 3.7.6, Craft Agents 0.11.4, Cherry Studio 2.0.3, Open WebUI, AnythingLLM/Open Computer, Astryx, LobeChat, Amphi, Claude Task Viewer, `mails`, and Sentrux.

---

## Decision summary

Phase 0.8 should establish a **small Host-owned Application Protocol and one React client**. The protocol is semantic and transport-independent. The Host remains canonical; React owns only disposable local/ephemeral UI state and public projections. The minimum contract must survive concurrency, retry, reconnect, and cancellation without relying on renderer-local truth.

The research changes the existing planned 0.8 scope in one bounded way: **inspectors, graph/timeline/notification/voice/workflow surfaces are not 0.8 acceptance criteria.** They remain compatible future consumers of the same protocol.

---

## D-08-01 — Host remains the only canonical application authority

**Decision:** Adopt.

The Application Protocol exposes public Host commands, snapshots, and ordered public events. React must never become another durable source of truth and must never read the workspace SQLite database directly.

```text
Host canonical state/events
        │
        ├── public snapshot
        └── ordered public events
                │
                ▼
       React projection journal/cache
                │
                ▼
            UI projections
```

The client journal is disposable and rebuildable from Host state.

**Primary patterns:** P-STATE-08, P-STATE-09, P-APP-07.

---

## D-08-02 — Separate application semantics from envelope, codec, and transport

**Decision:** Adopt.

Freeze semantic command/event schemas before selecting or optimizing the concrete wire transport.

```text
Application semantics
        ↓
Versioned envelope
        ↓
Codec
        ↓
Transport adapter
        ↓
Recovery/cursor behavior
```

Phase 0.8 must ship one working local transport adapter, but this memo does not freeze SSE, WebSocket, MessagePort, or a binary framing scheme as part of the semantic contract.

**Primary patterns:** P-TRANS-02, P-TRANS-12. P-TRANS-01/P-TRANS-03 remain implementation choices.

---

## D-08-03 — Commands have stable identity and typed Host decisions

**Decision:** Adopt.

Every semantic client command carries a stable `commandId` and client/session identity as required. Commands whose correctness depends on observed live state may additionally carry an expected target/base state.

Host command decisions distinguish at least:

```text
accepted
rejected
stale
duplicate
noop
failed
```

Transport failure is not a Host decision and must remain a different error class.

**Why:** duplicate delivery, reconnect, and stale UI actions are normal distributed-state cases, not exceptional parser errors.

**Primary patterns:** P-APP-01, P-APP-02, P-APP-11.

---

## D-08-04 — `START_NOW`, `GUIDE`, and `QUEUE` are input-admission semantics

**Decision:** Adopt.

The user/client may request a disposition. The Host decides the admitted disposition and may return a bounded fallback reason when the exact request cannot be honored.

```text
requested: auto | START_NOW | GUIDE | QUEUE
                     │
                     ▼
                Host admission
                     │
                     ▼
admitted: START_NOW | GUIDE | QUEUE
```

`GUIDE` means influence the currently active work through the Host's supported guidance path. `QUEUE` means durable ordered future input. `START_NOW` means admit as immediately executable work under current session policy.

The exact UI control can evolve without changing these semantics.

**Primary patterns:** P-APP-04, P-APP-05.

---

## D-08-05 — Input admission and Capability authorization are orthogonal

**Decision:** Adopt.

Never map `START_NOW|GUIDE|QUEUE` onto `allowed|approval-required|denied`.

```text
Input admission                  Capability authorization
---------------                  ------------------------
START_NOW                        allowed
GUIDE                       ×    approval-required
QUEUE                            denied
```

A START_NOW operation can later require approval for an irreversible Capability. A GUIDE instruction may require no approval at all.

**Primary patterns:** P-APP-08, P-PERM-01, P-PERM-02, corrected P-PERM-05.

---

## D-08-06 — Queue identity/order is Host-owned

**Decision:** Adopt, bounded.

A queued input receives stable Host identity and deterministic order. Reorder/edit/delete/promote semantics operate on Host queue items, not a renderer array.

The first implementation does **not** need ZCode's full reservation/promotion state machine. It must, however, make these invariants observable and testable:

- accepted queued input survives client reconnect;
- queue order does not change unless an accepted Host command changes it;
- queued input cannot dispatch before the Host promotes/adopts it;
- duplicate submission does not create duplicate queue items.

**Primary patterns:** P-APP-05.

---

## D-08-07 — Detach/disconnect is not cancellation; cancellation targets known work

**Decision:** Adopt.

View unmount, route change, renderer reload, or transport loss must not cancel Host work. Cancel is an explicit semantic command.

Where the client means “stop the operation I am looking at,” the command carries `expectedOperationId`. A stale client must not stop a newer operation merely because it is now “current.”

Cancellation request and terminal cancellation remain distinct states; the Host continues to publish effect/reconciliation/terminal events needed to tell the truth about already-started work.

**Primary patterns:** P-APP-03, P-APP-09, P-TRANS-06.

---

## D-08-08 — Recovery is cursor-based, with replay when safe and snapshot fallback

**Decision:** Adopt.

Every public subscription has an authoritative cursor based on the Host's ordered public event sequence (and epoch/generation if required by the existing storage/runtime model).

```text
client at cursor N
      X disconnect
Host work continues
      │
      ▼
reconnect(N)
      │
      ├── safe history available → replay N+1...
      └── gap/stale/unavailable → authoritative snapshot + new cursor
```

The client validates event continuity and never guesses through a sequence gap.

Replay buffers/caches are transport optimizations. Durable Host state is the source of recovery truth.

**Primary patterns:** P-APP-07, P-TRANS-08.

---

## D-08-09 — Pending interactions are structured application state

**Decision:** Adopt.

Permission requests are not renderer-only modals and not merely assistant prose. The public projection exposes pending interactions with stable identity and status; React renders the appropriate interaction surface and responds with a typed command.

Phase 0.8 only needs the interaction kinds already required by the Host product surface, especially permission/approval. The shape should remain extensible to clarification and recovery choices later.

**Primary patterns:** P-APP-08, P-PERM-01.

---

## D-08-10 — Public projection reducer may be shared; privileged Host projection logic may not

**Decision:** Adapt.

A pure reducer for **public Application Protocol events** may be shared between Host-side tests/adapters and React to prevent projection drift.

Do not export or reuse Host-internal reducers containing secrets, policy data, audit-only metadata, or recovery evidence that is not part of the public contract.

**Primary patterns:** P-STATE-09, P-STATE-10.

---

## D-08-11 — Streaming deltas are not automatically durable

**Decision:** Unresolved by design; default to semantic durability.

Rebuildability requires durable canonical semantic events, not necessarily every token/tool-output delta.

The 0.8 protocol may transport live deltas for responsive rendering. The durable event log must contain enough semantic boundary state to reconstruct the canonical result after reopen/replay. Exact token-by-token playback is not a Phase 0.8 requirement unless implementation evidence shows an existing canonical contract already depends on it.

**Primary pattern:** P-STATE-07.

---

## D-08-12 — Large/live outputs cross the protocol as bounded projections or references

**Decision:** Adapt.

Do not assume arbitrary terminal, browser, tool, file, trace, or artifact payloads fit safely in one UI event. The semantic contract must permit:

- bounded inline preview;
- stable public artifact/result reference;
- subsequent bounded fetch/stream by reference.

Phase 0.8 only needs the minimum required by existing coding capabilities. This decision prevents later terminal/browser/artifact surfaces from forcing a Host-authority redesign.

**Primary evidence:** Cherry bounded tool-output projection; Open WebUI structured output; Open Computer live Capability surfaces; P-RENDER-13/P-RENDER-14 as later throughput references.

---

## D-08-13 — Operation and attempt identity remain distinct, but attempt telemetry is not a 0.8 gate

**Decision:** Preserve compatibility; do not expand scope.

An operation may contain multiple provider/runtime attempts. If public events expose attempts, they must carry distinct attempt identity and must not overwrite logical operation identity.

Phase 0.8 does not need to invent a new canonical attempt subsystem if the current Host does not expose one.

**Primary pattern:** P-APP-10.

---

## D-08-14 — React scope is a protocol proof plus usable coding shell, not the entire research wishlist

**Decision:** Bounded correction to the currently planned 0.8 scope.

The minimum React experience should include:

- session selection/switching;
- transcript projection;
- structured current activity / Capability-tool cards;
- composer with requested `START_NOW|GUIDE|QUEUE` disposition;
- visible Host queue state;
- permission interaction surface;
- explicit Stop/cancel;
- reconnect/resync status;
- terminal completion/error/uncertain state presentation;
- basic rendering for current file/tool results sufficient to use the existing coding Host.

The following are **not Phase 0.8 acceptance criteria**:

- full reasoning graph visualization;
- memory browser;
- context-receipt inspector/diff;
- full trace/Gantt view;
- notification rules/inbox;
- voice;
- workflow/task DAG;
- automation/scheduler UI;
- remote workspace backend;
- multi-agent kanban;
- dynamic plugin marketplace;
- transport compression/protobuf migration;
- exact stream-delta playback.

A UI component library such as Astryx is an implementation dependency choice, not part of the Application Protocol contract.

---

## Selected 0.8 semantic core

The smallest coherent contract is therefore:

```text
Client command
  commandId
  type
  sessionId
  expected/base state?       (only where needed)
  payload
        │
        ▼
Host command decision
  accepted | rejected | stale | duplicate | noop | failed
        │
        ▼
Host canonical state/effects
        │
        ├── authoritative public snapshot @ cursor
        └── ordered public events cursor+1...
                         │
                         ▼
                 React public reducer
                         │
                         ▼
                  disposable UI state
```

For user input:

```text
input.submit(requestedDisposition)
        │
        ▼
Host admits START_NOW | GUIDE | QUEUE
        │
        ├── active operation projection
        ├── queue projection
        └── pending interactions
```

For reconnection:

```text
detach / disconnect
        │
        X  no cancellation
        │
Host work continues
        │
        ▼
attach(cursor)
        │
        ├── replay
        └── snapshot fallback
```

---

## Bounded correction to the existing planned Phase 0.8 specification

The current `docs/phase-0-spec.md` planned section correctly owns Application Protocol, ordered events, reconnect/resume, cancellation, duplicate handling, permissions, completion, and `START_NOW|GUIDE|QUEUE`.

The bounded correction is to **remove broad inspector surfaces from required implementation scope** and make them future consumers of the protocol. The phase should prove the Application Protocol and usable React coding shell first; memory/reasoning/context inspectors remain later/optional unless required by a concrete blocker discovered during implementation.

This correction does not reopen or modify Phases 0.0–0.7.

---

## Decisions intentionally left to implementation

These are routine/reversible choices unless concrete evidence makes them load-bearing:

- first local transport technology (SSE/HTTP, WebSocket, MessagePort, etc.);
- JSON versus another initial codec;
- exact React state/store library;
- component library / Astryx adoption;
- render batching interval;
- virtualization threshold;
- exact public event names, provided they implement the frozen semantics above;
- whether live assistant deltas are retained only in memory or additionally persisted for diagnostics.

---

## Decision

**Proceed with a bounded Phase 0.8 contract based on D-08-01 through D-08-14 and pressure-test it before freezing implementation acceptance criteria.**
