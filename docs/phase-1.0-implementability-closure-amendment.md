# ALCODE Phase 1.0 — Implementability Closure Amendment

**Status:** DRAFT planning amendment; not approved; not frozen; implementation not authorized  
**Base contract:** `docs/phase-1.0-plan.md` as merged on `main` at `fea86083f419fbdac642a391bf354e7735a0d161`  
**Purpose:** close only the implementation-semantic gaps identified by the fresh-eyes implementation read without reopening the selected Phase 1.0 authority model.

## 1. Precedence and scope

This amendment controls only where the base contract is silent, ambiguous, or inconsistent with the decisions below. All unaffected Phase 1.0 plan text remains unchanged.

The exact Phase 1.0 candidate contract after this amendment is therefore:

```text
base plan at fea86083f419fbdac642a391bf354e7735a0d161
+ this amendment at its exact merged head
```

A later explicit approval/freeze decision must identify both exact revisions, or a later consolidation commit that incorporates them. This amendment itself does not approve/freeze Phase 1.0 and does not authorize implementation.

The closure is deliberately narrow. It addresses:

1. canonical mutation-quiescence proof semantics;
2. Host-owned `WorkspaceAccessClass` derivation;
3. same-Workspace cross-Program dispatch contention;
4. session attribution for recovery-generated canonical events;
5. `ProgramState.revision` algebra;
6. eager versus lazy verification-impact processing;
7. first-slice planning provenance, coverage, and planning-base recheck semantics;
8. Completion Oracle transcript/tool-call wording;
9. structural path aggregate population;
10. consumed-draft duplicate/stale semantics;
11. historical envelope fingerprint/digest migration proof requirements;
12. terminology collision around Host verification-operation definitions.

No new Program hierarchy, scheduler queue, filesystem isolation claim, verification predicate kind, topology amendment path, or implementation work is introduced.

---

## 2. Closure summary

| Fresh-eyes issue | Closure decision |
|---|---|
| canonical quiescence proof undefined | close the containment-contract and canonical proof event semantics in §§3–4 |
| cross-Program selection undefined | no first-slice pending dispatch queue/preemption/fairness; canonical admission wins only when free; busy requests return deterministically |
| recovery events require `sessionId` | preserve required envelope; inherit session attribution from the canonical authority being recovered; no synthetic Host session |
| parked-Program verification timing | lazy Program-local catch-up; no Workspace-wide eager rewrite of parked Programs |
| `WorkspaceAccessClass` derivation | Host-owned versioned classification; missing/unknown fails to `may_write`; provider self-report cannot downgrade |
| Program revision algebra | one revision increment per effective atomic Program semantic transition; exact transition classes closed below |
| aggregate path population | count every canonical ProgramState path occurrence after local normalization/dedup across all path-bearing collections |
| transcript/tool-call obligation vague | remove it as a separate Program completion predicate; session/transcript completion remains separately authoritative |
| planning coverage/recheck ambiguous | first slice selects tracked read dependencies only; exact versioned read-contract/result-digest recheck |
| consumed draft outcome ambiguous | same-command retry returns original result; distinct exact accept is duplicate; replaced/invalidated/mismatched draft is stale |
| optional-envelope fingerprint trap | require omission-preserving fixtures across append/recompute/migration paths |
| verification contract name collision | use `HostVerificationOperationSpecV1` for the new Program verification operation definition |

---

## 3. Host-owned Workspace access classification

### 3.1 Closed classification

The semantic first-slice classification is exactly:

```text
no_workspace_access
read_only
may_write
```

The persisted root-operation value remains immutable historical authority.

### 3.2 Where classification authority lives

`WorkspaceAccessClass` is assigned by a **Host-owned versioned capability binding/classifier contract**, not by Agent output and not by an untrusted provider assertion.

A provider may offer metadata, but that metadata is proposal/input to Host binding policy. It cannot by itself downgrade an operation from `may_write` to `read_only` or `no_workspace_access`.

A Host-owned classifier may depend on canonical invocation arguments only when the classifier/version is part of the admitted Host capability binding semantics. Classification failure, missing classification, unsupported classifier version, or ambiguous behavior fails closed as:

```text
may_write
```

For compatibility with current Phase 0 capability metadata, a Host-owned static binding may map an existing trusted `isReadOnly: true` capability to `read_only`; `false`/missing maps to `may_write` unless the Host binding explicitly and versionedly proves `no_workspace_access`.

### 3.3 Effect mapping

For Workspace effect authority:

```text
no_workspace_access → EffectStatus.not_applicable to Workspace mutation
read_only           → EffectStatus.not_applicable to Workspace mutation
may_write           → ordinary confirmed | absent | indeterminate rules
```

`no_workspace_access` is stronger than `read_only`: its result is not allowed to depend on live Workspace state. `read_only` participates in the §10 Workspace-dependent read freshness cuts when its result is used as current Program evidence.

A `may_write` binding is not eligible for ordinary Phase 1 Program execution unless it also supplies an admitted quiescence contract from §4.

---

## 4. Canonical mutation-quiescence contract

### 4.1 Separate authority

Mutation quiescence remains independent from operation outcome and `EffectStatus`:

```text
EffectStatus:
  confirmed | absent | indeterminate | not_applicable

MutationQuiescence:
  unknown | proven_quiescent
```

A terminal operation fact, timeout, cancellation signal, confirmed effect, indeterminate effect, quiet watcher, unchanged observation, caller return, or replacement provider is never quiescence proof by itself.

### 4.2 Persisted operation-local contract

Every post-baseline root `may_write` operation persists a closed `OperationQuiescenceContractV1` equivalent to:

```ts
type MutationContainmentKindV1 =
  | "operation_scoped_containment"
  | "host_lifetime_containment";

interface OperationQuiescenceContractV1 {
  version: 1;
  containment: MutationContainmentKindV1;
  proofContractId: string;          // stable Host-owned proof semantics
  proofContractVersion: number;
  containmentInstanceId: string;    // exact historical containment lifetime/resource
  providerBindingRevision?: string;
  providerGenerationId?: string;
}
```

Exact storage field names may differ, but those semantic facts are mandatory when needed to validate historical quiescence after restart.

The earlier `external_writer_may_survive` study classification is **not an ordinary executable Phase 1 Program containment mode**. If a Host binding cannot provide either admitted `operation_scoped_containment` or `host_lifetime_containment`, ordinary Program-linked `may_write` admission rejects before `operation.requested` rather than creating a writer barrier that the first slice has no guaranteed way to clear.

Legacy pre-baseline operations retain existing Phase 0 recovery semantics and participate in the Phase 1 baseline barrier exactly as the governing plan already requires.

### 4.3 Closed containment semantics

`operation_scoped_containment` means:

> the Host-authorized execution adapter guarantees that every Workspace-mutation-capable descendant/resource of this operation is inside the exact persisted containment instance, and the versioned proof contract can establish when that operation-scoped instance can no longer write.

`host_lifetime_containment` means:

> the Host-authorized provider guarantees that every Workspace-mutation-capable resource created by the operation is unable to survive the exact persisted Host/provider containment lifetime, and the versioned proof contract can establish that the historical lifetime ended.

The guarantee belongs to the Host-approved adapter/binding contract, not to arbitrary shell text or provider self-description.

### 4.4 Canonical proof event

The first-slice canonical monotonic proof event is semantically `operation.mutation_quiesced`.

Its payload is equivalent to:

```ts
interface OperationMutationQuiescedV1 {
  operationId: OperationId;
  proofContractId: string;
  proofContractVersion: number;
  proofKind:
    | "operation_containment_ended"
    | "host_lifetime_ended";
  containmentInstanceId: string;
  proofEvidenceDigest: string;
}
```

The Host admits this event only after validating the evidence against the **persisted request-time `OperationQuiescenceContractV1`** for that operation. The proof cannot be evaluated by substituting current provider metadata for historical provenance.

The event is monotonic:

```text
unknown → proven_quiescent
```

There is no reverse transition for one historical `operationId`.

Replay treats every post-baseline started `may_write` operation without this canonical proof as an outstanding writer barrier.

### 4.5 Normal, timeout, crash, and reconciliation histories

Normal return may canonically batch terminal/effect facts and `operation.mutation_quiesced` when the Host adapter already has valid proof.

Timeout/cancel may append terminal/effect facts without quiescence:

```text
timeout/cancel
→ outcome may become terminal
→ effect may be confirmed or indeterminate
→ quiescence stays unknown
→ barrier remains
```

A confirmed effect may advance `WorkspaceEffectGeneration` before quiescence. The two authorities remain intentionally separate:

```text
confirmed effect
→ G advances exactly once
→ quiescence may still be unknown
→ no trusted post-effect O/base yet
```

For `may_write`, final `EffectStatus=absent` is admissible only after canonical quiescence proof. Workspace-based reconciliation likewise waits for quiescence before taking stable reconciliation observations.

After Host restart, a historical proof evaluator may establish quiescence only through the persisted proof contract/version and containment instance. If that evaluator/version is unavailable or the evidence is incomplete, quiescence remains unknown and the existing fail-closed writer barrier remains.

### 4.6 Session attribution of quiescence proof

`operation.mutation_quiesced` reuses the root operation's canonical `sessionId`. Its producer is runtime/recovery as applicable. Reusing the root session is historical attribution and does not assert that the session is currently active or authorized.

---

## 5. Same-Workspace cross-Program dispatch contention

Phase 1.0 does not add a portfolio scheduler, fairness queue, priority system, or preemption policy.

The closed first-slice rule is:

```text
dispatch request arrives for Program P
→ revalidate P is otherwise dispatch-eligible
→ attempt to acquire the Workspace-domain ProgramAttempt reservation

if another ProgramAttempt is active:
  → admit no new ProgramAttempt
  → do not preempt
  → do not enqueue a hidden durable pending dispatch
  → return deterministic workspace_busy/not_dispatched result

if reservation is free:
  → enter canonical admission
  → revalidate current eligibility/base/reservation
  → first canonically admitted valid request mints the new ProgramAttempt
  → concurrent losers revalidate and return busy/stale as appropriate
```

When the winning ProgramAttempt ends, the Host does **not** autonomously retry previously busy Programs merely because the Workspace became free. A later event/request from an active attached execution episode may request dispatch again. This preserves the existing no-background-execution invariant.

No starvation/fairness guarantee is claimed in Phase 1.0. Within one Program, the existing deterministic eligible-work ordering remains unchanged.

AC-10-05 therefore proves serialization and deterministic contention outcome, not a hidden multi-Program queue.

---

## 6. Session attribution for recovery-generated Program events

### 6.1 Preserve the envelope

Phase 1.0 does **not** make `EventDraft.sessionId` optional and does not introduce a synthetic Host session merely to append recovery events.

A recovery-generated canonical event inherits `sessionId` from the canonical authority/provenance it is repairing or extending.

### 6.2 Closed attribution rules

```text
operation lifecycle/quiescence/reconciliation recovery
→ root operation.sessionId

orphan ProgramAttempt interruption/recovery
→ sessionId of the canonical ProgramAttempt admission/dispatch fact

Program execution-base mismatch + verification-impact recovery
→ sessionId of the canonical accepted execution-base fact being revalidated

accepted base originated at first-dispatch bridge
→ source/creation session of that base

accepted base originated from later Attempt/base adoption or rebase
→ sessionId of that canonical base/rebase fact
```

Other recovery event types must identify one exact source canonical fact in their event contract and inherit that fact's `sessionId`; “most recent session,” current UI connection, and synthetic recovery session are not admissible fallbacks.

`producer.kind = "runtime"` with the recovery component remains the event-origin authority. Inherited `sessionId` is correlation/provenance and does not imply that the referenced session is active.

If a proposed recovery transition has no deterministic source-session rule, it is not a valid Phase 1 event type until that rule is specified. Program creation always has a source session, so the defined first-slice recovery paths have a provenance root.

This closes AC-10-09 without amending the Phase 0 event-envelope nullability contract.

---

## 7. `ProgramState.revision` algebra

### 7.1 General rule

Program creation establishes:

```text
revision = 1
```

After creation, **one effective atomic canonical semantic transition that changes current `ProgramState` projection/control truth advances `ProgramState.revision` exactly once**, regardless of how many Program fields that one atomic transition changes.

Duplicate/idempotent retries that reproduce an existing result, rejected commands, semantic no-ops, projection rebuild, and operation-only history that does not alter ProgramState do not advance Program revision.

### 7.2 Transition classes that advance revision

An effective first-slice transition advances revision when it changes at least one of:

- Program lifecycle/terminal state;
- session attachment relation retained in current ProgramState;
- work-item lifecycle/current work truth;
- blocker set/state;
- active `ProgramAttempt` issuance, interruption, clearing, or replacement state;
- accepted execution base, mismatch/rebase control state, or execution-base-unavailable state represented in ProgramState;
- verification `subjectGeneration`, current satisfaction, current waiver, or verification current/stale state;
- decisive Program evidence/artifact/output-slot binding retained in current ProgramState;
- any other explicitly first-slice ProgramState field added by the final implementation contract.

A single atomic mismatch transition that records a receipt, interrupts an active Attempt, and advances multiple verification generations still advances Program revision **once**.

A current-attempt legitimate effect can advance `WorkspaceEffectGeneration` independently. Program revision advances only if the same semantic processing changes ProgramState, such as adopting a new expected execution base or invalidating verification.

### 7.3 Mismatch receipt remains historical provenance

The adversarial-review correction remains unchanged:

```text
ExecutionBaseMismatchReceipt.expectedProgramRevision
= historical Program revision whose accepted base was checked

program.execution.rebase.accept.expectedProgramRevision
= exact current Program revision when the later command is admitted
```

If mismatch/interruption processing advances Program revision, the receipt is not regenerated merely to copy the newer command revision. The rebase command names the exact receipt and independently supplies exact current revision.

---

## 8. Verification-impact timing: lazy Program-local catch-up

Workspace mutation admission does **not** eagerly rewrite every parked Program in the Workspace.

### 8.1 Current Program / current Attempt

When the current Program needs to continue after its own confirmed effect, admit current evidence, satisfy verification, or advance its expected base, the Host performs the required impact analysis before that continuation. Relevant/unknown impact advances affected `subjectGeneration`; provably disjoint complete Host impact may retain currentness.

### 8.2 Parked or detached Programs

For a Program that is not currently crossing a freshness-sensitive boundary:

```text
Workspace effect becomes canonical
→ operation/effect history + WorkspaceEffectGeneration remain canonical
→ no mandatory eager scan/rewrite of every parked ProgramState
```

At that Program's next freshness-sensitive cut, mismatch handling catches its verification state up from its accepted base to the current base before rebase/dispatch/verification/completion can proceed.

The Host may use durable complete changed-path/effect-scope facts from intervening operations to prove disjointness. If the required historical impact evidence is missing, incomplete, over-bound, or unavailable, relevance is `unknown` and affected obligations invalidate fail closed.

This is the required first-slice timing model. An implementation may optimize with eager processing for a current Program, but it must produce the same semantic result and may not require Workspace-wide eager Program rewrites for correctness.

---

## 9. First-slice planning provenance and planning-base recheck

### 9.1 Required first-slice mode

The required Phase 1.0 first-slice planning provenance mode is **tracked read dependencies**. The immutable-snapshot strategy remains a valid future/alternate architecture but is not required by AC-10-02 or `gate:1.0` in the first executable slice.

An implementation that later adds another planning provenance profile must version it and prove the same provenance/staleness invariants, but Phase 1.0 acceptance is not blocked on building both independent mechanisms.

### 9.2 `PlanningReadDependencyV1`

Every semantic planning read supplied to the Agent is performed through a stable Host-owned read contract and records a bounded dependency equivalent to:

```ts
interface PlanningReadDependencyV1 {
  readContractId: string;
  readContractVersion: number;
  canonicalArgsDigest: string;
  canonicalResultDigest: string;
  coverageIdentity: string;
  providerBindingRevision?: string;
}
```

A Host planning read contract defines:

- canonical argument normalization;
- exactly what semantic result is returned;
- deterministic result canonicalization/digest semantics;
- completeness/overflow behavior;
- any provider/coverage identity required to make later recheck meaningful.

Examples include file content/absence, directory listing, search result set, Git state query, repository configuration, and CodeIntelligence observations. A read whose semantic result cannot be represented and rechecked under a stable Host contract is not an admissible first-slice planning input.

Agent-side model reasoning never authors these dependency records. The Host creates them at read delivery time.

### 9.3 Planning coverage versus execution coverage

`planningCoverageProfile` is the versioned set of Host planning read contracts/coverage semantics permitted during planning. It is distinct from the Program's selected runtime `ExecutionObservation` profile.

The `ProgramCreationDraft` binds both:

```text
PlanningObservationIdentity / planningCoverageProfile
AND
selected runtime ExecutionObservation profile required by verification scopes
```

The Host validates each independently. “Coverage contract” in the planning sections of the base plan means the planning coverage profile, not an implicit alias for the runtime execution-observation profile.

### 9.4 Sealing and `Bplan`

The Host accumulates every `PlanningReadDependencyV1` delivered during planning, applies deterministic ordering/deduplication rules owned by the planning profile, and seals the bounded complete set only after proposal generation.

For Phase 1.0:

```text
Bplan
= acceptedPlanningBase
= the exact sealed PlanningObservationIdentity for that draft
```

This definition replaces use of an otherwise undefined shorthand.

### 9.5 Recheck procedure

Before canonical Program creation, and again immediately before first ProgramAttempt dispatch, while conflicting Host-mediated mutation is excluded:

```text
for every sealed PlanningReadDependencyV1:
  re-execute the exact readContractId/version
  with the exact canonical arguments
  under the required provider/coverage identity semantics
  → compute current canonical result digest

all dependency results/provenance equal
→ accepted planning base matches

any result differs
OR required provider/coverage identity differs incompatibly
OR read is incomplete/unknown/unsupported/over-bound
→ planning base stale/unknown
→ creation or first dispatch rejects fail-closed
```

This recheck is observational, not isolation. An arbitrary external writer may still race after the last checked read; Phase 1.0 makes no stronger claim.

Untracked planning side channels are forbidden. A planning capability that mutates the Workspace is not admissible.

### 9.6 AC-10-02 correction

The phrase “prove both planning-provenance modes” in the base AC-10-02 is superseded. The first-slice proof requirement is:

> prove the selected `tracked-read-v1` planning provenance path end-to-end, including complete Host tracking, sealing, duplicate/overflow rejection, pre-creation recheck, first-dispatch recheck, and stale/unknown failure. Any additional implementation-enabled planning profile must pass equivalent proofs, but no second profile is required for Phase 1.0 acceptance.

---

## 10. Completion Oracle transcript/tool-call boundary

The base-plan bullet:

```text
no admitted transcript/tool-call obligation relevant to the attached execution remains unresolved
```

is removed as a separate Program completion predicate.

Phase 1.0 Program terminal authority is already guarded by:

- no active ProgramAttempt;
- no Program-linked operation still `requested`/`started`;
- no blocking effect/reconciliation/writer state;
- no Program-linked retryable durable work;
- current verification and artifact predicates;
- exact terminal execution-base freshness.

Durable transcript completeness, pending conversational tool-call correlation, and reasoning `VerificationContract` state remain owned by their existing session/transcript/reasoning authorities. They do not become an additional implicit Program completion engine.

Session terminalization may independently reject/hold a session because its transcript/context is incomplete. Program completion does not rewrite that session truth.

This preserves the invariant that reasoning/transcript state is not reconstructed into Program authority.

---

## 11. Structural path aggregate population

For the Phase 1.0 hard ceilings:

```text
Total path-bearing entries <= 4,096
Total normalized path bytes <= 1 MiB UTF-8
```

The counted population is the sum of every canonical path occurrence retained in **current ProgramState path-bearing collections**, after each local collection's required normalization and deduplication.

At minimum this includes:

- every work-item affected-path entry;
- every explicit `paths(...)` verification freshness-scope entry;
- any other first-slice ProgramState field that stores normalized Workspace paths.

A `workspace` verification scope contributes zero explicit path entries.

The same normalized path appearing in two different canonical collections counts twice because both occurrences consume bounded current-state structure. `Total normalized path bytes` is the UTF-8 byte sum over that same counted occurrence population.

Operation-log-only changed-path/impact evidence does not count toward the ProgramState aggregate unless copied into current ProgramState; it remains subject to its own event/evidence bounds.

Any local or aggregate limit breach rejects the proposed semantic admission; no path list is silently truncated.

---

## 12. Consumed creation-draft outcomes

The deterministic first-slice result is:

```text
same command/idempotency retry of an already accepted draft
→ return the original accepted result / ProgramStateId

new distinct accept command naming the exact same already-consumed draft identity + digest
→ deterministic duplicate result carrying the existing ProgramStateId

accept command naming a superseded/invalidated draft,
wrong digest, wrong control identity, or a draft consumed by a different semantic identity
→ stale/reject
```

No path can create a second ProgramStateId from one draft.

This closes the base plan's “existing result or deterministic duplicate/stale decision” ambiguity without changing single-consumption authority.

---

## 13. Historical envelope fingerprint/digest migration proof

AC-10-01's historical-compatibility requirement is strengthened only into an executable proof obligation, not a new semantic authority.

When `programStateId` is added as an optional envelope field:

- a historical event that did not contain the key must canonicalize with the key **absent**;
- it must not be rewritten/recomputed as `programStateId: null`;
- it must not construct an own-property with value `undefined` and then pass it to canonical serialization;
- new Program events include the key normally.

Implementation acceptance must include populated pre-Phase-1 event fixtures proving identical historical fingerprints/digests through every code path that computes or recomputes them, including:

1. normal append/fingerprint construction;
2. integrity verification/recomputation;
3. schema migration/backfill/copy paths.

The fixture must reopen/replay successfully after migration and demonstrate that legacy event fingerprints/digests are byte-identical to their pre-migration expected values.

This explicitly prevents copying the current optional-field-as-`null` fingerprint pattern onto the new envelope field.

---

## 14. Verification-operation terminology

To avoid collision with the existing reasoning-domain `VerificationContract`, the new stable Host definition used by Phase 1 Program predicates is named semantically:

```text
HostVerificationOperationSpecV1
```

`operation_result` binds one exact stable spec identity/version plus canonical invocation arguments/digest.

Artifact production steps likewise reference the applicable stable Host operation spec rather than a reasoning `VerificationContract`.

Existing reasoning-domain verification correlation remains separate and is not terminal Program authority.

Where the base plan says “versioned Host verification-operation contract,” read it as `HostVerificationOperationSpecV1`; no behavioral change beyond terminology is intended.

---

## 15. Required implementability retest

Before this amendment can be considered closure evidence, review the amended candidate against these exact implementation questions:

```text
I1 may_write binding has no Host quiescence contract
   → operation.requested rejected before environmental execution

I2 may_write operation confirms effect but quiescence proof is absent
   → G may advance once
   → writer barrier remains
   → no trusted post-effect base / ordinary Host may_write / verification / completion

I3 Host restarts after started may_write
   → replay reconstructs exact historical containment/proof contract
   → quiescence can clear only through that persisted proof contract

I4 P1 Attempt active; P2 requests dispatch
   → no preemption/no hidden queue/no P2 Attempt
   → deterministic busy/not-dispatched result

I5 recovery interrupts orphan Attempt with no active session
   → event reuses Attempt's canonical source sessionId
   → producer identifies runtime recovery

I6 mismatch recovery on parked Program with no active session
   → event uses accepted-execution-base provenance session
   → verification catch-up completes before rebase

I7 one atomic mismatch changes receipt + Attempt + multiple verification generations
   → Program revision advances once
   → receipt retains historical checked revision
   → later rebase command supplies independent exact current revision

I8 parked P does not receive eager ProgramState rewrites for unrelated Workspace mutation
   → next freshness cut catches up impact deterministically
   → incomplete impact fails closed

I9 planning read result changes between proposal and creation/first dispatch
   → tracked dependency digest differs
   → draft/first dispatch stale; no silent rebase

I10 planning depends on an untracked or non-recheckable semantic read
   → proposal non-acceptable

I11 all local path limits pass but aggregate affected+verification paths exceed 4,096 or 1 MiB
   → admission rejects; no truncation

I12 old event without programStateId is migrated/reopened
   → original fingerprint/digest remains identical

I13 distinct second accept names exact already-consumed draft
   → duplicate result references existing ProgramStateId; no P2

I14 Program completion while transcript reducer has unrelated/pending session-level conversational state
   → Program Oracle evaluates only its explicit Program predicates
   → session/transcript terminal authority remains separately unchanged
```

A failure must identify a concrete contradictory history. Additional implementation preferences are not closure blockers.

---

## 16. Final closure decision

This amendment does not claim that Phase 1.0 is approved. Its sole purpose is to make the remaining load-bearing implementation semantics single-valued enough that an implementation plan can be derived without inventing hidden safety policy.

If the §15 retest and ordinary exact-head review find no P0/P1/P2 contract defect, the next legitimate project action is the separate explicit Phase 1.0 approval/freeze decision on the exact reviewed candidate. Implementation still does not start automatically.