# ALCODE — Phase 0 Specification (executable)

Status: **active**. This is the executable build order. Each phase has an objective,
inputs, implementation scope, explicit exclusions, deliverables, required tests,
an exit gate, a failure/rollback rule, dependencies, and an estimated range.
Phases begin when their dependencies' exit gates pass and end when their own
exit gate passes.

Constitution: `docs/constitution.md` (10 principles, frozen).
Hard rules: `docs/rules.md`.
Non-goals: `docs/non-goals.md`.
Backlog: `docs/backlog.md`.

Naming: project codename `ALCODE`. Rename freely later.

---

## Workspace layout (decided in 0.0, used by 0.1+)

```
alcode/
├── packages/
│   ├── events/          ← narrow envelope/registry (scaffolded in 0.0, fleshed in 0.2)
│   ├── agent-core/      ← (0.1) vendored pi loop
│   ├── ai/              ← (0.1) vendored pi providers
│   ├── coding-agent/    ← (0.1) app layer + tools + extensions + CLI
│   ├── memory/          ← (0.3) Ola, ported JS→TS
│   ├── reasoning/       ← (0.4) Ouroboros, ported Py→TS
│   ├── cognition-runtime/ ← (0.5) coordinator/policy/reinforcement/consolidation
│   └── web/             ← (0.8) React GUI
├── extensions/
│   └── cognition/       ← (0.5) thin orchestration adapter
├── docs/{constitution,rules,non-goals,backlog,phase-0-spec}.md
├── docs/provenance/      ← per-import provenance records
└── package.json          ← workspace root (pnpm or npm workspaces)
```

**Dependency direction (inward flow toward domain contracts):**
`web → coding-agent → {agent-core, cognition-runtime, memory, reasoning} → events`.
`memory` and `reasoning` depend on `events` (the shared envelope), never on web,
CLI, agent-core internals, HTTP/MCP transport, provider SDKs, or host paths.
The `events` package is narrow: envelope, identity, correlation, sequence
allocation, schema versioning, serialization, registry, append/replay interfaces.
Domain packages own their event payloads.

## Storage layout (decided in 0.0)

```
~/.alcode/
├── registry.sqlite                  ← workspace registry, single-writer locks
└── workspaces/<workspace_id>/
    └── workspace.sqlite             ← ONE database per workspace
        ├── events
        ├── projection_cursors       ← (projection_name, last_applied_event_sequence, projection_schema_version)
        ├── sessions
        ├── operations
        ├── reasoning_nodes
        ├── reasoning_edges
        ├── memories
        ├── memory_stats
        ├── artifacts                ← content-addressed, by digest
        ├── projection_receipts
        └── schema_migrations
```

SQLite pragmas: WAL mode, foreign keys on, `BEGIN IMMEDIATE` transactions,
`ON CONFLICT … DO UPDATE` upserts, partial unique indexes where needed,
immutable event IDs, monotonic per-workspace event sequence. Binary/large tool
output lives in content-addressed artifact files referenced by digest.

---

## Phase 0.0 — Minimal architecture constitution

**Objective:** Freeze the minimal decisions required to begin the vertical slice. Nothing more.

**Inputs:** the constitution; the two source-analysis documents; verified pi paths.

**Implementation scope (ONLY):**
1. Commit the 10 principles to `docs/constitution.md`.
2. Define minimal identities in `packages/events/src/identity.ts`: `workspace_id`, `session_id`, `event_id`, `operation_id`, `memory_id`, `reasoning_node_id` + `event_sequence` and `schema_version`.
3. Define the `DomainEvent` envelope in `packages/events/src/envelope.ts`:
   ```ts
   interface DomainEvent<TType extends string, TPayload> {
     eventId: string;
     workspaceId: string;
     sessionId: string;
     operationId?: string;
     sequence: number;
     schemaVersion: number;
     type: TType;
     payload: TPayload;
     occurredAt: string;
     recordedAt: string;
   }
   ```
4. Define the narrow `events` package scope: envelope, identity, correlation, sequence allocation, schema versioning, serialization, registry, append/replay interfaces. Domain packages own their payloads.
5. Lock the one-database decision and storage layout (above).
6. Lock the single-writer ownership rule and supervised-process rule (`docs/rules.md`).
7. Lock the package dependency graph (inward flow; above).
8. Define the Phase 0.2 vertical-slice contract (see §0.2).
9. Write explicit non-goals (`docs/non-goals.md`).

**Explicit exclusions:** every event type (only envelope + registry mechanism now); complete memory/reasoning schemas; deferred identities (`installation_id`, `repository_id`, `worktree_id`, `task_id`, `turn_id`, `model_request_id`, `tool_call_id`, `artifact_id`); multi-agent identity; distributed runtime; final GUI transport; final plugin compatibility.

**Deliverables:** `docs/constitution.md`, `docs/rules.md`, `docs/non-goals.md`; `packages/events` skeleton (envelope + registry interfaces, no event types); README pointing at the constitution.

**Required tests:** none (scaffold only).

**Exit gate:** the 9 required outputs exist and are referenced by 0.1 and 0.2. If a principle is contested it reopens 0.0; otherwise 0.0 is closed.

**Failure/rollback rule:** if 0.2 surfaces that a frozen principle is wrong, amend via a documented constitutional change, not a silent code decision.

**Dependencies on later phases:** none — this is the root.

**Estimated range:** 1–2 working days, hard timebox. Anything not required to begin 0.2 enters `docs/backlog.md`.

---

## Phase 0.1 — Source acquisition and ownership conversion

**Objective:** vendored pi running headless as owned ALCODE infrastructure, with clean provenance.

**Inputs:** `C:/AlCode/ref/pi-main` (MIT); import/ownership-conversion commit discipline.

**Implementation scope:**
1. **Import commit (minimal semantic edits).** Copy:
   - `packages/agent` → `packages/agent-core`
   - `packages/ai` → `packages/ai`
   - selected `packages/coding-agent/src/core/tools/{bash,read,write,edit,grep,ls,find}.ts` + supporting (`path-utils`, `truncate`, `tool-definition-wrapper`, `output-accumulator`, `render-utils`, `file-mutation-queue`, `edit-diff`)
   - `packages/coding-agent/src/core/extensions/{types,loader,runner,wrapper,index}.ts` (the extension system — the spine's mount point)
   - CLI entrypoint skeleton
   Record in `docs/provenance/pi.md`: source repo, exact commit, import date, imported paths, excluded paths, original license, destination paths.
2. **Ownership-conversion commit (separate).** Rename packages/namespaces (`@earendil-works/*` → `@alcode/*`); remove pi branding; replace config conventions; define ALCODE-owned APIs.
3. Boot headless: `alcode -p "hello"` returns a model response.
4. Run the 7 tools against a scratch repo.

**Explicit exclusions:** pi `tui` (dropped — GUI in 0.8); pi `server` and `storage` (replaced by event-log architecture); pi example extensions (subagent is backlog-referenced only).

**Deliverables:** working `alcode` CLI; `docs/provenance/pi.md`; ownership-conversion diff.

**Required tests:** imported baseline tests for vendored agent-core + ai + tools (prove acquisition preserved behavior). Keep green forever as a regression oracle.

**Exit gate:** `alcode -p "hello"` works; the 7 tools each succeed in a smoke test; `docs/provenance/pi.md` is complete; import commit and ownership-conversion commit are separate in git history.

**Failure/rollback rule:** if a pi module resists ownership conversion (deep upstream coupling), exclude it in this phase and log to backlog — do not fork-patch pi internals in 0.1.

**Dependencies:** 0.2 needs the agent loop + extensions + at least one tool working.

**Estimated range:** 3–7 days.

---

## Phase 0.2 — Minimal durable vertical slice

**Objective:** prove the event-log-as-truth architecture end-to-end on a thin slice, before any Ola/Ouroboros port.

**Inputs:** 0.1's runnable agent; the `events` scaffold from 0.0.

**Implementation scope:**
1. Implement the `events` package for real: append (monotonic per-workspace sequence), replay, registry. One writer per workspace (single-writer lock in `registry.sqlite`).
2. Define the minimal event types needed for this slice (in their owning packages):
   - `events` (envelope only): `session.started`, `session.stopped`
   - agent/transcript: `user.message.appended`, `assistant.message.appended`, `tool.requested`, `tool.started`, `tool.completed`, `tool.failed`
   - minimal reasoning: `objective.set` (a single objective node — no full graph yet)
   - minimal memory: `memory.created` (one record — no scoring yet)
3. Wire the agent loop + one tool (`bash`) to emit events for every state change. The agent still operates on its in-memory transcript (verbatim); events are a side-effect shadow proving plumbing.
4. Open `workspace.sqlite` at session start; replay events at reopen; verify projection cursor == event sequence.

**Explicit exclusions:** no scoring, no graph, no falsifiers, no projection of LLM context from events yet (agent uses its native transcript). Point is durability plumbing, not cognition.

**The exact gate (must pass all):**
```
start runtime → resolve workspace → append user-message event → request model response →
execute one controlled tool → append operation and result events →
update minimal reasoning projection (objective) → create/retrieve one memory →
stop process → reopen same workspace → replay/recover → resume with identical durable state
```

**Required invariants (enforced by tests):** one workspace DB; one writer; strictly increasing event sequence; no repository-local mutable files; no detached children (tool process observed to exit); projection cursor equals event sequence after each operation; deleting a projection and rebuilding from events produces an equivalent projection; resume does not duplicate events.

**Deliverables:** `events` package working; `workspace.sqlite` schema (events, projection_cursors, sessions, operations, minimal reasoning_nodes, minimal memories); integration test proving the gate.

**Required tests:** the gate test itself; the 8 invariants as separate tests; a crash-before-projection-completion → reopen → recover test.

**Exit gate:** the exact-gate sequence passes; all 8 invariants pass; the crash-recovery test passes. **Do not begin the full Ola or Ouroboros ports until this passes.**

**Failure/rollback rule:** if durability cannot be proven on the slice, the architecture is wrong — surface it, do not paper over. This is the phase that validates principles 1–4.

**Dependencies:** 0.3, 0.4, 0.5 build on this event spine.

**Estimated range:** 1–2 weeks. Load-bearing phase — do not compress.

---

## Phase 0.3 — Memory semantic core (Ola port)

**Objective:** `packages/memory` is a real TS package, behaviorally equivalent to Ola's semantic core, validated by differential evidence.

**Inputs:** `C:/Next-Era/Ola/` (Node/JS); contracts from its `ARCHITECTURE.md`.

**Implementation scope (port directly):**
- Schemas: `lessons`, `playbooks` → TS types + Zod (from `schemas/*.yaml`).
- Stable `memory_id = "<type>/<slug>.md"`.
- Retrieval scoring: `0.65·relevance + 0.20·structural + 0.15·strength` + exact-match override.
- Strength/decay: Ebbinghaus formula `confidence × exp(−0.1·daysSinceUse/(1+0.2·consolidationCount))`; `consolidationCount` increments every 5 uses.
- Reinforcement doctrine: `recordUse` (strength) vs `recordSeen` (informational only); inject vs search modes.
- Lifecycle: active → archived → tombstoned → deleted; immutable records, mutable sidecar stats.
- Provenance (`sourceEventIds`), usage statistics, lexical retrieval (defer dense to backlog).
- `MemoryRecord` shape (per source doc): `id, type, title, body, status, confidence, consolidationCount, createdAt, updatedAt, lastSeenAt?, lastUsedAt?, sourceEventIds, workspaceScope?, repositoryScope?, tags`.

**Redesign, do NOT port mechanically:** ZCode hooks, transcript-DB coupling, detached workers, offload-drain launcher, old migration machinery, plugin-specific env resolution, host-specific directory assumptions. Replace detached workers with the supervised scheduler (rule 4).

**Differential evidence (incremental, not blocking):** Generate golden JSON from working JS Ola for: scoring (relevance/structural/strength blend), exact-match override, reinforcement (use vs seen), lifecycle transitions (active→archived→tombstoned→deleted), decay-over-time. TS port must match.

**Explicit exclusions:** dense/vector retrieval (backlog); offload/task-tracking surface; R2 migration; phase-0 chunk/judge scripts.

**Deliverables:** `packages/memory` semantic core; ported + differential tests; a `memory` projection consuming `memory.*` events from the log.

**Required tests:** unit (each formula); differential (golden corpus); the reinforcement doctrine as invariant tests.

**Exit gate:** all ported Ola contract tests green; differential fixtures match; no detached-worker patterns in the code.

**Failure/rollback rule:** if a formula doesn't match golden output, the port is wrong — fix the port, never relax the fixture.

**Dependencies:** 0.5 wires memory into cognition; 0.7's graph compiler selects memories.

**Estimated range:** 3–7 days.

---

## Phase 0.4 — Reasoning semantic core (Ouroboros port)

**Objective:** `packages/reasoning` is a real TS package, behaviorally equivalent to Ouroboros's core, validated by differential evidence.

**Inputs:** `C:/Next-Era/Ouroboros/ouroboros/` (Python); the 14 core modules (~5,332 LOC).

**Implementation scope (port semantically, in order):**

- *Mechanical (days 1–2):* `types`, `artifacts` (NodeKind/EdgeKind), `cognitive`, `predicates`, `state`, `graph`, `critic`, `branching`.
- *Attention-requiring (days 3–4):* `engine`, `reducer`, `diagnostics`, `verification`. Reducer's deterministic `event:{session}:{seq}:{kind}` IDs and diagnostics BFS must match Python exactly.
- *Design-decision (days 4–6):* `session_store` (→ `better-sqlite3`; preserve WAL/`BEGIN IMMEDIATE`/upserts/partial unique index/migrations; restructure `append_events` callback-in-lock to build-payload-then-locked-append); `cognitive_service` (drop session-resolution-by-workspace for now).

**Drop entirely (~11,300 LOC):** `mcp_server`, `mcp_invocation`, `invocation_gateway`, `lifecycle_*`, `reconciliation*`, `native_projection`, `register_governed_tool`, `trace_*`, `sidecar`, `qualification`, `clock_calibration_v2`, `command_signature`, `attribution`, `hash_schemas`, `activation`, and the `hooks/` dir.

**Preserve guarantees in native form (not mechanisms):** invocation correlation → `operation_id` + event correlation; durable receipts → operation/tool lifecycle events; exclusive activation → task/operation ownership txn; state attestation → runtime/store identity metadata; lifecycle reconciliation → event replay + startup recovery; automatic evidence capture → direct tool-result event ingestion; conservative hypothesis linking → explicit verification contracts; exactly-once mutation → transaction key/uniqueness; clock qualification → runtime monotonic clock abstraction; failure preservation → immutable failed operation records.

**Differential corpus (3 + 1 families, staged):**
1. **Normal deterministic flow** (objective→hypothesis→verification plan→evidence→conclusion): verify event IDs, graph nodes/edges, ordering, diagnostics, final state.
2. **Duplicate and replay**: duplicate event handling, reducer idempotence, uniqueness constraints, replay from sequence zero, replay from projection cursor.
3. **Crash and reopen**: interrupt after event append / before projection completion / during operation / after tool result / before final commit; reopen and recover.
4. **(Small, not full) Falsifier or conflicting-evidence path** — central to Ouroboros's identity; earliest port proves it isn't reduced to linear success.

Expand during the port: branching, unsupported conclusions, verification classifications, malformed inputs, migrations, rollback, concurrent ownership.

**Explicit exclusions:** MCP/governance apparatus (above); Python plumbing tests (~73%); full ~12-category golden corpus up front.

**Deliverables:** `packages/reasoning`; the `reasoning` projection consuming `objective.set`/`hypothesis.created`/`evidence.linked`/`falsifier.evaluated`/etc.; ported core tests + 4 differential families.

**Required tests:** ported core-reasoning tests (~3,900 LOC); the 4 differential families; deterministic-behavior invariants (graph ordering, reducer idempotence, verification classification, critic output, falsifier semantics, diagnostic traversal, txn behavior).

**Exit gate:** all ported reasoning tests green; all 4 differential families match Python golden output; deterministic-behavior invariants hold.

**Failure/rollback rule:** a golden mismatch means the port drifted — fix it before proceeding. Never ship a reasoning port that fails a differential fixture.

**Dependencies:** 0.5 wires reasoning into cognition; 0.7's graph compiler reads the reasoning projection.

**Estimated range:** 1–2 weeks.

---

## Phase 0.5 — Durable cognition integration

**Objective:** the `extensions/cognition` adapter binds the agent loop to memory + reasoning via domain events, with the event log as the single source of truth. The spine is alive.

**Inputs:** 0.1 (loop + extension API); 0.3 (memory); 0.4 (reasoning); 0.2 (event log).

**Implementation scope:**
- Split into thin extension + coordinator package (do NOT let the extension become a monolith):
  ```
  extensions/cognition/{index,event-adapter,tool-registration,projection-hook}.ts
  packages/cognition-runtime/{coordinator,policy,reinforcement,consolidation}.ts
  ```
- The extension only binds pi lifecycle events to coordinator calls. It contains NO memory policy, reducer semantics, evidence rules, or consolidation algorithms.
- The coordinator owns: when a tool result becomes evidence; when memory is reinforced; when a hypothesis must be verified; when consolidation runs; when diagnostics should block completion.
- **Lifecycle mapping (split `tool_call` into explicit stages):**
  - `session_start`: resolve workspace/task, open store, replay projections, recover interrupted operations, recall memory, orient reasoning.
  - `turn_start`: append user input, update objective, compile context (still verbatim — 0.6/0.7), request model.
  - `before_tool_call`: validate permission, create operation, record decision, establish verification contract if relevant, freeze args.
  - `tool_call_started/completed/failed/cancelled`: capture structured result, classify evidence, link only through explicit verification semantics, update reasoning, reinforce memory.
  - `turn_end`: critic + diagnostics, consolidate if policy allows, completion assessment, persist projection receipt.
  - `session_stop`: flush state, mark operations, write resumability checkpoint, release ownership.
- Register agent-callable tools: `recall`, `remember`, `commit_hypothesis`, `record_assumption`, `defer_alternative`, `record_decision`, `link_evidence`, `orient`, `diagnose`.

**Explicit exclusions:** graph context compiler (0.7); user-facing hooks (0.9); MCP/ACP (0.9).

**Deliverables:** the cognition extension + coordinator; integration tests covering the full lifecycle mapping.

**Required tests:** integration (prompt→model→tool→event→reasoning update→memory update→projection→resume); crash tests (terminate before event commit / after tool start / after external mutation / before tool-result commit / during projection update / during consolidation → verify recovery); concurrency (two tool calls, two sessions conflict, duplicate event delivery, cancelled request, concurrent reinforcement).

**Exit gate:** the Ouroboros 0.20 continuity proof reproduced in ALCODE — kill process mid-task, reopen, `resume → orient → act` with state intact; all crash/concurrency tests pass.

**Failure/rollback rule:** if cognition semantics leak into the extension, refactor — the boundary is a hard rule.

**Dependencies:** 0.6/0.7 consume the coordinator's projections; 0.8 surfaces cognition state in UI.

**Estimated range:** 1–2 weeks.

---

## Phase 0.6 — Verbatim context compiler

**Objective:** establish the safe baseline — context construction behaviorally identical to pi today, but emitted from the event log + projections.

**Inputs:** 0.1 (pi's native transcript behavior); 0.5 (cognition running).

**Implementation scope:**
- Implement `convertToLlm` Projection A (verbatim): `messages + tool calls + tool results → provider-compatible context`, sourced from the transcript projection.
- The regression oracle. Behaviorally indistinguishable from pi pre-acquisition.

**Explicit exclusions:** graph projection (0.7).

**Deliverables:** the verbatim compiler; setting `alcode.projection` (value: `verbatim` for now).

**Required tests:** parity tests — same model request produced by ALCODE's verbatim compiler vs pi's native conversion, on a corpus of transcripts.

**Exit gate:** verbatim projection produces token-identical (or behaviorally equivalent) model requests to pi's native path, on the parity corpus.

**Failure/rollback rule:** this is the fallback for 0.7 — it must be rock-solid before 0.7 ships.

**Dependencies:** 0.7's graph compiler falls back to this on any failure.

**Estimated range:** 3–5 days.

---

## Phase 0.7 — Graph context compiler and experiment framework

**Objective:** Projection B (graph-distilled) as a measured experiment with receipts and fail-safe fallback. Not default until it wins on objective evaluation.

**Inputs:** 0.4 (reasoning projection); 0.3 (memory projection); 0.6 (verbatim fallback).

**Implementation scope:**
- Formal context compiler, not a loose filter.
- **Mandatory inclusions:** current user request, active objective, system/safety constraints, current worktree/repo state, unresolved tool failures, pending permission state, active hypotheses, decisive evidence, known contradictions, latest relevant tool outputs, relevant durable memories, active verification obligations.
- **Selection factors:** relevance, recency, confidence, evidence quality, contradiction status, token cost, task scope, provenance.
- **Projection receipt** recorded as a `context.projection_compiled` event (mode, compiler version, source event sequence, receipt digest, token budget, fallback status) + full receipt in `projection_receipts`. Receipt shape:
  ```ts
  interface ProjectionReceipt {
    projectionMode: "verbatim" | "graph";
    compilerVersion: string;
    sourceEventSequence: number;
    includedEventIds: string[];
    includedReasoningNodeIds: string[];
    includedMemoryIds: string[];
    excludedItems: Array<{ id: string; reason: string }>;
    tokenBudget: number;
    estimatedTokens: number;
    fallbackUsed: boolean;
  }
  ```
- **Fail-safe → verbatim** when: reasoning projection invalid; event/projection sequence disagree; required constraints missing; unknown schema; incomplete provenance; token compilation fails.

**Explicit exclusions:** making graph the default (deferred until measured).

**Deliverables:** the graph compiler; receipt machinery; A/B harness comparing graph vs verbatim on a task suite.

**Required tests:** fallback triggers on each fail-safe condition; receipts complete and accurate; A/B metrics captured.

**Exit gate:** graph projection runs as a toggle; receipts inspectable; fallback proven; A/B data being collected. Default stays `verbatim` until graph measurably wins.

**Failure/rollback rule:** any fail-safe condition → automatic fallback to verbatim, logged. Never ship a graph projection that can silently produce invalid context.

**Dependencies:** 0.8 surfaces projection mode + receipts in UI.

**Estimated range:** 1–2 weeks.

---

## Phase 0.8 — React GUI

**Objective:** streaming React UI over the stable application event transport.

**Inputs:** open-harness `ui-stream.ts` + React provider (MIT); qwen webui patterns (Apache-2.0, reference only).

**Implementation scope:**
- Port open-harness's streaming layer (`ui-stream.ts`, `provider.tsx`, `transport.ts`, hooks) → `packages/web`.
- Build UI primitives: message timeline, reasoning stream, tool cards (read/write/edit/bash/grep kinds), permission prompts, file diffs, cancellation, task/session switcher, resumability status, diagnostics, memory + reasoning inspectors, **projection mode + receipt view**.
- **Transport contract defined before UI build:** event sequence, reconnect behavior, resume cursor, stream cancellation, duplicate-event handling, tool progress, permission round-trip, terminal completion. Frontend consumes ordered application events, never reads DB state directly.

**Explicit exclusions:** full graph visualization (backlog); multi-agent kanban (v2 direction).

**Deliverables:** the GUI; transport contract doc.

**Required tests:** transport reconnect/resume/duplicate-event tests; rendering tests for each primitive.

**Exit gate:** run `alcode` and get a streaming React UI driving the agent, tool calls rendering as cards, projection receipts visible, resumability observable.

**Failure/rollback rule:** GUI must be a client of the runtime — no domain logic in the frontend. If transport contracts aren't stable, delay UI coupling rather than coupling to a moving target.

**Dependencies:** 0.9 integrations surface in UI.

**Estimated range:** 1–2 weeks.

---

## Phase 0.9 — External integrations

**Objective:** hooks, MCP, ACP, code intelligence — each as an integration layer over owned lifecycle events, never authoritative state owners.

**Implementation scope (each independently shippable):**
- **User-facing hooks:** port qwen-code's `hooks/` (HookEventName, CommandHookConfig + HttpHookConfig + matchers + SSRF guards) onto ALCODE lifecycle events. Hooks must not silently become authoritative state owners.
- **MCP client:** port kimi-code's `connection-manager.ts` + 3-tier `config-loader.ts`. ALCODE consumes external MCP tools via typed calls. MCP stays external.
- **MCP server (optional):** expose selected capabilities to other hosts; reference qwen's `mobile-mcp`.
- **ACP:** port kimi-code's `acp-adapter/` so `alcode acp` connects to the same runtime as GUI/CLI (not a second state-owning loop).
- **Code intelligence:** the `CodeIntelligence` interface (`indexWorkspace`, `searchSymbols`, `findReferences`, `retrieveContext`); first impl may call the `codebase-memory-mcp` binary (MIT, source in library), workspace-scoped + commit-aware + invalidation-aware + cancellable + external to repo source.
  ```ts
  interface CodeIntelligence {
    indexWorkspace(...): Promise<IndexResult>;
    searchSymbols(...): Promise<SymbolResult[]>;
    findReferences(...): Promise<ReferenceResult[]>;
    retrieveContext(...): Promise<ContextChunk[]>;
  }
  ```

**Explicit exclusions:** making any of these mandatory for v1; letting any integration own state.

**Deliverables:** each integration as a separate module; tests per integration.

**Exit gate:** each integration works against the runtime without becoming a state owner; security model (loopback, ephemeral token, path validation, SSRF) enforced.

**Estimated range:** 1–2 weeks total, parallelizable.

---

## Migration (post-0.5, when worth doing)

Freeze Ola/Ouroboros repos as behavioral references. Define export/import contracts:
- **Ola:** memories, stats, tombstones, provenance.
- **Ouroboros:** sessions, graph nodes, edges, events, verification contracts, evidence.

Import into ALCODE with: count validation, ID validation, digest verification, graph integrity check, retrieval-sample comparison, source-provenance preservation, migration receipt. **Never point the new runtime at old live databases.**

---

## Phase 0 estimated total range

```
0.0 Minimal architecture constitution:        1–2 days
0.1 Source acquisition + ownership:           3–7 days
0.2 Minimal durable vertical slice:           1–2 weeks   (load-bearing)
0.3 Memory semantic core (Ola):               3–7 days
0.4 Reasoning semantic core (Ouroboros):      1–2 weeks
0.5 Durable cognition integration:            1–2 weeks
0.6 Verbatim context compiler:                3–5 days
0.7 Graph context compiler + experiment:      1–2 weeks
0.8 React GUI:                                1–2 weeks
0.9 External integrations:                    1–2 weeks (parallelizable)
---------------------------------------------
Internal alpha:                               ~6–11 weeks
```

Estimates are ranges, not commitments. AI assistance accelerates mechanical translation but does not eliminate semantic mismatch, concurrency defects, recovery design, provider quirks, UI transport bugs, or cross-platform process behavior. Gates drive sequencing, not calendars.
