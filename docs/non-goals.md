# ALCODE Phase 0 — Explicit Non-Goals

Things Phase 0 deliberately does NOT do. Each is captured here so it is not
silently dropped; deferred items also appear in `docs/backlog.md` with the
condition under which they become relevant.

## Architecture (deferred from Phase 0.0)

- Defining every event type up front. The `events` package defines the envelope
  and registry mechanism; domain packages own their event payloads and types
  emerge with each implemented phase.
- A universal/final memory or reasoning schema beyond the semantics required by
  the closed 0.3/0.4 engines and their additive integration events.
- The full identity model. Phase 0 has implemented `workspace_id`,
  `repository_id`/`repositoryId`, `session_id`, `event_id`, `operation_id`,
  `memory_id`, `reasoning_node_id`, `event_sequence`, and `schema_version`.
  Phase 0.6 also preserves the provider/model `toolCallId` end-to-end as a
  conversational/protocol correlation identity, distinct from `operation_id`.
  Still deferred until required: `installation_id`, `worktree_id`, `task_id`,
  `turn_id`, `model_request_id`, promotion of `tool_call_id` into the
  foundational branded/event-envelope identity set, and `artifact_id`.
- Multi-agent identity. The current foundation proves one supervised Agent at a
  time behind a replaceable protocol boundary, one workspace writer, and
  Host-owned durable authority.
- Distributed runtime behavior. The implemented runtime is single-writer,
  single-Host; remote Agent transport and distributed claims are deferred.
- Every extension event. The pi event taxonomy is reviewed and reduced to
  stable domain/Agent Protocol semantics; upstream events are not preserved
  indefinitely.
- Final GUI/application transport contract (settled in 0.8, not in the current
  foundation).
- Final plugin compatibility (ALCODE owns its extension contract; pi
  compatibility is not a goal).

## Implementation (deferred from later phases)

- **pi `tui` package** — dropped entirely. GUI arrives in 0.8.
- **pi `server` and `storage` packages** — replaced by the event-log/Host
  architecture. Not ported.
- **pi example extensions** (except `subagent`, which is backlog-referenced
  only, not ported in Phase 0).
- **Dense / vector retrieval** in the memory package. Phase 0.3 ships lexical
  retrieval; dense retrieval remains backlog work.
- **Ola offload / task-tracking surface, R2 migration, phase-0 chunk/judge
  scripts** — not ported.
- **Ouroboros MCP/governance/runtime apparatus:** `mcp_server`,
  `mcp_invocation`, `invocation_gateway`, `lifecycle_*`, `reconciliation*`,
  `native_projection`, `register_governed_tool`, `trace_*`, `sidecar`,
  `qualification`, `clock_calibration_v2`, `command_signature`, `attribution`,
  `hash_schemas`, `activation`, and the `hooks/` dir. Phase 0.4 ports reasoning
  semantics, not the runtime that happened to host them.
- **Ouroboros plumbing tests** outside the source-faithful reasoning core and
  frozen differential families. Additional oracle coverage requires a concrete
  future need; it is not unfinished Phase 0.4 work.
- **General scheduler/automation.** Phase 0.5 implements only bounded,
  event-sourced durable cognition work (`memory.consolidation`) needed to prove
  supervised recovery and idempotent semantic effect. Cron, recurring work,
  priorities, distributed leases, and remote workers remain deferred.
- **Remote Agent transport/public wire encoding.** Phase 0.5 implements the
  semantic Agent Protocol with local Node IPC; remote transports remain later
  adapters.
- **Replacing or weakening the closed `verbatim-v1` safety baseline as a side
  effect of context experimentation.** Phase 0.6 owns durable verbatim
  reconstruction; a later graph strategy must remain Host-selected and retain
  fail-safe verbatim behavior unless an explicit promotion decision changes the
  product default.
- **LLM-generated context summarization/semantic compaction as implicit Phase
  0.7 scope.** The current 0.7 plan is only a draft and proposes deterministic
  selection/rendering; provider-exact tokenizers and generated compaction remain
  deferred unless the reviewed/frozen plan explicitly activates them.
- **Making graph projection default.** A graph strategy may be evaluated behind
  an explicit Host strategy boundary, but product-default promotion requires a
  separate evidence-based decision after measured results.
- **Full graph visualization in the GUI.** 0.8 ships inspectors, not a graph UI.
- **Multi-agent kanban** (agent-teams-ai style). That is a v2 product direction,
  not a current Phase 0 foundation item.

## Migration (post-0.6, when worth doing)

- Pointing the new runtime at old live Ola/Ouroboros databases. Migration uses
  explicit export/import contracts with receipts — never direct DB reuse.
- Simultaneously adding major new architecture to both old and new
  implementations. Old repos remain behavioral references rather than shared
  live state owners.

## Process

- Calendar-driven deadlines. Phase 0 is gate-driven; estimates are ranges, not
  commitments. AI assistance accelerates mechanical translation but does not
  eliminate semantic mismatch, concurrency defects, recovery design, provider
  quirks, UI transport bugs, or cross-platform process behavior.
- Automatic upstream merges from pi. Upstream changes enter as deliberately
  evaluated patches once ALCODE has diverged.
