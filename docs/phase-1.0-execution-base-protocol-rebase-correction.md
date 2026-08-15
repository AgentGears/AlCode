# Phase 1.0 Execution-Base Protocol Study — Rebase Trigger Correction

**Status:** incorporated correction to PR #41 execution-base protocol study  
**Approval:** non-normative planning only; not approved; not frozen; implementation not authorized

**Precedence:** this correction controls wherever `docs/phase-1.0-execution-base-protocol-study.md` or `docs/phase-1.0-execution-base-protocol-review-corrections.md` requires an observation-`driftReceiptId` as the only basis for execution-base reauthorization.

It does not amend the governing Phase 1.0 plan or authorize implementation.

---

## 1. Problem

The initial study correctly makes the accepted Program execution base two-dimensional:

```text
Program accepted base = (WorkspaceEffectGeneration G, ExecutionObservationIdentity O)
```

and requires successor dispatch to fail when either dimension is no longer current.

However, the proposed rebase command used a mandatory:

```text
driftReceiptId
```

while the study defined a drift receipt only for:

```text
current complete observation Ocur != accepted observation Oexp
```

That is incomplete because causal lineage can change while the covered observation remains byte/semantic-state equal.

Canonical history already includes the supported case:

```text
Program parked at (G4,O4)
→ unrelated Host may_write operation executes
→ operation effect confirmed
→ WorkspaceEffectGeneration G4→G5
→ covered post observation is still O4
→ Program later resumes
```

The Program's accepted base is stale because:

```text
accepted G4 != current G5
```

but there is no observation-drift receipt because:

```text
accepted O4 == current O4
```

If `driftReceiptId` is the only accepted rebase basis, the Program has no legal path to accept `(G5,O4)` and can only be cancelled. That contradicts the selected two-axis model.

---

## 2. Corrected concept: ExecutionBaseMismatchReceipt

Replace the rebase prerequisite conceptually with a generic durable **execution-base mismatch receipt**.

Illustrative shape:

```ts
type ExecutionBaseMismatchKind =
  | "observation_mismatch"
  | "causal_generation_mismatch"
  | "causal_and_observation_mismatch";

interface ExecutionBaseMismatchReceipt {
  receiptId: string;
  programStateId: ProgramStateId;
  expectedProgramRevision: number;
  acceptedWorkspaceEffectGeneration: number;
  acceptedObservationIdentity: ExecutionObservationIdentity;
  currentWorkspaceEffectGeneration: number;
  currentObservationIdentity: ExecutionObservationIdentity;
  kind: ExecutionBaseMismatchKind;
  checkedAt: string;
}
```

Exact schema/event spelling is implementation design.

The semantic requirement is:

> **Whenever a Program's accepted execution base cannot be used because a complete current checked base differs in either the causal or observation dimension, the Host records one durable current execution-base mismatch basis that can be explicitly accepted by the Application.**

---

## 3. Receipt taxonomy

### 3.1 Observation mismatch only

```text
accepted (G5,O5)
current  (G5,O6)
→ kind = observation_mismatch
```

Typical cause: covered external edit with no Host-confirmed Workspace operation.

No fake Host generation is created.

### 3.2 Causal generation mismatch only

```text
accepted (G5,O5)
current  (G6,O5)
→ kind = causal_generation_mismatch
```

Typical cause: unrelated Host-confirmed `may_write` operation whose covered current-checkout observation happens to remain equal.

The Program still needs explicit execution-base reauthorization because its accepted causal base is not current.

### 3.3 Both dimensions mismatch

```text
accepted (G5,O5)
current  (G6,O6)
→ kind = causal_and_observation_mismatch
```

One receipt is sufficient; do not require separate rebase flows for the two axes.

---

## 4. Unknown observation is not an acceptable rebase target

If current observation is incomplete/unknown:

```text
current G known
current O unknown
```

then no new trusted execution base exists yet.

The Host may durably expose an `execution_base_unavailable`/blocked diagnostic, but the Application cannot accept a new base until a later protected direct observation is complete.

Once a complete current base exists, the Host emits/updates a durable mismatch basis for the exact candidate `(Gcur,Ocur)`.

Do not let an Application command turn `unknown` into an accepted observation.

---

## 5. Corrected rebase command

Conceptual command:

```ts
program.execution.rebase.accept {
  programStateId;
  expectedProgramRevision;
  executionBaseMismatchReceiptId;
  acceptedWorkspaceEffectGeneration;
  acceptedObservationIdentity;
}
```

Replace the initial study's mandatory `driftReceiptId` with the generic receipt/control identity.

Rules remain:

```text
Agent cannot authorize
Application/user authority required
exact current Program revision/control identity required
receipt is single-consumption/idempotent
accepted G/O must exactly equal the receipt's complete checked current candidate
later Workspace change before dispatch makes acceptance stale
rebase does not alter objective/topology/verification requirement definitions
```

---

## 6. Receipt authority and attribution

The receipt authoritatively means only:

> at checked cut C, the Program's previously accepted execution base was not the exact current complete execution base.

For an observation mismatch it does not claim:

```text
who changed the Workspace
when the first change occurred
whether external ABA occurred
```

For a generation mismatch it can reference the canonical generation/effect lineage that made `G` current, but it still does not assert that every covered byte difference was caused by those Host operations.

---

## 7. Active-attempt behavior

If a complete mismatch is detected while a ProgramAttempt is active outside a legitimate current-attempt post-effect base-advance window:

```text
record execution-base mismatch receipt
→ interrupt/invalidate current attempt
→ no new current Program operation/evidence/verification/completion claim from old attempt
```

This generalizes the earlier drift-only wording.

In normal architecture an unrelated Host `may_write` operation cannot cross an active ProgramAttempt reservation, so causal-only mismatch while active should be rare and indicates a late/recovered effect or another explicitly modeled transition. It is still handled fail-closed.

---

## 8. Parked Program resume behavior

For a parked Program:

```text
accepted B = (Gexp,Oexp)
→ scheduler considers resume
→ protected direct current base Bcur = (Gcur,Ocur)
```

Then:

```text
Bcur == B
→ eligible for ordinary successor-attempt admission

Bcur != B in either dimension
→ no dispatch
→ durable execution-base mismatch receipt
→ Application may accept exact Bcur
→ later scheduler rechecks exact accepted Bcur
→ fresh ProgramAttemptId only on exact match
```

This is the same creation/rebase bridge pattern for both axes.

---

## 9. Required negative proofs

```text
Program accepted (G4,O4)
→ unrelated confirmed may_write operation
→ current (G5,O4)
→ causal_generation_mismatch receipt exists
→ Application accepts (G5,O4)
→ final recheck matches
→ fresh attempt may dispatch
```

```text
Program accepted (G4,O4)
→ external edit
→ current (G4,O5)
→ observation_mismatch receipt
→ same rebase command family
```

```text
Program accepted (G4,O4)
→ Host effect + external edit
→ current (G5,O5)
→ combined mismatch receipt
→ one exact rebase authorization
```

```text
current G5 but observation unknown
→ no acceptable execution-base candidate
→ rebase accept rejected
```

```text
receipt says candidate (G5,O4)
→ later current base becomes (G5,O5) or (G6,O4)
→ receipt/acceptance stale
→ no dispatch
```

```text
old mismatch receipt consumed
→ retry identical command
→ duplicate/idempotent result
→ no second authority transition
```

---

## 10. Acceptance-criterion consequence

If later consolidated:

### AC-10-04 / AC-10-05

Prove successor dispatch rejects mismatch in **either** execution-base dimension and that exact accepted rebase is rechecked before fresh attempt admission.

### AC-10-10

Expose a generic `rebase_required` / execution-base mismatch projection containing the bounded current candidate and reason, rather than a UI contract that assumes all rebase requirements came from observation drift.

---

## 11. Corrected terminology

Where the initial study says:

```text
drift/rebase gap
```

for terminal/scheduler currentness, read the broader contract as:

```text
execution-base mismatch / rebase gap
```

Observation drift is one cause. Causal-generation divergence is another.

The preferred architecture remains unchanged: rebase is explicit Application authorization to continue the immutable Program contract from an exact new current execution base, followed by a fresh ProgramAttempt after final revalidation.
