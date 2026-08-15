# ALCODE Phase 1.0 — ProgramAttempt Execution Freshness Study

**Status:** DRAFT / non-normative planning study  
**Approval:** not approved; not frozen; implementation not authorized  
**Repository base studied:** `main` at `7e81de42ccdbf5917e6a2f2d53cf5b0acfdd5084`  
**Relationship to Phase 1.0:** studies the execution-freshness dependency exposed by `docs/phase-1.0-program-creation-authorship-study.md`. It does not amend `docs/phase-1.0-plan.md`, change AC-10 acceptance criteria, approve/freeze Phase 1.0, or authorize implementation.

## 1. Question

The Program-creation study deliberately makes creation-time `PlanningObservationIdentity` / `Bplan` a **creation-to-first-execution bridge only**. That is correct: once a legitimate Program-correlated mutation changes the Workspace, comparing every later dispatch back to immutable creation-time state would stall normal execution.

That leaves a separate runtime contract question:

> **How does the Host decide that a ProgramAttempt, capability result, evidence admission, verification satisfaction, successor dispatch, and completion decision are fresh with respect to the current Workspace after execution has begun — while distinguishing known Host-mediated effects from unexpected out-of-band changes and preserving uncertainty across crash/recovery?**

This is not the same question as verification freshness. Verification freshness answers whether one obligation remains satisfied for its current subject generation. This study asks whether execution claims are being made against a Workspace state the Host can still treat as current enough for the relevant canonical cut.

The study also asks what Phase 1 can **honestly guarantee** when a human editor or non-ALCODE process can modify the live repository without participating in Host admission.

---

# Part I — Scope and guarantee boundary

## 2. In scope

This study covers execution freshness from first ProgramAttempt dispatch through later attempts and Program completion, including:

- the execution-state identity used at ProgramAttempt dispatch;
- how legitimate Host-mediated mutating effects advance that identity;
- how read-only and mutating capability results are tied to the current execution base;
- out-of-band Workspace changes observed between Host decision boundaries;
- interaction with `operationId`, ProgramState revision, ProgramAttemptId, verification `subjectGeneration`, and creation-time `PlanningObservationIdentity`;
- indeterminate operation effects and reconciliation;
- restart/replay requirements;
- successor ProgramAttempt dispatch after earlier legitimate mutation;
- foreground/non-Program Host-mediated mutations;
- verification and Completion Oracle composition.

## 3. Out of scope

This study does not:

- implement ProgramState or ProgramAttempt;
- select an exact filesystem hashing implementation;
- promise filesystem snapshot isolation;
- claim that chokidar, Git, CodeIntelligence, or a filesystem watcher is canonical authority;
- make arbitrary external processes obey the Host's Workspace lock or mutation barrier;
- replace per-obligation verification freshness;
- define the complete Program-creation planning-observation schema;
- define the final Host-mediated mutation-barrier implementation;
- amend the governing Phase 1.0 plan.

## 4. Honest guarantee boundary

A live Workspace is not transactionally coupled to the canonical SQLite event store. A human editor can write after a Host observation and before the next filesystem operation. Therefore Phase 1 cannot honestly claim serializable filesystem transactions merely by introducing a generation counter or watcher.

The strongest first-slice guarantee considered achievable without stronger isolation is:

> **At every defined freshness-sensitive Host boundary, the Host revalidates canonical Program/Attempt currency and a bounded Host-observed execution base under Host-mediated mutation exclusion. Known Host-mediated mutation effects advance a durable causal lineage only through canonical operation/effect semantics. Unexpected observed divergence fails closed for the current ProgramAttempt. Indeterminate effects remain uncertainty and block dependent progress until reconciliation. This proves boundary-checked freshness and durable uncertainty handling; it does not prove that an arbitrary external writer could not race between two observations or during a capability's environmental execution.**

If Phase 1 requires the stronger property:

```text
no external writer can race a ProgramAttempt mutation
```

then a filesystem/repository isolation mechanism is required. No counter, watcher, or canonical event ordering can manufacture that property.

---

# Part II — Method

## 5. Decision method

For each alternative this study asks:

1. what fact is canonical;
2. what is only an observation;
3. what exact state a ProgramAttempt claims;
4. how a legitimate mutating operation changes that state;
5. how unexpected change is detected;
6. what happens when detection is incomplete or equivalence is unknown;
7. what survives Host crash/restart;
8. what happens when an external effect is `indeterminate`;
9. whether replay reconstructs the same authority without current watcher memory;
10. whether the design composes with verification freshness rather than replacing it;
11. what guarantee remains impossible without stronger isolation.

Correctness is a gate. Simplicity does not compensate for:

- duplicated canonical authority;
- stale-attempt admission;
- treating an observation token as mutation authority;
- losing effect uncertainty;
- replay dependence on process-local counters;
- automatically blessing unexplained Workspace drift;
- making legitimate Program mutations look like stale external changes;
- using creation-time `Bplan` as a perpetual runtime baseline.

---

# Part III — Repository facts

## 6. Program execution freshness is not implemented yet

Phase 1.0 remains planning-only. Current runtime code has no ProgramState or ProgramAttempt execution-freshness implementation.

The existing runtime nevertheless exposes important architectural facts and precedents that constrain a correct Phase 1 design.

## 7. One HostRuntime owns one locked Workspace runtime domain

`packages/host-runtime/src/host.ts` constructs one `HostRuntime` around one `LockedWorkspaceStore`, one `CanonicalAdmissionQueue`, one capability broker, one session manager, one context service, and one durable-work dispatcher.

This makes the Workspace runtime/admission domain the natural grain for a Workspace-scoped causal effect lineage.

It does **not** mean the Host controls every writer to the repository.

## 8. The Workspace lock excludes another cooperating Host, not arbitrary editors

`packages/workspace/src/lock.ts` implements a process-scoped lock for opening the ALCODE Workspace store. It is explicitly a Host/process ownership primitive.

It does not lock repository files against:

- an IDE;
- a shell outside ALCODE;
- another non-ALCODE process;
- a human writing files directly.

Therefore:

```text
Workspace store ownership
!=
filesystem isolation
```

## 9. Canonical admission is a serialization point, not an execution-lifetime lock

`CanonicalAdmissionQueue` serializes canonical event-store append work for a Workspace.

That is suitable for:

- exact attempt/currentness checks;
- atomic operation/attempt correlation;
- atomic effect-lineage transitions;
- stale/duplicate rejection;
- terminal Program decisions.

It is not sufficient to exclude an environmental mutation that executes outside the queue.

## 10. Capability execution crosses the canonical boundary

Current `packages/host-runtime/src/capability-broker.ts` does roughly:

```text
canonical admission:
  operation.requested
  operation.started
  action.recorded

then outside canonical admission:
  capability.execute(...)

then later canonical admission:
  operation.completed / failed / rejected
  evidence.recorded where applicable
```

So:

```text
operation.started became canonical
```

is not equivalent to:

```text
the environmental effect is complete
```

Any execution-freshness design that advances Workspace state at request/start merely because the event was admitted is unsound.

## 11. Operation identity already separates lifecycle from effect certainty

`packages/storage/src/operations.ts` and ADR 0003 model one durable root `operationId` with separate concepts for:

- execution lifecycle;
- effect status;
- reconciliation status.

The accepted architectural rule from ADR 0003 is:

> Effectively once where supported, otherwise detect and preserve uncertainty.

A mutating operation interrupted by crash can have an **indeterminate** effect. That state is durable and must not be silently converted into either "nothing happened" or "the current Workspace is fresh".

## 12. Startup recovery already treats mutation uncertainty as a barrier

Current Host startup enters recovery before ordinary new work. Surviving started/requested mutating operations are reconciled rather than blindly retried.

This is strong precedent for the Phase 1 rule:

> unresolved external-effect uncertainty blocks creation of a new trusted execution base.

## 13. CodeIntelligence has an observation token, not Program authority

`packages/code-intelligence/src/types.ts` defines:

```ts
interface CodeRevisionToken {
  epoch: number;
  generation: number;
  fingerprint: string;
}
```

`WorkspaceRevisionTracker` in `packages/code-intelligence/src/tracker.ts` maintains this token from:

- a bounded baseline fingerprint;
- chokidar-observed changes;
- explicit Host mutation notifications.

Ordinary changes advance `generation`; relevant configuration/baseline changes can bump `epoch` and recompute the fingerprint.

This is useful **observation infrastructure**.

It is not suitable as canonical Program execution authority as currently defined because:

- it is an in-memory tracker;
- watcher events are observations, not canonical effect decisions;
- it does not encode `operationId` or ProgramAttempt causation;
- it cannot by itself distinguish a legitimate current-attempt write from an external write;
- its counter is designed for CodeIntelligence invalidation/cache coherence;
- restart/replay semantics are different from canonical Program semantics.

## 14. CodeIntelligence already uses optimistic re-observation

`packages/code-intelligence/src/service.ts` captures a revision token before a provider query, queries the provider, captures the token again, and retries once if the token changed.

That is useful precedent for a **boundary re-observation pattern**.

It does not solve durable ProgramAttempt authority because the retry rule is query-local and does not preserve canonical external-effect uncertainty.

## 15. Durable work already demonstrates replayable claim/recovery patterns

`packages/host-runtime/src/work-dispatcher.ts` records durable requested/claimed/interrupted/completed work states and reconstructs its ledger by replay.

This supports the broader Phase 1 principle that execution authority must be reconstructible from canonical history rather than surviving only in process memory.

## 16. Creation-time Bplan has a deliberately finite role

`docs/phase-1.0-program-creation-authorship-study.md` now requires:

- complete bounded planning provenance;
- exact Application acceptance;
- final accepted planning-base recheck before creation;
- one final creation-time `Bplan` recheck before **first ProgramAttempt dispatch only**.

After legitimate execution mutation, successor dispatch must use an execution-aware current base.

This study defines that successor-side model.

## 17. Verification freshness is already a separate proposed contract

`docs/phase-1.0-open-decisions-study.md` recommends per-obligation monotonic `subjectGeneration`:

- satisfaction belongs to one obligation generation;
- relevant mutation advances that obligation generation;
- known disjoint mutation may preserve it;
- unknown relevance fails closed.

That remains the correct conceptual home for **verification satisfaction freshness**.

Execution freshness needs a Workspace/Attempt-level mechanism, but it must not collapse into one global verification epoch.

---

# Part IV — Identity separation

## 18. The identities solve different problems

The following must remain conceptually distinct:

```text
PlanningObservationIdentity
  creation-time semantic-planning provenance
  bridge to first execution only

ProgramState revision
  canonical task-state revision / proposal currency

ProgramAttemptId
  fresh non-reusable execution claim

operationId
  durable external-operation/effect identity

WorkspaceEffectGeneration
  proposed durable ordinal of Host-known confirmed mutating effects

ExecutionObservationIdentity
  proposed Host observation of live Workspace state at a freshness cut

verification subjectGeneration
  per-obligation satisfaction currency

CodeRevisionToken
  CodeIntelligence/cache observation token
```

Similarity of names is not semantic equivalence.

## 19. Why one universal generation is insufficient

A single global integer cannot simultaneously prove:

- what bytes/state the Host observed;
- why that state changed;
- whether a change came from the current ProgramAttempt;
- whether an interrupted tool may have partially changed the Workspace;
- whether one verification obligation is stale;
- whether an external editor changed the Workspace without a Host operation.

A correct design therefore needs at least a causal dimension and an observation dimension.

---

# Part V — Required properties

## 20. Exact current-attempt admission

At every Program-originated operation request, evidence admission, verification admission, successor dispatch, and terminal completion cut, the Host revalidates:

- exact current ProgramState revision where relevant;
- exact current ProgramAttemptId where relevant;
- Program lifecycle still permits the transition;
- no winning cancellation/supersession transition;
- no unresolved Workspace/effect uncertainty that makes the claim unsafe.

These checks occur inside the canonical admission that admits the relevant fact when the decision is canonical.

## 21. ProgramAttempt has an execution base

Every ProgramAttempt begins with an exact Host-owned execution base.

Illustrative semantic shape:

```ts
interface ProgramAttemptExecutionBase {
  workspaceEffectGeneration: number;
  observation: ExecutionObservationIdentity;
}
```

The exact field spelling is open. The architectural requirement is not.

The first ProgramAttempt derives this base only after the accepted creation-time planning base passes its first-dispatch recheck.

A successor ProgramAttempt derives its base from the current execution-aware Workspace state, not from creation-time `Bplan`.

## 22. Attempt initial base and current expected base are distinct

A ProgramAttempt may execute multiple correlated capability operations. A legitimate mutating operation must not automatically invalidate the very attempt that requested it.

Therefore the attempt has:

```text
initial execution base
```

and a Host-derived/rebuildable:

```text
current expected execution base
```

that can advance through confirmed Program-correlated mutations.

The current expected base is never advanced by an Agent assertion.

## 23. WorkspaceEffectGeneration is causal, not a filesystem hash

The proposed `WorkspaceEffectGeneration` means:

> a durable monotonic ordinal of Host-known **confirmed mutating effects** in this Workspace authority domain.

It does **not** mean:

> exact current filesystem contents.

A generation advances only through canonical operation/effect semantics, exactly once per qualifying confirmed effect transition.

A read-only operation does not advance it.

An operation proven to have no effect does not advance it.

An indeterminate effect does not create a trusted next generation merely because the Host wants to continue.

## 24. ExecutionObservationIdentity is observation, not canonical mutation authority

The proposed `ExecutionObservationIdentity` records a bounded Host-observed identity of the live Workspace at a defined cut.

Its exact representation may use Git/files/digests/CodeIntelligence components, but it must have explicit semantics for:

- included state;
- exclusions;
- absence/directory/query semantics where relevant;
- bounds;
- equality/equivalence;
- unknown/incomplete observation;
- restart re-observation.

A canonical event may authoritatively record that:

```text
Host observed O at cut C
```

without claiming that O is eternal canonical filesystem truth.

## 25. Known Host effects advance causal lineage

For a Program-correlated mutating operation:

```text
request under exact current ProgramAttempt / expected base
→ operation executes under Host-mediated mutation coordination
→ terminal effect becomes confirmed
→ Host obtains post-effect observation O1
→ canonical admission records terminal/evidence as allowed
  + advances WorkspaceEffectGeneration exactly once
  + advances the attempt's expected execution base to (G+1, O1)
```

Where atomic batching is feasible, the effect-lineage advance and canonical terminal/evidence admission should share the same admission cut so replay cannot observe terminal success with the old causal generation.

## 26. Effect-none leaves causal lineage unchanged

If reconciliation proves a mutating operation had no effect:

```text
G remains G
```

A new observation may still be required before continuation, especially after crash, but the Host does not fabricate a mutating-effect generation.

## 27. Indeterminate effects block a trusted next base

If a mutating operation is interrupted, times out, fails with uncertain side effects, or otherwise has `effectStatus = indeterminate`:

```text
trusted expected base advancement is blocked
```

The ProgramAttempt cannot simply capture the current Workspace and call it fresh, because doing so would erase the distinction between:

- effect happened;
- effect did not happen;
- effect partially happened;
- unrelated external change happened.

Reconciliation must resolve the effect semantics or the uncertainty remains visible/blocking.

## 28. Unexpected observed divergence fails closed

At a freshness-sensitive boundary, if:

```text
current Host observation != expected execution observation
```

and the divergence is not already accounted for by the canonical transition being admitted, the current ProgramAttempt loses freshness for dependent canonical claims.

The Host records/reports the stale/drift condition through a durable/rebuildable mechanism before allowing successor execution.

The exact event spelling is implementation design.

## 29. Out-of-band drift is not converted into Host effect lineage

An observed external edit does **not** automatically increment `WorkspaceEffectGeneration` as if the Host caused a confirmed operation.

Otherwise the system would lose causation:

```text
external write
→ watcher increments generation
→ looks indistinguishable from confirmed Host effect
```

Instead:

- Host-known effect lineage remains what canonical operation history says it is;
- the observation mismatch marks the current expected base stale/uncertain;
- a later rebase/replan/re-dispatch path establishes a new execution base from current observed Workspace state under explicit Host policy.

## 30. Watchers are early-warning sensors, not proof of absence

A watcher/CodeIntelligence token may quickly signal drift and invalidate caches.

But:

```text
no watcher event observed
```

is not sufficient proof that no external edit occurred.

Freshness-sensitive Host decisions require the selected direct observation/equivalence check, not watcher silence alone.

## 31. Host-mediated foreground mutation cannot race an active protected attempt

A non-Program/foreground Host-mediated mutating capability must not cross the active ProgramAttempt's protected mutation lifetime merely because it has a different session or no ProgramState.

The Host-mediated Workspace mutation barrier/scheduler integration must prevent that race or force an explicit serialized handoff.

If such a mutation completes while a Program is parked, it advances Workspace effect lineage. A later ProgramAttempt starts from the newer current base after revalidation/replanning as required.

## 32. External writers remain a residual race without isolation

A human/non-ALCODE writer can still change the Workspace:

- immediately after a pre-operation observation;
- while a shell command is executing;
- immediately after a terminal observation.

The hybrid model can:

- detect many such changes at later boundaries;
- fail closed when it observes unexplained divergence;
- ensure stale evidence/verification/completion does not cross a later checked cut;
- preserve indeterminate Host-operation effects.

It cannot prove sole causation of every byte transition in a live shared worktree.

That stronger property requires isolation.

## 33. Restart reconstructs causal lineage, then re-observes live state

A canonical causal generation can be rebuilt by replay.

A live Workspace observation cannot be trusted merely because the prior process recorded one before crashing.

On restart/resume:

```text
replay canonical WorkspaceEffectGeneration and Program/operation state
→ reconcile surviving uncertain operations
→ obtain a fresh Host observation of live Workspace
→ compare against the latest trusted expected base where meaningful
→ mismatch/unknown => fail closed / stale / reconciliation path
→ match => continuation may be admitted
```

No in-memory watcher generation is required to survive the crash as authority.

## 34. Verification subjectGeneration stays separate

A confirmed mutation can have two consequences:

```text
WorkspaceEffectGeneration advances globally for the Workspace effect
```

and, independently:

```text
relevant VerificationObligation.subjectGeneration advances
```

A known disjoint mutation may advance Workspace effect lineage while preserving a particular verification obligation's satisfaction.

Unknown verification impact fails closed for that obligation even if execution freshness itself is current.

## 35. Completion requires both execution and verification currentness

The Completion Oracle must reject completion if any of the following is unresolved at the terminal cut:

- current ProgramAttempt is stale/superseded where an active attempt claim matters;
- active Program-originated operations remain unfinished;
- any mutating operation has indeterminate/unreconciled effect relevant to the Program/Workspace safety contract;
- observed Workspace drift has invalidated the trusted current execution base and has not been reconciled/rebased;
- mandatory verification obligations are not satisfied for their current `subjectGeneration`;
- ordinary existing completion invariants are false.

Execution freshness is necessary but not sufficient for completion.

---

# Part VI — Freshness-sensitive boundaries

## 36. First ProgramAttempt dispatch

The first dispatch is the handoff from creation-time planning provenance to runtime execution state:

```text
accepted ProgramCreationDraft + Bplan
→ Host-mediated mutation exclusion
→ final first-dispatch recheck of accepted Bplan
→ current Workspace observation O0
→ current causal generation G0
→ admit fresh ProgramAttemptId A0 with initial execution base (G0, O0)
```

No later attempt compares directly to immutable `Bplan`.

## 37. Program-originated mutating operation request

Before a mutating capability request becomes a Program-linked durable operation, canonical admission revalidates:

- exact current ProgramState revision;
- exact current ProgramAttemptId;
- expected causal generation;
- attempt not already stale/cancelled/superseded;
- no unresolved prior effect uncertainty;
- Host-mediated mutation authority available.

A direct current observation check occurs at the defined pre-effect boundary when required by the selected observation model.

## 38. Read-only operation result/evidence

A read-only operation cannot advance `WorkspaceEffectGeneration`.

If the Workspace observation changes across the read and the result depends on mutable Workspace state, the result is not automatically current Program evidence. It must be tied to its observed revision/base or rejected/retried according to the final capability/evidence contract.

This generalizes the optimistic re-observation pattern already used by CodeIntelligence.

## 39. Mutating operation terminal/evidence admission

At terminal handling:

### Confirmed effect

```text
operation effect confirmed
+ exact operation/attempt ownership still valid for admission semantics
+ post-effect Workspace observation O1 available
→ advance WorkspaceEffectGeneration exactly once
→ update attempt expected base to (G+1, O1)
→ admit qualifying evidence with exact operation lineage
```

Late evidence from a superseded attempt does not automatically become current Program evidence even if the Workspace observation happens to match.

### Effect absent

```text
no causal generation advance
```

### Effect indeterminate

```text
no trusted next base
→ reconciliation/uncertainty barrier
```

## 40. Successor ProgramAttempt dispatch

A successor dispatch uses the current execution-aware base:

```text
latest replayable WorkspaceEffectGeneration Gk
+ fresh Host observation Ok
+ current ProgramState revision
+ no unresolved effect/drift barrier
→ fresh non-reusable ProgramAttemptId Ak
```

It does not require:

```text
Ok == creation-time Bplan
```

because earlier legitimate Program effects may have intentionally changed the Workspace.

## 41. Verification satisfaction admission

Verification admission revalidates:

- exact obligation identity;
- exact current `subjectGeneration`;
- qualifying evidence provenance;
- no unresolved effect/drift condition that makes the verification subject observation unsafe;
- Program/Attempt currency rules applicable to the evidence source.

Execution freshness does not replace the obligation generation.

## 42. Completion Oracle cut

Immediately before canonical terminal completion, the Host revalidates current Program/Attempt state, operation uncertainty, execution-drift status, and verification obligations inside the same serialized admission that can append `program.completed`.

A prior successful Workspace observation is not permanent authorization for completion.

---

# Part VII — Alternatives

## 43. Alternative A — boundary re-observation only

Model:

```text
capture Workspace fingerprint/token
→ compare at important boundaries
→ mismatch means stale
```

### Advantages

- conceptually small;
- can use existing observation infrastructure;
- catches many external edits;
- no new durable causal counter.

### Correctness problems

It does not explain **why** state changed.

If a current ProgramAttempt legitimately writes files:

```text
O0 != O1
```

A pure comparison model either:

- falsely declares the legitimate operation stale; or
- simply adopts O1 as the new baseline.

The latter is unsafe as an authority rule because it can silently bless unrelated/external changes mixed into the same interval.

It also has weak crash/replay semantics if the authoritative baseline is only process memory.

### Classification

**Reject as the sole execution-authority model.**

Retain re-observation as one component of the final design.

## 44. Alternative B — canonical Workspace generation only

Model:

```text
Host stores one durable Workspace generation G
→ every Host mutating effect increments G
→ ProgramAttempt claims G
```

### Advantages

- durable and replayable;
- cheap comparisons;
- natural Workspace runtime grain;
- clean successor-attempt sequencing.

### Correctness problems

Generation alone cannot detect an external writer that never participates in Host canonical admission.

It also cannot distinguish:

- confirmed effect;
- absent effect;
- indeterminate effect;

unless it is explicitly composed with operation semantics.

If it increments at `operation.requested` or `operation.started`, it lies about effects that may never occur.

### Classification

**Insufficient alone. Accommodate as the causal half of a stronger model.**

## 45. Alternative C — attempt-scoped observation token only

Model:

```text
ProgramAttempt starts with O0
→ read-only operations require O == expected
→ successful mutation captures O1 and replaces expected token
```

### Advantages

- naturally scoped to one execution episode;
- directly reflects observed Workspace state;
- successor operations can use updated post-mutation observation.

### Correctness problems

It conflates observed state with causal authority.

After a mutating interval, adopting O1 cannot tell whether O1 contains:

- only the Program operation's effects;
- an external edit;
- partial effects after failure;
- some combination.

Crash/restart also requires a separate durable lineage or conservative re-observation policy.

### Classification

**Reject as the sole model.**

Its "current expected observation" concept is useful inside the preferred hybrid.

## 46. Alternative D — immutable filesystem/repository isolation per ProgramAttempt

Model families include:

- isolated Git worktree;
- filesystem snapshot/overlay;
- container/VM workspace;
- transactional workspace provider with explicit commit/merge.

### Advantages

- strongest causal attribution;
- external live-worktree edits do not race the isolated attempt;
- clear pre/post state;
- can make mutation windows much easier to reason about.

### Costs and scope

- major new Remote Workspace / filesystem semantics;
- tool paths/processes must be forced into isolated view;
- merge/commit/conflict semantics become part of Program authority;
- platform-specific behavior;
- shell/tool escape paths become correctness issues;
- current Host architecture executes capabilities against the live Workspace.

### Classification

**Architecturally strongest; defer as a first-slice requirement unless Phase 1 explicitly demands continuous isolation from external writers.**

The final first-slice contract should preserve a seam for stronger workspace providers later.

## 47. Alternative E — watcher/token generation as authority

Model:

```text
CodeRevisionToken / chokidar generation changes
→ generation becomes Program freshness authority
```

### Advantages

- infrastructure exists;
- cheap early invalidation;
- reacts to Host and external changes.

### Correctness problems

- watcher silence does not prove absence of change;
- events can duplicate/coalesce/delay;
- current token is in-memory/cache-oriented;
- Host-known operation causation is not encoded;
- restart/replay does not reconstruct the same semantic authority;
- one watcher generation cannot preserve operation effect uncertainty.

### Classification

**Reject as canonical authority. Retain as advisory/early-warning observation infrastructure.**

## 48. Alternative F — hybrid durable effect lineage + Host-observed execution base + fail-closed boundary checks

Model:

```text
canonical WorkspaceEffectGeneration G
  tracks only Host-known confirmed mutating effects

ExecutionObservationIdentity O
  records what the Host observed at a defined freshness cut

ProgramAttempt current execution base = (G, O)
```

Known Program mutation:

```text
(G, O0)
→ exact correlated operation request
→ environmental execution under Host-mediated mutation coordination
→ effect confirmed
→ observe O1
→ canonical terminal/evidence + G→G+1
→ current expected base = (G+1, O1)
```

Unexpected observed change without a corresponding admitted effect transition:

```text
G unchanged
+ Ocurrent != Oexpected
→ out-of-band drift
→ current attempt cannot continue dependent canonical claims
```

Indeterminate effect:

```text
operation effect indeterminate
→ no trusted base advancement
→ reconciliation barrier
```

Restart:

```text
replay G + Program/operation state
→ reconcile uncertainty
→ re-observe O
→ match/equivalence required before continuation
```

### Advantages

- causal and observational concepts remain separate;
- replayable Host-known effect lineage;
- legitimate Program mutations do not self-invalidate;
- external drift can be detected without pretending the Host caused it;
- operation uncertainty stays first-class;
- successor dispatch naturally starts from latest current base;
- CodeIntelligence/watcher infrastructure remains useful without becoming authority;
- per-obligation verification freshness remains separate;
- compatible with a future isolated Workspace provider.

### Limitations

- more state than a single counter;
- exact observation schema still needs design;
- exact mutation-barrier lifetime still needs design;
- arbitrary external writes can still race between observations;
- during an arbitrary shell mutation, the Host cannot generally prove that every observed byte transition was caused solely by that operation;
- stronger continuous causality requires isolation.

### Classification

**Preferred for Phase 1.0, with an explicitly boundary-checked rather than snapshot-isolation guarantee.**

---

# Part VIII — Adversarial histories

## 49. First attempt, unchanged Workspace

```text
accepted Bplan
→ final first-dispatch recheck matches
→ observe O0
→ current causal generation G0
→ admit A0 at (G0, O0)
```

Normal result: A0 is current.

## 50. External edit before first dispatch

```text
Program created from Bplan
→ external editor changes dependency
→ first-dispatch recheck differs
```

Required result:

```text
no ProgramAttempt dispatch
```

Creation remains canonical semantic authorization; it is not erased. The Program needs stale/replan/re-authorization handling according to final lifecycle policy.

## 51. Legitimate current-attempt mutation

```text
A0 at (G0,O0)
→ A0 requests mutating operation M
→ exact A0/current-base admission succeeds
→ M succeeds, effect confirmed
→ Host observes O1
→ canonical terminal + evidence + G0→G1
→ A0 expected base becomes (G1,O1)
```

Required result:

- A0 is not stale merely because its own authorized mutation changed the Workspace;
- a later operation in A0 uses `(G1,O1)`;
- a successor attempt starts from current execution-aware state rather than `Bplan`.

## 52. Read-only operation races external edit

```text
A0 expects (G0,O0)
→ read starts
→ external editor changes Workspace
→ read completes
→ terminal freshness observation differs
```

Required result:

- result is not admitted as unqualified current Program evidence;
- retry/re-read may occur only under the final bounded policy;
- no causal generation is advanced because there was no Host mutating effect.

## 53. Host foreground mutator tries to race active ProgramAttempt

```text
A0 active
→ foreground session requests Host-mediated mutation F
```

Preferred result:

```text
F cannot cross A0's protected mutation authority
```

It is queued/rejected/delayed according to final mutation-barrier policy.

The system should not rely on detecting the damage after both execute concurrently.

## 54. Host foreground mutation while Program is parked

```text
Program P exists, no active ProgramAttempt
→ foreground Host mutation F executes
→ F effect confirmed
→ WorkspaceEffectGeneration G→G+1
```

Later P resume:

```text
fresh observation + current Program revision
→ new ProgramAttempt uses current G+1 execution base
```

P does not compare back to immutable creation `Bplan` as a perpetual equality requirement.

Whether P needs semantic replanning depends on what changed and the final Program policy; freshness alone does not answer objective adequacy.

## 55. External edit while Program is parked

```text
P parked at last expected observation O0
→ external process changes Workspace
→ no Host operation advances G
→ P later resumes
→ Host re-observes O1 != O0
```

Required result:

- do not silently resume under old execution assumptions;
- current/previous attempt claim is stale;
- Host must rebase/replan/revalidate before successor execution.

## 56. Crash after mutation effect, before terminal append

```text
A0 requests M
→ operation.started canonical
→ M changes Workspace
→ Host crashes before operation.completed / generation advance
```

On restart:

- operation is `indeterminate` under ADR 0003;
- replay still shows old trusted `WorkspaceEffectGeneration`;
- current live observation may differ;
- Host must not simply increment G because files differ;
- Host must not simply adopt current observation and call the attempt fresh;
- reconciliation decides whether effect is confirmed/absent/remaining indeterminate.

If reconciliation confirms effect:

```text
advance effect lineage exactly once through reconciliation semantics
→ obtain fresh observation
→ establish a new trusted execution base before continuation
```

If unresolved:

```text
no successor dependent execution/completion
```

## 57. Failed command with partial side effect

```text
shell command changes file A
→ later subcommand fails
→ process exits non-zero
```

ADR 0003 says failure does not prove absence of effect.

Required result:

```text
effect indeterminate unless tool-specific evidence resolves it
→ no trusted execution-base advance
→ reconciliation required
```

## 58. Duplicate watcher events for one Host mutation

```text
Host operation M confirmed once
→ filesystem watcher emits multiple events
```

Required result:

- `WorkspaceEffectGeneration` advances once because canonical operation/effect identity says one confirmed effect transition;
- watcher duplicates may invalidate observation caches but do not mint extra canonical effect generations.

## 59. Missed watcher event for external edit

```text
external edit occurs
→ watcher misses/coalesces event
→ later freshness-sensitive direct observation detects mismatch
```

Required result:

- mismatch still fails closed;
- watcher silence was never authority.

If the selected direct observation itself does not cover the changed state, the contract must admit that limitation or expand the observation model. It cannot claim detection it cannot prove.

## 60. External edit between pre-operation check and system call

```text
Host observes expected O0
→ external writer changes file
→ mutating capability starts milliseconds later
```

This race is possible in a shared live Workspace.

The hybrid design does not claim otherwise.

Later observation/verification may detect resulting divergence, but **pre-operation equality is not filesystem isolation**.

If the required correctness property is to exclude this race entirely, Alternative D or equivalent stronger Workspace provider semantics are necessary.

## 61. External edit during successful shell mutation

```text
A0 starts shell mutation M
→ external editor also writes during M
→ M exits successfully
→ Host observes O1
```

The Host knows M reported a confirmed effect under current operation semantics. It does not generally know that every O0→O1 byte difference was caused solely by M.

Required Phase 1 interpretation:

- advance Host effect lineage for M exactly once if its effect status is confirmed;
- O1 is the new Host-observed post-effect state;
- do not claim exclusive byte-level causation;
- later verification must validate the actual current subject state;
- watcher/conflict signals may cause a stricter fail-closed classification if the final capability policy can identify a conflicting external write;
- continuous sole-causation requires stronger isolation.

## 62. External edit immediately after terminal observation

```text
M completes
→ Host observes O1
→ canonical terminal/effect-generation transition commits
→ external editor writes O2 immediately afterward
```

The canonical record remains truthful:

```text
Host observed O1 at that cut
```

It does not claim O1 remained current forever.

At the next freshness-sensitive boundary, direct re-observation detects O2 if covered by the observation model and fails closed/rebases accordingly.

## 63. Successor attempt after legitimate mutation

```text
A0 produced confirmed mutation
→ G0→G1, O1 current
→ A0 ends
→ scheduler selects next ready work
→ successor A1 dispatches
```

Required base:

```text
A1 starts from current (G1,O1-or-fresh-equivalent)
```

Not:

```text
O == creation-time Bplan
```

## 64. Superseded attempt returns late after newer effect generation

```text
A0 superseded
→ A1 becomes current at later execution base
→ late A0 operation/result arrives
```

Required result:

- late A0 result cannot become current Program evidence merely because its observation matches some current files;
- exact immutable operation→attempt ownership exposes the stale source;
- any real external effect that occurred remains a durable operation fact and may still influence Workspace causal/reconciliation state;
- stale Program authority and real external effect are separate concepts.

## 65. Verification after disjoint confirmed mutation

```text
obligation V satisfied at subjectGeneration 4
→ Host mutation M confirmed
→ WorkspaceEffectGeneration 9→10
→ M proven disjoint from V's subject
```

Required result:

- execution base advances to generation 10;
- V may remain satisfied at subjectGeneration 4 if disjointness is deterministically established;
- no global "all verification stale because Workspace generation changed" rule.

## 66. Verification after unknown-impact mutation

```text
Workspace effect confirmed
→ impact on V cannot be proved disjoint
```

Required result:

- Workspace effect lineage advances;
- V's `subjectGeneration` advances / prior satisfaction invalidates under fail-closed verification policy.

## 67. Completion races unexpected drift

```text
Completion Oracle preliminary evaluation says complete
→ external edit occurs
→ terminal admission later executes
```

If the final completion contract requires a Workspace freshness observation at terminal cut, the terminal admission must revalidate it there; a stale earlier snapshot cannot authorize `program.completed`.

Even then, an external write can occur after the terminal observation/commit unless stronger isolation is used. Program completion therefore certifies the Host's terminal canonical predicates and observation at the cut, not eternal filesystem immutability after completion.

## 68. Host restart with no uncertain operation but changed live Workspace

```text
last canonical trusted base = (G,O0)
→ Host shuts down cleanly
→ human edits repository while Host is offline
→ Host restarts
```

Required result:

```text
replay G
→ fresh observation O1
→ O1 != O0
→ parked/current Program execution assumptions are stale
→ no silent continuation under old base
```

No watcher history during downtime is required to detect the mismatch if the direct observation model covers the change.

---

# Part IX — Preferred semantic model

## 69. WorkspaceEffectGeneration

Illustrative semantic definition:

```ts
type WorkspaceEffectGeneration = number;
```

Required properties:

1. Workspace-scoped within one canonical admission domain;
2. monotonic;
3. replayable from canonical events;
4. advances exactly once for each qualifying Host-known confirmed mutating effect;
5. does not advance for reads;
6. does not advance for proven effect-absent outcomes;
7. does not silently advance across indeterminate effects;
8. external drift does not masquerade as a Host effect-generation transition.

The exact initial value and event representation are implementation details.

## 70. ExecutionObservationIdentity

Illustrative opaque shape:

```ts
interface ExecutionObservationIdentity {
  kind: string;
  value: string;
}
```

The actual model may be richer. The architectural requirement is a bounded Host-observed identity with deterministic equality/equivalence semantics appropriate to the Workspace provider.

Potential sources may include:

- Git HEAD/index/worktree information;
- bounded filesystem digests;
- CodeIntelligence revision observations;
- remote-workspace provider revision IDs;
- provider-specific snapshot IDs.

No single source is promoted by this study.

## 71. ProgramAttemptExecutionBase

Illustrative shape:

```ts
interface ProgramAttemptExecutionBase {
  workspaceEffectGeneration: WorkspaceEffectGeneration;
  observation: ExecutionObservationIdentity;
}
```

The Host owns it.

The Agent receives a projection sufficient to know the attempt/currentness context but cannot assert or advance the base.

## 72. Attempt expected-base projection

The Host derives a current expected base for the active attempt from:

```text
program.attempt.started(initial base)
+ exact correlated confirmed effect transitions
+ any explicit stale/drift/reconciliation transitions
```

It is rebuildable.

The Agent does not mutate this projection directly.

## 73. Operation ownership

The open-decisions study's root ownership recommendation composes naturally:

```text
operation.requested
  owns operationId
  declares ProgramStateId / ProgramAttemptId ownership as selected by final contract
  is admitted only against exact current attempt/revision/base
```

Later operation/evidence facts derive ownership from immutable `operationId` rather than repeating mutable claims everywhere.

A generation/base field may be copied into diagnostic/read-model projections, but canonical authority should have one clear owner.

## 74. Effect-lineage transition ownership

For a confirmed mutating operation, the Host should make the effect-generation transition part of the same serialized semantic cut that recognizes the qualifying terminal/reconciliation effect.

Conceptually:

```text
operation M effect becomes confirmed
+ old WorkspaceEffectGeneration = G
→ new generation = G+1
```

Retry of the same terminal/reconciliation transition must not increment twice.

`operationId` provides the natural exactly-once causal key.

## 75. Drift observation

When the Host observes unexplained divergence, the durable fact should mean only:

```text
Host observed that expected execution observation no longer matched at cut C
```

It should not claim which external actor changed the Workspace unless separately known.

That drift makes the current attempt non-current for dependent claims until a new/reconciled execution base is established.

## 76. Rebase/replan boundary

This study does not recommend silently updating a current attempt's expected observation after unexplained external drift.

Preferred first-slice behavior:

```text
unexpected drift
→ current ProgramAttempt loses freshness
→ no further dependent mutation/evidence/verification/completion under that attempt
→ Host/Application/Agent obtains current state
→ Program is revalidated/replanned as required
→ fresh ProgramAttemptId starts from a new current execution base
```

This preserves the meaning of ProgramAttempt as an execution claim instead of turning it into a mutable lease over arbitrary state changes.

## 77. Relationship to ProgramState revision

Unexpected Workspace drift does not automatically mean the ProgramState's semantic revision changed.

These are separate questions:

```text
Workspace execution assumptions stale?
```

and:

```text
canonical Program topology/objective/blockers/revision changed?
```

A replan may later create a new Program revision if canonical Program semantics change. The initial drift observation itself should not fabricate a Program revision transition merely to make counters match.

---

# Part X — Relationship to existing Phase 1 decisions

## 78. Program creation

Creation-time `PlanningObservationIdentity` proves what semantic planning depended on.

First ProgramAttempt dispatch performs the final creation-base recheck and establishes runtime `ProgramAttemptExecutionBase`.

After that handoff, runtime execution freshness owns the live progression.

## 79. Verification freshness

Execution generation and verification subject generation have different cardinalities:

```text
one Workspace effect
→ one WorkspaceEffectGeneration transition
→ zero, one, or many VerificationObligation subjectGeneration transitions
```

depending on deterministic impact analysis.

## 80. Agent work topology

Deferring automatic Agent post-creation topology mutation does not remove execution-freshness needs. The fixed initial DAG can span multiple attempts and legitimate mutations.

## 81. Structural bounds

The final Phase 1 contract must bound:

- `ExecutionObservationIdentity` serialized size;
- any persisted drift/effect receipts;
- replay/projection growth associated with generation transitions;
- any path/observation sets used for impact analysis.

Do not store an unbounded full filesystem manifest in every canonical event.

## 82. Operation correlation

Durable root operation ownership is essential to this study because stale Program authority and real external effect must remain separable.

A superseded attempt's operation may still have changed the Workspace. The Host must preserve that effect and update/reconcile Workspace state without granting the stale attempt current Program evidence authority.

## 83. Program cancellation

Cancellation cuts off Program authority; it does not roll back external effects.

A mutating operation that crosses cancellation can still become:

- confirmed effect;
- absent effect;
- indeterminate effect.

Workspace effect lineage/reconciliation therefore continues to process real operation facts after Program cancellation, while late results cannot become current Program evidence.

## 84. Scheduler concurrency

Per-Workspace single active ProgramAttempt simplifies execution freshness, but it is not enough by itself.

Foreground/non-Program Host-mediated mutators must participate in the same environmental mutation coordination.

External writers remain outside Host scheduling.

## 85. Completion Oracle

The Completion Oracle consumes execution-freshness state as one predicate family, but does not own Workspace observation itself.

Completion requires:

- no unresolved current effect/drift barrier;
- current verification obligations;
- all ordinary Program completion invariants;
- terminal admission linearization.

---

# Part XI — Acceptance-proof consequences

## 86. Existing AC families can absorb the execution-freshness decision

No new AC family appears necessary if the final Phase 1 plan is consolidated carefully.

### AC-10-04 — state-indexed attempt validity

Add proofs that:

- each ProgramAttempt is bound to one initial execution base;
- current expected base advances only through Host-owned correlated effect transitions;
- unexplained drift makes the attempt stale for dependent claims;
- stale attempt results cannot regain authority merely because current files later look similar.

### AC-10-05 — scheduler / dispatch

Add proofs that:

- first dispatch bridges from accepted `Bplan`;
- successor dispatch uses latest execution-aware base;
- creation-time `Bplan` is never a perpetual successor-dispatch equality requirement;
- Host-mediated foreground mutators cannot cross protected ProgramAttempt mutation lifetime;
- restart/resume re-observes live Workspace before dispatch.

### AC-10-06 — operation correlation / uncertainty

Add proofs that:

- confirmed mutating effect advances Workspace effect lineage exactly once;
- effect-absent does not advance it;
- indeterminate effect blocks trusted base advancement;
- reconciliation resolves lineage exactly once when effect becomes confirmed/absent;
- stale attempt ownership does not erase a real external effect.

### AC-10-07 — verification freshness

Add proofs that:

- Workspace effect generation and obligation `subjectGeneration` are distinct;
- one global Workspace effect may leave known-disjoint verification current;
- unknown impact invalidates obligation satisfaction;
- execution drift blocks unsafe verification admission until current state is re-established.

### AC-10-08 — completion

Add terminal-race proof:

```text
preliminary completion true
→ Workspace drift/effect uncertainty appears before terminal cut
→ terminal revalidation rejects completion
```

### AC-10-09 — recovery

Add proof:

```text
Host restart
→ replay causal effect generation
→ reconcile interrupted mutations
→ re-observe live Workspace
→ mismatch/unknown prevents silent resume
```

## 87. Required negative proofs if promoted

```text
ProgramAttempt A at (G,O)
→ external edit observed with no correlated Host effect transition
→ A cannot continue dependent mutation/evidence/verification/completion
```

```text
ProgramAttempt A legitimately mutates Workspace
→ effect confirmed
→ G advances exactly once
→ A may continue from new expected base
→ A is not self-invalidated merely because O changed
```

```text
operation.started
→ Host crash after possible external effect
→ no terminal effect fact
→ restart does not fabricate G+1
→ operation remains indeterminate until reconciliation
```

```text
reconciliation proves effect absent
→ G unchanged
```

```text
reconciliation proves effect confirmed
→ G advances exactly once
```

```text
same operation terminal/reconciliation retried
→ no duplicate generation advance
```

```text
watcher emits duplicate events
→ no duplicate canonical effect generations
```

```text
watcher emits no event
→ direct boundary observation can still detect covered drift
→ watcher silence is never canonical proof
```

```text
foreground Host mutator requests execution while ProgramAttempt owns protected mutation lifetime
→ mutator cannot cross that lifetime
```

```text
external editor changes Workspace while Host is offline
→ restart re-observation differs
→ old attempt/base is not silently resumed
```

```text
confirmed disjoint mutation
→ WorkspaceEffectGeneration advances
→ unrelated verification obligation may remain satisfied
```

```text
unknown-impact mutation
→ WorkspaceEffectGeneration advances
→ affected/unknown verification obligations invalidate fail-closed
```

```text
first ProgramAttempt mutates Workspace legitimately
→ successor dispatch does not compare live Workspace to creation-time Bplan
```

```text
late superseded-attempt operation effect is real
→ Workspace effect is preserved/reconciled
→ stale attempt evidence does not become current Program evidence
```

---

# Part XII — Comparison

## 88. Comparison matrix

| Alternative | Causal authority | Detects external drift | Legitimate mutation continuity | Crash/replay | Preserves indeterminate effects | Continuous isolation | Result |
|---|---|---|---|---|---|---|---|
| A. Boundary re-observation only | weak | yes, at covered cuts | ambiguous | weak unless separately persisted | weak | no | reject alone |
| B. Canonical Workspace generation only | strong for Host effects | no | strong | strong | only if composed with operation model | no | partial |
| C. Attempt observation token only | weak/observational | yes, at cuts | possible but causally ambiguous | weak | weak | no | reject alone |
| D. Filesystem/repository isolation | strong | external live drift irrelevant to isolated attempt | strong | provider-dependent | strong if integrated | **yes** | defer / future strongest |
| E. Watcher/token as authority | weak | best-effort | ambiguous | weak | weak | no | reject as authority |
| F. Hybrid effect lineage + observation + fail-closed cuts | **strong Host causation + explicit observation** | **yes at defined covered cuts** | **strong** | **strong causal replay + re-observation** | **strong** | no | **prefer** |

---

# Part XIII — Recommendation

## 89. Recommended first-slice contract

**Recommend Alternative F: a hybrid two-axis execution-freshness model composed with Host-mediated mutation exclusion and operation uncertainty.**

Use:

```text
WorkspaceEffectGeneration
```

for durable/replayable **Host-known confirmed mutation lineage**, and:

```text
ExecutionObservationIdentity
```

for bounded Host observation of the live Workspace at freshness-sensitive cuts.

Bind each ProgramAttempt to an initial:

```text
ProgramAttemptExecutionBase = (WorkspaceEffectGeneration, ExecutionObservationIdentity)
```

and derive its current expected execution base through exact correlated confirmed effects.

The key transition rules are:

```text
read-only / effect absent
→ no WorkspaceEffectGeneration advance
```

```text
confirmed Host mutating effect
→ WorkspaceEffectGeneration advances exactly once
→ capture/accept new post-effect observation
→ current attempt expected base advances
```

```text
indeterminate effect
→ no trusted base advancement
→ reconciliation barrier
```

```text
unexpected observed divergence with no corresponding admitted effect transition
→ out-of-band drift
→ current ProgramAttempt loses freshness for dependent canonical claims
→ no silent baseline update
```

```text
successor ProgramAttempt
→ starts from latest execution-aware current base
→ never requires equality to immutable creation-time Bplan
```

## 90. Why this wins

It is the smallest design found that simultaneously preserves:

- Host canonical ownership;
- legitimate in-attempt mutation continuity;
- durable operation/effect causation;
- crash/replay correctness;
- external-drift detection at defined cuts;
- fail-closed uncertainty;
- successor-dispatch semantics;
- separation from verification freshness;
- compatibility with future stronger Workspace isolation.

A single generation loses observation truth. A single observation token loses causation. A watcher loses authority/replay. Full isolation is stronger but materially larger than the current first-slice architecture.

## 91. Residual limitation is intentional and must be explicit

The recommended model **does not** guarantee that an arbitrary external writer cannot modify the live Workspace between checks or during a shell/tool mutation.

The contract must not use phrases such as:

```text
Workspace unchanged throughout ProgramAttempt
```

unless stronger isolation is later selected.

The honest first-slice statement is:

> **Execution freshness is checked and fail-closed at defined Host boundaries, Host-mediated mutating execution is serialized/excluded through the Workspace mutation coordinator, and canonical Host-effect lineage is replayable. External/non-Host writers remain outside that exclusion; their covered changes are detected by re-observation at later boundaries, not prevented transactionally.**

## 92. Confidence

**High** confidence in the architectural separation:

```text
causal Host effect lineage
!=
live Workspace observation
!=
verification subject generation
```

**Medium-high** confidence that the hybrid is the correct Phase 1 first-slice tradeoff if boundary-checked freshness is the intended guarantee.

**Low-to-medium** confidence in the exact `ExecutionObservationIdentity` representation until the planning-observation and Workspace-provider semantics are selected/measured.

If Phase 1 instead requires continuous sole-writer / snapshot-consistent execution against arbitrary external editors, this recommendation is falsified and stronger isolation becomes mandatory.

---

# Part XIV — Remaining freeze-readiness dependencies

## 93. Exact ExecutionObservationIdentity semantics

The final contract must choose:

- representation;
- covered Workspace state;
- bounds;
- equality/equivalence rules;
- Git dirty/untracked/ignored-file semantics;
- directory/absence semantics where needed;
- remote Workspace/provider semantics;
- restart re-observation behavior;
- handling when complete observation cannot be obtained.

Unknown equivalence must fail closed at a correctness-sensitive cut.

## 94. Exact Host-mediated Workspace mutation barrier

The final contract must define:

- owner;
- acquisition order relative to canonical admission;
- which capabilities count as mutating;
- read-only concurrency;
- foreground/non-Program mutation behavior;
- ProgramAttempt lifetime transfer/release;
- cancellation and timeout;
- Host crash;
- reconciliation interaction;
- deadlock/queueing policy.

Canonical admission alone is not this barrier.

## 95. Exact effect-generation event ownership

The final contract must define how one confirmed effect advances `WorkspaceEffectGeneration` exactly once across:

- normal terminal success;
- terminal retry/idempotence;
- crash after effect before terminal record;
- reconciliation to confirmed;
- reconciliation to absent;
- stale/superseded ProgramAttempt ownership;
- Program cancellation.

`operationId` should be the natural causal idempotency key, but exact event/schema design remains open.

## 96. Drift lifecycle / rebase policy

The final contract must define the Host-owned state transition after unexpected drift:

- current attempt invalidation/supersession;
- whether ProgramState revision changes immediately or only if semantic replanning changes Program facts;
- Application/read-model surfacing;
- Agent replan/revalidation flow;
- when a fresh ProgramAttempt may be minted.

This study recommends **no silent in-attempt baseline replacement after unexplained drift**.

## 97. Capability observation contract

The final contract must define what a capability can report about:

- read observation identity;
- mutating affected paths where known;
- post-effect observations;
- effect certainty;
- reconciliation evidence.

Unknown affected paths may conservatively invalidate verification obligations without invalidating the entire causal effect lineage.

## 98. Closed verification-requirement taxonomy remains separate

This study does not close the verification predicate taxonomy required by Program creation. That remains a separate planning dependency.

## 99. Structural bounds still require empirical values

The architecture should bound execution-observation and drift/effect records, but exact ceilings still need corpus/measurement evidence rather than intuition.

## 100. Stronger isolation remains an explicit future branch

If boundary-checked freshness proves insufficient for product requirements, the next design family to study is not a more elaborate counter. It is an isolated/transactional Workspace provider:

```text
ProgramAttempt executes against isolated revision
→ Host knows exact base
→ external live Workspace edits cannot race it
→ explicit merge/commit/reconciliation boundary
```

That would be a larger architecture decision and should be studied as such.

---

# Part XV — Planning status

## 101. Status

This document remains a recommendation only.

It does not:

- amend `docs/phase-1.0-plan.md`;
- supersede `docs/phase-1.0-open-decisions-study.md`;
- supersede `docs/phase-1.0-program-creation-authorship-study.md`;
- consolidate `docs/phase-1.0-artifact-evidence-amendment.md`;
- approve or freeze Phase 1.0;
- authorize implementation.

If accepted, its conclusions belong only in a later explicitly authorized Phase 1.0 consolidation decision.
