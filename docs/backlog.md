# ALCODE Architecture Backlog

Items deferred from Phase 0 with the condition under which each becomes relevant.
Nothing here is silently dropped; each becomes active when its trigger fires.

## Identities (deferred from 0.0)

Frozen now: `workspace_id`, `session_id`, `event_id`, `operation_id`, `memory_id`,
`reasoning_node_id`, `event_sequence`, `schema_version`.

- `installation_id` — when multi-machine sync or licensing matters.
- `repository_id` (now `repositoryId`) — **PROMOTED to required-before-0.2**
  (see "Workspace identity" below). A path cannot be "only an attribute" and
  simultaneously the sole durable identity used to recognize moves.
- `worktree_id` — when subagent isolation uses git worktrees.
- `task_id` — when a unit of work spans sessions (long-horizon tasks).
- `turn_id` — when turn-level attribution is needed for receipts/analytics.
- `model_request_id` — when per-request tracing/provenance is needed.
- `tool_call_id` — when tool-call correlation across events needs a stable id
  (currently `operation_id` covers the single-tool case).
- `artifact_id` — if content-addressed digests are insufficient as handles.

## Required before Phase 0.2 (promoted from deferred)

These three were deferred in an earlier draft and are now required before the
0.2 vertical slice, because the 0.2 gate cannot prove its invariants without them.

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

- Dense / vector retrieval. Phase 0.3 ships lexical; dense enters when lexical
  recall quality is the bottleneck. Embeddings via the local fastembed pattern
  Ola/mnemopi use.
- Auto-skill minting (sandboxed + staged, per qwen-code's
  `skillReviewAgentPlanner.ts`). Becomes active when the agent has enough
  green sessions to distill from. Hard requirement: forked sub-agent under
  permission sandbox + pending dir for user confirmation (the fix for the
  qwen #4437 overwrite bug).

## Reasoning (deferred from 0.4)

- `command_signature.py` equivalent (shell tokenizer for test-runner
  classification). Defer because the agent loop knows tool intent directly;
  only needed if verification must classify arbitrary shell commands.
- Additional differential corpus categories (beyond the 3+1 starter families):
  branching, unsupported conclusions, verification classifications, malformed
  inputs, database migrations, rollback, concurrent ownership. Expand during
  the port as each semantic area activates.

## Context projection (deferred from 0.7)

- Making graph projection default. Stays non-default until it measurably wins
  on the A/B task suite.
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

## Process / scope

- Any pi module excluded from 0.1 ownership conversion due to upstream coupling.
  Log here with the specific blocker.
- Any architectural question that surfaces during a phase but is not required
  for that phase's exit gate. Log here rather than expanding scope.
