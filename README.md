# ALCODE

A memory-native, verifier-driven coding agent. TypeScript end-to-end.

ALCODE replaces a prior host-dependent plugin topology (Ola + Ouroboros as
ZCode MCP sidecars) with an owned, integrated product in which memory,
reasoning, tools, model access, persistence, and UI are governed by one
codebase. The append-only event log is the canonical durable record; the Host
owns admission, policy, execution lifecycle, recovery, transcript/context
truth, and completion, while the Agent and Experience Plane consume Host-owned
protocols and disposable projections.

**Status:** Phases 0.0 through 0.8 are **closed**. Phase 0.8 established the
Host-owned Application Protocol and React 19 Experience Plane with explicit
`START_NOW`, `GUIDE`, and `QUEUE` admission, Host-owned queueing, target-sensitive
cancellation, structured permission interactions, and cursor/snapshot recovery.
PR #19 final source head `99ea7dc524e8a3be608c6ab8f4aaf0e631a3cb14`
passed `gate:0.8` and full composed CI, then squash-merged as
`c4d41028d964155e0f5bb808f49e57385fed80fb`. `verbatim-v1` remains the product
default; `graph-v1` remains opt-in. Phase 0.9 is the next planned roadmap unit
and is not authorized by Phase 0.8 closure. See
[`docs/roadmap.md`](docs/roadmap.md) for architecture orientation.

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
10. [`docs/phase-0.8-plan.md`](docs/phase-0.8-plan.md) — frozen and completed
    Application Protocol + React Experience contract and closure evidence.

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
- **Application Protocol + React experience:** ALCODE-owned
  `@alcode/application-protocol`, Host Application service/controller, replaceable
  local loopback transport seam, public snapshot/event reducer, and
  `@alcode/web` React 19 client. The Host remains canonical; React is a disposable
  projection client. The current Agent Protocol has no safe mid-turn steering
  seam, so `GUIDE` is explicitly rejected as `guide_not_supported` rather than
  silently becoming `START_NOW` or `QUEUE`.
- **Code intelligence (later):** codebase-memory-mcp (MIT, pure C) remains a
  reference for the planned Phase 0.9 adapter layer; external adapters never own
  canonical ALCODE state.

## Why this shape

The prior topology ran Ola and Ouroboros as per-session MCP servers under a
closed-source host. That caused accidental distribution: process lifecycle
session-owned, configuration shared, state path shared, task ownership
cross-session, deployment control outside the plugin. ALCODE removes that
accidental distribution by owning the cognitive loop and placing durable
authority in a Host runtime. Phase 0.8 extends the same ownership model through
the public Application Protocol: clients may disconnect and rebuild their
projection without becoming execution or persistence authorities. See
[`docs/constitution.md`](docs/constitution.md) and ADR 0005 for the ownership
model.

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
0.8  React GUI / Application Protocol:           [CLOSED]
0.9  External integrations:                      [PLANNED]
```

Every implemented phase ends with an **executable gate** (`pnpm gate:X.Y`)
that emits a machine-readable `GateReceipt` — see `docs/phase-0-spec.md` for
the schema. Gates drive sequencing, not calendars.

## Next

The completed foundation is Phase 0.0 through Phase 0.8. The next planned
roadmap unit is **Phase 0.9 — External adapters**: hooks, MCP, ACP, and code
intelligence as adapters over the same Host runtime, never as canonical state
owners.

Phase 0.8 closure does not authorize Phase 0.9 implementation and does not
promote `graph-v1` to the product default. See
[`docs/roadmap.md`](docs/roadmap.md),
[`docs/phase-0-spec.md`](docs/phase-0-spec.md), and
[`docs/phase-0.8-plan.md`](docs/phase-0.8-plan.md).
