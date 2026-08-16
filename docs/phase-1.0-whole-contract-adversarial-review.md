# ALCODE Phase 1.0 — Whole-Contract Adversarial Review

**Status:** completed review evidence; not approval; not freeze; implementation not authorized  
**Pinned review subject:** `docs/phase-1.0-plan.md` as merged on `main` at `9d430f55b44d04cba664645641a78ed1814f6bc2`  
**Final targeted correction commit:** `523135f3b5c5fe6c128a6d786e89fc7084f8ccd2`  
**Method:** falsification by canonical-history attack, crash/replay analysis, authority collision analysis, rebuild equivalence, and independent review of the findings themselves  
**Scope:** the composed Phase 1.0 contract, AC-10-01 through AC-10-11, and Scenarios A through H

This review asks whether the contract permits a history in which the Host can admit stale authority, lose durable safety state, accept stale verification, produce an unrebuildable result, or leave two conforming implementations with materially different safety behavior. The original target remains pinned; later corrections do not rewrite the historical result.

The shared-worktree external-race/ABA limitation is not treated as a defect. Phase 1.0 promises boundary-checked freshness, not continuous filesystem isolation.

---

## 1. Review oracle

A history passes only when the contract determines one safe result from canonical state plus the explicitly allowed live observation boundary. It fails if the candidate permits any of the following:

- stale Program/Attempt/Workspace authority becoming current;
- an environmental writer outliving Host exclusion without a blocking durable fact;
- old verification surviving a recognized relevant/unknown subject change;
- replay depending on current provider/model/policy/process memory;
- a correctness-sensitive cut relying on an unspecified observation boundary;
- two conforming implementations making opposite safety decisions from the same canonical history.

A reviewer finding is itself subject to falsification. A proposed defect is withdrawn when the existing contract already supplies a deterministic safe history and the finding depended on conflating two distinct authorities.

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
| Mismatch provenance | `ExecutionBaseMismatchReceipt` | later command revision |
| Rebase command currency | command `expectedProgramRevision` + exact receipt/candidate | receipt's historical checked revision alone |
| Cancellation/completion | serialized Host terminal admission | Agent idle/completion claim |

The review did not change this authority split. The validated defects were missing composition rules between already-selected authorities.

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
| H21 | mismatch receipt followed by Attempt interruption/rebase | **PASS after independent review; initial F4 hypothesis withdrawn** |
| H22 | delete projections and rebuild without current model/provider registry | PASS where transitions are fully specified |

---

# 4. Validated findings against the pinned candidate

## F1 — P1 — Freshness-sensitive cuts were named but not closed

The consolidation said “at any freshness-sensitive cut” without defining the full first-slice set. That allowed a conforming implementation to omit direct Workspace observation at load-bearing boundaries explicitly bracketed by the earlier execution studies.

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

**Status after `523135f...`: RESOLVED.**

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

Without a Workspace-domain barrier admission rule, M could overlap O's still-live descendant. The same gap existed after restart when replay reconstructed the barrier before any Program scheduler activity.

The correction makes every post-baseline started `may_write` without canonical quiescence an outstanding Workspace writer barrier that blocks new ProgramAttempt reservation/dispatch, ordinary Program and non-Program Host `may_write`, Workspace-based stable reconciliation, verification satisfaction, and Completion Oracle admission. Cancellation, Program terminalization, timeout, or effect classification does not clear it; only canonical quiescence proof does. Bounded diagnostic/quiescence recovery remains allowed.

**Status after `523135f...`: RESOLVED.**

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

The correction chooses the simpler crash-safe first-slice rule: first canonical recognition of a complete mismatch performs verification impact in the same serialized Program semantic transition. Receipt + active-Attempt interruption + all required overlapping/unknown generation invalidations are admitted together. Unknown impact invalidates fail closed. A causal-only mismatch catches up missing Program-specific impact before rebase. Rebase may consume only a receipt whose required impact transition is complete.

**Status after `523135f...`: RESOLVED.**

---

# 5. Withdrawn hypothesis — F4 was not a contract defect

The first review draft classified mismatch-receipt revision behavior as P2 and argued that interruption could make the receipt “self-stale.” Independent Codex review falsified that claim.

The existing rebase contract already separates two facts:

```text
ExecutionBaseMismatchReceipt.expectedProgramRevision
→ historical Program revision whose accepted base was checked

program.execution.rebase.accept.expectedProgramRevision
→ exact current Program revision required when the later Application command is admitted
```

The command also names the exact `executionBaseMismatchReceiptId`. Therefore this history is legal without regenerating the receipt:

```text
P R10; Attempt A active
→ mismatch checked/receipt records historical R10 basis
→ A interrupted; current Program control state may now have a later revision
→ Application sends rebase command with that exact current revision + the R10 mismatch receipt id + exact candidate G/O
→ Host revalidates current command revision and exact receipt/candidate independently
```

The initial F4 reasoning conflated historical mismatch provenance with later command currency. The temporary revision-semantics changes made while investigating F4 were removed in `523135f...`; the corrected plan now explicitly preserves the two-field/two-authority distinction instead of adding an unnecessary revision protocol.

**Final classification: WITHDRAWN, not a finding.**

---

# 6. Rebuild-equivalence result

The review conceptually deleted derived Program/operation projections, watcher state, process memory, and current provider/model assumptions.

- F1 could not be repaired by replay because an external change never observed at a required cut leaves no fact to replay. Closing the cuts fixes the protocol rather than the reducer.
- F2 replay already reconstructed the writer barrier; the correction now closes how every admission path consumes that rebuilt truth.
- F3 replay cannot invent obligation invalidation from a new accepted execution base. The same-cut mismatch/impact transition now leaves all required truth in canonical history before rebase.
- The withdrawn F4 history already rebuilds because the receipt preserves its historical checked revision while the later command carries independent exact-current revision.

The surviving histories rebuild without current model output, watcher continuity, current provider-registry reinterpretation, or mutable current policy as historical authority.

---

# 7. Targeted retest against `523135f3b5c5fe6c128a6d786e89fc7084f8ccd2`

| Retest | Required outcome | Result |
|---|---|---|
| R1 external edit before Program root operation request | protected pre-observation detects mismatch; no stale `operation.requested` | **PASS** — §10.1 cuts 2/4 + AC-10-04 |
| R2 external edit during Workspace-dependent read | changed/unknown post-observation preserves generic history but rejects current Program evidence | **PASS** — §10.1 cut 3 + AC-10-04 |
| R3 external edit before Completion Oracle | protected direct terminal observation detects mismatch/unavailable; no `program.completed` | **PASS** — §10.1 cut 8, §14, AC-10-08 |
| R4 cancel while a `may_write` descendant may survive | Program terminalizes; barrier remains; unrelated Host `may_write` cannot cross it | **PASS** — §9, §13, AC-10-05/06 |
| R5 restart with terminal confirmed O but no quiescence proof | rebuilt writer barrier blocks ordinary Host `may_write`, verification and completion | **PASS** — §9, §15, AC-10-09 |
| R6 V satisfied G1 then overlapping/unknown external drift | mismatch recognition makes invalidation crash-safe before rebase; old G1 cannot complete | **PASS** — §10.2/10.3, §11.4, AC-10-07 |
| R7 mismatch receipt followed by Program-control change | receipt preserves historical checked revision; rebase command independently uses exact current revision + exact receipt/candidate | **PASS** — §10.2/10.3 + AC-10-04 |

Neighboring regression histories remain valid:

- known-disjoint verification impact may retain `subjectGeneration`;
- causal-only `(G4,O4) → (G5,O4)` retains a legal exact rebase path;
- late stale-Attempt confirmed effect still advances `WorkspaceEffectGeneration` because operation effect authority is independent of stale Program authority;
- shared-worktree external race/ABA remains an explicit limitation, including races after a checked observation;
- legacy omitted envelope fields retain historical digest/fingerprint compatibility.

---

# 8. Affected acceptance/scenario proof surface

The validated F1–F3 corrections affect only the proof surface needed for those defects:

- **AC-10-04:** root-operation direct base check; read pre/post; protected completion observation; receipt historical revision versus independent current rebase-command revision.
- **AC-10-05/06:** outstanding writer barriers gate Program and ordinary Host mutation admission.
- **AC-10-07:** mismatch and verification invalidation are crash-safe before rebase.
- **AC-10-08:** Completion Oracle requires protected direct terminal observation/current-base revalidation.
- **AC-10-09:** restart barrier gates ordinary Host `may_write` and performs mismatch/verification-impact processing before admission.
- **Scenarios A/B/D/E/F/G:** first-dispatch observation, restart writer gating, mismatch-impact composition, cancellation-surviving barrier, verification invalidation before rebase, and protected terminal observation.

AC-10-01/02/03/10/11 and Scenarios C/H required no new semantic authority from this correction.

---

# 9. Final review conclusion

**Result: no known P0/P1/P2 contract correctness finding remains after the validated F1–F3 corrections, F4 withdrawal, and targeted retest.**

The corrected candidate preserves the selected authority model and explicit shared-worktree guarantee boundary while closing the three concrete composition defects found in the pinned consolidated plan. This conclusion is review evidence only. It does not approve Phase 1.0, freeze the contract, or authorize implementation.

The next legitimate decision, after this review/correction PR is independently verified and merged, is a **separate explicit approval/freeze decision on the exact merged contract head**.