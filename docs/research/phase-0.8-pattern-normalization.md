# Phase 0.8 — Pattern Catalog Normalization

**Status:** non-canonical research normalization. This file records the bounded corrections applied to the broad Phase 0.8 pattern catalog before decisions were frozen. It is evidence/triage, not an implementation contract.

**Date:** 2026-08-12

## Governing corrections

The research catalog is useful only if it preserves the existing ALCODE ownership model. The following corrections are load-bearing:

1. **Host remains canonical.** A client may keep an ordered public-event journal/cache, but it is disposable projection state, never a second source of truth.
2. **Input admission and Capability authorization are separate axes.** `START_NOW|GUIDE|QUEUE` must not imply `allowed|approval-required|denied`, or vice versa.
3. **The event log supplies reconciliation evidence, not omniscience.** A positive post-effect receipt can prove an effect; absence of a receipt does not generally prove that an external effect did not happen.
4. **Rebuildability does not require persisting every token delta.** Canonical semantic boundary events may be sufficient; exact playback is a separate product requirement.
5. **Transport layers stay distinct:** application semantics → versioned envelope → codec → transport → reconnect/recovery. A first SSE/WS/MessagePort choice must not define the semantic Application Protocol.
6. **Cancellation is semantic Host control.** A transport may coalesce/drop render deltas but must never discard required canonical effect/terminal events because a UI cancelled rendering.
7. **A shared reducer is public-only.** React may share the reducer for public Application Protocol events; privileged Host projection/policy/secret state never crosses that boundary.
8. **Convergence is evidence, not automatic adoption.** Same-domain Agent applications carry greater Phase 0.8 weight than generic CRDT/event-framework analogies.
9. **Advanced patterns are phase-compatible, not phase requirements.** Tracking-token lattices, schema-history logs, time travel, full notifications, voice, memory browser, reasoning graph, workflow DAGs, and similar surfaces remain later unless implementation evidence proves a blocker.

## Same-domain Agent application patterns

These patterns receive the highest Phase 0.8 evidentiary weight.

### P-APP-01 — Command identity + optimistic base

Stable `commandId` plus client/session identity; race-sensitive commands may include expected/base state. ZCode 3.7.6 independently uses command identity with base revision/log epoch.

**ALCODE disposition:** Adopt stable command identity; add expected/base state only where stale UI can cause the wrong semantic effect.

### P-APP-02 — Authoritative command-decision vocabulary

Distinguish `accepted | rejected | stale | duplicate | noop | failed`. Transport failure remains a separate class.

**ALCODE disposition:** Adopt.

### P-APP-03 — Target-identity guard for live-work commands

Stop/cancel names the operation the client believes it is stopping. ZCode uses an expected foreground execution identity; Cherry independently gives each execution distinct identity and cancellation.

**ALCODE disposition:** Adopt for cancellation and other race-sensitive live-work commands.

### P-APP-04 — Requested vs admitted input disposition

Record requested `auto|startNow|queue|guide`; Host returns/records admitted `startNow|queue|guide` plus bounded fallback reason where required.

**ALCODE disposition:** Adopt. This is independent of permission policy.

### P-APP-05 — Durable queue-item identity and explicit promotion

Queued input has stable identity/order; edit/reorder/delete/promote operate on Host queue items, not a renderer array. ZCode and Craft both expose this pressure.

**ALCODE disposition:** Adopt bounded semantics; do not copy a full reservation state machine unless required.

### P-APP-06 — Authoritative action availability

Host may project semantic actions as allowed/disallowed with reason code rather than forcing React to reverse-engineer Host legality.

**ALCODE disposition:** Adapt narrowly for semantic actions; ordinary visual enablement stays frontend-local.

### P-APP-07 — Cursor recovery: replay when safe, snapshot on gap/stale

ZCode, Craft, and Cherry independently separate long-running work from client attachment and support catch-up/reconnect semantics.

**ALCODE disposition:** Adopt as 0.8-core. Replay buffers are optimization; durable Host state is recovery truth.

### P-APP-08 — Pending interaction is application state

Permission/clarification/recovery requests have stable identity/status and are not renderer-only modals or prose-only transcript state.

**ALCODE disposition:** Adopt for permission interactions in 0.8; keep shape extensible.

### P-APP-09 — Detach/disconnect is not cancel

Cherry's detach vs abort distinction and ZCode/Craft independent server work lifetime strongly converge.

**ALCODE disposition:** Adopt as invariant.

### P-APP-10 — Operation identity differs from physical attempt identity

Retries/model transitions must not overwrite the logical operation. Cherry and ZCode both expose attempt identity separately.

**ALCODE disposition:** Preserve compatibility; do not create a new attempt subsystem solely for 0.8.

### P-APP-11 — Admit/persist before acceptance is reported

Craft persists accepted input before acknowledgement; Cherry persists before terminal completion presentation; ALCODE already uses durable transcript admission.

**ALCODE disposition:** Extend existing durability discipline to Application Protocol commands where crash survival is promised.

## Phase-fit overlay

| Pattern family | 0.8 disposition | Authority |
|---|---|---|
| P-APP-01..05,07..09,11 | Adopt/Adapt — 0.8-core | Application Protocol + Host |
| P-APP-06,10 | Compatible / bounded | Host projection |
| P-META-01 cause/origin | Adopt if cheap | public event envelope |
| P-STATE-04 orthogonal outcome/effect/reconciliation | Adopt | Host/public projection |
| P-STATE-09 public reducer | Adapt | shared public protocol package |
| P-STATE-10 after-commit fan-out | Preserve existing durability discipline | Host/storage |
| P-STATE-15 ephemeral UI state | Adopt concept | Experience Plane |
| P-RENDER-04/05/06/10 | Adopt as needed | Experience Plane |
| P-UI-06 multi-file review | 0.8-compatible, not required for protocol closure | Experience Plane |
| P-RECOV-03 three-way reconcile | Later unless current Host recovery requires UI decision | Host + Experience Plane |
| P-PERM-01 pending approval canonical state | 0.8-core | Host/Application Protocol |
| notification/voice/graph/memory/workflow families | Defer | later phases/product work |
| tracking-token lattice/schema-history/time-travel | Research-only/defer | infrastructure |

## Result

This normalization converts the broad catalog into evidence feeding `phase-0.8-decisions.md`; it does not itself add acceptance criteria. The frozen implementation boundary lives in `docs/phase-0.8-plan.md`.
