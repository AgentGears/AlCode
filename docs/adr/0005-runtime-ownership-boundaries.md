# ADR 0005 — Runtime Ownership Boundaries

Status: **accepted** (Phase 0.1B).
Freezes five ownership boundaries before semantic engines (0.3/0.4) and the
Host control plane (0.5) are built. Does not define wire encoding, remote
transport, scheduler schema, subagent protocol, browser protocol, or workflow
model — those remain unfrozen until their phases need them.

## Context

Phase 0.2 proved the durable event/recovery spine. The refreshed roadmap
(`docs/roadmap.md`) defines a north star in which the Host owns execution
policy and canonical state, supervises replaceable agents, mediates
environmental capabilities, and schedules durable work.

Before large semantic ports (Ola memory, Ouroboros reasoning) begin, the
ownership boundaries must be unambiguous enough that tool, provider, memory,
and reasoning code can be assigned to the correct side. Without frozen
boundaries, Ola/Ouroboros internals risk being imported into the wrong layer.

## Decision — five boundaries

For each boundary, five facts are frozen: **authority owner**, **requester**,
**validator**, **semantic request/result crossing the boundary**, and
**things forbidden from crossing the boundary**.

### 1. Host ↔ Agent

```text
authority owner:  Host
requester:        Agent
validator:        Host (permission/policy)
crossing:         tool/capability request → capability result;
                  criterion evidence → completion decision
forbidden:        Agent directly owns OS process lifecycle, workspace
                  authority, operation persistence, permissions, scheduler
                  claims, terminal/browser processes, or the final lifecycle
                  transition
```

The Agent proposes actions and produces evidence. The Host authorizes,
persists, mediates, and performs lifecycle transitions. The Agent is
replaceable — its restart does not invalidate Host-owned execution identity
or durable state.

### 2. Host ↔ Capability

```text
authority owner:  Host (via capability broker)
requester:        Host (on behalf of Agent proposal)
validator:        Host (permission/policy)
crossing:         typed capability request (read/write/execute/git/etc.)
                  → typed capability result (content, exit code, side-effect
                  metadata)
forbidden:        Capability directly appends events, mutates projection
                  cursors, acquires the OS lock, or bypasses permission
                  checks
```

Capabilities execute environmental actions. The Host owns the durable
operation lifecycle around each capability invocation. In Phase 0.1B, the
Host-side adapter and the capability implementation may live in the same
process; the boundary is a contract, not necessarily a process boundary.

The Agent sees capabilities through `AgentTool` adapters. The adapter
translates the model-facing tool call into a capability request. The
capability implementation performs the environmental action. The adapter
normalizes the result back into `AgentToolResult`.

```text
AgentTool adapter
       │
       ▼
Capability contract
       │
       ▼
Host-owned implementation (LocalWorkspace filesystem/terminal)
```

### 3. Host ↔ Workspace

```text
authority owner:  Host (via workspace manager)
requester:        Host (at session start, for workspace resolution)
validator:        Host (identity verification, lock acquisition)
crossing:         workspace identity + capability availability →
                  resolved workspace handle (filesystem root, terminal cwd,
                  git context, metadata)
forbidden:        Workspace implementation directly owns event log, agent
                  process, or reasoning state
```

A Workspace bundles identity, filesystem, terminal, git, and metadata.
Workspace identity is stable across transports: `identity ≠ transport ≠
location`. Phase 0.1B implements `LocalWorkspace` only. SSH, WSL, Docker,
and remote-server backends are deferred.

### 4. Host ↔ Memory engine

```text
authority owner:  Host (owns canonical memory.* events and the durable
                  store)
requester:        Agent (via recall/remember tool calls) or Host (via
                  scheduler dispatch for consolidation)
validator:        Host (permission/policy; durable event admission)
crossing:         recall query → retrieved memory records;
                  memory semantic transition → canonical memory.* event
forbidden:        Memory engine directly owns OS process lifecycle, workspace
                  authority, operation persistence for non-memory operations,
                  or reasoning graph state
```

The Memory engine owns semantics (scoring, strength/decay, retrieval policy,
reinforcement, consolidation policy). It does not own the event log, the
workspace, or the agent process. Memory transitions go through canonical
events to derived projections. No detached extraction worker — any future
extraction/consolidation goes through supervised durable execution.

### 5. Host ↔ Reasoning engine

```text
authority owner:  Host (owns canonical reasoning.* events and the durable
                  store)
requester:        Agent (via commit_hypothesis/record_decision/etc.) or
                  Host (via verification dispatch)
validator:        Host (permission/policy; durable event admission)
crossing:         proposal/evidence → validated domain transition →
                  canonical reasoning.* event;
                  orientation request → reasoning graph state
forbidden:        Reasoning engine directly owns OS process lifecycle,
                  workspace authority, operation persistence for non-reasoning
                  operations, or memory store
```

The Reasoning engine owns semantics (graph, critic, branching, reducer,
diagnostics, verification). It does not own the event log, the workspace, or
the agent process. Reasoning transitions go through canonical events to
derived projections.

## What is deliberately NOT frozen

These remain unfrozen until their phases need them:

- Wire encoding (JSON, protobuf, capnp — the contracts above are semantic,
  not wire-level)
- Remote transport (IPC, TCP, Unix socket)
- Scheduler automation schema (claim/run identity, retry eligibility details)
- Subagent protocol
- Browser protocol
- Full workflow model
- Multi-agent coordination

## Consequences

- Tool, provider, memory, and reasoning code can be assigned to the correct
  side of a boundary before it is written.
- The Agent remains replaceable: the Host reconstructs what a new Agent needs
  from canonical state, not from the old Agent's in-memory model.
- Phase 0.1B can extract capabilities incrementally without creating a Host
  process split. The boundaries are contracts first, process boundaries
  later.
- No speculative infrastructure is created for unfrozen concerns.
