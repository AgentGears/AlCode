# ALCODE Hard Rules

Constraints that apply to every phase. These operationalize the constitution.
Violations are bugs, not style preferences. Foundational event shape,
identity, and serialization live in `docs/event-contract.md`; transaction,
locking, uncertainty, secret, and runtime-ownership rules live here and in the
ADRs.

## Runtime and process

- **One writer per workspace.** A workspace state root has exactly one owning
  Host/runtime at a time. Exclusion is enforced by a **process-held OS lock**
  under `~/.alcode/` (never inside the repository); owner metadata is written
  to `registry.sqlite` for diagnostics. A database row alone is insufficient —
  PID reuse and abrupt termination leave stale ownership ambiguous. The OS
  lock releases on process exit; PID metadata is never sufficient evidence for
  forcibly breaking a lock. See `docs/adr/0002-workspace-identity-and-locking.md`.

- **Cross-platform lock primitives.** The ADR specifies the lock file location,
  the primitive per platform (Windows: `LockFileEx`; POSIX: `flock` /
  `O_EXCL` marker), acquisition/release behavior, owner metadata, abrupt-
  termination release semantics, and behavior on networked or unsupported
  filesystems (fail closed: do not pretend to hold a lock that is not real).

- **No detached, unowned production workers.** Every child process is bounded,
  cancellable, retained/observed by its owning Host subsystem, and observed to
  exit. Background cognition work uses the Host-owned durable-work dispatcher
  and canonical `runtime.work.*` state; Phase 0.5 activates only bounded
  `memory.consolidation`. General scheduler leases, remote workers, cron, and
  recurring automation are not implied by this rule.

- **Agent process lifetime is not session lifetime.** The Host owns the durable
  session. Agent exit/replacement does not by itself append
  `runtime.session.stopped`, discard operation identity, erase canonical
  cognition, or erase canonical transcript history. A replacement Agent
  resumes through the Agent Protocol and is hydrated/oriented from Host-owned
  durable state. See ADR 0005 and the closed Phase 0.5/0.6 plans.

- **No compatibility process whose purpose is to preserve an obsolete boundary.**
  "No bridge, no sidecar" means no process exists solely to keep a Python or
  ZCode-era boundary alive. It does NOT mean the entire application must be one
  OS process — supervised Agent/tool child processes are allowed when the Host
  retains authority and lifecycle observation.

## State, storage, and transactions

- **Mutable state lives under `~/.alcode/`, never inside source repositories.**
  Repositories are observed; runtime state is external. A moved repository
  must not lose its memory or reasoning history — which requires a stable
  `repository_id` independent of path (see identity, below).

- **One SQLite database per workspace** (`~/.alcode/workspaces/<id>/workspace.sqlite`).
  Tables include `events`, `projection_cursors`, `sessions`, `operations`,
  `reasoning_nodes`, `reasoning_edges`, `memories`, `memory_stats`,
  `transcript_messages`, `artifacts`, `projection_receipts`, and
  `schema_migrations`. The event log remains canonical even when projection
  tables are updated separately.

- **The locked store remains opaque outside storage/Host-owned facades.**
  Agent/extension code does not receive the raw SQLite handle. Host cognition
  and context reconstruction use bounded read models rather than crossing the
  database handle into the Agent.

- **Strictly increasing event sequence per workspace.** `event_sequence` is
  monotonic; resume must not duplicate events; `append` is idempotent on
  `eventId` (re-appending an existing event is a no-op).

- **Event append and projection commits follow a precise model** (see
  `docs/adr/0001-event-and-projection-commit-semantics.md`):
  1. Append immutable events in **one transaction**. Assigns `sequence` and `recordedAt`.
  2. Apply each projection **idempotently** in a **separate transaction**.
  3. Advance that projection's cursor **in the same transaction** as its updates.
  4. On startup, replay from every lagging cursor.

- **Host state-changing admission is serialized.** Canonical Host writes route
  through one admission queue so semantic validation, symbolic reasoning
  reference resolution, transcript transition validation, and event append
  observe a stable ordering. Semantic engines return intents/effects; they do
  not append canonical events directly.

- **Transcript validation and append are one Host admission critical section.**
  Rich assistant/tool-result transcript transitions are validated against a
  stable canonical transcript state and appended under the same serialized
  Host admission operation. A separate read-validate-append sequence is a
  TOCTOU bug.

- **Projections have three states, not two:**
  - **Inline state** — updated atomically with event append; part of the write
    model. Rare; only for state that must be consistent with the log at append
    time (e.g. the sequence allocator).
  - **Critical projection** — separate transaction, but the operation is **not
    reported complete** until this projection has caught up to the event.
    Example: the operation registry, and transcript admission where the ACK
    promises a readable durable result.
  - **Derived projection** — separate transaction, may lag without blocking
    operation completion. Example: reasoning graph, memory materialization, or
    a context-receipt summary when the canonical receipt event already records
    the decision. Rebuilt from events on demand.

- **Every projection maintains a cursor** (`projection_name`,
  `last_applied_event_sequence`, `projection_schema_version`). A projection can
  be deleted and rebuilt from events; rebuilding produces an equivalent projection.

## Tool operations and uncertainty

- **Environmental capability execution is Host authority.** The Agent may
  request a capability through the Agent Protocol; it does not directly own the
  environmental process or durable operation lifecycle. Before execution, Host
  policy runs and requested/started/action state is durably visible. A denied
  request must not start the operation or execute the capability.

- **Provider tool-call identity and Host operation identity are distinct.** The
  provider/model `toolCallId` is preserved end-to-end through Agent tool
  execution, Host capability request/result correlation, and durable transcript
  tool results. `operationId` remains the separate Host-owned durable execution
  identity; neither substitutes for the other.

- **Operations have a state machine across three dimensions** (see ADR 0003):
  - **ExecutionOutcome:** `succeeded` | `failed` | `cancelled` | `timed_out`
  - **EffectStatus:** `confirmed` | `absent` | `indeterminate` | `not_applicable`
  - **ReconciliationStatus:** `not_required` | `pending` | `resolved` | `unresolved`

  An operation whose `EffectStatus` is `indeterminate` is **never
  auto-retried**. A crash can occur after a shell command mutated the
  repository but before `tool.completed` persisted; on restart the runtime
  cannot know whether the command ran, failed, or partially ran. `failed`,
  `cancelled`, and `timed_out` default to `indeterminate` — failure does not
  prove the effect did not occur. Read-only tools declare `not_applicable`.

- **`indeterminate` resolves only via reconciliation.** It does not transition
  to `confirmed` merely because the process restarted. Reconciliation produces
  evidence → `ReconciliationStatus: "resolved"` and `EffectStatus` updated to
  `confirmed`/`absent`; or `ReconciliationStatus: "unresolved"` with
  `EffectStatus` staying `indeterminate`, surfacing to the user. See
  `docs/operation-recovery.md`.

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

- **Incident handling for a secret that evades detection** follows ADR 0004's
  Model A (physical security-redaction exception): revoke/rotate the credential,
  record a `security.redaction_applied` audit event (no secret), rewrite the
  physical store to remove the value in place, rebuild projections, and verify
  absence in place. Sidecar redaction alone is *masking, not erasure* — it
  hides the value from replay but the raw value persists in the SQLite row,
  WAL, and backups. See `docs/threat-model.md` and ADR 0004.

## Cognition boundaries

- **The cognition extension is a thin Agent-side adapter.** It may register
  Agent-facing proxy tools and translate selected Agent lifecycle evidence onto
  `@alcode/agent-protocol`. It must NOT own storage, workspace locking, memory
  policy, reasoning reduction, evidence semantics, capability execution,
  context selection, or consolidation algorithms.

- **The Host is the authority boundary between Agent and cognition state.**
  The implemented flow is:

  ```text
  Agent / cognition extension
          ↓ Agent Protocol request
  Host cognition gateway + canonical admission
          ↓
  cognition-runtime + memory/reasoning semantic engines
          ↓ validated semantic effect
  Host-owned canonical event(s)
          ↓
  rebuildable projections
  ```

  `@alcode/cognition-runtime` returns orientation/policy/assessment results; it
  does not own SQLite or append canonical events.

- **Memory retrieval is not memory truth mutation.** Search recall records
  `seen`; direct explicit use records `used`; every fifth use may request the
  bounded consolidation work proven in 0.5. Search visibility alone must not
  strengthen a memory as if it were applied.

- **Context inclusion is not memory reinforcement.** Merely selecting or
  rendering a memory into model context does not mean the model used it and
  must not record `seen`, `used`, or consolidation state by itself.

- **Verification linking remains conservative.** Trusted unique verification
  may add epistemic support/contradiction; untrusted unique matching records
  execution correlation only; ambiguous/unmatched outcomes do not create a
  verification correlation event.

- **Agent idle is evidence, not completion authority.** Only the Host performs
  the final durable session stop after the frozen completion policy is
  satisfied.

- **Hooks must not silently become authoritative state owners.** User-facing
  hooks are an integration layer over owned lifecycle events; their outputs are
  advisory unless explicitly promoted.

- **MCP stays external.** ALCODE may consume external MCP tools and expose
  selected capabilities later, but internal memory/reasoning/Host cognition
  uses owned typed contracts, never MCP as the internal state boundary.

## Transcript and context boundaries

- **Durable transcript is Host-canonical before later inference.** Newly
  admitted rich assistant and tool-result messages must cross the serialized,
  Host-validated, Host-acknowledged transcript barrier before the Agent may
  begin the subsequent model request. `transport.send()` alone is not durable
  acknowledgement.

- **Incomplete transcript is reconstructable but not continuable.** An
  outstanding durable assistant tool call without a durable matching tool
  result is preserved as incomplete state. The runtime does not fabricate a
  result, silently discard the call, or auto-retry it to manufacture a
  continuable transcript.

- **The Agent's conversation cache is disposable.** Canonical transcript state
  and context authority remain Host-owned. Replacement Host/Agent processes can
  reconstruct `verbatim-v1` from durable state; no Agent-local transcript or
  checkpoint file may become authoritative.

- **Verbatim context is the closed safety baseline.** `verbatim-v1` is
  reconstructable from canonical events and remains the product/default context
  strategy unless a later explicitly authorized decision changes that default.
  `graph-v1` may not silently replace it.

- **Selective context is Host observation policy.** The Agent does not own
  context selection, reasoning traversal, memory search, trust classification,
  graph/verbatim mode choice, fallback, or receipt persistence.

- **Every graph-capable provider inference requires a fresh Host context
  decision.** A 0.7-capable Agent must await Host context refresh immediately
  before each `ModelProvider.stream()`, including later provider requests in the
  same user turn. A turn-start graph snapshot may not be reused after tool,
  cognition, operation, verification, or workspace state changes.

- **Canonical context source uses one event cut; workspace state is a separate
  observation.** Transcript/reasoning/memory/operation context derives from one
  captured `sourceEventSequence`. Filesystem/Git state is explicitly timed and
  provenanced; the system does not claim a transaction across SQLite and the
  external worktree.

- **Canonical does not mean control-authoritative.** Source-derived memory,
  objectives, hypotheses, assumptions, decisions, evidence and workspace data
  cannot acquire Host-control authority merely because they are persisted.
  Graph context must distinguish Host control, Host-observed facts, verified
  evidence, epistemic claims, advisory memory and unverified data, with
  source-derived values structurally escaped as data.

- **Graph budgeting has a real hard bound.** The 0.7 graph policy enforces a
  deterministic post-render serialized-character bound. Approximate
  `chars4-v1` token cost is diagnostic/comparative only and must not be
  described as a provider-independent token upper bound. Required graph facts
  are never silently dropped; overflow falls back to verbatim without claiming
  verbatim satisfies the graph bound.

- **Reasoning context is objective-scoped.** Context selection does not equate
  "all active hypotheses" with the current reasoning frontier. The required
  frontier follows the current objective and closed graph relations to include
  operative hypotheses, linked falsifiers, active decisions, verification
  obligations, blocking diagnostics/implicated paths and decisive evidence.
  Ambiguous scope fails safely to verbatim rather than guessing.

- **Memory strength cannot create context relevance.** Automatic memory context
  requires positive exact/relevance/structural eligibility before applying the
  closed Phase 0.3 ranking. No-positive-match inputs select no memory rather
  than using strength alone. Context insertion itself records no `seen`/`used`.

- **Context receipts are bounded audit decisions.**
  `context.projection_compiled` records source, attempted policy, effective
  delivery, fallback, selected provenance, bounded exclusion summaries,
  candidate-universe digest and request-environment digest. It must not grow by
  storing every rejected historical candidate.

- **Context/audit meta-events are not cognition facts.** A context receipt must
  not become reasoning evidence, memory provenance fallback, task-world
  observation, or context-source content merely because it is a recent
  canonical event.

- **Graph closure does not imply graph promotion.** `verbatim-v1` remains the
  product default after Phase 0.7 closure. At least one preregistered fixture
  must prove non-vacuous effective graph delivery and context reduction, but
  promotion remains a separate explicit evidence-based decision.

- **Phase 0.7 is frozen but not started.** The binding design/acceptance
  contract lives in `docs/phase-0.7-plan.md`. No implementation is authorized
  merely by the existence of the frozen plan.

## Security

- **Local runtime security** (for future GUI/backend split): bind to loopback
  only; use an ephemeral auth token; restrict state-file permissions; reject
  foreign origins; validate workspace paths; prevent path traversal.

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
