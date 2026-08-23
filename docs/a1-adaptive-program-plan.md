# ALCODE A1 — Adaptive Program Revision and Progressive Decomposition Plan

**Status:** **DRAFT — candidate bounded contract; not approved; not frozen; implementation not authorized.**  
**Prepared:** 2026-08-24 against `main@a6ff8fdfa8ea15fa2e0f8c744a01f201755689a8`.  
**Predecessor:** P-01 Production Program Agent is closed.  
**Roadmap:** [`roadmap.md`](./roadmap.md), A1.  
**As-built study:** [`a1-adaptive-program-study.md`](./a1-adaptive-program-study.md).

This document is a candidate successor contract. Merging it records a reviewable design proposal only. It does not authorize production implementation. A separate explicit approval/freeze decision must identify the exact approved plan blob/head before any A1 implementation slice begins.

---

## 1. Objective

A1 gives ALCODE a safe way to evolve the canonical meaning and required-work topology of an active long-horizon Program after creation.

The signature capability is:

```text
accepted Program meaning R1
        ↓
current WorkItem / Attempt execution
        ↓
new information reveals missing detail, wrong decomposition, or changed scope
        ↓
bounded semantic revision proposal
        ↓
Host policy + exact authority decision
        ↓
accepted Program meaning R2
        ↓
RevisionImpact
   ┌────┼───────────────┐
   ▼    ▼               ▼
retain  invalidate     add/supersede
valid   affected      required work
work    authority/
        verification
        ↓
continue under R2
        ↓
Completion Oracle proves current semantic closure
```

A1 does **not** make the model canonical authority. The Agent proposes semantic changes. The Host validates, classifies, derives impact, and admits canonical Program revisions. Changes that require user/Application authority remain exact-draft Application decisions.

The target architecture is:

```text
ProgramState
    │
    ├── state revision / CAS generation
    │
    ▼
ProgramRevision
    │
    ▼
RevisionImpact
    │
    ▼
WorkItem
    │
WorkItemGeneration
    │
    ▼
AttemptAuthority
    │
    ▼
ProgramAttempt
    │
    ▼
Agent / Host capabilities / Operations
```

---

## 2. Governing compatibility rule: two different revisions

A1 must preserve the meaning of the existing `ProgramState.revision`.

### 2.1 Existing state revision

```text
ProgramState.revision
```

remains:

> the exact whole-state optimistic-concurrency generation for the canonical current ProgramState.

It continues to advance once for every admitted ProgramState-changing transition, including operational/control transitions.

A1 must not reinterpret historical values or existing `expectedProgramRevision` V1 command fields as semantic topology generations.

### 2.2 New semantic Program revision

A1 introduces a distinct canonical semantic lineage:

```text
ProgramRevision
```

which changes only when accepted Program meaning/topology changes.

Conceptually:

```ts
interface ProgramRevision {
  programRevisionId: ProgramRevisionId;
  parentProgramRevisionId: ProgramRevisionId | null;
  ordinal: number;
  changeClass: "initial" | "refinement" | "correction" | "scope_amendment";
  acceptedAtStateRevision: number;
  semanticReceipt: ProgramSemanticReceipt;
}
```

Exact field names are implementation-selectable before freeze only if the semantics remain equivalent.

A semantic revision admission is itself one ordinary canonical ProgramState mutation and therefore advances `ProgramState.revision` exactly once. Operational ProgramState mutations do not create a new semantic ProgramRevision.

Invariant:

> **State revision answers “is this the exact current state snapshot?” Semantic Program revision answers “is this the current accepted Program meaning?”**

---

## 3. Semantic Program state

An A1 Program must expose a current semantic revision head and bounded revision metadata sufficient to reconstruct current meaning and validate authority.

The current semantic meaning includes at least:

- accepted objective boundary;
- current required WorkItems and dependencies;
- WorkItem generations;
- requirement/topology state;
- current verification definitions/applicability;
- required outputs/production obligations;
- current inherited authority envelopes/semantic constraints.

Historical revision lineage is canonical event history. Current ProgramState must not grow by embedding an unbounded copy of every historical semantic snapshot.

A1 must remain under explicit hard bounds for:

- current WorkItems;
- retained tombstone/lineage records if any;
- dependency edges;
- revisions admitted per Program or per bounded epoch;
- topology expansion per refinement;
- revision proposal bytes;
- revision-impact bytes;
- current canonical ProgramState bytes;
- Agent/Application projections.

The exact numeric additions to `PROGRAM_LIMITS` are implementation-plan details to freeze before implementation, but **unbounded revision/topology growth is prohibited**.

---

## 4. WorkItem identity and generation

A1 introduces a monotonic positive `WorkItemGeneration` for each WorkItem identity.

### 4.1 Identity rule

Preserve `WorkItemId` when the durable semantic obligation is still the same obligation.

Examples:

```text
same obligation
+ clarified description
+ narrowed affected paths
+ changed dependency detail
+ strengthened constraint
        ↓
same WorkItemId
new WorkItemGeneration
```

Use a new WorkItemId when the new work is a materially different obligation.

Examples:

```text
old obligation replaced by a different outcome
        ↓
old WorkItem superseded
new WorkItemId introduced
```

New child obligations introduced by decomposition receive new WorkItemIds.

The Host, not the Agent, canonically decides identity preservation from the admitted semantic revision.

### 4.2 Minimum WorkItem semantic dimensions

A1 canonical WorkItem state must distinguish:

```text
requirementState:
  required
  withdrawn
  superseded

topologyState:
  leaf
  decomposed

execution/satisfaction:
  pending
  active
  blocked
  awaiting_verification
  satisfied
```

The implementation may preserve the existing `lifecycle` field as the serialized execution/satisfaction dimension for compatibility, provided it does not become a second contradictory source of truth.

Required invariants:

```text
decomposed ≠ satisfied
satisfied ≠ verified
verified ≠ currently verified
withdrawn/superseded ≠ silently completed
```

A WorkItem generation change cannot reuse stale Attempt authority or stale work-bound verification as though semantic meaning were unchanged.

---

## 5. Progressive decomposition

A1 allows a current required leaf WorkItem to be replaced semantically by a bounded child DAG while preserving the parent as the durable obligation/lineage anchor.

Conceptually:

```text
W@g3   required / leaf
  │
  │ accepted refinement
  ▼
W@g4   required / decomposed
  ├── W1@g1
  ├── W2@g1
  └── W3@g1
```

### 5.1 Decomposition does not satisfy the parent

Admitting the child graph does not mark `W` satisfied.

The parent obligation becomes satisfiable only when the A1 satisfaction rule for its required decomposition is met. At minimum this requires all current required child/descendant obligations that discharge the parent to be satisfied, with their mandatory current verification obligations satisfied/waived as required by the accepted Program.

The exact derived-vs-explicit parent-satisfaction mechanism must be deterministic and Host-owned. An Agent cannot declare the parent satisfied merely because it proposed children.

### 5.2 Child-graph validity

A decomposition proposal must be rejected unless:

- the target parent is current and required;
- the proposal targets the exact current WorkItemGeneration;
- child IDs are unique/new as required;
- the resulting current required graph remains finite and acyclic;
- all dependencies resolve under the resulting current topology;
- no child enlarges the inherited WorkAuthorityEnvelope;
- topology expansion stays within hard limits;
- required verification minimums are preserved or strengthened;
- no forbidden semantic change is smuggled in as a refinement;
- the change remains within the accepted Program objective/authority boundary.

---

## 6. Program change classes

Every semantic revision after the initial revision has one canonical change class.

### 6.1 Refinement

A **refinement** keeps the required higher-level outcome and authority boundary unchanged while adding/narrowing detail.

Typical examples:

- decompose one current leaf into bounded children;
- clarify a WorkItem description;
- narrow affected paths;
- partition one obligation into more precise obligations;
- strengthen verification or constraints.

Refinement is intended to be the only class that may eventually receive bounded autonomous admission in A1.

### 6.2 Correction

A **correction** changes the current Program interpretation because a prior assumption, decomposition, dependency, or approach was wrong/impossible, while still targeting the original accepted higher-level objective and authority ceiling.

Typical examples:

- supersede a wrong WorkItem with a different obligation;
- remove/replace an impossible branch of the current decomposition;
- materially change dependencies because the original decomposition was incorrect.

Correction is more invalidating than refinement.

**A1 first-slice rule:** corrections require exact Application acceptance of a Host-sealed correction draft. Automatic correction policy is deferred.

### 6.3 Scope amendment

A **scope amendment** changes the accepted outcome or authority boundary.

Examples:

- modify the caller-authored objective;
- add a new external effect domain/system;
- enlarge repository roots/capability ceiling;
- remove a mandatory success criterion;
- weaken verification minimums;
- materially change required outputs;
- relax a forbidden constraint.

**A1 rule:** scope amendment always requires exact Application acceptance of a Host-sealed amendment draft.

### 6.4 Monotonic vs non-monotonic changes

The Host policy should also classify semantic changes by monotonicity.

Generally monotonic:

- add bounded decomposition;
- strengthen verification;
- narrow authority;
- add evidence requirements;
- discover a blocker.

Generally non-monotonic:

- remove required work;
- withdraw verification;
- relax a constraint;
- widen authority;
- change objective;
- replace a previously required obligation.

A candidate may be called `refinement` only when it is monotonic under the frozen RefinementPolicy.

---

## 7. WorkAuthorityEnvelope

Every current required WorkItem has an inherited authority ceiling.

Conceptually:

```ts
interface WorkAuthorityEnvelope {
  objectiveBoundary: unknown;
  allowedRepositoryRoots: string[];
  allowedEffectClasses: string[];
  allowedExternalSystems: string[];
  capabilityCeiling: string[];
  resourceBudget: unknown;
  maximumTopologyExpansion: number;
  verificationMinimums: unknown;
  forbiddenChanges: unknown[];
}
```

The exact bounded representation must be frozen before implementation.

Required semantics:

- root Program authority comes from the accepted Program contract/Application authority;
- a child may specialize, partition, or narrow its parent's envelope;
- a child/refinement may not enlarge its parent's envelope;
- an Agent cannot mint capability or external-system authority through semantic text;
- widening any authority dimension is a scope amendment;
- authority-envelope comparison/admission is Host policy, not model self-classification.

---

## 8. Revision proposal and admission

A1 introduces a bounded semantic-revision proposal path separate from initial Program creation.

### 8.1 Agent proposal is not canonical

A revision-capable Agent may propose:

- target ProgramStateId;
- parent semantic ProgramRevisionId;
- target WorkItemId/WorkItemGeneration where applicable;
- proposed change class;
- bounded semantic edits/decomposition;
- structured rationale/advisory evidence.

The Agent does not choose:

- canonical ProgramRevisionId;
- canonical WorkItem identity/generation decisions;
- canonical RevisionImpact;
- canonical authority-envelope widening;
- acceptance outcome;
- Attempt retention/invalidation;
- verification retention/invalidation.

### 8.2 Semantic parent currentness

Revision proposals are anchored to the current **semantic ProgramRevision**, not the whole-state `ProgramState.revision`.

Operational state changes that do not alter semantic Program meaning do not automatically make the proposal stale.

At canonical admission, the Host:

1. serializes through the canonical admission queue;
2. loads the latest ProgramState;
3. requires the proposal/draft parent semantic ProgramRevision to still be current;
4. revalidates all target WorkItem generations and relevant semantic constraints;
5. applies policy/authorization;
6. derives RevisionImpact;
7. admits the semantic change atomically as one state transition or rejects it.

The Host uses the latest state revision internally for the actual reducer transition. The Agent does not obtain a durable semantic lease by holding an old whole-state revision.

### 8.3 Concurrent proposals

A1 first slice has no semantic auto-merge.

If two proposals target the same current semantic parent:

```text
R12
├── proposal A
└── proposal B
```

and A is admitted as R13, B is stale and must be regenerated/revalidated against R13.

No last-writer-wins semantic merge is allowed.

---

## 9. RefinementPolicy and authorization

The Host owns one bounded `RefinementPolicy`-class decision surface.

A refinement may be auto-admitted only if it is proven to:

- target the current semantic revision/current WorkItem generation;
- preserve the accepted higher-level objective;
- preserve all existing required outcomes;
- stay within/narrow the authority envelope;
- preserve or strengthen verification minimums;
- remain within topology/resource bounds;
- contain no non-monotonic removal/weakening;
- create a valid current DAG;
- produce deterministic bounded RevisionImpact.

If any property is unknown, the proposal is not auto-admitted.

Correction and scope amendment are sealed as exact pending semantic drafts and require Application acceptance in the A1 first slice.

The Host is the canonical admissions authority; the policy evaluator need not claim omniscient semantic understanding. Unknown classification fails closed.

---

## 10. RevisionImpact

Every admitted semantic revision produces one deterministic canonical `RevisionImpact`.

Conceptually:

```ts
interface RevisionImpact {
  fromProgramRevisionId: ProgramRevisionId;
  toProgramRevisionId: ProgramRevisionId;

  unchangedWorkItems: WorkItemGenerationRef[];
  modifiedWorkItems: WorkItemGenerationChange[];
  addedWorkItems: WorkItemGenerationRef[];
  supersededWorkItems: WorkItemGenerationRef[];
  withdrawnWorkItems: WorkItemGenerationRef[];

  retainedAttempts: ProgramAttemptId[];
  invalidatedAttempts: ProgramAttemptId[];

  retainedVerification: VerificationGenerationRef[];
  staleVerification: VerificationGenerationRef[];
}
```

Only the subsets relevant to the current first-slice one-active-Attempt architecture need be populated, but the semantic result must distinguish retained vs invalidated authority.

Required properties:

- derived by pure/bounded Host semantic logic from previous canonical state + accepted semantic change;
- Agent cannot author the canonical impact result;
- admitted atomically with the semantic revision;
- rebuildable from canonical history;
- no distributed consumers independently guess whether “revision changed means stale”.

---

## 11. AttemptAuthority v2

A1 must preserve `ProgramAttemptAuthorityV1` for fixed-topology compatibility. Adaptive Programs use a versioned authority contract.

Conceptually:

```ts
interface ProgramAttemptAuthorityV2 {
  programStateId: string;
  programRevisionId: string;

  programAttemptId: string;
  workItemId: string;
  workItemGeneration: number;

  dependencyReceipt: AttemptDependencyReceipt;
  constraintReceipt: ProgramConstraintReceipt;

  agentGeneration: number;
}
```

The exact receipt representation must be bounded and frozen before implementation. Do not proliferate content digests merely for symmetry; first define the semantic contents that must be rechecked.

### 11.1 State revision is not the long-lived lease

V2 must not require a previously projected whole-state `ProgramState.revision` to remain unchanged for an Attempt to execute.

At every protected Host admission cut, currentness is reconstructed from canonical state.

### 11.2 Required currentness checks

An A1 Attempt can remain current only while all applicable checks hold:

- Program lifecycle active;
- exact ProgramAttemptId still current;
- exact WorkItemId + WorkItemGeneration still current/required;
- relevant dependencies remain satisfied/current as captured by the Attempt dependency receipt;
- relevant Program constraints/authority envelope remain compatible;
- Session remains attached/active;
- AgentGeneration remains current;
- recovery barrier clear;
- writer barriers clear;
- execution base current;
- requested capability remains Host-authorized.

A semantic revision that does not affect these facts may retain the Attempt.

### 11.3 Invalidation cases

RevisionImpact must invalidate/retire the active Attempt when at least:

- its WorkItem is modified to a new generation;
- its WorkItem is withdrawn/superseded;
- a dependency becomes unsatisfied or semantically changes incompatibly;
- its authority envelope changes incompatibly;
- a correction/amendment changes a constraint that the Attempt depends on;
- the resulting current topology makes the Attempt's target no longer executable.

Attempt retirement is canonical before new authority is issued.

### 11.4 Operations remain historical truth

An already Host-admitted Operation is not erased because its Attempt becomes invalid during/after execution. Existing effect/quiescence/reconciliation rules remain authoritative.

---

## 12. Attempt dependency and constraint receipts

A1 introduces typed semantic receipts before deciding where content-addressed digests are useful.

### `AttemptDependencyReceipt`

Must identify enough current semantic dependency state to decide whether the Attempt's prerequisite assumptions still hold, for example:

- dependency WorkItemId;
- dependency WorkItemGeneration;
- required satisfaction state;
- relevant parent/decomposition relation.

### `ProgramConstraintReceipt`

Must identify the subset of Program/Work authority constraints whose change would invalidate the Attempt.

This may include:

- current semantic ProgramRevisionId;
- WorkAuthorityEnvelope generation/reference;
- mandatory WorkItem-scoped constraints.

### Existing execution/capability currentness

Execution-base and inference capability projections already have separate authorities. A1 should reuse them rather than duplicate them inside a semantic receipt unless a concrete admission check requires it.

---

## 13. Verification semantics under adaptive Programs

A1 preserves current `VerificationObligation.subjectGeneration` as verification freshness generation.

It adds explicit semantic applicability.

Conceptually each verification obligation has a subject binding such as:

```text
program-wide
or
WorkItemId + WorkItemGeneration
or
output/production subject tied to a producer WorkItem generation
```

The exact representation must support deterministic RevisionImpact.

### 13.1 Work generation change

When an obligation is bound to a WorkItem generation and that generation changes:

- its old satisfaction cannot remain current for the new semantic subject;
- the Host advances/invalidate its verification subjectGeneration as required;
- old evidence remains historical/provenance and is not rewritten.

### 13.2 Unrelated semantic revision

Verification proven disjoint from the semantic change may remain current.

### 13.3 Program-wide verification

Program-wide obligations remain mandatory. A semantic change invalidates them when their subject definition says the changed Program meaning is material. Unknown impact fails closed.

### 13.4 Workspace mutation remains independent

Workspace/effect changes continue to invalidate verification under the existing execution-freshness rules. Semantic currentness and workspace freshness are separate axes.

Invariant:

> **WorkItemGeneration identifies semantic subject evolution. Verification subjectGeneration identifies evidence freshness.**

---

## 14. Semantic revision transition atomicity

One admitted semantic revision must be atomic at the canonical event/state level.

The committed state must contain, at one serialized cut:

- new semantic ProgramRevision head;
- all WorkItem identity/generation/topology changes;
- verification applicability/generation impact;
- RevisionImpact;
- active Attempt retention or canonical invalidation;
- any pending/accepted semantic-control state required by the change.

Crash/replay outcome must be one of:

```text
old semantic revision fully current
or
new semantic revision fully current
```

Never a partially applied child graph with old Attempt/verification semantics.

Where multiple canonical event records are needed for audit/control surfaces, their admission must preserve an atomic/rebuildable transaction boundary under the existing storage/event doctrine.

---

## 15. Legacy fixed-topology Program compatibility

Historical Phase 1/P-01 Programs remain valid and rebuildable.

A1 must not rewrite historical events or reinterpret historical `ProgramState.revision`.

### 15.1 Baseline adoption

Before a legacy Program can accept an A1 semantic revision, the Host must establish an explicit deterministic semantic baseline representing its existing accepted objective/topology.

The final freeze must choose one of these bounded mechanisms:

- pure deterministic normalization plus canonical baseline identity; or
- explicit Host-admitted `semantic baseline adopted` transition.

Candidate preference: **explicit baseline adoption for semantic mutation**, because it creates an auditable authority boundary and does not pretend historical Phase 1 events contained a semantic revision identity they did not record.

Constraints:

- baseline adoption cannot change Program meaning;
- no active legacy Attempt may silently inherit V2 adaptive authority;
- if an active Attempt exists, adoption waits for/causes a normal safe Attempt boundary according to the final frozen rule;
- legacy Programs that never opt into adaptive semantics continue on existing V1 fixed-topology behavior.

---

## 16. Application authority and public projection

A1 extends Application state without changing the meaning of existing V1 `revision`.

The public projection should expose bounded semantic control information:

- current semantic ProgramRevisionId and ordinal;
- WorkItem generation;
- requirement/topology state;
- pending correction/scope-amendment draft;
- change class;
- bounded RevisionImpact summary when operationally relevant;
- whether an active Attempt was retained or invalidated by the latest semantic revision.

### 16.1 Exact semantic draft acceptance

Correction/scope-amendment acceptance follows the existing Program-creation doctrine:

```text
Agent / Host reasoning proposes
        ↓
Host validates + seals exact semantic draft
        ↓
Application observes exact digest + parent semantic revision
        ↓
Application accepts exact draft
        ↓
Host rechecks semantic parent/currentness
        ↓
canonical admission
```

The Application never accepts “whatever the current Agent means now”.

Existing rebase/cancel/session commands retain their current whole-state revision semantics unless separately versioned for a demonstrated reason.

---

## 17. Recovery and rebuild

Recovery precedes new mutation/execution exactly as today.

A1 adds semantic reconstruction requirements:

- rebuild exact current semantic revision head from canonical history;
- rebuild WorkItem identities/generations/topology;
- rebuild current RevisionImpact/control state;
- rebuild retained/invalidated Attempt authority;
- rebuild verification currentness without consulting current model output;
- recover pending semantic drafts deterministically;
- reject stale draft acceptance after parent semantic revision changes.

A Host restart cannot ask the model to reconstruct “what the Program probably meant”.

Existing Operation/effect/quiescence/reconciliation recovery semantics remain unchanged.

---

## 18. Cancellation and terminal races

Cancellation remains authority cutoff, not rollback.

A1 must serialize races between:

- semantic revision admission;
- correction/amendment acceptance;
- Program cancellation;
- Completion Oracle admission.

Required semantics:

- once cancelled, no later semantic revision can become current;
- a semantic draft accepted against a stale/cancelled parent is rejected;
- an already admitted Operation keeps its independent effect/recovery truth;
- completion/cancellation remain mutually exclusive;
- a revision cannot remove completion burden and race the Completion Oracle without passing the current semantic terminal cut.

---

## 19. Completion Oracle changes

A1 preserves all current Completion Oracle checks and adds semantic closure.

Completion requires, at one protected canonical cut:

- Program lifecycle active;
- current semantic revision valid/current;
- no pending required semantic admission/amendment that already forms canonical completion burden;
- every current required leaf obligation satisfied;
- every decomposed required parent discharged under the deterministic decomposition-satisfaction rule;
- no unresolved required decomposition marker;
- mandatory verification current for the current semantic subjects;
- no open blocker;
- no active Attempt;
- execution base current;
- no outstanding Program Operation;
- no indeterminate effect/unresolved reconciliation;
- no writer barrier;
- no retryable durable work;
- artifact integrity current.

A WorkItem being withdrawn/superseded counts only according to an explicitly accepted current semantic revision. It is not equivalent to silently marking work complete.

---

## 20. Eligibility and scheduling

A1 extends the pure eligibility model to current semantic topology.

Ready work must be derived from:

- current required WorkItems;
- current WorkItemGeneration;
- current leaf/decomposition relationships;
- satisfied current dependencies;
- blocker state;
- execution-base/recovery state at operational admission.

The A1 first slice still supports one active ProgramAttempt per Workspace execution domain.

No general parallel scheduler is introduced.

Staging remains:

```text
A1  eligibility / Attempt admission semantics
A7  execution placement / parallel workspace scheduling
A8  delegation scheduling
A10 autonomous Program policy scheduling
```

---

## 21. Agent revision proposal surface

A1 may add an Agent Protocol capability such as `program_revision_v1` without changing `AGENT_PROTOCOL_VERSION` if additive capability negotiation remains sufficient; otherwise the plan freeze must explicitly version the protocol.

A revision-capable Agent may receive:

- current semantic ProgramRevision identity;
- current WorkItem generation/topology;
- bounded authority envelope;
- revision proposal tool/message;
- Host decision/result.

The Agent must not receive raw canonical mutation APIs.

The Host may expose bounded semantic planning reads for revision formation, reusing the P-01 tracked-read doctrine. Any repository observations that materially support a semantic revision must have Host-owned provenance/currentness.

---

## 22. Required semantic invariants

A1 implementation must prove at least:

1. `ProgramState.revision` retains its historical whole-state CAS meaning.
2. Semantic ProgramRevision changes only for accepted semantic changes.
3. Every ProgramRevision has one current parent lineage; no hidden fork becomes current.
4. WorkItemGeneration is monotonic per WorkItemId.
5. Same WorkItemId never changes semantic generation without explicit canonical revision impact.
6. Superseded/withdrawn work does not disappear from causal history.
7. Decomposition does not satisfy the parent by itself.
8. Child authority never exceeds parent/Program authority.
9. RevisionImpact is Host-derived and rebuildable.
10. Unaffected Attempt authority may survive unrelated semantic revision.
11. Affected Attempt authority cannot execute after invalidation.
12. Already admitted Operations retain effect/recovery truth after semantic invalidation.
13. WorkItemGeneration and Verification subjectGeneration are distinct.
14. Stale verification cannot satisfy a changed semantic subject.
15. Stale semantic proposals/draft acceptances fail closed.
16. Correction/scope amendment cannot self-authorize through the Agent.
17. Recovery reproduces exact semantic lineage/current authority.
18. Completion cannot succeed with unresolved required decomposition.
19. No A1 path creates same-Workspace parallel Attempts.
20. Legacy V1 fixed-topology Programs remain rebuildable/continuable.

---

## 23. Explicit exclusions

A1 does **not** add:

- Capability Workflow VM / Code Mode;
- arbitrary generated Python/JavaScript/shell execution;
- container sandbox implementation;
- learned/reusable procedures;
- procedure optimization;
- general parallel ProgramAttempts;
- Git-worktree execution placement;
- durable subagent/delegation teams;
- remote workers/SSH/VM execution;
- autonomous portfolio scheduling;
- dynamic self-installing Agent plugins;
- enterprise approval/RBAC/governance.

A1 also does not weaken:

- Operation/effect uncertainty;
- writer/quiescence barriers;
- recovery-before-mutation;
- exact Application creation/rebase/cancel authority;
- Host verification;
- Completion Oracle authority;
- Agent-generation replacement semantics.

---

## 24. Candidate acceptance criteria

These are **candidate** acceptance criteria until an explicit A1 freeze.

### AC-A1-01 — Separate state and semantic revision

The pure Program kernel introduces a rebuildable semantic ProgramRevision lineage while preserving the existing `ProgramState.revision` whole-state CAS semantics. Tests prove operational transitions advance state revision without creating semantic revisions, and semantic revision admission advances both exactly as specified.

### AC-A1-02 — WorkItem identity, generation, and bounded topology

WorkItems gain monotonic semantic generation and explicit requirement/topology semantics. The kernel deterministically validates current required topology, supersession/withdrawal, parent/child decomposition, hard bounds, and the identity-preservation rules.

### AC-A1-03 — Bounded revision proposal and stale-parent arbitration

A revision-capable Agent/Host path can propose a bounded semantic change against an exact parent semantic revision/current target WorkItem generation. The Host rejects stale concurrent proposals and admits no semantic last-writer-wins merge.

### AC-A1-04 — Safe refinement and progressive decomposition

A monotonic bounded refinement within the inherited WorkAuthorityEnvelope may be admitted by frozen RefinementPolicy. Decomposition creates a valid child DAG, does not satisfy the parent by itself, cannot weaken verification minimums, and cannot widen authority.

### AC-A1-05 — Correction and scope-amendment authority

Corrections and scope amendments are Host-sealed exact drafts requiring explicit Application acceptance. Stale digest/parent/cancelled Program acceptance fails closed. The Agent cannot self-authorize either class.

### AC-A1-06 — Canonical RevisionImpact

Every admitted semantic revision atomically records/derives deterministic RevisionImpact for WorkItems, active Attempt authority, and verification currentness. Rebuild produces the same result without model inference.

### AC-A1-07 — Unaffected Attempt retention

With an active Attempt for W1, admit a semantic refinement affecting only independent W3. W1 retains the exact current ProgramAttemptId/WorkItemGeneration authority and can execute a Host capability afterward despite whole-state and semantic Program revision changes.

### AC-A1-08 — Affected Attempt invalidation

When a revision changes/supersedes/withdraws the active Attempt's WorkItem generation or invalidates a required dependency/constraint, old authority is retired before the new semantic revision can issue replacement execution authority. Stale execute/progress/capability messages reject.

### AC-A1-09 — Verification semantic impact

Work-bound/program-wide verification has deterministic semantic applicability. Affected semantic changes stale/advance the required verification freshness generation; provably unrelated obligations may remain current; unknown impact fails closed. Old evidence remains historical and cannot satisfy the new subject.

### AC-A1-10 — Recovery, legacy baseline, and replacement

Host reopen rebuilds semantic revision lineage and current authority exactly. Legacy fixed-topology Programs remain valid and require the frozen baseline-adoption boundary before adaptive mutation. Agent replacement preserves Program/semantic truth but still uses fresh Agent/Attempt authority under existing recovery rules.

### AC-A1-11 — Cancellation and Completion Oracle

Cancellation races semantic revision/draft acceptance safely. Completion remains Host-only and additionally proves no unresolved required decomposition/current semantic burden remains. Decomposition, withdrawal, or supersession cannot become an implicit completion shortcut.

### AC-A1-12 — Exact composed A1 gate and closure record

A dedicated exact-head A1 gate composes all closed P-01/S-01/Phase 1 correctness gates plus A1 semantic/adversarial/recovery/protocol proofs and emits the existing machine-readable GateReceipt. A1 closes only when that exact-head gate passes and an as-built closure record maps every frozen acceptance criterion.

---

## 25. Required scenarios

### Scenario A — Unrelated refinement while work is active

```text
R12: active Attempt A on W1@g2
→ refine independent W3@g1 into children
→ R13
→ RevisionImpact retains A
→ A executes capability successfully under fresh Host recheck
```

Proves semantic revision does not globally invalidate unrelated execution.

### Scenario B — Decompose active work

```text
R20: Attempt A targets W@g3
→ accepted refinement decomposes W
→ W@g4 + children C1/C2
→ RevisionImpact invalidates A
→ stale A capability rejected
→ fresh eligible child Attempt later issued
```

### Scenario C — Concurrent proposals

```text
R30
├─ proposal P1
└─ proposal P2
→ P1 admitted as R31
→ P2 stale
→ no semantic auto-merge / hidden fork
```

### Scenario D — Correction invalidates current verification

```text
W@g4 verified current
→ accepted correction changes same obligation materially
→ W@g5
→ affected verification stale/new freshness generation
→ prior evidence remains historical only
```

### Scenario E — Scope amendment exact acceptance

```text
Agent proposes wider external effect domain
→ Host classifies scope_amendment
→ exact sealed amendment draft
→ no authority change before Application acceptance
→ stale/wrong-digest acceptance rejected
```

### Scenario F — Crash at semantic revision admission

Crash before/after the canonical cut rebuilds either the complete old semantic revision or the complete new semantic revision, never a partial topology/impact state.

### Scenario G — Agent replacement after retained revision

An unrelated semantic revision retains WorkItem meaning, then Agent A dies. Replacement still retires old Agent/Attempt authority under S-01/P-01 semantics and issues fresh authority; semantic retention does not imply worker identity retention.

### Scenario H — Cancellation race

Exact Application cancellation races correction/amendment acceptance. Canonical admission serializes to one valid outcome; a cancelled Program cannot later acquire a new semantic revision.

### Scenario I — Completion with decomposition

All original top-level parents are decomposed but one required descendant is unsatisfied. Completion Oracle blocks. Completion succeeds only after current required decomposition is fully discharged and current verification is satisfied.

---

## 26. Candidate implementation order

This order is dependency guidance only. It is not implementation authorization.

1. **Pure semantic kernel**
   - semantic ProgramRevision identity/head;
   - WorkItemGeneration;
   - requirement/topology semantics;
   - legacy normalization/baseline contract;
   - validator/limits.

2. **Revision transaction + RevisionImpact**
   - bounded change representation;
   - change classification;
   - pure impact derivation;
   - atomic transition semantics;
   - concurrency tests.

3. **Host revision proposal/admission control**
   - revision-capable planning/proposal transport;
   - RefinementPolicy;
   - correction/amendment sealing;
   - Application exact acceptance.

4. **AttemptAuthority v2**
   - dependency/constraint receipts;
   - Host currentness checks;
   - unaffected retention;
   - affected invalidation;
   - stale V2 message proofs.

5. **Verification semantic applicability**
   - explicit semantic subject binding;
   - RevisionImpact-driven invalidation/retention;
   - existing workspace freshness composition.

6. **Eligibility/decomposition/completion**
   - current required graph derivation;
   - decomposed-parent discharge;
   - successor dispatch;
   - Completion Oracle semantic closure.

7. **Recovery/projection/legacy/product integration**
   - rebuild/reopen;
   - baseline adoption;
   - Application/Agent projections;
   - replacement/cancellation races.

8. **A1 exact-head gate + as-built closure**
   - composed historical gates;
   - adversarial scenarios;
   - closure mapping.

The final freeze may restack these slices if repository dependency analysis demonstrates a safer sequence. The semantic acceptance boundary, not the PR numbering, is authoritative.

---

## 27. Gate requirements

A future `pnpm gate:a1` (exact name freezeable) should prove four categories.

### Semantic proof

- revision/state-generation separation;
- WorkItem identity/generation;
- valid decomposition;
- deterministic RevisionImpact;
- verification semantic applicability;
- Completion semantic closure.

### Adversarial lifecycle proof

- stale concurrent proposals;
- stale Attempt after affected revision;
- retained Attempt after unrelated revision;
- stale Application amendment acceptance;
- cancellation/revision races;
- Agent replacement.

### Recovery proof

- crash/rebuild around semantic admission;
- legacy baseline;
- interrupted Operations unaffected by semantic history rewrite;
- exact revision lineage after Host reopen.

### Capability proof

- retained Attempt can still execute only after fresh Host admission checks;
- invalidated Attempt cannot execute;
- authority envelope cannot widen via refinement;
- semantic revision cannot bypass CapabilityBroker/Operation truth.

The A1 gate must compose the authoritative closed P-01 product gate rather than replacing it.

---

## 28. Metrics

A1 should add diagnostic metrics useful for evaluating adaptive planning quality without making them correctness authority:

- semantic revision count;
- refinement/correction/scope-amendment count;
- revision acceptance/rejection/stale-parent rate;
- WorkItem generation churn;
- supersession/withdrawal rate;
- decomposition depth;
- unnecessary WorkItems;
- missed obligations discovered later;
- unrelated Attempt invalidation rate;
- retained Attempt rate;
- verification invalidation/retention rate;
- human semantic correction rate;
- average current WorkItem lifetime.

Candidate quality metric:

```text
semantic stability ratio
=
meaningful Program progress
/
semantic topology churn
```

These are evaluation surfaces, not Host admission predicates unless a future frozen policy explicitly says otherwise.

---

## 29. Approval/freeze rule

This document is not self-approving.

Before A1 implementation begins, a separate explicit decision must:

1. identify the exact repository head/blob containing the reviewed plan;
2. resolve all open contract questions called out by review;
3. freeze the semantic acceptance criteria;
4. confirm the implementation sequence/gate boundary;
5. state that A1 implementation is authorized.

Until then:

```text
roadmap: active
A1 study: complete enough for review
A1 plan: candidate
A1 implementation: NOT AUTHORIZED
```

A successful future A1 closure authorizes no A2 implementation automatically.
