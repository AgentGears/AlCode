# ALCODE — Phase 0 Specification (executable)

Status: **active; Phases 0.0, 0.1A, 0.1B, 0.2, 0.3, 0.4, 0.5, and 0.6 closed**.
Phase 0.6 closed in merge commit `98c764c` with `pnpm gate:0.6` green. Phase
0.7 is the next roadmap unit; its reviewed design is **FROZEN / NOT STARTED /
NOT AUTHORIZED**. See `docs/roadmap.md` for architecture orientation.

This is the executable build order. Each implemented phase has an objective,
scope, explicit exclusions, required evidence, and an **executable exit gate**
(`pnpm gate:X.Y`). A phase is complete when its frozen gate emits
`status: "passed"`; documentation does not substitute for executable evidence.
Closed-phase sections below record the as-built contract rather than reopening
their implementation plans. A frozen successor design defines acceptance but
does not authorize implementation by itself.

References:
- Constitution (10 principles, frozen): `docs/constitution.md`
- Architecture orientation: `docs/roadmap.md`
- Hard rules: `docs/rules.md`
- Event contract (envelope, producer, identity, versioning): `docs/event-contract.md`
- Runtime ownership boundaries: `docs/adr/0005-runtime-ownership-boundaries.md`
- Phase 0.5 frozen/completed plan: `docs/phase-0.5-plan.md`
- Phase 0.6 frozen/completed plan: `docs/phase-0.6-plan.md`
- Phase 0.7 frozen/not-started plan: `docs/phase-0.7-plan.md`
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
│   ├── agent-core/        ← owned minimal Agent loop + durable-prefix seam
│   ├── agent-protocol/    ← Host ↔ Agent semantic protocol + local IPC
│   ├── ai/                ← provider adapters (0.1B)
│   ├── coding-agent/      ← app layer, tools, capabilities, worker/CLI seams
│   ├── cognition-runtime/ ← orientation/recall/verification/completion policy
│   ├── events/            ← canonical event envelope/contracts
│   ├── host-runtime/      ← Host control plane + transcript/context authority
│   ├── memory/            ← Ola-derived memory semantics (0.3)
│   ├── reasoning/         ← Ouroboros-derived reasoning semantics (0.4)
│   ├── secrets/           ← pre-persistence secret admission/redaction
│   ├── storage/           ← locked event store + projections/read models
│   ├── test-provider/     ← deterministic offline provider
│   ├── transcript/        ← durable conversational semantics (0.6)
│   └── workspace/         ← repository/workspace identity + ownership
├── extensions/
│   └── cognition/         ← thin Agent-side protocol adapter
├── docs/
├── scripts/gate/
└── .github/workflows/ci.yml
```

`packages/context` is frozen for Phase 0.7 but does not exist yet.
`packages/web` is planned for 0.8 and does not exist yet.

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
  ├─ transcript
  ├─ storage
  ├─ memory
  ├─ reasoning
  └─ events

cognition-runtime
  ├─ memory
  └─ reasoning
```

The Agent worker and cognition extension do not own storage, workspace locks,
canonical admission, environmental process lifecycle, transcript authority,
context strategy, or final completion. Memory/reasoning/transcript remain
semantic domains; Host/storage own canonical state and persistence. See ADR
0005 and the closed Phase 0.6 plan.

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
        ├── transcript_messages
        ├── artifacts
        ├── projection_receipts
        └── schema_migrations
```

The event log is canonical. Projection cursors never advance beyond the event
head; derived projections are rebuildable. Workspace ownership is one writer
through the process-held OS lock. Possibly-mutating interrupted operations use
the explicit Phase 0.2 uncertainty/reconciliation state machine and are not
automatically retried. Schema remains v7 after Phase 0.6.

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

## Phase 0.6 — Durable verbatim context reconstruction — CLOSED

**Objective:** establish the safe model-context baseline: reconstruct the
provider-visible conversational prefix from canonical durable transcript state
so replacement Host/Agent processes do not depend on earlier in-memory history.

The frozen implementation contract is recorded in
`docs/phase-0.6-plan.md`.

**As built:**

- `@alcode/transcript` owns rich transcript payload/message semantics,
  deterministic reduction, pre-append transition validation, completeness, and
  fidelity classification;
- canonical transcript vocabulary now includes `user.message.appended`,
  `assistant.message.appended`, and `tool.result.appended`;
- assistant/tool-result admissions use a serialized Host validation + append +
  critical projection barrier and return `transcript.admitted` only after
  durable acceptance;
- the Agent loop awaits transcript admission so `no transcript ACK ⇒ no next
  model request`;
- the provider/model `toolCallId` is preserved through `ToolExecutionContext`,
  capability request/result correlation, and the durable tool result while
  `operationId` remains separate Host execution identity;
- stable-head `TranscriptSnapshot` reconstructs exact or legacy text history
  with `complete | incomplete` and `exact | legacy_text_only` state;
- Host `compileVerbatimContext()` emits `verbatim-v1`; incomplete history blocks
  continuation without replay, fabricated tool results, or pending-input policy;
- `durable_transcript_v1` capability negotiation prevents the Host from
  claiming exact 0.6 semantics for a supervised worker that does not support
  the contract;
- replacement Agent history is disposable and hydrated from Host-provided
  canonical reconstruction;
- pinned pi v0.81.1 `convertToLlm` source is byte-faithful and used as the
  shared-message parity oracle;
- textual transcript projection rebuild, stable source sequence, duplicate
  delivery, Host+Agent close/reopen, and ownership boundaries are executable
  gate evidence;
- schema remains v7; exact context authority remains canonical events rather
  than the intentionally simpler `transcript_messages` table.

**Signature proof:**

```text
canonical U1 → Assistant(T1) → ToolResult(T1)
→ destroy Agent A and Host A
→ reopen Host B
→ reconstruct verbatim-v1 from canonical events only
→ hydrate empty Agent B
→ admit U2
→ next ModelRequest contains the same complete durable prefix + U2
→ continue
```

**Explicit exclusions retained:** graph/context relevance selection;
reasoning/memory injection; graph projection receipts; graph A/B evaluation;
compaction/summarization; provider-specific transforms/tokenizers; durable
system-prompt/tool-definition/provider restoration; 0.8 pending-input dispatch
semantics; UI; remote Agent transport; multi-agent/subagents.

**Exit gate:** `pnpm gate:0.6` composes `gate:0.5` and proves the pinned pi
oracle, rich transcript semantics, pre-append validation, durable admission ACK
barrier, end-to-end tool-call identity, stable-head reconstruction,
close/reopen/replacement continuity, legacy fidelity, incomplete-history
fail-closed behavior, projection rebuild, and context ownership boundaries.

**Closure:** PR #12 source head
`303a0c4cb528a63952befcdd86e83548f8378327` merged as
`98c764c60f95fe45c7976661bedda30a287c5c20`; post-merge CI run `31542403984`
completed successfully with Phase 0.6 job `93947566591` green.

**Status:** CLOSED.

---

## Phase 0.7 — Governed selective context / `graph-v1` — FROZEN / NOT STARTED

**Status:** FROZEN DESIGN — NOT STARTED — NOT AUTHORIZED. The authoritative
implementation/acceptance contract is `docs/phase-0.7-plan.md`.

**Objective:** make selective model observation a deterministic, auditable,
reversible Host policy. `graph-v1` is an opt-in strategy; `verbatim-v1` remains
both the safety fallback and product default.

**Inputs:** closed 0.6 verbatim/durable transcript baseline; closed 0.4
reasoning semantics; closed 0.3 memory semantics; 0.5 Host operation/cognition
state; bounded explicitly recorded Host workspace observation.

**Frozen architecture:**

- every `ModelProvider.stream()` in a 0.7-capable Agent is immediately preceded
  by a Host context refresh; no turn-start graph snapshot may be reused across
  later tool-loop inference after state changes;
- one stable canonical source cut supplies transcript/reasoning/memory/operation
  state; workspace/Git state is a separately timed/provenanced observation and
  is not falsely described as transactionally atomic with SQLite;
- pure `@alcode/context` owns deterministic policy only; Host owns acquisition,
  strategy, fallback, receipt admission and delivery;
- context items carry explicit trust classes (`host_control`, `host_observed`,
  `verified_evidence`, `epistemic_claim`, `advisory_memory`, `unverified_data`);
  canonical source text can never become Host control solely through storage;
- source-derived system content is structured/escaped data under Host-authored
  control framing, not uncontrolled prose interpolation;
- current-turn canonical transcript and the immediately preceding complete turn
  are required, preserving tool-call/result atomicity;
- reasoning selection uses an objective-scoped causal frontier containing
  relevant active hypotheses, linked falsifiers, active decisions, pending
  verification obligations, blocking diagnostics/implicated graph paths and
  decisive evidence; it does not dump all active historical hypotheses;
- memory insertion is read-only and requires positive exact/relevance/structural
  eligibility before applying the closed Phase 0.3 score; multiple deterministic
  anchors are scored independently and aggregated by max score; selection never
  records memory `seen`/`used`;
- graph context has a hard deterministic **post-render serialized-character**
  bound; `chars4-v1` remains an approximate comparison metric, not a provider
  token upper bound;
- required graph facts are never silently dropped; required overflow causes an
  explicit `verbatim-v1` fallback without claiming verbatim satisfies the graph
  bound;
- canonical `context.projection_compiled` receipts separate source, attempted
  graph decision, effective delivery and fallback; excluded candidates are
  bounded summaries plus a candidate-universe digest rather than an unbounded
  rejected-item list;
- receipts include a request-environment digest covering base-system-prompt
  digest, tool-definition digest, compiler/policy/render/trust versions and
  budget configuration;
- the canonical receipt event is the durability barrier; the existing SQL
  `projection_receipts` summary remains rebuildable/derived unless a concrete
  implementation invariant proves critical visibility necessary;
- context receipt events are audit/meta-events and must not become reasoning
  evidence, memory provenance fallback or task-world observations;
- A/B fixtures/metrics are preregistered before selector implementation and use
  isolated equivalent source state;
- Phase 0.7 cannot close vacuously through all-fallback behavior: at least one
  frozen fixture must deliver `graph-v1`, preserve required facts, use fewer
  serialized characters than `verbatim-v1`, and succeed under the deterministic
  oracle;
- no evaluation result automatically promotes graph to the product default.

**Frozen exclusions:** graph default promotion; LLM summarization/semantic
compaction; provider-specific tokenizers/window enforcement/transforms; raw
system-prompt/tool-definition durability; dense/vector memory retrieval; memory
reinforcement due to selection; new reasoning semantics solely for ranking;
static-turn/dynamic-overlay optimization; pending-input redispatch /
START_NOW / GUIDE / QUEUE; UI; remote Agent transport; browser;
workflow/task identity; subagents; general scheduler/automation.

**Exit gate:** `pnpm gate:0.7` composes `gate:0.6` and proves inference-boundary
freshness, coherent canonical source cuts, workspace-observation provenance,
trust/data separation, stored-injection containment, objective-scoped frontier
with decisions/falsifiers, transcript atomicity, relevance-gated read-only
memory, hard post-render graph bounds, safe fallback, bounded/reproducible
receipts, meta-event non-contamination, Agent replacement/recovery, verbatim
default, frozen evaluation corpus isolation, and the non-vacuous graph value
proof defined in `docs/phase-0.7-plan.md`.

Implementation requires separate explicit authorization.

---

## Phase 0.8 — Application Protocol + React GUI

**Objective:** streaming React experience over a stable Host-owned application
transport.

**Inputs:** open-harness `ui-stream.ts` + React provider (MIT); qwen web UI
patterns (reference only); stable Host/runtime contracts.

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

## Migration (post-0.6, when worth doing)

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
0.6   Durable verbatim context reconstruction CLOSED
0.7   Governed selective context / graph-v1   FROZEN — NOT STARTED
0.8   Application Protocol + React GUI        PLANNED
0.9   External integrations                   PLANNED
```

Historical calendar estimates are planning context only. Executable gates and
frozen acceptance criteria drive sequencing and closure.
