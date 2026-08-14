# ALCODE Phase 1.0 — Durable ProgramState

**Status:** FROZEN — implementation not started  
**Prepared:** 2026-08-15 after Phase 0.9 closure and roadmap reconciliation  
**Base:** `main` at `878c938ba6a23b743c3d96c947c698a272054e37`

## 1. Objective

Phase 1.0 gives ALCODE a Host-owned durable unit of work that can outlive any one chat/session, Agent process, Host process, or execution episode.

The new unit is **ProgramState**. It is the canonical durable representation of a long-horizon coding objective: the objective itself, bounded work decomposition, dependencies, current attempts, blockers, verification obligations, decisive evidence/artifact references, and terminal completion state.

The signature result is:

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
→ satisfy required verification
→ Host completes the ProgramState exactly once
```

Phase 1.0 promotes the backlog need previously described as `task_id`, but it does **not** introduce a second competing task identity. `ProgramStateId` is the single cross-session durable identity for this phase.

This phase does not reopen Phases 0.0–0.9. Phase 0.9 CodeIntelligence remains an observation/freshness substrate; ProgramState is the stable state-indexed authority that consumes those observations without turning them into canonical code truth.

## 2. Governing invariants

1. **The Host owns ProgramState.** The Agent may propose work, evidence, or transitions; it cannot directly mutate canonical ProgramState or declare terminal completion.
2. **Program identity is not session identity.** A ProgramState may span multiple sessions. A session may be attached to at most one ProgramState, and an existing stopped session remains stopped.
3. **No transcript reconstruction of task truth.** ProgramState is reconstructed from canonical program events/projections, never by parsing conversation text.
4. **One cross-session identity.** `ProgramStateId` fulfills the long-horizon `task_id` role. Phase 1.0 must not introduce a parallel `TaskId` for the same semantic object.
5. **Current attempt validity is explicit.** Every dispatched work attempt has a fresh non-reusable `ProgramAttemptId`; stale or superseded attempts cannot commit completion/evidence as current work.
6. **Revision checks are state-indexed.** Mutating Agent proposals carry the expected ProgramState revision. A proposal against a stale canonical revision is rejected rather than silently rebased.
7. **Ready work is derived, not asserted.** Eligibility follows deterministically from dependency completion, blocker state, verification state, and current-attempt state.
8. **Phase 1.0 scheduling is bounded and local.** At most one active ProgramState work attempt is dispatched at a time. There are no timers, cron semantics, distributed leases, remote workers, or parallel subagents.
9. **Uncertain external effects remain uncertain.** An indeterminate mutating operation blocks automatic retry and ProgramState completion until existing reconciliation semantics resolve it.
10. **Verification is a first-class obligation.** Required verification cannot be replaced by an Agent assertion. Satisfaction references canonical evidence; waiver is explicit, durable, and Host-authorized.
11. **Session completion is not ProgramState completion.** A session may stop while the ProgramState remains active. ProgramState completion is a separate Host-owned decision.
12. **Program completion is exact-once.** The terminal completion event has a stable idempotency key and may be admitted at most once.
13. **Projections are rebuildable.** Deleting/rebuilding derived ProgramState projections from the canonical event log must reproduce the same semantic state and revision.
14. **Observation does not become authority.** CodeIntelligence results, Git state, files, model output, and tool results are evidence/provenance inputs; none directly replaces canonical ProgramState transitions.
15. **Existing product defaults stay unchanged.** `verbatim-v1` remains the product default and `graph-v1` remains opt-in.

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
│    ├─ bounded scheduler                      │
│    ├─ attempt validity / stale rejection     │
│    ├─ verification correlation               │
│    └─ Completion Oracle                      │
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

Phase 1.0 introduces a pure semantic package, `@alcode/program-state`, containing:

- ProgramState domain types;
- deterministic reducer;
- transition validation;
- dependency/eligibility derivation;
- bounded public/Agent projection helpers;
- Completion Oracle predicate inputs/results that are pure data.

The package performs no filesystem, SQLite, process, network, model, capability, or scheduler I/O.

`@alcode/host-runtime` owns:

- creation and attachment;
- canonical event admission;
- durable projection catch-up/rebuild coordination;
- scheduling and attempt issuance;
- correlation with operations/reconciliation/verification evidence;
- Agent proposal validation/admission;
- ProgramState completion authority.

`@alcode/storage` owns only derived storage/read-model mechanics. The canonical event log remains the source of truth.

### 3.2 Identity model

Add a branded UUIDv7 `ProgramStateId` to `@alcode/events` because it is a cross-domain identity referenced by Host/runtime, Agent Protocol, Application Protocol/read models, storage, and program events.

Add optional `programStateId?: ProgramStateId` to the canonical event envelope and persist/index it. Existing events remain valid with no ProgramStateId.

Program-local identities remain owned by `@alcode/program-state`:

- `ProgramWorkItemId` — stable opaque/UUID identity for one work item;
- `ProgramAttemptId` — fresh UUID identity for one dispatch attempt;
- `VerificationObligationId` — stable identity for one required verification obligation;
- `ProgramBlockerId` — stable identity for one explicit blocker.

A `ProgramAttemptId` is never reused after interruption, replacement, cancellation, completion, or Host reopen.

### 3.3 Session attachment

A ProgramState may have many historical sessions, but each session may attach to zero or one ProgramState.

Attachment is durable. Starting a later session against the same ProgramStateId does not revive a stopped prior session. The Host opens/resumes the new/current session under existing session rules and separately records its ProgramState attachment.

Program creation occurs under a Host session and records that initial attachment. Phase 1.0 does not require autonomous ProgramState creation while no session exists.

### 3.4 ProgramState model

The minimum canonical model is:

```ts
interface ProgramState {
  programStateId: ProgramStateId;
  objective: string;
  completionCriteria: CompletionCriterion[];
  lifecycle: "active" | "completed" | "cancelled";
  revision: number; // canonical source event sequence of latest program transition
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

The objective and completion criteria are immutable after creation in Phase 1.0. Objective amendment/versioning is successor scope.

A work item contains at minimum:

- stable id;
- bounded description;
- ordered dependency ids;
- lifecycle `pending | in_progress | awaiting_verification | blocked | completed | cancelled`;
- optional affected paths;
- required verification obligation ids;
- decisive canonical evidence references;
- produced Host artifact handles when applicable.

A work item is **eligible** only when it is `pending`, every dependency is `completed`, it has no unresolved blocker, the ProgramState is active, and there is no current active attempt.

`ready` is never a canonical stored state; it is derived from the above facts.

### 3.5 Canonical event families

Exact payload schemas are implementation-owned but must preserve these semantic families:

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
- `program.verification.waived`;
- `program.artifact.recorded`;
- `program.cancelled`;
- `program.completed`.

The event taxonomy may be represented by more specific subtypes if necessary, but implementation must not collapse semantically distinct facts (for example, verification satisfaction versus waiver, or work completion versus ProgramState completion).

All ProgramState transitions pass through the existing serialized `CanonicalAdmissionQueue` or an equivalent Host-owned single canonical admission lane.

### 3.6 State-indexed validity and attempt claims

ProgramState replaces conversational/temporal inference of "what work is current" with explicit validity.

When the scheduler dispatches one work item, the Host records `program.attempt.started` containing:

- `ProgramAttemptId`;
- `ProgramWorkItemId`;
- attached `sessionId`;
- Agent generation/request correlation where available;
- the ProgramState revision on which the claim was issued.

Agent-originated state mutations include the current attempt id when they concern dispatched work and include `expectedProgramRevision`.

The Host rejects a mutation as stale when any of these is true:

- the ProgramStateId is different;
- the attempt id is not the current active attempt;
- the work item is no longer the attempted work item;
- the expected revision is older than the current ProgramState revision for a transition requiring current state;
- the Agent generation/request no longer owns the active attempt;
- the ProgramState is terminal.

Agent/Host replacement or Host reopen invalidates an orphaned active attempt by durably recording interruption before a new attempt may be issued.

This is a single-Host claim-validity protocol, **not** a distributed lease protocol. There are no time-based claim expirations in Phase 1.0.

### 3.7 Bounded scheduler

The Phase 1.0 scheduler is deliberately minimal:

- explicit/event-driven only;
- one active attempt per ProgramState;
- deterministic eligible-work selection by stable work-item order;
- dispatch only after canonical attempt admission;
- no auto-dispatch of work whose prerequisites or verification gates are unresolved;
- no retry after indeterminate external mutation until reconciliation resolves the effect;
- retry may create a new attempt only after the old attempt is terminal/interrupted and the work remains eligible.

The scheduler does not own capability execution. It invokes the existing Host/Agent execution path and therefore remains subject to current permission, capability, operation, recovery, context, and transcript authority.

### 3.8 Verification obligations and impact

Phase 1.0 introduces durable verification obligations without pretending to have a full canonical code graph.

A mutating work item records bounded `affectedPaths` when known and one or more explicit verification obligations when the completion contract requires them. Verification obligations describe the required check and acceptance predicate in deterministic data.

Satisfaction must reference canonical evidence, such as a completed Host operation/tool result, reasoning verification result, retained artifact, or other event-backed evidence accepted by the Host.

A verification obligation may be waived only through an explicit Host-authorized action that records who/what authorized the waiver and why. An Agent proposal alone cannot waive an obligation.

Automated repository-wide impact analysis, probabilistic test selection, and a canonical ProgramModel/code graph are excluded from Phase 1.0. Phase 0.9 CodeIntelligence may support observations used when creating or evaluating obligations, but it does not own their truth.

### 3.9 External-effect uncertainty

ProgramState consumes existing operation/reconciliation semantics.

If a work attempt performs a mutating external operation whose effect becomes `indeterminate`, then:

- the attempt cannot be represented as safely retryable;
- the work item cannot become completed from that ambiguous result;
- ProgramState completion is blocked;
- no scheduler retry is issued until reconciliation establishes a safe state;
- resolution evidence is durably linked before work proceeds.

This preserves the Phase 0.2 recovery doctrine rather than creating a task-level retry loophole.

### 3.10 Completion Oracle

The **Completion Oracle** is Host-owned. Agent idle/completion language is evidence only.

A ProgramState may emit `program.completed` only when all of the following hold on one canonical state cut:

- ProgramState lifecycle is active;
- every required non-cancelled work item is `completed`;
- every mandatory verification obligation is `satisfied` or explicitly `waived`;
- no unresolved ProgramState/work-item blocker exists;
- no active attempt remains;
- no ProgramState-linked operation has unresolved/indeterminate effect requiring reconciliation;
- no ProgramState-linked retryable durable work is incomplete;
- all declared completion criteria evaluate satisfied from canonical evidence;
- the current Agent is idle when an Agent is attached and active in the completion path.

The completion admission uses an idempotency key derived from `ProgramStateId` so retry/recovery cannot create duplicate terminal completion.

Cancellation is a distinct terminal fact and never aliases completion.

### 3.11 Agent Protocol integration

Phase 1.0 adds a negotiated Agent Protocol capability, `program_state_v1`.

For an attached session, Host-to-Agent structured state includes a bounded ProgramState projection containing at minimum:

- ProgramStateId and revision;
- objective and completion criteria;
- current work item and active attempt id when any;
- dependency status relevant to unfinished work;
- unresolved blockers;
- pending verification obligations;
- decisive evidence/artifact references required for the current step;
- terminal/lifecycle state.

The Agent may submit typed ProgramState transition/evidence proposals. Every mutating proposal is validated by the Host and, when relevant, carries the current attempt id and expected ProgramState revision.

The Host may additionally render a bounded ProgramState summary into provider-visible context, but prompt text is a projection only. Structured canonical state remains outside the Agent.

A replacement Agent receives the same current ProgramState projection from the Host before continuing work.

### 3.12 Application/read-model integration

Phase 1.0 exposes ProgramState as a Host-owned read model for an attached session. The existing session/transcript/operation surfaces remain valid.

The minimum public projection includes:

- ProgramStateId;
- objective;
- lifecycle/status;
- work-item status and current item;
- blocker summary;
- verification summary;
- active attempt identity/status;
- ProgramState revision.

Phase 1.0 does not require a kanban/task-management product. The React shell may display the bounded projection if needed for executable ownership proof, but a full task UI is excluded.

ProgramState creation/attachment/cancellation/verification waiver may be exposed through narrow Host/Application commands if required by the executable slice; the Experience Plane never writes projections or canonical events directly.

## 4. Security and trust

- Program objective, work descriptions, affected paths, model proposals, code observations, tool output, and artifact contents are untrusted data, not Host control instructions.
- Existing secret admission/redaction rules continue to apply before persistence.
- ProgramState must not create a new path around capability policy, permission prompts, network policy, plugin generation trust, or external-process ownership.
- Artifact references use the existing Host content-addressed artifact store/handles; ProgramState does not invent a second canonical artifact store.
- Agent-provided evidence is not accepted as a verified fact merely because the Agent labels it evidence.
- Stale-attempt rejection occurs before committing semantic state derived from that attempt.

## 5. Explicit exclusions

The following are outside Phase 1.0 acceptance unless concrete implementation evidence proves one is required to make the frozen objective valid:

- a parallel `TaskId` representing the same long-horizon unit as `ProgramStateId`;
- portfolio/project hierarchy or multi-Program orchestration;
- general-purpose workflow DSL beyond the bounded ProgramState work/dependency model;
- recurring automation, cron, timers, delayed jobs, reminders, or notification scheduling;
- distributed claims, leases, remote workers, multi-writer coordination, or cloud orchestration;
- parallel subagents, agent teams, worktree isolation, or multi-agent kanban;
- browser execution;
- remote workspace backends including SSH/WSL/Docker/remote server execution;
- marketplace/plugin expansion or model-written runtime plugins;
- MCP server mode;
- public remote Application Protocol wire encoding;
- full ProgramModel/canonical code graph;
- repository-wide automatic impact graph construction;
- probabilistic/LLM-only verifier selection as canonical policy;
- objective amendment/version-history product;
- autonomous ProgramState creation while no Host session exists;
- automatic background execution after Host startup with no explicit attached execution episode;
- graph-v1 product-default promotion;
- full graph/memory/context/trace/task inspector UI;
- vector memory, auto-skill minting, or other unrelated cognition expansion.

These are successor/backlog items, not Phase 1.0 completion gates.

## 6. Frozen acceptance criteria

Acceptance criteria AC-10-01 through AC-10-11 are frozen when Phase 1.0 implementation begins. They may change only under the project change-control rule for demonstrated correctness/safety/material-usability blockers.

### AC-10-01 — ProgramState identity and canonical envelope

`ProgramStateId` is a branded UUIDv7 cross-domain identity. The canonical event/storage envelope can carry/index optional ProgramStateId without breaking non-program events. The backlog `task_id` need is satisfied by this identity; no duplicate TaskId is introduced.

Executable proof covers identity typing/serialization, SQLite persistence/indexing, migration/reopen, event replay, and old events with no ProgramStateId.

### AC-10-02 — Deterministic ProgramState model and rebuild

`@alcode/program-state` deterministically reduces validated program events into objective, lifecycle, work/dependency state, blockers, verification obligations, artifacts, attachments, active attempt, and revision.

Executable proof deletes/rebuilds the derived ProgramState projection from canonical events and obtains semantic parity with the pre-rebuild state.

### AC-10-03 — Cross-session attachment and continuity

One ProgramState survives session stop, Agent replacement, Host close/reopen, and attachment of a later session. A stopped prior session is not revived, and a session cannot be attached to two different ProgramStateIds.

Executable proof demonstrates partial work in Session A and correct continuation in Session B against the same ProgramStateId.

### AC-10-04 — State-indexed attempt validity

Each dispatch mints a fresh ProgramAttemptId. Current-work mutations are accepted only from the current valid attempt/current ProgramState revision. Old Agent generations, superseded attempts, late results, and stale revisions are rejected without mutating canonical ProgramState.

Executable proof includes an ABA-style replacement case: Attempt A becomes invalid, Attempt B becomes current, and a late result from Attempt A cannot complete or alter the work item.

### AC-10-05 — Deterministic bounded scheduling

The Host derives eligible work from dependency/blocker/verification/attempt state and dispatches deterministically with at most one active ProgramState attempt. Dependency-ineligible work is never dispatched; completing prerequisites unlocks the next eligible work exactly once.

No timer, recurring automation, distributed lease, or subagent mechanism is required by the proof.

### AC-10-06 — Effect uncertainty and retry safety

ProgramState scheduling/completion composes existing operation effect/reconciliation semantics. An indeterminate mutating effect blocks automatic retry and ProgramState completion until reconciliation establishes a safe result.

Executable proof simulates a mutation whose external effect may have occurred, verifies no duplicate retry is issued, then resolves/reconciles before continuation.

### AC-10-07 — Durable verification obligations

Required verification obligations are durable, rebuildable, bound to work/completion criteria, and satisfied only by Host-accepted canonical evidence or explicit Host-authorized waiver. Pending verification prevents required work from reaching verified completion and prevents ProgramState completion.

Executable proof demonstrates work that reaches `awaiting_verification`, remains incomplete at the Program level, then becomes complete only after matching evidence is admitted.

### AC-10-08 — Host Completion Oracle and exact-once terminal state

Only the Host Completion Oracle may admit `program.completed`. Completion is rejected while required work, blockers, verification, active attempts, unresolved indeterminate effects, incomplete linked durable work, or completion criteria remain outstanding. Agent idle is evidence, not authority.

Executable proof retries the completion decision/recovery path and observes exactly one canonical ProgramState completion event.

### AC-10-09 — Agent structured ProgramState integration

An attached Agent negotiates `program_state_v1` and receives a bounded structured ProgramState projection with ProgramStateId/revision/current work/attempt/blockers/verification. Replacement Agents receive the current projection before acting. Agent proposals are Host-validated and stale proposals are rejected.

Executable proof confirms the Agent cannot own or overwrite canonical ProgramState and cannot continue a superseded attempt.

### AC-10-10 — Application/read-model projection and ownership

The Host exposes a bounded authoritative ProgramState read model for an attached session without making the Experience Plane a state owner. Reconnect/snapshot behavior returns the current ProgramState projection from canonical Host state.

Executable ownership tests prove UI/client code does not open the durable store, append ProgramState events, dispatch attempts, or decide ProgramState completion directly.

### AC-10-11 — Composed Phase 1.0 gate

`pnpm gate:1.0` composes and passes `pnpm gate:0.9` plus all Phase 1.0 checks at the exact final implementation head. Existing Phase 0.9 closure semantics/defaults remain intact.

## 7. Required scenario proofs

The Phase 1.0 gate must include these non-vacuous scenarios:

### Scenario A — Long-horizon reopen

```text
Program P with work A → B → C
→ Session 1 completes A
→ Host + Agent destroyed
→ Host reopened
→ Session 2 attaches P
→ A remains complete; only B is eligible
→ B/C continue from canonical ProgramState
→ verification satisfied
→ P completes once
```

### Scenario B — Stale-attempt ABA

```text
work B → Attempt X issued to Agent generation 1
→ Agent 1 replaced / X interrupted
→ Attempt Y issued to Agent generation 2
→ late Agent 1 result for X arrives
→ Host rejects X as stale
→ Y remains current and may complete B
```

### Scenario C — Indeterminate mutation

```text
attempt invokes mutating capability
→ connection/process failure after effect may have occurred
→ operation effect = indeterminate
→ no scheduler retry
→ ProgramState completion blocked
→ reconciliation resolves effect
→ Host records resolution and safely continues
```

### Scenario D — Verification gate

```text
mutating work implementation finishes
→ required verification still pending
→ work = awaiting_verification
→ Agent says "done" / idles
→ Completion Oracle rejects completion
→ matching canonical verification evidence arrives
→ work becomes completed
→ Program may complete if all other criteria hold
```

### Scenario E — Rebuild and exact-once completion

```text
complete a ProgramState
→ rebuild/delete derived program projections
→ replay canonical event log
→ reconstructed ProgramState is semantically identical and terminal
→ retry completion/recovery
→ no second program.completed event
```

## 8. Gate

Add `pnpm gate:1.0` composing `pnpm gate:0.9`.

The gate records at least these check ids:

```text
1.0.compose.0.9
1.0.identity.program-state
1.0.program.reducer
1.0.program.rebuild
1.0.program.session-binding
1.0.program.attempt-freshness
1.0.program.scheduler
1.0.program.uncertainty
1.0.program.verification
1.0.program.completion
1.0.agent.program-state
1.0.application.program-projection
1.0.ownership
```

Phase 1.0 adds no new platform matrix solely for logical ProgramState semantics. Existing composed/platform CI remains authoritative unless implementation introduces a new platform-sensitive surface that demonstrably requires focused proof.

## 9. Implementation order

Implementation should proceed in this dependency order:

1. ProgramStateId identity/envelope/storage migration and replay compatibility.
2. Pure `@alcode/program-state` model, reducer, validation, dependency derivation, and tests.
3. ProgramState derived projection/read model and rebuild proof.
4. Host ProgramService creation/session attachment and canonical transition admission.
5. Attempt validity plus deterministic single-attempt scheduler.
6. Existing operation/reconciliation uncertainty integration.
7. Verification obligation/evidence correlation.
8. Completion Oracle and exact-once terminal admission.
9. Agent Protocol `program_state_v1` projection/proposal seam.
10. Application/read-model projection and bounded Experience Plane ownership proof.
11. Scenario proofs, `gate:1.0`, exact-head closure evidence, and as-built documentation.

Intermediate commits/PRs may be reviewable partial Phase 1.0 work, but none claims Phase 1.0 closure until the full composed gate passes at the exact final implementation head.

## 10. Failure and rollback

- Schema migration must preserve all existing events and non-ProgramState workspaces.
- If ProgramState projection rebuild fails, canonical events remain the recovery source; derived program projections may be dropped/rebuilt.
- If an Agent/Host dies with an active ProgramAttemptId, recovery records interruption before issuing a new attempt.
- If a mutating operation is indeterminate, recovery must not convert that uncertainty into retry eligibility.
- If ProgramState protocol capability negotiation is absent, legacy non-program sessions continue under the existing Agent Protocol behavior; an attached ProgramState requiring structured continuity must not silently downgrade to Agent-owned task memory.
- ProgramState terminal events are append-only facts; rollback never rewrites a completed/cancelled ProgramState into active state.

## 11. Completion definition

Phase 1.0 is complete when the exact implementation head:

1. passes `pnpm gate:1.0`, including the composed Phase 0.9 gate and AC-10-01 through AC-10-11;
2. passes the required scenario proofs above;
3. records the as-built ProgramState contract and exact-head closure evidence in repository documentation.

Successful Phase 1.0 closure does **not** authorize subagents, parallel/distributed workers, recurring automation, browser execution, remote workspaces, full workflow/task products, or any other excluded successor feature.

Until implementation starts, this document is the frozen design/acceptance contract only. Once implementation begins, AC-10-01 through AC-10-11 are immutable except under explicit project change control for a demonstrated correctness, safety, corruption, or material-usability blocker.
