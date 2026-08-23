# ALCODE A1 — Adaptive Program Revision and Progressive Decomposition Plan

**Status:** **DRAFT — freeze-resolution candidate; not approved; not frozen; implementation not authorized.**  
**Prepared:** 2026-08-24 against `main@093b273ee455307fc1793c2fc12a6cadec53b216`.  
**Predecessor:** P-01 Production Program Agent is closed.  
**Roadmap:** [`roadmap.md`](./roadmap.md), A1.  
**As-built study:** [`a1-adaptive-program-study.md`](./a1-adaptive-program-study.md).

This revision incorporates the architecture-review consensus on the A1 candidate. It closes the semantic contract questions that can be decided from the current architecture without inventing unsupported performance numbers or protocol assumptions. It remains a candidate successor contract only. A separate explicit approval/freeze decision must identify the exact reviewed plan blob/head and resolve the remaining evidence-dependent freeze blockers before any A1 implementation slice begins.

---

## 0. Freeze-resolution decisions

The following decisions are normative for this candidate and replace earlier ambiguous language.

1. **State revision and semantic Program revision remain separate.** `ProgramState.revision` stays the exact whole-state CAS generation. `ProgramRevision` is a separate accepted semantic lineage.
2. **A1 first slice does not auto-admit semantic revisions.** Refinement, correction, and scope amendment all require exact Application acceptance of one Host-sealed semantic draft. Structural classification remains Host-owned, but classification alone does not grant semantic admission authority.
3. **Unknown semantic classification is rejected, not escalated automatically.** The Host returns a bounded reason; a fresh proposal may be formed explicitly against the current semantic head.
4. **WorkAuthorityEnvelope comparison is mechanical only.** No natural-language semantic-equivalence test is privileged Host authority. Unknown/incomparable envelope dimensions cannot satisfy a narrowing proof.
5. **Parent discharge is derived, recursive, and non-vacuous.** `decomposed != satisfied`; a required decomposed parent with zero current required direct children is unresolved and cannot complete.
6. **Decomposing already satisfied work is a correction.** It cannot be classified as a refinement.
7. **Attempt dependency receipts are direct-only in A1.** A captured direct dependency generation change invalidates the dependent Attempt in the first slice. No “compatible dependency generation change” optimization is attempted.
8. **`issuedUnderProgramRevisionId` is provenance, not an equality lease.** V2 Attempt currentness is reconstructed from exact Attempt/work/dependency/constraint/Agent/execution facts, so unrelated semantic revisions may retain an Attempt.
9. **Verification semantic subjects are explicit.** WorkItem and output subjects bind to exact WorkItem generations; program-wide verification is conservatively staled by every admitted semantic revision in the first slice.
10. **Verification is never transferred implicitly across supersession/withdrawal.** Old obligations/evidence become historical; successor obligations are explicitly admitted.
11. **One admitted semantic revision is one canonical atomic semantic-cut event.** Replay observes either the complete previous semantic head or the complete new semantic head, never a partial topology/impact state.
12. **Legacy adoption is explicit and quiescent.** No active V1 Attempt is converted in place. Adaptive semantics begin only after an exact baseline-adoption boundary with recovery/effect/writer barriers clear.
13. **Pending semantic drafts are noncanonical Program meaning and do not block Completion.** Only admitted state and canonical blockers contribute to the Completion Oracle.
14. **At most one sealed pending semantic draft exists per Program in A1.** A stale parent invalidates the draft; there is no automatic semantic rebase.
15. **Revision proposals are Host-requested revision-planning episodes, not execution-Attempt tool calls.** A normal execution request cannot mutate Program meaning.
16. **First-dispatch/current-execution facts may never be inferred from `ProgramState.revision == 1`.** They are derived from canonical Attempt history or an equivalent explicit execution-state fact.
17. **Already admitted Operations remain historical environmental truth across semantic invalidation.** Semantic change grants no rollback or reinterpretation authority.
18. **A1 remains one-active-Attempt-per-Workspace.** No same-Workspace parallel execution is introduced.

Two items remain explicit freeze blockers because this review did not provide sufficient evidence to choose them safely:

- exact new numeric A1 limits for decomposition depth/fan-out/revision count/proposal-impact bytes;
- final Agent-protocol wire-version strategy for V2 execution/revision messages after compatibility tests.

Existing Phase 1 limits (`workItems = 128`, `totalDependencyEdges = 1024`, canonical ProgramState = 4 MiB) remain ceilings unless an explicitly reviewed limit change is justified before freeze.

---

## 1. Objective

A1 gives ALCODE a safe way to evolve the canonical meaning and required-work topology of an active long-horizon Program after creation while preserving existing Host authority over execution, environmental effects, recovery, verification, and completion.

```text
accepted Program meaning R1
        ↓
current WorkItem / Attempt execution
        ↓
new information reveals missing detail, wrong decomposition, or changed scope
        ↓
Host-requested bounded revision planning
        ↓
Agent proposal
        ↓
Host structural validation + classification + exact draft seal
        ↓
Application accepts exact draft
        ↓
Host rechecks current semantic parent
        ↓
atomic ProgramRevision R2 + RevisionImpact
        ↓
retain unaffected authority / invalidate affected authority
        ↓
continue under R2
        ↓
Completion Oracle proves current semantic closure
```

The Agent is a proposal engine. The Host owns canonical validation, classification, identity decisions, impact derivation, execution admission, verification truth, and the semantic transition. The Application owns acceptance of every semantic revision in the A1 first slice.

Target architecture:

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
AttemptAuthorityV2
    │
    ▼
ProgramAttempt
    │
    ▼
Agent / Host capabilities / Operations
```

---

## 2. Two different revisions

### 2.1 `ProgramState.revision`

`ProgramState.revision` remains the exact whole-state optimistic-concurrency generation. It advances once for every admitted ProgramState-changing transition, including operational/control transitions.

A1 must not reinterpret historical values or existing V1 `expectedProgramRevision` fields as semantic topology generations.

### 2.2 `ProgramRevision`

A1 adds a separate semantic lineage that changes only when accepted Program meaning/topology changes.

Conceptually:

```ts
interface ProgramRevision {
  programRevisionId: ProgramRevisionId;
  parentProgramRevisionId: ProgramRevisionId | null;
  ordinal: number;
  changeClass: "initial" | "refinement" | "correction" | "scope_amendment";
  acceptedAtStateRevision: number;
  admissionEventId: string;
  sourceDraftId: string | null;
  sourceDraftDigest: string | null;
}
```

The full current semantic state is canonical ProgramState plus the admitted revision event. The lineage record does not embed unbounded historical semantic snapshots.

A semantic revision admission is one ordinary ProgramState mutation and therefore advances `ProgramState.revision` exactly once. Operational transitions do not create a new semantic `ProgramRevision`.

Invariant:

> **State revision answers “is this the exact current state snapshot?” Semantic Program revision answers “what accepted Program meaning is current?”**

---

## 3. Bounded semantic Program state

Current semantic meaning includes at least:

- accepted objective boundary reference;
- current required WorkItems and dependency edges;
- WorkItem generations;
- requirement/topology state;
- explicit verification definitions and semantic subjects;
- required outputs/production obligations;
- current authority envelopes and mandatory semantic constraints.

Historical revision lineage is append-only canonical history. Current ProgramState must not embed every historical semantic snapshot.

A1 adds hard bounds for:

- decomposition depth;
- direct children introduced by one decomposition;
- semantic revisions per Program;
- revision proposal bytes;
- RevisionImpact bytes;
- sealed pending semantic draft bytes.

The exact new numbers remain a freeze blocker. The freeze must select them from repository state-size analysis and gate fixtures rather than arbitrary review guesses. Existing WorkItem/edge/state ceilings do not increase by default.

No retry/replanning loop may bypass these bounds by repeated small revisions.

---

## 4. WorkItem identity, generation, and orthogonal state

`WorkItemGeneration` is a monotonic positive integer **per `WorkItemId`**.

### 4.1 Identity disposition is explicit canonical data

A semantic draft/revision contains an explicit Host-sealed identity disposition for every affected obligation:

```text
preserve_identity_and_advance_generation
new_identity_supersedes_old
withdraw_identity
unchanged
```

The Agent may propose a disposition, but the Host seals the exact disposition and the Application accepts that exact draft. Recovery never re-infers identity from natural-language similarity.

For the first slice, preserve identity only for bounded change forms that continue the same durable obligation, including decomposition of that obligation, structural narrowing, strengthened constraints/verification, or an explicitly accepted correction that retains the same required outcome. A materially different required outcome uses a new WorkItemId and supersedes the old one.

Every semantic change to a preserved WorkItem identity advances its generation exactly once in that revision. Unchanged WorkItems do not advance generation merely because the global semantic revision changes.

New child obligations always receive new WorkItemIds at generation 1.

### 4.2 Orthogonal state dimensions

A1 canonical WorkItem semantics distinguish:

```text
requirementState:
  required
  withdrawn
  superseded

topologyState:
  leaf
  decomposed

satisfactionState:
  pending
  active
  blocked
  awaiting_verification
  satisfied
```

The implementation may map the existing serialized `lifecycle` field to `satisfactionState` for compatibility, but there must be one canonical source of truth.

Required mapping for legacy execution states:

```text
pending                -> pending
in_progress            -> active
blocked                -> blocked
awaiting_verification  -> awaiting_verification
completed              -> satisfied
```

Required invariants:

```text
decomposed ≠ satisfied
satisfied ≠ verified
verified ≠ currently verified
withdrawn/superseded ≠ silently satisfied
```

---

## 5. Progressive decomposition and discharge

A1 allows a current required leaf to become a bounded child DAG while retaining the parent as the durable lineage anchor.

```text
W@g3 required / leaf
  │ accepted semantic revision
  ▼
W@g4 required / decomposed
  ├── C1@g1
  ├── C2@g1
  └── C3@g1
```

### 5.1 Derived non-vacuous discharge

Decomposition never sets the parent satisfied merely because children exist.

For A1, parent discharge is a pure Host-derived predicate:

```text
discharged(W) :=
  W.requirementState == required
  AND W.topologyState == decomposed
  AND currentRequiredDirectChildren(W).size > 0
  AND every current required direct child C satisfies:
        C.satisfactionState == satisfied
        OR discharged(C)
```

This rule is recursive through bounded decomposition depth.

A required decomposed parent with zero current required direct children is an **unresolved decomposition**, not a satisfied obligation. A correction that removes all current required children must in the same admitted semantic revision do one of:

- re-leaf the parent with an executable current generation;
- supply replacement required children;
- supersede the parent;
- withdraw the parent under explicitly accepted correction/scope semantics.

There is no vacuous discharge.

Downstream dependencies on a decomposed parent remain blocked until that parent is discharged. A child cannot independently satisfy an external dependency on the parent in A1.

Mandatory verification remains a separate Completion requirement for the current semantic subjects; discharge does not rewrite verification truth.

### 5.2 Decomposing satisfied work

Decomposing a WorkItem whose current satisfaction state is `satisfied` is always a **correction**, never a refinement. Its generation advances and all active Attempts whose direct dependency receipt captured the old generation are invalidated.

### 5.3 Child-graph validity

A semantic draft containing decomposition is rejected unless:

- the target is current, required, and the exact current WorkItemGeneration;
- child IDs are unique/new;
- the resulting current required graph is finite, acyclic, and within hard bounds;
- every dependency resolves under the resulting topology;
- superseding a node also relinks, supersedes, or withdraws every dependent edge so no current dependency targets invalid work;
- child authority envelopes are mechanically equal to or narrower than the parent envelope;
- mandatory verification is not silently weakened;
- the exact identity/generation changes are explicit in the sealed draft.

---

## 6. Semantic change classes

Every semantic revision after `initial` has one Host-sealed change class.

### 6.1 Refinement

A refinement is a monotonic structural/detail change that preserves the accepted objective boundary and does not remove required outcomes or widen authority.

Candidate forms include:

- bounded decomposition of a current unsatisfied leaf;
- narrowing repository roots/effect/capability/external-system authority;
- adding mandatory constraints;
- strengthening verification;
- narrowing affected paths.

### 6.2 Correction

A correction changes prior accepted interpretation while remaining under the same accepted objective/authority ceiling.

Examples:

- superseding a wrong WorkItem;
- replacing an impossible decomposition branch;
- materially changing dependencies;
- decomposing already satisfied work;
- withdrawing previously required work while retaining the same top-level objective.

### 6.3 Scope amendment

A scope amendment changes the accepted objective or authority ceiling.

Examples:

- change the caller-authored objective;
- introduce an external system not already permitted by the governing envelope;
- widen repository roots/effect classes/capability ceiling;
- remove a mandatory top-level success criterion;
- weaken verification minimums;
- materially change required outputs;
- relax a forbidden constraint.

Using an external system already present in the inherited `allowedExternalSystems` set does not by itself widen authority; adding one outside that set is a scope amendment.

### 6.4 First-slice admission rule

**All three semantic change classes require exact Application acceptance in A1.**

The Host still classifies because classification governs validation, impact, projection, and future policy evolution. But A1 does not give a structural policy semantic-meaning authority.

Unknown or ambiguous classification is rejected with a bounded structured reason. It is not silently converted to another class and is not auto-escalated into an Application draft.

Blocker discovery remains an operational ProgramState fact unless admitting the blocker also changes Program meaning. A blocker transition by itself does not create a semantic ProgramRevision.

---

## 7. Mechanical `WorkAuthorityEnvelope`

A1 uses only mechanically comparable authority dimensions.

Conceptually:

```ts
interface WorkAuthorityEnvelopeV1 {
  objectiveBoundaryRef: {
    programStateId: string;
    rootProgramRevisionId: string;
    anchorWorkItemId: string | null;
  };
  allowedRepositoryRoots: string[];
  allowedEffectClasses: string[];
  allowedExternalSystems: string[];
  capabilityCeiling: string[];
  maximumTopologyExpansion: number;
  mandatoryVerificationIds: string[];
  forbiddenChangeKinds: string[];
}
```

All collections are canonical, deduplicated, bounded, and ordered before comparison.

Mechanical partial order:

- `objectiveBoundaryRef`: must be equal for refinement/correction under the same authority ceiling; changing it requires scope-amendment authority;
- `allowedRepositoryRoots`: every child root must be equal to or a normalized descendant of an allowed parent root;
- `allowedEffectClasses`: child set must be a subset of parent set;
- `allowedExternalSystems`: child set must be a subset of parent set;
- `capabilityCeiling`: child set must be a subset of parent set;
- `maximumTopologyExpansion`: child value must be `<=` parent value;
- `mandatoryVerificationIds`: child/refined set may preserve or add mandatory requirements but may not remove parent-required IDs under refinement;
- `forbiddenChangeKinds`: child/refined set may preserve or add forbidden kinds but may not remove them under refinement.

Any unknown/incomparable dimension is not mechanically narrower. Natural-language rationale/description is never evidence for authority containment.

A1 deliberately does **not** invent a new resource-budget authority system. If later stages add canonical resource budgets, they may extend this envelope under their own frozen contract.

---

## 8. Revision planning, draft lifecycle, and admission

### 8.1 Host-requested revision planning

Semantic revision formation occurs in a distinct Host-requested revision-planning episode. A normal ProgramAttempt execution request or capability tool call cannot propose canonical Program mutation.

A revision-planning episode may be requested while an unrelated Attempt remains active, but it has separate request identity and no execution authority.

A revision-capable Agent may propose:

- ProgramStateId;
- exact parent ProgramRevisionId;
- target WorkItemId/WorkItemGeneration where applicable;
- proposed change class;
- bounded structured semantic edits;
- advisory rationale/evidence.

The Agent does not choose canonical revision IDs, identity dispositions, RevisionImpact, Attempt retention, verification impact, or acceptance outcome.

### 8.2 One sealed pending draft per Program

A1 permits at most one sealed pending semantic draft per Program.

Draft lifecycle:

```text
Agent proposal
  ↓
Host validates/classifies/derives candidate impact
  ↓
sealed_pending
  ↓ Application accepts exact digest
accepted → canonical semantic revision

or

stale_parent / rejected / cancelled / superseded
  ↓
terminal noncanonical draft
```

Sealed drafts are durable control records but are **not** current Program meaning.

If any semantic revision becomes current before a pending draft is accepted, the old draft becomes stale. There is no automatic semantic rebase. A new proposal must target the new semantic head and receive fresh exact acceptance.

### 8.3 Admission cut

At canonical admission the Host:

1. serializes through the canonical admission queue;
2. loads latest ProgramState;
3. requires Program lifecycle `active`;
4. requires the exact accepted draft parent ProgramRevisionId still current;
5. revalidates exact target WorkItem generations;
6. revalidates envelope/topology/verification constraints;
7. recomputes deterministic RevisionImpact from latest canonical state + exact sealed change;
8. requires the recomputed result to match the sealed draft semantics/impact receipt;
9. admits one canonical semantic-cut event or rejects the command.

Operational state revision changes alone do not stale a semantic draft if all semantic targets remain current.

### 8.4 Concurrent proposals

There is no semantic auto-merge and no last-writer-wins merge.

Given two proposals against R12, once one becomes R13 the other is stale. Admission queue order defines the deterministic winner of a race at the canonical cut; the stale proposal is not replayed or merged automatically.

---

## 9. Structural classification policy

`RefinementPolicy` in A1 is a bounded structural validator/classifier, **not an auto-admission oracle**.

It may prove facts such as:

- exact current parent/generation targeted;
- bounded edit kind;
- valid DAG;
- mechanical envelope narrowing/equality;
- no structural removal under refinement;
- verification minimum set preserved/strengthened;
- all state/topology limits respected.

It may not claim privileged proof that arbitrary natural-language text “means the same thing.”

If semantic equivalence is needed to accept the proposal, that semantic decision is embodied in the exact Application acceptance of the Host-sealed draft.

Unknown structural classification or unknown authority comparison is rejected with a stable reason code.

Future autonomous refinement admission requires a separate frozen objective that defines a mechanically decidable refinement algebra or equivalent proof authority. A1 does not authorize it.

---

## 10. Canonical `RevisionImpact`

Every admitted semantic revision has one deterministic Host-derived impact.

Conceptually:

```ts
interface RevisionImpactV1 {
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
  addedVerification: VerificationGenerationRef[];
  reboundVerification: VerificationGenerationChange[];
  retiredVerification: VerificationGenerationRef[];

  retainedOutputs: string[];
  addedOutputs: string[];
  modifiedOutputs: string[];
  retiredOutputs: string[];
}
```

Exact field names may change before freeze, but these semantic distinctions may not collapse into a single “revision changed” flag.

Required properties:

- pure/bounded Host derivation from previous canonical state + exact accepted semantic edit;
- no model-authored canonical impact;
- deterministic for the same state/edit;
- admitted in the same atomic semantic cut;
- rebuildable from canonical history;
- consumers use canonical impact/currentness rather than independently guessing staleness.

### 10.1 Conservative first-slice dependency impact

If an active Attempt's direct dependency receipt contains `W@g1` and the revision changes that direct dependency to `W@g2`, the Attempt is invalidated even if the new dependency later appears behaviorally compatible. A1 does not attempt semantic compatibility proof across dependency generations.

### 10.2 Supersession edge validity

A semantic edit that supersedes/withdraws a WorkItem is invalid unless every current dependent edge is simultaneously relinked, superseded, or withdrawn such that the resulting required graph has no dependency on non-current work.

---

## 11. `ProgramAttemptAuthorityV2`

V1 remains valid for fixed-topology Programs. Adaptive Programs issue only V2 Attempts after semantic baseline/initialization.

Conceptually:

```ts
interface ProgramAttemptAuthorityV2 {
  programStateId: string;
  issuedUnderProgramRevisionId: string; // provenance, not equality lease

  programAttemptId: string;
  workItemId: string;
  workItemGeneration: number;

  dependencyReceipt: AttemptDependencyReceiptV1;
  constraintReceipt: ProgramConstraintReceiptV1;

  agentGeneration: number;
}
```

### 11.1 V2 currentness

A previously projected whole-state revision is not a V2 long-lived lease. At every protected Host capability/progress/execute admission cut, currentness is reconstructed from canonical state.

An Attempt remains current only while:

- Program lifecycle is active;
- exact ProgramAttemptId is still current;
- exact WorkItemId + WorkItemGeneration is current and required;
- each direct dependency receipt entry still matches the same dependency generation and is currently satisfied/discharged;
- exact constraint/envelope receipt remains current;
- Session remains attached/active;
- AgentGeneration remains current;
- recovery barrier is clear;
- writer/quiescence barriers are clear;
- execution base remains current;
- requested capability remains Host-authorized.

A newer ProgramRevision does not by itself stale the Attempt.

### 11.2 Invalidation

RevisionImpact retires the Attempt before replacement authority can issue when:

- its WorkItem generation changes;
- its WorkItem is superseded/withdrawn;
- a direct dependency generation changes;
- a direct dependency becomes unsatisfied/undischarged;
- its exact authority/constraint receipt changes;
- current topology no longer permits the target work.

Subsequent capability/progress/execute messages from the retired authority fail stale.

### 11.3 Fresh admission after retention

Retention means **same Attempt identity and semantic scope survive**. It does not bypass capability admission. A retained Attempt's next capability call is freshly checked against current canonical state.

---

## 12. Typed dependency and constraint receipts

### 12.1 Direct-only `AttemptDependencyReceiptV1`

Conceptually:

```ts
interface AttemptDependencyReceiptEntryV1 {
  workItemId: string;
  workItemGeneration: number;
  required: true;
  satisfiedOrDischargedAtIssue: true;
}

interface AttemptDependencyReceiptV1 {
  entries: AttemptDependencyReceiptEntryV1[];
}
```

The receipt contains **direct dependencies only**, canonically ordered and bounded. Transitive change propagates through the direct dependency's generation/discharge state rather than expanding the receipt to the transitive Program graph.

A direct dependency generation mismatch invalidates the Attempt in A1.

### 12.2 `ProgramConstraintReceiptV1`

Conceptually:

```ts
interface ProgramConstraintReceiptV1 {
  workAuthorityEnvelope: WorkAuthorityEnvelopeV1;
  mandatoryConstraintIds: string[];
}
```

The exact normalized envelope/constraint values are the semantic assumptions. A ProgramRevisionId is not used as an equality currentness token inside this receipt.

Execution-base and capability-projection authority remain independently checked by their existing mechanisms rather than duplicated inside the semantic receipt.

---

## 13. Verification semantic subjects

A1 preserves `VerificationObligation.subjectGeneration` as **evidence freshness generation** and adds a separate semantic subject.

```ts
type VerificationSubjectV1 =
  | { kind: "program" }
  | {
      kind: "work_item";
      workItemId: string;
      workItemGeneration: number;
    }
  | {
      kind: "output";
      outputSlotId: string;
      producerWorkItemId: string;
      producerWorkItemGeneration: number;
    };
```

### 13.1 WorkItem subject

If the bound WorkItem generation changes, the old obligation/satisfaction cannot satisfy the new semantic subject. The old evidence remains historical. A newly admitted/rebound obligation receives the required fresh `subjectGeneration` semantics.

### 13.2 Output subject

Output verification is bound to the exact producer WorkItem generation. Producer generation change retires/rebinds the old semantic obligation as specified by RevisionImpact. Verification is never silently transferred.

### 13.3 Program subject

For A1 first slice, **every admitted semantic ProgramRevision stales current program-wide verification**. This is intentionally conservative and measurable. Later optimization may retain program-wide verification only under a separately frozen materiality proof.

### 13.4 Supersession/withdrawal

When a WorkItem is superseded/withdrawn, semantic verification obligations bound to that WorkItem/output are retired from current force in the same semantic revision. Successor WorkItems receive explicit new/rebound obligations through the accepted revision. Historical evidence is retained as provenance and never rewritten.

### 13.5 Workspace freshness remains independent

Workspace/effect changes continue to invalidate verification under existing execution-freshness rules. Semantic subject identity and workspace evidence freshness are separate axes.

Invariant:

> **WorkItemGeneration identifies semantic subject evolution. Verification subjectGeneration identifies evidence freshness.**

---

## 14. Atomic semantic revision event

One admitted semantic revision is exactly one canonical semantic-cut event, conceptually:

```text
program.semantic_revision.admitted
```

Its payload contains enough bounded canonical post-state/control data to establish in one cut:

- new ProgramRevision head;
- WorkItem identity/generation/topology changes;
- verification semantic subjects/currentness changes;
- output/production semantic changes within A1 scope;
- RevisionImpact;
- active Attempt retention/invalidation;
- accepted draft provenance.

The event may continue the repository's snapshot-in-payload pattern. Additional notifications/projections may be derived later, but rebuild authority may not depend on a second event being appended.

Crash/replay result is:

```text
complete previous semantic head
OR
complete new semantic head
```

never a partially admitted semantic graph.

A later corrective semantic revision is the rollback mechanism. Historical accepted ProgramRevisions are never deleted or rewritten.

---

## 15. Legacy fixed-topology adoption

Legacy Phase 1/P-01 Programs remain valid indefinitely under V1 fixed-topology behavior unless they explicitly adopt adaptive semantics.

### 15.1 Exact baseline-adoption authority

Adaptive mutation of a legacy Program requires an exact Application baseline-adoption command/draft. The Host emits one explicit canonical baseline event, conceptually:

```text
program.semantic_baseline.adopted
```

It establishes:

- `ProgramRevision` ordinal 1 / `changeClass: initial`;
- current existing WorkItems at generation 1;
- current requirement/topology state derived without changing meaning;
- explicit authority envelopes;
- explicit verification subjects;
- identity/no-op RevisionImpact for adoption itself.

Baseline adoption does **not** stale current verification merely because the lineage is created.

For legacy verification whose semantic applicability cannot be reconstructed more narrowly from canonical historical facts, the baseline binds it conservatively as `program` subject. The first later semantic revision therefore stales it.

### 15.2 Quiescent adoption preconditions

Baseline adoption requires at one protected cut:

- Program lifecycle active;
- no active ProgramAttempt;
- no outstanding Program Operation owned by the Program;
- no unresolved/indeterminate effect or reconciliation;
- no writer barrier;
- recovery clear;
- execution base not in an unresolved mismatch/unavailable state.

An active V1 Attempt is never converted in place. After adoption, all newly issued Attempts for that Program use V2 authority.

Legacy Programs that never adopt remain V1 and are not rewritten.

---

## 16. Application authority, draft visibility, and Completion

### 16.1 Exact acceptance for every semantic revision

Every semantic revision follows:

```text
Host-requested revision planning
        ↓
Agent proposal
        ↓
Host validation + classification + candidate impact
        ↓
Host seals exact draft + digest + parent semantic head
        ↓
Application accepts exact draft
        ↓
Host rechecks latest semantic currentness
        ↓
canonical semantic admission
```

The Application never accepts “whatever the Agent currently means.”

### 16.2 Pending draft is noncanonical

A sealed pending draft is durable control state, not accepted Program meaning.

It therefore:

- does not change eligibility;
- does not change Attempt authority;
- does not change verification currentness;
- does not itself block Completion.

If the Host has discovered a fact that must block Completion, it records a canonical blocker/review-required fact under existing/new explicit Program semantics; the existence of a draft is not the blocker.

If Completion or cancellation becomes canonical before draft acceptance, subsequent draft acceptance fails stale/terminal.

### 16.3 Public projection

Application projection adds bounded fields for:

- current ProgramRevisionId/ordinal;
- WorkItem generation;
- requirement/topology/satisfaction state;
- current authority-envelope summary;
- one pending semantic draft if present;
- change class;
- latest bounded RevisionImpact summary;
- whether current Attempt was retained/invalidated by the latest revision.

Existing public `revision` retains its whole-state meaning.

---

## 17. Recovery and rebuild

Recovery must reconstruct without model inference:

- current semantic revision head/lineage;
- WorkItem IDs/generations/topology;
- authority envelopes;
- verification semantic subjects + freshness;
- current RevisionImpact/control state;
- V1 versus V2 Program mode;
- retained/invalidated Attempt authority;
- one pending semantic draft and its exact parent/digest state.

Stale draft acceptance after reopen fails deterministically.

Existing Operation/effect/quiescence/reconciliation recovery remains unchanged and precedes new mutation/execution.

---

## 18. Cancellation, in-flight Operations, and terminal races

Cancellation remains authority cutoff, not rollback.

Canonical admission serializes races among:

- semantic revision acceptance;
- cancellation;
- Completion;
- Attempt retirement/issue.

Required semantics:

- cancelled Program cannot later acquire a new semantic revision;
- stale/cancelled draft acceptance rejects;
- completion/cancellation remain mutually exclusive;
- semantic revision cannot erase or reinterpret an already admitted Operation;
- if an in-flight Operation later confirms or becomes indeterminate after its Attempt is semantically invalidated, its effect/quiescence/reconciliation truth is still processed normally;
- replacement mutation cannot bypass existing uncertainty/recovery barriers.

No semantic revision receives “credit attribution” for pre-revision partial effects. Newly eligible work verifies against current workspace truth through normal Host verification.

---

## 19. Completion Oracle semantic closure

Completion remains a pure Host decision over admitted canonical state/effect/recovery facts.

At one protected cut it requires:

- Program lifecycle active;
- current semantic ProgramRevision valid;
- every current required leaf satisfied;
- every current required decomposed parent discharged under the recursive non-vacuous rule;
- no unresolved required decomposition;
- mandatory verification current for every current semantic subject;
- no open canonical blocker;
- no active Attempt;
- execution base current;
- no outstanding Program Operation;
- no indeterminate effect/unresolved reconciliation;
- no writer barrier;
- no retryable durable work;
- artifact integrity current.

**Pending semantic drafts do not block Completion.** If a draft later matters, it must be accepted before Completion; after Program completion its acceptance is stale.

Withdrawal/supersession affects Completion only through an explicitly admitted current semantic revision. Removing all children of a decomposed parent without re-leaf/supersede/withdraw/replacement is unresolved, not complete.

---

## 20. Eligibility, scheduling, and first dispatch

Ready work is derived from:

- current required WorkItems;
- current WorkItem generations;
- leaf/decomposition relationships;
- direct dependency satisfaction/discharge;
- blocker state;
- execution-base/recovery state at operational admission.

A1 remains one active ProgramAttempt per Workspace execution domain.

**First dispatch/current execution state must never be inferred from `ProgramState.revision == 1`.** The Host derives whether any Attempt has been issued from durable Attempt history or an equivalent explicit canonical execution-state fact.

Staging remains:

```text
A1  semantic eligibility / Attempt admission
A7  execution placement / parallel workspace scheduling
A8  delegation scheduling
A10 autonomous Program policy scheduling
```

---

## 21. Agent protocol surface

A1 introduces additive capability concepts for:

- revision planning;
- ProgramAttemptAuthorityV2 execution/progress/capability admission.

A revision proposal is accepted only within a Host-requested revision-planning request scope.

The Agent receives bounded current semantic context and no raw canonical mutation API.

### 21.1 Remaining protocol-version freeze blocker

The desired compatibility rule is:

- V1 Agents/Programs continue fixed-topology behavior unchanged;
- adaptive Programs require an Agent that explicitly negotiates V2 Program execution/revision capabilities;
- the Host never sends V2 authority/messages to a V1-only Agent.

Before final freeze, protocol tests must determine whether this can be implemented as additive negotiated message/version capability under the existing `AGENT_PROTOCOL_VERSION` or requires incrementing the connection protocol version. The architecture does not assume the answer without parser/negotiation proof.

---

## 22. Required semantic invariants

A1 implementation must prove at least:

1. `ProgramState.revision` retains historical whole-state CAS meaning.
2. ProgramRevision advances only for admitted semantic changes/baseline initialization.
3. Semantic lineage has one current parent chain; no hidden fork becomes current.
4. WorkItemGeneration is monotonic per WorkItemId.
5. Identity disposition/generation change is explicit in canonical RevisionImpact.
6. Superseded/withdrawn work remains in causal history.
7. Decomposition never satisfies a parent by itself.
8. Required decomposed parent with zero current required children is unresolved, never vacuously discharged.
9. Child authority never exceeds parent/Program authority under mechanical comparison.
10. Unknown authority/classification does not auto-admit.
11. Every semantic revision requires exact Application acceptance in A1.
12. RevisionImpact is Host-derived, deterministic, and rebuildable.
13. Unaffected Attempt identity may survive unrelated semantic revision.
14. `issuedUnderProgramRevisionId` is provenance, not global staleness authority.
15. Direct dependency generation change invalidates a dependent Attempt in A1.
16. Affected Attempt cannot execute after canonical invalidation.
17. Retained Attempt capability calls still pass fresh Host currentness/admission checks.
18. Already admitted Operations retain effect/recovery truth after semantic invalidation.
19. WorkItemGeneration and Verification subjectGeneration remain distinct.
20. Verification semantic subjects are explicit; stale evidence cannot satisfy a changed subject.
21. Superseded/withdrawn verification is retired, not implicitly transferred.
22. Program-wide verification stales on every semantic revision in the first slice.
23. Stale proposals/draft acceptances fail closed; no semantic auto-merge/rebase.
24. Pending drafts are noncanonical and do not block Completion.
25. Legacy V1 Programs remain rebuildable/continuable; adoption is explicit and quiescent.
26. Recovery reproduces exact semantic lineage/current authority without model inference.
27. Completion cannot succeed through unresolved/vacuous decomposition.
28. No A1 path creates same-Workspace parallel Attempts.
29. First-dispatch semantics do not depend on magic state revision values.
30. Semantic correction is append-only history; no ProgramRevision rollback/rewrite exists.

---

## 23. Explicit exclusions

A1 does **not** add:

- autonomous semantic refinement admission;
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
- enterprise approval/RBAC/governance;
- multi-Attempt execution inside one Workspace domain.

A1 also does not weaken Operation/effect uncertainty, writer/quiescence barriers, recovery-before-mutation, Host verification, Completion Oracle authority, or Agent-generation replacement semantics.

---

## 24. Candidate acceptance criteria

These remain candidate criteria until explicit freeze.

### AC-A1-01 — Separate state and semantic revisions

Pure Program kernel introduces rebuildable ProgramRevision lineage while preserving whole-state `ProgramState.revision`. Operational transitions advance only state revision; semantic admission advances state revision once and semantic lineage once.

### AC-A1-02 — WorkItem identity/generation and bounded topology

Kernel validates explicit identity disposition, monotonic generation, orthogonal requirement/topology/satisfaction state, acyclic bounded topology, dependency validity, non-vacuous decomposition, and all frozen limits. Adversarial proposals exceeding any frozen bound reject without changing Program meaning.

### AC-A1-03 — Exact semantic draft authority and stale arbitration

Host-requested revision planning produces bounded proposals. Host seals at most one exact pending draft per Program. All semantic revisions require exact Application acceptance; stale parent/digest/cancelled/terminal acceptance rejects. No semantic auto-merge/rebase exists.

### AC-A1-04 — Mechanical authority containment

Every child/refined WorkAuthorityEnvelope is mechanically equal/narrower under the frozen partial order. Unknown/incomparable or wider authority cannot pass refinement validation. No text rationale can mint authority.

### AC-A1-05 — Change-class correctness

Refinement/correction/scope amendment classifications follow frozen structural rules; decomposing satisfied work is correction; unknown classification rejects. Change class never bypasses exact Application acceptance.

### AC-A1-06 — Canonical atomic RevisionImpact

Every admitted semantic revision is one atomic canonical semantic-cut event containing deterministic RevisionImpact across WorkItems, current Attempt, verification subjects/currentness, and A1 output obligations. Crash/rebuild yields complete old or complete new semantic state only.

### AC-A1-07 — Unaffected Attempt retention

With active Attempt A on independent W1, accept a semantic revision affecting only W3. A keeps the same ProgramAttemptId/WorkItemGeneration and can execute a later Host capability under fresh currentness/admission checks despite whole-state and semantic revision changes.

### AC-A1-08 — Affected Attempt invalidation

Changing/superseding/withdrawing A's WorkItem, changing a direct dependency generation/satisfaction, or changing its exact constraint receipt retires A before replacement authority. Stale execute/progress/capability messages reject.

### AC-A1-09 — Explicit verification semantic impact

Verification uses explicit `VerificationSubjectV1`. Work/output subject changes retire/rebind affected obligations without transferring stale evidence. Program-wide verification stales on every semantic revision in A1. Workspace freshness remains independently enforced.

### AC-A1-10 — Legacy adoption and V1/V2 boundary

Legacy Program adoption is exact, explicit, meaning-preserving, identity-impact, and quiescent. No active V1 Attempt is converted. New post-adoption Attempts are V2; legacy Programs that never adopt continue V1 behavior.

### AC-A1-11 — Completion and terminal correctness

Completion blocks on unsatisfied leaves, undischarged parents, zero-child unresolved decomposition, stale verification, blockers, active operations/Attempts, uncertainty/recovery barriers, and existing terminal requirements. Pending drafts alone do not block Completion. Cancellation/Completion/revision races serialize correctly.

### AC-A1-12 — First-dispatch and eligibility correctness

Eligibility derives from current semantic topology and operational facts. Tests prove first dispatch/current execution is not inferred from `ProgramState.revision == 1`. A1 never creates same-Workspace parallel Attempts.

### AC-A1-13 — In-flight mutation survives semantic invalidation as effect truth

An already admitted mutating Operation may settle after its Attempt is invalidated. Confirmation/indeterminacy/quiescence/reconciliation remain canonical and block replacement mutation where existing recovery rules require it. Semantic revision neither erases nor reassigns the effect.

### AC-A1-14 — Exact composed A1 gate and closure

Exact-head A1 gate composes the authoritative P-01/S-01/Phase 1 gates plus all frozen A1 semantic/adversarial/recovery/protocol proofs and emits the existing machine-readable GateReceipt. Closure requires an as-built mapping for every frozen AC.

---

## 25. Required adversarial scenarios

### Scenario A — unrelated semantic revision retains active Attempt

```text
R12: Attempt A on W1@g2
→ exact accepted revision decomposes independent W3
→ R13
→ RevisionImpact retains A
→ A capability passes fresh Host recheck
```

### Scenario B — decompose active work

```text
Attempt A targets W@g3
→ accepted decomposition
→ W@g4 + C1/C2
→ A invalidated
→ stale capability rejected
→ later child Attempt receives fresh authority
```

### Scenario C — concurrent proposals

Two proposals target R30. One exact acceptance wins canonical admission as R31; the other becomes stale. No merge/rebase is automatic.

### Scenario D — correction stales verification

Verified W@g4 becomes W@g5 under accepted correction. Old work/output verification is retired/staled; evidence remains historical only.

### Scenario E — scope amendment cannot self-authorize

Agent proposes wider external-system authority. Host classifies scope amendment, seals exact draft, and no authority changes until exact Application acceptance.

### Scenario F — crash at semantic admission

Replay reconstructs complete previous or complete new semantic head, never partial topology/impact.

### Scenario G — Agent replacement after retained semantic revision

Semantic revision retains W meaning, then Agent dies. S-01/P-01 replacement semantics still retire worker/Attempt authority as required; semantic retention does not imply Agent identity retention.

### Scenario H — cancellation race

Cancellation races semantic draft acceptance. One canonical outcome wins; cancelled Program never gains later ProgramRevision.

### Scenario I — decomposition completion

A required descendant remains unsatisfied. Parent not discharged and Completion blocks.

### Scenario J — ambiguous classification

Host cannot structurally classify proposal or compare envelope. Proposal rejects with stable diagnostic; no draft/admission/partial state change occurs.

### Scenario K — bound exhaustion

Proposal exceeds each frozen A1 topology/revision/payload bound. Host rejects and current Program semantics continue unchanged.

### Scenario L — envelope smuggling

Child/refinement widens repository root/effect/external-system/capability authority or removes a forbidden/verification requirement. Validation rejects; natural-language rationale cannot override comparison.

### Scenario M — vacuous discharge

Accepted correction attempts to withdraw all children of a required decomposed parent without re-leaf/replacement/supersession/withdrawal. Semantic validation rejects or Completion remains blocked; parent cannot become implicitly satisfied.

### Scenario N — revision against already satisfied work

Proposal decomposes satisfied W. Host classifies correction, exact Application acceptance is required, W generation advances, and active dependent Attempts on the old direct generation invalidate.

### Scenario O — in-flight mutation settles after semantic invalidation

```text
Attempt A admits may_write Operation O
→ semantic revision invalidates A
→ O later confirms OR becomes indeterminate
→ effect/quiescence/reconciliation truth settles normally
→ no replacement mutation bypasses uncertainty barriers
```

### Scenario P — pending draft versus Completion

A sealed but unaccepted draft exists. If current admitted Program semantics independently satisfy Completion, Completion may become canonical; subsequent draft acceptance fails terminal/stale. Draft existence alone is not Completion burden.

### Scenario Q — first-dispatch after operational churn/baseline

Program has state revision >1 before its first adaptive Attempt. Scheduler still issues exactly the correct first Attempt based on canonical Attempt history/execution facts, proving no `revision == 1` dependency.

---

## 26. Candidate implementation dependency order

This is dependency guidance, not authorization.

1. **Semantic kernel**
   - ProgramRevision identity/head;
   - WorkItemGeneration + identity disposition;
   - orthogonal WorkItem state;
   - WorkAuthorityEnvelope comparison;
   - VerificationSubject definitions;
   - discharge predicate;
   - validators/limits.

2. **Atomic revision transaction + RevisionImpact**
   - bounded semantic edit representation;
   - structural classification;
   - full deterministic impact derivation;
   - single semantic-cut event;
   - concurrency/crash proofs.

3. **Semantic draft/Application control**
   - Host-requested revision planning;
   - one-pending-draft lifecycle;
   - exact digest/parent acceptance;
   - stale/terminal arbitration.

4. **AttemptAuthorityV2 + receipts**
   - direct dependency receipt;
   - constraint/envelope receipt;
   - currentness checks;
   - retention/invalidation;
   - stale message proofs.

5. **Eligibility + Completion integration**
   - current required graph;
   - discharge/dependency rules;
   - first-dispatch semantics;
   - Completion semantic closure.

6. **Legacy/recovery/projection/protocol integration**
   - explicit quiescent baseline adoption;
   - rebuild/reopen;
   - Application/Agent projections;
   - V1/V2 negotiation proof;
   - replacement/cancellation races.

7. **A1 exact-head gate + as-built closure**
   - composed historical gates;
   - Scenarios A-Q;
   - closure mapping.

The verification subject model is deliberately in slice 1 so RevisionImpact is implemented against already-defined semantic subjects rather than revised later.

---

## 27. Gate requirements

A future exact-head A1 gate must prove:

### Semantic proof

- two-revision separation;
- explicit identity/generation transitions;
- mechanical envelope containment;
- non-vacuous recursive discharge;
- deterministic full RevisionImpact;
- explicit verification subjects;
- first-dispatch semantic independence from state revision;
- Completion semantic closure.

### Authority/adversarial proof

- all semantic revisions require exact Application acceptance;
- unknown classification rejects;
- stale concurrent proposals/drafts reject;
- retained Attempt survives unrelated semantic revision only under fresh Host admission;
- affected Attempt cannot execute;
- bound exhaustion fails closed;
- envelope smuggling fails closed;
- no same-Workspace parallel Attempt path appears.

### Recovery/effect proof

- crash/rebuild around semantic cut;
- explicit legacy baseline adoption;
- V1/V2 boundary after adoption;
- in-flight Operations keep effect truth after semantic invalidation;
- exact semantic lineage after Host reopen;
- uncertainty barriers still govern replacement mutation.

### Protocol/product proof

- negotiated adaptive capability surface rejects incompatible Agents;
- Application projection preserves old `revision` meaning and exposes bounded new semantic fields;
- pending draft/Completion/cancellation races behave as frozen;
- A1 gate composes the authoritative P-01 product gate rather than replacing it.

---

## 28. Metrics

Diagnostic only, never correctness authority in A1:

- semantic revision count by class;
- accepted/rejected/stale proposal rate;
- WorkItem generation churn;
- decomposition depth/fan-out;
- supersession/withdrawal rate;
- retained/invalidated Attempt rate;
- verification retained/staled/rebound/retired rate;
- program-wide verification rerun cost;
- human semantic correction rate;
- average semantic-draft lifetime;
- bound-rejection rate;
- first-dispatch/baseline-adoption failures.

Candidate quality metric:

```text
semantic stability ratio
=
meaningful Program progress
/
semantic topology churn
```

No latency/SLO target is frozen without benchmark evidence.

---

## 29. Remaining freeze blockers

The architecture review has reduced the unresolved boundary to two evidence-dependent decisions.

### 29.1 Numeric A1 limits

Before freeze, repository fixtures/size analysis must select exact values for:

- `MAX_DECOMPOSITION_DEPTH`;
- `MAX_CHILDREN_PER_DECOMPOSITION`;
- `MAX_SEMANTIC_REVISIONS_PER_PROGRAM`;
- revision proposal bytes;
- RevisionImpact bytes;
- sealed semantic-draft bytes.

Existing current WorkItem/edge/ProgramState ceilings remain unchanged unless the same review explicitly changes them.

### 29.2 Agent protocol versioning

Before freeze, exact protocol compatibility tests must decide whether V2 Program execution/revision can be an additive negotiated capability under the existing connection protocol or requires incrementing `AGENT_PROTOCOL_VERSION`.

Either outcome must preserve:

```text
V1 Program + V1 Agent → existing fixed-topology behavior
adaptive Program       → V2-capable Agent required
V1-only Agent          → never receives V2 authority/message
```

No implementation slice may begin until these two blockers are resolved and the exact plan blob is explicitly frozen.

---

## 30. Approval/freeze rule

This document is not self-approving.

A separate explicit freeze decision must:

1. identify the exact repository head and plan blob reviewed;
2. resolve §29 numeric limits and protocol versioning;
3. confirm the normative decisions in §0;
4. freeze AC-A1-01 through AC-A1-14 and required Scenarios A-Q;
5. confirm the implementation dependency order/gate boundary;
6. explicitly authorize A1 implementation.

Until then:

```text
roadmap: active
A1 study: complete
A1 freeze-resolution plan: candidate
A1 implementation: NOT AUTHORIZED
```

A successful future A1 closure authorizes no A2 implementation automatically.
