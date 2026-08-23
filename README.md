# ALCODE

A memory-native, verifier-driven coding agent and durable autonomous software-engineering runtime. TypeScript end-to-end.

ALCODE replaces a prior host-dependent plugin topology (Ola + Ouroboros as ZCode MCP sidecars) with an owned, integrated product in which memory, reasoning, tools, model access, persistence, UI, durable Program state, execution, verification, and recovery are governed by one codebase. The append-only event log is the canonical durable record; the Host owns admission, policy, execution lifecycle, recovery, transcript/context truth, Program truth, verification, and completion, while the Agent and Experience Plane consume Host-owned protocols and disposable projections.

**Status:** the closed product baseline includes Phases 0.0–0.9, Phase 1.0 Durable ProgramState, Phase 1.1 Default Program Execution, S-01 Replaceable Agent Runtime, and P-01 Production Program Agent. P-01 closed at `e6a9025b767a8fc9026bcd72670a338e8a37c059` under the exact `pnpm gate:product-agent` proof surface. The current architecture is a fixed-topology autonomous Program runtime: a real model plans through Host-tracked reads, proposes a bounded Program, executes fresh ProgramAttempts through Host capabilities, receives Host-owned verification failure context, retries under fresh authority, advances structurally-ready successor work without another caller prompt, survives Agent replacement under recovery rules, and completes only through the Host Completion Oracle.

The forward architecture is recorded in [`docs/roadmap.md`](docs/roadmap.md). **A1 — Adaptive Program Revision and Progressive Decomposition** is the recommended next design objective, but roadmap direction does not authorize implementation. The authoritative P-01 closure record is [`docs/p-01-production-program-agent-as-built.md`](docs/p-01-production-program-agent-as-built.md).

`verbatim-v1` remains the product default; `graph-v1` remains opt-in.

`ref/` (gitignored) holds studied reference codebases — not part of this repo.

## Read first

1. [`docs/constitution.md`](docs/constitution.md) — the frozen architectural principles.
2. [`docs/roadmap.md`](docs/roadmap.md) — durable architecture direction, current position, and A1–A11 sequencing.
3. [`docs/rules.md`](docs/rules.md) — hard runtime, storage, effect, cognition, context, Application, and extension rules.
4. [`docs/event-contract.md`](docs/event-contract.md) — canonical event envelope, producer, identity, versioning, and ownership semantics.
5. [`docs/phase-1.0-freeze.md`](docs/phase-1.0-freeze.md) — frozen Durable ProgramState contract decision.
6. [`docs/phase-1.0-as-built.md`](docs/phase-1.0-as-built.md) — Phase 1.0 implementation mapping.
7. [`docs/phase-1.1-as-built.md`](docs/phase-1.1-as-built.md) — default Program execution implementation mapping.
8. [`docs/s-01e-agent-generation-closure-contract.md`](docs/s-01e-agent-generation-closure-contract.md) — S-01 generation closure boundary.
9. [`docs/p-01-production-program-agent-as-built.md`](docs/p-01-production-program-agent-as-built.md) — Production Program Agent closure and exact product gate.
10. [`docs/backlog.md`](docs/backlog.md) — deferred work with reactivation conditions.

Historical Phase 0 plans and closure records remain under `docs/` and retain their original frozen/closure roles.

### Architecture decisions

- [`docs/adr/0001-event-and-projection-commit-semantics.md`](docs/adr/0001-event-and-projection-commit-semantics.md)
- [`docs/adr/0002-workspace-identity-and-locking.md`](docs/adr/0002-workspace-identity-and-locking.md)
- [`docs/adr/0003-tool-operation-uncertainty-and-recovery.md`](docs/adr/0003-tool-operation-uncertainty-and-recovery.md)
- [`docs/adr/0004-secret-admission-and-erasure.md`](docs/adr/0004-secret-admission-and-erasure.md)
- [`docs/adr/0005-runtime-ownership-boundaries.md`](docs/adr/0005-runtime-ownership-boundaries.md)

### Operational

- [`docs/threat-model.md`](docs/threat-model.md)
- [`docs/operation-recovery.md`](docs/operation-recovery.md)
- [`docs/provenance/`](docs/provenance/) — per-import provenance records.

## Current product path

```text
caller objective
  → durable Host input admission
  → Host planning episode
  → model planning through tracked Host reads + exact verifier catalog
  → bounded Program proposal
  → Host validation / seal
  → explicit Application acceptance
  → fresh ProgramAttempt
  → Host-requested Agent execution
  → Host-mediated coding capabilities
  → Host verifier execution
      fail → retire Attempt + durable failure fact → fresh retry Attempt
      pass → complete work → fresh successor Attempt when ready
  → Completion Oracle
  → Program.completed
```

The Agent remains replaceable cognition. It does not own canonical ProgramState, ProgramAttempt currency, capability admission, Operation/effect truth, recovery, verification, execution-base identity, or completion.

## What ALCODE is built from

- **Agent loop:** pi (MIT), acquired as licensed source and converted into ALCODE-owned infrastructure. Provenance: [`docs/provenance/pi.md`](docs/provenance/pi.md).
- **Memory:** Ola-derived semantic contracts — retrieval, strength, reinforcement, lifecycle, and consolidation semantics.
- **Reasoning:** Ouroboros-derived semantic core — reasoning graph, falsifiers, verification contracts, critic, and diagnostics.
- **Host/runtime:** ALCODE-owned Agent Protocol, Host runtime, canonical admission, capability brokerage, durable Program authority, execution/recovery, verification, and completion.
- **Transcript/context:** ALCODE-owned rich transcript domain, durable reconstruction, `verbatim-v1`, governed `graph-v1`, Host context authority, receipts, and replaceable-Agent hydration.
- **Application Protocol + React experience:** Host-authored public state/commands consumed by disposable clients.
- **Extension and observation adapters:** Host-governed plugins, MCP, hooks, ACP, and CodeIntelligence adapters that do not become a second control plane.

## Why this shape

The prior topology ran cognition as per-session sidecars beneath an external host. ALCODE removes that accidental distribution by owning the cognitive loop and placing durable execution authority in the Host. Sessions, Agent processes, provider inference, clients, plugins, and later workers are replaceable participants around durable Host-owned truth.

The current load-bearing hierarchy is:

```text
ProgramState
     ↓
fixed accepted work topology
     ↓
ProgramAttempt
     ↓
Agent Generation / Agent Run / Inference Scope
     ↓
CapabilityBroker
     ↓
Host Operation
     ↓
effect / recovery / verification
```

The next architectural problem is to make Program meaning itself safely revisionable without invalidating unrelated execution or evidence. See [`docs/roadmap.md`](docs/roadmap.md).

## Closed milestones

```text
0.0–0.9  Owned foundation, durability, cognition, context, UI, adapters [CLOSED]
1.0      Durable ProgramState                                         [CLOSED]
1.1      Default Program-backed execution                             [CLOSED]
S-01     Replaceable Agent runtime                                    [CLOSED]
P-01     Production Program Agent                                     [CLOSED]
```

Every closed objective is backed by an executable gate and/or exact closure record. Gates drive sequencing, not calendars.

## Next

The repository is at the boundary between a **fixed-topology autonomous Program** and an **adaptive long-horizon Program**.

A1 is not yet an implementation-authorized objective. Its separate candidate plan must define and freeze ProgramRevision transactions, WorkItem identity/generation, progressive decomposition, revision impact, Attempt invalidation, verification invalidation, recovery/rebuild, and Completion Oracle interaction before production implementation begins.

See [`docs/roadmap.md`](docs/roadmap.md) for the durable forward architecture. Successor implementation requires its own explicit plan/freeze; completion of P-01 does not implicitly authorize it.
