# ALCODE Phase 1.0 — Durable ProgramState

**Status:** DRAFT — consolidated candidate contract; not approved; not frozen; implementation not authorized  
**Planning base:** Phase 0.9 closed; Phase 1.0 planning studies and measurements consolidated through `main` at `dfe4e09bd0d7e8bc0a4b89fb8cef99b6e4c1ad7f`  
**Approval rule:** this document becomes frozen and may authorize implementation only after a separate explicit approval decision.

> This document is the consolidated Phase 1.0 working contract. It incorporates the resolved planning decisions previously recorded in the artifact-evidence amendment and the Phase 1.0 decision, creation, execution-freshness, execution-base, verification-predicate, and structural-bounds studies. Those documents remain design history and rationale; where they conflict with this consolidated plan, this plan is the current DRAFT candidate. Consolidation is not approval or freeze.

## 1. Objective

Phase 1.0 gives ALCODE a Host-owned durable unit of work that can outlive any one chat/session, Agent process, Host process, or execution episode.

The unit is **ProgramState**. It is the canonical durable representation of one long-horizon coding objective: immutable accepted intent, bounded required-work topology, blockers, mandatory verification obligations, decisive evidence/artifact references, current execution authority, session attachments, and terminal state.

The signature result is:

```text
caller supplies an objective
→ Host runs bounded read-only planning
→ Agent proposes an initial required DAG + mandatory verification
→ Application accepts one exact Host-owned draft
→ Host creates one ProgramState atomically
→ Session A executes only current eligible work
→ legitimate Workspace effects advance the execution base
→ Agent/Host/session may be replaced or stopped
→ Host reopens and rebuilds exact Program truth
→ Session B attaches the same ProgramStateId
→ stale attempts/results reject
→ unexpected Workspace divergence requires explicit rebase
→ current mandatory verification is satisfied or explicitly waived
→ Host Completion Oracle completes ProgramState exactly once
```

`ProgramStateId` is the single cross-session durable identity for this semantic unit. Phase 1.0 does not introduce a competing `TaskId`.

Phase 1.0 does not reopen Phases 0.0–0.9. Existing operation/reconciliation, transcript, context, capability, policy, artifact, and CodeIntelligence systems remain substrates with their existing authorities. ProgramState composes them without turning observations or model output into canonical Program truth.

## 2. Governing invariants

1. **Host canonical authority.** Only the Host admits canonical ProgramState transitions. The Agent may propose bounded semantic data/evidence; the Experience Plane may issue authorized Application commands; neither directly appends `program.*`, mutates projections, satisfies verification by assertion, or declares completion.
2. **Program identity is independent of session identity.** A ProgramState may span sessions; a session attaches to at most one ProgramState; stopped sessions are never revived to continue it.
3. **No transcript reconstruction of Program truth.** Rebuild uses canonical Program/operation/control events and deterministic reducers, never conversational text parsing.
4. **Exact currentness.** Any current-state mutation requiring a Program revision requires `expectedProgramRevision === currentProgramRevision`. Missing, malformed, lower, or higher values reject before semantic admission.
5. **Fresh attempt identity.** Every dispatch mints a new non-reusable `ProgramAttemptId`; stale, interrupted, superseded, replaced, or terminal attempts cannot admit current work/evidence/verification claims.
6. **Ready work is derived.** Eligibility derives from canonical lifecycle, direct dependencies, blockers, mandatory verification/work state, attached active execution state, and scheduler/attempt state. `ready` is never Agent-authored canonical truth.
7. **Initial required topology is immutable in the first slice.** The exact required DAG becomes canonical at creation. Agent-originated post-creation scope expansion is not a Phase 1.0 authority path; the Agent may report discovered work/blockers as advisory structured information.
8. **Bounded DAG.** Required work is finite and acyclic; unknown dependency IDs, self-dependencies, cycles, malformed duplicates, and any local/aggregate limit breach reject deterministically.
9. **One active ProgramAttempt per Workspace runtime/admission domain.** Programs sharing one Workspace serialize execution attempts. Independent Workspace runtimes may execute independently. Phase 1.0 has no same-Workspace parallel ProgramAttempts.
10. **No implicit background execution.** Dispatch requires an active attached session/execution episode. Host startup, eligibility, or an Agent idle signal does not itself authorize dispatch.
11. **Execution freshness has two axes.** `WorkspaceEffectGeneration` records replayable Host-known confirmed Workspace-effect lineage; `ExecutionObservationIdentity` records a complete bounded Host observation. A trusted `ProgramAttemptExecutionBase` requires both.
12. **Boundary-checked freshness, not filesystem isolation.** The Host coordinates Host-mediated Workspace mutators and checks observations at defined cuts. Arbitrary external writers may still race between cuts or perform undetectable ABA. Phase 1.0 makes no stronger shared-worktree claim.
13. **Effect certainty and mutator quiescence are distinct.** A terminal or confirmed operation effect does not prove its writer/descendants stopped. Unknown quiescence remains a durable/rebuildable Workspace writer barrier.
14. **Indeterminate mutation remains uncertainty.** It blocks trusted continuation/retry/completion until reconciliation; it never becomes `absent` or `confirmed` by inference from later bytes.
15. **Attempt-originated operations are durably correlated once.** Program ownership is declared at the root operation and inherited through `operationId`; no second link authority is introduced.
16. **Verification is per-obligation and generation-indexed.** Each mandatory obligation owns a monotonic `subjectGeneration`; only evidence or a waiver for the exact current generation is current.
17. **Unknown verification impact fails closed.** Known overlap invalidates; provably disjoint impact may retain currentness; unknown impact advances/invalidates the affected obligation rather than optimistically reusing proof.
18. **Artifact identity is not evidence admission.** Retained bytes/ArtifactRef presence never by themselves become current Program evidence. Artifact-backed evidence uses the same attempt/provenance and `subjectGeneration` rules as every other evidence source.
19. **Completion contract is immutable.** The accepted objective, required DAG, mandatory verification definitions, output slots/production steps, and creation-time policy additions are not rewritten by runtime evidence.
20. **Completion is Host-only and serialized.** `program.completed` is admitted only by the Completion Oracle on one exact canonical cut; `program.completed` and `program.cancelled` are mutually exclusive.
21. **Cancellation is authority cutoff, not rollback.** Exact-revision Application cancellation atomically invalidates the active ProgramAttempt and makes the Program terminal, while outstanding operation effect/reconciliation facts remain independently true.
22. **Projections are rebuildable.** Removing/rebuilding Program projections from canonical history reproduces the same semantic current state without process memory, current plugin registries, mutable current policy, or current model output.
23. **Observation never becomes canonical semantic authority.** Git, files, CodeIntelligence, watchers, model reasoning, tool output, and artifact contents are observations/evidence/provenance inputs only.
24. **Reasoning and ProgramState remain independent reducers.** Reasoning may support evidence but does not directly satisfy Program verification or mutate ProgramState.
25. **Existing product defaults remain unchanged.** `verbatim-v1` remains the default and `graph-v1` remains opt-in.

## 3. Ownership and package architecture

```text
Experience Plane / Application client
        │ exact commands, approvals, read models
        ▼
┌─────────────────────────────────────────────────────┐
│                    ALCODE HOST                      │
│                                                     │
│ ProgramService / Program scheduler                  │
│   ├─ Program creation control                       │
│   ├─ canonical admission                            │
│   ├─ Program reducer/projection                     │
│   ├─ session attachment                             │
│   ├─ ProgramAttempt issuance                        │
│   ├─ Workspace execution-base coordinator           │
│   ├─ operation/evidence correlation                 │
│   ├─ verification freshness/admission               │
│   ├─ cancellation/rebase authority                  │
│   ├─ recovery barrier                               │
│   └─ Completion Oracle                              │
│                                                     │
│ existing Host authority remains: policy,            │
│ capabilities, operations, recovery, transcript,     │
│ context, cognition, artifacts                       │
└───────────────────────┬─────────────────────────────┘
                        │ Agent Protocol
                        ▼
                 replaceable Agent
                 proposal/evidence client

CANONICAL EVENT LOG
  program.* + operation/control/runtime events
        │
        ├─ rebuildable ProgramState projection
        └─ rebuildable execution/operation ownership state
```

`@alcode/program-state` is a pure semantic package containing Program domain types, deterministic reducer/transition validation, DAG/eligibility derivation, verification state derivation, bounded projection helpers, and pure Completion Oracle inputs/results. It performs no filesystem, SQLite, process, network, capability, model, scheduler, or ArtifactStore I/O.

`@alcode/host-runtime` owns creation, exact command/attempt admission, Workspace coordination, observations, scheduling, capability/operation correlation, verification evidence admission, rebase/cancel authority, recovery, and terminal decisions.

`@alcode/storage` owns persistence/projection mechanics only. The canonical event log remains the source of semantic truth.

## 4. Identity model and canonical operation ownership

`ProgramStateId` is a branded UUIDv7 cross-domain identity. Program-local identities include at least:

- `ProgramWorkItemId`;
- `ProgramAttemptId`;
- `VerificationObligationId`;
- `ProgramBlockerId`;
- `ProgramOutputSlotId`;
- `ProgramArtifactProductionStepId`.

The canonical event envelope may carry optional `programStateId?: ProgramStateId`; legacy and non-Program events remain valid without it. Adding this optional field must preserve historical event fingerprints/digests: an omitted historical field stays omitted for the historical canonical serialization and is never reinterpreted as explicit `null` merely because the newer schema knows the field.

For a ProgramAttempt-originated capability operation:

```text
operation.requested root
  envelope.programStateId = P
  payload.programAttemptId = A
  payload.operationId = O
  payload.workspaceAccessClass = request-time Host classification
```

`WorkspaceAccessClass` is a closed Host classification equivalent to `no_workspace_access | read_only | may_write`. Its exact spelling is implementation-owned, but the request-time value is immutable canonical root-operation history. Replay never asks the current capability/provider registry how an old operation should have been classified.

All later operation lifecycle/evidence/reconciliation events inherit Program ownership through `operationId = O`; they do not repeat `ProgramAttemptId` as a competing authority. Efficient projections may denormalize P/A.

The exact current P/A/revision/Agent-generation validity check and root `operation.requested` admission share one canonical serialization point. Any pre-admission asynchronous checks are revalidated at that cut.

Provider/binding/containment identity is persisted operation-locally only where the selected capability/recovery contract needs that exact historical incarnation to prove containment/quiescence. Phase 1.0 does not bind a whole ProgramAttempt to one provider snapshot and does not interrupt attempts merely because an unrelated provider generation changes.

## 5. Program creation and immutable contract authorship

### 5.1 Roles

The caller/Application authors the source objective. The Agent may semantically propose the initial required work topology and task-specific verification burden. The Host owns planning provenance, deterministic structural/policy validation, exact pending-draft control, canonical creation, and any non-removable Host policy requirements. The Application/user is the authorization principal that accepts the exact semantic draft.

Moving model inference inside the Host does not turn model-authored semantics into deterministic Host policy.

### 5.2 Read-only planning and `PlanningObservationIdentity`

Pre-Program planning is bounded and read-only. Every semantic Workspace/repository read influencing the proposal must be covered by exactly one of two Host-owned provenance modes:

**Immutable-snapshot mode**

```text
Host fixes one bounded immutable planning snapshot S
before the first semantic planning read
→ every permitted semantic planning read is served exclusively from S
→ PlanningObservationIdentity binds profile/version, Workspace/root identity,
  coverage contract, and immutable snapshot state identity/digest
```

A live mutable view that is merely digested after planning is not this mode.

**Tracked-dependency mode**

```text
for every semantic planning read delivered to the Agent:
  Host attaches observation/dependency identity at delivery time
→ Host accumulates a bounded normalized dependency set
→ Agent submits proposal
→ Host seals the complete set
→ PlanningObservationIdentity binds profile/version, Workspace/root identity,
  coverage contract, sealed dependency set, and deterministic digest
```

Untracked semantic read side channels, overflow, unsupported coverage, or incomplete/unknown observation make the proposal non-acceptable. The tracked set is sealed only after proposal generation because the planner may discover dependencies during planning.

A planning identity proves the provenance of the semantic view and what the Host last observed under its profile. It does **not** prove that an arbitrary external writer cannot change the shared worktree after the observation.

### 5.3 Exact creation draft

The Host-owned `ProgramCreationDraft` conceptually binds, under one deterministic digest:

- creation request/draft identity;
- exact source objective/provenance;
- `PlanningObservationIdentity`;
- complete initial required DAG;
- complete mandatory verification definitions and freshness scopes;
- required output slots and production-step definitions;
- selected execution-observation profile/coverage contract required by those scopes;
- Host-added non-removable policy requirements;
- policy generation/digest relevant to creation;
- all bounded semantic values that become immutable Program contract.

The Host validates syntax, normalization, DAG integrity, predicate taxonomy, path-scope/observation-profile compatibility, production-step/output binding, and all local/aggregate limits before presenting the exact pending draft. It does not claim to deterministically prove that an Agent-proposed semantic decomposition is the only correct decomposition.

### 5.4 Pending creation and session terminal linearization

The pending creation interaction is Host-owned durable control state. While it is current/unresolved, ordinary idle-driven session completion is not terminally eligible.

That rule is checked inside the same Host canonical admission lane that can publish/consume the pending interaction; a stale pre-enqueue snapshot cannot authorize session termination.

Explicit session stop remains allowed and races acceptance deterministically:

```text
stop wins canonical cut
→ pending creation becomes invalidated/resolved
→ session stops
→ later accept rejects/stales

accept wins canonical cut
→ Program is created and source session attached
→ later stop follows Program-attached session semantics
```

### 5.5 Exact acceptance and single consumption

Application acceptance targets the exact current Host-owned draft/control identity and digest. After any wait for Workspace mutation coordination, the Host revalidates request/draft currentness, source-session state, policy, and unconsumed status inside the same serialized admission that creates the Program.

One atomic semantic transaction establishes:

```text
creation request/draft: current → consumed by ProgramStateId P
pending interaction: unresolved → accepted/resolved by P
accept command: accepted → P
Program P: complete immutable initial contract + source-session attachment
```

One draft may map to at most one ProgramStateId across crash, retry, duplicate command, or two distinct accept command IDs racing the same draft. A later acceptance of a consumed draft resolves to the existing result or deterministic duplicate/stale decision; it never creates P2.

Before creation the Host excludes conflicting Host-mediated Workspace mutators and rechecks the accepted planning base under the relevant planning mode. A mismatch/unknown result makes the draft stale rather than silently rebasing it.

### 5.6 Bridge to first execution

Before the **first** ProgramAttempt dispatch, the Host reacquires the Workspace mutation coordinator, establishes required mutator quiescence, and performs one final accepted planning-base recheck. If it matches, the Host establishes the first `ProgramAttemptExecutionBase` from the current execution protocol and admits the attempt.

Creation-time `Bplan`/planning identity ends its runtime role at this bridge. After any legitimate Program-correlated mutation, successor attempts use current execution-aware `(WorkspaceEffectGeneration, ExecutionObservationIdentity)` and never compare the Workspace back to immutable creation-time `Bplan`.

## 6. ProgramState model, DAG, blockers, and topology

The minimum semantic current state is equivalent to:

```ts
interface ProgramState {
  programStateId: ProgramStateId;
  objective: string;
  lifecycle: "active" | "completed" | "cancelled";
  revision: number;
  workItems: ProgramWorkItem[];
  blockers: ProgramBlocker[];
  verification: VerificationObligation[];
  outputSlots: ProgramOutputSlot[];
  productionSteps: ProgramArtifactProductionStep[];
  decisiveEvidence: ProgramEvidenceReference[];
  artifacts: ProgramArtifactReference[];
  attachedSessionIds: string[];
  activeAttempt: ProgramAttempt | null;
  acceptedExecutionBase: ProgramAttemptExecutionBase | null;
  executionBaseMismatch?: ExecutionBaseMismatchReceipt;
}
```

Exact storage fields/event decomposition are implementation design. The semantic facts above must remain rebuildable.

Required work is a bounded DAG. Work-item lifecycle is equivalent to `pending | in_progress | awaiting_verification | blocked | completed`; there is no first-slice work-item cancellation or replacement. Direct dependency IDs are normalized deterministically. When several items are eligible, deterministic selection uses canonical work-creation order and then stable ID if a secondary key is needed.

The initial required topology is complete at creation and immutable for Phase 1.0. The Agent Protocol may expose a bounded `discovered_work`/blocker report seam, but such a report does not enlarge canonical required topology or completion burden. Explicit post-creation scope expansion/versioning is successor scope.

## 7. Session attachment and dispatch authority

One ProgramState may retain many historical session attachments; one session attaches to at most one ProgramState. A later active session can attach the same ProgramStateId without reviving any stopped session.

A Program with no active attached session/execution episode remains durable and active but does not dispatch new work. A client/UI disconnect alone does not stop the Host session or automatically interrupt an already executing external operation.

An orderly session stop interrupts the current ProgramAttempt before/with stop completion unless its work authority has already terminalized. The Program itself may remain active for a future session.

The scheduler is event-driven and scoped to one Workspace runtime/admission domain:

- at most one active ProgramAttempt in that Workspace domain;
- no timer/polling/cron/autonomous background loop;
- deterministic eligible-work selection;
- attempt admission occurs canonically before Agent execution;
- a retry always uses a fresh attempt identity;
- no retry or successor dispatch while required recovery, writer-quiescence, execution-base, blocker, or verification conditions are unresolved.

Independent Workspace runtimes are not serialized by a process-global Program lock.

## 8. `ProgramAttemptExecutionBase` and Workspace observation

### 8.1 Identity separation

Keep these identities distinct:

```text
PlanningObservationIdentity  creation semantic provenance / first-dispatch bridge
ProgramState revision         canonical Program control-state currency
ProgramAttemptId              one current execution authority claim
operationId                   one durable capability/effect identity
WorkspaceEffectGeneration     Host-known confirmed Workspace-effect lineage
ExecutionObservationIdentity  bounded checked live Workspace state
subjectGeneration             one verification obligation's proof currency
CodeRevisionToken             CodeIntelligence/cache observation token
```

No counter stands in for another.

### 8.2 Trusted execution base

```ts
interface ProgramAttemptExecutionBase {
  workspaceEffectGeneration: number;
  observation: ExecutionObservationIdentity;
}
```

A ProgramAttempt stores an immutable initial base and a Host-derived current expected base. Legitimate current-attempt effects may advance the latter without self-invalidating the attempt.

Observation outcomes are semantically:

```text
complete + equal
complete + different
unknown/incomplete
```

`unknown` is neither equal nor different and fails closed at correctness-sensitive boundaries.

### 8.3 Versioned complete `ExecutionObservationIdentity`

The selected first-slice observation contract is equivalent to:

```ts
interface ExecutionObservationIdentity {
  kind: "workspace-observation-v1";
  providerKind: string;
  workspaceIdentity: string;
  coverageDigest: string;
  stateDigest: string;
}
```

Exact Phase 1 equality requires the same observation kind/profile, same provider/Workspace identity, same `coverageDigest`, and same `stateDigest`. Different coverage is non-equivalent; a cut that requires exact currentness fails closed rather than invoking a new semantic-equivalence engine.

`coverageDigest` binds profile/version, Workspace/root identity, included surfaces, exclusions, normalization, symlink/submodule behavior, Git/control-state semantics, and any provider configuration that changes what `stateDigest` covers. `stateDigest` binds the observed value of that covered semantic state.

For the local Git Workspace profile, complete coverage includes under finite bounds: HEAD state/OID; index semantic entries/conflict stages; tracked worktree path/type/mode/symlink/content identity; untracked non-ignored entries; effective ignore-policy inputs that determine coverage; material repository control state such as merge/rebase/cherry-pick/revert/sequencer/bisect and sparse/worktree visibility configuration; and submodule/gitlink state only when it can be represented completely. Unsupported/overflowing required state makes the observation `unknown`.

Ignored caches/build/dependency content and raw unrelated `.git` internals are not silently claimed as observed. `workspace` verification scope means the selected profile's complete semantic surface, not every byte any arbitrary command could read.

A symlink observation binds the entry/link text; following an outside-root target does not expand Workspace observation automatically.

## 9. Workspace mutation coordination, effect lineage, and writer barriers

The Workspace coordinator protects Host-mediated mutation lifetimes. Acquisition order is:

```text
Workspace coordinator / reservation
→ canonical admission when both are needed
```

Code must not acquire them in the opposite order and then wait, because canonical admission serializes event truth while the coordinator governs environmental mutator lifetimes.

A current ProgramAttempt holds the Workspace-domain Program mutation reservation required by the first-slice scheduler. Read, mutation, and reconciliation subleases may be used beneath that reservation according to implementation, but unrelated Host `may_write` operations cannot cross the protected Program mutation lifetime.

A root `may_write` operation establishes a durable/rebuildable outstanding-writer barrier from canonical operation start until a Host-validated canonical quiescence proof establishes that the relevant writer/descendant set stopped. Operation effect certainty and writer quiescence are independent:

```text
confirmed effect + writer not proven quiescent → barrier remains
terminal failed effect + writer not proven quiescent → barrier remains
indeterminate effect + quiescence proven → uncertainty remains even though writer stopped
```

`WorkspaceEffectGeneration` is a replayable Workspace-domain ordinal derived from existing operation effect authority:

```text
first canonical transition of persisted request-time `may_write` operation O
into EffectStatus = confirmed
→ advance WorkspaceEffectGeneration exactly once for O
```

A request/start alone does not advance it. `absent` does not advance it. If an indeterminate operation is later reconciled to confirmed, that first canonical confirmed transition advances it once. Duplicate terminal/reconciliation paths cannot double-advance the same `operationId`.

A confirmed effect requires a complete protected post-effect observation before the Host has a trusted new `(G,O)` base. If the post-observation is unknown, causation remains known but the current attempt cannot continue dependent execution/verification/completion claims.

A Host-known operation does not prove exclusive causation of every observed byte. Arbitrary external writers remain outside Host exclusion. The guarantee is the checked post-state and canonical Host effect lineage, not a claim that no concurrent external write occurred.

## 10. Execution-base mismatch and explicit rebase

At any freshness-sensitive cut, the Host compares the Program's accepted/current expected base with a complete protected current base.

If either dimension differs outside the legitimate current-attempt post-effect advance path, the Host records a durable `ExecutionBaseMismatchReceipt` equivalent to:

```ts
type ExecutionBaseMismatchKind =
  | "observation_mismatch"
  | "causal_generation_mismatch"
  | "causal_and_observation_mismatch";

interface ExecutionBaseMismatchReceipt {
  programStateId: ProgramStateId;
  expectedProgramRevision: number;
  acceptedWorkspaceEffectGeneration: number;
  acceptedObservationIdentity: ExecutionObservationIdentity;
  currentWorkspaceEffectGeneration: number;
  currentObservationIdentity: ExecutionObservationIdentity;
  kind: ExecutionBaseMismatchKind;
}
```

If a mismatch is detected while an attempt is active, the Host interrupts/invalidates that attempt before accepting further current operation/evidence/verification/completion claims from it.

`unknown` current observation does not produce an acceptable candidate base. It exposes an execution-base-unavailable/blocking condition until a later complete protected observation exists.

A parked Program resumes only when its accepted base exactly matches the protected current base. Otherwise no dispatch occurs until the Application explicitly accepts the exact current candidate through a stale-safe, exact-revision, exact-receipt command equivalent to `program.execution.rebase.accept`. The receipt/acceptance is single-consumption/idempotent, does not amend objective/topology/verification definitions, and is rechecked immediately before a fresh attempt is admitted. Any later change makes the accepted candidate stale again.

External ABA can remain invisible if the shared worktree changes and returns to the same observed state between checked cuts. If the product later requires proof that no intermediate external mutation occurred, it needs a stronger isolated/transactional Workspace provider; Phase 1.0 does not manufacture that guarantee from hashes/watchers.

## 11. Verification contract

### 11.1 Mandatory immutable obligations

There is no separate first-slice `CompletionCriterion[]` engine. The Program-specific immutable completion burden is the set of canonical mandatory verification obligations plus the universal Completion Oracle invariants.

Every canonical verification obligation is mandatory for Program completion unless it has a valid explicit waiver for its **current** `subjectGeneration`. Phase 1.0 has no optional/advisory canonical verification obligation; advisory checks remain planning/reasoning information.

Each obligation binds:

- stable `VerificationObligationId`;
- immutable `VerificationPredicateV1`;
- immutable accepted `VerificationFreshnessScopeV1`;
- monotonic current `subjectGeneration`;
- historical/current satisfaction and/or waiver state with exact generation;
- decisive canonical evidence references.

Runtime evidence satisfies, invalidates, or waives a requirement; it never rewrites the requirement.

### 11.2 Closed `VerificationPredicateV1`

Exactly three semantic predicate kinds exist in the first slice:

```text
operation_result
workspace_path_state
artifact_present
```

Unsupported kinds reject creation/admission. No generic Boolean DSL, arbitrary `field/operator/value` expression, plugin evaluator, free-form evidence predicate, reasoning contract, or model judgment is terminal Program authority.

**`operation_result`** binds at Program creation to one exact stable **versioned Host verification-operation contract** and exact bounded canonical invocation arguments/digest. Runtime `operationId`, provider instance, ProgramAttemptId, ArtifactRef, and evidenceRef are not part of the immutable requirement. At satisfaction, the Host proves exact contract/args match, current Program/Attempt authority where applicable, required terminal success/exit semantics, safe effect/reconciliation state, required mutator quiescence, trusted current execution base, and exact current `subjectGeneration`. Current capability policy/permission still applies; a requirement never pre-authorizes execution.

A replaceable provider's raw interpretation of `succeeded` cannot redefine durable predicate semantics. The versioned Host verification-operation contract defines the stable success semantics; operation-local provider provenance is retained only where required for execution/recovery.

**`workspace_path_state`** binds one normalized Workspace path and required direct state `file | directory | symlink | absent`. It proves only that direct state under a complete protected observation; it does not prove content correctness, compilation, tree contents, symlink-target acceptability, Git membership, or semantic inspection. Unknown/incomplete observation is not `absent`.

**`artifact_present`** names a stable creation-time `ProgramOutputSlotId`, never a future ArtifactRef and never merely “any artifact from work item W.” The slot is mechanically defined by an immutable `ProgramArtifactProductionStepId` containing producer work identity, exact versioned Host operation contract, exact canonical bounded invocation arguments/digest, and one Host-defined singular output channel. A runtime root operation may claim that production step only after exact current-attempt/contract/args validation; two repeated invocations cannot satisfy one another's output slot by sharing producer/tool labels.

Later canonical evidence binds the actual ArtifactRef to that output slot/production step. Artifact presence means the bound retained regular artifact resolves and passes Host content-integrity checks. It does not mean semantic correctness or inspection.

Inspection-dependent semantic verification remains outside Phase 1.0 until a separate approved delivery/provenance contract exists.

### 11.3 Freshness scope

The closed first-slice scope is:

```text
workspace
paths(non-empty bounded exact/subtree entries)
```

Path entries use normalized segment-boundary `exact` or `subtree` semantics, not glob syntax. They are deduplicated and bounded. `workspace_path_state(P)` requires its freshness scope to cover P.

Every explicit path scope entry must be completely covered by the selected versioned `ExecutionObservation` profile. An excluded, conditionally unobservable, outside-root, sparse/provider-hidden, or otherwise incompletely represented dependency rejects creation unless an already-supported stronger approved profile covers it completely. The Host does not silently widen observation or drop the path.

A later non-equivalent observation `coverageDigest` makes freshness continuity unknown and therefore invalidates/advances the dependent obligations. Explicit rebase under the new coverage does not resurrect satisfaction/waivers from the old generation.

### 11.4 `subjectGeneration`, impact, satisfaction, and waiver

`subjectGeneration` is the one canonical freshness ordinal for each obligation. A relevant mutation or unknown relevance advances/invalidates the obligation. The Host may retain currentness only when the mutation impact is provably disjoint from the accepted scope using Host-owned/trusted complete impact evidence.

Capability/provider self-reported paths are not sufficient authority by themselves. Host-derived changed-path observation or a trusted complete effect-scope contract controls disjointness. Limit-exceeded/incomplete impact is unknown and fails closed; it is never truncated and called complete.

A satisfaction record is current only when its verified generation equals the obligation's current generation. A waiver is an explicit durable Application/Host-authorized transition with actor/source/reason and the **exact generation being waived**. It is not a predicate result. When the generation advances, the old waiver is historical.

For a verification operation that may write the Workspace, generic success may satisfy the same generation only after:

1. effect certainty is resolved;
2. writer/descendant quiescence is canonically proven;
3. a complete protected post-effect observation exists;
4. Host-derived impact is provably disjoint from the obligation scope.

If the impact overlaps or is unknown, the obligation generation advances and the operation's earlier generic success does **not** automatically satisfy the new generation. A future stronger verification contract may define post-effect final-state semantics explicitly; generic v1 success does not.

## 12. Artifact evidence semantics

`ArtifactRef` is content identity, not Program evidence authority.

Required relationship:

```text
ArtifactRef resolves / bytes retained
+ current admissible Program/Attempt provenance
+ current verification predicate/scope/generation rules
→ artifact-backed evidence may contribute
```

Forbidden implication:

```text
ArtifactRef resolves
=> current Program evidence / current verification / completed work
```

A stale/superseded attempt may leave a perfectly valid retained ArtifactRef; its late reference does not become current evidence. If the Host crashes after retaining bytes but before canonical terminal operation/evidence admission, the retained artifact cannot prove that the interrupted operation succeeded. Identical bytes produced under different histories may share one ArtifactRef while preserving distinct canonical provenance.

If an artifact-backed obligation was satisfied at G1 and a relevant mutation advances it to G2, the same retained ArtifactRef cannot carry satisfaction to G2. A fresh G2 evidence admission is required even if a new verification produces byte-identical content and the content-addressed store returns the same ArtifactRef.

At terminal completion, an artifact-backed current satisfaction rechecks the bound ArtifactRef's presence/integrity. A current explicit generation-indexed waiver does not require or invent an ArtifactRef and never synthesizes predicate success.

## 13. Cancellation

Program cancellation is an explicit Application-authorized exact-revision command, conceptually:

```text
program.cancel(programStateId, expectedProgramRevision, reason?)
```

The Application/authentication boundary establishes caller authority. The Host records actor/client/command provenance when available and an optional bounded reason.

One canonical admission cut:

```text
validate lifecycle active + exact revision
→ interrupt/invalidate active ProgramAttempt if any
→ admit program.cancelled with stable idempotency key
→ Program becomes terminal
```

Best-effort physical Agent/process cancellation may be signaled afterward, but canonical cancellation does not wait indefinitely for environmental quiescence and does not claim rollback. Outstanding operation lifecycle/effect/reconciliation and durable writer barriers remain true and continue through ordinary recovery/reconciliation. Late results remain historical ownership facts and cannot complete work or verification for the cancelled Program.

Completion and cancellation share the same terminal admission lane. Whichever terminal fact wins first makes the other reject/noop as already terminal. Exactly one terminal state becomes effective.

## 14. Completion Oracle

`agent.idle` may trigger evaluation but is not a completion predicate. The Host Completion Oracle may admit `program.completed` only when, on the same serialized canonical state cut or after complete revalidation inside it:

- lifecycle is `active`;
- every required work item is completed;
- every canonical mandatory verification obligation has current satisfaction for its exact `subjectGeneration` **or** a current valid waiver for that generation;
- no unresolved Program/work blocker exists;
- no active ProgramAttempt exists;
- no current execution-base mismatch/unavailable condition blocks terminal authority;
- no Program-linked operation remains `requested`/`started` in a way that can still affect Program truth;
- no Program-linked indeterminate effect or unresolved reconciliation blocks safe completion;
- no outstanding/rebuildable Workspace writer barrier relevant to Program completion remains unresolved;
- no Program-linked retryable durable work remains incomplete;
- no admitted transcript/tool-call obligation relevant to the attached execution remains unresolved;
- every artifact-backed satisfaction relied on at the terminal cut still resolves/passes integrity;
- all structural/current-state invariants are valid.

There is no second concrete-reference completion criterion list.

Completion uses a stable ProgramState-derived idempotency key. Preliminary evaluation outside canonical admission is advisory only; a competing event admitted first forces complete re-evaluation. `program.completed` and `program.cancelled` are mutually exclusive.

Session completion remains independent: a session may stop while an active Program remains durable, and a pending Program-creation interaction can block ordinary idle session completion without yet creating a ProgramState.

## 15. Recovery and replay

Before Program scheduler admission after Host open/reopen:

```text
recover canonical store/log integrity
→ rebuild/catch up Program projections
→ rebuild root operation Program/Attempt ownership
→ rebuild request-time WorkspaceAccessClass and operation-local execution provenance
→ rebuild WorkspaceEffectGeneration from first confirmed may_write transitions
→ rebuild outstanding durable writer barriers/quiescence state
→ recover/reconcile interrupted/indeterminate operations
→ identify orphan active ProgramAttempts and durably interrupt them idempotently
→ establish any required legacy execution-protocol baseline only after legacy mutators are recovered/quiescent
→ take a fresh complete protected ExecutionObservationIdentity
→ revalidate accepted Program execution bases / produce mismatch state where needed
→ enable scheduler admission
```

A Host crash cannot erase an outstanding writer barrier merely because the operation has a terminal/effect event. A crash during attempt interruption, mismatch/rebase control, creation single-consumption, generation advancement, or terminal completion is handled idempotently from canonical history.

Legacy operations predating Phase 1 execution-protocol fields are never retrospectively classified from mutable current providers. Phase 1 begins its execution baseline only after existing recovery/quiescence plus a complete current observation.

Replay of canonical Program truth does not consult current model output, plugin/evaluator registries, current Host tightening policy, or current capability-provider semantics for historical verification definitions.

## 16. Agent Protocol and projections

Phase 1.0 adds a negotiated structured Agent capability equivalent to `program_state_v1`.

The Host supplies a bounded **AttemptProjection**, not a wholesale serialization of canonical ProgramState. It includes enough current authority to act safely, such as:

- ProgramStateId and exact revision;
- ProgramAttemptId/current work identity;
- immutable objective and current work description;
- dependency/blocker facts needed for the attempt;
- current `ProgramAttemptExecutionBase` summary/identity;
- required verification obligations, accepted scopes, output/production-step requirements relevant to the current work;
- decisive current evidence/artifact references required for action;
- capability/operation constraints and uncertainty/reconciliation facts relevant to the attempt;
- stop/terminal conditions.

Prompt text is a disposable rendering. Structured projection remains Host-owned authority. A replacement Agent receives current structured state only under current valid authority; an orphan/superseded attempt is interrupted and a replacement never inherits its `ProgramAttemptId`.

The Agent may submit bounded work evidence, blocker/discovered-work reports, verification evidence proposals, and work-completion requests. It may not directly authorize verification satisfaction/waiver, rebase, cancellation, creation acceptance, topology expansion, or Program completion.

## 17. Application/read-model integration

The Host exposes a bounded authoritative Program read model and exact commands for creation acceptance, rebase acceptance, cancellation, session attachment, and other Host-authorized interactions required by the contract.

The public projection includes at least:

- ProgramStateId/revision/objective/lifecycle;
- bounded work status/current item summary;
- blockers;
- verification current/stale/waived summary;
- active attempt state;
- rebase-required/execution-base-unavailable state and exact current control identity where user action is possible;
- pending Program-creation interaction/draft digest and state;
- outstanding uncertainty/reconciliation status relevant to user interpretation.

Reconnect/snapshot derives from current Host state. Renderer/client state is disposable. The Experience Plane never opens the durable store, appends Program events, dispatches attempts, classifies effects, satisfies verification, or decides terminal completion.

## 18. Structural hard ceilings

These are the Phase 1.0 candidate hard ceilings derived from the repository-backed measurement corpus. A deployment may configure **stricter limits for new admissions** but never broader limits than these hard ceilings, and later policy tightening must not make previously canonical history invalid on replay.

| Dimension | Hard ceiling |
|---|---:|
| Work items / ProgramState | **128** |
| Direct dependencies / work item | **32** |
| Total dependency edges | **1,024** |
| Blockers / ProgramState | **64** |
| Verification obligations | **256** |
| Decisive evidence refs / work item or obligation | **32** |
| Total decisive evidence refs | **2,048** |
| Retained Program artifact refs | **256** |
| `ProgramOutputSlotId` values | **64** |
| `ProgramArtifactProductionStepId` values | **64** |
| Affected paths / work item | **128** |
| Freshness path entries / obligation | **64** |
| Total path-bearing entries | **4,096** |
| One normalized path | **1 KiB UTF-8** |
| Total normalized path bytes | **1 MiB UTF-8** |
| Objective | **16 KiB UTF-8** |
| Work-item description | **8 KiB UTF-8** |
| Blocker reason/description | **4 KiB UTF-8** |
| One verification predicate canonical argument payload | **16 KiB** |
| One production-step canonical argument payload | **16 KiB** |
| Total objective/work/blocker human text | **512 KiB UTF-8** |
| Total predicate + production-step canonical argument bytes | **512 KiB** |
| Unique session attachments retained in current ProgramState | **128** |
| Serialized canonical current ProgramState | **4 MiB** |
| Agent AttemptProjection | **128 KiB** |
| Application/public Program projection | **256 KiB** |

Canonical state-size enforcement uses one versioned deterministic Host canonical serialization profile selected by implementation and frozen with the implementation contract; the measurement's compact JSON surrogate is evidence for the numeric envelope, not a wire-format commitment.

Any creation/proposal/admission that would exceed a hard local, aggregate, or canonical-byte ceiling rejects deterministically. Canonical semantic state, observation scope, affected paths, evidence, or verification dependencies are never silently truncated to fit. Projection builders may select/summarize according to a deterministic bounded projection contract; projection omission does not delete canonical truth.

No reducer/rebuild latency SLA is invented before Phase 1 exists. Acceptance requires deterministic bounded algorithms under the V/E/count/byte ceilings; measured performance can be recorded during implementation without redefining canonical validity.

## 19. Security and trust

- Objectives, work descriptions, paths, Agent proposals, model output, tool output, reasoning output, artifact contents, provider data, and observations are untrusted data, never Host instructions.
- Existing secret admission/redaction rules remain in force before persistence.
- ProgramState does not bypass capability policy, permission prompts, network policy, plugin trust, process ownership, transcript authority, operation uncertainty, or Workspace locking rules.
- Program verification requirements do not pre-authorize capabilities.
- Current Program/Attempt/revision/execution-base rejection occurs before semantic admission of stale claims.
- Planning and execution observation identities use bounded Host-defined profiles; unsupported/unknown state fails closed rather than weakening coverage.
- Artifact contents remain content-addressed data; provenance/evidence admission controls semantic use.
- Resource ceilings are enforced at canonical admission and projection boundaries.

## 20. Explicit exclusions

Phase 1.0 excludes:

- a parallel `TaskId` for the same ProgramState;
- portfolio/project hierarchy or multi-Program orchestration;
- same-Workspace parallel ProgramAttempts, write-set conflict scheduling, or per-Program parallel execution;
- post-creation required-topology amendment/versioning and automatic Agent scope expansion;
- a general-purpose workflow/Boolean rule DSL;
- optional/advisory canonical verification obligations;
- plugin/model-defined verification evaluators;
- inspection-dependent semantic verification, media ingestion/rendering, or canonical inspection-delivery protocol;
- continuous filesystem snapshot/isolation guarantees on the shared worktree;
- worktree isolation, transactional snapshot providers, or remote Workspace backends;
- recurring automation, timers, cron, delayed jobs, reminders, or notifications;
- distributed claims/leases, remote workers, cloud orchestration, or multi-writer distributed coordination;
- parallel subagents/agent teams/multi-agent kanban;
- browser execution;
- SSH/WSL/Docker/remote Workspace backends;
- MCP server mode or unrelated marketplace/plugin expansion/model-written runtime plugins;
- ProgramAttempt-wide provider snapshots or provider-change-driven attempt interruption;
- public remote Application Protocol wire encoding;
- full canonical ProgramModel/code graph or repository-wide automatic impact graph construction;
- probabilistic/LLM-only verifier selection as canonical policy;
- objective amendment/version-history product;
- autonomous Program creation while no Host session exists;
- automatic background execution after Host startup with no active attached execution episode;
- `graph-v1` product-default promotion;
- full graph/memory/context/trace/task inspector UI;
- vector memory, auto-skill minting, or unrelated cognition expansion.

## 21. Acceptance criteria — consolidated DRAFT candidate

These ACs are not approved or frozen. They are the candidate proof contract for the next whole-contract review.

### AC-10-01 — Identity, envelope, and historical compatibility

`ProgramStateId` is one branded UUIDv7 cross-domain identity; no competing TaskId exists. Optional `programStateId` is persisted/indexed without invalidating legacy/non-Program events. Historical omitted optional fields preserve their original fingerprint/digest serialization; schema migration must prove old history verifies/replays identically.

### AC-10-02 — Exact Program creation, immutable contract, and deterministic rebuild

Prove both planning-provenance modes; no untracked semantic planning read may influence an accepted draft. Program creation validates all immutable contract definitions/bounds, exact accepted observation provenance, and scope/profile compatibility. One exact draft is single-consumed into exactly one ProgramStateId across duplicate/distinct accepts and crash/retry. The complete initial objective, DAG, verification obligations/scopes, output slots/production steps, policy additions, and source-session attachment appear on one atomic creation cut and rebuild deterministically.

Negative proofs include stale planning base, unknown/incomplete planning observation, over-bound contract, unsupported predicate/scope, consumed draft, and crash after Program commit before caller response.

### AC-10-03 — Cross-session continuity and terminal interaction linearization

One Program survives session stop, Agent replacement, Host reopen, and later-session attachment; stopped sessions are not revived and one session cannot attach two Programs. A pending creation interaction blocks ordinary idle session completion **inside terminal canonical admission**. Explicit stop versus creation acceptance produces one deterministic winner and leaves no usable orphan draft.

### AC-10-04 — Exact ProgramAttempt and execution-base validity

Every dispatch mints a fresh ProgramAttemptId. Current claims require exact P/A/work/revision/Agent-generation ownership. Root operation admission revalidates those facts in its canonical cut. First dispatch bridges from accepted planning base; successors require exact current `(WorkspaceEffectGeneration, ExecutionObservationIdentity)`.

Required negatives:

```text
expected R16, current R17 → reject
expected R18, current R17 → reject
old Attempt X, current Y → reject
old Agent generation/request → reject
accepted (G4,O4), current (G5,O4) → rebase_required
accepted (G4,O4), current (G4,O5) → rebase_required
current observation unknown → no rebase target / no dispatch
mismatch receipt accepted, then base changes again → no dispatch
```

### AC-10-05 — Bounded DAG and Workspace-domain scheduler

Creation rejects unknown/self/cyclic/malformed/over-bound DAGs and aggregate limit breaches. Eligible selection is deterministic. At most one ProgramAttempt is active per Workspace runtime/admission domain; separate Workspace runtimes may proceed independently. No dispatch occurs without an active attached execution episode, with unresolved execution-base mismatch, or before required recovery/quiescence.

Prove legitimate current-attempt mutation advances its expected base and permits same-attempt continuation only when confirmed effect, writer quiescence, and complete post-effect observation establish a trusted next base. Successor dispatch never compares back to creation-time `Bplan`.

### AC-10-06 — Operation correlation, effect uncertainty, writer barriers, and artifact provenance

For every ProgramAttempt-originated operation, root history durably identifies P/A/O and immutable request-time Workspace access class. Descendants resolve ownership through O. `WorkspaceEffectGeneration` advances exactly once at the first canonical confirmed transition for one `may_write` O, including a later reconciliation-to-confirmed path, and never on request/start/absent.

Effect certainty and writer quiescence are independently rebuildable. A crash cannot drop an unproven writer barrier. Indeterminate mutation interrupts trusted attempt continuation, blocks retry/completion, and remains uncertain until reconciliation.

Required artifact negatives:

```text
stale Attempt A produced ArtifactRef R
→ R still resolves
→ late A reference cannot become current evidence

bytes retained as R
→ crash before canonical terminal/evidence admission
→ R cannot prove operation success
```

### AC-10-07 — Closed verification, freshness, output binding, and waivers

Only `operation_result`, `workspace_path_state`, and `artifact_present` v1 predicates are accepted. Operation predicates bind exact versioned Host verification-operation contracts + canonical arguments; artifact requirements bind stable output slots through exact production-step contract/args/channel identity; repeated invocations cannot satisfy one another's slot. Path scopes are non-empty exact/subtree sets, obey segment-boundary semantics, cover any `workspace_path_state` path, and are fully covered by the selected observation profile.

Prove:

```text
V satisfied at subjectGeneration G1
→ relevant/unknown-impact mutation
→ V advances/stales at G2
→ old satisfaction and G1 waiver are not current
→ same retained ArtifactRef cannot restore V
→ fresh exact G2 evidence or explicit G2 waiver required
```

A mutating verification operation cannot satisfy a new generation from its generic success after overlapping/unknown self-mutation. Coverage-profile change fails closed and does not resurrect old proof after rebase. Artifact-backed terminal satisfaction rechecks presence/integrity; waiver never fabricates ArtifactRef/predicate success.

### AC-10-08 — Completion Oracle, cancellation, and terminal mutual exclusion

Only the Host Completion Oracle admits `program.completed`, after complete revalidation on the terminal canonical cut. Prove all universal predicates, current verification generations, artifact integrity when relied upon, no active attempt, no blocking uncertainty/writer barrier/execution-base mismatch, and no unresolved relevant durable work/tool/transcript obligation.

Application cancellation requires exact revision, atomically invalidates/interupts the active attempt, and records one terminal authority cutoff without claiming rollback. Race proofs:

- completion preliminary check then conflicting event → recheck/reject;
- completion vs cancellation → exactly one terminal state;
- duplicate/retry/reopen → exactly one effective terminal fact;
- outstanding operation after cancellation remains historical/reconcilable but cannot change Program terminal truth.

### AC-10-09 — Recovery barrier and execution-state rebuild

Host reopen rebuilds Program projections, operation ownership/access classification, WorkspaceEffectGeneration, durable writer barriers, uncertainty/reconciliation, and orphan attempts before scheduler admission; then it takes a fresh complete protected observation and resolves exact accepted-base currentness. Crash during any idempotent recovery transition cannot authorize a replacement attempt early.

Legacy pre-Phase-1 operation history is not reclassified from current providers; a new Phase 1 baseline is established only after legacy recovery/quiescence plus complete current observation.

### AC-10-10 — Agent/Application projections and authority ownership

Agent negotiates structured Program state and receives a <=128 KiB current AttemptProjection before acting; replacement cannot continue a superseded attempt. Application receives a <=256 KiB authoritative public projection including pending creation/rebase/uncertainty state needed for user decisions. Reconnect derives from Host snapshot/replay. Agent/UI cannot create canonical ProgramState directly, expand required topology, authorize waiver/rebase/cancel, satisfy verification, dispatch attempts, or decide completion.

All hard canonical limits and projection limits fail deterministically; canonical truth is never silently discarded to fit a projection.

### AC-10-11 — Composed Phase 1.0 gate

Only if implementation is later explicitly approved, `pnpm gate:1.0` must compose and pass the exact closed Phase 0.9 gate plus every approved Phase 1.0 proof at the exact final implementation source head. No implementation gate or CI result can itself retroactively approve this DRAFT contract.

## 22. Required scenario proofs — consolidated DRAFT candidate

### Scenario A — Exact creation, idle/stop race, and first-dispatch bridge

```text
objective supplied
→ bounded read-only planning with complete provenance
→ exact draft D pending
→ ordinary agent.idle races D publication
→ terminal admission sees D and cannot ordinary-stop session
→ Application accepts exact D
→ Host rechecks planning base under mutation coordination
→ D single-consumed → one Program P + source attachment
→ crash/retry accept maps to same P
→ pre-first-dispatch planning-base recheck succeeds
→ first ProgramAttempt minted from trusted execution base
```

Variant: explicit stop wins before acceptance → D invalidated/resolved + session stopped; no Program created from D.

### Scenario B — Long-horizon reopen

```text
P: A → B → C
→ Session 1 completes A under current verification/execution-base rules
→ Host + Agent destroyed
→ reopen rebuilds Program/effect/writer/recovery state
→ fresh observation established
→ no dispatch without active attached session
→ Session 2 attaches P
→ A remains complete
→ exact current base accepted/current
→ B then C execute
→ current mandatory verification satisfied/waived
→ P completes once
```

### Scenario C — Stale attempt / exact revision ABA

```text
B → Attempt X at revision R / Agent generation 1
→ X interrupted/replaced
→ Attempt Y / generation 2 current
→ late X operation/evidence/result arrives
→ Host preserves X historical operation facts but rejects current Program claim
→ lower or higher revision proposal rejects
→ Y remains current
```

### Scenario D — Legitimate mutation, external divergence, and rebase

```text
Attempt A base (G4,O4)
→ A's may_write operation confirmed + quiescent
→ G5 + complete O5
→ A expected base advances to (G5,O5)
→ A may continue if otherwise current
→ later external edit produces O6
→ mismatch receipt; A interrupted
→ Application accepts exact candidate (G5,O6)
→ final recheck matches
→ fresh Attempt B may dispatch
```

Also prove causal-only `(G4,O4) → (G5,O4)` mismatch and combined mismatch. Document that an unobserved external ABA between equal checked observations is outside the guarantee.

### Scenario E — Indeterminate effect and durable writer barrier

```text
Attempt A starts may_write O
→ Host/environment crashes or loses effect certainty
→ effect indeterminate
→ writer quiescence may also be unknown
→ A cannot continue/retry/verify/complete
→ reopen rebuilds O ownership + uncertainty + writer barrier
→ reconciliation/quiescence eventually produce canonical facts
→ fresh complete execution base required
→ only fresh Attempt B can continue
```

### Scenario F — Verification invalidation and artifact identity

```text
V satisfied at G1 using artifact-backed evidence R
→ relevant mutation
→ V advances to G2
→ R remains byte-identical/resolvable
→ Completion Oracle rejects stale V
→ fresh verification at G2 happens to reproduce same bytes / same ArtifactRef R
→ new G2 canonical evidence admission required
→ V current only after exact Host predicate admission or G2 waiver
```

Include mutating-verifier overlap/unknown-impact case where generic success cannot self-certify the advanced generation.

### Scenario G — Cancellation/completion race

```text
all completion predicates appear true
↔ exact-revision Application cancel arrives
→ one canonical terminal order wins
→ cancel-first interrupts attempt and makes Program cancelled; completion rejects
OR completion-first makes Program completed; cancel rejects/noops
→ outstanding operations retain ordinary lifecycle/effect/reconciliation truth
→ rebuild yields same unique terminal Program state
```

### Scenario H — Rebuild, migration, and idempotency

```text
delete derived Program/operation execution projections
→ replay canonical history including legacy events lacking Program fields
→ historical fingerprints/digests remain valid
→ rebuild Program state, P/A operation ownership, generations, barriers,
  verification generations/waivers, attachments, and terminal state
→ semantic parity with pre-delete current state
→ duplicate creation/rebase/completion/cancellation recovery does not create duplicate authority transitions
```

## 23. Proposed gate shape — not implemented or authorized

If implementation is later approved, the candidate gate families are:

```text
1.0.compose.0.9
1.0.identity.program-state
1.0.program.reducer
1.0.program.rebuild
1.0.program.creation
1.0.program.session-binding
1.0.program.revision-attempt-freshness
1.0.program.execution-base
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

This list is acceptance-proof organization, not an implementation authorization. Existing platform CI remains authoritative unless the later implementation introduces a demonstrably new platform-sensitive surface.

## 24. Candidate implementation dependency order — not authorized

If and only if this contract is later explicitly approved/frozen, implementation planning should decompose roughly in this dependency order:

1. identities/envelope migration with historical digest compatibility;
2. pure Program domain model/reducer/DAG/limits/verification definitions;
3. rebuildable Program projections;
4. creation-request/draft/pending-interaction and atomic creation control;
5. session attachment and exact Program/Attempt validity;
6. Workspace observation/coordinator/effect-generation/writer-barrier substrate integration;
7. operation ownership and uncertainty/reconciliation composition;
8. scheduler/first-dispatch/successor execution-base/rebase flows;
9. verification evidence, freshness, output-slot/production-step, artifact semantics;
10. cancellation and serialized Completion Oracle;
11. Agent Protocol AttemptProjection/proposals;
12. Application commands/projections;
13. scenario proofs, composed `gate:1.0`, exact-head closure evidence, and as-built documentation.

This order is informative planning only. It authorizes no code change.

## 25. Consolidation status and approval rule

This consolidation closes the previously enumerated **pre-consolidation** contract questions into one candidate Phase 1.0 text. It does not assert that adversarial review has already validated the composed whole.

The next decision process is therefore:

```text
consolidated DRAFT candidate
→ whole-contract adversarial review
→ address any concrete correctness findings
→ explicit user approval/freeze decision
→ only then implementation planning/authorization
```

At this commit stage:

- this plan is **not approved**;
- this plan is **not frozen**;
- AC-10 is still amendable through review;
- implementation is **not authorized**;
- supporting studies/amendments remain historical rationale and do not independently authorize implementation;
- no PR/commit should claim Phase 1.0 implementation has started or that this contract is frozen.

A later explicit freeze must record the exact approved document head/commit so implementation and closure can be evaluated against the actual approved contract.
