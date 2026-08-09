# ALCODE — Phase 0 Specification (executable)

Status: **active; Phases 0.0, 0.1A, 0.2 closed** — gate:0.2 green on `main` (`dd07fb2`). See `docs/roadmap.md` for architecture orientation.

This is the executable build order. Each phase has an objective, inputs,
implementation scope, explicit exclusions, deliverables, required tests, an
**executable exit gate** (`pnpm gate:X.Y`), a failure/rollback rule,
dependencies, and an estimated range. Phases begin when their dependencies'
exit gates pass and end when their own gate command emits
`status: "passed"`.

References:
- Constitution (10 principles, frozen): `docs/constitution.md`
- Hard rules: `docs/rules.md`
- Event contract (envelope, producer, identity, versioning): `docs/event-contract.md`
- Non-goals: `docs/non-goals.md`
- Backlog: `docs/backlog.md`

Naming: project codename `ALCODE`. Rename freely later.

There are **five P0 architectural findings** this revision resolves before the
large semantic ports begin: (1) phase-gate status, (2) transaction semantics,
(3) uncertain tool mutations, (4) workspace identity and ownership, (5) secret
admission. ADRs 0001–0004 cover findings 2–5; finding 1 is resolved by making
every gate executable.

## Gate receipt schema (stable from the outset)

Every `pnpm gate:X.Y` emits a `GateReceipt` JSON to stdout and to
`~/.alcode/gate-receipts/<gate>-<commitSha>-<ts>.json`:

```ts
interface GateReceipt {
  gate: string;                            // "0.0", "0.1A", "0.2", ...
  status: "passed" | "failed";
  commitSha: string;
  startedAt: string;                       // ISO 8601
  completedAt: string;                     // ISO 8601
  runtimeVersion: string;                  // node --version
  packageManagerVersion: string;           // pnpm --version
  inputs: Array<{ name: string; digest?: string }>;
  checks: Array<{
    id: string;                            // e.g. "events.append.idempotent"
    status: "passed" | "failed" | "skipped";
    evidence?: string;                     // path or short value
  }>;
}
```

A phase is **not** passed by reading documents; it is passed when its gate
command emits `status: "passed"`.

---

## Workspace layout

```
alcode/
├── packages/
│   ├── events/            ← envelope/registry (0.0 scaffold, 0.2 fleshed)
│   ├── agent-core/        ← (0.1A) vendored pi loop
│   ├── ai/                ← (0.1B) vendored pi providers
│   ├── coding-agent/      ← (0.1A) app layer + tools + extensions + CLI
│   ├── test-provider/     ← (0.1A) offline fake provider for CI
│   ├── memory/            ← (0.3) Ola, ported JS→TS
│   ├── reasoning/         ← (0.4) Ouroboros, ported Py→TS
│   ├── cognition-runtime/ ← (0.5) coordinator/policy/reinforcement/consolidation
│   └── web/               ← (0.8) React GUI
├── extensions/
│   └── cognition/         ← (0.5) thin orchestration adapter
├── docs/{constitution,rules,event-contract,non-goals,backlog,phase-0-spec}.md
├── docs/adr/              ← architecture decision records
├── docs/{threat-model,operation-recovery}.md
├── docs/provenance/       ← per-import provenance records
├── scripts/gate/          ← executable gate runners (pnpm gate:X.Y)
├── LICENSE
├── THIRD_PARTY_NOTICES.md
├── package.json           ← workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── .github/workflows/ci.yml
```

**Dependency direction (inward flow toward domain contracts):**
`web → coding-agent → {agent-core, cognition-runtime, memory, reasoning} → events`.
`memory` and `reasoning` depend on `events`, never on web, CLI, agent-core
internals, HTTP/MCP transport, provider SDKs, or host paths. The `events`
package is narrow (see `docs/event-contract.md`); domain packages own their
event payloads.

## Storage layout

```
~/.alcode/  (or $ALCODE_HOME for tests)
├── registry.sqlite                       ← workspace registry, single-writer locks (OS lock + diagnostic metadata)
├── gate-receipts/                        ← emitted gate receipts
└── workspaces/<workspace_id>/
    ├── workspace.lock                    ← OS lock file (process-held; not in the repo)
    └── workspace.sqlite                  ← ONE database per workspace
        ├── events
        ├── projection_cursors
        ├── sessions
        ├── operations
        ├── reasoning_nodes
        ├── reasoning_edges
        ├── memories
        ├── memory_stats
        ├── artifacts                     ← content-addressed, by digest
        ├── projection_receipts
        └── schema_migrations
```

SQLite pragmas: WAL mode, foreign keys on, `BEGIN IMMEDIATE` transactions,
`ON CONFLICT … DO UPDATE` upserts, partial unique indexes where needed,
immutable event IDs, monotonic per-workspace event sequence. Binary/large tool
output lives in content-addressed artifact files referenced by digest.

---

## Phase 0.0 — Architecture foundation (CLOSED)

**Objective:** Establish the executable foundation — workspace, minimal
`events` scaffold, test framework, licensing, minimal CI on one platform, and
the four ADRs that resolve the remaining P0 findings. The constitution and
hard rules are already written; this phase makes them *enforced*.

**Inputs:** the constitution, hard rules, event contract; the five P0 findings.

**Implementation scope:**
1. Workspace root: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`.
2. `packages/events` skeleton implementing the envelope (`docs/event-contract.md`):
   branded identity types, `EventProducer`, `correlationId`/`causationEventId`,
   `payloadSchemaVersion`, canonical-JSON serialization, the append/replay
   interfaces. No domain event types yet (those live in their domain packages).
3. `packages/test-provider` — an offline fake LLM provider for CI (returns
   deterministic canned responses; never touches the network).
4. The gate runner harness in `scripts/gate/` with the `GateReceipt` schema.
5. Minimal CI on **one primary platform** (`.github/workflows/ci.yml`) running
   `pnpm gate:0.0`. Tri-platform CI is deferred to 0.1B.
6. The four ADRs (decisions written before the mechanisms they govern):
   - `docs/adr/0001-event-and-projection-commit-semantics.md`
   - `docs/adr/0002-workspace-identity-and-locking.md`
   - `docs/adr/0003-tool-operation-uncertainty-and-recovery.md`
   - `docs/adr/0004-secret-admission-and-erasure.md`
7. `docs/threat-model.md`, `docs/operation-recovery.md`.
8. `LICENSE`, `THIRD_PARTY_NOTICES.md`.
9. A temporary configurable `ALCODE_HOME` env var for tests (default `~/.alcode`).

**Explicit exclusions:** every domain event type; complete memory/reasoning
schemas; deferred identities (`installation_id`, `worktree_id`, `task_id`,
`turn_id`, `model_request_id`, `tool_call_id`, `artifact_id`); multi-agent
identity; distributed runtime; final GUI transport; tri-platform CI;
deterministic import automation (0.1B); upcasting machinery.

**Deliverables:** workspace + `events` scaffold + `test-provider` + gate
runner + CI + the 4 ADRs + threat model + recovery doc + LICENSE/NOTICES.

**Required tests:** `events` unit tests (idempotent append, monotonic
sequence, canonical-JSON determinism, branded-id type safety);
`test-provider` returns deterministic output.

**Exit gate:** `pnpm gate:0.0` emits `status: "passed"` on CI.

**Failure/rollback rule:** if a written ADR is found inconsistent with the
constitution, amend the ADR (ADRs serve the constitution, not vice versa). If
the constitution itself is wrong, amend via a documented constitutional change.

**Dependencies:** none — root.

**Estimated range:** 2–4 working days.

---

## Phase 0.1A — Minimal agent loop with offline provider (CLOSED)

**Objective:** a runnable owned agent (vendored pi loop semantics) with one
controlled tool, driven by the offline `test-provider`, persisting nothing yet.
Proves acquisition and ownership conversion on a thin slice — *without*
inheriting pi's TUI, provider, or dynamic-extension-loading infrastructure,
which the constitution has chosen not to retain.

**Inputs:** pi `v0.81.1` (commit `20be4b18d4c57487f8993d2762bace129f0cf7c6`,
2026-07-21, MIT); the events scaffold; the test-provider.

**Path:** Path A — import the coherent agent-loop semantic slice; implement
an owned static extension host; define owned provider and tool contracts;
write a fresh headless `bash`. The full pi extension loader/runner and
upstream `bash` are *excluded* under the failure/rollback rule because they
resist ownership conversion (jiti, pi-tui, pi-ai provider bundle coupling).

**Implementation scope:**
1. **Import commit** (mechanical, quarantined, faithful): copy the agent-loop
   slice from pi `v0.81.1` — `agent-loop.ts`, `agent.ts`, `types.ts`,
   `stream-fn.ts`, `index.ts`, plus any small utility those files directly
   require that is not provider/TUI/persistence/extension-loading
   infrastructure. Upstream headers intact; not yet exported as
   `@alcode/agent-core`; not yet in the workspace build (the 0.0 gate stays
   green). Record exact source paths and SHA-256 checksums in
   `docs/provenance/pi.md`.
2. **Ownership-conversion commit** (separate, authored):
   - rename to `@alcode/agent-core`; remove pi branding;
   - identify the exact provider operations the loop calls and define the
     smallest ALCODE-owned interface (`ModelProvider`, `ModelRequest`,
     `ModelStream`, `ModelEvent`) — do NOT copy broad `pi-ai` type
     definitions (that would reproduce provider coupling under a new
     namespace); keep compatibility types in a temporary conversion adapter
     only where the imported code requires them;
   - adapt `TestProvider` to the `ModelProvider` interface;
   - define an owned `AgentTool<TInput, TResult>` interface with
     `execute(input, context)`;
   - implement a minimal owned **`StaticExtensionHost`** (NOT pi's dynamic
     loader): `AgentExtension { name; register(ctx) }` and
     `ExtensionContext { registerTool; onBeforeModelRequest?;
     onAfterModelResponse? }`. The host mounts extensions statically (no
     `jiti`, no runtime TS loading, no marketplace). This proves the seam
     where the cognition spine will mount in 0.5;
   - write a fresh headless `bash` tool against the owned `AgentTool`
     interface (no pi-tui): explicit working directory (cwd scoping, NOT a
     filesystem sandbox), captured stdout/stderr, exit code, timeout, abort
     handling, output-size bound, no child process intentionally left running
     after completion/timeout/cancellation (tree-kill via process group or
     taskkill /T), clear result for failed/cancelled/timed-out. No filesystem
     or network sandbox is claimed — actual containment belongs before the
     bash tool is exposed to untrusted model-generated commands. The result
     retains enough raw facts (stdout, stderr, exitCode, durationMs) for the
     0.2 outcome/effect-certainty state machine, but that integration is 0.2;
   - CLI skeleton: `alcode -p "hello"` against the test-provider (offline,
     deterministic). Live providers are 0.1B.

**Explicit exclusions:** pi `tui`/`server`/`storage`; pi-ai provider
implementations, OAuth, compat bundles; `jiti` and the dynamic extension
loader/runner; upstream `bash.ts` (depends on pi-tui); the other 6 tools
(0.1B); live provider integrations (0.1B); deterministic import automation
(0.1B); tri-platform CI (0.1B).

**Deliverables:** runnable `alcode` with owned loop + `StaticExtensionHost`
+ fresh `bash` + offline provider; import and ownership-conversion commits
as separate reviewable units; provenance record with checksums.

**Required tests:** imported-slice semantics preserved (loop runs a
single-turn + single-tool-call against the test provider); offline
`alcode -p "hello"` integration test; a static test extension mounts and
either registers a tool or observes a lifecycle hook; `bash` executes a
controlled command in a disposable repository and the process exits cleanly
with no surviving child.

**Exit gate:** `pnpm gate:0.1A` emits `status: "passed"`. Proves:
(1) provenance points to exact tag/commit; (2) imported-file checksums
recorded; (3) agent-core typechecks and tests pass; (4) `alcode -p "hello"`
returns the deterministic offline response; (5) no network access or
provider credential required; (6) a static test extension mounts
successfully; (7) the extension registers the bash tool or observes one
lifecycle hook; (8) bash executes a controlled command in a disposable
repository; (9) the process exits cleanly with no surviving child;
(10) Phase 0.0 remains green; (11) Linux CI passes.

**Failure/rollback rule:** if a pi module resists ownership conversion
(loader, runner, upstream bash all meet this condition — they drag in
jiti/pi-tui/pi-ai provider bundle), exclude it and log to backlog — do not
fork-patch pi internals in 0.1A. This rule is *invoked* by this phase for
the listed modules.

**Dependencies:** 0.0.

**Estimated range:** 3–5 days.

---

## Phase 0.2 — Minimal durable vertical slice (CLOSED)

**Objective:** prove the event-log-as-truth architecture end-to-end on a thin
slice, before any Ola/Ouroboros port. The load-bearing proof.

**Inputs:** 0.1A's runnable agent; the `events` scaffold from 0.0; ADRs 0001–0004.

**Implementation scope:**
1. Implement the `events` package for real: append (monotonic per-workspace
   sequence, idempotent on `eventId`), replay, registry. Single-writer OS
   lock per workspace (per ADR 0002).
2. Define the minimal event types needed for this slice, **owned by their
   domains** (NOT by `events`):
   - runtime/session domain: `runtime.session.started`, `runtime.session.stopped`
   - transcript/agent domain: `user.message.appended`, `assistant.message.appended`, `tool.requested`, `tool.started`, `tool.completed`, `tool.failed`
   - reasoning (minimal): `objective.set` (single objective node — no full graph)
   - memory (minimal): `memory.created` (one record — no scoring)
3. Implement the **transaction model** from ADR 0001: append in one txn;
   projections applied idempotently in separate txns; cursor advanced with
   each projection's writes; startup replays from lagging cursors.
4. Classify the minimal projections:
   - **Inline:** sequence allocator (atomic with append).
   - **Critical:** operations registry (status readable before tool returns);
     transcript (an operation isn't complete until its messages are visible).
   - **Derived:** reasoning_nodes (minimal), memories (minimal).
5. Implement the **operation state machine** from ADR 0003 (`requested →
   started → succeeded | failed | cancelled | timed_out | indeterminate`)
   including the `indeterminate` → reconciliation-only path.
6. Implement the **secret redaction gate** from ADR 0004: env-var filtering +
   pattern detection run **before** event append; redacted payloads use
   `secretref:` references.
7. Wire the agent loop + `bash` tool to emit events for every state change.
   The agent still operates on its in-memory transcript (verbatim projection);
   events are a side-effect shadow proving plumbing.
8. Open `workspace.sqlite` at session start; replay events at reopen; verify
   projection cursor == event sequence.

**Explicit exclusions:** scoring, full graph, falsifiers, projection of LLM
context from events yet (agent uses its native transcript). Point is durability
plumbing + the four P0 mechanisms, not cognition.

**The exact gate (must pass all):**
```
start runtime → resolve workspace → append user-message event → request model response →
execute one controlled tool → append operation and result events →
update minimal reasoning projection (objective) → create/retrieve one memory →
stop process → reopen same workspace → replay/recover → resume with identical durable state
```

**Required invariants (enforced by tests):** one workspace DB; one writer (OS
lock); strictly increasing event sequence; no repository-local mutable files;
no detached children (tool process observed to exit); each projection cursor
≤ event sequence; deleting a derived projection and rebuilding from events
produces an equivalent projection; resume does not duplicate events;
`indeterminate` operations are not auto-retried; known secret sources are
redacted before persistence.

**Required tests:** the gate test itself; the invariants as separate tests;
crash tests (after event append / before projection completion / during
operation / after external mutation / before final commit → reopen → recover);
a secret-redaction test (env var value, common token format, structured tool
field never enter the DB).

**Exit gate:** `pnpm gate:0.2` emits `status: "passed"`. **Do not begin the
full Ola or Ouroboros ports until this passes.**

**Failure/rollback rule:** if durability cannot be proven on the slice, the
architecture is wrong — surface it, do not paper over. This phase validates
principles 1–4 and resolves P0 findings 2–5.

**Dependencies:** 0.1A; ADRs 0001–0004.

**Estimated range:** 1–2 weeks (load-bearing — do not compress).

---

## Phase 0.1B — Remaining tools, live providers, reproducibility

**Objective:** complete the agent's tool set and live-provider integrations,
and harden reproducibility. Run in parallel with or after 0.2.

**Inputs:** 0.1A's runnable agent; remaining pi tools; pi `packages/ai`.

**Implementation scope:**
1. Vendor the remaining 6 tools (`read`, `write`, `edit`, `grep`, `ls`,
   `find`) + support files.
2. Vendor pi `packages/ai` for live providers (OpenAI, Anthropic, …).
3. **Deterministic import script** (URL, commit, paths, checksums) — provenance
   becomes reproducible, not developer-local.
4. **Tri-platform CI** (Windows, Linux, macOS).
5. Pinned package manager, TypeScript toolchain, runtime version.
6. Live-provider smoke tests (opt-in, gated on API keys; never in default CI).

**Explicit exclusions:** none beyond non-goals.

**Deliverables:** full tool set; live providers; reproducible import;
tri-platform CI; pinned toolchain.

**Required tests:** each new tool; live-provider smoke (opt-in); CI green on
all three platforms.

**Exit gate:** `pnpm gate:0.1B` emits `status: "passed"` on tri-platform CI.

**Failure/rollback rule:** a flaky platform is allowed to skip with documented
reason, not silently pass.

**Dependencies:** 0.1A; can overlap with 0.2/0.3/0.4.

**Estimated range:** 3–7 days.

---

## Phase 0.3 — Memory semantic core (Ola port)

**Objective:** `packages/memory` is a real TS package, behaviorally equivalent
to Ola's semantic core, validated by differential evidence.

**Inputs:** `C:/Next-Era/Ola/` (Node/JS); its `ARCHITECTURE.md`.

**Implementation scope (port directly):**
- Schemas: `lessons`, `playbooks` → TS types + Zod.
- Stable `memory_id = "<type>/<slug>.md"`.
- Retrieval scoring: `0.65·relevance + 0.20·structural + 0.15·strength` +
  exact-match override.
- Strength/decay: Ebbinghaus formula; `consolidationCount` every 5 uses.
- Reinforcement doctrine: `recordUse` vs `recordSeen`; inject vs search modes.
- Lifecycle: active → archived → tombstoned → deleted; immutable records,
  mutable sidecar stats.
- Provenance (`sourceEventIds`), usage statistics, lexical retrieval.
- `MemoryRecord` shape (see Ola ARCHITECTURE.md).

**Redesign, do NOT port mechanically:** ZCode hooks, transcript-DB coupling,
detached workers, offload-drain launcher, old migration machinery,
plugin-specific env resolution, host-specific directory assumptions. Detached
workers replaced by the supervised scheduler.

**Differential evidence (incremental, not blocking):** golden JSON from working
JS Ola for: scoring, exact-match override, reinforcement (use vs seen),
lifecycle transitions, decay-over-time. TS port must match.

**Explicit exclusions:** dense/vector retrieval (backlog); offload/task-tracking
surface; R2 migration; phase-0 chunk/judge scripts.

**Deliverables:** `packages/memory` semantic core; ported + differential tests;
the `memory` derived projection consuming `memory.*` events.

**Required tests:** unit (each formula); differential (golden corpus); the
reinforcement doctrine as invariant tests.

**Exit gate:** `pnpm gate:0.3` emits `status: "passed"` (all ported Ola
contract tests green; differential fixtures match; no detached-worker patterns).

**Failure/rollback rule:** if a formula doesn't match golden output, the port
is wrong — fix the port, never relax the fixture.

**Dependencies:** 0.2 (the event spine); can overlap with 0.4.

**Estimated range:** 3–7 days.

---

## Phase 0.4 — Reasoning semantic core (Ouroboros port)

**Objective:** `packages/reasoning` is a real TS package, behaviorally
equivalent to Ouroboros's core, validated by differential evidence.

**Inputs:** `C:/Next-Era/Ouroboros/ouroboros/` (Python); the 14 core modules (~5,332 LOC).

**Implementation scope (port semantically, in order):**

- *Mechanical (days 1–2):* `types`, `artifacts` (NodeKind/EdgeKind),
  `cognitive`, `predicates`, `state`, `graph`, `critic`, `branching`.
- *Attention-requiring (days 3–4):* `engine`, `reducer`, `diagnostics`,
  `verification`. Reducer's deterministic IDs and diagnostics BFS must match
  Python exactly.
- *Design-decision (days 4–6):* `session_store` (→ `better-sqlite3`; preserve
  WAL/`BEGIN IMMEDIATE`/upserts/partial unique index/migrations; restructure
  `append_events` callback-in-lock to build-payload-then-locked-append);
  `cognitive_service` (drop session-resolution-by-workspace for now).

**Drop entirely (~11,300 LOC):** `mcp_server`, `mcp_invocation`,
`invocation_gateway`, `lifecycle_*`, `reconciliation*`, `native_projection`,
`register_governed_tool`, `trace_*`, `sidecar`, `qualification`,
`clock_calibration_v2`, `command_signature`, `attribution`, `hash_schemas`,
`activation`, and the `hooks/` dir.

**Preserve guarantees in native form (not mechanisms):** per the source-doc
table — invocation correlation → `operation_id` + event correlation; durable
receipts → operation/tool lifecycle events; exclusive activation →
task/operation ownership txn; etc.

**Differential corpus (3 + 1 families, staged):**
1. Normal deterministic flow (objective→hypothesis→verification plan→evidence→conclusion).
2. Duplicate and replay (idempotence, uniqueness, replay from zero / from cursor).
3. Crash and reopen (interrupt at each boundary → recover).
4. (Small) Falsifier or conflicting-evidence path.

Expand during the port: branching, unsupported conclusions, verification
classifications, malformed inputs, migrations, rollback, concurrent ownership.

**Explicit exclusions:** MCP/governance apparatus; Python plumbing tests;
full ~12-category golden corpus up front.

**Deliverables:** `packages/reasoning`; the `reasoning` derived projection
consuming `objective.set`/`hypothesis.created`/`evidence.linked`/`falsifier.evaluated`/etc.;
ported core tests + 4 differential families.

**Required tests:** ported core-reasoning tests (~3,900 LOC); the 4
differential families; deterministic-behavior invariants.

**Exit gate:** `pnpm gate:0.4` emits `status: "passed"` (all ported reasoning
tests green; all 4 differential families match Python golden output).

**Failure/rollback rule:** a golden mismatch means the port drifted — fix it
before proceeding. Never ship a reasoning port that fails a differential fixture.

**Dependencies:** 0.2; can overlap with 0.3.

**Estimated range:** 1–2 weeks.

---

## Phase 0.5 — Durable cognition integration

**Objective:** the `extensions/cognition` adapter binds the agent loop to
memory + reasoning via domain events. The spine is alive.

**Inputs:** 0.1A/0.1B (loop + extension API + tools); 0.3 (memory); 0.4
(reasoning); 0.2 (event log).

**Implementation scope:**
- Split into thin extension + coordinator package (do NOT let the extension
  become a monolith):
  ```
  extensions/cognition/{index,event-adapter,tool-registration,projection-hook}.ts
  packages/cognition-runtime/{coordinator,policy,reinforcement,consolidation}.ts
  ```
- The extension only binds pi lifecycle events to coordinator calls. No memory
  policy, reducer semantics, evidence rules, or consolidation algorithms in it.
- The coordinator owns: when a tool result becomes evidence; when memory is
  reinforced; when a hypothesis must be verified; when consolidation runs;
  when diagnostics should block completion.
- **Lifecycle mapping (split `tool_call` into explicit stages):**
  - `session_start`: resolve workspace/task, open store, replay projections,
    recover interrupted operations, recall memory, orient reasoning.
  - `turn_start`: append user input, update objective, compile context (still
    verbatim — 0.6/0.7), request model.
  - `before_tool_call`: validate permission, create operation, record decision,
    establish verification contract if relevant, freeze args.
  - `tool_call_started/completed/failed/cancelled`: capture structured result,
    classify evidence, link only through explicit verification semantics,
    update reasoning, reinforce memory.
  - `turn_end`: critic + diagnostics, consolidate if policy allows, completion
    assessment, persist projection receipt.
  - `session_stop`: flush state, mark operations, write resumability
    checkpoint, release ownership (release OS lock).
- Register agent-callable tools: `recall`, `remember`, `commit_hypothesis`,
  `record_assumption`, `defer_alternative`, `record_decision`, `link_evidence`,
  `orient`, `diagnose`.

**Explicit exclusions:** graph context compiler (0.7); user-facing hooks (0.9);
MCP/ACP (0.9).

**Deliverables:** the cognition extension + coordinator; integration tests
covering the full lifecycle mapping.

**Required tests:** integration (prompt→model→tool→event→reasoning
update→memory update→projection→resume); crash tests (terminate before event
commit / after tool start / after external mutation / before tool-result
commit / during projection update / during consolidation → verify recovery);
concurrency (two tool calls, two sessions conflict, duplicate event delivery,
cancelled request, concurrent reinforcement).

**Exit gate:** `pnpm gate:0.5` emits `status: "passed"` — the Ouroboros 0.20
continuity proof reproduced in ALCODE: kill process mid-task, reopen,
`resume → orient → act` with state intact; **Agent replacement/restart does
not invalidate Host-owned execution identity or durable state** — the Host
supervises the Agent, so replacing or restarting the Agent process preserves
operation identity, session state, and canonical events; all
crash/concurrency tests pass.

**Failure/rollback rule:** if cognition semantics leak into the extension,
refactor — the boundary is a hard rule.

**Dependencies:** 0.2, 0.3, 0.4.

**Estimated range:** 1–2 weeks.

---

## Phase 0.6 — Verbatim context compiler

**Objective:** establish the safe baseline — context construction
behaviorally identical to pi today, but emitted from the event log + projections.

**Inputs:** 0.1A (pi's native transcript behavior); 0.5 (cognition running).

**Implementation scope:**
- Implement `convertToLlm` Projection A (verbatim): `messages + tool calls +
  tool results → provider-compatible context`, sourced from the transcript
  projection. The regression oracle.

**Explicit exclusions:** graph projection (0.7).

**Deliverables:** the verbatim compiler; setting `alcode.projection`
(value: `verbatim` for now).

**Required tests:** parity tests — same model request produced by ALCODE's
verbatim compiler vs pi's native conversion, on a corpus of transcripts.

**Exit gate:** `pnpm gate:0.6` emits `status: "passed"` (token-identical or
behaviorally equivalent on the parity corpus).

**Failure/rollback rule:** this is the fallback for 0.7 — must be rock-solid
before 0.7 ships.

**Dependencies:** 0.5.

**Estimated range:** 3–5 days.

---

## Phase 0.7 — Graph context compiler and experiment framework

**Objective:** Projection B (graph-distilled) as a measured experiment with
receipts and fail-safe fallback. **Not default until it wins on pre-registered
objective evaluation.**

**Inputs:** 0.4 (reasoning projection); 0.3 (memory projection); 0.6 (verbatim fallback).

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
  (mode, compiler version, source event sequence, receipt digest, token
  budget, fallback status) + full receipt in `projection_receipts`:
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
- **Fail-safe → verbatim** when: reasoning projection invalid; event/projection
  sequence disagree; required constraints missing; unknown schema; incomplete
  provenance; token compilation fails.
- **Pre-register evaluation metrics BEFORE collecting the first A/B result.**
  The phase records that registration must happen before results are visible;
  the registration itself (primary metric, safety guardrail, secondary
  metrics, model/provider config, task corpus, promotion/rollback thresholds)
  is a deliverable of this phase, not defined now.

**Explicit exclusions:** making graph the default (deferred until measured).

**Deliverables:** the graph compiler; receipt machinery; A/B harness; the
pre-registered evaluation protocol.

**Required tests:** fallback triggers on each fail-safe condition; receipts
complete and accurate; A/B metrics captured.

**Exit gate:** `pnpm gate:0.7` emits `status: "passed"` (graph projection runs
as a toggle; receipts inspectable; fallback proven; pre-registered protocol
exists; A/B data being collected). Default stays `verbatim` until graph
measurably wins under the pre-registered protocol.

**Failure/rollback rule:** any fail-safe condition → automatic fallback to
verbatim, logged. Never ship a graph projection that can silently produce
invalid context.

**Dependencies:** 0.5, 0.6.

**Estimated range:** 1–2 weeks.

---

## Phase 0.8 — React GUI

**Objective:** streaming React UI over the stable application event transport.

**Inputs:** open-harness `ui-stream.ts` + React provider (MIT); qwen webui patterns (Apache-2.0, reference only).

**Implementation scope:**
- Port open-harness's streaming layer (`ui-stream.ts`, `provider.tsx`,
  `transport.ts`, hooks) → `packages/web`.
- Build UI primitives: message timeline, reasoning stream, tool cards
  (read/write/edit/bash/grep kinds), permission prompts, file diffs,
  cancellation, task/session switcher, resumability status, diagnostics,
  memory + reasoning inspectors, **projection mode + receipt view**.
- **Transport contract defined before UI build:** event sequence, reconnect
  behavior, resume cursor, stream cancellation, duplicate-event handling,
  tool progress, permission round-trip, terminal completion. Frontend consumes
  ordered application events, never reads DB state directly.

**Explicit exclusions:** full graph visualization (backlog); multi-agent kanban
(v2 direction).

**Deliverables:** the GUI; transport contract doc.

**Required tests:** transport reconnect/resume/duplicate-event tests;
rendering tests for each primitive.

**Exit gate:** `pnpm gate:0.8` emits `status: "passed"` (run `alcode`, get a
streaming React UI driving the agent; tool calls render as cards; projection
receipts visible; resumability observable).

**Failure/rollback rule:** GUI must be a client of the runtime — no domain
logic in the frontend. If transport contracts aren't stable, delay UI coupling.

**Dependencies:** runtime transport and cognition contracts stable (0.5).

**Estimated range:** 1–2 weeks.

---

## Phase 0.9 — External integrations

**Objective:** hooks, MCP, ACP, code intelligence — each as an integration
layer over owned lifecycle events, never authoritative state owners.

**Implementation scope (each independently shippable):**
- **User-facing hooks:** port qwen-code's `hooks/` (HookEventName,
  CommandHookConfig + HttpHookConfig + matchers + SSRF guards) onto ALCODE
  lifecycle events. Hooks must not silently become authoritative state owners.
- **MCP client:** port kimi-code's `connection-manager.ts` + 3-tier
  `config-loader.ts`. MCP stays external.
- **MCP server (optional):** expose selected capabilities to other hosts;
  reference qwen's `mobile-mcp`.
- **ACP:** port kimi-code's `acp-adapter/` so `alcode acp` connects to the
  same runtime as GUI/CLI (not a second state-owning loop).
- **Code intelligence:** the `CodeIntelligence` interface
  (`indexWorkspace`, `searchSymbols`, `findReferences`, `retrieveContext`);
  first impl may call the `codebase-memory-mcp` binary (MIT, source in
  library), workspace-scoped + commit-aware + invalidation-aware + cancellable
  + external to repo source.

**Explicit exclusions:** making any of these mandatory for v1; letting any
integration own state.

**Deliverables:** each integration as a separate module; tests per integration.

**Exit gate:** `pnpm gate:0.9` emits `status: "passed"` (each integration works
against the runtime without becoming a state owner; security model enforced).

**Estimated range:** 1–2 weeks total, parallelizable. Outside critical path
until transport/cognition contracts stabilize.

---

## Migration (post-0.5, when worth doing)

Freeze Ola/Ouroboros repos as behavioral references. Define export/import
contracts (Ola: memories/stats/tombstones/provenance; Ouroboros:
sessions/graph nodes/edges/events/verification contracts/evidence). Import
into ALCODE with count validation, ID validation, digest verification, graph
integrity check, retrieval-sample comparison, source-provenance preservation,
migration receipt. **Never point the new runtime at old live databases.**

---

## Phase 0 estimated total range

```
0.0  Architecture foundation (CLOSED):          2–4 days
0.1A Minimal agent loop + offline provider:    2–4 days    [CLOSED]
0.2  Minimal durable vertical slice:           1–2 weeks   [CLOSED]
0.1B Remaining tools, live providers, repro:   3–7 days
0.3  Memory semantic core (Ola):               3–7 days
0.4  Reasoning semantic core (Ouroboros):      1–2 weeks
0.5  Durable cognition integration:            1–2 weeks
0.6  Verbatim context compiler:                3–5 days
0.7  Graph context compiler + experiment:      1–2 weeks
0.8  React GUI:                                1–2 weeks
0.9  External integrations:                    1–2 weeks (parallelizable)
---------------------------------------------
Internal alpha:                               ~6–11 weeks
```

Estimates are ranges, not commitments. Gates drive sequencing, not calendars.
