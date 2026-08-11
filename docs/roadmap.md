# ALCODE Roadmap — Architecture Orientation

Status: **active; Phases 0.0 through 0.6 closed**. Phase 0.6 closed in merge
commit `98c764c` with `gate:0.6` green. Phase 0.7 is the next roadmap unit; its
plan is currently **DRAFT / NOT AUTHORIZED**. This document orients the
architecture and sequencing; the executable specification with authoritative
gate definitions lives in [`phase-0-spec.md`](./phase-0-spec.md).

## North star

ALCODE is a durable Host runtime that supervises replaceable reasoning agents,
mediates environmental capabilities, owns execution policy and canonical state,
schedules bounded durable work, and exposes a consistent workspace contract
across execution environments.

The governing ownership model is implemented through Phase 0.6:

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
│ transcript/context authority       │
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
              │          │            │
              ▼          ▼            ▼
          transcript   memory      reasoning
              │        engine       engine
              └──────────┬────────────┘
                         ▼
                Host context strategy
                verbatim-v1 (closed)
                graph-v1 (draft 0.7)
```

The load-bearing architectural shift is complete: durable execution and
canonical state are Host authority; the Agent is a replaceable reasoning
process. Memory and reasoning are semantic engines behind Host-owned admission,
not independent state-owning runtimes. Phase 0.6 additionally proves that model
conversation continuity is reconstructable from canonical events rather than
old Agent process memory. ADR 0005 continues to govern ownership.

---

## Current position

```text
0.0   Architecture foundation                 CLOSED
0.1A  Minimal owned agent                     CLOSED
0.1B  Capability/provider layer               CLOSED
0.2   Durable event/recovery spine            CLOSED
0.3   Memory semantic engine                  CLOSED
0.4   Reasoning semantic engine               CLOSED
0.5   Host + cognition integration            CLOSED
0.6   Durable verbatim context reconstruction CLOSED
                                                 │
                                                 ▼
0.7   Graph-distilled context strategy         DRAFT — NOT AUTHORIZED
                                                 │
                              ┌──────────────────┴──────────────────┐
                              ▼                                     ▼
0.8   Application protocol + React UI          PLANNED     0.9 External adapters PLANNED
```

The completed foundation must not be reopened absent concrete defect evidence.
A draft successor plan does not start the phase; it must be reviewed, frozen,
and explicitly authorized before implementation.

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

The signature proof is executable:

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

### 0.6 — Durable verbatim context reconstruction — CLOSED

Established the safe provider-visible context baseline from canonical durable
state. The completed surfaces include:

- `@alcode/transcript` with rich user/assistant/tool-result semantics,
  deterministic reduction, completeness/fidelity classification, and semantic
  transition validation;
- serialized Host transcript admission with durable `transcript.admitted` ACK;
- the invariant `no transcript ACK ⇒ no next model request`;
- end-to-end provider `toolCallId` identity through Host capability execution
  and the corresponding tool result;
- stable-head `TranscriptSnapshot` reconstruction and Host-owned
  `verbatim-v1` compilation;
- explicit `complete | incomplete` and `exact | legacy_text_only` state;
- fail-closed orphaned-tool-call continuation without replay or fabricated
  results;
- replacement Agent hydration from Host-provided durable history;
- pinned pi `convertToLlm` parity for the shared text/tool vocabulary;
- transcript projection rebuild and Host+Agent close/reopen continuity proof.

The signature proof is executable:

```text
canonical rich conversation + tool result
→ destroy Agent A and Host A
→ reopen Host B
→ reconstruct verbatim-v1 from canonical events
→ hydrate empty Agent B
→ next ModelRequest contains the same durable prefix
→ continue
```

Schema remains v7. Graph selection, memory/reasoning injection, compaction,
provider-specific transforms, and 0.8 dispatch policy were not pulled into the
phase.

**Gate:** `gate:0.6`, composing `gate:0.5`. Frozen/completed plan:
[`phase-0.6-plan.md`](./phase-0.6-plan.md).

**Closure:** PR #12 source head `303a0c4` merged as `98c764c`; post-merge CI run
`31542403984` completed successfully.

---

## Next roadmap unit

### 0.7 — Graph-distilled context strategy — DRAFT / NOT AUTHORIZED

The next architectural problem is selective context. Phase 0.6 answers
"what did the model previously see?"; Phase 0.7 is intended to answer
"what should the model see for this new task?" without moving context authority
into the Agent.

The current draft proposes:

```text
one stable canonical source cut
        +
bounded Host-observed workspace snapshot
        +
current canonical user request
        ↓
Host-owned graph-v1 compiler
        ↓
required facts + deterministic optional selection
        ↓
canonical projection receipt
        ↓
Agent Protocol context update
        ↓
disposable replacement Agent context
```

`verbatim-v1` remains both the safety fallback and product default. The draft
uses existing reasoning semantics and the closed memory ranking function; merely
selecting a memory for context must not reinforce it. Required state is never
silently dropped to meet a graph budget: if it cannot fit safely, graph mode
falls back to verbatim.

The draft also proposes a canonical `context.projection_compiled` receipt,
summary materialization into the existing `projection_receipts` table, and a
pre-registered A/B harness. Phase 0.7 closure would not promote graph mode to
default; default promotion remains a separate evidence-based decision.

See [`phase-0.7-plan.md`](./phase-0.7-plan.md). The document is **not frozen** and
implementation is **not authorized**.

---

## Later roadmap

### 0.8 — Application Protocol + React experience

Define the application transport contract before the UI, then build the React
experience as a client of ordered Host events. This phase also owns the
product-level `START_NOW`, `GUIDE`, and `QUEUE` admission semantics rather than
smuggling them into the Agent Protocol/context compiler.

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
them. They are not Phase 0.7 prerequisites.

The Phase 0.7 draft proposes only a bounded, read-only Host workspace-context
snapshot port; it does not promote a remote workspace backend or give the
context compiler arbitrary filesystem/terminal authority.

---

## Ownership checkpoint — completed

ADR 0005 freezes:

- Host ↔ Agent
- Host ↔ Capability
- Host ↔ Workspace
- Host ↔ Memory engine
- Host ↔ Reasoning engine

Phase 0.5 exercised those boundaries in production code and gates; Phase 0.6
extended the same ownership model to durable transcript/context reconstruction.
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

- making graph context the product default before measured promotion;
- LLM summarization/compaction;
- provider-specific context transforms/tokenizers;
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
- [`docs/phase-0.6-plan.md`](./phase-0.6-plan.md): completed frozen 0.6 contract
  and closure evidence.
- [`docs/phase-0.7-plan.md`](./phase-0.7-plan.md): current **draft** successor
  plan; not frozen and not authorized.
- [`docs/constitution.md`](./constitution.md): the 10 frozen principles.
- [`docs/rules.md`](./rules.md): hard rules.
- [`docs/backlog.md`](./backlog.md): trigger-based deferred work.
