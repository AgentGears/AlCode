# ALCODE

A memory-native, verifier-driven coding agent. TypeScript end-to-end.

ALCODE replaces a prior host-dependent plugin topology (Ola + Ouroboros as
ZCode MCP sidecars) with an owned, integrated product in which memory,
reasoning, tools, model access, persistence, and UI are governed by one
codebase. The append-only event log is the source of truth; reasoning, memory,
the transcript, the UI, and the LLM context window are all projections of it.

**Status:** Phases 0.0 through 0.7 are **closed**. The durable event/recovery
spine, memory semantics, reasoning semantics, Host control plane, durable
cognition integration, replaceable-Agent property, durable verbatim model
context, and governed selective-context policy are proven. Phase 0.7 closed in
merge commit `eae55ae657b850ab77dbbb1ba0951fe41a1c3285`; exact-head PR CI run
`31589327975` passed `gate:0.7` and all composed foundation gates. `verbatim-v1`
remains the product default; `graph-v1` remains opt-in. Phase 0.8 is planned and
was not started by Phase 0.7 closure. See [`docs/roadmap.md`](docs/roadmap.md)
for architecture orientation.

`ref/` (gitignored) holds studied reference codebases — not part of this repo.

## Read first

1. [`docs/constitution.md`](docs/constitution.md) — the 10 frozen principles.
2. [`docs/roadmap.md`](docs/roadmap.md) — architecture orientation and sequencing.
3. [`docs/phase-0-spec.md`](docs/phase-0-spec.md) — the executable build order,
   with gate-receipt schema and per-phase `pnpm gate:X.Y` exit gates.
4. [`docs/event-contract.md`](docs/event-contract.md) — the domain event
   envelope, producer, identity, versioning semantics, and ownership rules.
5. [`docs/rules.md`](docs/rules.md) — hard constraints applying to every phase.
6. [`docs/non-goals.md`](docs/non-goals.md) — what Phase 0 deliberately does not do.
7. [`docs/backlog.md`](docs/backlog.md) — deferred items with reactivation conditions.
8. [`docs/phase-0.6-plan.md`](docs/phase-0.6-plan.md) — frozen and completed
   durable verbatim context reconstruction plan and closure evidence.
9. [`docs/phase-0.7-plan.md`](docs/phase-0.7-plan.md) — frozen and completed
   governed selective-context / `graph-v1` contract and closure evidence.

### Architecture decisions (ADRs)

- [`docs/adr/0001-event-and-projection-commit-semantics.md`](docs/adr/0001-event-and-projection-commit-semantics.md)
- [`docs/adr/0002-workspace-identity-and-locking.md`](docs/adr/0002-workspace-identity-and-locking.md)
- [`docs/adr/0003-tool-operation-uncertainty-and-recovery.md`](docs/adr/0003-tool-operation-uncertainty-and-recovery.md)
- [`docs/adr/0004-secret-admission-and-erasure.md`](docs/adr/0004-secret-admission-and-erasure.md)
- [`docs/adr/0005-runtime-ownership-boundaries.md`](docs/adr/0005-runtime-ownership-boundaries.md)

### Operational

- [`docs/threat-model.md`](docs/threat-model.md)
- [`docs/operation-recovery.md`](docs/operation-recovery.md)
- [`docs/provenance/`](docs/provenance/) — per-import provenance records.

## What ALCODE is built from

- **Agent loop:** pi (MIT) — acquired as licensed source, converted to owned infrastructure. Provenance: [`docs/provenance/pi.md`](docs/provenance/pi.md).
- **Memory:** Ola's contracts (JS→TS) — Ebbinghaus strength, reinforcement doctrine, lifecycle, retrieval scoring.
- **Reasoning:** Ouroboros's core (Py→TS) — reasoning graph, falsifiers, verification contracts, critic, diagnostics.
- **Host/runtime:** ALCODE-owned Agent Protocol, Host runtime, cognition runtime,
  canonical admission, capability brokerage, recovery, and bounded durable work.
- **Transcript/context baseline:** ALCODE-owned rich transcript domain,
  Host-acknowledged transcript admission, `verbatim-v1` reconstruction, and
  replaceable-Agent hydration from canonical events.
- **Selective context:** ALCODE-owned `@alcode/context` compiler and Host context
  service with per-inference authorization, `graph-v1`, trust/provenance
  containment, objective-scoped reasoning, relevance-gated memory, bounded
  workspace observations and receipts, deterministic fallback, and isolated
  preregistered evaluation.
- **GUI streaming layer (planned for 0.8):** open-harness's `ui-stream.ts` + React provider (MIT).
- **Code intelligence (later):** codebase-memory-mcp (MIT, pure C).

## Why this shape

The prior topology ran Ola and Ouroboros as per-session MCP servers under a
closed-source host. That caused accidental distribution: process lifecycle
session-owned, configuration shared, state path shared, task ownership
cross-session, deployment control outside the plugin. ALCODE removes that
accidental distribution by owning the cognitive loop and placing durable
authority in a Host runtime. See [`docs/constitution.md`](docs/constitution.md)
and ADR 0005 for the ownership model.

## Phase 0 at a glance

```text
0.0  Architecture foundation:                    [CLOSED]
0.1A Minimal agent loop + offline provider:      [CLOSED]
0.1B Capability/provider layer:                  [CLOSED]
0.2  Durable event/recovery spine:               [CLOSED]
0.3  Memory semantic engine:                     [CLOSED]
0.4  Reasoning semantic engine:                  [CLOSED]
0.5  Host + cognition integration:               [CLOSED]
0.6  Durable verbatim context reconstruction:    [CLOSED]
0.7  Governed selective context / graph-v1:      [CLOSED]
0.8  React GUI / application protocol:           [PLANNED]
0.9  External integrations:                      [PLANNED]
```

Every implemented phase ends with an **executable gate** (`pnpm gate:X.Y`)
that emits a machine-readable `GateReceipt` — see `docs/phase-0-spec.md` for
the schema. Gates drive sequencing, not calendars.

## Next

The completed foundation is 0.0 through 0.7. The next planned roadmap unit is
**Phase 0.8 — Application Protocol + React experience**: define the application
transport contract before UI implementation, then build the React client as a
consumer of ordered Host events. Phase 0.8 also owns product-level
`START_NOW`, `GUIDE`, and `QUEUE` admission semantics.

Phase 0.7 closure does not authorize Phase 0.8 implementation and does not
promote `graph-v1` to the product default. See
[`docs/roadmap.md`](docs/roadmap.md) and
[`docs/phase-0.7-plan.md`](docs/phase-0.7-plan.md).
