# ALCODE Hard Rules

Constraints that apply to every phase. These operationalize the constitution.
Violations are bugs, not style preferences. Foundational event shape,
identity, and serialization live in `docs/event-contract.md`; transaction,
locking, uncertainty, and secret rules live here.

## Runtime and process

- **One writer per workspace.** A workspace state root has exactly one owning
  runtime at a time. Exclusion is enforced by a **process-held OS lock** under
  `~/.alcode/` (never inside the repository); owner metadata is written to
  `registry.sqlite` for diagnostics. A database row alone is insufficient —
  PID reuse and abrupt termination leave stale ownership ambiguous. The OS
  lock releases on process exit; PID metadata is never sufficient evidence for
  forcibly breaking a lock. See `docs/adr/0002-workspace-identity-and-locking.md`.

- **Cross-platform lock primitives.** The ADR specifies the lock file location,
  the primitive per platform (Windows: `LockFileEx`; POSIX: `flock` /
  `O_EXCL` marker), acquisition/release behavior, owner metadata, abrupt-
  termination release semantics, and behavior on networked or unsupported
  filesystems (fail closed: do not pretend to hold a lock that is not real).

- **No detached, unowned production workers.** Every child process is:
  recorded (spawn event in the log); bounded (timeout enforced); cancellable
  (the runtime retains a handle); observed to exit (exit code captured); and
  absent after cleanup (verified, not assumed). Background work runs under a
  supervised scheduler that owns the lease, materialization, commit, and
  completion observation. The prior detached-worker failure class
  (~1,100 orphaned spawns) must not recur.

- **No compatibility process whose purpose is to preserve an obsolete boundary.**
  "No bridge, no sidecar" means no process exists solely to keep a Python or
  ZCode-era boundary alive. It does NOT mean the entire application must be one
  OS process — supervised child processes for risky tool execution are allowed
  and the runtime retains handles.

## State, storage, and transactions

- **Mutable state lives under `~/.alcode/`, never inside source repositories.**
  Repositories are observed; runtime state is external. A moved repository
  must not lose its memory or reasoning history — which requires a stable
  `repository_id` independent of path (see identity, below).

- **One SQLite database per workspace** (`~/.alcode/workspaces/<id>/workspace.sqlite`).
  Tables: `events`, `projection_cursors`, `sessions`, `operations`,
  `reasoning_nodes`, `reasoning_edges`, `memories`, `memory_stats`, `artifacts`,
  `projection_receipts`, `schema_migrations`. The event log remains canonical
  even when projection tables are updated in the same or separate transactions.

- **Strictly increasing event sequence per workspace.** `event_sequence` is
  monotonic; resume must not duplicate events; `append` is idempotent on
  `eventId` (re-appending an existing event is a no-op).

- **Event append and projection commits follow a precise model** (see
  `docs/adr/0001-event-and-projection-commit-semantics.md`):
  1. Append immutable events in **one transaction**. Assigns `sequence` and `recordedAt`.
  2. Apply each projection **idempotently** in a **separate transaction**.
  3. Advance that projection's cursor **in the same transaction** as its updates.
  4. On startup, replay from every lagging cursor.

- **Projections have three states, not two:**
  - **Inline state** — updated atomically with event append; part of the write
    model. Rare; only for state that must be consistent with the log at append
    time (e.g. the sequence allocator).
  - **Critical projection** — separate transaction, but the operation is **not
    reported complete** until this projection has caught up to the event.
    Example: the operation registry (an operation's status must be readable
    before a tool call returns).
  - **Derived projection** — separate transaction, may lag without blocking
    operation completion. Example: reasoning graph, memory store, transcript.
    Rebuilt from events on demand.

- **Every projection maintains a cursor** (`projection_name`,
  `last_applied_event_sequence`, `projection_schema_version`). A projection can
  be deleted and rebuilt from events; rebuilding produces an equivalent projection.

## Tool operations and uncertainty

- **Operations have a state machine:**
  ```
  requested → started → succeeded | failed | cancelled | timed_out
                       ↘ indeterminate
  ```
  An `indeterminate` operation is **never auto-retried**. A crash can occur
  after a shell command mutated the repository but before `tool.completed`
  persisted; on restart the runtime cannot know whether the command ran,
  failed, or partially ran.

- **`indeterminate` resolves only via reconciliation.** It does not transition
  to `succeeded` merely because the process restarted. A reconciliation
  operation must produce evidence and then resolve to a terminal state:
  `reconciled_succeeded` or `reconciled_failed`, or remain `unresolved`.
  See `docs/operation-recovery.md`.

- **The honest guarantee is "effectively once where supported, otherwise detect
  and preserve uncertainty."** Restrict "exactly once" to operations with
  genuine idempotency keys or transactional control. For arbitrary tool
  mutations, the system detects uncertainty and surfaces it rather than
  silently retrying or silently assuming success.

## Secrets and redaction

- **Redaction occurs before event persistence, not at projection time.**
  User messages and tool results are common locations for credentials and
  private data; once a raw secret hits an append-only log, tombstones do not
  remove it. The pipeline:
  - environment-variable filtering (known secret sources);
  - pattern and entropy-based secret detection (common token formats,
    structured tool fields);
  - redacted event payloads (secret replaced with a `secretref:` reference);
  - policy for encrypted artifacts and key destruction;
  - tests proving redaction markers behave correctly and known secret sources
    are caught.

- **The enforceable guarantee** (not absolute exclusion — no entropy or pattern
  detector can promise that):
  > Known secret sources and detected secret patterns are redacted or rejected
  > before persistence; raw secret values must never be intentionally persisted.

- **Secrets must never enter** model context unless explicitly needed, memory
  records, tool logs without redaction, projection receipts, repository files,
  or exported diagnostics. See `docs/threat-model.md`.

- **Incident handling for a secret that evades detection** is documented in
  `docs/threat-model.md`: the event is marked tainted, downstream artifacts are
  purged, and the affected event row is quarantined (the log is append-only,
  so the value is overwritten with a redaction marker in a sidecar rather than
  row-deleted — see the threat model for the exact mechanism).

## Cognition boundaries

- **The cognition extension is a thin orchestration adapter.** It binds
  lifecycle events to coordinator calls. It must NOT contain memory policy,
  reducer semantics, evidence rules, or consolidation algorithms. Those live
  in `packages/cognition-runtime`. Flow:
  `extension event adapter → cognition coordinator → memory/reasoning commands → domain events`.

- **Hooks must not silently become authoritative state owners.** User-facing
  hooks are an integration layer over owned lifecycle events; their outputs are
  advisory unless explicitly promoted.

- **MCP stays external.** ALCODE may consume external MCP tools (as MCP client)
  and expose selected capabilities (as MCP server), but memory and reasoning
  internally use typed calls, never MCP.

## Security

- **Local runtime security** (for GUI/backend split): bind to loopback only;
  use an ephemeral auth token; restrict state-file permissions; reject foreign
  origins; validate workspace paths; prevent path traversal.

- **Extension trust:** declared permissions; capability restrictions;
  installation provenance; version pinning; disable/recovery mode.

## Provenance and licensing

- **Every imported codebase gets a provenance record** (repo, commit, license,
  imported files, modifications, attribution). See `docs/provenance/`.

- **Full ownership means maintenance and direction, not stripping copyright.**
  Third-party license notices are preserved in `LICENSE` and `THIRD_PARTY_NOTICES.md`.

## Gates

- **Every phase gate is an executable command** (`pnpm gate:0.0`,
  `pnpm gate:0.1A`, …) that emits a machine-readable `GateReceipt` (stable
  JSON schema in `docs/phase-0-spec.md`). A gate is not "passed" by reading
  documents; it is passed when the command emits `status: "passed"`.
