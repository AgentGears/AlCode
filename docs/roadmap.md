# ALCODE Roadmap — Architecture Orientation

Status: **active; Phases 0.0, 0.1A, 0.2 closed**. This document orients the
architecture and sequencing. The executable specification with authoritative
gate definitions lives in [`phase-0-spec.md`](./phase-0-spec.md).

## North star

ALCODE is a durable Host runtime that supervises replaceable reasoning agents,
mediates environmental capabilities, owns execution policy and canonical state,
schedules durable work, and exposes a consistent workspace contract across
execution environments.

The governing ownership model:

```text
Experience Plane
CLI / Desktop / Web / API
      │
      │ Application Protocol
      ▼
┌───────────────────────────────┐
│         ALCODE HOST           │
│                               │
│ sessions                      │
│ execution contracts           │
│ input admission               │
│ permissions / policy          │
│ agent supervision             │
│ capability brokerage          │
│ durable persistence           │
│ scheduler dispatch            │
└──────────┬───────────┬────────┘
           │           │
    Agent Protocol     │ Capability / Workspace Protocol
           │           │
           ▼           ▼
      ┌─────────┐   ┌────────────────────┐
      │  AGENT  │   │ EXECUTION          │
      │         │   │                    │
      │ replace-│   │ filesystem         │
      │ able    │   │ terminal           │
      │ reasoner│   │ git                │
      └─────────┘   │ browser            │
                    │ other capabilities │
                    └────────────────────┘

              DURABLE STATE
        canonical events + projections
```

The key shift from the original roadmap: build semantic engines on the proven
durable spine while progressively extracting a Host control plane, so that by
Phase 0.5 the Agent is replaceable, capabilities are mediated, and durable
execution — not the reasoning process — is the product authority.

---

## Current position

```text
0.0   Architecture foundation            CLOSED
0.1A  Owned minimal agent                CLOSED
0.2   Durable event/recovery spine        CLOSED
                                              │
                         ┌─────────────────────┼─────────────────────┐
                         ▼                     ▼                     ▼
                      0.1B                   0.3                   0.4
                 Capability              Memory               Reasoning
                 foundation              semantics            semantics
                    │                       │                     │
                    │                       └──────────┬──────────┘
                    └───────────────────────────────┬─┘
                                                  ▼
                                                 0.5
                                        Host + cognition
                                           integration
                                                  │
                                                  ▼
                                                 0.6
                                        Verbatim context
                                                  │
                                                  ▼
                                                 0.7
                                           Graph context
                                                  │
                                     ┌────────────┴────────────┐
                                     ▼                         ▼
                                    0.8                       0.9
                              Experience/UI              Integrations
```

Phase 0.2 stays closed. Its canonical event architecture becomes the
foundation for the Host rather than something to refactor away.

Phases 0.1B, 0.3, and 0.4 can proceed in parallel. Prefer closing 0.1B
before the heavy 0.5 integration begins, but do not make that a frozen
dependency unless concrete implementation evidence requires it.

---

## Phase summaries

### 0.1B — Capability foundation + complete coding agent

The existing objective remains: remaining tools, live providers,
deterministic acquisition, tri-platform CI, and pinned runtime/toolchain.

The architectural refinement is that the six new tools should begin
establishing the Capability boundary. Instead of tools directly owning
filesystem/process authority, move incrementally toward:

```text
AgentTool adapter
       │
       ▼
Capability contract
       │
       ▼
Host-owned implementation
```

Do not migrate everything into a separate Host process yet. The immediate
goal is to make capabilities extractable. The current `bash` tool can
initially sit behind the terminal capability implementation.

**Gate:** `gate:0.1B`, tri-platform CI. See [`phase-0-spec.md`](./phase-0-spec.md) §0.1B.

### 0.3 — Memory semantic engine

Ola is the primary behavioral reference. ZCode is the secondary
product-semantics reference.

The semantic boundary must explicitly distinguish five operations that must
not collapse into a single `remember()` mechanism:

1. Memory record
2. Memory retrieval
3. Memory reinforcement
4. Memory extraction
5. Memory consolidation

Primary Ola semantics: lessons/playbooks, stable memory IDs, retrieval
scoring, exact-match override, strength/decay, recordUse vs recordSeen,
lifecycle, provenance, lexical retrieval.

ZCode constraints: user/feedback/project/reference memory classes, prefer
non-derivable information, avoid copying information recoverable from code,
treat memories as potentially stale, separate extraction from retrieval,
bounded extraction authority.

The ALCODE design: the Agent requests recall; the Host invokes the Memory
engine; the Memory engine reads the durable projection; the result returns
to the Agent. Memory semantic transitions go through canonical `memory.*`
events to derived memory projections. No detached extraction worker — any
future extraction/consolidation goes through supervised durable execution.

**Gate:** `gate:0.3`, Ola differential fixtures. See [`phase-0-spec.md`](./phase-0-spec.md) §0.3.

### 0.4 — Reasoning semantic engine

Ouroboros remains the behavioral oracle. The graph, critic, branching,
reducer, diagnostics, and verification port remains sound.

The refresh is mostly about its public boundary. Reasoning should be an
owned semantic engine:

```text
proposal / evidence
       ↓
Reasoning engine
       ↓
validated domain transition
       ↓
canonical reasoning.* event
```

Not: Agent directly edits reasoning tables.

ZCode's persistent goal model is a useful secondary reference (objective
continuity, verification state, budget/accounting boundaries, cross-session
continuation). Do not mechanically import its goal/workflow model.

A key contract question to settle during 0.4: does objective identity
deserve a stronger durable abstraction than `reasoning node kind = objective`?
Only promote it if the port/integration evidence requires it.

**Gate:** `gate:0.4`, Ouroboros differential families. See [`phase-0-spec.md`](./phase-0-spec.md) §0.4.

### 0.5 — Host runtime + durable cognition integration

This is where the roadmap changes most. The old framing was "cognition
extension + coordinator." The refreshed framing is: establish the Host
control plane and prove that cognition operates through it without
becoming it.

The Host owns the authoritative mechanics:

- Session Manager
- Agent Supervisor
- Execution Contract Manager
- Input Admission
- Permission / Policy
- Capability Broker
- Workspace Manager
- Scheduler Dispatcher
- Durable Store

These are logical components, not necessarily separate processes or packages
initially.

Cognition owns semantics (orientation, recall policy, verification policy,
evidence interpretation, reasoning updates, reinforcement decisions,
consolidation policy, completion assessment evidence). It does not own OS
process lifecycle, workspace authority, operation persistence, permissions,
scheduler claims, terminal/browser processes, or the final lifecycle
transition.

**Agent Protocol starts here.** The first explicit Host ↔ Agent semantic
boundary: hello/capabilities, session.open, session.resume, input.admitted,
context.provide, capability.request, capability.result, criterion.evidence,
agent.idle, agent.error, cancel, shutdown. The exact encoding stays unfrozen.

**Transactional scheduler starts here** — only the amount needed for
supervised cognition work, consolidation, recoverable background tasks,
claim/run identity, and retry eligibility. Do not build the full automation
product here.

**Closure authority.** The Agent/verifier produces criterion evidence; the
Host evaluates the frozen contract and performs the ACTIVE → COMPLETE
transition. The Host owns the lifecycle transition; it does not invent
semantic evidence.

**0.5 exit proof.** Keep the existing continuity goal (kill → reopen →
resume → orient → act) but now explicitly prove that Agent
replacement/restart does not invalidate Host-owned execution identity or
durable state.

**Gate:** `gate:0.5`. See [`phase-0-spec.md`](./phase-0-spec.md) §0.5.

### 0.6 — Durable verbatim context delivery

Rebuild pi-equivalent model context from the transcript projection. This
phase establishes that context compilation belongs to the Host/control
boundary:

```text
Durable State
      ↓
Context Compiler
      ↓
Host
      ↓ Agent Protocol
      ↓
Agent/model
```

Rather than the agent reconstructing canonical state for itself. This makes
the Agent replaceable because the Host can reconstruct what the new Agent
needs after restart.

ZCode's compaction/resume semantics are a useful secondary reference; pi
remains the parity oracle for verbatim behavior.

**Gate:** `gate:0.6`. See [`phase-0-spec.md`](./phase-0-spec.md) §0.6.

### 0.7 — Graph context compiler

Graph-distilled context, required inclusions, projection receipts, fail-safe
fallback, preregistered evaluation, and the graph remains non-default until
measured.

The architectural refinement: context compilation belongs to the Host/control
boundary. Both verbatim and graph are Host-selected context strategies. That
makes A/B tests cleaner because the same Agent can be tested against
alternative context projections.

**Gate:** `gate:0.7`. See [`phase-0-spec.md`](./phase-0-spec.md) §0.7.

### 0.8 — Application Protocol + React experience

The transport contract must be defined before UI build. The frontend
consumes ordered application events rather than reading the DB. This
becomes the Application Protocol.

Formalize `START_NOW`, `GUIDE`, `QUEUE` as distinct admission semantics.
Every admitted user input gets durable identity/state (input_id, session_id,
sequence, requested_mode, admitted_mode, submitted_at, admitted_at,
dispatch_state, source).

This phase also formalizes reconnect/resume/subscription semantics. ZCode is
an important reference here.

**Gate:** `gate:0.8`. See [`phase-0-spec.md`](./phase-0-spec.md) §0.8.

### 0.9 — External adapters

Integration scope: user hooks, MCP, ACP, code intelligence. Treat all of
them as adapters onto the Host. The invariant stays: integration ≠ state
owner. Do not force SSH/WSL/Docker into the gate unless an actual product
requirement activates them.

**Gate:** `gate:0.9`. See [`phase-0-spec.md`](./phase-0-spec.md) §0.9.

---

## Workspace abstraction — cross-cutting, implementation deferred

The Workspace contract should be designed incrementally while capabilities
are extracted:

```text
Workspace
├── identity
├── filesystem
├── terminal
├── git
├── metadata
└── capability availability
```

Initially `LocalWorkspace`. Later: SSHWorkspace, WSLWorkspace,
DockerWorkspace, RemoteServerWorkspace.

Freeze: `workspace identity ≠ transport ≠ location`. Do not require multiple
remote implementations during Phase 0. The backlog already defers several
environment/isolation identities (including `worktree_id`) until their
triggers exist.

---

## Bounded checkpoint before 0.3/0.4 implementation

Not a new phase. Not a new gate. Before large semantic ports begin, freeze
only the owned boundaries:

- Host ↔ Agent
- Host ↔ Capability
- Host ↔ Workspace
- Host ↔ Memory engine
- Host ↔ Reasoning engine

Do not freeze these until their phases actually need them:

- Wire encoding
- Remote transport
- Scheduler automation schema
- Subagent protocol
- Browser protocol
- Full workflow model

This gives enough architectural discipline to avoid importing
Ola/Ouroboros/ZCode internals into the wrong layers without creating
speculative infrastructure.

---

## Deliberately deferred

Do not promote attractive ZCode capabilities merely because they exist. Keep
deferred unless activated by an existing phase:

- Full workflow product
- Recurring automation UI
- Subagent worktree isolation
- Dynamic extension loading
- Vector memory retrieval
- Auto-skill minting
- Full graph visualization
- Multi-agent kanban
- Multi-writer durable store
- Remote workspace backends

The existing backlog already follows this trigger-based philosophy.

---

## Document roles

- **This file** (`docs/roadmap.md`): architecture orientation and sequencing.
- [`docs/phase-0-spec.md`](./phase-0-spec.md): executable specification with
  authoritative gate definitions.
- [`docs/constitution.md`](./constitution.md): the 10 frozen principles.
- [`docs/rules.md`](./rules.md): hard rules.
- [`docs/backlog.md`](./backlog.md): trigger-based deferred work.
