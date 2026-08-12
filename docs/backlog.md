# ALCODE Architecture Backlog

Items deferred from Phase 0 with the condition under which each becomes relevant.
Nothing here is silently dropped; each becomes active when its trigger fires.

## Identities (deferred from 0.0)

Frozen now: `workspace_id`, `repository_id`/`repositoryId`, `session_id`,
`event_id`, `operation_id`, `memory_id`, `reasoning_node_id`, `event_sequence`,
`schema_version`.

- `installation_id` — when multi-machine sync or licensing matters.
- `repository_id` (now `repositoryId`) — **PROMOTED and implemented before 0.2**
  (see "Workspace identity" below). A path cannot be "only an attribute" and
  simultaneously the sole durable identity used to recognize moves.
- `worktree_id` — when subagent isolation uses git worktrees.
- `task_id` — when a unit of work spans sessions (long-horizon tasks).
- `turn_id` — when turn-level attribution is needed for receipts/analytics.
- `model_request_id` — when per-request tracing/provenance is needed. Phase 0.7
  deliberately uses protocol correlation + durable context receipt identity
  rather than promoting this identity solely for inference refresh.
- **branded/global `tool_call_id` identity** — Phase 0.6 now preserves the
  provider/model `toolCallId` end-to-end across assistant content,
  `ToolExecutionContext`, Agent Protocol capability request/result, and durable
  tool-result transcript state. It is explicitly distinct from Host
  `operation_id`. Promoting it into the foundational branded identity set or
  event envelope remains deferred until cross-domain identity guarantees
  require that stronger contract.
- `artifact_id` — if content-addressed digests are insufficient as handles.

## Required before Phase 0.2 (completed promotion)

These items were deferred in an earlier draft and were promoted before the
0.2 vertical slice because the 0.2 gate could not prove its invariants without
them. This section is retained as decision history; it is not pending work.

### Workspace identity and resolution protocol

- Stable `repositoryId` independent of path (installation-assigned UUID).
  A path cannot be "only an attribute" and the sole durable identity.
- Identity vs recognition split (ADR 0002): `repositoryId` (stable primary
  key), `repositoryLineage` (shared-clone hint), `repositoryFingerprint`
  (mutable recognition evidence), `workspaceId` (execution/state scope).
- How a path is initially assigned a `repositoryId` and `workspaceId`.
- Recognition policy: same-filesystem move via filesystem object identity;
  known path alias updates the registry; cross-filesystem move vs clone is
  inherently ambiguous and requires explicit `alcode workspace link`.
- Whether worktrees share or separate workspace state (default: share
  repositoryId, separate workspaceId).
- Content hashing never claims to distinguish a move from a clone.
- See ADR 0002 for the identity model and the locking protocol.

### Secret detection and pre-persistence redaction

- Environment-variable filtering (known secret sources).
- Pattern and entropy-based detection (common token formats, structured tool fields).
- Redacted payloads use `secretref:` references, never raw values.
- Tests proving known secret sources are caught before persistence.
- The enforceable guarantee (not absolute exclusion — see `docs/rules.md`):
  known secret sources and detected secret patterns are redacted or rejected
  before persistence; raw secret values must never be intentionally persisted.
- Incident handling for a secret that evades detection (see `docs/threat-model.md`).
- See ADR 0004.

## Memory (deferred from 0.3)

Phase 0.3 is closed. The items below were deliberately excluded from its
semantic-engine gate and remain backlog items rather than reasons to reopen it.

- Dense / vector retrieval. Phase 0.3 ships lexical; dense enters when lexical
  recall quality is the bottleneck. Embeddings via the local fastembed pattern
  Ola/mnemopi use.
- Auto-skill minting (sandboxed + staged, per qwen-code's
  `skillReviewAgentPlanner.ts`). Becomes active when the agent has enough
  green sessions to distill from. Hard requirement: forked sub-agent under
  permission sandbox + pending dir for user confirmation (the fix for the
  qwen #4437 overwrite bug).

## Reasoning (deferred from 0.4)

Phase 0.4 is closed. These items require a new concrete need; they do not
extend the accepted reasoning-port gate.

- `command_signature.py` equivalent (shell tokenizer for test-runner
  classification). Defer because the agent loop knows tool intent directly;
  only needed if verification must classify arbitrary shell commands.
- Additional differential corpus categories beyond the frozen Phase 0.4
  families. Reactivate only when a new reasoning surface or concrete defect
  requires additional oracle evidence; do not expand the closed 0.4 corpus by
  default.

## Host/runtime (deferred after 0.6)

Phases 0.5–0.6 proved a local Node IPC Agent Protocol, Host-owned capability
execution, bounded event-sourced cognition work, replaceable-Agent continuity,
and Host-owned durable transcript/context reconstruction. The following remain
deliberately outside the closed foundation:

- remote Agent transport / public wire encoding;
- general scheduler or recurring automation;
- distributed claims / leases / remote workers;
- browser execution subsystem;
- task/workflow engine and `task_id` lifecycle;
- remote workspace backends.

Activate only when a later authorized product requirement needs them.

## Context projection (deferred from 0.7)

Phase 0.7 now has a frozen design but has not started. These remain explicitly
deferred outside that frozen acceptance boundary:

- Making graph projection the product default. Stays non-default until an
  explicit post-evaluation promotion decision is authorized after measurable
  evidence.
- Provider-exact tokenization/context-window management. Activate if the
  deterministic hard rendered-character bound plus approximate planning metric
  is insufficient for provider-window safety.
- LLM-generated summarization/semantic compaction. Activate only when bounded
  deterministic selection cannot meet context-cost requirements safely.
- Static-turn-selection + dynamic-overlay optimization. The frozen 0.7 design
  uses full Host recompilation at every inference boundary; split overlays may
  be considered only after measured compilation cost justifies the added policy
  layer.
- Graph visualization UI (full). 0.8 ships inspectors only.

## GUI (deferred from 0.8)

- Full graph visualization.
- Multi-agent kanban (agent-teams-ai style) — v2 product direction.

## Integrations (deferred from 0.9)

- Multi-writer transactional store coordination (if single-writer ownership
  becomes a real bottleneck with concurrent ALCODE instances).
- MCP server mode (expose ALCODE capabilities to other hosts). Optional.
- Additional extension events beyond the reduced stable taxonomy.

## Subagents

- Promote pi's `examples/extensions/subagent/` (1,016 LOC, single/parallel/chain)
  to first-class when subagent dispatch is needed. Not on Phase 0 critical path.

## Dynamic extension loading (deferred from 0.1A)

- **pi's dynamic extension loader/runner** (`packages/coding-agent/src/core/
  extensions/{loader,runner,wrapper}.ts` from `v0.81.1`) — runtime TypeScript
  loading via `jiti`, the 30+ event taxonomy, the `_bundledPi*` provider/TUI
  bundle, and the marketplace/packaging machinery. Excluded from 0.1A under
  the failure/rollback rule because it resists ownership conversion (couples
  to `jiti`, `pi-tui`, `pi-ai` provider bundle). 0.1A ships an owned
  `StaticExtensionHost` instead (contracts only: `AgentExtension`,
  `ExtensionContext`).
- **Phase 0.5 outcome:** runtime-loaded cognition extensions were not needed.
  A thin statically-owned cognition adapter behind `@alcode/agent-protocol`
  satisfied the replaceable-Agent boundary.
- **Reactivation trigger:** user-installed/runtime-loaded extensions become a
  product requirement, or a future authorized phase demonstrates a concrete
  need for dynamic loading. Port deliberately then; do not introduce the pi
  loader as a side effect of unrelated work.

## Process / scope

- Any pi module excluded from 0.1 ownership conversion due to upstream coupling.
  Log here with the specific blocker.
- Any architectural question that surfaces during a phase but is not required
  for that phase's exit gate. Log here rather than expanding scope.
