# ALCODE Truth-Boundary Invariants and Cross-Runtime Implications — 2026-09-15

**Status:** Architecture review note; current-state guidance, not a frozen objective contract  
**Repository head reviewed:** `main@4c324c9b34d500ff103dd7afd93fcf08d5c0a30b`  
**Closed product baseline:** A2/S-04 at `eed99c2fde14e4e0e981c67b873fb91db3ed3c5f`  
**Current successor work:** A5 forcing study, candidate plan, and design-review resolution are landed as documentation only; A5 remains **NOT FROZEN / NO IMPLEMENTATION AUTHORITY**.  
**Authority:** This note clarifies architectural reasoning and successor-review discipline. It does not amend the Constitution, freeze A5, or authorize implementation.

---

## 1. Why this note exists

ALCODE's architecture now separates enough distinct kinds of durable truth that future work can no longer safely use generic language such as "the agent did X" or "the operation succeeded" without identifying which authority or evidence boundary is meant.

The closed runtime already distinguishes durable objective semantics, renewable execution authority, replaceable cognition, reconstructable inference provenance, Host Operations, external-effect truth, verification, and final completion. A5 then adds a candidate physical execution-world generation below those authorities.

The review discipline for A5 and later A6–A10 should therefore reason explicitly about **truth boundaries**: what a record proves, what it does not prove, which component may create it, and at which serialized boundary mutable authority must be revalidated.

---

## 2. The current truth and authority stack

The useful decomposition is:

```text
Intent truth
  ProgramState / ProgramRevision / WorkItem generation

Renewable execution authority
  ProgramAttempt

Worker identity
  Agent generation

Cognition causality
  InferenceEpoch

Environmental action identity
  Host Operation

External-world truth
  execution outcome / effect status / reconciliation

Quality truth
  Host verification

Completion truth
  Completion Oracle

Physical execution-world identity (A5 candidate)
  executionWorldGenerationId
```

These are related but not interchangeable.

For example:

```text
model wanted X
    ≠ Host admitted X

Host admitted X
    ≠ external effect X occurred

provider invocation was prepared
    ≠ provider invocation definitely occurred

Operation returned
    ≠ mutation is known to have occurred or not occurred

verification passed
    ≠ the Program is automatically complete

InferenceEpoch identifies causality
    ≠ InferenceEpoch grants execution authority

executionWorldGenerationId identifies a physical world
    ≠ that identity authorizes a capability by itself
```

This separation is one of ALCODE's primary correctness properties and should become stricter, not looser, as execution becomes more isolated, reusable, parallel, delegated, or remote.

---

## 3. General architectural laws derived from the current runtime

### 3.1 Admission Atomicity

> **Any mutable condition used to authorize a canonical transition must be validated inside the same serialized admission boundary that commits that transition.**

The unsafe shape is:

```text
validate authority
      ↓
await policy / lookup / approval / transport
      ↓
canonical mutation
```

If the authority can change during the intervening work, the earlier check is only historical evidence. It is not the check that authorized the durable fact.

The safe shape is:

```text
canonical admission boundary
      ↓
recognize replay/idempotency when applicable
      ↓
validate current mutable authority
      ↓
commit the authoritative transition
```

This law applies to more than one subsystem. Successor work should apply it to:

- current `ProgramAttempt`;
- WorkItem generation;
- Agent generation;
- execution-base identity;
- dynamic capability/provider generation;
- approval validity;
- transcript admission;
- verification subject generation;
- A5 execution-world generation;
- future A7 workspace/integration generation;
- future A8 delegation authority;
- future A9 worker lease/incarnation;
- future scheduler admissions.

The existing hard rule that transcript validation and append are one Host critical section is one concrete instance. A5's candidate immutable generation-bound execution binding is another.

A standard architecture-review question should be:

> **What can change after this validation but before the authoritative write?**

If the answer is "something that affects authority or meaning," either the validation must move into the canonical admission boundary or an immutable admitted binding must make later change irrelevant to the already-admitted operation.

---

### 3.2 Evidence Preservation

> **Failure must not discard observations already obtained from an external system.**

A result channel that returns provenance only on successful completion is semantically too weak for an uncertainty-aware runtime.

External interaction can produce evidence and still fail:

```text
request sent
      ↓
provider/native identifier observed
      ↓
stream truncates / transport fails / process dies
```

The failure is real, but so is the observation.

ALCODE already uses this principle for environmental Operations by separating execution outcome from effect status and reconciliation. The same epistemic model should apply to provider invocations, execution-provider lifecycle transitions, remote workers, deployment APIs, Git/network operations, and any other external boundary.

A useful semantic result shape is conceptually:

```text
ExternalAttemptResult
  outcome
  observations[]
  output?
```

where observations survive failure and can strengthen later reconstruction without pretending the external action completed successfully.

---

### 3.3 Replay Before Revalidation

> **An already-admitted idempotent request should be recognized before testing one-shot preconditions that its successful admission may have consumed.**

A common unsafe ordering is:

```text
validate current one-shot authority
      ↓
check whether the same request already committed
```

After a successful commit, the world may legitimately no longer satisfy the original precondition. An ACK can still be lost. A replay must therefore be judged first against the durable idempotency/admission record.

Conceptually:

```text
canonical admission
      ↓
already admitted under this idempotency identity?
      ├─ yes → return/reconstruct original acknowledgement
      └─ no  → validate current authority
                    ↓
                  append
```

This rule becomes increasingly important across unreliable transports, isolated providers, remote workers, and future distributed execution.

---

### 3.4 Uncertainty Is First-Class Epistemic State

> **A pre-action record, requested action, timeout, cancellation, lost process, or lost transport must never be promoted into stronger external truth than the Host actually observed.**

The same structure appears at multiple layers:

```text
provider invocation prepared
      ≠ invocation definitely occurred

execution-world activation prepared
      ≠ provider definitely created/activated the world

operation started
      ≠ mutation definitely completed

teardown requested
      ≠ world definitely ceased to exist

remote worker lost
      ≠ remote mutation definitely did not occur
```

A5's candidate activation/teardown uncertainty model is therefore not an isolated special case. It is a continuation of the same epistemic execution model already used by ADR 0003 and A2.

---

### 3.5 Provenance and Identity Never Imply Authority

> **Durable identity may explain causality, provenance, trust, or exact generation without becoming a capability token.**

This applies uniformly:

```text
ProgramRevision identity
    identifies semantic intent
    ≠ grants execution

InferenceEpoch
    identifies exact cognition causality
    ≠ grants execution

provider toolCallId
    identifies provider-level causal lineage
    ≠ grants Host capability execution

OperationId
    identifies a Host Operation
    ≠ proves the external effect

executionWorldGenerationId
    identifies the physical world admitted for A5 execution
    ≠ grants capability authority

future procedure/package digest
    identifies exact reusable code/contract generation
    ≠ grants ProgramAttempt authority
```

This law is especially important if ALCODE later adopts reusable procedure packages, artifact qualification, remote workers, or stronger trust identities.

---

## 4. ALCODE's epistemic execution model

The common pattern across A2, Operations, and the A5 candidate is:

```text
intent / preparation
      ↓
external observation boundary
      ↓
what evidence was actually observed?
      │
      ├─ affirmative evidence → record only that evidence
      └─ missing/ambiguous evidence → preserve uncertainty
```

This is stronger than ordinary failure handling. It means durable state represents **what the Host can legitimately know**, not merely what code paths returned.

That principle should remain consistent across:

- provider dispatch;
- tool/process dispatch;
- filesystem mutation;
- execution-provider activation and teardown;
- Git/network APIs;
- deployment systems;
- future procedure execution;
- future remote workers;
- future delegated Agents.

---

## 5. Implications for A5–A10

### A5 — execution providers

The candidate A5 design already incorporates two important consequences:

1. provider activation/teardown use uncertainty-aware evidence rather than configuration intent as proof;
2. an admitted Operation captures an immutable binding to the exact execution-world generation so provider replacement cannot transparently retarget already-admitted execution.

A5 review should additionally apply Admission Atomicity and Replay Before Revalidation to every lifecycle/admission transition that can be retried or race provider generation replacement.

### A6 — reusable procedures

A reusable procedure should eventually have exact artifact identity and qualification evidence, but neither package identity nor trust should imply invocation authority.

A likely future shape is:

```text
ProcedurePackage
  package/content digest
  semantic version
  typed entry/exit contract
  declared capability/effect requirements
  qualification evidence bound to exact digest
```

Invocation still requires current Host authority under the exact ProgramAttempt and capability policy.

### A7 — parallel workspaces

Parallelism should multiply independently identified execution domains, not weaken same-workspace serialization. Integration must create a new execution/verification subject; verification on one branch/worktree does not automatically verify the integrated workspace.

Admission Atomicity must apply to workspace-generation and integration-generation fences.

### A8 — durable delegation

Delegation identity should remain durable work identity while Agents remain replaceable workers. Delegation must carry an authority ceiling rather than mint independent authority.

### A9 — remote execution

A9 turns the A2-style race into a distributed-systems requirement:

```text
worker receives lease/generation
      ↓
Program/workspace authority changes
      ↓
network delay
      ↓
stale worker submits result or mutation
```

The Host must validate current authority at canonical admission and preserve remote-attempt evidence separately from effect truth. Transport retries require replay-first idempotency semantics.

### A10 — autonomous scheduling

The scheduler may choose *what to try next* but must never become the source of Program, effect, verification, or completion truth. Scheduler policy remains above Host state machines, never beside them as a second control plane.

---

## 6. Comparative implication from NodeChain

The NodeChain comparison is useful because the two systems optimize different durable units while sharing the belief that the model must not be execution truth.

```text
NodeChain
  primary durable/reusable unit: governed capability / Harness Node

ALCODE
  primary durable/autonomous unit: Program / WorkItem generation
```

The useful direction is compositional rather than substitutive:

```text
Program / WorkItem
      ↓ requires
Governed reusable capability / procedure
      ↓ admitted under
ProgramAttempt authority
      ↓
Host Operation
      ↓
execution provider
```

Concepts worth importing into ALCODE's future procedure layer include:

- exact reusable package/content identity;
- typed semantic contracts;
- qualification/evaluation bound to the exact package digest;
- trust identity separate from per-invocation authority;
- stronger physical isolation evidence.

Concepts ALCODE should preserve above that layer include:

- durable adaptive Program semantics;
- WorkItem generations;
- renewable ProgramAttempt authority;
- execution-base freshness;
- replaceable Agent generations;
- inference-level causal provenance;
- verification freshness;
- independent Completion Oracle.

A reusable-capability substrate should therefore sit **below** Program semantics, not replace the Program model with a static node graph.

---

## 7. Maturity boundary

Documentation should continue distinguishing landed guarantees from active design work.

### Landed / closed

- append-only canonical event history and rebuildable projections;
- ProgramState / ProgramRevision / WorkItem generation;
- ProgramAttempt renewable authority;
- Host Operations and effect uncertainty/reconciliation;
- Host verification and Completion Oracle;
- replaceable Agent runtime;
- S-02 bounded Code Mode;
- A2/S-04 reconstructable non-authorizing inference provenance.

### Landed as design documentation only

- A5 forcing study;
- A5 candidate execution-provider plan;
- A5 design-review corrections.

### Not yet closed product capability

- general physical execution-provider isolation;
- governed reusable procedure lifecycle;
- isolated parallel workspaces;
- durable delegation/subagents;
- remote workers;
- autonomous policy scheduling.

Do not describe candidate designs as implemented merely because the documents are merged.

---

## 8. Review checklist for successor objectives

For every new canonical transition, external boundary, reusable artifact, worker, or execution provider, reviewers should ask:

1. **What durable identity is this record about?**
2. **What exactly does the record prove?**
3. **What stronger claim does it explicitly not prove?**
4. **Which component is authorized to create the canonical fact?**
5. **Which mutable authorities can change before commit?**
6. **Are those authorities validated inside the committing serialization boundary?**
7. **If the request is a replay, is prior admission recognized before consumable preconditions are revalidated?**
8. **Can failure discard observations already obtained externally?**
9. **Can timeout/process/transport loss be confused with proof of absence?**
10. **Can an identity, trust label, provenance record, or package digest accidentally become an authority token?**
11. **Can provider/worker replacement transparently retarget already-admitted execution?**
12. **Can a lower layer claim verification or completion that belongs to a higher Host authority?**

If any answer is ambiguous, the design is not yet precise enough for a frozen acceptance contract.

---

## 9. Relationship to authoritative documents

This note does not replace existing normative sources.

- `docs/constitution.md` remains the frozen architectural foundation.
- `docs/rules.md` remains the operational hard-rule surface.
- `docs/adr/0003-tool-operation-uncertainty-and-recovery.md` remains authoritative for Operation uncertainty/recovery.
- `docs/a2-inference-provenance-plan.md` and `docs/a2-inference-provenance-as-built.md` remain authoritative for closed A2 semantics.
- `docs/a5-execution-provider-gap-study.md`, `docs/a5-execution-provider-plan.md`, and `docs/a5-execution-provider-design-review-2026-09-15.md` remain the current A5 candidate design record.
- `docs/roadmap.md` remains the sequencing/navigation surface.

The purpose of this document is to make the cross-cutting reasoning explicit so later objectives do not rediscover the same authority, replay, and uncertainty laws independently.