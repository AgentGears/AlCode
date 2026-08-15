# ALCODE Phase 1.0 — Workspace Execution Base & Mutation Coordination Study

**Status:** DRAFT / non-normative planning study  
**Approval:** not approved; not frozen; implementation not authorized  
**Repository base studied:** `main` at `7bcf1aec225761614d91b5df949bb6a013fc4c4f`  
**Relationship to Phase 1.0:** closes the execution-contract dependencies deliberately left open by `docs/phase-1.0-execution-freshness-study.md`. It does not amend `docs/phase-1.0-plan.md`, change AC-10 acceptance criteria, approve/freeze Phase 1.0, or authorize implementation.

## 1. Decision question

The execution-freshness study selected a two-axis runtime model:

```text
WorkspaceEffectGeneration
  durable/replayable Host-known Workspace-effect lineage

+

ExecutionObservationIdentity
  bounded Host observation of current Workspace state

=

ProgramAttemptExecutionBase
```

That architecture is not freeze-ready until the transition protocol is defined.

This study asks:

> **What exact Phase 1 protocol lets the Host establish, preserve, advance, invalidate, recover, and re-authorize a trusted `ProgramAttemptExecutionBase` around real capability execution, while preserving operation uncertainty, excluding competing Host-mediated mutators, detecting covered external drift at defined cuts, and remaining honest about races a shared live worktree cannot prevent?**

The answer must jointly close five coupled questions:

1. what `ExecutionObservationIdentity` means and when two observations are equal;
2. what Host-mediated mutation coordination owns and for how long;
3. exactly how `WorkspaceEffectGeneration` advances without creating duplicate operation authority;
4. what happens after unexplained Workspace drift;
5. what capability metadata/observations may be used for execution and verification impact.

Treating those as unrelated fields would leave gaps between them. This study therefore evaluates complete transition protocols.

---

# Part I — Sources and repository facts

## 2. Governing planning state

`docs/phase-1.0-plan.md` remains a draft. Relevant proposed invariants include:

- Host ownership of ProgramState;
- exact Program revision and ProgramAttempt validity;
- uncertainty preservation;
- durable ProgramAttempt→operation correlation;
- current-state-indexed verification;
- serialized exact-once completion;
- rebuildable projections;
- observation is evidence, not authority.

The plan still contains older provisional wording such as globally single-attempt scheduling and the four-kind `CompletionCriterion` union. Later non-normative studies recommend changes, but no study is itself the governing contract.

## 3. Program-creation handoff is intentionally finite

`docs/phase-1.0-program-creation-authorship-study.md` makes creation-time `PlanningObservationIdentity` / `Bplan` a creation-to-first-execution bridge only.

For first ProgramAttempt dispatch:

```text
acquire Host-mediated mutation exclusion
→ wait/fail closed on Host mutator uncertainty
→ recheck accepted Bplan
→ mismatch/unknown => no dispatch
→ establish first runtime execution base
→ admit first ProgramAttempt
```

After legitimate Program execution changes the Workspace, successor attempts must use current execution-aware state rather than comparing back to immutable creation-time `Bplan`.

## 4. Current Workspace lock is not repository isolation

`packages/workspace/src/lock.ts` owns the ALCODE Workspace process/store. It prevents another cooperating Host from opening the same durable Workspace concurrently when the platform lock primitive works.

It does not prevent:

- IDE writes;
- shell writes outside ALCODE;
- editor save operations;
- arbitrary non-ALCODE processes;
- another process that ignores ALCODE's lock from changing repository files.

Therefore:

```text
Workspace lock
!=
repository filesystem lock
!=
snapshot isolation
```

## 5. CanonicalAdmissionQueue is a semantic linearization point only

Current `CanonicalAdmissionQueue` serializes canonical event-store append work.

It is appropriate for:

- exact Program/Attempt currentness checks;
- atomic canonical event batches;
- stale/duplicate rejection;
- terminal Program decisions;
- operation ownership admission.

It must not be held across arbitrary environmental tool execution. A promise-chain append lane cannot act as a filesystem transaction.

## 6. Capability execution crosses the canonical boundary

Current `packages/host-runtime/src/capability-broker.ts` roughly performs:

```text
policy / approval / verification planning
→ mint operationId
→ canonical operation.requested + operation.started + action.recorded
→ release canonical admission
→ capability.execute(...)
→ evaluate result
→ canonical operation.completed + evidence.recorded + optional reasoning correlation
```

A capability may therefore be mutating the Workspace while no canonical admission critical section is held.

Any Phase 1 design that treats event append order as environmental exclusion is incorrect.

## 7. Operation effect semantics are already the causal authority

`packages/storage/src/operations.ts`, ADR 0003, and `docs/operation-recovery.md` distinguish:

```text
ExecutionOutcome
EffectStatus
ReconciliationStatus
```

For current semantics:

- read-only → `not_applicable`;
- succeeded mutator → normally `confirmed`;
- failed/cancelled/timed_out mutator → `indeterminate` unless stronger evidence exists;
- crash-surviving requested/started operations become explicit indeterminate/pending state;
- indeterminate environmental mutation is not auto-retried.

`operationId` is the stable durable identity of the external operation/effect.

A Workspace effect-lineage mechanism should therefore consume operation-effect truth, not create a second independent effect authority.

## 8. Current startup recovery surfaces uncertainty but does not yet impose this barrier

Current Host startup recovers interrupted operations and returns/surfaces pending uncertainty. The existing runtime does not generally prohibit all ordinary capability execution while any pending operation remains unresolved.

The stronger Phase 1 rule in this study is new:

> **Program execution-base admission and Host-mediated Workspace mutation admission fail closed while unresolved Workspace-affecting operation uncertainty can make the Workspace base unsafe.**

This must be implemented deliberately; it is not already present merely because operation recovery exists.

## 9. CodeIntelligence is useful observation precedent, not execution authority

`packages/code-intelligence/src/tracker.ts` currently provides an in-memory `CodeRevisionToken` with:

```text
epoch + generation + fingerprint
```

The tracker:

- computes a bounded baseline fingerprint;
- increments a generation from watcher events / explicit Host notifications;
- can become `UNCERTAIN`;
- rebaselines with a new random epoch;
- intentionally ignores `.git`, `node_modules`, `.alcode`, `dist`, and `coverage` by default.

Important limitations for Program execution authority:

- watcher events are observations, not canonical cause;
- the epoch is process/rebaseline-local;
- the fingerprint is a baseline component, not a continuously recomputed full-state digest after each change;
- the default ignored surface is tailored to CodeIntelligence/cache coherence, not a frozen Program execution contract;
- the token does not identify `operationId` or `ProgramAttemptId` causation.

`packages/code-intelligence/src/service.ts` does provide an important pattern:

```text
observe before
→ perform query
→ observe after
→ downgrade currentness if the observation changed
```

There is no automatic query retry.

## 10. Current HostCapability metadata is insufficient for exact Workspace impact

Current `HostCapability` exposes `isReadOnly?: boolean`, but it does not provide a distinct Host-owned Workspace-access classification or a complete affected-path contract.

Those concepts must remain distinct:

```text
operation has any external effect?
!=
operation may write the Workspace?
!=
which Workspace paths were affected?
!=
which verification obligations are impacted?
```

A network-writing capability could be externally mutating without changing the Workspace. Conversely an arbitrary shell capability may write any Workspace path even when a particular invocation happens not to.

## 11. Current operation terminal facts can represent confirmed/absent/indeterminate

`OperationCompletedPayload` supports optional `toolDeclaredEffect`, and the projection computes `EffectStatus` and reconciliation status deterministically.

The repository therefore already has the correct conceptual place for effect certainty. Phase 1 should extend reconciliation/event coverage as necessary, not add a competing Workspace-effect verdict.

---

# Part II — Required correctness properties

## 12. One authority per fact

The protocol must keep these separate:

```text
operationId
  authority for one external operation/effect history

WorkspaceEffectGeneration
  derived replayable ordinal of confirmed Host-known Workspace-mutating effects

ExecutionObservationIdentity
  Host observation of a defined Workspace semantic surface

ProgramAttemptId
  authority claim for one Program execution attempt

ProgramState revision
  Program semantic/control-state currency

verification subjectGeneration
  obligation-specific verification currency
```

No counter may silently stand in for another.

## 13. A trusted execution base requires both causal and observed state

```text
ProgramAttemptExecutionBase = (G, O)
```

where:

- `G` is current `WorkspaceEffectGeneration`;
- `O` is a complete current `ExecutionObservationIdentity` under the selected observation profile.

A missing/unknown/incomplete observation cannot be used as a trusted base.

## 14. Unknown is not unequal and not equal

Observation results have three semantic outcomes:

```text
complete + equal
complete + different
unknown/incomplete
```

Unknown/incomplete fails closed at correctness-sensitive cuts. It must not be coerced into either equality or drift attribution.

## 15. External writers remain outside Host exclusion

The first slice may prove:

- no competing **Host-mediated Workspace mutator** crosses the protected Program execution lifetime;
- current covered Workspace state was directly observed at defined cuts;
- unexplained covered mismatch fails closed;
- Host-known effect causation is replayable.

It cannot prove on a shared worktree:

- no external writer raced after the observation;
- no external writer raced during arbitrary tool execution;
- no external ABA mutation occurred between two equal observations;
- every byte difference after a broad shell command was caused only by that command.

Those stronger claims require isolation or a trustworthy provider-level monotonic revision with matching semantics.

## 16. Program-owned legitimate mutation must not self-invalidate

A current ProgramAttempt may perform several mutations.

A confirmed current-attempt Workspace mutation advances the attempt's expected base instead of invalidating the same attempt merely because the Workspace changed.

## 17. Unexplained drift must not be silently absorbed outside a Host mutator window

If the Host observes a different complete state at a checked cut and no current canonical operation transition accounts for entering a post-effect state:

```text
unexpected drift
→ current attempt loses authority for dependent claims
```

The old attempt does not regain authority if bytes later happen to return to an older digest.

## 18. Indeterminate mutation invalidates continuation of the same attempt

This study strengthens the prior freshness recommendation:

> **Once a current ProgramAttempt has a Workspace-affecting operation whose effect becomes indeterminate, that ProgramAttempt is no longer eligible to continue execution, verification admission, or completion.**

Reason:

- there is no trusted next execution base;
- continuing the same attempt would turn an uncertain mutation history into a mutable lease;
- fresh ProgramAttempt IDs are cheap and already required after interruption/recovery.

Reconciliation can make future continuation safe, but continuation occurs under a fresh attempt after the required rebase/currentness path.

## 19. A confirmed effect without a complete post-effect observation also cannot continue the same attempt

The effect lineage may be known while the live Workspace observation is unknown.

```text
confirmed effect
→ G advances
→ post-observation unknown
→ no trusted (G,O1)
→ current attempt interrupted/stale for dependent claims
```

Causation is not discarded, but execution waits for a new complete accepted base.

---

# Part III — ExecutionObservationIdentity alternatives

## 20. Alternative O-A — reuse CodeRevisionToken as Program authority

**Model:** ProgramAttempt stores the current CodeIntelligence `epoch/generation/fingerprint` token.

**Reject.**

Reasons:

- in-memory/rebaseline lifecycle differs from canonical replay;
- watcher continuity is not proof;
- default ignore policy is not an execution contract;
- generation cannot be reconstructed solely from canonical Program history;
- current fingerprint semantics are not a direct full-state digest after every observed change;
- causation remains absent.

Useful only as an early-warning/optimization signal.

## 21. Alternative O-B — Git HEAD/status identity only

**Model:** use HEAD OID plus dirty/clean status.

**Reject alone.**

It is too coarse. A status bit does not bind exact dirty contents, untracked contents, symlink target, index conflict state, or other state needed to compare exact observations.

## 22. Alternative O-C — entire filesystem Merkle/digest with no exclusions

**Model:** recursively hash every entry and every byte under Workspace root.

**Correct in coverage when it completes, but unsuitable as the mandatory Phase 1 profile by itself.**

Problems:

- ordinary repositories may contain huge dependency/cache/generated trees;
- special files and changing trees need explicit semantics;
- observation can become unbounded or prohibitively expensive;
- `.git` internals contain large/volatile implementation state not all of which belongs in a current-checkout execution contract.

The lesson is to define the semantic surface explicitly, not to hash indiscriminately.

## 23. Alternative O-D — per-read dependency receipts only

**Model:** track only files/queries the Agent read.

**Reject as the general runtime execution base.**

This is attractive for planning but incomplete for arbitrary mutation and future reads. A shell command can depend on directory membership, absence, Git state, generated inputs, or files never previously read through a tracked API.

Dependency receipts remain useful for planning and verification scope, not as the sole attempt-wide base.

## 24. Alternative O-E — versioned complete Workspace observation profile

**Model:** the Host/Workspace provider defines a closed versioned semantic surface, produces a bounded complete identity for that surface, and returns `unknown` rather than a partial identity when it cannot satisfy the profile.

**Preferred.**

This separates:

```text
what the profile promises to observe
```

from:

```text
how efficiently the provider computes it
```

A future isolated/remote provider can implement the same semantic contract with a native revision identifier.

## 25. Alternative O-F — immutable/isolated Workspace snapshot

**Model:** each attempt executes against a provider snapshot/worktree inaccessible to external writers.

**Strongest, deferred.**

This would close continuous non-interference and attribution problems, but the governing Phase 1 exclusions currently reject worktree isolation/remote Workspace expansion. It is the successor branch if boundary-checked shared-worktree semantics prove insufficient.

---

# Part IV — Selected observation contract

## 26. Recommendation: versioned complete observation profile

Use a semantic shape equivalent to:

```ts
type ExecutionObservationResult =
  | {
      status: "complete";
      identity: ExecutionObservationIdentity;
      observedAt: string;
      changedPaths?: readonly string[];
    }
  | {
      status: "unknown";
      reason: string;
    };

interface ExecutionObservationIdentity {
  kind: "workspace-observation-v1";
  providerKind: string;
  workspaceIdentity: string;
  coverageDigest: string;
  stateDigest: string;
}
```

Exact TypeScript spelling is not normative. Semantic fields are.

## 27. `coverageDigest` and `stateDigest` have different meanings

`coverageDigest` binds:

- observation profile/version;
- Workspace/provider identity;
- root identity;
- included semantic surfaces;
- exclusions;
- path normalization rules;
- symlink/submodule handling mode;
- Git/control-state components where applicable;
- any provider configuration that changes what `stateDigest` covers.

`stateDigest` binds the observed value of that covered state.

Therefore exact Phase 1 equality is:

```text
same kind
AND same provider/workspace identity
AND same coverageDigest
AND same stateDigest
```

Different profile/coverage is **not equivalent** in Phase 1. Treat it as unknown for a cut that requires exact currentness.

This avoids a second extensible semantic-equivalence engine in the first slice.

## 28. Local Git Workspace profile

For a local Git-backed coding Workspace, `workspace-observation-v1` should cover the semantic current-checkout surface rather than raw `.git` storage internals.

At minimum the complete identity covers, under aggregate bounds:

1. current HEAD symbolic/detached state and target object ID;
2. index semantic entries, including path, mode, object identity, and conflict stage where present;
3. tracked working-tree entries: path, type, executable/mode semantics, symlink link text, size where useful, and content identity;
4. untracked **non-ignored** working-tree entries with the same bounded path/type/content semantics;
5. effective repository ignore-policy inputs used to decide that untracked coverage, including repository-local exclude inputs and any provider-resolved external exclude source that changes classification;
6. repository control state that materially changes current-checkout operation semantics, such as in-progress merge/rebase/cherry-pick/revert/sequencer/bisect state and sparse-checkout/worktree visibility configuration;
7. submodule/gitlink state only when the provider can represent it completely under the same bounded contract; otherwise the observation is unknown for a Workspace requiring that state.

Raw object databases, reflogs, packfiles, hooks caches, and unrelated refs are not hashed merely because they live under `.git`.

This is a **current-checkout execution surface**, not every possible Git input to every arbitrary command.

## 29. Ignored content is outside the local Git observation surface

Ignored working-tree content such as dependency/build caches can be extremely large. Phase 1 does not pretend to observe all such bytes merely to claim stronger guarantees.

Consequences:

- changes solely inside ignored content may not alter `ExecutionObservationIdentity`;
- the guarantee is explicitly scoped to the selected Workspace semantic surface;
- a capability whose correctness depends on excluded content needs its own capability/evidence provenance or a stronger observation/isolation profile;
- a Host-known operation that may write excluded content still participates in mutation coordination and causal effect semantics if classified as Workspace-mutating.

This is preferable to silently using CodeIntelligence's ignore list as if it were complete Program authority.

## 30. Symlink semantics

The observation hashes the symlink entry and link text without recursively treating an arbitrary outside-root target as Workspace state.

A capability that follows a symlink outside the observed root can therefore have effects outside observation coverage. Its Workspace impact becomes unknown unless a stronger capability/provider contract proves otherwise.

## 31. Submodules

A gitlink OID alone does not describe a dirty checked-out submodule worktree.

A provider may recursively observe submodules under aggregate bounds. If it cannot provide complete selected semantics, a correctness-sensitive observation that depends on that Workspace state returns `unknown`.

## 32. Non-Git local Workspace profile

If Phase 1 continues to support a non-Git local Workspace, use the same identity shape with a bounded canonical tree profile over the provider-declared Workspace surface.

It records path/type/mode/symlink/content identity and a fixed provider exclusion contract. Bounds or unsupported entries yield `unknown`.

No future remote backend is required by this study.

## 33. Observation bounds

The profile requires hard bounds for:

- entries enumerated;
- bytes hashed/read;
- maximum individual file treatment;
- path length;
- changed-path receipt count;
- serialized identity/receipt size;
- recursive submodule/provider nesting if supported;
- observation time/resource budget where deterministic failure semantics can be defined.

This study intentionally does **not** choose final numeric ceilings because structural-bound measurement remains a separate empirical Phase 1 dependency.

The semantic rule is fixed now:

```text
bound exceeded
→ observation unknown
→ no trusted execution-base admission at a cut requiring completeness
```

## 34. Observation race while scanning

The observer must not return a `complete` identity if it detects that its covered surface changed during construction.

Permitted implementations include:

- bounded before/after provider revision checks;
- stable file metadata/content read validation;
- retry/rebaseline within a fixed attempt limit;
- provider-native atomic snapshot/revision where available.

If stability cannot be established within bounds:

```text
unknown
```

Do not return a digest of a torn scan as complete.

## 35. Observation receipts are evidence, not filesystem authority

Canonical state may authoritatively record:

```text
Host observed identity O at semantic cut C
```

It does not make O eternal filesystem truth.

Persist the compact identity and bounded diagnostic/changed-path evidence needed by the consuming semantic transition. Do not persist a whole unbounded manifest merely to make the observation canonical.

Ephemeral provider manifests may be used to compute bounded changed-path sets.

---

# Part V — Mutation coordination alternatives

## 36. Alternative M-A — CanonicalAdmissionQueue only

**Reject.**

It serializes event append, not environmental execution.

## 37. Alternative M-B — short per-operation mutex only

**Model:** only individual mutating capability executions are mutually exclusive.

**Partial, not sufficient.**

It prevents two Host mutators from overlapping, but allows a foreground Host mutation between two capability calls of one active ProgramAttempt. That would change the attempt's assumptions without a Program-owned transition.

The system could invalidate the attempt afterward, but the prior creation/freshness studies already identified a simpler first-slice invariant: unrelated Host mutators do not cross an active ProgramAttempt mutation lifetime.

## 38. Alternative M-C — ProgramAttempt reservation + read/mutation leases

**Preferred.**

One Workspace-scoped Host subsystem coordinates environmental access:

- a long-lived ProgramAttempt mutation reservation;
- short read/observation leases;
- short exclusive mutation leases;
- reconciliation access for uncertain operations.

The reservation prevents unrelated Host Workspace mutators from crossing an active ProgramAttempt, while subleases control actual execution/observation cuts.

## 39. Alternative M-D — lock the repository against all writers

**Not available on the current architecture.**

The ALCODE Workspace lock does not force external editors/processes to participate. Calling an internal mutex a repository lock would be false.

## 40. Alternative M-E — isolated attempt worktree/snapshot

**Strongest, deferred.**

This is the path if Phase 1 later requires continuous external-writer exclusion.

---

# Part VI — Selected Host-mediated mutation protocol

## 41. WorkspaceMutationCoordinator

The preferred semantic subsystem is a Workspace-scoped Host `WorkspaceMutationCoordinator` or equivalent.

The name is illustrative. Required semantics are not.

It owns **Host-mediated environmental scheduling**, not canonical Program truth.

Canonical authority remains in the event log.

## 42. ProgramAttempt reservation lifetime

Before a ProgramAttempt is admitted, the scheduler obtains an exclusive **ProgramAttempt mutation reservation** for that Workspace.

The reservation is bound to the attempt being created and is retained until:

- the attempt reaches terminal/interrupted/superseded state;
- no in-flight Workspace-mutating operation owned by that attempt remains environmentally executing;
- any resulting effect uncertainty has been durably recorded;
- release does not create a gap in a semantic transition that explicitly transfers authority to another protected phase.

While the reservation is held:

- Program-owned mutators for that exact attempt may run through the reservation;
- unrelated foreground/non-Program Host Workspace mutators wait/reject as `workspace_busy` according to product policy;
- another ProgramAttempt cannot acquire a competing reservation;
- read-only Host operations may run only according to the read-lease rule below.

## 43. The reservation is not a durable lease

It has no timeout and no distributed ownership meaning.

If the Host process dies, the in-memory reservation disappears. Safety comes from durable facts:

- active/orphan ProgramAttempt state;
- operation requested/started/terminal state;
- indeterminate effect recovery;
- startup scheduler/mutation-admission barrier.

Do not persist a time-based lease and infer safety from expiry.

## 44. Read/observation lease

A Host read/observation lease prevents a Host Workspace mutator from entering its environmental mutation section while the checked read/observation executes.

It may coexist with a ProgramAttempt reservation when the read is allowed under that attempt.

A non-Program read may run while a ProgramAttempt reservation exists only if it is Host-classified Workspace-read-only and does not overlap an active mutation sublease. Such a read has no authority over the Program unless separately admitted as Program evidence.

## 45. Mutation sublease

A Workspace-mutating capability execution requires an exclusive mutation sublease.

For Program-owned execution it additionally requires exact ownership by the active ProgramAttempt reservation.

No unrelated Host mutator may overlap this environmental section.

External writers remain outside it.

## 46. Acquisition order

To avoid deadlock between environmental coordination and canonical admission, any code path requiring both follows one global order:

```text
Workspace coordinator reservation/lease
→ direct observation if required
→ CanonicalAdmissionQueue
```

Never wait for the Workspace coordinator while holding canonical admission.

No canonical admission critical section spans arbitrary capability execution.

## 47. ProgramAttempt start sequence

For the first attempt:

```text
acquire ProgramAttempt reservation
→ prove no blocking unresolved Workspace-effect uncertainty
→ creation-time Bplan bridge recheck
→ obtain complete current execution observation O0
→ read current WorkspaceEffectGeneration G0
→ canonical admission:
     revalidate Program/session/revision/currentness
     admit program.attempt.started with fresh ProgramAttemptId and base (G0,O0)
→ retain reservation for the active attempt
```

For a successor attempt:

```text
acquire ProgramAttempt reservation
→ prove no blocking uncertainty/drift authorization gap
→ obtain complete current observation Ocur
→ require exact equality to the Program's currently accepted execution observation
→ require current WorkspaceEffectGeneration matches the accepted current causal base
→ canonical attempt admission
→ retain reservation
```

A successor never compares back to creation-time `Bplan`.

## 48. Program read-only capability sequence

```text
active attempt reservation
→ acquire read lease
→ direct pre-observation Opre
→ require Opre == attempt expected observation
→ canonical admission:
     exact Program/Attempt/revision/base revalidation
     admit operation.requested + operation.started with root Program ownership
→ execute read outside canonical admission while read lease remains held
→ direct post-observation Opost
→ canonical terminal operation/evidence admission
→ Program evidence is current only if:
     operation ownership is current
     no supersession/cancel won
     observation remained complete/current for the selected cut
     required verification subjectGeneration still matches
→ release read lease
```

Generic operation/evidence history remains durable even if Program-specific current-evidence admission rejects it.

## 49. Program mutating capability sequence

```text
active attempt reservation
→ acquire mutation sublease
→ direct pre-observation Opre
→ require Opre == attempt expected observation
→ canonical admission:
     exact Program/Attempt/revision/base revalidation
     admit operation.requested + operation.started
→ execute mutation outside canonical admission while mutation sublease remains held
→ determine terminal ExecutionOutcome / EffectStatus
→ obtain complete post-observation if possible
→ canonical terminal cut:
     persist operation terminal/effect fact
     apply WorkspaceEffectGeneration derivation if effect newly confirmed
     admit Program base-advance / evidence / verification invalidations only when their predicates hold
→ release mutation sublease
```

If terminal persistence cannot be completed while the process remains alive, Host-mediated new mutation admission fails closed rather than releasing into ambiguous ordinary operation.

## 50. Completion/verification cut ordering

A correctness-sensitive verification-satisfaction or Program-completion decision obtains an observation/read lease **before** entering canonical admission.

Then:

```text
observe current Workspace
→ enter canonical admission
→ revalidate exact Program state + effect lineage + accepted observation + verification subject generations + no winning terminal conflict
→ append satisfaction/completion if still true
```

This prevents a competing **Host-mediated** mutator from crossing the checked cut.

An external process can still race after observation; the shared-worktree guarantee does not claim otherwise.

## 51. Reservation release after normal attempt termination

When an attempt reaches a normal terminal/interrupted state with no in-flight mutating operation and no unresolved uncertainty created by it, the Host releases the ProgramAttempt reservation.

The Program retains its last trusted accepted execution base for successor dispatch.

## 52. Cancellation and timeout

Cancellation cuts Program authority first: no new Program operations are admitted after the cancellation/interruption cut.

If a mutating operation is in flight:

- signal/cancel it according to capability semantics;
- retain environmental coordination until execution returns or the Host can durably classify the operation state;
- cancelled/timed-out mutators default to indeterminate effect;
- once indeterminate is canonical, the attempt is non-continuable and the Workspace uncertainty barrier remains even though the in-memory attempt reservation may be released.

Cancellation does not roll back effects.

## 53. Reconciliation lease

Reconciliation for an indeterminate Workspace-affecting operation obtains exclusive mutation/reconciliation access before inspecting or deliberately modifying Workspace state.

Ordinary ProgramAttempt start and ordinary Host Workspace mutators are blocked while unresolved uncertainty remains in the relevant Workspace domain.

Read-only diagnostic observations needed by reconciliation are allowed under reconciliation control.

---

# Part VII — WorkspaceEffectGeneration alternatives

## 54. Alternative G-A — separate authoritative `workspace.generation.advanced` command/event

**Reject as a second authority if it independently decides whether an effect happened.**

It risks disagreement:

```text
operation says indeterminate
but workspace event says advanced
```

or duplicate advancement on retry/reconciliation.

## 55. Alternative G-B — process-local counter

**Reject.**

It fails restart/replay.

## 56. Alternative G-C — derive generation from canonical operation effect transitions

**Preferred.**

Define:

> `WorkspaceEffectGeneration` is the replayable Workspace-scoped ordinal obtained by advancing once when a Host operation classified as potentially Workspace-mutating first reaches canonical `EffectStatus = confirmed`.

The operation domain remains the only effect-certainty authority.

## 57. Alternative G-D — advance whenever observed bytes differ

**Reject.**

An observed difference has no Host causal identity and may be external drift. It must not be rewritten as a Host-confirmed operation effect.

---

# Part VIII — Selected effect-generation contract

## 58. Workspace-effect classification is Host-owned

Phase 1 needs a Host-owned Workspace-access classification distinct from generic `isReadOnly`.

Semantic shape:

```ts
type WorkspaceAccessClass =
  | "none"
  | "read_only"
  | "may_write";
```

Exact API spelling is open.

Rules:

- missing/untrusted classification defaults conservatively to `may_write`;
- Agent output cannot downgrade `may_write` to read-only;
- dynamic capability metadata is accepted only through existing Host provider/policy trust boundaries;
- arbitrary shell execution is `may_write` unless a separate Host-owned capability contract proves otherwise.

## 59. Exact generation rule

For every canonical operation in Workspace event order:

```text
if WorkspaceAccessClass != may_write:
  no WorkspaceEffectGeneration change

if effect never reaches confirmed:
  no generation change

on first canonical transition for operationId into confirmed:
  G := G + 1 exactly once

later duplicate/replayed facts for the same confirmed transition:
  no additional change
```

This means a succeeded `may_write` operation can conservatively advance generation even when the final covered file digest happens to be unchanged. `G` is causal lineage, not content equality.

## 60. Normal terminal success

```text
operation.completed
outcome = succeeded
WorkspaceAccessClass = may_write
effectStatus = confirmed
```

advances generation once at that canonical position.

## 61. Effect absent

If Host/tool-specific semantics prove `EffectStatus = absent`:

```text
G unchanged
```

If post-observation nevertheless differs from the attempt expected observation, that difference is drift, not a Host effect transition.

## 62. Indeterminate

```text
effectStatus = indeterminate
→ G unchanged for now
→ uncertainty barrier
→ current ProgramAttempt non-continuable
```

Do not infer confirmed effect from a changed snapshot alone.

## 63. Reconciliation to confirmed

The operation domain needs a canonical reconciliation result if current implementation does not yet persist the final resolution.

Semantic result:

```text
operationId O
indeterminate/pending
→ canonical reconciliation evidence/admission
→ effectStatus confirmed, reconciliation resolved
```

At the first such confirmed transition:

```text
G := G + 1
```

exactly once.

## 64. Reconciliation to absent

```text
effectStatus absent
reconciliation resolved
→ G unchanged
```

## 65. Reconciliation unresolved

```text
effectStatus indeterminate
reconciliation unresolved
→ G unchanged
→ Workspace remains blocked for dependent Program execution
```

User policy may later authorize some separate recovery path, but uncertainty must not be relabeled absent/confirmed without an explicit canonical decision supported by the allowed reconciliation contract.

## 66. Projection model

The preferred design does not require a new independent Workspace-effect verdict event.

A Workspace execution projection can derive and persist for efficient reads:

- current `WorkspaceEffectGeneration`;
- which `operationId` first consumed each generation;
- unresolved Workspace-affecting uncertainty set.

Delete/rebuild from canonical operation/reconciliation events must produce the same generation sequence.

## 67. Program expected-base advancement after a normal confirmed current-attempt effect

The operation fact proves the effect; a Program-local base-advance fact proves how the current attempt adopts the post-effect observation.

Semantic batch:

```text
operation terminal says confirmed
+
WorkspaceEffectGeneration derives G→G+1
+
complete post-observation O1
+
exact operation ownership still maps to current ProgramAttempt A
+
no drift contradiction requiring invalidation
→ Host may admit a Program execution-base advance for A to (G+1,O1)
```

The Program event/reference must not re-decide effect certainty. It consumes the operation authority.

This is not duplicate authority because the two facts answer different questions:

```text
operation effect: did Host operation O have a confirmed effect?
Program base advance: what trusted observation does current Attempt A use after O?
```

## 68. Confirmed stale-attempt effects still advance global lineage

A late operation owned by a superseded/cancelled attempt may still have a real confirmed Workspace effect.

Therefore:

```text
stale Program authority
!=
no Workspace effect
```

Global generation advances when the operation effect is confirmed. Stale Program evidence/base authority remains rejected.

---

# Part IX — Concurrent external writes during Host mutation

## 69. The attribution problem

History:

```text
expected O0
→ Host mutating operation M starts
→ external editor also writes
→ M reports success / effect confirmed
→ Host observes O1
```

The Host knows M had a confirmed effect under operation semantics. It may not know which subset of O0→O1 differences came from M versus the external editor.

The protocol must not lie about this.

## 70. Complete Host-owned write scope can detect some concurrent drift

If a capability adapter has a **Host-owned complete Workspace write scope** for the invocation, and complete pre/post observations yield changed paths outside that scope:

```text
confirmed M effect
→ G advances once
→ out-of-scope observed change = drift evidence
→ do not continue current attempt under O1
```

The current attempt is interrupted/stale after terminal operation persistence.

## 71. Unknown write scope cannot prove exclusive causation

For arbitrary shell/broad mutators, write scope is normally `unknown`.

Then Phase 1 may adopt a complete post-effect observation O1 as the attempt's current observed state after M, because the Host has checked actual covered state at that boundary.

But the claim is only:

```text
M had a confirmed Host-known effect
AND
Host observed covered state O1 after execution
```

It is **not**:

```text
all O0→O1 changes were caused solely by M
```

This limitation is part of the selected boundary-checked guarantee.

If exclusive attribution is required for arbitrary mutators, the hybrid shared-worktree design is falsified and isolated Workspace execution is required.

## 72. Same-path external races are generally indistinguishable

Even a known write scope cannot prove that an external writer did not also modify the same allowed path during M.

Direct observation shows resulting state, not exclusive actor history.

Again, stronger isolation is the remedy, not another counter.

---

# Part X — Drift/rebase alternatives

## 73. Alternative D-A — silently replace expected observation in the same attempt

**Reject.**

It turns ProgramAttempt into a mutable lease and allows stale authority to become current merely by accepting whatever files happen to exist.

## 74. Alternative D-B — mark drift but let the same attempt continue

**Reject.**

A fresh attempt identity is the clean authority boundary after an unexplained state transition.

## 75. Alternative D-C — invalidate attempt and automatically start a fresh attempt from current state

**Viable but weaker product/semantic boundary.**

It preserves technical attempt freshness but silently authorizes continuing an immutable Program contract against externally changed state. That may be undesirable when the user deliberately edited files or a foreground action changed repository semantics.

## 76. Alternative D-D — invalidate attempt, require exact Application rebase acceptance, then fresh attempt

**Preferred for Phase 1.**

The Application/user explicitly authorizes:

> continue the existing immutable Program contract against this exact newly observed Workspace state.

No topology/objective amendment is implied.

## 77. Alternative D-E — automatic semantic replan/versioned Program amendment

**Defer.**

Post-creation objective/topology amendment/versioning is outside current Phase 1 scope. If the existing Program contract no longer fits, cancel and create a new Program rather than silently mutate the contract.

---

# Part XI — Selected drift/rebase lifecycle

## 78. Drift detection

At a freshness-sensitive cut outside a current mutator post-effect adoption window:

```text
expected complete observation Oexp
→ direct complete observation Ocur
→ Ocur != Oexp
```

means covered execution drift.

If observation is unknown, treat execution as not safely current but do not assert a specific drift identity.

## 79. Active-attempt drift

If a ProgramAttempt is active when drift is detected:

```text
record durable drift receipt
+
interrupt/invalidate active ProgramAttempt for workspace_drift
+
stop admitting new Program-owned operations/evidence/verification/completion for that attempt
```

This should linearize in the Host canonical lane so a late proposal cannot win after the drift invalidation fact.

An already-running operation remains an independent durable effect history and must finish/reconcile.

## 80. Drift receipt meaning

A drift fact authoritatively means:

```text
at checked cut C, Host observed current covered state did not match the Program's accepted execution observation
```

It does not claim:

- who changed the Workspace;
- when the first change occurred;
- whether one or many writers acted;
- whether an ABA history occurred before the cut.

## 81. Parked Program drift

If no ProgramAttempt is active and the Program later tries to resume, successor-dispatch revalidation compares current `(G,O)` against the Program's last accepted execution base.

A changed global generation caused by an unrelated Host mutator or an observation mismatch means the Program needs a new accepted execution base before dispatch unless the change was already part of a Program-owned accepted transition.

## 82. Rebase authorization

Preferred first-slice Application command semantics are equivalent to:

```ts
program.execution.rebase.accept {
  programStateId;
  expectedProgramRevision;
  driftReceiptId;
  acceptedObservationIdentity;
  acceptedWorkspaceEffectGeneration;
}
```

Exact wire spelling is open.

Rules:

- Agent cannot authorize rebase;
- command requires exact current Program revision where Program state changed;
- drift receipt/current execution-control identity must match;
- accepted observation must be complete and current;
- command is idempotent/single-consumption;
- a later Workspace change before new attempt dispatch makes the acceptance stale;
- rebase does not amend objective, required topology, or verification requirement definitions.

## 83. Rebase semantic meaning

The Application accepts only:

> continue the already-authorized immutable Program contract from this exact current execution base.

If the user/Agent concludes the objective/topology must change materially, Phase 1 uses Program cancellation plus new Program creation. It does not smuggle contract amendment through rebase.

## 84. Rebase and ProgramState revision

Do not increment Program revision merely because a watcher counter changed.

However real canonical Program control transitions may naturally change Program revision:

- active attempt interruption due to drift;
- explicit accepted rebase if the Program reducer treats current execution authorization as Program control state.

The exact reducer increment policy should remain deterministic. The important rule is that Workspace counters are not copied into Program revision as synchronization numbers.

## 85. Rebase bridge to fresh attempt

After rebase acceptance:

```text
accepted base B = (G,O)
→ no active attempt yet
→ scheduler later acquires ProgramAttempt reservation
→ direct re-observation under Host mutation exclusion
→ current G/O must still match B exactly
→ mismatch/unknown => accepted rebase stale; no dispatch
→ match => mint fresh ProgramAttemptId
```

This mirrors the creation-to-first-dispatch bridge without reusing `Bplan`.

## 86. Verification impact at drift/rebase

External drift is evaluated separately from execution-base authorization.

If the Host can derive a complete bounded changed-path set under the same observation profile:

- known-disjoint verification scopes may remain current;
- relevant scopes invalidate.

If changed paths/impact are unknown:

```text
fail closed for potentially affected verification obligations
```

No fake Host effect generation is needed merely to drive verification invalidation.

## 87. Drift ABA cannot resurrect an old attempt

History:

```text
A expects O0
→ Host detects O1 drift
→ A interrupted
→ external writer restores O0
```

A remains interrupted. Exact byte equality later does not restore ProgramAttempt authority.

A new accepted rebase/fresh attempt is required.

---

# Part XII — Capability observation/impact alternatives

## 88. Alternative C-A — trust Agent/tool `affectedPaths`

**Reject as authority.**

It is untrusted evidence and can be incomplete.

## 89. Alternative C-B — treat every mutation as affecting everything

**Correct but overly destructive.**

It is a safe fallback for unknown impact, not the desired only mode. It would invalidate unrelated verification constantly.

## 90. Alternative C-C — Host-owned capability access class + Host-derived observed diff + bounded trusted scope evidence

**Preferred.**

Use several evidence strengths without confusing them:

1. Host-owned capability Workspace access class controls coordinator admission;
2. direct pre/post observation controls execution currentness;
3. Host-derived changed-path diff can provide complete covered impact when available;
4. a Host-owned capability adapter may provide complete bounded write scope for a specific invocation;
5. Agent/tool-declared paths remain advisory unless independently validated;
6. unknown impact fails closed for verification.

---

# Part XIII — Selected capability contract

## 91. Workspace access class

Each Host capability binding has one Workspace access class:

```text
none
read_only
may_write
```

Missing/untrusted classification → `may_write`.

This class determines environmental coordinator behavior.

It does **not** by itself prove effect status or changed paths.

## 92. Program operation ownership

For Program-originated operations, root `operation.requested` remains the natural place to bind:

- `programStateId` through envelope/domain correlation as selected by the earlier study;
- `programAttemptId` on the root operation request;
- exact request-time Program revision/base claim as needed for admission proof.

Later operation/evidence facts derive ownership through immutable `operationId` rather than repeating independent ownership claims everywhere.

## 93. Pre/post observation is Host-owned

The Host obtains execution observations through the Workspace observer/provider.

A capability may not return an arbitrary string and declare it the current `ExecutionObservationIdentity`.

## 94. Changed-path impact

Preferred impact union:

```ts
type WorkspaceImpact =
  | { kind: "none" }
  | { kind: "known_paths"; paths: readonly string[]; completeForCoveredSurface: true }
  | { kind: "unknown" };
```

`known_paths` is admitted only when the Host can establish completeness for the selected covered Workspace surface.

Sources may include:

- diff of two complete observations with bounded manifests;
- a Host-owned capability adapter whose write set is mechanically complete;
- reconciliation-specific Host evidence.

Agent/model/tool self-report alone is insufficient.

## 95. Unknown impact

Unknown path impact does not mean unknown effect status.

Example:

```text
bash succeeds
→ effect confirmed
→ WorkspaceEffectGeneration advances
→ post-observation complete
→ exact changed-path causation may still be unknown
```

Execution can continue under the boundary-checked guarantee if the post base is trusted, while verification invalidation fails closed where impact cannot be proven disjoint.

## 96. Read result currentness

A read result can become current Program evidence only if:

- exact ProgramAttempt ownership remains current;
- pre-observation matched expected base;
- post-observation is complete and still matches the required current base under the read contract;
- no Program supersession/cancellation won;
- relevant verification subject generation has not changed before satisfaction admission.

Generic operation history may still record the read result if those Program-specific predicates fail.

## 97. Mutating result currentness

For a confirmed current-attempt mutation:

- operation effect truth persists regardless of later Program staleness;
- global generation advances exactly once;
- current Program evidence/base advancement requires exact current attempt ownership and a complete post-effect observation;
- if a complete trusted write scope proves an out-of-scope concurrent change, treat as drift and do not continue the attempt;
- if write scope is unknown, post-state adoption carries the explicit non-exclusive-causation limitation.

## 98. Verification commands

A verification command is not trusted merely because its exit code is zero.

Program verification satisfaction consumes:

- canonical operation/evidence provenance;
- exact obligation ID/current subjectGeneration;
- execution-base currentness;
- closed deterministic predicate evaluation;
- any required artifact/evidence semantics from the active amendment/future consolidation.

Execution observation and verification subject generation remain distinct.

---

# Part XIV — Recovery protocol

## 99. Restart order

Before Program scheduler or ordinary Host Workspace mutation admission is enabled after reopen:

```text
acquire Workspace process/store lock
→ canonical store/projection recovery
→ rebuild ProgramState / operation / Workspace execution projections
→ identify orphan active ProgramAttempt and durably interrupt idempotently
→ recover requested/started operations
→ classify/surface Workspace-affecting survivors as indeterminate where required
→ block Program execution / ordinary Host Workspace mutators on unresolved uncertainty
→ reconcile or surface unresolved decision
→ obtain fresh complete Workspace observation
→ compare against each resumable Program's last accepted execution base at the appropriate resume cut
→ only then enable eligible Program/mutation admission
```

This is stronger than current Phase 0.x startup behavior and is explicit Phase 1 work.

## 100. Crash before operation request append

No canonical operation exists. No Host effect should have been executed because operation execution starts only after request/start admission.

Reservation/sublease can be released with process death; replay has no effect uncertainty for that unstarted operation.

## 101. Crash after `operation.started` before external effect

Recovery cannot prove the effect did not happen.

Mutating operation becomes indeterminate/pending.

No generation advance is fabricated.

## 102. Crash after external effect before terminal append

Same canonical history as the prior case:

```text
operation.started
→ no terminal fact
```

Recovery preserves indeterminate state. Observation mismatch alone does not decide effect causation. Reconciliation does.

## 103. Crash after terminal confirmed effect before Program base advance

Replay sees a confirmed Workspace-mutating effect, so global generation reconstructs the advance.

If no trusted current-attempt base-advance fact was committed, the old attempt must not be resumed by inventing one after restart.

Recovery interrupts the orphan attempt and requires a fresh current observation/rebase path before successor execution.

This avoids partial-batch ambiguity becoming same-attempt authority.

## 104. Crash after Program base advance

Replay reconstructs:

- confirmed operation effect;
- generation;
- Program expected-base advance;
- attempt ownership.

But the Host process death still makes the active attempt orphaned under the Phase 1 recovery rule. It is interrupted, then later successor execution revalidates against live state.

## 105. Crash during reconciliation

Reconciliation itself must be idempotent in canonical admission.

A repeated reconciliation cannot:

- advance one operation's generation twice;
- flip a previously resolved confirmed effect to absent;
- create competing final resolutions.

If the environmental reconciliation check itself can mutate, it runs under the reconciliation mutation lease and its own uncertainty rules.

## 106. Offline external edit

```text
last accepted base (G,O0)
→ Host cleanly closes
→ human edits Workspace
→ reopen
→ replay gives same G
→ direct observation gives O1 != O0
```

Expected:

- no fake Host generation;
- Program cannot silently resume from O0;
- drift/rebase flow is required before a fresh attempt.

No watcher history while offline is needed to detect a final covered mismatch.

---

# Part XV — Canonical histories

## 107. Normal read

```text
A current at (G4,O4)
→ read lease
→ Opre = O4
→ operation R requested/started under A
→ read executes
→ Opost = O4
→ terminal observation evidence admitted current
→ A remains (G4,O4)
```

## 108. Normal confirmed mutation

```text
A current at (G4,O4)
→ mutation sublease
→ Opre = O4
→ operation M requested/started under A
→ M succeeds, Workspace-affecting effect confirmed
→ observe complete O5
→ terminal cut derives G5
→ Program base advance (G5,O5)
→ A continues
```

## 109. Confirmed mutation with unchanged content digest

```text
M classified may_write
→ M confirmed
→ post observation equals O4
```

Generation still advances:

```text
(G4,O4) → (G5,O4)
```

because lineage and content equality answer different questions.

## 110. Failed mutation with possible partial effect

```text
M starts
→ writes some state
→ exits failed
→ EffectStatus indeterminate
```

Expected:

- no G advance yet;
- A becomes non-continuable;
- uncertainty barrier;
- reconcile;
- fresh attempt only after safe base authorization.

## 111. Reconciliation confirms effect

```text
O indeterminate
→ reconciliation evidence confirms effect
→ first confirmed transition for operation O
→ G advances once
→ obtain current complete observation
→ rebase/accepted current base
→ fresh attempt
```

## 112. Reconciliation proves absent

```text
O indeterminate
→ reconcile absent
→ G unchanged
→ reobserve current Workspace
→ if still matches accepted prior base, rebase/continuation policy can authorize fresh attempt
```

The old attempt remains interrupted.

## 113. External drift between operations

```text
A expects O5
→ no Host mutator active
→ editor changes Workspace
→ next checked cut observes O6
```

Expected:

```text
drift receipt
→ A interrupted
→ no current evidence/verification/completion
→ Application accepts exact rebase or cancels
→ fresh attempt
```

## 114. External ABA after drift was detected

```text
O5 → O6 detected
→ A interrupted
→ external state returns to O5
```

A does not revive.

## 115. External ABA entirely between checks

```text
O5 checked
→ external O6
→ external returns O5
→ next direct check O5
```

Boundary-equality model may miss this history.

The contract must explicitly say so. A watcher signal may reveal it opportunistically but is not proof either way.

## 116. External write during unknown-scope shell mutation

```text
A at O5
→ bash M starts
→ editor changes same/different files
→ M succeeds
→ observe O6
```

Expected first-slice claim:

- M confirmed → G advances once;
- O6 is accepted post-effect covered state if observation complete and no stronger scope contradiction exists;
- no claim that M exclusively caused O5→O6;
- verification impact may be unknown/fail-closed;
- if this limitation is unacceptable, isolation is required.

## 117. Known-scope mutation with out-of-scope change

```text
Host adapter proves M can write only {a.ts}
→ pre O5
→ M executes
→ post diff = {a.ts, b.ts}
```

Expected:

- confirmed M still advances G once;
- `b.ts` difference is drift evidence;
- current attempt is interrupted rather than silently adopting post state.

## 118. Foreground Host mutator while ProgramAttempt active

```text
A owns ProgramAttempt reservation
→ foreground capability classified may_write requests execution
```

Expected: wait/reject as Workspace busy; it cannot cross A's reservation.

## 119. Foreground Host mutator while Program parked

```text
no active attempt reservation
→ foreground Host may_write operation executes confirmed
→ G advances
→ Program later resumes
```

Program's old accepted base no longer matches current global causal state. Resume enters drift/rebase authorization before a fresh attempt.

## 120. Read races external edit

```text
pre O0
→ read executes
→ external edit
→ post O1
```

Read result remains generic operation evidence but is not current Program evidence under O0.

## 121. Completion races Host mutator

Host mutator cannot start while completion holds the coordinator observation lease. If mutator already holds required mutation authority, completion waits/fails closed before final observation.

Canonical completion still revalidates Program predicates inside the admission lane.

## 122. Completion races external writer

```text
Host observes complete O0
→ external writer changes O1
→ canonical program.completed commits
```

Possible on shared worktree.

The terminal fact is truthful about the checked boundary, not a claim of filesystem transaction isolation. A stronger guarantee requires an isolated provider.

## 123. Late stale-attempt effect

```text
A0 interrupted
→ A1 or rebase state current
→ late operation from A0 is confirmed
```

Expected:

- operation effect persists;
- global G advances;
- current Program base is now stale unless the effect was already accounted for;
- A0 evidence remains stale;
- current Program enters drift/rebase/revalidation as necessary.

## 124. Program cancellation with late effect

Cancellation wins Program authority. A late real effect still changes global Workspace lineage and may affect other parked Programs' future resume bases.

No rollback claim is made.

---

# Part XVI — Relationship to verification freshness

## 125. Cardinality remains different

```text
one confirmed Host Workspace effect
→ G advances once
→ zero/one/many verification obligations may invalidate
```

according to deterministic impact evidence.

## 126. Known disjoint effect

If complete Host-derived impact proves effect disjoint from obligation subject:

```text
G advances
subjectGeneration may remain unchanged
```

## 127. Unknown impact

```text
G advances if effect confirmed
impact unknown
→ fail-closed advance/invalidate affected verification subject generations according to the final verification taxonomy
```

## 128. External drift

External drift does not advance `G`, but it still triggers verification-impact analysis.

If impact is unknown, invalidate potentially affected obligations fail-closed.

## 129. Artifact freshness

Artifact content identity does not bypass execution/verification freshness.

A retained ArtifactRef from an older subject generation remains the same bytes but cannot carry prior verification satisfaction into a newer subject generation merely because the ref still resolves.

---

# Part XVII — Relationship to completion

## 130. Completion inputs

The final Completion Oracle must consume at least:

- Program lifecycle/current revision;
- no active ProgramAttempt;
- no unresolved required work/blockers;
- required verification current for each subject generation;
- no unresolved Workspace-affecting operation uncertainty;
- no unresolved execution drift/rebase gap;
- current global `WorkspaceEffectGeneration` equals the Program's accepted current causal base;
- current complete observation equals the Program's accepted current observation at the terminal cut;
- no cancellation/terminal conflict won first.

## 131. Completion observation is not a criterion

`ExecutionObservationIdentity` is a currentness precondition, not a user-authored completion criterion.

The Completion Oracle checks that it is operating on the accepted current Workspace base. It does not ask the Agent whether the digest “looks done.”

## 132. Terminal exact-once remains canonical

Completion evaluation and append still linearize through `CanonicalAdmissionQueue` after the environmental observation lease has been acquired and current observation obtained.

A stable Program-derived completion idempotency key remains appropriate.

---

# Part XVIII — Acceptance-criterion consequences

## 133. AC-10-04 — exact attempt validity

Add/clarify proofs:

```text
attempt starts only from exact complete accepted (G,O)
```

```text
unexpected drift observed
→ current attempt interrupted
→ later state equality cannot revive it
```

```text
indeterminate Workspace-affecting effect
→ same attempt cannot continue
```

```text
confirmed effect + unknown post-observation
→ same attempt cannot continue
```

## 134. AC-10-05 — scheduler/environmental coordination

Refine scheduling proof to include:

- ProgramAttempt reservation acquired before final dispatch observation;
- no unrelated Host `may_write` capability crosses an active ProgramAttempt reservation;
- read/mutation/reconciliation lease rules;
- global acquisition order: coordinator before canonical admission;
- successor dispatch exact current execution-base recheck;
- stale accepted rebase cannot dispatch after later drift.

This also provides the evidence needed to replace older “canonical queue equals concurrency control” interpretations.

## 135. AC-10-06 — operation correlation/uncertainty/effect lineage

Add proofs:

```text
first confirmed transition for Workspace-mutating operation O
→ G advances exactly once
```

```text
terminal retry/replay
→ no duplicate G
```

```text
indeterminate
→ no G advance
```

```text
reconcile confirmed
→ G advances once
```

```text
reconcile absent
→ G unchanged
```

```text
stale attempt's real confirmed effect
→ G advances
→ stale Program evidence rejected
```

## 136. AC-10-07 — verification freshness

Add proofs:

- Host-derived known changed paths may prove disjointness;
- Agent/tool-declared paths alone cannot;
- unknown impact invalidates fail-closed;
- external drift can invalidate verification without fake Host-effect generation;
- execution observation unknown blocks satisfaction admission;
- `subjectGeneration` remains separate from `WorkspaceEffectGeneration`.

## 137. AC-10-08 — completion

Add terminal-cut proof:

```text
acquire observation lease
→ observe exact accepted current base
→ enter canonical admission
→ revalidate all Program/verification/uncertainty/terminal predicates
→ append completed exactly once
```

Negative proofs:

```text
unresolved drift → completion reject
unresolved indeterminate Workspace effect → completion reject
current G mismatch → completion reject
current observation mismatch/unknown → completion reject
```

## 138. AC-10-09 — recovery barrier

Strengthen to prove:

- Workspace-effect generation rebuild from operation effects;
- orphan attempts interrupted;
- started/requested Workspace mutators become blocking uncertainty as required;
- no scheduler/ordinary Host Workspace mutator admission before relevant uncertainty handling;
- fresh direct observation after replay;
- offline drift prevents silent Program resume.

## 139. AC-10-10 — Application/read model

Expose bounded execution-control state:

- current accepted execution-base summary;
- active attempt/busy status;
- drift detected / rebase required;
- pending/unresolved Workspace-effect uncertainty;
- rebase acceptance command result: accepted/stale/duplicate/noop as appropriate.

The Application does not write event-store state directly.

## 140. No new AC family is required

The execution-base protocol is cross-cutting proof detail for existing AC-10-04/05/06/07/08/09/10 rather than a separate product feature.

A dedicated gate may still be useful if implementation later needs one, but the acceptance property belongs to existing ownership/recovery/currentness criteria.

---

# Part XIX — Required negative-proof matrix

## 141. Observation

```text
observation bound exceeded
→ unknown
→ no trusted attempt/verification/completion cut
```

```text
coverageDigest differs
→ not equivalent
→ fail closed
```

```text
CodeRevisionToken unchanged
but direct execution observation differs
→ direct execution observation wins
```

```text
watcher silent
→ not proof of no external change
```

## 142. Coordinator

```text
ProgramAttempt reservation active
→ foreground Host may_write request
→ cannot enter environmental mutation
```

```text
mutation sublease held
→ Host read requiring stable observation
→ waits until mutation section completes
```

```text
canonical admission held
→ code path tries to wait for coordinator
→ forbidden by acquisition-order invariant
```

## 143. Effect generation

```text
read-only operation completed
→ no G advance
```

```text
may_write succeeded confirmed
→ G +1
```

```text
same terminal event replayed
→ no additional G
```

```text
failed indeterminate
→ no G
```

```text
reconcile confirmed after indeterminate
→ exactly one G
```

```text
reconcile absent
→ no G
```

## 144. Drift/rebase

```text
A current O0
→ direct O1 mismatch
→ A interrupted
```

```text
A interrupted by drift
→ state returns O0
→ A remains stale
```

```text
rebase accepts O1
→ O2 appears before dispatch
→ no dispatch under accepted O1
```

```text
Agent says "continue"
→ no Application rebase acceptance
→ no fresh attempt
```

## 145. Unknown-scope mutation

```text
bash confirmed
→ post O1 complete
→ G advances
→ system may continue from O1
→ system does not claim exclusive causation
```

This proof must assert the limitation, not pretend to prove absence of concurrent external writes.

## 146. Known-scope mutation

```text
scope {a}
→ observed diff {a,b}
→ G advances for confirmed M
→ drift invalidates current attempt because b is unexplained
```

## 147. Recovery

```text
started mutator
→ crash
→ restart
→ indeterminate
→ no fabricated G
→ no same-attempt resume
```

```text
confirmed terminal effect persisted
→ crash before Program base advance
→ replay G advanced
→ orphan attempt interrupted
→ no fabricated old-attempt base advance
```

```text
Host offline edit
→ restart direct mismatch
→ rebase required
```

## 148. Completion

```text
all work/verification appear satisfied
→ execution drift unresolved
→ completion reject
```

```text
all work/verification appear satisfied
→ indeterminate Workspace effect unresolved
→ completion reject
```

---

# Part XX — Alternative comparison matrix

## 149. Observation matrix

| Design | Exact covered state | Replay-independent | External final drift | Bounded | Causation | Result |
|---|---|---|---|---|---|---|
| CodeRevisionToken authority | no | no | best-effort | yes | no | reject |
| HEAD/status only | weak | yes | partial | yes | no | reject alone |
| full filesystem digest | strong if completes | yes | yes | poor without caps | no | not default |
| per-read dependencies | narrow | yes if persisted | narrow | yes | no | planning-only |
| versioned complete profile | **yes by declared surface** | **yes** | **yes at checked cuts** | **yes** | no | **prefer** |
| isolated snapshot | strongest | provider-defined | excludes external writer | yes if provider | separate | defer |

## 150. Mutation-coordination matrix

| Design | Blocks Host mutator overlap | Protects whole attempt assumptions | Uses canonical queue correctly | External writers | Result |
|---|---|---|---|---|---|
| admission queue only | no | no | overclaims | no | reject |
| per-op mutex | yes | no | yes | no | partial |
| attempt reservation + subleases | **yes** | **yes from Host mutators** | **yes** | no | **prefer** |
| pretend repo lock | no real proof | no | n/a | no | reject |
| isolated provider | yes | yes | yes | yes within provider | defer |

## 151. Generation matrix

| Design | Single effect authority | Replay | Reconciliation | External drift distinct | Result |
|---|---|---|---|---|---|
| separate workspace verdict event | risks duplicate | yes | tricky | maybe | reject as authority |
| process counter | no | no | weak | weak | reject |
| derive from first operation confirmed transition | **yes** | **yes** | **natural** | **yes** | **prefer** |
| observed-diff counter | no causation | yes-ish | wrong | no | reject |

## 152. Drift matrix

| Design | Prevents stale same-attempt continuation | User-visible authority | Contract remains immutable | Scope | Result |
|---|---|---|---|---|---|
| silent same-attempt baseline | no | no | technically | small | reject |
| drift flag, same attempt | weak | maybe | yes | small | reject |
| automatic fresh attempt | yes | no | yes | small | viable |
| explicit rebase + fresh attempt | **yes** | **yes** | **yes** | moderate | **prefer** |
| versioned semantic replan | yes | yes | no | large | defer |

---

# Part XXI — Consolidated recommendation

## 153. Recommended Phase 1 execution-base protocol

Adopt this combined semantic model when/if later promoted into the governing plan:

```text
1. Workspace provider exposes versioned complete ExecutionObservationIdentity
   or returns unknown.

2. ProgramAttempt dispatch acquires a Workspace-scoped ProgramAttempt
   mutation reservation before its final direct observation.

3. ProgramAttempt starts from exact:

      (WorkspaceEffectGeneration, ExecutionObservationIdentity)

4. WorkspaceEffectGeneration is derived from canonical operation history:
   first confirmed transition of each Host-classified Workspace-mutating
   operation advances exactly once.

5. Program-owned mutating execution runs under the attempt reservation
   + exclusive mutation sublease; Host foreground mutators cannot cross it.

6. Host direct pre/post observations establish checked current state.

7. Normal confirmed current-attempt effect:
      G advances once
      + complete post observation
      + exact current ownership
      → advance attempt expected base.

8. Indeterminate effect:
      no trusted next base
      → current attempt non-continuable
      → reconciliation barrier
      → fresh attempt after safe current-base authorization.

9. Confirmed effect + unknown post observation:
      G advances
      → current attempt non-continuable
      → reobserve/rebase before fresh attempt.

10. Unexplained complete observation mismatch outside a normal post-effect
    adoption window:
      drift receipt
      → current attempt interrupted
      → explicit Application rebase acceptance
      → final recheck
      → fresh ProgramAttemptId.

11. Rebase never mutates immutable objective/topology/verification requirement
    definitions. If they no longer fit, cancel and create a new Program.

12. Workspace impact uses Host-derived observation diffs / Host-owned complete
    capability scope when available; unknown impact fails closed for verification.

13. Watchers/CodeIntelligence remain early-warning/observation infrastructure,
    never canonical absence proof.

14. Shared-worktree guarantee is boundary-checked. External concurrent writes
    and ABA histories can remain undetectable; exclusive causation requires
    future isolated Workspace execution.
```

## 154. Why this package wins

It is the smallest coherent first-slice protocol found that preserves all of:

- one canonical operation/effect authority;
- rebuildable causal Workspace lineage;
- exact ProgramAttempt currentness;
- legitimate same-attempt mutation progression;
- fail-closed uncertainty;
- explicit Host environmental exclusion;
- covered external-drift detection at defined boundaries;
- user-visible re-authorization after unexplained drift;
- verification freshness separation;
- compatibility with future isolated/remote Workspace providers;
- honest shared-worktree limitations.

A simpler counter-only model loses observed state. A digest-only model loses causation. A per-operation mutex leaves inter-operation Host races. Silent rebase loses authority provenance. Full isolation is stronger but outside current Phase 1 scope.

## 155. Freeze-readiness impact

If this study is accepted later, the execution-base architecture itself is sufficiently specified for consolidation **except for numeric structural ceilings**.

The following no longer need separate architecture studies:

- observation identity semantic shape/equality;
- Host-mediated mutation barrier lifetime/order;
- effect-generation authority/idempotence;
- drift invalidation/rebase authorization;
- capability Workspace access/impact evidence hierarchy;
- restart composition of those rules.

Remaining Phase 1 planning work still includes:

1. final verification predicate taxonomy / mandatory verification requirement kinds;
2. empirical structural-bound measurements, including execution-observation caps;
3. final consolidation of all accepted studies/amendments into the governing plan;
4. explicit user approval/freeze after consolidation review.

## 156. Implementation consequences are not authorization

If Phase 1 is later approved, likely implementation work would include:

- Workspace execution observer/profile;
- WorkspaceMutationCoordinator;
- Host capability Workspace access classification;
- ProgramAttempt execution-base state/events/projection;
- derived WorkspaceEffectGeneration projection;
- canonical reconciliation resolution support where current code is incomplete;
- drift/rebase Application commands/read model;
- scheduler/capability/completion integration;
- negative proofs described above.

This list is planning evidence only. It does not authorize any of that implementation now.

## 157. Confidence

**High confidence** in:

- exact distinction among operation effect, Workspace effect generation, observation identity, ProgramAttempt identity, and verification subject generation;
- deriving `WorkspaceEffectGeneration` from operation effect transitions rather than a second verdict authority;
- ProgramAttempt reservation + subleases as the correct Host-mediated shared-worktree coordination shape;
- invalidating the same attempt after indeterminate effect or unexplained drift;
- explicit rebase before fresh execution after external/unrelated drift;
- fail-closed unknown observation/impact.

**Medium-high confidence** in the selected local Git observation surface. It is substantially more suitable than CodeIntelligence's current cache-oriented token, but exact provider implementation should be validated against realistic repositories before freeze.

**Low confidence** in exact numeric observation limits until the structural measurement corpus exists.

## 158. Falsifiers

This recommendation is no longer sufficient if Phase 1 requires any of:

- proof no external process modified covered state between checks;
- proof no external process raced a Host mutator;
- proof of exclusive byte-level causation for arbitrary shell operations;
- complete history detection of external ABA changes;
- execution correctness over ignored/out-of-profile state with no capability-specific provenance;
- automatic semantic contract amendment after external drift.

Those requirements require a stronger isolated/transactional Workspace architecture and/or an expanded Program contract model.

---

# Part XXII — Planning status

## 159. Status

This document is a non-normative alternatives study.

It does not:

- amend `docs/phase-1.0-plan.md`;
- supersede `docs/phase-1.0-execution-freshness-study.md`;
- supersede `docs/phase-1.0-program-creation-authorship-study.md`;
- change the active artifact-evidence amendment;
- approve or freeze Phase 1.0;
- authorize implementation.

Its conclusions become governing only if explicitly selected and consolidated into the Phase 1.0 contract, followed by explicit approval/freeze.
