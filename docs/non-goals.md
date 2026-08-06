# ALCODE Phase 0 — Explicit Non-Goals

Things Phase 0 deliberately does NOT do. Each is captured here so it is not
silently dropped; deferred items also appear in `docs/backlog.md` with the
condition under which they become relevant.

## Architecture (deferred from Phase 0.0)

- Defining every event type. The `events` package defines the envelope +
  registry mechanism only. Domain packages own their event payloads and types
  emerge with each phase.
- The complete memory schema and the complete reasoning schema. Only the
  subsets needed for each phase's exit gate.
- The full identity model. Phase 0.0 freezes only: `workspace_id`, `session_id`,
  `event_id`, `operation_id`, `memory_id`, `reasoning_node_id`, plus
  `event_sequence` and `schema_version`. Deferred identities (until required):
  `installation_id`, `repository_id`, `worktree_id`, `task_id`, `turn_id`,
  `model_request_id`, `tool_call_id`, `artifact_id`.
- Multi-agent identity. One agent, one workspace, one writer for v1.
- Distributed runtime behavior. Single-writer, single-host.
- Every extension event. The pi event taxonomy is reviewed and reduced to
  stable domain events; upstream events are not preserved indefinitely.
- Final GUI transport contract (settled in 0.8, not 0.0).
- Final plugin compatibility (ALCODE owns its extension contract; pi
  compatibility is not a goal).

## Implementation (deferred from later phases)

- **pi `tui` package** — dropped entirely. GUI arrives in 0.8.
- **pi `server` and `storage` packages** — replaced by the event-log
  architecture. Not ported.
- **pi example extensions** (except `subagent`, which is backlog-referenced
  only, not ported in Phase 0).
- **Dense / vector retrieval** in the memory package. Phase 0.3 ships lexical
  retrieval; dense retrieval enters backlog.
- **Ola offload / task-tracking surface, R2 migration, phase-0 chunk/judge
  scripts** — not ported.
- **Ouroboros MCP/governance apparatus** (~11,300 LOC): `mcp_server`,
  `mcp_invocation`, `invocation_gateway`, `lifecycle_*`, `reconciliation*`,
  `native_projection`, `register_governed_tool`, `trace_*`, `sidecar`,
  `qualification`, `clock_calibration_v2`, `command_signature` (the agent knows
  tool intent directly), `attribution`, `hash_schemas`, `activation`, and the
  `hooks/` dir. Dropped.
- **Ouroboros plumbing tests** (~73% of test LOC). Only the core-reasoning
  tests (~3,900 LOC) and the 3+1 differential families are ported.
- **The full ~12-category golden corpus up front.** Phase 0.4 starts with
  normal flow, duplicate/replay, crash/reopen, and a small falsifier/conflict
  fixture. The corpus expands iteratively as semantic areas activate.
- **Making graph projection default.** Projection B ships behind a toggle in
  0.7 and stays non-default until it measurably wins.
- **Full graph visualization in the GUI.** 0.8 ships inspectors, not a graph UI.
- **Multi-agent kanban** (agent-teams-ai style). That is a v2 product
  direction, not a v1 build item. The spine supports it later.

## Migration (post-0.5, when worth doing)

- Pointing the new runtime at old live Ola/Ouroboros databases. Migration uses
  explicit export/import contracts with receipts — never direct DB reuse.
- Simultaneously adding major new architecture to both old and new
  implementations. Old repos are frozen as behavioral references during
  construction.

## Process

- Calendar-driven deadlines. Phase 0 is gate-driven; estimates are ranges, not
  commitments. AI assistance accelerates mechanical translation but does not
  eliminate semantic mismatch, concurrency defects, recovery design, provider
  quirks, UI transport bugs, or cross-platform process behavior.
- Automatic upstream merges from pi. Upstream changes enter as deliberately
  evaluated patches once ALCODE has diverged.
