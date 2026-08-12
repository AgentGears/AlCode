# ALCODE Phase 0.8 — Application Protocol + React Experience

**Status:** **CLOSED**

**Frozen:** 2026-08-12 following the Phase 0.8 pattern normalization, decision memo, and four-scenario contract pressure test. **Closed:** source PR #19 head `99ea7dc524e8a3be608c6ab8f4aaf0e631a3cb14` passed `gate:0.8` in exact-head run `31642583639` and the full CI workflow in `31642583653`, then squash-merged to `main` as `c4d41028d964155e0f5bb808f49e57385fed80fb`.

This plan is the bounded implementation contract for Phase 0.8. It does not reopen Phases 0.0–0.7 and does not authorize successor Phase 0.9 work.

---

## Objective

Establish a stable **Host-owned Application Protocol** and a usable React coding experience that consumes authoritative Host snapshots and ordered public events, supports `START_NOW|GUIDE|QUEUE`, explicit cancellation, permission interactions, and reconnect/resume, while preserving the existing Host/Agent/Capability ownership boundaries.

The signature product property is:

```text
React may disappear and reconnect
        │
        X
Host work remains canonical and continues
        │
        ▼
React reattaches from cursor/snapshot
        │
        ▼
continues from the same Host-owned operation/session state
```

---

## Governing invariants

1. **Host is canonical.** React is a disposable projection client and never reads the durable DB as authority.
2. **Application semantics are transport-independent.** Envelope/codec/transport are replaceable implementation layers.
3. **Accepted commands are identifiable and idempotent.** Duplicate/stale/noop/rejected/failed are distinct Host decisions.
4. **Input admission is explicit.** `START_NOW`, `GUIDE`, and `QUEUE` are Host/application semantics.
5. **Capability authorization is independent of input admission.** `allowed|approval-required|denied` is a separate axis.
6. **Queue order is Host-owned.** Renderer-local arrays are never execution truth.
7. **Detach/disconnect is not cancellation.** Cancel is an explicit Host command targeting known work.
8. **Reconnect never guesses across a gap.** Replay when safe; authoritative snapshot when replay is unavailable/stale.
9. **Pending interactions are structured state.** Permission requests are not renderer-only modals or prose-only state.
10. **Uncertain effects remain honest.** UI must not collapse execution outcome, external effect status, and reconciliation state.
11. **Public projection is bounded.** Privileged Host-only state and secrets do not cross the Application Protocol.
12. **No domain authority moves into the frontend.** UI behavior can be rich; canonical decisions stay Host-side.

---

## Implementation scope

### 1. `@alcode/application-protocol`

Add a shared TypeScript package containing the **public semantic contract**, including:

- protocol/version identity;
- client command envelope with stable `commandId`;
- typed command decisions:
  - `accepted`
  - `rejected`
  - `stale`
  - `duplicate`
  - `noop`
  - `failed`;
- public snapshot + cursor contract;
- ordered public event envelope with event sequence/cursor and bounded cause/origin metadata;
- input submission with requested/admitted `START_NOW|GUIDE|QUEUE` disposition;
- queue-item public identity/order projection;
- explicit operation cancellation with expected target identity;
- pending permission interaction and typed response;
- structured operation/Capability lifecycle and terminal state sufficient for the React shell;
- typed protocol/session terminal errors;
- bounded public references for outputs that should not be inlined wholesale.

The package contains **no storage, Agent runtime, Capability execution, React, Electron, or provider implementation**.

### 2. Host Application Protocol service/adapter

Add a Host-owned application service that:

- translates public commands into existing Host session/admission/capability operations;
- performs command deduplication/idempotence at the semantic boundary;
- returns typed Host command decisions;
- resolves requested versus admitted input disposition;
- owns queue item identity/order and promotion;
- rejects/noops stale target-sensitive commands;
- exposes authoritative public snapshots;
- emits ordered public events only after their required canonical state is admitted/settled;
- exposes pending permission interactions and accepts permission responses;
- never exposes secret values, internal SQLite handles, audit-only metadata, or private Host policy state.

### 3. One local transport adapter

Implement one working local transport connecting the React client to the Host.

The exact technology is a reversible implementation choice. The adapter must support:

- command request/decision;
- snapshot hydration;
- ordered event delivery;
- cursor-based reconnect/resume;
- gap/stale detection with authoritative snapshot fallback;
- explicit detach/close without implicit Host cancellation.

The semantic Application Protocol must not import transport-specific types.

### 4. React experience (`packages/web` or the existing planned equivalent)

Build a minimal usable coding shell consuming only the Application Protocol:

- session list/selection;
- transcript;
- structured active work / tool-Capability cards;
- composer with requested `START_NOW|GUIDE|QUEUE` disposition;
- Host queue display;
- pending permission interaction surface;
- explicit Stop/cancel;
- reconnect/resync indicator;
- terminal completion/error/uncertain status;
- basic file/tool-result rendering sufficient to operate the current coding Host.

The client may maintain:

- disposable ordered public-event journal/cache;
- local draft text;
- scroll/selection/collapse state;
- render batching/virtualization state.

Those are never canonical Host state.

### 5. Public projection reducer

Provide a pure reducer for the public Application Protocol snapshot/events so React projections are deterministic and testable.

The reducer must be isolated from privileged Host-internal projection code. Host tests may use the public reducer to verify parity, but the UI does not receive internal policy/secrets/recovery evidence that is outside the public contract.

---

## Frozen admission semantics

### `START_NOW`

Request immediate admission as executable work under current Host/session policy.

The Host may reject or return an explicit fallback/admitted disposition if current state makes immediate start impossible. It must not silently queue while reporting START_NOW.

### `GUIDE`

Request that the input influence the currently active operation through the supported Host→Agent guidance path.

If guidance cannot be delivered to the active work, the Host must return/record an explicit rejection or fallback disposition/reason. It must not silently claim guidance occurred.

### `QUEUE`

Admit the input as a durable Host-owned ordered queue item for later promotion.

Queued input does not execute until the Host explicitly promotes/adopts it. Queue order survives UI disconnect/reconnect and duplicate delivery.

---

## Frozen cancellation semantics

- UI unmount/disconnect/detach does **not** cancel.
- `operation.cancel` is an explicit semantic command.
- The command targets the operation identity the client believes it is stopping (`expectedOperationId` or equivalent).
- A stale command must not stop newer work.
- `cancel requested` and `operation cancelled/settled` are distinct states.
- Already-started possibly-mutating effects continue through the existing Host reconciliation doctrine; cancellation does not justify dropping required effect/terminal receipts.

---

## Frozen recovery semantics

Each application subscription exposes an authoritative public cursor.

On reconnect:

1. client presents its last applied cursor;
2. Host/adapter replays contiguous public events when safe/available;
3. client rejects sequence gaps;
4. if replay is unavailable, stale, or discontinuous, Host provides an authoritative current public snapshot and new cursor;
5. client discards/rebases disposable local journal state and continues.

Replay buffers are optimizations. The canonical durable Host state remains recovery truth.

---

## Delta durability decision

**Not frozen as “persist every delta.”**

Phase 0.8 may use live assistant/tool-output deltas for responsive rendering. Canonical durable semantic boundaries must contain enough information to reconstruct the accepted transcript/operation result after restart.

Exact token-by-token playback is not an acceptance criterion.

---

## Explicit exclusions

The following remain outside the Phase 0.8 acceptance boundary unless concrete implementation evidence proves one is required to make the frozen objective valid:

- public/remote wire encoding as a product API;
- remote Agent transport;
- remote workspace backends (SSH/WSL/Docker/etc.);
- full graph visualization;
- memory browser;
- context-receipt inspector/diff;
- full reasoning/trace/Gantt inspector;
- notification rules/inbox/OS notifications;
- voice/STT/TTS;
- workflow/task DAG engine;
- scheduler/recurring automation UI;
- subagent/multi-agent product protocol;
- multi-agent kanban;
- dynamic plugin marketplace/extension loading;
- protocol compression/protobuf migration;
- schema-history/upcaster framework beyond what current schema evolution concretely requires;
- time-travel UI;
- exact token-delta durable playback;
- provider redesign;
- graph-v1 default promotion.

These are backlog/compatible-later work, not completion gates.

---

## Frozen acceptance criteria

### AC-08-01 — Protocol contract

A versioned `@alcode/application-protocol` (or equivalently named shared package) defines validated semantic commands, typed Host decisions, authoritative snapshot/cursor, ordered public events, input admission, cancellation, queue projection, permission interaction, and terminal state without importing React, storage, provider, or transport implementation.

### AC-08-02 — Host authority and public projection

The Host services the Application Protocol using existing canonical runtime/storage authority. The React client has no direct durable DB authority. Public snapshots/events exclude secrets and private Host-only state.

### AC-08-03 — Command idempotence and stale protection

Executable tests prove:

- duplicate `commandId` does not duplicate the semantic effect;
- target-sensitive stale command cannot affect newer work;
- Host distinguishes accepted/rejected/stale/duplicate/noop/failed decisions as applicable.

### AC-08-04 — `START_NOW|GUIDE|QUEUE`

Executable tests prove requested/admitted disposition is explicit and that:

- START_NOW does not silently become queued;
- GUIDE either reaches the active work through a supported Host path or yields an explicit rejection/fallback;
- QUEUE creates one stable Host queue item, survives reconnect, preserves order, and cannot dispatch before Host promotion;
- Capability approval remains independent of disposition.

### AC-08-05 — Cancellation/detach lifecycle

Executable tests prove:

- client detach/transport loss does not cancel Host work;
- explicit cancel targets expected operation identity;
- stale cancel cannot kill newer work;
- terminal effect/reconciliation state is still published after cancellation request where required.

### AC-08-06 — Reconnect/resume

Executable tests prove:

- client reconnects from last cursor and receives contiguous missed public events when available;
- a detected gap/stale cursor causes authoritative snapshot recovery rather than guessed state;
- the rebuilt React public projection matches the Host public snapshot at the same cursor.

### AC-08-07 — Permission interaction

Executable integration/rendering tests prove a Host pending permission interaction is rendered from protocol state, a typed response command reaches Host policy, and UI-local modal state is insufficient to fabricate/resolve the interaction.

### AC-08-08 — React coding shell

A React client can drive the same Host runtime through the Application Protocol and provides the frozen minimum surfaces: session selection, transcript, structured current activity/tool cards, composer disposition, queue, permission prompt, Stop, reconnect status, and honest terminal/error/uncertain presentation.

### AC-08-09 — Ownership guard

Dependency/static tests prove application/UI packages do not import storage/database handles or move Agent/Capability/domain authority into the frontend. Existing ADR 0005 ownership remains intact.

### AC-08-10 — Foundation composition

`pnpm gate:0.8` composes `gate:0.7` and passes the Phase 0.8 protocol, reconnect, command/admission, cancellation, permission, rendering, and ownership checks.

---

## Required scenario proofs

The gate must exercise at least these four scenario families from `phase-0.8-pressure-test.md`:

1. **Normal turn:** START_NOW → structured activity/Capability → canonical completion.
2. **Concurrent input:** GUIDE + QUEUE while active, including duplicate/stale command behavior and deterministic queue order.
3. **Disconnect:** work continues without client, reconnect catches up or snapshots, stale Stop cannot affect newer work.
4. **Failure/retry/uncertainty:** logical work remains coherent across retry/model attempt changes and existing Host uncertain-effect state is rendered without unsafe automatic retry semantics.

These scenario families are proofs of the frozen semantics; they are not licenses to add unrelated features.

---

## Gate

`pnpm gate:0.8` emits the existing `GateReceipt` schema with `status: "passed"` only when AC-08-01 through AC-08-10 pass while composing `gate:0.7`.

Suggested check IDs (implementation may refine names without changing criteria):

```text
0.8.protocol.contract
0.8.host.public-projection
0.8.command.idempotence
0.8.admission.routing
0.8.queue.ordering
0.8.cancel.detach
0.8.reconnect.resume
0.8.permission.interaction
0.8.react.rendering
0.8.ownership
0.8.compose.0.7
```

---

## Failure / rollback rule

A UI or transport implementation may be replaced without changing canonical Host semantics. If a concrete transport/component-library choice fails during implementation, replace that adapter/library rather than moving domain authority into React or Agent code.

A demonstrated blocker may change this frozen contract only under project change control.

---

## As built / closure evidence

Phase 0.8 shipped the frozen contract without reopening the 0.0–0.7 foundation:

- `@alcode/application-protocol` owns the public, versioned semantic contract, runtime command validation, public cursor/event reducer, snapshot/recovery types, and a replaceable loopback local transport adapter;
- `@alcode/host-runtime` owns the Application service/controller, command idempotence, requested/admitted input routing, Host queue identity/order, expected-execution cancellation guards, public snapshot/replay projection, and Host-owned permission interactions;
- Capability approval remains Host policy: mutating capabilities can be escalated to a Host-owned pending interaction, while React only returns a typed decision;
- `@alcode/web` is a React 19 Experience Plane client using only the Application Protocol for authoritative state; it provides session selection, transcript, structured work/Capability cards, queue, permission surface, START_NOW/GUIDE/QUEUE controls, Stop, reconnect state, and honest uncertain-effect presentation;
- disconnect/unmount does not issue cancellation; cursor gaps cause resync/snapshot rather than guessed local state;
- the current Agent Protocol has no truthful mid-turn steering seam, so `GUIDE` is explicitly rejected as `guide_not_supported` rather than silently degrading to START_NOW or QUEUE;
- React TSX rendering tests were added to the root Vitest discovery and ownership-boundary tests prevent UI/Application Protocol packages from importing Host/storage/Agent authority.

**Closure:** PR #19 final source head `99ea7dc524e8a3be608c6ab8f4aaf0e631a3cb14` passed the dedicated Phase 0.8 run `31642583639` (`pnpm gate:0.8`) and full composed CI run `31642583653`. PR #19 squash-merged as `c4d41028d964155e0f5bb808f49e57385fed80fb`.

## Completion definition

Phase 0.8 is complete: `pnpm gate:0.8` passed AC-08-01 through AC-08-10 at the exact PR head. Attractive later surfaces remain outside the closed phase.

Implementation of Phase 0.9 or any excluded feature requires a distinct authorized objective.
