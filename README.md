# ALCODE

A memory-native, verifier-driven coding agent. TypeScript end-to-end.

ALCODE replaces a prior host-dependent plugin topology (Ola + Ouroboros as
ZCode MCP sidecars) with an owned, integrated product in which memory,
reasoning, tools, model access, persistence, and UI are governed by one
codebase. The append-only event log is the canonical durable record; the Host
owns admission, policy, execution lifecycle, recovery, transcript/context
truth, and completion, while the Agent and Experience Plane consume Host-owned
protocols and disposable projections.

**Status:** Phases 0.0 through 0.9 are **closed**. Phase 0.9 established the
Host-governed extension and code-observation layer: Agent Plugins package
semantics, immutable digest-bound installed generations, dynamic generation-bound
Host capabilities, MCP Tools, monotonic lifecycle hooks, stable ACP v1, semantic
CodeIntelligence with freshness/synchronization fencing, and Host-projected
plugin management. Phase 0.9 source head `8b8620599660b639cef1205450f7f65afaa8af62`
passed the composed `gate:0.9` in PR run `31829969975`; the required Ubuntu and
Windows platform proof passed in run `31829969938`, and full CI passed in run
`31829969982`. `verbatim-v1` remains the product default; `graph-v1` remains
opt-in. Phase 0.9 closure does not authorize a successor phase. See
[`docs/roadmap.md`](docs/roadmap.md) for architecture orientation and
[`docs/phase-0.9-closure.md`](docs/phase-0.9-closure.md) for closure evidence.

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
11. [`docs/phase-0.9-closure.md`](docs/phase-0.9-closure.md) — as-built extension/
    observation contract summary and executable closure evidence.

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
- **Extension and observation adapters:** ALCODE-owned `@alcode/plugins`,
  `@alcode/mcp`, `@alcode/hooks`, `@alcode/acp`, and
  `@alcode/code-intelligence`, coordinated by Host-owned runtime services. External
  packages/protocols/providers remain replaceable adapters; they do not own
  canonical ALCODE state or bypass Host policy.

## Why this shape

The prior topology ran Ola and Ouroboros as per-session MCP servers under a
closed-source host. That caused accidental distribution: process lifecycle
session-owned, configuration shared, state path shared, task ownership
cross-session, deployment control outside the plugin. ALCODE removes that
accidental distribution by owning the cognitive loop and placing durable
authority in a Host runtime. Phase 0.8 extends the same ownership model through
the public Application Protocol: clients may disconnect and rebuild their
projection without becoming execution or persistence authorities. Phase 0.9
extends the boundary outward again: packages and external protocols compose
around the privileged Host instead of becoming a second control plane. See
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
0.9  Extension & observation adapters:           [CLOSED]
```

Every implemented phase ends with an **executable gate** (`pnpm gate:X.Y`)
that emits a machine-readable `GateReceipt` — see `docs/phase-0-spec.md` for
the schema. Gates drive sequencing, not calendars.

## Next

The completed Phase 0 foundation is Phase 0.0 through Phase 0.9. No successor
phase is authorized by Phase 0.9 closure. Deferred work remains in
[`docs/backlog.md`](docs/backlog.md) and requires a distinct client objective
before implementation.

`verbatim-v1` remains the product default and Phase 0.9 closure does not promote
`graph-v1`. See [`docs/roadmap.md`](docs/roadmap.md),
[`docs/phase-0-spec.md`](docs/phase-0-spec.md), and
[`docs/phase-0.9-closure.md`](docs/phase-0.9-closure.md).
