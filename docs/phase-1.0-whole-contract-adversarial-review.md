# ALCODE Phase 1.0 — Whole-Contract Adversarial Review

**Status:** completed review evidence; not approval; not freeze; implementation not authorized  
**Pinned review subject:** `docs/phase-1.0-plan.md` as merged on `main` at `9d430f55b44d04cba664645641a78ed1814f6bc2`  
**Targeted correction commit:** `2619748df31fb0aeed750ac3d452c0fe55ffa2d1`  
**Method:** falsification by canonical-history attack, crash/replay analysis, authority collision analysis, and rebuild equivalence  
**Scope:** the composed Phase 1.0 contract, AC-10-01 through AC-10-11, and Scenarios A through H

This review asks whether the contract permits a history in which the Host can admit stale authority, lose durable safety state, accept stale verification, produce an unrebuildable result, or leave two conforming implementations with materially different safety behavior. The original review target remains pinned; correcting a finding does not rewrite the fact that the pinned candidate contained it.

The shared-worktree external-race/ABA limitation is not treated as a defect. The Phase 1.0 candidate explicitly promises boundary-checked freshness, not continuous filesystem isolation.

---

## 1. Review oracle

A history passes only when the contract determines one safe result from canonical state plus the explicitly allowed live observation boundary. It fails if the candidate permits any of the following:

- stale Program/Attempt/Workspace authority becoming current;
- an environmental writer outliving Host exclusion without a blocking durable fact;
- old verification surviving a recognized relevant/unknown subject change;
- replay depending on current provider/model/policy/process memory;
- a command becoming stale because of the same semantic transition that created its control receipt;
- a correctness-sensitive cut relying on an unspecified observation boundary;
- two conforming implementations making opposite safety decisions from the same canonical history.

---

## 2. Authority ledger

| Fact | Canonical authority | Must not be replaced by |
|---|---|---|
| Program semantic/control state | Program canonical history + deterministic reducer | Agent assertion, transcript text |
| Program mutation currency | `ProgramState.revision` | Workspace counters |
| Current execution claim | `ProgramAttemptId` | session identity, timeout lease |
| One external operation/effect | `operationId` + operation effect/reconciliation history | Program base-advance event |
| Host-known Workspace-effect lineage | derived `WorkspaceEffectGeneration` | observed byte difference |
| Checked covered Workspace state | `ExecutionObservationIdentity` at a defined cut | watcher silence, CodeRevisionToken |
| Historical writer containment/quiescence | request-time operation-local contract + canonical quiescence proof | current provider registry |
| Verification currency | per-obligation `subjectGeneration` | ArtifactRef identity, Workspace generation |
| Artifact bytes | ArtifactStore / ArtifactRef | Program evidence admission |
| Rebase authorization | exact Application acceptance of one current mismatch candidate | Agent/model assertion |
| Cancellation/completion | serialized Host terminal admission | Agent idle/completion claim |

The review found no need to change this authority split. Every defect was a missing composition rule between already-selected authorities.

---

## 3. Pinned-candidate attack matrix

| ID | History attacked | Result on `9d430f55...` |
|---|---|---|
| H01 | duplicate/distinct acceptance of one creation draft across crash | PASS |
| H02 | idle/explicit-stop versus pending creation acceptance | PASS |
| H03 | first dispatch after planning-base change | PASS |
| H04 | stale-low / stale-high Program revision and old Attempt ABA | PASS |
| H05 | root operation request after covered Workspace drift | **FAIL — F1** |
| H06 | Workspace-dependent read with external edit during execution | **FAIL — F1** |
| H07 | confirmed current-attempt mutation with complete post-state | PASS |
| H08 | failed/timed-out mutation with indeterminate effect | PASS |
| H09 | confirmed effect before writer quiescence, then Host crash | **FAIL — F2 admission scope** |
| H10 | cancellation while detached writer remains possible | **FAIL — F2** |
| H11 | external drift → rebase → crash before verification invalidation | **FAIL — F3** |
| H12 | causal-only generation mismatch with unchanged observation | PASS |
| H13 | external ABA detected then bytes restored | PASS; old Attempt remains dead |
| H14 | external ABA entirely between equal checked observations | PASS as explicit guarantee limitation |
| H15 | verification G1 → relevant mutation → retained identical ArtifactRef | PASS when invalidation is canonical |
| H16 | current-generation waiver → relevant mutation | PASS when invalidation is canonical |
| H17 | completion versus cancellation | PASS |
| H18 | completion after covered drift not yet directly observed | **FAIL — F1** |
| H19 | legacy event replay after optional Program envelope extension | PASS |
| H20 | provider replacement after historical `may_write` operation | PASS |
| H21 | active mismatch whose interruption changes Program revision | **FAIL / ambiguous — F4** |
| H22 | delete projections and rebuild without current model/provider registry | PASS where transitions were fully specified |

---

# 4. Findings against the pinned candidate

## F1 — P1 — Freshness-sensitive cuts were named but not closed

The consolidation said “at any freshness-sensitive cut” without defining the full first-slice set. That allowed a conforming implementation to omit direct Workspace observation at load-bearing boundaries that the earlier execution studies had explicitly bracketed.

Minimal histories:

```text
A accepted at (G4,O4)
→ external edit makes O5
→ Agent requests Program-linked may_write M
→ exact P/A/revision checks pass
→ no required direct pre-observation at root-operation admission
→ M can execute while A still claims O4
```

```text
A expects O4
→ Workspace-dependent read begins
→ external edit O4→O5 during read
→ read returns
→ no mandatory post-observation
→ stale result can be treated as current Program evidence
```

```text
all canonical terminal predicates appear true at accepted (G4,O4)
→ external edit makes O5
→ no direct terminal observation required
→ no mismatch receipt yet exists
→ Completion Oracle can append `program.completed` against stale O4
```

The correction closes the first-slice cuts: first dispatch; every Program-linked root operation request; Workspace-dependent read pre/post; mutating pre and post-quiescence/post-effect; Workspace-dependent current work/evidence admission; verification satisfaction; successor/rebase bridge; and Completion Oracle terminal admission. Verification/completion acquire Workspace observation/read coordination before canonical admission and revalidate exact Program state plus G/O inside it. External writers may still race after a check; no stronger isolation is claimed.

**Status after `2619748...`: RESOLVED.**

---

## F2 — P1 — Rebuildable writer barriers did not explicitly gate ordinary Host `may_write`

The pinned candidate rebuilt a started `may_write` operation's outstanding writer barrier and blocked Program continuation, but did not explicitly require that this barrier continue to exclude ordinary non-Program Host Workspace mutation after the owning Attempt/Program reservation ended.

Minimal history:

```text
P/A owns may_write O
→ O leaves a descendant that may still write
→ Application cancels P
→ P terminal, A invalidated, Attempt reservation ends
→ O remains terminal/indeterminate-or-confirmed with quiescence unknown
→ unrelated Host may_write M requests execution
```

Without an explicit Workspace-domain barrier admission rule, M could overlap O's still-live descendant. The same gap existed after restart when replay reconstructed the barrier before any Program scheduler activity.

The correction makes every post-baseline started `may_write` without canonical quiescence an outstanding Workspace writer barrier that blocks new ProgramAttempt reservation/dispatch, ordinary Program and non-Program Host `may_write`, Workspace-based stable reconciliation, verification satisfaction, and Completion Oracle admission. Cancellation, Program terminalization, timeout, or effect classification does not clear it; only canonical quiescence proof does. Bounded diagnostic/quiescence recovery remains allowed.

**Status after `2619748...`: RESOLVED.**

---

## F3 — P1 — Rebase could become current before verification invalidation was crash-safe

Execution freshness and verification freshness are intentionally separate authorities. The pinned candidate did not order mismatch recognition, verification `subjectGeneration` invalidation, and rebase acceptance tightly enough.

Minimal history:

```text
P parked at accepted (G4,O4)
V satisfied at subjectGeneration G1 over src/a.ts
→ external edit changes src/a.ts and current observation becomes O5
→ mismatch receipt recorded
→ Application accepts exact rebase (G4,O5)
→ acceptedExecutionBase becomes current
→ crash before V invalidation / generation advance is canonical
→ reopen observes exact O5
→ no execution-base mismatch remains
→ replay still shows V satisfied at G1
→ stale verification can authorize completion
```

Replay cannot infer the missing verification transition merely from the accepted new base because `subjectGeneration` is independent authority.

The correction chooses the simpler crash-safe first-slice rule: first canonical recognition of a complete mismatch performs verification impact in the same serialized Program semantic transition. Receipt + active-Attempt interruption + all required overlapping/unknown generation invalidations are one atomic Program cut. Unknown impact invalidates fail closed. A causal-only mismatch catches up any missing Program-specific impact before rebase. Rebase may consume only a receipt whose required impact transition is complete.

**Status after `2619748...`: RESOLVED.**

---

## F4 — P2 — Program revision semantics were not closed

The pinned candidate required exact `ProgramState.revision` but did not define which effective Program transitions incremented it. An active mismatch could therefore create a receipt referring to R10 and then interrupt the Attempt in a transition that another reducer reasonably interpreted as R11, making the receipt self-stale.

Minimal ambiguity:

```text
P revision R10; Attempt A active
→ mismatch detected
→ receipt created with expectedProgramRevision R10
→ same mismatch handling interrupts A
```

One conforming reducer could advance to R11 while another remained R10.

The correction establishes revision `1` at creation and then advances revision exactly once for each effective atomic canonical semantic cut that changes ProgramState projection/control truth. Duplicate/idempotent/no-op and operation-only history that does not change ProgramState do not advance it. Active mismatch receipt + Attempt interruption + same-cut verification invalidations are one Program transition; the receipt binds the **resulting current revision**. Accepted rebase is a later transition and advances once again.

**Status after `2619748...`: RESOLVED.**

---

# 5. Rebuild-equivalence result

The review conceptually deleted derived Program/operation projections, watcher state, process memory, and current provider/model assumptions.

- F1 could not be repaired by replay because an external change never observed at a required cut leaves no fact to replay. Closing the cuts fixes the protocol rather than the reducer.
- F2 replay already reconstructed the writer barrier; the correction now closes how every admission path must consume that rebuilt truth.
- F3 replay cannot invent obligation invalidation from a new accepted execution base. The same-cut mismatch/impact transition now leaves all required truth in canonical history before rebase.
- F4 replay now has one deterministic revision rule, including one increment for multi-fact atomic Program cuts and no increment for semantic no-ops.

The surviving histories rebuild without current model output, watcher continuity, current provider registry reinterpretation, or mutable current policy as historical authority.

---

# 6. Targeted retest against `2619748df31fb0aeed750ac3d452c0fe55ffa2d1`

The correction was tested only against the findings and their neighboring invariants; it was not used to start another architecture cycle.

| Retest | Required outcome | Result |
|---|---|---|
| R1 external edit before Program root operation request | protected pre-observation detects mismatch; no stale `operation.requested` | **PASS** — §10.1 cuts 2/4 + AC-10-04 |
| R2 external edit during Workspace-dependent read | changed/unknown post-observation preserves generic history but rejects current Program evidence | **PASS** — §10.1 cut 3 + AC-10-04 |
| R3 external edit before Completion Oracle | protected direct terminal observation detects mismatch/unavailable; no `program.completed` | **PASS** — §10.1 cut 8, §14, AC-10-08 |
| R4 cancel while a `may_write` descendant may survive | Program terminalizes; barrier remains; unrelated Host `may_write` cannot cross it | **PASS** — §9, §13, AC-10-05/06 |
| R5 restart with terminal confirmed O but no quiescence proof | rebuilt writer barrier blocks ordinary Host `may_write`, verification and completion | **PASS** — §9, §15, AC-10-09 |
| R6 V satisfied G1 then overlapping/unknown external drift | mismatch recognition makes invalidation crash-safe before rebase; old G1 cannot complete | **PASS** — §10.2/10.3, §11.4, AC-10-07 |
| R7 active mismatch at R10 | one atomic mismatch/interruption/impact cut → R11; receipt binds R11; accepted rebase → R12 | **PASS** — invariants 4/17, §6, §10.2/10.3, AC-10-04 |

Neighboring regression histories also remain valid:

- **known-disjoint verification impact may retain `subjectGeneration`** because §10.2/§11.4 require invalidation only when impact overlaps or cannot be proven disjoint;
- **causal-only `(G4,O4) → (G5,O4)` retains a legal exact rebase path** through the generic mismatch receipt and conservative impact catch-up;
- **late stale-Attempt confirmed effect still advances `WorkspaceEffectGeneration`** because operation effect authority remains independent of stale Program authority;
- **shared-worktree external race/ABA remains an explicit limitation**, including races after a checked observation;
- **legacy omitted envelope fields retain historical digest/fingerprint compatibility**; none of the targeted corrections changes that migration rule.

No retest requires a new authority, new predicate taxonomy, worktree isolation, topology amendment, or implementation feature outside the consolidated Phase 1.0 candidate.

---

# 7. Affected acceptance/scenario proof surface

The targeted correction changes only the proof surface necessary to close F1–F4:

- **AC-10-02:** creation establishes revision 1.
- **AC-10-04:** deterministic revision transitions; root-operation direct base check; read pre/post; active mismatch R10→R11 receipt and R11→R12 rebase proofs.
- **AC-10-05/06:** outstanding writer barriers gate Program and ordinary Host mutation admission.
- **AC-10-07:** mismatch and verification invalidation are one crash-safe transition before rebase.
- **AC-10-08:** Completion Oracle requires protected direct terminal observation/current-base revalidation.
- **AC-10-09:** restart barrier gates ordinary Host `may_write` and performs mismatch/verification-impact processing before admission.
- **Scenarios A/B/D/E/F/G/H:** first-dispatch observation, restart writer gating, mismatch-impact-revision composition, cancellation-surviving barrier, verification invalidation before rebase, protected terminal observation, and deterministic revision rebuild.

AC-10-01, AC-10-03, AC-10-10, AC-10-11 and Scenario C required no semantic correction beyond their existing interaction with exact current revision.

---

# 8. Final review conclusion

**Result: no known P0/P1/P2 contract correctness finding remains after the bounded F1–F4 correction and targeted retest.**

The corrected candidate preserves the selected authority model and explicit shared-worktree guarantee boundary while closing the four concrete composition defects found in the pinned consolidated plan. This conclusion is review evidence only. It does not approve Phase 1.0, freeze the contract, or authorize implementation.

The next legitimate decision, after this review/correction PR is independently verified and merged, is a **separate explicit approval/freeze decision on the exact merged contract head**.