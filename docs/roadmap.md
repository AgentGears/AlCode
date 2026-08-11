# ALCODE Roadmap — Architecture Orientation

Status: **active; Phases 0.0 through 0.5 closed**. Phase 0.5 closed in merge
commit `9b06f4a` with `gate:0.5` green. Phase 0.6 is the next roadmap unit and
has **not started**. This document orients the architecture and sequencing; the
executable specification with authoritative gate definitions lives in
[`phase-0-spec.md`](./phase-0-spec.md).

## North star

ALCODE is a durable Host runtime that supervises replaceable reasoning agents,
mediates environmental capabilities, owns execution policy and canonical state,
schedules bounded durable work, and exposes a consistent workspace contract
across execution environments.

The governing ownership model is now implemented through Phase 0.5:

```text
Experience Plane
CLI / Desktop / Web / API
      │
      │ Application Protocol (later)
      ▼
┌────────────────────────────────────┐
│            ALCODE HOST             │
│                                    │
│ session lifetime                   │
│ canonical admission                │
│ permissions / policy               │
│ Agent supervision                  │
│ capability brokerage               │
│ durable persistence / recovery     │
│ bounded durable work               │
│ completion authority               │
└──────────────┬──────────────┬──────┘
               │              │
       Agent Protocol         │ Capability / Workspace
               │              │
               ▼              ▼
       ┌─────────────┐   ┌────────────────────┐
       │ replaceable │   │ EXECUTION          │
       │ Agent       │   │ filesystem         │
       │ process     │   │ terminal           │
       └─────────────┘   │ future capabilities│
                         └────────────────────┘

                    DURABLE STATE
              canonical events + projections
                     │             │
                     ▼             ▼
                  memory        reasoning
                  engine         engine
```

The load-bearing architectural shift is complete: durable execution and
canonical state are Host authority; the Agent is a replaceable reasoning
process. Memory and reasoning are semantic engines behind Host-owned admission,
not independent state-owning runtimes. ADR 0005 freezes these ownership
boundaries.

---

## Current position

```text
0.0   Architecture foundation            CLOSED
0.1A  Minimal owned agent                CLOSED
0.1B  Capability/provider layer          CLOSED
0.2   Durable event/recovery spine       CLOSED
0.3   Memory semantic engine             CLOSED
0.4   Reasoning semantic engine          CLOSED
0.5   Host + cognition integration       CLOSED
                                              │
                                              ▼
0.6   Durable verbatim context reconstruction NEXT — NOT STARTED
                                              │
                                              ▼
0.7   Graph-distilled context strategy   PLANNED
                                              │
                              ┌───────────────┴───────────────┐
                              ▼                               ▼
0.8   Application protocol + React UI    PLANNED     0.9 External adapters PLANNED
```

The completed foundation must not be reopened absent concrete defect evidence.
The next phase does not start automatically; it requires its own frozen plan
and authorization.

---

## Completed foundation

### 0.0 — Architecture foundation — CLOSED

Established the workspace, event-envelope scaffold, gate receipt machinery,
single-platform CI, licensing, threat/recovery documentation, and ADRs 0001–0004.

**Gate:** `gate:0.0`.

### 0.1A — Minimal owned agent — CLOSED

Converted the pi agent-loop slice into ALCODE-owned infrastructure with a
narrow provider/tool contract, deterministic offline provider, static extension
seam, and controlled `bash` tool.

**Gate:** `gate:0.1A`.

### 0.1B — Capability/provider layer — CLOSED

Completed the owned coding-tool set, LocalWorkspace/capability contracts,
deterministic pi acquisition verification, live Anthropic provider support,
pinned toolchain, and tri-platform CI. ADR 0005 froze Host ↔ Agent,
Host ↔ Capability, Host ↔ Workspace, Host ↔ Memory, and Host ↔ Reasoning
ownership before the semantic ports.

**Gate:** `gate:0.1B`, green on Ubuntu, macOS, and Windows.

### 0.2 — Durable event/recovery spine — CLOSED

Made the append-only event log canonical, added rebuildable projections,
workspace ownership/locking, durable session and operation lifecycle,
explicit uncertain-effect recovery, pre-persistence secret admission, and
replay/rebuild guarantees.

**Gate:** `gate:0.2`.

### 0.3 — Memory semantic engine — CLOSED

Ported Ola's memory semantic core into `@alcode/memory`: typed lesson/playbook
records, stable IDs, lexical retrieval, 0.65/0.20/0.15 scoring, exact-match
override, Ebbinghaus decay, seen/use separation, every-fifth-use consolidation,
lifecycle, provenance, and a rebuildable memory projection.

The engine owns semantics only. Canonical admission and persistence remain Host
and storage concerns.

**Gate:** `gate:0.3` with differential Ola fixtures.

### 0.4 — Reasoning semantic engine — CLOSED

Ported the source-faithful Ouroboros reasoning core into
`@alcode/reasoning`: graph vocabulary and validation, deterministic reducer,
cognitive transition intents, critic, branching/grafting, diagnostics,
falsifier evaluation, verification matching, and rebuildable reasoning
nodes/edges.

Phase 0.4 explicitly did **not** port Ouroboros `session_store`, MCP/runtime
adapters, Host execution authority, scheduler, or context compilation. Those
belong outside the reasoning engine under ADR 0005. See
[`phase-0.4-exclusion-rationale.md`](./phase-0.4-exclusion-rationale.md).

**Gate:** `gate:0.4` with pinned Ouroboros golden evidence and migration/replay
proofs.

### 0.5 — Host runtime + durable cognition integration — CLOSED

Established the Host control plane and bound the semantic engines to the Agent
loop without moving durable authority into the Agent. The completed surfaces
include:

- `@alcode/agent-protocol` — explicit Host ↔ Agent semantic messages and local
  Node IPC adapters;
- `@alcode/host-runtime` — canonical admission, Host session lifetime, Agent
  supervision, capability policy/brokerage, durable-work dispatch, completion
  authority, and cognition gateway;
- `@alcode/cognition-runtime` — orientation, recall/verification/reinforcement
  policy, and completion assessment semantics;
- `@alcode/cognition-extension` — thin Agent-side proxy/lifecycle adapter;
- bounded storage read models without exposing the SQLite handle;
- environmental reasoning integration events (`action.recorded`,
  `evidence.recorded`, `verification.result.correlated`);
- bounded event-sourced `memory.consolidation` work with retry-safe semantic
  idempotency.

The signature proof is now executable:

```text
kill Agent A while Host-owned work is in flight
→ Host durably completes the operation
→ launch Agent B
→ resume the same session
→ orient from durable cognition
→ continue acting
```

Agent death does not stop the Host session or erase operation/memory/reasoning
identity. Host death after an uncertain external mutation reuses Phase 0.2's
indeterminate/pending recovery doctrine and does not automatically retry.

**Gate:** `gate:0.5`, composing `gate:0.4`. Frozen plan and closure evidence:
[`phase-0.5-plan.md`](./phase-0.5-plan.md).

---

## Next roadmap unit

### 0.6 — Durable verbatim context reconstruction — NEXT / NOT STARTED

The next architectural problem is model-visible conversational continuity.
Phase 0.5 proved that durable cognition survives Agent replacement; Phase 0.6
must make the provider-facing conversation reconstructable from canonical
durable state rather than ephemeral Agent memory.

Target boundary:

```text
canonical transcript/events
        ↓
Host-owned verbatim reconstruction
        ↓
provider-compatible message sequence
        ↓ Agent Protocol / model boundary
replacement Agent
```

pi remains the behavioral parity reference for verbatim conversion. The phase
should prove ordering, role/content fidelity, tool-call/result pairing,
restart reconstruction, and continuation from durability alone.

**Not 0.6:** graph-distilled selection, semantic compression, token-budget
optimization, compaction strategy, or making graph context default. Those
belong to 0.7.

**Gate:** `gate:0.6` after the phase is planned, authorized, and implemented.
See [`phase-0-spec.md`](./phase-0-spec.md) §0.6.

---

## Later roadmap

### 0.7 — Graph-distilled context strategy

Introduce graph-distilled context behind a toggle with required inclusions,
projection receipts, fail-safe verbatim fallback, and preregistered evaluation.
The graph strategy remains non-default until measured evidence justifies it.

Both 0.6 verbatim and 0.7 graph context are Host-selected strategies; neither
moves canonical state ownership into the Agent.

### 0.8 — Application Protocol + React experience

Define the application transport contract before the UI, then build the React
experience as a client of ordered Host events. This phase also owns the
product-level `START_NOW`, `GUIDE`, and `QUEUE` admission semantics rather than
smuggling them into the 0.5 Agent Protocol.

### 0.9 — External adapters

Add hooks, MCP, ACP, and code-intelligence adapters onto the Host. Integration
remains an adapter role, never a canonical state owner.

---

## Workspace abstraction

The current concrete implementation is `LocalWorkspace`, with filesystem and
terminal authority mediated through owned capability contracts. The invariant
remains:

```text
workspace identity != transport != location
```

SSH, WSL, Docker, remote-server backends, browser capability, and other remote
execution mechanisms remain deferred until a product requirement activates
them. They are not Phase 0.6 prerequisites.

---

## Ownership checkpoint — completed

The pre-semantic-port checkpoint is no longer pending. ADR 0005 froze:

- Host ↔ Agent
- Host ↔ Capability
- Host ↔ Workspace
- Host ↔ Memory engine
- Host ↔ Reasoning engine

Phase 0.5 then exercised those boundaries in production code and gates.
Still intentionally unfrozen/deferred:

- public/remote wire encoding;
- remote Agent transport;
- general scheduler/automation schema;
- subagent protocol;
- browser protocol;
- full workflow/task model.

---

## Deliberately deferred

Do not promote attractive reference-system features merely because they exist.
Keep them deferred unless activated by an authorized phase or concrete product
requirement:

- full workflow product;
- recurring automation UI;
- subagent worktree isolation;
- dynamic user-installed extension loading;
- vector memory retrieval;
- auto-skill minting;
- full graph visualization;
- multi-agent kanban;
- multi-writer durable store;
- remote workspace backends.

The backlog remains trigger-based rather than calendar-based.

---

## Document roles

- **This file** (`docs/roadmap.md`): current architecture orientation and sequencing.
- [`docs/phase-0-spec.md`](./phase-0-spec.md): executable specification with
  authoritative gate definitions and historical phase contracts.
- [`docs/phase-0.5-plan.md`](./phase-0.5-plan.md): completed frozen 0.5 contract
  and closure evidence.
- [`docs/constitution.md`](./constitution.md): the 10 frozen principles.
- [`docs/rules.md`](./rules.md): hard rules.
- [`docs/backlog.md`](./backlog.md): trigger-based deferred work.
