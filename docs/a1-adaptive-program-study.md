# ALCODE A1 — Adaptive Program As-Built Architecture Study

**Status:** Architecture study only. This document records the current implementation constraints that a future A1 contract must respect. It does **not** authorize A1 implementation.  
**Prepared against:** `main@a6ff8fdfa8ea15fa2e0f8c744a01f201755689a8`, after P-01 closure and post-P-01 documentation convergence.  
**Roadmap objective:** A1 — Adaptive Program Revision and Progressive Decomposition.

---

## 1. Purpose

P-01 closed the fixed-topology autonomous Program runtime. The production path can now plan a bounded Program, execute fresh ProgramAttempts, verify work through Host-owned verifiers, retire failed Attempts, retry under fresh authority, advance structurally-ready successors without new caller input, survive Agent replacement under recovery rules, and complete only through the Host Completion Oracle.

The remaining architectural limitation is semantic rather than operational:

```text
current:
accepted fixed Program DAG
        ↓
ProgramAttempts
        ↓
verification / retry / successor dispatch
        ↓
Completion Oracle

needed:
accepted Program meaning R1
        ↓
execution discovers missing / wrong / more detailed work
        ↓
bounded revision proposal
        ↓
Program meaning R2
        ↓
retain unaffected authority/evidence
invalidate affected authority/evidence
        ↓
continue under evolved canonical meaning
```

This study answers one question:

> What does the repository already assume about Program revision, work identity, Attempt currentness, verification freshness, scheduling, recovery, projection, and completion that A1 must preserve or deliberately replace?

The study is intentionally source-grounded. It does not freeze a target design. The companion candidate plan is where proposed A1 semantics are stated.

---

## 2. Source map

The load-bearing current implementation is concentrated in:

- [`../packages/program-state/src/types.ts`](../packages/program-state/src/types.ts)
- [`../packages/program-state/src/creation.ts`](../packages/program-state/src/creation.ts)
- [`../packages/program-state/src/reducer-core.ts`](../packages/program-state/src/reducer-core.ts)
- [`../packages/program-state/src/validation-core.ts`](../packages/program-state/src/validation-core.ts)
- [`../packages/program-state/src/eligibility.ts`](../packages/program-state/src/eligibility.ts)
- [`../packages/program-state/src/completion.ts`](../packages/program-state/src/completion.ts)
- [`../packages/program-state/src/limits.ts`](../packages/program-state/src/limits.ts)
- [`../packages/host-runtime/src/program-dispatch.ts`](../packages/host-runtime/src/program-dispatch.ts)
- [`../packages/host-runtime/src/program-execution-scheduler.ts`](../packages/host-runtime/src/program-execution-scheduler.ts)
- [`../packages/host-runtime/src/program-agent.ts`](../packages/host-runtime/src/program-agent.ts)
- [`../packages/host-runtime/src/program-execution-control.ts`](../packages/host-runtime/src/program-execution-control.ts)
- [`../packages/host-runtime/src/program-verification.ts`](../packages/host-runtime/src/program-verification.ts)
- [`../packages/host-runtime/src/program-terminal.ts`](../packages/host-runtime/src/program-terminal.ts)
- [`../packages/host-runtime/src/program-recovery.ts`](../packages/host-runtime/src/program-recovery.ts)
- [`../packages/host-runtime/src/program-application.ts`](../packages/host-runtime/src/program-application.ts)
- [`../packages/agent-protocol/src/messages.ts`](../packages/agent-protocol/src/messages.ts)
- [`../packages/application-protocol/src/types.ts`](../packages/application-protocol/src/types.ts)

Historical/frozen contracts that explain why the code has this shape:

- [`phase-1.0-freeze.md`](./phase-1.0-freeze.md)
- [`phase-1.0-as-built.md`](./phase-1.0-as-built.md)
- [`phase-1.1-as-built.md`](./phase-1.1-as-built.md)
- [`s-01e-agent-generation-closure-contract.md`](./s-01e-agent-generation-closure-contract.md)
- [`p-01-production-program-agent-as-built.md`](./p-01-production-program-agent-as-built.md)

---

## 3. The most important current fact: `ProgramState.revision` is not semantic Program meaning

`ProgramState` currently contains:

```text
programStateId
objective
lifecycle
revision
workItems
blockers
verification
outputSlots
productionSteps
decisiveEvidence
artifacts
attachedSessionIds
activeAttempt
acceptedExecutionBase
executionBaseMismatch
executionBaseUnavailable
creationPolicyRequirements
```

There is no current `ProgramRevision` object, no semantic-revision lineage, no `WorkItemGeneration`, and no `RevisionImpact`.

The reducer defines `revision` as a whole-state optimistic-concurrency generation. One admitted state-changing transition increments it exactly once. That includes transitions whose meaning is purely operational/control-plane, such as:

- session attach/detach;
- Attempt issue/interruption;
- execution-base advance/mismatch/rebase/unavailable;
- verification satisfy/invalidate/waive;
- evidence/artifact retention;
- blocker transitions;
- work lifecycle transitions;
- cancellation/completion.

The current `ProgramRevisionConflictError` therefore means:

> “The caller did not target the exact current ProgramState snapshot.”

It does **not** mean:

> “The caller targeted the wrong semantic version of the objective/topology.”

This distinction is load-bearing for A1.

### Consequence

A1 must not silently redefine `ProgramState.revision` to mean semantic Program revision. Existing code, public commands, event idempotency keys, dispatch checks, verification flows, Application control, and terminal admission all depend on its current state-CAS meaning.

The future architecture needs two separate notions:

```text
ProgramState.revision
    = exact whole-state CAS/current-state generation

ProgramRevision
    = accepted semantic meaning/topology generation
```

A semantic revision will itself be admitted through a normal ProgramState transition and therefore will also increment `ProgramState.revision`, but operational transitions must not create new semantic Program revisions.

---

## 4. Current Program contract is fixed at creation

`createProgramState()` constructs:

- the caller-authored objective;
- the initial work-item DAG;
- verification definitions;
- output slots;
- production steps;
- creation policy requirements.

All work starts `pending`. Every verification obligation starts at `subjectGeneration = 1`. `revision` starts at 1.

Phase 1.0 intentionally treats the accepted semantic contract as immutable. The current reducer has no transition for:

- adding required work;
- changing dependencies;
- changing a work description/affected paths;
- withdrawing required work;
- superseding a WorkItem;
- decomposing a WorkItem into children;
- changing verification definitions;
- changing output/production requirements;
- changing the objective.

A1 therefore is not a small extension to an existing topology-mutation mechanism. It introduces the first post-creation semantic evolution path.

---

## 5. Current WorkItem identity and lifecycle are too compressed for adaptive topology

The current WorkItem model is approximately:

```text
WorkItem
├── workItemId
├── creationOrder
├── description
├── dependencyIds[]
├── affectedPaths[]
└── lifecycle:
      pending
      in_progress
      awaiting_verification
      blocked
      completed
```

This works for an immutable DAG because three distinct questions collapse into one lifecycle:

1. Is this obligation still required?
2. Is it a leaf or has it been decomposed?
3. What is its execution/satisfaction state?

Adaptive topology separates those dimensions.

Examples the current lifecycle cannot represent cleanly:

```text
W is still a required obligation
but W has been decomposed into W1/W2/W3
and W itself is not yet satisfied
```

or:

```text
W represented the same obligation,
but its constraints changed materially;
old execution evidence must no longer satisfy it
```

or:

```text
W has been superseded by W2 and is retained only for lineage/provenance
```

The current reducer also explicitly prevents reopening completed work in Phase 1.0. A1 must decide whether changed meaning preserves the WorkItem identity with a new generation or creates a new WorkItem identity, rather than abusing “reopen completed”.

### Required future separation

The architecture study supports separating at least:

```text
requirement state:
  required / withdrawn / superseded

topology state:
  leaf / decomposed

execution/satisfaction state:
  pending / active / blocked / awaiting_verification / satisfied
```

The exact serialized representation remains an A1 contract decision. The important point is semantic:

```text
decomposed ≠ satisfied
satisfied ≠ verified
verified ≠ currently verified
```

---

## 6. Current readiness assumes every dependency is one terminal WorkItem

`deriveReadyWorkItems()` currently requires:

- Program active;
- no active Attempt;
- no execution-base mismatch/unavailable;
- WorkItem lifecycle `pending`;
- all direct dependencies `completed`;
- no applicable open blocker.

The scheduler then chooses deterministic creation order and delegates operational admission to the dispatch service.

This is a good separation to preserve:

```text
pure Program eligibility
        ↓
Host operational admission
        ↓
Attempt issuance
```

But adaptive topology means “dependency completed” is no longer enough as the sole relation. A1 must define what happens when a dependency:

- is decomposed;
- is superseded;
- is withdrawn;
- changes generation;
- has descendants whose satisfaction substitutes for the parent obligation.

A1 should evolve eligibility/admission semantics, not turn the scheduler into canonical truth.

---

## 7. Current Attempt authority is coupled to whole-state revision

The Agent protocol currently defines `ProgramAttemptAuthorityV1`:

```text
programStateId
expectedProgramRevision
programAttemptId
workItemId
agentGeneration
```

`expectedProgramRevision` is `ProgramState.revision`.

The same tuple is reused by:

- `program.attempt.execute`;
- Agent progress messages;
- capability requests;
- Host current-Attempt projection;
- Program root-operation ownership/admission.

The Host does more than trust that revision number: it also rechecks the exact AttemptId, WorkItemId, Session, Agent generation, recovery state, writer barriers, and protected execution base. Those checks are strong and should remain.

But the whole-state revision check causes a semantic problem for A1:

```text
Attempt A works on W1
        │
unrelated Program transition changes W8/session/evidence
        │
ProgramState.revision increments
        │
A's previously projected authority becomes stale
```

That behavior is acceptable in the fixed-topology first slice. It is too coarse once unrelated Program meaning may evolve while an unaffected Attempt remains valid.

### A1 implication

A1 needs an Attempt authority form that derives semantic currentness from the things that actually matter to that Attempt, such as:

- exact ProgramAttemptId;
- WorkItemId + WorkItemGeneration;
- relevant dependency state/generations;
- relevant Program constraints/authority envelope;
- Session + AgentGeneration;
- current accepted execution base;
- current Host recovery/writer barriers;
- current capability admission.

`ProgramState.revision` should remain an internal exact-state CAS mechanism. It should not remain the long-lived semantic lease for an A1 Attempt.

This almost certainly requires a versioned Agent-protocol authority surface rather than changing V1 in place.

---

## 8. Current Operation/effect truth already has the right independence

`program-dispatch.ts` stamps Program ownership on root `operation.requested` and preserves operation-local execution/effect/quiescence history independently of later Agent or Attempt replacement.

Mutation settlement already has the correct general doctrine:

- a Host-admitted Operation remains a historical fact even if the originating Agent/Attempt later becomes stale;
- confirmed effects advance durable workspace effect generation;
- indeterminate mutation remains uncertainty;
- missing quiescence blocks trusted continuation;
- settlement may make Program execution-base state unavailable if the original Attempt is no longer safely current.

A1 must preserve this exactly.

Semantic revision must never “undo” an Operation fact or reinterpret an uncertain effect as absent.

The relationship should be:

```text
semantic revision may invalidate future authority/evidence
        │
        └─ but cannot rewrite historical Operation/effect truth
```

---

## 9. Verification freshness already has a generation model, but it is a different generation

Each current verification obligation owns a monotonic `subjectGeneration`. Satisfaction and waiver apply only to the exact current generation. Invalidation increments that generation and clears current satisfaction/waiver.

This is already the correct pattern for freshness.

A1 introduces another generation:

```text
WorkItemGeneration
    = semantic generation of the obligation

Verification.subjectGeneration
    = freshness generation of the verification subject/evidence
```

These must not be conflated.

A WorkItem semantic generation change will often require some verification obligations to advance their `subjectGeneration`, but workspace mutation can also invalidate verification without changing the WorkItem semantic generation.

### Current limitation

Verification applicability is not a first-class semantic binding. `program-execution-control.ts` infers “required for current work” from:

- artifact ownership;
- affected-path overlap;
- decisive evidence links;
- whether other work remains incomplete.

That inference is workable for a fixed DAG. A1 needs deterministic revision impact. The candidate plan should therefore define explicit verification subject/applicability semantics rather than making semantic revision correctness depend on heuristics.

---

## 10. Current mutation impact is deliberately conservative

Confirmed Program mutations currently invalidate all verification obligations when precise bounded path impact is not known. Execution-base mismatch similarly uses conservative complete invalidation.

That safe baseline does not block A1.

A1 can introduce **semantic-revision impact** independently:

```text
semantic revision
    → derive exact work/constraint/verification impact

workspace mutation
    → existing effect/freshness impact doctrine
```

A1 does not need to solve every future path-impact optimization to make semantic revision correct. Conservative invalidation remains acceptable where impact cannot be proven disjoint.

---

## 11. Current scheduler is policy, not truth — preserve this

`ProgramExecutionSchedulerV1`:

- reconstructs current ProgramState;
- derives one structurally-ready WorkItem;
- asks for current Agent generation;
- calls `ProgramDispatchServiceV1.issueAttempt()`.

It explicitly does not own durable state, hidden queues, or recovery truth.

That architecture should survive A1.

A1 needs a stronger **eligibility / Attempt-admission** model because currentness becomes semantic-generation-aware. It does not need an A10-style autonomous policy scheduler.

One current implementation detail will need attention: first-dispatch detection partly relies on `state.revision === 1`. Once state revision and semantic revision are explicitly separate, “first dispatch” should be represented by the relevant canonical execution state rather than treating whole-state revision 1 as semantic meaning.

---

## 12. Current Agent replacement semantics are already aligned with A1

S-01/P-01 replacement behavior is strong:

```text
Agent A current
    ↓
replacement begins
    ↓
old Attempt retired / awaiting work returned pending when required
    ↓
transcript/recovery preparation
    ↓
Agent B becomes fresh generation
    ↓
fresh Attempt may later issue
```

The durable identity is the Program/work, not the Agent.

A1 should preserve that direction. A retained Attempt across an unrelated **semantic revision** is conceptually different from retaining an Attempt across **Agent replacement**. Agent replacement should still mint fresh Agent authority and should not inherit an old Attempt as though cognition identity survived.

---

## 13. Current Completion Oracle is strict but assumes fixed required work

The pure Completion Oracle currently blocks on:

- invalid structure;
- non-active Program;
- any WorkItem not `completed`;
- stale mandatory verification;
- open blocker;
- active Attempt;
- execution-base mismatch/unavailable/not-current;
- outstanding Program operations;
- indeterminate effects/reconciliation;
- writer barriers;
- retryable durable work;
- unavailable artifact integrity.

Host terminal admission adds the protected observation/recovery/canonical serialization cuts.

A1 must preserve every environmental correctness check and add semantic closure:

```text
no unresolved required decomposition
no current required WorkItem left unsatisfied
no pending accepted/relevant semantic transition
mandatory verification current for the current semantic Program
```

Decomposing a parent must never be a shortcut to Completion.

---

## 14. Current public Application state exposes state revision, not semantic revision

The Application Protocol currently exposes:

```text
PublicProgram {
  programStateId
  revision
  objective
  lifecycle
  workItems
  blockers
  verification
  activeAttempt
  control
  uncertainty
}
```

Existing Program commands use `expectedProgramRevision` to target the exact current state for rebase/cancel/session attach/detach.

That public field is already part of V1 semantics. A1 should not silently rename or reinterpret it.

Adaptive Programs need additional public information, for example:

- current semantic `programRevisionId` / ordinal;
- WorkItem generation;
- requirement/topology state;
- pending semantic revision/amendment requiring acceptance;
- bounded RevisionImpact summary;
- stale/retained Attempt result where relevant.

Scope amendments/corrections that require user authority should follow the same principle as Program creation: the Agent proposes; the Host seals exact semantics; the Application accepts an exact draft.

---

## 15. Current state persistence is snapshot-heavy and bounded

Program events currently persist the resulting `ProgramState` snapshot in `program.created`, `program.transitioned`, `program.completed`, and `program.cancelled` payloads. Consumers replay those events and select the latest state.

The current canonical state is hard-bounded:

- 128 WorkItems;
- 1,024 dependency edges;
- 256 verification obligations;
- 4 MiB serialized canonical ProgramState;
- 128 KiB Agent Attempt projection;
- 256 KiB Application Program projection.

A1 cannot assume unbounded semantic history can be copied into current state.

### A1 consequence

Historical revision lineage should be recoverable from canonical events, but current state should retain only the bounded data needed for:

- current semantic topology;
- current identities/generations;
- active/relevant tombstones needed to validate references;
- current revision lineage head / bounded metadata.

The candidate plan must explicitly guard against topology/history growth becoming an unbounded state accumulator.

---

## 16. Legacy Program compatibility is a real design requirement

Programs created before A1 lack:

- semantic revision identity;
- WorkItem generations;
- requirement/topology states;
- revision impact records.

Historical events cannot be retroactively rewritten.

A1 therefore needs an explicit compatibility rule. Acceptable classes of solution include:

1. deterministic normalization of legacy fixed-topology state into an A1 semantic baseline; or
2. an explicit Host-admitted baseline-adoption transition before a legacy Program becomes adaptively revisionable.

What should not happen:

- silently reinterpret historical `ProgramState.revision` as semantic revision;
- invent non-rebuildable lineage from process memory;
- let an active legacy Attempt silently gain A1 authority without a fresh admission boundary.

The candidate plan proposes a bounded legacy-baseline rule; implementation details remain reviewable before freeze.

---

## 17. Architecture conclusions

The as-built repository strongly supports these conclusions.

### 17.1 Keep two revisions

```text
state revision:
  ProgramState.revision
  exact whole-state optimistic concurrency
  increments for any admitted state mutation

semantic Program revision:
  new A1 concept
  changes only when accepted Program meaning/topology changes
```

### 17.2 Add WorkItemGeneration

Global semantic revision is too coarse to decide whether a specific obligation changed.

```text
ProgramRevision
  tells us:
  "What does the Program currently mean?"

WorkItemGeneration
  tells us:
  "Has this particular obligation materially changed?"
```

### 17.3 Derive RevisionImpact centrally

Do not scatter “revision changed, therefore stale” checks across the Host.

A semantic revision admission should deterministically derive one impact result describing what is retained and invalidated.

### 17.4 Decouple AttemptAuthority from whole-state revision

A1 Attempt currentness should be tied to exact relevant semantic/execution authority, not every unrelated state mutation.

### 17.5 Keep verification freshness independent

WorkItemGeneration and Verification `subjectGeneration` solve different problems and should remain different counters.

### 17.6 Preserve Operation/effect/recovery truth untouched

Semantic revision governs future meaning/authority. It does not rewrite environmental history.

### 17.7 Keep scheduler policy subordinate to eligibility/admission

A1 is not the stage to introduce a sophisticated autonomous scheduler.

### 17.8 Make decomposition semantically explicit

A parent becoming `decomposed` is a topology fact, not a satisfaction fact.

### 17.9 Require stronger authority for non-monotonic semantic change

A refinement that only partitions/narrows an existing obligation is categorically different from removing required work, weakening verification, relaxing constraints, or changing objective/effect authority.

---

## 18. Questions the A1 contract must freeze

Before production implementation begins, the A1 plan must answer at least:

1. What exactly is a semantic `ProgramRevision`?
2. How does it coexist with existing `ProgramState.revision`?
3. What transaction admits a new semantic revision?
4. How are concurrent/stale semantic proposals rejected?
5. What changes preserve WorkItemId?
6. What changes increment WorkItemGeneration?
7. What requires a new WorkItemId and supersession?
8. What does `decomposed` mean?
9. How are parent/child requirements satisfied?
10. What makes a child graph valid?
11. Which refinements can be auto-admitted?
12. What authority envelope is inherited/narrowed?
13. What is refinement vs correction vs scope amendment?
14. Which semantic changes require exact Application acceptance?
15. How is RevisionImpact derived?
16. Which changes retain/interrupt an active Attempt?
17. What exact authority replaces whole-state revision in Agent Attempt authority?
18. Which verification obligations remain current?
19. How do WorkItemGeneration and Verification subjectGeneration interact?
20. How do legacy fixed-topology Programs obtain an A1 semantic baseline?
21. How does recovery rebuild exact semantic lineage?
22. How does cancellation race with pending revision/amendment acceptance?
23. How does completion prove no unresolved required decomposition remains?
24. What hard bounds prevent revision/topology history from becoming unbounded?

---

## 19. Explicit non-goals for the A1 study/plan

A1 should not pull in:

- Capability Workflow VM / Code Mode;
- arbitrary generated-code execution;
- sandbox execution-provider implementation;
- procedure learning/optimization;
- general parallel workspace execution;
- durable subagent/delegation teams;
- remote workers;
- A10 autonomous policy scheduling;
- enterprise governance/RBAC.

A1 may introduce only the minimum eligibility/admission/projection/protocol changes required to make adaptive Program semantics correct.

---

## 20. Study result

The current runtime is ready for A1, but the change is deeper than “make the DAG editable.”

The actual architectural transition is:

```text
current:
whole-state revision
+ fixed WorkItem identity
+ exact-revision Attempt lease
+ fixed verification set
+ all-work-completed terminal predicate

A1:
whole-state revision retained
+ semantic ProgramRevision lineage
+ WorkItemGeneration
+ deterministic RevisionImpact
+ relevance-scoped AttemptAuthority
+ semantic verification impact
+ explicit decomposition closure
```

The highest-risk mistake would be to overload the existing `revision` field and thereby couple every operational state mutation to semantic invalidation.

The candidate A1 plan should instead make Program evolution, execution evolution, and later capability evolution independent but causally related processes.
