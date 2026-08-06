# ALCODE

A memory-native, verifier-driven coding agent. TypeScript end-to-end.

ALCODE replaces a prior host-dependent plugin topology (Ola + Ouroboros as
ZCode MCP sidecars) with an owned, integrated product in which memory,
reasoning, tools, model access, persistence, and UI are governed by one
codebase. The append-only event log is the source of truth; reasoning, memory,
the transcript, the UI, and the LLM context window are all projections of it.

**Status:** Phase 0 (foundation). No code yet — `docs/` is the active artifact.
`ref/` holds the studied reference codebases.

## Read first

1. [`docs/constitution.md`](docs/constitution.md) — the 10 frozen principles.
2. [`docs/phase-0-spec.md`](docs/phase-0-spec.md) — the executable build order.
3. [`docs/rules.md`](docs/rules.md) — hard constraints applying to every phase.
4. [`docs/non-goals.md`](docs/non-goals.md) — what Phase 0 deliberately does not do.
5. [`docs/backlog.md`](docs/backlog.md) — deferred items with reactivation conditions.

## What ALCODE is built from

- **Agent loop:** pi (MIT) — acquired as licensed source, converted to owned
  infrastructure. Provenance: [`docs/provenance/pi.md`](docs/provenance/pi.md).
- **Memory:** Ola's contracts (JS→TS) — Ebbinghaus strength, reinforcement
  doctrine, lifecycle, retrieval scoring.
- **Reasoning:** Ouroboros's core (Py→TS) — reasoning graph, falsifiers,
  verification contracts, critic, diagnostics.
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
0.0 Minimal architecture constitution:        1–2 days      [DOCS — done]
0.1 Source acquisition + ownership:           3–7 days      [next]
0.2 Minimal durable vertical slice:           1–2 weeks     (load-bearing)
0.3 Memory semantic core (Ola):               3–7 days
0.4 Reasoning semantic core (Ouroboros):      1–2 weeks
0.5 Durable cognition integration:            1–2 weeks
0.6 Verbatim context compiler:                3–5 days
0.7 Graph context compiler + experiment:      1–2 weeks
0.8 React GUI:                                1–2 weeks
0.9 External integrations:                    1–2 weeks
---------------------------------------------
Internal alpha:                               ~6–11 weeks
```

Gates drive sequencing, not calendars.

## The next action

Phase 0.0 (the docs) is complete. The next action is **Phase 0.1**: create the
`packages/` workspace, import the selected pi source as a separate git commit,
record provenance, do the ownership-conversion commit, and boot `alcode -p "hello"`.

See [`docs/phase-0-spec.md`](docs/phase-0-spec.md) §0.1 for the exact scope,
exclusions, deliverables, tests, and exit gate.
