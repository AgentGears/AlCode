# ALCODE — Phase 0 Specification (executable)

Status: **active; Phases 0.0, 0.1A, 0.1B, 0.2, 0.3, 0.4, and 0.5 closed**.
Phase 0.5 closed in merge commit `9b06f4a` with `pnpm gate:0.5` green. Phase
0.6 is the next roadmap unit and has **not started**. See `docs/roadmap.md` for
architecture orientation.

This is the executable build order. Each phase has an objective, scope,
explicit exclusions, required evidence, and an **executable exit gate**
(`pnpm gate:X.Y`). A phase is complete when its frozen gate emits
`status: "passed"`; documentation does not substitute for executable evidence.
Closed-phase sections below record the as-built contract rather than reopening
their implementation plans.

References:
- Constitution (10 principles, frozen): `docs/constitution.md`
- Architecture orientation: `docs/roadmap.md`
- Hard rules: `docs/rules.md`
- Event contract (envelope, producer, identity, versioning): `docs/event-contract.md`
- Runtime ownership boundaries: `docs/adr/0005-runtime-ownership-boundaries.md`
- Phase 0.5 frozen/completed plan: `docs/phase-0.5-plan.md`
- Non-goals: `docs/non-goals.md`
- Backlog: `docs/backlog.md`

Naming: project codename `ALCODE`. Rename freely later.

## Gate receipt schema

Every `pnpm gate:X.Y` emits a `GateReceipt` JSON to stdout and to
`~/.alcode/gate-receipts/<gate>-<commitSha>-<ts>.json`:

```ts
interface GateReceipt {
  gate: string;
  status: "passed" | "failed";
  commitSha: string;
  startedAt: string;
  completedAt: string;
  runtimeVersion: string;
  packageManagerVersion: string;
  inputs: Array<{ name: string; digest?: string }>;
  checks: Array<{
    id: string;
    status: "passed" | "failed" | "skipped";
    evidence?: string;
  }>;
}
```

A phase is **not** passed by reading documents; it is passed when its gate
command emits `status: "passed"`.

---

## Current workspace layout

```text
alcode/
├── packages/
│   ├── agent-core/        ← owned minimal Agent loop (0.1A)
│   ├── agent-protocol/    ← Host ↔ Agent semantic protocol + local IPC (0.5)
│   ├── ai/                ← provider adapters (0.1B)
│   ├── coding-agent/      ← app layer, tools, capabilities, worker/CLI seams
│   ├── cognition-runtime/ ← orientation/recall/verification/completion policy (0.5)
│   ├── events/            ← canonical event envelope/contracts
│   ├── host-runtime/      ← Host control plane (0.5)
│   ├── memory/            ← Ola-derived memory semantics (0.3)
│   ├── reasoning/         ← Ouroboros-derived reasoning semantics (0.4)
│   ├── secrets/           ← pre-persistence secret admission/redaction
│   ├── storage/           ← locked event store + projections/read models
│   ├── test-provider/     ← deterministic offline provider
│   └── workspace/         ← repository/workspace identity + ownership
├── extensions/
│   └── cognition/         ← thin Agent-side protocol adapter (0.5)
├── docs/
├── scripts/gate/
└── .github/workflows/ci.yml
```

`packages/web` is planned for 0.8; it does not exist yet.

### Ownership/dependency direction

The architectural direction is authority-based rather than a single linear
package chain:

```text
coding-agent
  ├─ agent-core
  ├─ agent-protocol
  ├─ cognition-extension
  └─ Host bootstrap/adapters

cognition-extension
  ├─ agent-core
  └─ agent-protocol

host-runtime
  ├─ agent-protocol
  ├─ cognition-runtime
  ├─ storage
  ├─ memory
  ├─ reasoning
  └─ events

cognition-runtime
  ├─ memory
  └─ reasoning
```

The Agent worker and cognition extension do not own storage, workspace locks,
canonical admission, environmental process lifecycle, or final completion.
Memory and reasoning remain semantic engines; Host/storage own canonical state
and persistence. See ADR 0005.

## Storage layout

```text
~/.alcode/  (or $ALCODE_HOME for tests)
├── registry.sqlite
├── gate-receipts/
└── workspaces/<workspace_id>/
    ├── workspace.lock
    └── workspace.sqlite
        ├── events
        ├── projection_cursors
        ├── sessions
        ├── operations
        ├── reasoning_nodes
        ├── reasoning_edges
        ├── memories
        ├── memory_stats
        ├── artifacts
        ├── projection_receipts
        └── schema_migrations
```

The event log is canonical. Projection cursors never advance beyond the event
head; derived projections are rebuildable. Workspace ownership is one writer
through the process-held OS lock. Possibly-mutating interrupted operations use
the explicit Phase 0.2 uncertainty/reconciliation state machine and are not
automatically retried.

---

## Phase 0.0 — Architecture foundation — CLOSED

**Objective:** establish the executable workspace, event-envelope scaffold,
gate harness, licensing, initial CI, and the architectural decisions required
before durable state.

**As built:** workspace/package structure; `@alcode/events`; deterministic test
provider; gate receipt machinery; ADRs 0001–0004; threat model; operation
recovery documentation; licensing/notices; configurable `ALCODE_HOME` for tests.

**Explicit exclusions retained:** domain semantic engines, multi-agent identity,
distributed runtime, final GUI transport, and later integration mechanisms.

**Exit gate:** `pnpm gate:0.0` emits `status: "passed"`.

**Status:** CLOSED.

---

## Phase 0.1A — Minimal owned agent — CLOSED

**Objective:** prove acquisition and ownership conversion of a thin pi agent
loop without importing pi's TUI/server/storage/dynamic-loader architecture.

**As built:** owned `@alcode/agent-core`; narrow `ModelProvider` and
`AgentTool` contracts; deterministic offline provider; owned
`StaticExtensionHost`; fresh headless `bash`; provenance checks; offline
`alcode -p "hello"` integration path.

**Explicit exclusions retained:** pi TUI/server/storage, dynamic extension
loader/runner, live providers and remaining coding tools (0.1B).

**Exit gate:** `pnpm gate:0.1A` emits `status: "passed"` while composing 0.0.

**Status:** CLOSED.

---

## Phase 0.2 — Durable event/recovery spine — CLOSED

**Objective:** prove the event-log-as-truth architecture end-to-end before the
full memory/reasoning semantic ports.

**As built:**

- monotonic/idempotent canonical event append;
- one locked SQLite database per workspace;
- projection cursors and replay/catch-up;
- durable runtime/session and operation events;
- operations state machine with explicit uncertain-effect recovery;
- minimal transcript/reasoning/memory projections;
- workspace/repository identity and single-writer ownership;
- pre-persistence secret redaction/admission;
- replay/rebuild and close/reopen invariants.

**Required invariant:** an indeterminate/pending possibly-mutating operation is
never automatically retried.

**Exit gate:** `pnpm gate:0.2` emits `status: "passed"` while composing the
closed foundation gates.

**Status:** CLOSED.

---

## Phase 0.1B — Capability/provider layer — CLOSED

**Objective:** complete the coding capability foundation, live provider layer,
reproducible pi acquisition, and tri-platform execution evidence.

**As built:**

- owned read/write/edit/grep/ls/find tools and existing bash path;
- `Workspace`, filesystem, and terminal capability contracts with
  `LocalWorkspace` implementation;
- deterministic pi import/verification manifest;
- owned provider package including Anthropic live integration;
- opt-in live-provider smoke test;
- pinned Node/TypeScript/pnpm toolchain;
- Ubuntu, macOS, and Windows `gate:0.1B` CI;
- ADR 0005 runtime ownership boundaries.

**Exit gate:** `pnpm gate:0.1B` emits `status: "passed"` on the tri-platform
matrix while composing 0.1A.

**Status:** CLOSED.

---

## Phase 0.3 — Memory semantic engine (Ola port) — CLOSED

**Objective:** own Ola-equivalent memory semantics in TypeScript behind the
Host-owned durability boundary.

**As built:**

- typed/Zod lesson and playbook records;
- stable `memory_id = "<type>/<slug>.md"` identity;
- lexical retrieval and exact-match override;
- scoring `0.65·relevance + 0.20·structural + 0.15·strength`;
- Ebbinghaus strength/decay and every-fifth-use consolidation boundary;
- `recordSeen` versus `recordUse` reinforcement doctrine;
- lifecycle transitions and mutable sidecar statistics;
- authoritative provenance and deterministic `stored_at`;
- active-only fail-closed ranking;
- memory projection v2 / schema v6 rebuild and migration behavior;
- checked-in Ola differential fixtures.

The memory package does **not** own SQLite, canonical event admission, detached
workers, transcript extraction, or environmental execution.

**Exit gate:** `pnpm gate:0.3` emits `status: "passed"` while composing 0.2.

**Status:** CLOSED.

---

## Phase 0.4 — Reasoning semantic engine (Ouroboros port) — CLOSED

**Objective:** own the source-faithful Ouroboros reasoning semantic core in
TypeScript without importing the runtime that happened to host it.

**Authority reconciliation:** ADR 0005 governs. Ouroboros `session_store`,
MCP/runtime adapters, environmental execution, scheduler/governance authority,
context compilation, and cognition orchestration are explicitly outside
`@alcode/reasoning`. See `docs/phase-0.4-exclusion-rationale.md`.

**As built:**

- complete 23 `NodeKind` / 18 `EdgeKind` vocabulary for compatibility;
- canonical cognitive graph validation plus legacy single-GOAL validator;
- nine cognitive operations returning pre-persistence transition intents;
- symbolic intra-batch references for atomic investigation opening;
- deterministic reducer IDs derived from session/sequence/event semantics;
- source-faithful critic, rule-based branching/grafting, diagnostics, and
  verification matching/evaluation;
- append-only falsifier evaluation and satisfied-falsifier contradiction
  semantics;
- canonical dotted reasoning-domain event contracts;
- schema v7 + reasoning projection v2 with reasoning edges and rebuild;
- real Python-generated Ouroboros golden evidence and exporter provenance;
- v6→v7 migration, projection v1→v2 replay, delete/rebuild, and close/reopen
  integration proofs.

Random generic Ouroboros IDs never become canonical ALCODE state. The Host
owns persistence and canonical event admission.

**Exit gate:** `pnpm gate:0.4` emits `status: "passed"` while composing 0.3 and
running the frozen Ouroboros fixture families.

**Closure:** PR #6 merged as `4c82c8c`.

**Status:** CLOSED.

---

## Phase 0.5 — Host runtime + durable cognition integration — CLOSED

**Objective:** establish a Host-owned control plane that supervises a
replaceable Agent behind an explicit protocol boundary and binds the closed
memory/reasoning engines to durable capability execution.

The frozen implementation contract is recorded in
`docs/phase-0.5-plan.md`.

**As built:**

- `@alcode/agent-protocol` with explicit Host ↔ Agent semantic messages and
  local Node child-process IPC;
- `@alcode/host-runtime` with canonical admission queue, Host session manager,
  Agent supervisor, capability policy/broker, cognition gateway, bounded
  durable-work dispatcher, and Host completion authority;
- `@alcode/cognition-runtime` with orientation, recall, verification/evidence,
  reinforcement/consolidation, and completion-assessment policy;
- thin `@alcode/cognition-extension`, importing Agent core/protocol rather than
  storage/workspace/memory/reasoning authority;
- bounded storage read-model facade without exposing the SQLite handle;
- Host-resolved Phase 0.4 symbolic reasoning batches;
- additive reasoning integration events `action.recorded`, `evidence.recorded`,
  and `verification.result.correlated`;
- Host policy and pre-execution durability barrier;
- duplicate Agent request delivery idempotence per generation;
- bounded event-sourced `memory.consolidation` work with retry-safe semantic
  idempotency;
- Host-only final `runtime.session.stopped` authority.

**Signature proof:**

```text
Host opens session S
→ Agent A creates durable cognition / requests Host capability
→ kill Agent A while Host-owned work is in flight
→ Host durably completes the same operation
→ Agent B attaches to the same session S
→ session.resume
→ orient from the same durable reasoning/memory/operation state
→ continue acting
```

Agent replacement does not stop the session, lose operation identity, lose
memory/reasoning state, or repeat the environmental mutation. Host restart
after a possibly-mutating interrupted operation applies Phase 0.2 uncertainty
recovery and performs no automatic retry.

**Explicit exclusions:** durable transcript→provider context reconstruction
(0.6); graph-distilled context strategy (0.7); token budgeting/compaction;
application/UI protocol and START_NOW/GUIDE/QUEUE semantics (0.8); hooks,
MCP, ACP (0.9); remote Agent transport/public wire encoding; browser subsystem;
remote workspace backends; subagents/multi-agent identity; task/workflow engine;
general scheduler/recurring automation; distributed claims; automatic
transcript→memory extraction; Ola offload/rehydration; learned/RL cognition
policy; provider redesign.

**Exit gate:** `pnpm gate:0.5` composes `gate:0.4` and emits `status: "passed"`
only when the frozen reasoning/memory/verification roundtrips, permission and
pre-execution visibility barrier, Agent replacement continuity, Host recovery,
durable-work recovery/exactly-once semantic effect, duplicate delivery,
completion authority, and ownership-boundary proofs pass.

**Closure:** PR #7 source head
`82aac97ceb74f0ae6151f27ab352d20c5b2e053d` merged as
`9b06f4ace2921db599d5bbecce1bd21c73748d39`; CI run `31522355607` completed
successfully.

**Status:** CLOSED.

---

## Phase 0.6 — Durable verbatim context reconstruction — NOT STARTED

**Objective:** establish the safe model-context baseline: reconstruct the
provider-facing conversation from canonical durable transcript/events so a
replacement Host/Agent does not depend on an earlier process's in-memory
message history.

**Inputs:** 0.1A/pi native conversion behavior as parity oracle; 0.2 durable
transcript/event state; 0.5 Host/Agent protocol and replaceable runtime.

**Implementation scope:**
- Implement the verbatim projection equivalent of pi `convertToLlm`:
  `messages + tool calls + tool results → provider-compatible context`, sourced
  from durable canonical state / transcript projection.
- Preserve deterministic ordering, roles, content, tool-call/result pairing,
  and provider-visible semantics across close/reopen and Agent replacement.
- Keep the reconstruction behind the Host/control boundary; the Agent does not
  become the canonical transcript owner.

**Explicit exclusions:** graph-distilled selection, graph receipts, semantic
compression, and graph-default decisions (0.7).

**Deliverables:** verbatim context compiler/reconstructor and the baseline
`verbatim` projection strategy.

**Required tests:** parity corpus against pi's native conversion plus durable
restart/replacement reconstruction evidence. The same canonical history must
produce the same provider-visible message sequence independent of the prior
Agent process.

**Exit gate:** `pnpm gate:0.6` emits `status: "passed"` (token-identical where
possible, otherwise behaviorally equivalent under the frozen parity corpus;
durable reconstruction/restart proof passes).

**Failure/rollback rule:** verbatim is the safety fallback for 0.7 and must be
correct before the graph strategy can ship.

**Dependencies:** 0.5.

**Status:** NOT STARTED; implementation requires a separately frozen plan and
explicit authorization.

---

## Phase 0.7 — Graph context compiler and experiment framework

**Objective:** Projection B (graph-distilled) as a measured experiment with
receipts and fail-safe fallback. **Not default until it wins on pre-registered
objective evaluation.**

**Inputs:** 0.4 reasoning projection; 0.3 memory projection; 0.6 verbatim fallback.

**Implementation scope:**
- Formal context compiler, not a loose filter.
- **Mandatory inclusions:** current user request, active objective,
  system/safety constraints, current worktree/repo state, unresolved tool
  failures, pending permission state, active hypotheses, decisive evidence,
  known contradictions, latest relevant tool outputs, relevant durable
  memories, active verification obligations.
- **Selection factors:** relevance, recency, confidence, evidence quality,
  contradiction status, token cost, task scope, provenance.
- **Projection receipt** recorded as a `context.projection_compiled` event
  (mode, compiler version, source event sequence, receipt digest, token budget,
  fallback status) plus an inspectable full receipt.
- **Fail-safe → verbatim** when reasoning/context prerequisites are invalid or
  incomplete.
- Pre-register evaluation metrics before collecting A/B results.

**Explicit exclusions:** making graph the default before measured promotion.

**Deliverables:** graph compiler, receipt machinery, A/B harness, and the
pre-registered evaluation protocol.

**Required tests:** every fail-safe condition falls back to verbatim; receipts
are complete/accurate; A/B metrics are captured.

**Exit gate:** `pnpm gate:0.7` emits `status: "passed"` with graph as a toggle,
receipts inspectable, fallback proven, and the preregistered protocol present.
Default remains verbatim until graph measurably wins.

**Dependencies:** 0.5, 0.6.

---

## Phase 0.8 — Application Protocol + React GUI

**Objective:** streaming React experience over a stable Host-owned application
transport.

**Inputs:** open-harness `ui-stream.ts` + React provider (MIT); qwen web UI
patterns (reference only); stable 0.5 runtime contracts.

**Implementation scope:**
- Define the application transport contract before UI build: ordered event
  sequence, reconnect/resume cursor, cancellation, duplicate handling, tool
  progress, permissions, and terminal completion.
- Build UI primitives: transcript, reasoning stream, tool cards, permission
  prompts, diffs, cancellation, session switching, resumability, diagnostics,
  memory/reasoning inspectors, and projection mode/receipt view.
- Formalize `START_NOW`, `GUIDE`, and `QUEUE` as distinct input-admission
  semantics at the application/Host boundary.
- Frontend consumes ordered application events; it never reads the durable DB
  as an authority source.

**Explicit exclusions:** full graph visualization; multi-agent kanban.

**Required tests:** transport reconnect/resume/duplicate-event behavior plus
rendering tests for each primitive.

**Exit gate:** `pnpm gate:0.8` emits `status: "passed"` with a streaming React
client driving the same Host runtime and resumability observable.

**Failure/rollback rule:** UI remains a client of the runtime; no domain logic
moves into the frontend.

**Dependencies:** stable Host/runtime contracts; context strategies as required
by the product surface.

---

## Phase 0.9 — External integrations

**Objective:** hooks, MCP, ACP, and code intelligence as adapters over the owned
Host/runtime, never authoritative state owners.

**Implementation scope (independently shippable):**
- user-facing hooks with command/HTTP configuration and SSRF guards;
- MCP client; optional MCP server mode;
- ACP adapter against the same Host runtime used by GUI/CLI;
- `CodeIntelligence` interface with a workspace-scoped, commit-aware,
  invalidation-aware, cancellable first implementation.

**Explicit exclusions:** making any external integration mandatory for v1 or
allowing an adapter to own canonical state.

**Exit gate:** `pnpm gate:0.9` emits `status: "passed"` when enabled integrations
work against the Host without violating the security/ownership model.

---

## Migration (post-0.5, when worth doing)

Ola/Ouroboros repositories remain behavioral references. Any future migration
uses explicit export/import contracts with count/ID/digest/graph/provenance
validation and a migration receipt. **Never point the new runtime at old live
databases.**

---

## Phase 0 status summary

```text
0.0   Architecture foundation                 CLOSED
0.1A  Minimal owned agent                     CLOSED
0.1B  Capability/provider layer               CLOSED
0.2   Durable event/recovery spine            CLOSED
0.3   Memory semantic engine                  CLOSED
0.4   Reasoning semantic engine               CLOSED
0.5   Host + cognition integration            CLOSED
0.6   Durable verbatim context reconstruction NEXT — NOT STARTED
0.7   Graph context compiler + experiment     PLANNED
0.8   Application Protocol + React GUI        PLANNED
0.9   External integrations                   PLANNED
```

Historical calendar estimates are planning context only. Executable gates and
frozen acceptance criteria drive sequencing and closure.
