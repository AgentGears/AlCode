# ALCODE Phase 1.0 — Whole-Contract Adversarial Review

**Status:** review evidence against the consolidated DRAFT candidate; not approval; not freeze; implementation not authorized  
**Review subject:** `docs/phase-1.0-plan.md` exactly as merged on `main` at `9d430f55b44d04cba664645641a78ed1814f6bc2`  
**Method:** falsification by canonical-history attack, crash/replay analysis, authority collision analysis, and rebuild equivalence  
**Scope:** the composed Phase 1.0 contract, AC-10-01 through AC-10-11, and Scenarios A through H

This review does not ask whether the architecture is attractive. It asks whether the consolidated contract permits a history in which the Host can admit stale authority, lose durable safety state, accept stale verification, produce an unrebuildable result, or leave two conforming implementations with materially different safety behavior.

The review subject is pinned. Findings below are against that exact merged candidate; later corrections do not rewrite the historical review result.

---

## 1. Review oracle

A history passes only when the contract determines one safe result from canonical state plus the explicitly allowed live observation boundary. A history fails when the candidate permits any of the following:

- a stale Program/Attempt/Workspace claim can become current;
- an environmental writer can outlive the Host's exclusion without a blocking durable fact;
- verification accepted for an old subject can survive a recognized relevant/unknown Workspace change;
- a replay needs current provider/model/policy/process memory to recover historical truth;
- a command can become stale because of the same semantic transition that created the command's control receipt;
- a correctness-sensitive cut relies on an unspecified observation boundary;
- two reasonable implementations can make opposite safety decisions while both satisfy the text.

The shared-worktree external-ABA limitation is **not** treated as a defect. The candidate explicitly promises boundary-checked freshness, not continuous filesystem isolation.

---

## 2. Authority ledger

The following authority split is internally coherent and is used as the review oracle:

| Fact | Canonical authority | Must not be replaced by |
|---|---|---|
| Program semantic/control state | Program canonical history + deterministic reducer | Agent assertion, transcript text |
| Program mutation currency | `ProgramState.revision` | Workspace counters |
| Current execution claim | `ProgramAttemptId` | session identity, timeout lease |
| One external operation/effect | `operationId` + operation effect/reconciliation history | Program base-advance event |
| Host-known confirmed Workspace-effect lineage | derived `WorkspaceEffectGeneration` | observed byte difference |
| Checked covered Workspace state | `ExecutionObservationIdentity` at a defined cut | watcher silence, CodeRevisionToken |
| Historical writer containment/quiescence | request-time operation-local contract + canonical quiescence proof | current provider registry |
| Verification currency | per-obligation `subjectGeneration` | ArtifactRef identity, Workspace generation |
| Artifact bytes | ArtifactStore / ArtifactRef | Program evidence admission |
| Rebase authorization | exact Application acceptance of one current mismatch candidate | Agent/model assertion |
| Cancellation/completion | serialized Host terminal admission | Agent idle/completion claim |

No finding below changes this authority model; each finding is a missing composition rule between authorities already selected by the candidate.

---

## 3. Adversarial matrix

The review exercised the following composed histories.

| ID | History attacked | Result on pinned candidate |
|---|---|---|
| H01 | duplicate/distinct acceptance of one creation draft across crash | PASS |
| H02 | idle/explicit-stop versus pending creation acceptance | PASS |
| H03 | first dispatch after planning-base change | PASS |
| H04 | stale-low / stale-high Program revision and old Attempt ABA | PASS |
| H05 | root operation request after Attempt supersession | **FAIL — F1 observation-cut definition is incomplete for Workspace freshness** |
| H06 | Workspace-dependent read with external edit during execution | **FAIL — F1 read bracketing disappeared from consolidated contract** |
| H07 | confirmed current-attempt mutation with complete post-state | PASS |
| H08 | failed/timed-out mutation with indeterminate effect | PASS |
| H09 | confirmed effect before writer quiescence, then Host crash | PASS for rebuild; **FAIL — F2 admission scope after rebuild/cancellation is incomplete** |
| H10 | cancellation while detached writer remains possible | **FAIL — F2 allows an implementation to release Program reservation without a stated ordinary-Host-mutation barrier** |
| H11 | external drift detected, Application rebase, crash before verification invalidation | **FAIL — F3** |
| H12 | causal-only generation mismatch with unchanged observation | PASS for rebase candidate |
| H13 | external ABA detected then bytes restored | PASS; old Attempt remains dead |
| H14 | external ABA entirely between equal checked observations | PASS as explicit guarantee limitation |
| H15 | verification G1 → relevant mutation → retained identical ArtifactRef | PASS when invalidation is canonical |
| H16 | current-generation waiver → relevant mutation | PASS when invalidation is canonical |
| H17 | completion versus cancellation | PASS |
| H18 | completion after external drift that has not yet been observed | **FAIL — F1 terminal observation cut is not concretely required by consolidated text** |
| H19 | legacy event replay after optional Program envelope extension | PASS by omission-preserving digest rule |
| H20 | provider replacement after historical `may_write` operation | PASS by operation-local historical contract |
| H21 | mismatch detected on active Attempt when interruption changes Program revision | **FAIL / ambiguous — F4** |
| H22 | delete projections and rebuild without current model/provider registry | PASS for the facts whose canonical transitions are fully specified |

The failures are not requests for alternative architecture. They are minimal histories where the consolidated text lost a safety/ordering rule that the supporting studies either already stated or that the composed contract requires for its own exact-currentness claims.

---

# 4. Findings

## F1 — P1 — Freshness-sensitive cuts are named but not closed

### Contract surface

The consolidated plan says:

> At any freshness-sensitive cut, the Host compares the Program's accepted/current expected base with a complete protected current base.

But it never closes the set of cuts. The earlier execution-freshness and execution-base studies did: Program-originated operation request, Workspace-dependent read before/after, mutating terminal/post-effect adoption, evidence admission, verification satisfaction, successor dispatch, and Completion Oracle terminal admission.

The consolidation retained the abstract phrase while dropping the operational enumeration.

### Minimal failing history A — stale root mutator admission

```text
Attempt A accepted at (G4,O4)
→ external writer changes covered Workspace to O5
→ no checked cut has yet observed O5
→ Agent requests Program-linked may_write operation M
→ Host revalidates exact P/A/revision and the stored expected base
→ consolidated text does not explicitly require a protected direct current observation at this operation-request cut
→ M may be admitted and execute against O5 while A still claims O4
```

Exact P/A/revision equality does not prove the live Workspace still equals the expected observation.

### Minimal failing history B — stale read evidence

```text
A expects O4
→ Workspace-dependent read starts
→ external edit O4→O5 during read
→ read returns a result derived across the change
→ no mandatory pre/post observation bracket is defined in the consolidated candidate
→ generic/current Program evidence can be admitted without the study's stale-read downgrade rule
```

### Minimal failing history C — stale completion

```text
all canonical work/verification appears terminally acceptable at accepted base (G4,O4)
→ external writer changes covered Workspace to O5
→ no mismatch receipt exists because no direct check has run
→ Completion Oracle enters its canonical lane
→ its predicate list requires no *current recorded* mismatch/unavailable condition, but does not explicitly require the protected direct observation that would discover O5
→ program.completed can be admitted against stale O4
```

The known shared-worktree race **after** a terminal observation remains an accepted limitation. The defect is the missing requirement to take that observation at all.

### Violated contract intent

- governing invariants 11–12;
- exact currentness of AC-10-04;
- terminal freshness intended by AC-10-08;
- execution-freshness study §§24 and 37–43;
- execution-base protocol study §§48–50.

### Smallest correction

Close the first-slice freshness-cut taxonomy in the consolidated plan and ACs. Require, as applicable:

1. first ProgramAttempt dispatch;
2. every Program-linked root operation request;
3. Workspace-dependent read-only operation: protected complete pre-observation matching the expected base, then protected complete post-observation; changed/unknown post-state makes the result non-current Program evidence;
4. mutating operation pre-observation and post-quiescence/post-effect observation before trusted base adoption;
5. current work-completion/current-evidence admission when it relies on Workspace state;
6. verification satisfaction;
7. successor-attempt dispatch and final rebase bridge;
8. Completion Oracle terminal cut.

For verification and completion, obtain the observation/read lease before canonical admission, observe directly, then revalidate exact Program state, G/O, generations, barriers, and terminal conflicts inside the canonical cut. External writers can still race after observation; no stronger isolation claim is added.

---

## F2 — P1 — Durable writer barriers are rebuildable but their ordinary admission scope is under-specified

### Contract surface

The candidate correctly says a started `may_write` operation creates a durable/rebuildable outstanding-writer barrier until canonical quiescence proof, and correctly preserves that barrier after cancellation. It also says unrelated Host `may_write` operations cannot cross an **active ProgramAttempt reservation**.

What is missing is the stronger rule already established by the execution-base review correction: an outstanding writer barrier itself blocks ordinary Host Workspace mutation admission even after the ProgramAttempt reservation has ended.

### Minimal failing history

```text
Program P / Attempt A owns may_write O
→ O's child can continue writing
→ Application cancellation wins
→ P terminal; A invalidated
→ in-memory ProgramAttempt reservation may be released
→ O remains canonical terminal/indeterminate-or-confirmed with quiescence unknown
→ durable writer barrier correctly remains
→ unrelated non-Program Host may_write M requests execution
```

The consolidated text clearly blocks a new ProgramAttempt before required quiescence and clearly preserves O's barrier, but does not explicitly say that ordinary Host `may_write` M must be rejected/wait while this post-attempt barrier exists.

A conforming implementation could therefore serialize Program attempts correctly yet overlap M with O's still-live descendant. That contradicts the stated Host-mediated mutation-coordination guarantee.

### Crash variant

```text
O effect confirmed
→ quiescence unknown
→ Host crashes
→ replay reconstructs confirmed effect + outstanding writer barrier
→ current provider differs
→ historical containment contract correctly refuses to prove quiescence
→ ordinary Host may_write admission starts before any Program scheduler activity
```

Again, scheduler gating alone is insufficient.

### Violated contract intent

- governing invariant 13;
- AC-10-05 environmental coordination intent;
- AC-10-09 recovery barrier intent;
- execution-base review correction §§3–5, especially the rule that unknown quiescence blocks ordinary Host mutation, stable reconciliation, verification satisfaction, and completion.

### Smallest correction

State one Workspace-domain rule:

> Any post-baseline started `may_write` operation lacking canonical `proven_quiescent` is an outstanding writer barrier. While any such barrier exists, the Host does not grant an ordinary ProgramAttempt mutation reservation, ordinary Host `may_write` admission, Workspace-based stable reconciliation, verification satisfaction, or Completion Oracle terminal admission. Only bounded diagnostic/quiescence-recovery access under the historical operation contract is allowed.

Cancellation/Program terminalization does not clear this barrier. The barrier clears only by the canonical quiescence proof for that `operationId`.

---

## F3 — P1 — External execution-base mismatch can be accepted before verification invalidation is crash-safe

### Contract surface

The candidate independently requires:

- external drift / execution-base mismatch → explicit Application rebase;
- relevant or unknown Workspace impact → advance/invalidate affected verification `subjectGeneration`;
- old satisfaction/waiver must not survive a relevant change.

But it does not define the ordering between the first canonical recognition of an external mismatch, verification impact invalidation, and rebase acceptance.

### Minimal failing history

```text
Program P parked at accepted base (G4,O4)
V is satisfied at subjectGeneration 1
V scope overlaps src/a.ts
→ external editor changes src/a.ts
→ protected resume check observes current (G4,O5)
→ Host records execution-base mismatch receipt
→ Application accepts exact rebase candidate (G4,O5)
→ acceptedExecutionBase becomes (G4,O5)
→ Host crashes before program.verification.invalidated / subjectGeneration advance is canonical
→ reopen observes exact (G4,O5)
→ no execution-base mismatch remains
→ replay still shows V satisfied at generation 1
→ all other Completion Oracle predicates hold
→ stale V can authorize completion
```

The same problem exists with unknown impact; fail-closed invalidation must not be merely eventual after the rebase becomes current.

### Why replay cannot repair this automatically

`subjectGeneration` is its own authority. The new accepted execution base does not itself imply which obligations changed. Unless the contract defines a deterministic canonical coupling/barrier, replay cannot invent the missing invalidation from current bytes or mutable provider policy.

### Violated contract intent

- governing invariants 16–17 and 22;
- AC-10-07 verification freshness;
- AC-10-08 Completion Oracle;
- Scenario D + Scenario F composition;
- execution-base protocol study §86 (external drift participates in verification impact).

### Smallest correction

At the first canonical transition that recognizes a complete execution-base mismatch for a Program, the Host must evaluate verification impact against the mismatch/current observation evidence. Before that candidate can become an accepted rebase/current base, one of these must already be canonical:

- all required overlapping/unknown `subjectGeneration` advances/invalidation facts; or
- a durable pending verification-impact barrier that blocks rebase acceptance, verification satisfaction, successor dispatch, and completion until those invalidations are canonical.

For the first slice, the simpler rule is to admit the mismatch receipt/attempt interruption and all required verification invalidations in one serialized Program transition whenever the bounded impact evaluation is available; unknown impact invalidates every obligation not provably disjoint. Rebase acceptance consumes only a receipt whose required verification-impact transition is complete.

For a causal-generation mismatch caused by Host operations, prior canonical impact processing may already have invalidated the Program; if not, mismatch processing must conservatively catch up before rebase acceptance.

---

## F4 — P2 — `ProgramState.revision` transition policy is not closed, making mismatch receipts potentially self-stale

### Contract surface

The candidate makes exact `ProgramState.revision` equality a universal stale-command guard and includes `expectedProgramRevision` in `ExecutionBaseMismatchReceipt`. It also says active-attempt mismatch interrupts/invalidates the attempt and explicit rebase is a Program control transition.

However, it does not define which effective ProgramState transitions advance `revision`, or whether a multi-fact canonical cut advances it once or multiple times.

### Minimal ambiguous history

```text
P revision R10; Attempt A active
→ Host detects execution-base mismatch
→ receipt is created with expectedProgramRevision = R10
→ same mismatch handling interrupts A
```

Two reasonable reducers are currently possible:

```text
Implementation X: attempt interruption changes ProgramState → revision R11
Implementation Y: attempt interruption does not advance revision → remains R10
```

Under X, if the receipt retained R10 it is stale immediately after the transition that created it; Application rebase can never satisfy both exact current revision and exact receipt without another receipt-generation rule. Under Y, `revision` does not represent a visible activeAttempt state change.

This is not merely a naming issue: Agent/Application stale-command behavior and replayed control state differ.

### Violated contract intent

- governing invariant 4;
- Program revision as canonical control-state currency;
- AC-10-04 exact-state validity;
- exact-revision rebase/cancellation semantics.

### Smallest correction

Close the revision rule:

> Every effective canonical semantic transition that changes the ProgramState projection/control truth advances `ProgramState.revision` exactly once for that atomic semantic cut. Duplicate/idempotent/no-op admission and operation-only history that does not change ProgramState do not advance it.

For an active-attempt execution-base mismatch, receipt creation + attempt interruption + any same-cut verification invalidations are one atomic Program transition and advance revision once. The persisted mismatch receipt binds the **resulting current Program revision** used by the subsequent exact rebase command. Rebase acceptance is a later effective Program transition and advances revision once again.

This keeps the revision a Program synchronization currency without copying Workspace counters into it.

---

# 5. Histories that survived attack

The review found no material contradiction in these composed areas on the pinned candidate:

### Creation and identity

The Host-owned exact draft, planning provenance, atomic single-consumption, pending-interaction terminal linearization, and first-dispatch `Bplan` bridge form one coherent authority chain. Crash-after-commit/response-loss remains idempotently recoverable.

### Operation effect versus Program authority

A stale/cancelled Attempt's late real effect remains a real `operationId` effect and can advance Workspace causal lineage without becoming current Program evidence. This correctly separates external fact from stale Program authority.

### Effect certainty versus quiescence

The consolidation retained the PR #41 review corrections: request-time `WorkspaceAccessClass`, immutable historical execution/quiescence contract, final `absent` only after quiescence, and confirmed effect not implying writer stop. Replay therefore does not consult a replacement provider to decide an old writer's containment.

### Artifact and verification identity

Stable output slots/production steps, stable Host verification-operation contracts, exact/subtree scope semantics, generation-indexed satisfaction/waiver, and ArtifactRef-as-byte-identity compose without creating a second evidence authority. A retained identical ArtifactRef cannot carry stale verification forward.

### Cancellation/completion authority

Cancellation is a terminal Program authority cutoff, not rollback. Completion and cancellation share one canonical terminal lane; outstanding operation history remains independently true. Exactly one Program terminal state wins.

### Historical compatibility

Optional Program envelope extension is constrained to preserve historical omission semantics; legacy event digests/fingerprints therefore need not change merely because a newer schema recognizes `programStateId`.

### Shared-worktree guarantee boundary

The candidate does not claim that a direct observation prevents an arbitrary external writer from racing immediately afterward, nor that equal observations prove no intermediate ABA. Those are explicit accepted limitations, not hidden correctness gaps.

---

# 6. Rebuild-equivalence attacks

For each finding, derived projections/process memory/current provider registry were conceptually deleted.

- **F1:** replay cannot discover an external edit that was never observed at a required cut. A missing cut is not repairable by replay.
- **F2:** replay can reconstruct the outstanding writer barrier, but without a closed admission-scope rule two implementations can use the same rebuilt truth differently. Rebuildability alone is insufficient.
- **F3:** replay cannot infer a missing obligation-generation transition from an accepted new execution base because execution freshness and verification freshness are intentionally distinct authorities.
- **F4:** replay can reproduce whichever revision policy an implementation chose, but the contract does not determine the same revision sequence across implementations. The candidate therefore does not yet define one protocol.

The other attacked histories rebuild from canonical Program/operation/control history without requiring current model output, watcher continuity, or current provider semantics.

---

# 7. Required retest after correction

A corrected candidate is acceptable for the next decision only if these exact histories are re-run:

```text
R1 external edit before Program root operation request
   → protected pre-observation detects mismatch
   → no operation.requested from stale Attempt

R2 external edit during Workspace-dependent read
   → post-observation differs/unknown
   → generic operation history may persist
   → current Program evidence rejected

R3 external edit before Completion Oracle
   → protected terminal observation detects mismatch/unavailable
   → no program.completed

R4 cancel Program while may_write descendant may survive
   → Program terminalizes
   → durable writer barrier remains
   → unrelated Host may_write rejected/waits

R5 restart with terminal confirmed O but no quiescence proof
   → rebuilt writer barrier blocks ordinary Host may_write + verification/completion

R6 V satisfied G1
   → external overlapping/unknown drift
   → mismatch receipt and required verification invalidation become crash-safe
   → rebase accepted only after invalidation complete
   → old G1 satisfaction/waiver cannot complete Program

R7 active mismatch at revision R10
   → one atomic mismatch/interruption transition
   → current revision R11
   → receipt binds R11
   → exact R11 rebase may be accepted
   → accepted rebase produces R12
```

Neighboring histories that must remain true:

```text
known-disjoint verification impact may retain subjectGeneration
causal-only (G4,O4) → (G5,O4) still has a legal exact rebase path
late stale-attempt confirmed effect still advances WorkspaceEffectGeneration
shared-worktree external writer may still race after a checked observation
legacy omitted envelope fields still verify byte/digest compatibly
```

---

# 8. Review conclusion on the pinned candidate

**Decision: bounded correction required before Phase 1.0 can be presented for approval/freeze.**

The pinned consolidated candidate is directionally coherent, but F1–F3 are correctness findings and F4 is a protocol-currentness ambiguity. None requires a new architecture or a return to open-ended planning. They can be closed by restoring/clarifying composition rules already implied by the selected authority model.

This review does not approve or freeze Phase 1.0 and does not authorize implementation.

After the targeted contract correction, rerun §7 and the affected AC/scenario proofs. If no P0/P1/P2 findings remain, the exact corrected head may be presented for the separate explicit approval/freeze decision.