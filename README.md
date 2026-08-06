# ALCODE

A memory-native, verifier-driven coding agent. TypeScript end-to-end.

ALCODE replaces a prior host-dependent plugin topology (Ola + Ouroboros as
ZCode MCP sidecars) with an owned, integrated product in which memory,
reasoning, tools, model access, persistence, and UI are governed by one
codebase. The append-only event log is the source of truth; reasoning, memory,
the transcript, the UI, and the LLM context window are all projections of it.

**Status:** Phase 0.0 (architecture foundation) — **reopened**. Documentation
is complete; the executable scaffold (workspace, `events` package, gate runner,
ADRs, threat model, recovery model, licensing, minimal CI) is pending.

`ref/` (gitignored) holds studied reference codebases — not part of this repo.

## Read first

1. [`docs/constitution.md`](docs/constitution.md) — the 10 frozen principles.
2. [`docs/phase-0-spec.md`](docs/phase-0-spec.md) — the executable build order,
   with gate-receipt schema and per-phase `pnpm gate:X.Y` exit gates.
3. [`docs/event-contract.md`](docs/event-contract.md) — the domain event
   envelope, producer, identity, versioning semantics, and ownership rules.
4. [`docs/rules.md`](docs/rules.md) — hard constraints applying to every phase.
5. [`docs/non-goals.md`](docs/non-goals.md) — what Phase 0 deliberately does not do.
6. [`docs/backlog.md`](docs/backlog.md) — deferred items with reactivation conditions.

### Architecture decisions (ADRs)

- [`docs/adr/0001-event-and-projection-commit-semantics.md`](docs/adr/0001-event-and-projection-commit-semantics.md)
- [`docs/adr/0002-workspace-identity-and-locking.md`](docs/adr/0002-workspace-identity-and-locking.md)
- [`docs/adr/0003-tool-operation-uncertainty-and-recovery.md`](docs/adr/0003-tool-operation-uncertainty-and-recovery.md)
- [`docs/adr/0004-secret-admission-and-erasure.md`](docs/adr/0004-secret-admission-and-erasure.md)

### Operational

- [`docs/threat-model.md`](docs/threat-model.md)
- [`docs/operation-recovery.md`](docs/operation-recovery.md)
- [`docs/provenance/`](docs/provenance/) — per-import provenance records.

## What ALCODE is built from

- **Agent loop:** pi (MIT) — acquired as licensed source, converted to owned infrastructure. Provenance: [`docs/provenance/pi.md`](docs/provenance/pi.md).
- **Memory:** Ola's contracts (JS→TS) — Ebbinghaus strength, reinforcement doctrine, lifecycle, retrieval scoring.
- **Reasoning:** Ouroboros's core (Py→TS) — reasoning graph, falsifiers, verification contracts, critic, diagnostics.
- **GUI streaming layer:** open-harness's `ui-stream.ts` + React provider (MIT).
- **Code intelligence (later):** codebase-memory-mcp (MIT, pure C).

## Why this shape

The prior topology ran Ola and Ouroboros as per-session MCP servers under a
closed-source host. That caused accidental distribution: process lifecycle
session-owned, configuration shared, state path shared, task ownership
cross-session, deployment control outside the plugin. ALCODE removes that
accidental distribution by owning the whole cognitive loop. See
[`docs/constitution.md`](docs/constitution.md) for the full rationale.

## Phase 0 at a glance

```
0.0  Architecture foundation (REOPENED):        2–4 days      [docs done; scaffold pending]
0.1A Minimal agent loop + offline provider:    2–4 days      [next]
0.2  Minimal durable vertical slice:           1–2 weeks     (load-bearing)
0.1B Remaining tools, live providers, repro:   3–7 days
0.3  Memory semantic core (Ola):               3–7 days
0.4  Reasoning semantic core (Ouroboros):      1–2 weeks
0.5  Durable cognition integration:            1–2 weeks
0.6  Verbatim context compiler:                3–5 days
0.7  Graph context compiler + experiment:      1–2 weeks
0.8  React GUI:                                1–2 weeks
0.9  External integrations:                    1–2 weeks
---------------------------------------------
Internal alpha:                               ~6–11 weeks
```

Every phase ends with an **executable gate** (`pnpm gate:X.Y`) that emits a
machine-readable `GateReceipt` — see `docs/phase-0-spec.md` for the schema.
Gates drive sequencing, not calendars.

## The next action

Phase 0.0's documentation is complete; the executable scaffold is pending. The
next action is to **finish Phase 0.0**: create the `packages/` workspace,
implement the `events` scaffold, add the `test-provider`, set up the gate
runner harness with the `GateReceipt` schema, add minimal CI on one platform,
write `LICENSE`/`THIRD_PARTY_NOTICES.md`, and make `pnpm gate:0.0` emit
`status: "passed"`.

See [`docs/phase-0-spec.md`](docs/phase-0-spec.md) §0.0 for the exact scope,
exclusions, deliverables, tests, and exit gate.
