# ALCODE Phase 1.0 — ProgramAttempt Execution Freshness Study

**Status:** DRAFT / non-normative planning study  
**Approval:** not approved; not frozen; implementation not authorized  
**Repository base studied:** `main` at `7e81de42ccdbf5917e6a2f2d53cf5b0acfdd5084`  
**Relationship to Phase 1.0:** studies the execution-freshness dependency exposed by `docs/phase-1.0-program-creation-authorship-study.md`. It does not amend `docs/phase-1.0-plan.md`, change AC-10 acceptance criteria, approve/freeze Phase 1.0, or authorize implementation.

## 1. Question

The Program-creation study deliberately makes creation-time `PlanningObservationIdentity` / `Bplan` a **creation-to-first-execution bridge only**. Once legitimate Program execution mutates the Workspace, comparing later dispatches back to immutable creation-time state would stall normal execution.

The remaining question is:

> **How does the Host decide that a ProgramAttempt, capability result, evidence admission, verification satisfaction, successor dispatch, and completion decision are fresh with respect to the current Workspace after execution begins — while distinguishing known Host-mediated effects from unexpected out-of-band changes and preserving uncertainty across crash/recovery?**

This is distinct from verification freshness. Verification freshness asks whether one obligation remains satisfied for its current `subjectGeneration`. Execution freshness asks whether an execution claim is being made against a Workspace state the Host can still treat as current enough for the relevant Host boundary.

---

# Part I — Scope and guarantee boundary

## 2. In scope

This study covers:

- execution-state identity at ProgramAttempt dispatch;
- legitimate Host-mediated mutation progression;
- read-only and mutating capability freshness;
- out-of-band Workspace changes;
- operation/effect uncertainty and reconciliation;
- successor dispatch after legitimate mutation;
- restart/replay;
- foreground/non-Program Host-mediated mutations;
- verification-freshness composition;
- Completion Oracle composition.

## 3. Out of scope

This study does not:

- implement Phase 1;
- select an exact hashing algorithm;
- promise filesystem snapshot isolation;
- promote chokidar, Git, CodeIntelligence, or a watcher to canonical authority;
- make arbitrary external writers participate in Host admission;
- replace per-obligation verification freshness;
- finalize the planning-observation schema;
- finalize the Host-mediated mutation-barrier implementation;
- amend the governing plan.

## 4. Honest guarantee boundary

A live Workspace is not transactionally coupled to the SQLite event store. A human editor can write after a Host observation and before the next filesystem operation. Therefore neither a counter nor a watcher can provide serializable filesystem semantics.

The strongest first-slice guarantee considered achievable without stronger isolation is:

> **At defined freshness-sensitive Host boundaries, the Host revalidates canonical Program/Attempt currency and a bounded Host-observed execution base under Host-mediated mutation coordination. Known Host-mediated mutation effects advance a durable causal lineage only through canonical operation/effect semantics. Unexpected observed divergence fails closed for the current ProgramAttempt. Indeterminate effects remain uncertainty and block dependent progress until reconciliation. This is boundary-checked freshness, not proof that an arbitrary external writer could not race between observations or during environmental execution.**

An additional limitation follows directly:

```text
O0 observed
→ external state changes O0 → O1 → O0 between checked cuts
→ later observation again equals O0
```

A pure state-equality check can miss that transient ABA history. A watcher or provider monotonic revision may make such a history observable, but watcher silence is not proof. If correctness requires proving that **no intermediate external mutation occurred**, stronger isolation or a trustworthy monotonic Workspace-provider revision is required.

If Phase 1 requires:

```text
no external writer can race Program execution
```

then an isolated/transactional Workspace provider is required. No canonical counter can manufacture that property over a shared live worktree.

---

# Part II — Method

## 5. Decision method

For every alternative, ask:

1. what fact is canonical;
2. what is only an observation;
3. what exact state a ProgramAttempt claims;
4. how legitimate mutation changes that state;
5. how unexpected change is detected;
6. what happens when equivalence is unknown;
7. what survives restart/replay;
8. what happens under indeterminate effect;
9. how verification freshness composes;
10. what remains impossible without isolation.

Correctness is a gate. Reject designs that:

- duplicate canonical authority;
- admit stale-attempt claims;
- treat watcher state as mutation authority;
- lose effect uncertainty;
- depend on an in-memory counter for replay;
- silently bless unexplained drift;
- self-invalidate every legitimate Program mutation;
- use creation-time `Bplan` as a perpetual runtime baseline.

---

# Part III — Repository facts

## 6. Phase 1 execution freshness is not implemented

ProgramState and ProgramAttempt remain planning concepts. Current code provides constraints and precedents, not a hidden implementation of this contract.

## 7. HostRuntime is Workspace-scoped

`packages/host-runtime/src/host.ts` builds one Host runtime around one `LockedWorkspaceStore`, one `CanonicalAdmissionQueue`, capability broker, session manager, context service, and durable-work dispatcher.

That makes the Workspace runtime/admission domain the natural grain for Workspace-wide causal effect lineage.

It does not make the Host the sole filesystem writer.

## 8. Workspace lock is Host/process ownership, not file isolation

`packages/workspace/src/lock.ts` is a process-scoped lock around ALCODE Workspace ownership/storage. It does not prevent an IDE, shell, human, or non-ALCODE process from changing repository files.

```text
Workspace store ownership
!=
filesystem isolation
```

## 9. Canonical admission serializes append decisions, not environmental lifetimes

`CanonicalAdmissionQueue` is suitable for exact currentness checks, atomic event batches, stale/duplicate rejection, operation ownership, and terminal decisions.

It does not stop an already-started capability from mutating the environment outside the queue.

## 10. Capability execution crosses the canonical boundary

Current `packages/host-runtime/src/capability-broker.ts` admits:

```text
operation.requested
operation.started
action.recorded
```

before calling `capability.execute(...)` outside canonical admission. Terminal operation/evidence facts are admitted later.

Therefore:

```text
canonical operation.started
!=
environmental effect completed
```

A Workspace generation cannot safely advance merely because `operation.requested` or `operation.started` became canonical.

## 11. Operation model already preserves effect uncertainty

`packages/storage/src/operations.ts` and ADR 0003 separate:

- lifecycle/execution outcome;
- external effect status;
- reconciliation status.

A mutation can be `indeterminate` after crash/failure/cancellation/timeout. The accepted rule is effectively-once where supported, otherwise preserve uncertainty.

Execution freshness must compose with this model rather than infer effect certainty from a later filesystem snapshot.

## 12. Current startup recovery **surfaces** uncertainty; it is not yet a runtime barrier

Current Host startup invokes interrupted-operation recovery and returns pending operation IDs. Recovery records interrupted mutations as indeterminate/pending for reconciliation. Current startup/capability paths do **not** generally prevent all subsequent ordinary capability execution merely because such pending operations exist.

So the repository provides precedent for **durably surfacing and preserving mutation uncertainty**, not an already-implemented global execution barrier.

The Phase 1 rule proposed by this study is stronger and new:

> unresolved effect uncertainty must block creation/use of a trusted Program execution base where that uncertainty could make the claim unsafe.

That requires explicit Phase 1 admission/scheduling integration.

## 13. CodeIntelligence token is observation infrastructure

`packages/code-intelligence/src/types.ts` defines:

```ts
interface CodeRevisionToken {
  epoch: number;
  generation: number;
  fingerprint: string;
}
```

`WorkspaceRevisionTracker` advances observation generations from chokidar events and explicit Host mutation notifications and recomputes bounded baseline fingerprints for relevant epoch changes.

Useful properties:

- cheap change signal;
- observation token attached to CodeIntelligence results;
- Host and watcher changes can invalidate caches.

It is not canonical Program authority because it is currently in-memory/cache-oriented, does not encode operation/attempt causation, and cannot by itself distinguish current-attempt effects from external writes.

## 14. CodeIntelligence uses before/after observation, not retry

`packages/code-intelligence/src/service.ts` captures the revision token before a provider query and again afterward. If the token changed, the returned observation is marked non-current/incomplete with a diagnostic. It does **not** automatically retry the provider query.

This is useful precedent for:

```text
observe before
→ perform read/query
→ observe after
→ downgrade/reject freshness when state changed
```

It is not a precedent for automatic retry, and it does not provide durable ProgramAttempt authority.

## 15. Durable work demonstrates replayable claims

`packages/host-runtime/src/work-dispatcher.ts` records requested/claimed/interrupted/completed facts and rebuilds its ledger by replay.

The relevant principle is that durable execution authority should be reconstructible rather than living only in process memory.

## 16. Creation-time Bplan has one finite role

`docs/phase-1.0-program-creation-authorship-study.md` makes `Bplan` the semantic planning base and requires its last runtime equality/equivalence recheck at **first ProgramAttempt dispatch only**.

After legitimate execution mutation, successor dispatch uses execution-aware current state.

## 17. Verification freshness is separate

The open-decisions study recommends per-obligation `subjectGeneration` with fail-closed unknown-impact invalidation. That remains the home for verification satisfaction currency.

Execution freshness must not become a Program-global verification epoch.

---

# Part IV — Identity separation

## 18. Distinct identities

```text
PlanningObservationIdentity
  creation-time planning provenance; bridge to first execution

ProgramState revision
  canonical Program semantic revision / proposal currency

ProgramAttemptId
  fresh non-reusable execution claim

operationId
  durable operation/effect identity

WorkspaceEffectGeneration
  proposed replayable ordinal of Host-known confirmed mutating effects

ExecutionObservationIdentity
  proposed Host observation of live Workspace state at a checked cut

verification subjectGeneration
  per-obligation satisfaction currency

CodeRevisionToken
  CodeIntelligence/cache observation token
```

Do not collapse them merely because several contain counters or fingerprints.

## 19. Why one counter cannot solve the problem

One integer cannot simultaneously prove:

- what state the Host observed;
- why it changed;
- whether a current Program operation caused a known effect;
- whether a crashed operation partially ran;
- whether an external writer changed state outside Host history;
- which verification obligations are stale.

At least two axes are required: **causal Host-effect lineage** and **live-state observation**.

---

# Part V — Required properties

## 20. ProgramAttempt has an exact execution base

Illustrative semantic shape:

```ts
interface ProgramAttemptExecutionBase {
  workspaceEffectGeneration: number;
  observation: ExecutionObservationIdentity;
}
```

The Host owns this base.

The first attempt derives it after the accepted `Bplan` first-dispatch recheck. Successor attempts derive it from current execution-aware Workspace state.

## 21. Initial and current expected base are distinct

A ProgramAttempt can execute multiple correlated capability operations. A legitimate mutation must not automatically invalidate the same attempt that requested it.

Therefore each attempt has:

- immutable initial execution base;
- Host-derived/rebuildable current expected base.

The current expected base may advance only through Host-owned effect/drift/reconciliation transitions, never Agent assertion.

## 22. WorkspaceEffectGeneration is causal, not a filesystem digest

Proposed meaning:

> a Workspace-scoped monotonic ordinal of Host-known **confirmed mutating effects**.

Rules:

- read-only operation: unchanged;
- proven effect absent: unchanged;
- confirmed Host mutating effect: advance exactly once;
- indeterminate effect: do not manufacture a trusted next generation;
- external drift: does not pretend to be a Host effect-generation transition.

A mutating operation that reports success but makes no observable byte difference may still conservatively count as one Host-confirmed effect transition if that is the selected operation semantics. The generation is lineage, not content equality.

## 23. ExecutionObservationIdentity is observation, not mutation authority

It records a bounded Host-observed identity of live Workspace state at a defined cut.

The final representation must specify:

- covered state and exclusions;
- bounds;
- equality/equivalence;
- Git/untracked/ignored semantics;
- directory/absence semantics where needed;
- remote Workspace/provider semantics;
- unknown/incomplete observation;
- restart behavior.

A canonical fact may authoritatively mean:

```text
Host observed O at cut C
```

without claiming O is eternal filesystem truth.

## 24. Exact current-attempt revalidation

At Program-originated operation request, current evidence admission, verification admission, successor dispatch, and completion terminal cut, revalidate as applicable:

- exact ProgramState revision;
- exact current ProgramAttemptId;
- Program lifecycle;
- cancellation/supersession;
- current expected execution base;
- no unresolved effect/drift condition that makes the claim unsafe.

Canonical authorization is revalidated inside the same admission that admits the canonical fact.

## 25. Confirmed Host effects advance the causal base

For a current Program-correlated mutation:

```text
A expects (G,O0)
→ exact operation request admitted
→ capability executes under Host-mediated mutation coordination
→ effect confirmed
→ Host observes O1
→ terminal/evidence semantics admitted
→ WorkspaceEffectGeneration G→G+1 exactly once
→ A current expected base becomes (G+1,O1)
```

Where feasible, terminal effect recognition and generation advance belong to the same serialized semantic cut so replay cannot see a confirmed effect with the old causal lineage.

## 26. Effect absent leaves causal generation unchanged

Reconciliation proving the effect absent leaves `G` unchanged. A fresh observation may still be required after crash, but no false Host-effect generation is minted.

## 27. Indeterminate effect blocks trusted base advancement

If effect is indeterminate:

```text
no trusted (G+1,O1)
```

Simply observing current files and adopting them would erase whether the operation ran, partially ran, or was mixed with unrelated change.

Reconciliation must resolve the effect or uncertainty remains blocking for dependent execution/evidence/verification/completion.

## 28. Unexpected observed divergence fails closed

At a checked boundary:

```text
Ocurrent != Oexpected
```

with no corresponding canonical effect transition that accounts for the change means the current ProgramAttempt loses freshness for dependent claims.

Preferred first-slice rule:

```text
unexpected drift
→ do not silently replace Oexpected
→ invalidate/supersede current attempt for dependent claims
→ establish current Workspace state through explicit rebase/replan/revalidation
→ mint a fresh ProgramAttemptId
```

## 29. External drift does not increment Host effect lineage

If a human edits the Workspace, no Host operation suddenly exists. Therefore external drift cannot be represented as if it were a confirmed Host mutation merely to keep counters moving.

The two-axis base allows:

```text
same WorkspaceEffectGeneration G
+ different accepted observation Onew
```

after an explicit drift/rebase boundary.

## 30. Watchers are sensors, not proof of absence

Watcher/CodeIntelligence change signals can invalidate caches and trigger earlier checks.

But:

```text
no watcher event
```

is not sufficient evidence that no external mutation occurred.

Correctness-sensitive boundaries use the selected direct observation/equivalence mechanism.

## 31. Host-mediated mutators need environmental coordination

A foreground/non-Program Host mutator must not cross a protected active ProgramAttempt mutation lifetime simply because it belongs to another session.

The mutation barrier/scheduler integration must serialize or reject/delay it.

This is additional Phase 1 work; canonical admission ordering alone is insufficient.

## 32. External writers remain outside Host exclusion

The hybrid can detect covered divergence at later boundaries and prevent stale canonical claims after detection. It cannot prove exclusive byte-level causation in a shared worktree.

In particular:

```text
pre-check O0
→ external edit
→ tool system call
```

and:

```text
tool mutates
+ external editor mutates concurrently
→ post-observation O1
```

remain possible without stronger isolation.

## 33. Restart rebuilds causation, then re-observes state

On restart:

```text
replay Program/operation state and WorkspaceEffectGeneration
→ surface/reconcile surviving indeterminate operations
→ obtain fresh live Workspace observation
→ compare to latest trusted expected observation where meaningful
→ mismatch/unknown => fail closed for affected Program execution
```

The replayable causal lineage does not depend on a watcher generation surviving process death.

## 34. Verification subjectGeneration stays distinct

One confirmed Workspace effect can advance one global effect generation while affecting zero, one, or many verification obligations.

Known-disjoint effect:

```text
WorkspaceEffectGeneration advances
verification obligation may remain satisfied
```

Unknown/relevant effect:

```text
WorkspaceEffectGeneration advances
verification subjectGeneration advances / old satisfaction invalidates
```

## 35. External drift also participates in verification invalidation

Verification cannot invalidate only for Host-correlated mutations. If the Host observes external drift and later establishes a new accepted execution observation, verification impact must be evaluated against the drift too.

Where exact changed scope is known, known-disjoint obligations may remain current. Where impact is unknown, fail-closed invalidation applies.

The external drift does **not** need a fake WorkspaceEffectGeneration increment to invalidate verification; the obligation's own `subjectGeneration` is the verification authority.

## 36. Completion requires execution and verification currentness

The Completion Oracle rejects terminal completion while any of these remains unresolved:

- stale/superseded current attempt claim where relevant;
- active Program-originated operations;
- indeterminate mutating effects that matter to Workspace/Program safety;
- unresolved execution drift/rebase state;
- mandatory verification not satisfied for current `subjectGeneration`;
- ordinary existing completion invariants.

Execution freshness is necessary, not sufficient.

---

# Part VI — Freshness-sensitive cuts

## 37. First ProgramAttempt dispatch

```text
accepted Program + Bplan
→ acquire Host-mediated mutation coordination
→ first-dispatch Bplan recheck
→ observe live O0
→ current causal generation G0
→ admit fresh ProgramAttempt A0 at (G0,O0)
```

No successor attempt compares directly to `Bplan`.

## 38. Mutating operation request

Before Program-linked `operation.requested` is admitted:

- exact current Program/Attempt ownership;
- current expected causal generation/base;
- no unresolved prior effect uncertainty;
- Host-mediated mutation authority available;
- direct observation check where required by the selected observation contract.

## 39. Read-only result/evidence

A read-only operation never advances Workspace effect generation.

For Workspace-dependent reads:

```text
observe before
→ perform read
→ observe after
```

If the observation changed, the result is stale/non-current rather than unqualified Program evidence. The final policy may retry explicitly, but current CodeIntelligence does not provide a generic auto-retry precedent.

## 40. Mutating terminal/evidence cut

### Confirmed effect

```text
confirmed effect
+ durable operation ownership
+ post-effect observation
→ generation advance exactly once
→ attempt expected-base advance
→ qualifying evidence admission subject to currentness rules
```

### Effect absent

No causal advance.

### Effect indeterminate

No trusted base advance; reconciliation barrier.

## 41. Successor ProgramAttempt dispatch

```text
latest replayable causal generation Gk
+ fresh current observation Ok
+ current ProgramState revision
+ no unresolved drift/effect barrier
→ new ProgramAttempt Ak
```

Not:

```text
Ok == immutable creation-time Bplan
```

## 42. Verification satisfaction cut

Revalidate:

- exact obligation;
- exact current `subjectGeneration`;
- qualifying evidence provenance;
- no unresolved execution drift/effect uncertainty that invalidates the observed verification subject;
- applicable ProgramAttempt currency.

## 43. Completion terminal cut

Preliminary completion evaluation cannot authorize later completion. The final serialized cut revalidates Program/Attempt state, operations, drift/effect uncertainty, and verification currentness before `program.completed` can win.

---

# Part VII — Alternatives

## 44. Alternative A — boundary re-observation only

```text
capture observation O
→ compare at boundaries
```

**Pros:** small, detects many external changes, reuses observation infrastructure.

**Failure:** no causal explanation. A legitimate mutation changes O. Either it self-invalidates or the Host silently adopts the new O, which can also bless unrelated change. Crash/replay authority is weak unless separately made durable.

**Classification:** reject as sole authority; retain re-observation as a component.

## 45. Alternative B — canonical Workspace generation only

```text
Host-confirmed mutation → G++
ProgramAttempt claims G
```

**Pros:** durable, replayable, cheap, correct Workspace grain.

**Failure:** external writers do not participate in canonical admission, so G alone cannot detect them. It also requires operation effect certainty; increment-at-request/start is unsound.

**Classification:** insufficient alone; retain as causal half.

## 46. Alternative C — attempt observation token only

```text
attempt starts O0
→ successful mutation captures O1 as new expected token
```

**Pros:** directly represents observed state and in-attempt progression.

**Failure:** adopting O1 after a mutation does not tell whether O1 contains only the intended effect, a concurrent external edit, partial effect, or a mixture. Restart also needs separate durable semantics.

**Classification:** reject alone; retain expected-observation concept.

## 47. Alternative D — isolated Workspace per ProgramAttempt

Families:

- isolated Git worktree;
- filesystem snapshot/overlay;
- container/VM workspace;
- transactional remote Workspace provider.

**Pros:** strongest causal attribution; live-worktree external edits cannot race the isolated attempt.

**Costs:** new workspace/merge/conflict semantics, tool containment, platform/provider complexity, shell escape considerations, substantial first-slice scope.

**Classification:** strongest architecture for continuous isolation; defer unless Phase 1 explicitly requires that stronger guarantee.

## 48. Alternative E — watcher/CodeRevisionToken as authority

**Pros:** existing low-cost change signal.

**Failure:** watcher silence is not proof; events can coalesce/delay/duplicate; current token is in-memory/cache-oriented; no operation causation or durable effect uncertainty.

**Classification:** reject as authority; keep as sensor/cache invalidator.

## 49. Alternative F — hybrid durable effect lineage + observed execution base

```text
WorkspaceEffectGeneration G
  = canonical Host-known confirmed effect lineage

ExecutionObservationIdentity O
  = Host-observed current Workspace state at checked cut

ProgramAttemptExecutionBase = (G,O)
```

Confirmed current-attempt mutation:

```text
(G,O0)
→ correlated operation
→ effect confirmed
→ observe O1
→ G→G+1 exactly once
→ expected base (G+1,O1)
```

Unexpected observation mismatch:

```text
G unchanged
+ Ocurrent != Oexpected
→ drift
→ current attempt cannot silently continue dependent claims
```

Indeterminate effect:

```text
no trusted next base
→ reconciliation
```

**Pros:** separates causation and observation, replayable effect lineage, legitimate mutations do not self-invalidate, external drift remains visible, uncertainty preserved, successor dispatch natural, verification freshness remains separate, future isolation compatible.

**Limitations:** more state; observation schema and barrier still need design; external shared-worktree races remain possible between checks.

**Classification:** **preferred for Phase 1 if the intended guarantee is boundary-checked freshness rather than continuous isolation.**

---

# Part VIII — Adversarial histories

## 50. First attempt unchanged

```text
Bplan recheck matches
→ observe O0 at G0
→ A0 starts (G0,O0)
```

Expected: current.

## 51. External edit before first dispatch

```text
Program created
→ external edit
→ first-dispatch Bplan recheck mismatches
```

Expected: no attempt dispatch. Program creation remains canonical semantic authorization; lifecycle/replan policy handles staleness.

## 52. Legitimate current-attempt mutation

```text
A0 (G0,O0)
→ M requested under exact A0
→ M effect confirmed
→ observe O1
→ G0→G1 exactly once
→ A0 expected base (G1,O1)
```

Expected: A0 is not stale because its own authorized effect changed the Workspace.

## 53. Read races external edit

```text
read begins at O0
→ external edit
→ read returns
→ post-read observation != O0
```

Expected: read result non-current/rejected for current Program evidence; no causal generation advance.

## 54. External ABA between checked cuts

```text
checked O0
→ external edit O0→O1
→ external revert O1→O0
→ next checked observation equals O0
```

Expected statement: the boundary-only equality model may not detect this history. It must not claim that no intervening mutation occurred. A provider monotonic revision may detect it if trustworthy; otherwise only isolation can prove continuous non-interference.

## 55. Foreground Host mutation races active attempt

Preferred result: Host-mediated environmental mutation coordinator prevents the foreground mutator from crossing the protected ProgramAttempt mutation lifetime. Do not rely on detecting the race afterward.

## 56. Host mutation while Program parked

```text
no active ProgramAttempt
→ foreground Host mutation confirmed
→ G→G+1
→ later Program resume observes current O
→ successor attempt starts from current (G+1,O)
```

Whether semantic replanning is necessary depends on impact; freshness alone does not rewrite Program semantics.

## 57. External mutation while Program parked

```text
old expected O0
→ Host offline/Program parked
→ external edit
→ resume observation O1 != O0
```

Expected: no silent resume under old attempt assumptions; explicit rebase/replan/revalidation before fresh attempt.

## 58. Crash after effect before terminal append

```text
operation.started canonical
→ mutation may occur
→ crash before terminal/generation advance
```

Restart:

- operation becomes/surfaces indeterminate under existing recovery semantics;
- replay still has old trusted G;
- live observation may differ;
- do not infer `G+1` merely from changed files;
- reconcile effect.

Confirmed reconciliation: advance lineage exactly once and obtain fresh observation before dependent continuation.

Absent reconciliation: G unchanged.

Unresolved: block dependent Program execution/completion under final Phase 1 rules.

## 59. Failed shell with partial effect

Failure does not prove effect absent. Preserve `indeterminate` until tool-specific reconciliation/user resolution. Do not adopt current files as a trusted continuation base just to make progress.

## 60. Duplicate watcher events

One Host operation can produce many watcher notifications. `WorkspaceEffectGeneration` advances once because `operationId`/effect transition is the causal authority.

## 61. Missed watcher event

A later direct covered observation can still detect mismatch. Watcher silence was never sufficient proof.

If the direct observation model excludes the changed state, the contract must admit that coverage limit rather than claiming detection.

## 62. External edit between pre-check and tool call

Possible in shared live Workspace. The hybrid does not claim exclusion. Later checks may detect consequences, but pre-check equality is not transaction isolation.

## 63. External edit during successful mutator

```text
M mutates
+ external editor mutates concurrently
→ M reports success
→ Host observes O1
```

The Host may know M has a confirmed effect under operation semantics. It generally cannot prove every O0→O1 byte transition came solely from M.

Required wording:

- advance M's Host effect lineage once if effect confirmed;
- O1 is post-effect observation, not exclusive-causation proof;
- verification evaluates actual current subject state;
- stronger sole-causation guarantee requires isolation.

## 64. External edit immediately after terminal observation

```text
Host observes O1
→ terminal/generation cut records that observation/effect
→ external edit O2
```

The record is truthful that O1 was observed at the cut. It does not grant eternal freshness. Next checked boundary re-observes.

## 65. Successor after legitimate mutation

```text
A0 effect advances (G0,O0)→(G1,O1)
→ A0 ends
→ A1 dispatches from current (G1,O1-or-equivalent)
```

Never compare A1 back to creation `Bplan` as a perpetual requirement.

## 66. Late superseded-attempt effect

```text
A0 superseded
→ A1 current
→ late A0 operation effect/result arrives
```

Separate:

- real external effect: preserve/reconcile and advance Workspace lineage if confirmed;
- stale Program authority: late A0 evidence does not become current merely because files happen to match.

## 67. Disjoint confirmed mutation after verification

```text
V satisfied at subjectGeneration 4
→ Workspace Host effect G9→G10
→ mutation proven disjoint from V
```

Expected: execution lineage advances; V may remain satisfied.

## 68. Unknown-impact confirmed mutation

Expected: execution lineage advances; affected/unknown obligation generation advances fail-closed.

## 69. External drift after verification

```text
V satisfied
→ external drift observed
→ Host establishes new accepted execution observation
```

Expected: evaluate verification impact independently. Known disjoint may preserve; unknown/relevant invalidates. Do not invent a Host effect generation solely to trigger verification invalidation.

## 70. Completion races drift

```text
preliminary complete
→ drift/effect uncertainty appears
→ terminal admission runs
```

Expected: terminal revalidation rejects completion if the checked current predicates are no longer true.

An external write after the final terminal observation/commit remains outside any non-isolated guarantee.

## 71. Restart after offline edit

```text
last trusted (G,O0)
→ clean shutdown
→ human edits while Host absent
→ restart
→ replay G
→ observe O1 != O0
```

Expected: do not resume old execution assumptions; no watcher history during downtime is required if the direct observation covers the change.

---

# Part IX — Preferred semantic model

## 72. WorkspaceEffectGeneration

Required properties:

1. Workspace-scoped;
2. monotonic;
3. replayable;
4. advances exactly once per qualifying Host-known confirmed mutating effect;
5. unchanged for reads/effect-absent;
6. not silently advanced across indeterminate effect;
7. not advanced merely because external drift was observed.

Exact initial value/event spelling is implementation detail.

## 73. ExecutionObservationIdentity

Opaque conceptual shape:

```ts
interface ExecutionObservationIdentity {
  kind: string;
  value: string;
}
```

Possible sources include Git/worktree state, bounded filesystem digests, CodeIntelligence observations, or remote Workspace provider revision IDs. This study promotes none specifically.

The selected representation must have explicit coverage/equivalence semantics.

## 74. ProgramAttemptExecutionBase

```ts
interface ProgramAttemptExecutionBase {
  workspaceEffectGeneration: WorkspaceEffectGeneration;
  observation: ExecutionObservationIdentity;
}
```

The Agent may receive this through AttemptProjection but cannot author/advance it.

## 75. Attempt expected-base reducer

Host derives current expected base from:

```text
attempt initial base
+ correlated confirmed effect transitions
+ drift/stale transitions
+ reconciliation outcomes
```

It is rebuildable from canonical history plus explicitly recorded observations; it is not an Agent-maintained mutable field.

## 76. Operation ownership remains root-causal

`operation.requested` is the natural durable root binding operation to Program/ProgramAttempt. Later lifecycle/evidence facts inherit through immutable `operationId`.

The exact final Phase 1 schema may copy identifiers into projections, but should not create two independent ownership authorities.

## 77. Generation transition is idempotent by operation effect identity

A confirmed effect transition must not increment twice under retry/recovery. `operationId` plus the canonical effect/reconciliation transition is the natural idempotency anchor.

## 78. Drift fact means observation, not actor attribution

When the Host records drift, its authoritative meaning is:

```text
at cut C, Host observed expected execution base mismatch
```

not:

```text
actor X definitely wrote path Y
```

unless separate evidence establishes that attribution.

## 79. No silent baseline replacement after unexplained drift

Preferred first slice:

```text
unexpected drift
→ current attempt stale for dependent claims
→ inspect current Workspace
→ replan/revalidate as needed
→ establish new accepted current observation
→ fresh ProgramAttemptId
```

This preserves ProgramAttempt as a meaningful claim rather than a mutable lease over arbitrary state changes.

## 80. Drift does not automatically change ProgramState revision

Execution-assumption staleness and Program semantic revision are distinct. A later replan may change canonical Program facts/revision, but drift observation alone should not fabricate a Program revision merely to synchronize counters.

---

# Part X — Relationship to existing Phase 1 decisions

## 81. Program creation

`PlanningObservationIdentity` owns semantic planning provenance. First dispatch hands off from `Bplan` to runtime execution base. Runtime freshness owns progression afterward.

## 82. Verification freshness

Cardinality is deliberately different:

```text
one Workspace Host effect or observed external drift
→ zero/one/many verification subjectGeneration changes
```

according to deterministic impact analysis.

## 83. Agent topology

Fixed first-slice topology can still span many attempts/effects. Deferring Agent post-creation work addition does not eliminate runtime freshness.

## 84. Structural bounds

Bound:

- observation identity size;
- persisted observation/drift receipts;
- path/impact sets;
- replay/projection growth.

Do not persist an unbounded whole-filesystem manifest per event.

## 85. Operation correlation

Stale Program authority and real external effect are independent. A stale attempt's operation may still have changed the Workspace; preserve/reconcile that effect without promoting stale evidence.

## 86. Cancellation

Cancellation cuts Program authority; it does not roll back effects. Post-cancel operation effects still enter Workspace effect/reconciliation semantics, while stale/cancelled Program evidence remains inadmissible as current.

## 87. Scheduler concurrency

Per-Workspace single active ProgramAttempt simplifies the model but does not serialize foreground/non-Program Host mutators. Environmental mutation coordination remains necessary.

## 88. Completion Oracle

Completion consumes execution-freshness status plus verification freshness and ordinary Program predicates. It does not turn Workspace observation into canonical filesystem truth.

---

# Part XI — Acceptance-proof consequences

## 89. AC-10-04 — exact attempt validity

Prove:

- attempt initial execution base is exact;
- expected base advances only through Host-owned transitions;
- unexplained drift makes current attempt stale for dependent claims;
- stale attempt cannot regain authority by accidental later state equality.

## 90. AC-10-05 — scheduler/dispatch

Prove:

- first dispatch bridges from `Bplan`;
- successor dispatch uses current execution-aware base;
- `Bplan` is not perpetual;
- Host foreground mutation cannot cross protected attempt mutation lifetime;
- restart/resume re-observes current Workspace.

## 91. AC-10-06 — operation uncertainty/correlation

Prove:

- confirmed mutating effect advances effect lineage exactly once;
- effect-absent leaves it unchanged;
- indeterminate blocks trusted base advancement;
- reconciliation-to-confirmed/absent resolves lineage exactly once;
- stale attempt ownership does not erase real effect.

## 92. AC-10-07 — verification freshness

Prove:

- effect generation and `subjectGeneration` are distinct;
- disjoint Host effect may preserve verification;
- unknown-impact Host effect invalidates;
- external drift also triggers impact evaluation/fail-closed invalidation without requiring fake Host-effect generation;
- unresolved drift/effect uncertainty blocks unsafe satisfaction admission.

## 93. AC-10-08 — completion

Negative proof:

```text
preliminary completion true
→ drift/effect uncertainty before terminal cut
→ terminal revalidation rejects completion
```

## 94. AC-10-09 — recovery

Prove:

```text
restart
→ replay causal lineage
→ surface/reconcile interrupted effects
→ direct re-observation
→ mismatch/unknown prevents affected Program continuation
```

This is a **new Phase 1 barrier requirement**, not a statement that current Host startup already globally blocks work.

## 95. Required negative proofs

```text
A at (G,O)
→ unexplained covered drift observed
→ A cannot continue dependent mutation/evidence/verification/completion
```

```text
A legitimately mutates
→ confirmed effect
→ G advances once
→ A may continue from new expected base
```

```text
operation started
→ crash after possible effect
→ no terminal fact
→ restart does not fabricate G+1
```

```text
reconciliation absent
→ G unchanged
```

```text
reconciliation confirmed
→ G advances once
```

```text
terminal/reconciliation retry
→ no duplicate generation advance
```

```text
duplicate watcher events
→ no duplicate effect generations
```

```text
watcher silence
→ not proof of no change
```

```text
external ABA O0→O1→O0 between checks
→ boundary equality may not detect history
→ system does not claim continuous non-interference
```

```text
foreground Host mutator during protected ProgramAttempt
→ cannot cross mutation lifetime
```

```text
external edit while Host offline
→ restart re-observation mismatch
→ no silent old-base resume
```

```text
disjoint Host effect
→ G advances
→ unrelated verification may remain current
```

```text
external drift with unknown verification impact
→ verification invalidates fail-closed
→ no fake Host-effect generation required
```

```text
first attempt legitimately mutates
→ successor dispatch uses runtime base
→ no equality check against creation Bplan
```

```text
late stale-attempt real effect
→ preserve/reconcile Workspace effect
→ reject stale Program evidence authority
```

---

# Part XII — Comparison

## 96. Matrix

| Alternative | Causal authority | External drift | Legitimate mutation continuity | Replay | Indeterminate effect | Continuous isolation | Result |
|---|---|---|---|---|---|---|---|
| A. Re-observation only | weak | at covered cuts | ambiguous | weak alone | weak | no | reject alone |
| B. Canonical generation only | strong for Host effects | no | strong | strong | good if composed | no | partial |
| C. Attempt token only | observational | at cuts | possible but ambiguous | weak alone | weak | no | reject alone |
| D. Isolated Workspace | strong | live external drift excluded from attempt | strong | provider-dependent | strong if integrated | **yes** | strongest, defer |
| E. Watcher token authority | weak | best-effort | ambiguous | weak | weak | no | reject as authority |
| F. Hybrid lineage + observation | **strong Host causation + explicit observation** | **at defined covered cuts** | **strong** | **strong causation + re-observation** | **strong** | no | **prefer** |

---

# Part XIII — Recommendation

## 97. Recommendation

**Recommend Alternative F for the Phase 1 first slice, provided the intended guarantee is boundary-checked execution freshness rather than continuous filesystem isolation.**

Use:

```text
WorkspaceEffectGeneration
```

for durable Host-known confirmed mutation lineage, and:

```text
ExecutionObservationIdentity
```

for bounded Host observation at freshness-sensitive cuts.

Every ProgramAttempt starts from:

```text
ProgramAttemptExecutionBase = (WorkspaceEffectGeneration, ExecutionObservationIdentity)
```

and its Host-derived expected base may advance through exact correlated confirmed effects.

Rules:

```text
read / effect absent
→ no effect-generation advance
```

```text
confirmed Host mutating effect
→ G advances exactly once
→ capture post-effect observation
→ current expected base advances
```

```text
indeterminate effect
→ no trusted next base
→ reconciliation barrier
```

```text
unexpected observed divergence
→ no fake Host effect generation
→ current attempt stale for dependent claims
→ explicit rebase/replan before fresh attempt
```

```text
successor attempt
→ latest execution-aware base
→ never perpetual creation-Bplan equality
```

## 98. Why this wins

It is the smallest model found that jointly preserves:

- Host canonical ownership;
- legitimate in-attempt mutation;
- replayable external-effect causation;
- crash uncertainty;
- external drift detection at defined cuts;
- successor execution;
- verification-freshness separation;
- compatibility with future isolated Workspace providers.

One generation loses observation. One observation loses causation. Watchers lose authority/replay. Full isolation is stronger but significantly expands the architecture.

## 99. Guarantee wording if promoted

Use language equivalent to:

> **Execution freshness is checked and fail-closed at defined Host boundaries. Host-mediated mutating execution participates in Workspace mutation coordination, and Host-known effect lineage is canonical/replayable. External/non-Host writers remain outside that exclusion; their covered changes are detected by later observations when visible to the selected observation model, not prevented transactionally. The contract does not claim continuous mutation-history detection or exclusive byte-level causation without stronger isolation.**

## 100. Confidence and falsifiers

**High confidence** in separating:

```text
Host effect lineage
!=
live Workspace observation
!=
verification subject generation
```

**Medium-high confidence** in the hybrid as the Phase 1 tradeoff under a boundary-checked guarantee.

**Low-to-medium confidence** in exact observation representation until Workspace/provider semantics are chosen and measured.

The recommendation is falsified if Phase 1 requires any of:

- proof that no external writer changed relevant state during an attempt;
- proof of complete mutation-history continuity between checks;
- exclusive byte-level causal attribution for arbitrary shell/tool effects.

Those requirements push the architecture toward isolated/transactional Workspace execution.

---

# Part XIV — Remaining freeze-readiness dependencies

## 101. ExecutionObservationIdentity

Define:

- representation;
- coverage;
- bounds;
- equality/equivalence;
- Git dirty/untracked/ignored semantics;
- absence/directory semantics;
- remote/provider revision semantics;
- incomplete observation behavior;
- restart behavior.

Unknown equivalence fails closed where correctness depends on it.

## 102. Host-mediated Workspace mutation barrier

Define:

- owning Host subsystem;
- acquisition/release order;
- mutating capability classification;
- read-only concurrency;
- foreground/non-Program behavior;
- ProgramAttempt lifetime transfer;
- cancellation/timeout/crash;
- indeterminate/reconciliation interaction;
- queueing/deadlock behavior.

## 103. Effect-generation transition ownership

Define exactly-once advancement across:

- normal terminal success;
- terminal retry;
- crash after effect before terminal record;
- reconciliation to confirmed;
- reconciliation to absent;
- stale/superseded attempt;
- Program cancellation.

`operationId` is the natural causal idempotency key; exact event spelling remains open.

## 104. Drift/rebase lifecycle

Define:

- attempt invalidation/supersession;
- ProgramState-revision interaction;
- Application/read-model surfacing;
- Agent replan flow;
- verification invalidation from external drift;
- when a new accepted execution observation and fresh attempt may be established.

Preferred first slice: **no silent in-attempt baseline replacement after unexplained drift**.

## 105. Capability observation contract

Define what capabilities can provide about:

- read observation identity;
- affected paths where known;
- post-effect observation;
- effect certainty;
- reconciliation evidence.

Unknown affected paths may conservatively invalidate verification without changing the meaning of Workspace Host-effect lineage.

## 106. Verification predicate taxonomy remains separate

This study does not close the creation-time verification-requirement predicate taxonomy.

## 107. Structural values remain empirical

Execution-observation and drift/effect records need bounded representation, but exact ceilings still require measurement.

## 108. Stronger isolation remains an explicit future branch

If boundary checks prove insufficient, study an isolated/transactional Workspace provider rather than adding more counters to a shared worktree.

---

# Part XV — Planning status

## 109. Status

This document remains a recommendation only.

It does not:

- amend `docs/phase-1.0-plan.md`;
- supersede `docs/phase-1.0-open-decisions-study.md`;
- supersede `docs/phase-1.0-program-creation-authorship-study.md`;
- consolidate the artifact-evidence amendment;
- approve or freeze Phase 1.0;
- authorize implementation.

If accepted, its conclusions belong only in a later explicitly authorized Phase 1.0 consolidation decision.
