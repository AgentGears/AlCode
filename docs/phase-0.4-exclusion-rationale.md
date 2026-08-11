# Phase 0.4 — Exclusion Rationale

Phase 0.4 ports **reasoning semantics only**: graph semantics, cognitive
artifacts, deterministic reduction, critic behavior, branching/grafting,
diagnostics, falsifiers, and verification semantics. The Reasoning engine
remains a semantic engine behind the ADR 0005 Host ↔ Reasoning boundary.
The Host owns canonical `reasoning.*` events, durable persistence,
environmental authority, and execution lifecycle.

## Summary rule

> **Phase 0.4 ports Ouroboros reasoning behavior, not the runtime that
> happened to host it.** Persistence, transport, governance authority,
> environmental execution, scheduling, cognition orchestration,
> offload/rehydration, and model-context compilation remain outside
> `@alcode/reasoning`.

## What is excluded and why

### Ouroboros `session_store`

Persistence is Host authority. ALCODE already has the durable event/recovery
spine from Phase 0.2. A second reasoning-owned store would create competing
sources of truth.

### Ouroboros MCP/runtime adapters

Transport and integration mechanisms, not reasoning semantics. ADR 0005
leaves wire encoding, remote transport, scheduler protocols unfrozen.

### Ola Memory Subagent control loop

Cognition orchestration (what to retrieve, when to verify, what to do next)
belongs to the cognition coordinator in Phase 0.5.

### Ola offload/rehydration system

Context/state-management infrastructure. Those concerns belong to 0.6
(verbatim context) and 0.7 (graph-distilled context strategy).

### Ola governance implementation

Canonical admission authority belongs to the Host. The reasoning engine may
propose or semantically validate; it does not canonically commit itself.

### Host execution orchestration

Reasoning may model verification intent and interpret evidence. It must not
start processes, invoke capabilities, own operation lifecycle, or authorize
actions.

### Scheduler work

Scheduling is a Host control-plane mechanism. The reasoning engine outputs
semantic eligibility/intent only; it creates no jobs, workers, or leases.

### Context compilation

Graph state and model context are distinct products. Phase 0.4 exposes
structured orientation/query results; prompt/context compilation is deferred
to 0.6/0.7.
