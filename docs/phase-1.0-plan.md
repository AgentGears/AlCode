# ALCODE Phase 1.0 — Durable ProgramState

**Status:** DRAFT — planning in progress; not approved; not frozen; implementation not authorized  
**Planning base:** Phase 0.9 closed and roadmap reconciled  
**Current repository base for this draft:** `main` at `32a8e48a15561a3359695980371bc2c44d8708cf`

> This document is a working Phase 1.0 design/acceptance proposal. It does not become frozen and does not authorize implementation until explicit approval is given. Planning changes may continue until that approval.

**Active planning amendment:** `docs/phase-1.0-artifact-evidence-amendment.md` currently controls the artifact-evidence, verification-freshness, `artifact_present`, AC-10-06, and AC-10-07 clarifications until those changes are consolidated into this document. That amendment is itself draft, not approved, not frozen, and does not authorize implementation.

## 1. Objective

Phase 1.0 is intended to give ALCODE a Host-owned durable unit of work that can outlive any one chat/session, Agent process, Host process, or execution episode.

The proposed unit is **ProgramState**. It is the canonical durable representation of a long-horizon coding objective: the objective itself, bounded work decomposition, dependency state, current attempts, blockers, verification obligations, decisive evidence/artifact references, and terminal completion state.

The target signature result is:

```text
create a multi-step coding ProgramState
→ attach Session A
→ complete only part of the work
→ destroy Agent A and Host A
→ reopen Host B
→ attach Session B to the same ProgramStateId
→ rebuild the exact durable program state
→ dispatch only still-eligible unfinished work
→ reject stale results from Agent A / old attempts
→ re-establish any verification made stale by later mutation
→ satisfy current required verification
→ Host completes the ProgramState exactly once
```

`ProgramStateId` is proposed as the single cross-session durable identity for this phase. Phase 1.0 should not introduce a second competing `TaskId` for the same semantic object.

This phase must not reopen Phases 0.0–0.9. Phase 0.9 CodeIntelligence remains an observation/freshness substrate; ProgramState consumes observations as evidence without turning them into canonical code truth.

## 2. Proposed governing invariants

These invariants are part of the planning proposal and remain open to review until explicit approval.

1. **The Host owns ProgramState.** The Agent may propose bounded semantic changes or evidence; it cannot directly append canonical `program.*` events, mutate projections, satisfy verification by assertion, or declare terminal completion.
2. **Program identity is not session identity.** A ProgramState may span multiple sessions. A session may attach to at most one ProgramState. Stopped sessions are not revived to continue a ProgramState.
3. **No transcript reconstruction of task truth.** ProgramState is rebuilt from canonical program events/projections, never by parsing conversation text.
4. **One cross-session identity.** `ProgramStateId` fulfills the long-horizon `task_id` role; a parallel TaskId for the same unit is forbidden in Phase 1.0.
5. **Current attempt validity is explicit.** Every dispatch mints a fresh, non-reusable `ProgramAttemptId`; superseded attempts cannot commit current completion/evidence.
6. **Revision preconditions require exact equality.** For any mutation requiring current state, `expectedProgramRevision === currentProgramRevision`. Missing, malformed, lower, or higher values are rejected before semantic admission.
7. **Ready work is derived, not asserted.** Eligibility is derived from lifecycle, direct dependency completion, blocker state, verification state, active-session state, and active-attempt state.
8. **The dependency structure is a bounded DAG.** Unknown dependencies, self-dependencies, duplicate edges that violate normalization policy, and cycles are rejected at admission.
9. **Phase 1.0 scheduling is globally single-attempt.** At most one active `ProgramAttemptId` exists across the Host Program scheduler at a time. Multi-Program parallelism is successor scope.
10. **No implicit background execution.** Eligibility does not itself authorize dispatch. A ProgramState dispatch requires an explicitly active attached session/execution episode for that ProgramState.
11. **Uncertain external effects remain uncertain.** An indeterminate mutating operation blocks automatic retry and ProgramState completion until existing reconciliation semantics resolve it.
12. **Attempt-originated operations are durably correlated.** ProgramState/ProgramAttempt ownership is mechanically discoverable from canonical operation/evidence correlation.
13. **Verification is current-state indexed.** Required verification is satisfied only for the verification subject generation it actually checked. Relevant later mutation invalidates stale satisfaction.
14. **Completion criteria are closed and deterministic.** The Completion Oracle does not delegate criterion truth to free-text model judgment.
15. **Session completion is not ProgramState completion.** A session may stop while a ProgramState remains active. ProgramState completion is a distinct Host-owned terminal decision.
16. **Program completion is exact-once and serialized.** Completion evaluation and terminal admission linearize on the same canonical admission cut, or are revalidated inside that serialization point before append.
17. **Terminal states are mutually exclusive.** `program.completed` and `program.cancelled` cannot both become canonical for one ProgramState.
18. **Projections are rebuildable.** Deleting/rebuilding derived ProgramState projections from canonical events reproduces the same semantic state and revision.
19. **Observation does not become authority.** CodeIntelligence, Git state, files, model output, tool results, reasoning events, and artifact contents remain evidence/provenance inputs only.
20. **Reasoning and ProgramState remain independent reducers.** Reasoning events may support ProgramState evidence but do not directly satisfy ProgramState obligations or mutate ProgramState; ProgramState transitions do not automatically create reasoning nodes.
21. **Existing product defaults stay unchanged.** `verbatim-v1` remains the product default and `graph-v1` remains opt-in.

## 3. Architecture

```text
Experience Plane / client
          │
          │ session + program commands/read models
          ▼
┌──────────────────────────────────────────────┐
│                 ALCODE HOST                  │
│                                              │
│  ProgramService                              │
│    ├─ canonical admission                    │
│    ├─ ProgramState reducer/projection        │
│    ├─ session attachment                     │
│    ├─ recovery barrier                       │
│    ├─ bounded global scheduler               │
│    ├─ attempt validity / revision checks     │
│    ├─ operation/evidence correlation         │
│    ├─ verification freshness                 │
│    └─ serialized Completion Oracle           │
│                                              │
│  existing Host authority remains:            │
│  policy / capabilities / operations /        │
│  recovery / transcript / context / cognition │
└───────────────┬──────────────────────────────┘
                │ Agent Protocol
                ▼
        ┌───────────────────┐
        │ replaceable Agent │
        │ proposal/evidence │
        │ execution client  │
        └───────────────────┘

CANONICAL EVENT LOG
  program.* + existing runtime/operation/transcript/reasoning events
        │
        └─ rebuildable ProgramState projection
```

### 3.1 Package and ownership split

The current proposal introduces a pure semantic package, `@alcode/program-state`, containing:

- ProgramState domain types;
- deterministic reducer;
- transition validation;
- DAG/dependency validation and eligibility derivation;
- verification freshness derivation;
- bounded public/Agent projection helpers;
- closed completion-criterion evaluation;
- pure Completion Oracle predicate inputs/results.

The package performs no filesystem, SQLite, process, network, model, capability, operation, or scheduler I/O.

`@alcode/host-runtime` owns creation/attachment, canonical event admission, projection catch-up/rebuild coordination, startup recovery barriers, scheduling, attempt issuance, operation/evidence correlation, proposal validation, verification admission, and terminal ProgramState authority.

`@alcode/storage` owns only derived storage/read-model mechanics. The canonical event log remains the source of truth.

### 3.2 Identity and envelope model

Proposed cross-domain identity:

```ts
type ProgramStateId = Branded<"ProgramStateId">; // UUIDv7
```

The canonical event envelope may carry optional `programStateId?: ProgramStateId` so legacy/non-program events remain valid. For events caused by a current ProgramAttempt, ProgramState correlation is mandatory at the relevant operation/evidence boundary.

Program-local identities remain owned by `@alcode/program-state`:

- `ProgramWorkItemId` — stable identity for one work item;
- `ProgramAttemptId` — fresh identity for one dispatch attempt;
- `VerificationObligationId` — stable identity for one required verification obligation;
- `ProgramBlockerId` — stable identity for one explicit blocker.

A `ProgramAttemptId` is never reused after interruption, replacement, completion, failure, session-stop interruption, or Host reopen.

### 3.3 Session attachment and execution authorization

A ProgramState may have many historical sessions, but each session attaches to zero or one ProgramState.

Program creation occurs under a Host session and records the initial attachment. A later session may attach to the same ProgramStateId without reviving an earlier stopped session.

A ProgramState with no active attached execution/session episode remains durable and active but does not dispatch new work. Existing in-flight operations continue under existing operation lifecycle/recovery rules regardless of UI disconnect.

An orderly session stop with a current ProgramAttempt records `program.attempt.interrupted` as part of, or before completion of, the stop transition unless the attempt's underlying work is already terminal. A mere client/UI disconnect without session stop does not itself interrupt the attempt.

### 3.4 ProgramState model

Proposed minimum semantic model:

```ts
interface ProgramState {
  programStateId: ProgramStateId;
  objective: string;
  completionCriteria: CompletionCriterion[];
  lifecycle: "active" | "completed" | "cancelled";
  revision: number;
  workItems: ProgramWorkItem[];
  blockers: ProgramBlocker[];
  verification: VerificationObligation[];
  artifacts: ProgramArtifactReference[];
  attachedSessionIds: string[];
  activeAttempt: ProgramAttempt | null;
  completedAt?: string;
  cancelledAt?: string;
}
```

The objective and completion criteria are proposed immutable after creation for Phase 1.0. Amendment/versioning remains successor scope unless planning later changes this decision.

A work item contains at minimum:

- stable id;
- bounded description;
- direct dependency IDs;
- canonical creation sequence/order key;
- lifecycle `pending | in_progress | awaiting_verification | blocked | completed`;
- optional bounded affected paths;
- required verification obligation IDs;
- decisive canonical evidence references;
- produced Host artifact handles where applicable.

Work-item cancellation is intentionally removed from the Phase 1.0 draft. Program-level cancellation remains available; work topology mutation/cancellation policy can be reconsidered during planning if a concrete requirement emerges.

A work item is eligible only when it is `pending`, all direct predecessors are `completed`, no unresolved blocker applies, the ProgramState is active, an active attached session/execution episode exists, and no ProgramAttempt is active globally.

`ready` is never canonical stored state.

### 3.5 Dependency graph integrity

Work dependencies form a directed acyclic graph.

At `program.work.added` admission the Host/semantic validator must reject:

- unknown dependency IDs;
- self-dependency;
- cycles introduced by the new edge set;
- malformed or over-bound dependency lists.

Duplicate dependency IDs are either rejected or canonicalized according to one deterministic normalization rule selected before approval. Dispatch eligibility depends on direct predecessors only; transitive correctness follows from DAG semantics.

When multiple work items are eligible, deterministic tie-breaking uses canonical work creation sequence, then stable work-item ID if a secondary key is required.

### 3.6 Closed CompletionCriterion contract

`CompletionCriterion` must be a closed, typed, Host-evaluable union rather than free text.

Proposed minimum taxonomy:

```ts
type CompletionCriterion =
  | { kind: "all_required_work_completed" }
  | { kind: "verification_obligation_satisfied"; obligationId: VerificationObligationId }
  | { kind: "artifact_present"; handle: string }
  | { kind: "canonical_evidence_accepted"; evidenceRef: string };
```

The objective remains human/model-readable intent. Unsupported criterion kinds fail creation/admission rather than being delegated to model interpretation.

The final taxonomy remains a planning decision and is not frozen by this draft.

### 3.7 Canonical event families

Proposed semantic families include:

- `program.created`;
- `program.session.attached`;
- `program.work.added`;
- `program.attempt.started`;
- `program.attempt.interrupted`;
- `program.work.awaiting_verification`;
- `program.work.completed`;
- `program.work.blocked` / `program.work.unblocked`;
- `program.verification.required`;
- `program.verification.satisfied`;
- `program.verification.invalidated`;
- `program.verification.waived`;
- `program.artifact.recorded`;
- `program.cancelled`;
- `program.completed`.

Exact payload schemas remain part of planning/implementation design, but semantically distinct facts must not be collapsed.

All ProgramState transitions use the serialized `CanonicalAdmissionQueue` or an equivalent Host-owned single canonical admission lane.

### 3.8 State-indexed validity and attempt claims

When the scheduler dispatches work, the Host first records `program.attempt.started` containing at minimum:

- `ProgramAttemptId`;
- `ProgramWorkItemId`;
- attached `sessionId`;
- Agent generation/request correlation where available;
- ProgramState revision on which the claim was issued.

A mutating Agent proposal concerning dispatched work carries the current attempt ID and `expectedProgramRevision`.

The Host accepts such a proposal only when:

```text
proposal.programStateId == current.programStateId
AND proposal.programAttemptId == current.activeAttempt.id
AND proposal.workItemId == current.activeAttempt.workItemId
AND proposal.expectedProgramRevision == current.revision
AND proposal.agentGeneration/request still owns the attempt
AND current.lifecycle == active
```

Any mismatch is rejected before semantic admission. Both stale-low and impossible/future-high revision values are invalid.

Agent/Host replacement or Host reopen invalidates an orphaned active attempt by durably recording interruption before a new attempt may be issued.

This remains a single-Host validity protocol, not a distributed lease protocol. There are no time-based claim expirations.

### 3.9 Agent proposal boundary

The Agent does not append canonical program events directly. It submits bounded typed proposals that the Host may reject or translate into Host-owned transitions.

Proposed allowed proposal classes include:

- work decomposition/addition proposal;
- work evidence submission;
- work completion request;
- blocker report/resolution evidence;
- verification evidence proposal;
- artifact/evidence reference proposal.

The Host validates bounds, current revision/attempt, DAG integrity, policy, evidence provenance, completion-contract compatibility, and any authorization requirement before admission.

The Agent may not directly authorize or emit canonical:

- `program.verification.satisfied`;
- `program.verification.waived`;
- `program.cancelled`;
- `program.completed`.

A proposal to add work does not mean the Agent owns topology; topology becomes canonical only after Host validation/admission.

### 3.10 Bounded scheduler

The Phase 1.0 scheduler proposal is deliberately minimal:

- event-driven only;
- at most one active ProgramAttempt globally across the Host Program scheduler;
- requires an active attached session/execution episode for the target ProgramState;
- deterministic eligible-work selection by canonical creation order;
- dispatch only after canonical attempt admission;
- no retry after indeterminate external mutation until reconciliation resolves the effect;
- retry mints a new attempt only after the prior attempt is terminal/interrupted and the work is still eligible;
- no timers, polling loops, cron semantics, background worker threads, distributed leases, remote workers, or parallel subagents.

The scheduler reevaluates eligibility after canonical events that may change readiness, including:

- program session attachment/activation;
- work completion;
- work/blocker resolution;
- verification satisfaction/invalidation/waiver;
- attempt interruption/terminalization;
- operation or reconciliation resolution affecting the active attempt.

Host startup does not itself authorize dispatch.

### 3.11 Startup recovery barrier

Before scheduler admission is enabled after Host open/reopen:

```text
canonical log/store recovery
→ ProgramState projection catch-up/rebuild
→ identify orphan active ProgramAttempt
→ durably record interruption idempotently
→ recover/reconcile linked operations and uncertainty state
→ revalidate ProgramState projection
→ enable scheduler admission
```

If the Host crashes while recording interruption, recovery repeats idempotently and must not issue a replacement attempt until interruption/reconciliation state is canonical and current.

### 3.12 Operation and evidence correlation

Any capability operation initiated as part of a ProgramAttempt must be durably discoverable as owned by that ProgramState and ProgramAttempt. The concrete mechanism may extend operation payload/envelope correlation rather than introducing a new operation authority model.

Required semantic rule:

```text
ProgramAttempt → capability operation
=> canonical correlation includes ProgramStateId + ProgramAttemptId (or an equivalent mechanically lossless link)
```

Results from superseded attempts do not become current ProgramState evidence merely because the underlying operation later completes. Reuse requires explicit Host reconciliation/admission under current state.

### 3.13 Verification obligations and freshness

Verification obligations are durable and state-indexed.

Each obligation has a verification subject/freshness generation, provisionally named `verificationEpoch` (the final name remains open). Satisfaction records at minimum:

- obligation ID;
- canonical evidence reference;
- originating work/attempt identity where applicable;
- subject/freshness generation verified;
- deterministic acceptance-predicate result.

A relevant later mutation advances or otherwise changes the subject generation and makes prior satisfaction non-current. The Host records `program.verification.invalidated` or derives an equivalent explicit canonical invalidation fact before Program completion can rely on fresh verification.

Conservative Phase 1.0 freshness rule:

- known affected-path overlap with a verification subject → invalidate;
- uncertain relevance where policy requires freshness → invalidate;
- false representation of stale verification as current → forbidden.

This does not require a canonical ProgramModel/code graph. Phase 0.9 CodeIntelligence may help produce observations, but it does not decide canonical verification truth.

A waiver is explicit, durable, Host-authorized, and records authorization/reason. Agent assertion cannot waive an obligation.

### 3.14 Reasoning graph boundary

ProgramState and the reasoning engine remain separate semantic domains.

- Reasoning may produce hypotheses, evidence links, verification plans, or conclusions useful as advisory evidence.
- A reasoning event may be referenced by a ProgramState evidence admission.
- A reasoning event does not itself satisfy a ProgramState verification obligation.
- ProgramState transitions do not automatically create reasoning nodes.
- The two reducers remain independently rebuildable from canonical events.

### 3.15 External-effect uncertainty

ProgramState composes existing operation/reconciliation semantics.

If a ProgramAttempt performs a mutating operation whose effect becomes `indeterminate`:

- the attempt is not represented as safely retryable;
- the work item cannot complete from that ambiguous result;
- ProgramState completion is blocked;
- no scheduler retry is issued;
- reconciliation must establish a safe state and canonical resolution evidence before continuation.

No ProgramState-level retry loophole may weaken the Phase 0.2 uncertainty doctrine.

### 3.16 Completion Oracle and canonical quiescence

The Completion Oracle is Host-owned. `agent.idle` may trigger evaluation but is not itself a completion predicate.

A ProgramState may emit `program.completed` only when all required predicates hold on the same canonical state cut, including:

- lifecycle is active;
- all required work is completed;
- all mandatory verification is currently satisfied or explicitly waived;
- no unresolved blocker exists;
- no active ProgramAttempt exists;
- no ProgramState-linked operation remains `requested`/`started` or has unresolved indeterminate effect/reconciliation;
- no ProgramState-linked retryable durable work remains incomplete;
- no admitted transcript/tool-call obligation relevant to the attached execution remains unresolved;
- every typed CompletionCriterion evaluates true from canonical state/evidence.

Completion evaluation and append must linearize through one serialized canonical admission point. An implementation may either evaluate inside the admission critical section or revalidate the complete predicate set after entering it immediately before append.

If any conflicting event is admitted first, the completion decision is recomputed and rejected if the predicates no longer hold.

`program.completed` uses a stable ProgramState-derived idempotency key. `program.cancelled` is a distinct terminal fact. Admission must enforce terminal mutual exclusion.

### 3.17 Agent Protocol integration

The current proposal adds a negotiated Agent Protocol capability, `program_state_v1`.

For an attached session, Host-to-Agent structured state includes a bounded ProgramState projection with at least:

- ProgramStateId/revision;
- objective and typed completion criteria;
- current/eligible work summary;
- active attempt identity when any;
- relevant dependency state;
- unresolved blockers;
- current/stale verification state;
- decisive evidence/artifact references required for the step;
- terminal/lifecycle state.

A replacement Agent receives the current structured projection before it may continue ProgramState work.

Prompt-rendered ProgramState summaries remain disposable projections and never replace structured canonical state.

### 3.18 Application/read-model integration

The Host exposes a bounded authoritative ProgramState read model for an attached session. Existing session/transcript/operation surfaces remain valid.

The minimum public projection includes ProgramStateId, objective, lifecycle, work-item status/current item, blocker summary, verification freshness summary, active attempt state, and ProgramState revision.

Phase 1.0 does not require a kanban/task-management product. The Experience Plane never opens the durable store, appends ProgramState events, dispatches attempts, satisfies verification, or decides terminal completion.

## 4. Structural bounds — provisional

Phase 1.0 must have explicit structural limits before approval. The following values are **planning defaults, not frozen values**:

- maximum work items per ProgramState: 256;
- maximum direct dependencies per work item: 32;
- maximum blockers per ProgramState: 128;
- maximum verification obligations per ProgramState: 256;
- maximum evidence references per work item/obligation: 32;
- maximum affected paths per work item: 128;
- maximum objective text: 16 KiB UTF-8;
- maximum work-item description: 8 KiB UTF-8;
- maximum serialized public/Agent ProgramState projection: 256 KiB.

These should be validated against realistic repository tasks before final approval. The final approved contract must contain explicit finite bounds even if the values change.

## 5. Security and trust

- Program objective, work descriptions, affected paths, Agent proposals, code observations, tool output, reasoning output, and artifact contents are untrusted data, not Host instructions.
- Existing secret admission/redaction rules continue before persistence.
- ProgramState must not bypass capability policy, permission prompts, network policy, plugin generation trust, external-process ownership, transcript authority, or operation uncertainty.
- Artifact references reuse the existing Host content-addressed artifact store.
- Agent-provided evidence is not accepted as verified merely because the Agent labels it evidence.
- Attempt/revision rejection occurs before semantic state from that proposal is committed.
- Resource bounds are enforced at admission/projection boundaries.

## 6. Explicit exclusions

Unless planning explicitly changes them before approval, Phase 1.0 excludes:

- a parallel TaskId for the same long-horizon unit;
- portfolio/project hierarchy or multi-Program orchestration;
- per-Program parallel execution or multi-Program parallel scheduler concurrency;
- general-purpose workflow DSL beyond bounded ProgramState work/dependency semantics;
- recurring automation, timers, cron, delayed jobs, reminders, or notifications;
- distributed claims/leases, remote workers, multi-writer coordination, or cloud orchestration;
- parallel subagents, agent teams, worktree isolation, or multi-agent kanban;
- browser execution;
- SSH/WSL/Docker/remote workspace backends;
- marketplace/plugin expansion or model-written runtime plugins;
- MCP server mode;
- public remote Application Protocol wire encoding;
- full ProgramModel/canonical code graph;
- repository-wide automatic impact graph construction;
- probabilistic or LLM-only verifier selection as canonical policy;
- objective amendment/version-history product;
- autonomous ProgramState creation while no Host session exists;
- automatic background execution after Host startup with no active attached execution episode;
- `graph-v1` product-default promotion;
- full graph/memory/context/trace/task inspector UI;
- vector memory, auto-skill minting, or unrelated cognition expansion.

## 7. Provisional acceptance criteria

These acceptance criteria are **not frozen and not approved**. They are the current planning target and may be amended until explicit approval.

### AC-10-01 — ProgramState identity and canonical envelope

`ProgramStateId` is a branded UUIDv7 cross-domain identity. Event/storage envelopes can carry/index optional ProgramStateId without breaking non-program events. No duplicate TaskId is introduced.

Proof target: typing/serialization, SQLite migration/persistence/indexing, reopen/replay, and legacy events with no ProgramStateId.

### AC-10-02 — Deterministic ProgramState model and rebuild

`@alcode/program-state` deterministically reduces validated program events into objective, typed completion criteria, lifecycle, DAG/work state, blockers, verification freshness, artifacts, attachments, active attempt, and revision.

Proof target: delete/rebuild derived ProgramState projection from canonical events and obtain semantic parity.

### AC-10-03 — Cross-session attachment and continuity

One ProgramState survives session stop, Agent replacement, Host close/reopen, and attachment of a later session. Stopped sessions are not revived; one session cannot attach to two ProgramStateIds.

### AC-10-04 — Exact state-indexed attempt validity

Each dispatch mints a fresh ProgramAttemptId. Current-work mutations require the current attempt and exact revision equality.

Required negative proofs include:

```text
expected R16, current R17 → reject
expected R18, current R17 → reject
old Attempt A, current Attempt B → reject
old Agent generation/request → reject
```

Rejected proposals do not mutate canonical ProgramState.

### AC-10-05 — DAG integrity and deterministic bounded scheduling

Dependency admission rejects unknown IDs, self-reference, cycles, and over-bound graphs. Scheduler selection is deterministic and globally single-attempt.

Required negative proof: Host reopens with eligible work but no active attached session/execution episode → no dispatch.

### AC-10-06 — Effect uncertainty and durable attempt correlation

ProgramState/Attempt ownership is mechanically correlated through attempt-originated operation events/evidence. Indeterminate mutation blocks retry and Program completion until reconciliation.

Proof target includes a late operation result from a superseded attempt that cannot become current evidence without explicit Host reconciliation/admission.

### AC-10-07 — Durable verification freshness

Verification obligations are durable/rebuildable and satisfied only by Host-accepted canonical evidence or Host-authorized waiver for the current verification subject generation.

Required proof:

```text
verification satisfied
→ relevant mutation
→ prior satisfaction becomes stale/invalidated
→ Completion Oracle rejects
→ fresh matching verification admitted
→ obligation becomes current again
```

### AC-10-08 — Serialized Completion Oracle and terminal mutual exclusion

Only the Host Completion Oracle may admit `program.completed`. Evaluation and append linearize on one canonical admission cut or are revalidated inside that cut.

Required race proofs:

- conflicting event admitted between preliminary evaluation and completion append causes recheck/rejection;
- `program.completed` versus `program.cancelled` race yields exactly one terminal state;
- completion retry/recovery yields exactly one `program.completed` event.

### AC-10-09 — Recovery barrier and structured Agent integration

Host reopen completes ProgramState catch-up, orphan-attempt interruption, and required reconciliation before scheduler admission. Crash during interruption admission is idempotently recoverable.

An attached/replacement Agent negotiates `program_state_v1`, receives current structured state before acting, and cannot continue a superseded attempt.

### AC-10-10 — Application/read-model projection and ownership

The Host exposes a bounded authoritative ProgramState projection for the attached session. Reconnect/snapshot reads current Host state. Client/UI code does not own durable store access, ProgramState event append, scheduling, verification authority, or completion.

### AC-10-11 — Composed Phase 1.0 gate

If/when implementation is explicitly approved, `pnpm gate:1.0` must compose and pass `pnpm gate:0.9` plus the approved Phase 1.0 checks at the exact final implementation head.

## 8. Required scenario proofs — provisional

### Scenario A — Long-horizon reopen

```text
Program P with work A → B → C
→ Session 1 completes A
→ Host + Agent destroyed
→ Host reopened
→ recovery barrier completes
→ no dispatch while no active attached session exists
→ Session 2 attaches P
→ A remains complete; only B is eligible
→ B/C continue from canonical ProgramState
→ current verification satisfied
→ P completes once
```

### Scenario B — Stale-attempt ABA and exact revision

```text
work B → Attempt X issued to Agent generation 1 at revision R
→ Agent 1 replaced / X interrupted
→ Attempt Y issued to Agent generation 2
→ late Agent 1 result for X arrives
→ Host rejects X
→ proposal with wrong lower or higher revision also rejects
→ Y remains current
```

### Scenario C — Indeterminate mutation

```text
attempt invokes mutating capability
→ external effect may have occurred
→ operation effect = indeterminate
→ no retry
→ Program completion blocked
→ reconciliation resolves effect
→ Host records canonical resolution
→ safe continuation becomes possible
```

### Scenario D — Verification invalidation

```text
mutating work finishes
→ verification V satisfied at epoch E1
→ later relevant mutation changes verification subject
→ V invalidated/stale at E2
→ Agent says "done" / no active attempt
→ Completion Oracle still rejects
→ fresh evidence satisfies V at E2
→ completion may proceed if all other predicates hold
```

### Scenario E — Completion linearization and rebuild

```text
all completion predicates appear satisfied
→ competing blocker/cancel event races completion
→ canonical admission serialization chooses one order
→ completion revalidates and cannot cross the conflicting event
→ terminal state is unique
→ rebuild derived projections from canonical log
→ semantic state remains identical
→ completion retry creates no duplicate terminal event
```

### Scenario F — Recovery crash idempotency

```text
Host dies with active Attempt X
→ reopen begins recovery
→ interruption admission starts
→ Host crashes again
→ reopen repeats recovery
→ exactly one effective interruption fact
→ no replacement attempt before barrier completes
```

## 9. Proposed gate shape

If implementation is later approved, the current gate proposal is:

```text
1.0.compose.0.9
1.0.identity.program-state
1.0.program.reducer
1.0.program.rebuild
1.0.program.session-binding
1.0.program.revision-attempt-freshness
1.0.program.dag
1.0.program.scheduler
1.0.program.operation-correlation
1.0.program.uncertainty
1.0.program.verification-freshness
1.0.program.completion-linearization
1.0.program.recovery-barrier
1.0.agent.program-state
1.0.application.program-projection
1.0.ownership
```

No new platform matrix is proposed solely for pure ProgramState semantics. Existing composed/platform CI remains authoritative unless implementation later introduces a demonstrably platform-sensitive surface.

## 10. Proposed implementation order — not authorized yet

No implementation starts from this draft. If the plan is eventually approved, the current dependency order is:

1. ProgramStateId identity/envelope/storage migration and replay compatibility.
2. Pure `@alcode/program-state` model, typed criteria, reducer, DAG validation, bounds, and tests.
3. ProgramState derived projection/read model and rebuild proof.
4. Host ProgramService creation/session attachment and canonical transition admission.
5. Exact revision/attempt validity and Agent proposal boundary.
6. Startup recovery barrier plus globally single-attempt event-driven scheduler.
7. Operation/attempt correlation and uncertainty integration.
8. Verification obligation freshness/invalidation/evidence correlation.
9. Serialized Completion Oracle and terminal mutual exclusion.
10. Agent Protocol `program_state_v1` projection/proposal seam.
11. Application/read-model projection and Experience Plane ownership proof.
12. Scenario proofs, `gate:1.0`, exact-head closure evidence, and as-built documentation.

## 11. Open planning questions

The following points remain explicitly open and require review before approval/freeze:

1. Final `CompletionCriterion` union and whether any additional deterministic criterion is necessary.
2. Final verification freshness representation/name (`verificationEpoch`, subject revision, or equivalent) and exact invalidation policy when affected paths are unknown.
3. Whether Agent work-addition proposals are needed in the first executable slice or should be deferred while retaining the Host proposal boundary.
4. Exact structural bound values after testing against realistic long-horizon coding tasks.
5. Exact durable representation of `ProgramAttemptId` correlation on operation events without duplicating operation authority.
6. Whether program-level cancellation needs additional authorization semantics in Phase 1.0 beyond terminal mutual exclusion and Host ownership.
7. Whether the globally single-attempt scheduler remains the desired Phase 1.0 scope after realistic multi-Program usage is considered.

## 12. Approval and freeze rule

This planning document is not approved and not frozen.

The transition from planning to an implementation contract requires an explicit approval decision. At that point, the approved text/acceptance criteria are marked frozen and implementation may begin. Until then:

- planning amendments are allowed;
- no AC-10 criterion is immutable;
- no implementation is authorized by this document;
- no PR or commit should claim Phase 1.0 implementation has started or that the Phase 1.0 contract is frozen.

A later freeze should record the exact approved document head/commit so implementation and closure can be evaluated against the actual approved contract.
