# ALCODE Hard Rules

Constraints that apply to every phase. These operationalize the constitution.
Violations are bugs, not style preferences.

## Runtime and process

- **One writer per workspace.** A workspace state root has exactly one owning
  runtime at a time. A second runtime attempting to open the same workspace
  must fail clearly with the owner identified, not silently coordinate writes.
  (Single-writer model for v1; multi-writer transactional coordination is
  deferred — see backlog.)

- **No detached, unowned production workers.** Every child process is:
  - recorded (spawn event in the log);
  - bounded (timeout enforced);
  - cancellable (the runtime retains a handle);
  - observed to exit (exit code captured); and
  - absent after cleanup (verified, not assumed).
  The prior detached-worker failure class (~1,100 orphaned spawns) must not
  recur. Background work runs under a supervised scheduler that owns the lease,
  materialization, commit, and completion observation.

- **No compatibility process whose purpose is to preserve an obsolete boundary.**
  "No bridge, no sidecar" means no process exists solely to keep a Python or
  ZCode-era boundary alive. It does NOT mean the entire application must be one
  OS process — supervised child processes for risky tool execution are allowed
  and the runtime retains handles.

## State and storage

- **Mutable state lives under `~/.alcode/`, never inside source repositories.**
  Repositories are observed; runtime state is external. A moved repository must
  not lose its memory or reasoning history.

- **One SQLite database per workspace** (`~/.alcode/workspaces/<id>/workspace.sqlite`).
  Tables: `events`, `projection_cursors`, `sessions`, `operations`,
  `reasoning_nodes`, `reasoning_edges`, `memories`, `memory_stats`, `artifacts`,
  `projection_receipts`, `schema_migrations`. One transaction boundary; clean
  workspace isolation; exact correlation between event append and projection
  update. The event log remains canonical even when projections update in the
  same transaction.

- **Every projection maintains a cursor** (`projection_name`,
  `last_applied_event_sequence`, `projection_schema_version`). A projection can
  be deleted and rebuilt from events.

- **Strictly increasing event sequence per workspace.** `event_sequence` is
  monotonic; resume must not duplicate events.

## Ports and verification

- **Differential evidence, not translated tests alone.** Before changing a
  working original (Ola/Ouroboros), generate frozen golden JSON fixtures from
  it. The TS port must match the golden output. Translated tests can drift
  with the implementation; differential fixtures cannot.

- **Ports preserve guarantees, not mechanisms.** When a Python/MCP mechanism is
  dropped, the guarantee it provided must survive in a native ALCODE form
  (e.g., invocation correlation → `operation_id` + event correlation). Mechanism
  changes; guarantee remains where still relevant.

- **Deterministic behavior ports exactly.** Event-to-node mapping, graph
  ordering, reducer idempotence, verification classification, critic output,
  falsifier semantics, diagnostic traversal, transaction behavior. Optimize for
  behavioral equivalence, not superficial TypeScript style.

## Cognition boundaries

- **The cognition extension is a thin orchestration adapter.** It binds
  lifecycle events to coordinator calls. It must NOT contain memory policy,
  reducer semantics, evidence rules, or consolidation algorithms. Those live in
  `packages/cognition-runtime`. Flow:
  `extension event adapter → cognition coordinator → memory/reasoning commands → domain events`.

- **Hooks must not silently become authoritative state owners.** User-facing
  hooks are an integration layer over owned lifecycle events; their outputs are
  advisory unless explicitly promoted.

- **MCP stays external.** ALCODE may consume external MCP tools (as MCP client)
  and expose selected capabilities (as MCP server), but memory and reasoning
  internally use typed calls, never MCP.

## Security

- **Secrets never enter** model context unless explicitly needed, memory records,
  tool logs without redaction, projection receipts, repository files, or exported
  diagnostics.

- **Local runtime security** (for GUI/backend split): bind to loopback only;
  use an ephemeral auth token; restrict state-file permissions; reject foreign
  origins; validate workspace paths; prevent path traversal.

- **Extension trust:** declared permissions; capability restrictions;
  installation provenance; version pinning; disable/recovery mode.

## Provenance and licensing

- **Every imported codebase gets a provenance record** (repo, commit, license,
  imported files, modifications, attribution). See `docs/provenance/`.

- **Full ownership means maintenance and direction, not stripping copyright.**
  Third-party license notices are preserved.
