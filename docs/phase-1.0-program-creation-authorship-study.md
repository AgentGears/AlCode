# ALCODE Phase 1.0 — Program Creation and Contract Authorship Study

**Status:** DRAFT / non-normative planning study  
**Approval:** not approved; not frozen; implementation not authorized  
**Repository base studied:** `main` at `ff211b5c0c7d9f93946ab6a2ad42e45a58ca693c`  
**Relationship to Phase 1.0:** studies one additional contract question exposed by the interaction between Program creation, immutable completion requirements, and the first-slice topology decision. It does not amend `docs/phase-1.0-plan.md`, change AC-10 acceptance criteria, approve/freeze Phase 1.0, or authorize implementation.

## 1. Question

The Phase 1.0 draft says the Host owns ProgramState and Program creation. The current alternatives study recommends an immutable first-slice completion contract built from universal Completion Oracle invariants plus mandatory verification requirements, and recommends no automatic Agent-originated canonical topology mutation after creation.

That leaves one material question:

> Who supplies the semantic content of the initial Program contract — objective, initial required work topology, and mandatory verification requirements — and who is authorized to accept that content before the Host makes it canonical?

“Host owns ProgramState” answers canonical ownership. It does **not** answer semantic authorship or semantic acceptance.

This study also pressure-tests two consequences of creation-time immutability:

1. the accepted draft must still match the Workspace/repository state it was planned against; and
2. acceptance must map to exactly one ProgramState even across crash/retry.

## 2. Scope

The study covers the boundary before the first `ProgramAttempt`:

- objective provenance;
- initial DAG authorship;
- mandatory verification authorship;
- Host policy additions;
- semantic acceptance authority;
- draft freshness against Workspace/repository observations;
- Host-mediated mutation races;
- exact-draft stale protection;
- canonical creation atomicity/idempotence;
- crash/replacement/reconnect behavior.

It does not decide the final verification predicate taxonomy, exact structural-limit numbers, general Program contract amendment/versioning, subagents, remote workers, or a general workflow language.

## 3. Method

For each alternative this study asks:

1. where semantic intent originates;
2. who proposes decomposition and verification;
3. who may accept those semantics;
4. what the Host can validate deterministically;
5. what Workspace/repository observation the plan is valid for;
6. what happens with in-flight mutation, stale drafts, crash, retry, replacement, replay, and reconnect;
7. whether any model/Agent gains indirect completion authority.

Correctness is a gate. A convenience advantage does not compensate for duplicate authority, stale contract admission, partial creation, duplicate creation after crash, or an unsafe environmental race.

---

# Part I — Repository facts

## 4. Current facts

### 4.1 Host canonical authority is already clear

`docs/phase-1.0-plan.md` assigns Program creation/attachment, canonical event admission, scheduling, verification admission, and terminal authority to `@alcode/host-runtime`. Program creation occurs under a Host session and records the initial attachment.

That establishes **canonical ownership**, not who authors the semantic plan.

### 4.2 The initial semantic contract is intended to be durable and immutable

The current plan makes the objective/completion contract immutable after creation. The existing open-decisions study recommends the first-slice completion contract become:

```text
immutable objective
+ immutable mandatory verification requirements
+ universal Host Completion Oracle invariants
```

If promoted, creation-time verification authorship becomes load-bearing.

### 4.3 Static first-slice topology makes initial decomposition load-bearing

The existing open-decisions study recommends no automatic Agent-originated canonical work addition after creation.

Therefore:

```text
initial required DAG
→ scheduler's required work universe
```

Initial decomposition is not just explanatory prose.

### 4.4 No Program creation protocol exists yet

The current plan names Agent proposal classes, but current `@alcode/application-protocol` has no Program creation/draft/accept command and current `@alcode/agent-protocol` has no Program creation vocabulary.

The creation boundary is therefore still a planning decision rather than an implemented contract.

### 4.5 Application Protocol already provides useful precedent

Current Application semantics establish:

- stable `commandId`;
- accepted/rejected/stale/duplicate/noop/failed decisions;
- Host-owned structured pending interactions;
- reconnect from Host snapshot/replay;
- disposable Experience Plane state;
- explicit target-sensitive stale protection.

Those patterns can be reused without moving authority into React.

### 4.6 The source objective can already have durable Host provenance

`HostApplicationService` durably admits accepted user input before delivering START_NOW work to the Agent. A Program objective can therefore mechanically refer back to a Host-owned creation command/input event rather than an Agent paraphrase.

### 4.7 Canonical event batches are atomic

`CanonicalAdmissionQueue` serializes Host state-changing append work around one Workspace event store. `WorkspaceEventStore.append()` validates the complete draft batch and writes it in one SQLite transaction.

That permits a creation cut in which the complete Program contract becomes visible atomically.

### 4.8 Application duplicate handling makes command-to-Program atomicity load-bearing

Current Application duplicate handling depends on durable command identity/effects. If Program events were committed and the accept-command decision were persisted later, this history would be possible:

```text
accept A
→ Program P commits
→ Host crashes before A is recorded handled
→ retry A
→ Host sees no prior semantic result
→ fresh ProgramStateId P2 minted
```

Therefore:

> **The accepted creation command must be durably mapped to the created ProgramStateId in the same atomic creation transaction, or Program identity must be deterministically derived from stable creation identity.**

This study prefers the atomic command→Program mapping because it composes directly with current Application idempotence.

### 4.9 Canonical admission does not serialize environmental execution lifetime

This is a critical distinction.

The current `CapabilityBroker` durably admits operation requested/started state, then runs `capability.execute()` **outside** `CanonicalAdmissionQueue`, and later admits terminal/evidence events.

So:

```text
canonical admission order
!=
environmental mutation lifetime exclusion
```

A long-running mutating operation can already be executing while another Host admission occurs. Program creation freshness cannot rely only on canonical event ordering.

### 4.10 Workspace/repository state is observation, not SQLite state

ALCODE already distinguishes canonical Host events from mutable worktree/Git/CodeIntelligence observations. There is no transaction spanning SQLite and the external repository.

A creation draft that was derived from repository state is therefore valid only relative to the bounded observation it planned against.

### 4.11 Reasoning is not ProgramState authority

Reasoning objectives, hypotheses, verification plans, model output, and CodeIntelligence observations may inform a draft, but Phase 1 explicitly keeps ProgramState and reasoning as independent reducers. None silently becomes Program truth.

---

# Part II — Role separation

## 5. Five distinct roles

### Intent originator

The caller/Application/user supplies the Program's objective.

### Semantic planner

The replaceable Agent/model is the natural component to propose repository-specific work decomposition and task-specific verification requirements.

### Policy contributor

Host policy may add deterministic, non-removable requirements independent of Agent preference.

### Semantic acceptance authority

The Application caller may authorize one **exact** proposed contract.

### Canonical authority

Only the Host may admit the accepted semantics as canonical ProgramState.

The core distinction is:

```text
Host canonical ownership
!=
Agent semantic authorship
!=
Application semantic acceptance
```

A sixth responsibility is orthogonal:

### Environmental mutation authority

The Host must coordinate Host-mediated mutating capability execution so creation freshness is not invalidated by already-running environmental work.

---

# Part III — Non-negotiable requirements

## 6. Creation invariants

### 6.1 Exact objective provenance

The canonical objective preserves caller-supplied objective text after ordinary pre-persistence safety/redaction admission. Agent titles/summaries remain advisory.

### 6.2 No Agent indirect completion authority

A replaceable Agent cannot automatically choose a weak or over-broad immutable completion burden merely because its proposal passes schema/DAG/bounds validation.

### 6.3 No hidden model-as-truth authority

Moving a model call into Host code does not make semantic adequacy deterministic. A Host-invoked model is still a proposal source.

### 6.4 Immutable active contract

Once active, first-slice objective and mandatory verification requirements cannot be silently rewritten by runtime evidence. If static topology is selected, required work topology is likewise fixed except for a separately authorized mechanism.

### 6.5 Complete atomic initial Program

Replay must never observe `program.created` without the complete accepted initial contract.

### 6.6 Crash-safe exactly-one creation

One accepted creation command maps to exactly one ProgramStateId across duplicate delivery, response loss, Host crash, and retry.

### 6.7 Exact-draft stale protection

A changed/superseded draft, policy identity, source session, or source objective invalidates old acceptance.

### 6.8 Planning-observation stale protection

A draft is bound to the bounded Workspace/repository observation used to produce it. If the base has changed or equivalence cannot be established, acceptance fails stale/fail-closed.

### 6.9 No Host-mediated mutation crossing creation finalization

Observation checks alone are insufficient because environmental mutation runs outside canonical admission.

For the preferred first-slice design:

> **Final creation acceptance may proceed only while the Host holds an exclusive Workspace mutation barrier covering Host-mediated mutating operations.**

The barrier must ensure:

- no Host-mediated mutating operation is still executing when the final planning-base observation is taken;
- no new unrelated Host-mediated mutating operation may start between that observation and the accepted-creation transaction;
- an indeterminate/unreconciled mutation fails closed rather than being treated as harmless quiescence.

### 6.10 Dispatch must reacquire environmental mutation authority

A Program may remain active for some time before dispatch. The Host therefore cannot hold the creation barrier indefinitely.

Before issuing a ProgramAttempt, the scheduler must:

1. acquire the Workspace mutation barrier;
2. ensure no other Host-mediated mutating operation is active/unreconciled;
3. recheck the accepted creation observation/base;
4. admit `program.attempt.started` only if current;
5. transfer/retain mutation authority for the ProgramAttempt so an unrelated Host-mediated mutating operation cannot begin and cross the attempt's execution lifetime.

Read-only work may remain concurrent where safe.

This is stronger than “one ProgramAttempt per Workspace”: it coordinates **all Host-mediated mutating operation lifetimes** that can affect Program correctness.

### 6.11 No false claim about external editors/processes

The Host mutation barrier controls Host-mediated capability execution, not arbitrary external repository edits.

ALCODE must not claim transactional isolation over the worktree. Planning-observation rechecks remain required, and out-of-band changes remain Workspace observations that must fail closed when they invalidate the accepted base or later verification freshness.

### 6.12 Read-only pre-Program planning

Before Program creation there is no ProgramAttempt. Creation planning may inspect bounded Workspace state, but mutating capability requests fail closed.

### 6.13 Bounded contract

Draft work, dependencies, paths, verification requirements, text, and public representation are bounded before presentation/admission.

### 6.14 No future concrete evidence identities in immutable requirements

Future ArtifactRefs or canonical evidenceRefs may later satisfy a requirement but cannot themselves be creation-time requirement identities.

### 6.15 Replacement/reconnect honesty

Pending exact drafts are Host-owned durable state, not Agent/renderer-local memory.

---

# Part IV — Alternatives

## 7. Alternative A — Application supplies the full structured contract

```text
Application supplies objective + DAG + mandatory verification
→ Host validates
→ Host atomically creates
```

**Pros:** explicit authority, simple replay, no model contract auto-admission.  
**Cons:** turns the public caller into a workflow author, weak default natural-language UX, duplicates coding-plan logic outside the Agent.

**Classification:** correct; accommodate as an advanced API, not the sole/default first-slice path.

## 8. Alternative B — Host deterministically synthesizes contract from objective text

**Pros:** simple external API, no approval interaction.  
**Cons:** arbitrary coding decomposition and task-specific verification are not deterministically derivable by the current Host; using a model internally merely relabels model authorship.

**Classification:** reject as a general solution.

## 9. Alternative C — Agent proposes and Host auto-admits

```text
objective
→ Agent plan
→ Host schema/bounds/DAG/policy validation
→ automatic Program creation
```

**Pros:** excellent autonomous UX, small interaction surface.  
**Cons:** deterministic structural checks cannot prove semantic adequacy; Agent can omit necessary verification or expand scope and thereby indirectly control the Host's future completion burden.

Failure history:

```text
objective: fix bug and preserve compatibility
→ Agent proposes edit-only work + no compatibility verification
→ structurally legal
→ Host auto-admits
→ work/verifications eventually satisfy admitted contract
```

The Host has not proven the caller's semantic requirement was represented.

**Classification:** reject as normative first-slice authority model.

## 10. Alternative D — Agent proposes; Application accepts exact fresh draft; Host atomically creates

```text
Application objective
→ Host creation request
→ Host captures planning observation B0
→ read-only Agent planning
→ Agent proposes bounded draft D for B0
→ Host validates structure/policy and adds mandatory Host requirements
→ Host persists exact pending draft H(D,B0,P0)
→ Application accepts H
→ Host acquires exclusive Workspace mutation barrier
→ waits/fails closed until Host-mediated mutation state is quiescent/reconciled
→ Host re-observes current base
→ base != B0 or unknown => stale, release barrier, no Program
→ Host revalidates draft/policy/session inside canonical admission
→ one SQLite transaction records:
     accepted command A → ProgramStateId P
     + complete initial Program event batch
→ release creation barrier unless immediately transferring to dispatch
→ Program active
```

Before first ProgramAttempt:

```text
acquire Workspace mutation barrier
→ ensure no conflicting Host-mediated mutation active/unreconciled
→ recheck accepted creation base
→ stale => no dispatch
→ current => admit ProgramAttempt
→ retain/transfer Host-mediated mutation exclusivity for attempt lifetime
```

**Pros:** natural Agent planning; Agent remains proposal source; caller accepts exact immutable burden; stale Workspace plans reject; Host-policy minima are non-removable; crash/retry maps to one Program; Host-mediated mutation cannot cross final freshness checks.  
**Cons:** one approval round trip; new Application draft/accept interaction; durable pending draft; planning-observation identity; Workspace mutation coordination; user acceptance authorizes but does not prove plan quality.

**Classification:** **preferred**.

## 11. Alternative E — canonical `planning` ProgramState then finalize

```text
program.created(lifecycle=planning)
→ iterative Agent planning
→ later program.contract.finalized
→ active execution
```

**Pros:** durable iterative planning under one ProgramStateId.  
**Cons:** adds lifecycle, revision, recovery, cancellation, interaction, and finalization semantics before current signature objective needs them; still needs semantic acceptance and mutation/freshness rules.

**Classification:** correct but defer.

## 12. Alternative F — explicit delegated auto-accept

Caller explicitly authorizes Host to accept whatever bounded Agent plan passes Host validation/policy.

**Pros:** autonomous UX, explicit delegation rather than hidden authority.  
**Cons:** caller never accepts the exact immutable burden; a poor Agent can still select a degenerate contract inside bounds.

**Classification:** accommodate/defer as later convenience mode.

## 13. Alternative G — objective-only active Program, Agent populates contract later

**Pros:** adaptive, simple initial creation.  
**Cons:** mutable completion contract, active Program without final burden, reopens post-creation Agent scope-expansion problem, requires a finalization lifecycle to become safe.

**Classification:** reject in this form.

## 14. Alternative H — second model/judge authorizes plan

**Pros:** may improve quality.  
**Cons:** another model is not deterministic semantic authority; agreement does not create an authorization principal.

**Classification:** advisory quality layer only; reject as acceptance authority.

---

# Part V — Adversarial histories

## 15. Normal preferred creation

```text
C requests Program creation with objective O
→ source intent durable
→ capture B0
→ Agent proposes D(B0)
→ Host validates + adds policy requirements
→ pending H(D,B0,P0) durable
→ Application accepts H via command A
→ Host acquires mutation barrier
→ no active/unreconciled Host-mediated mutation
→ reobserve == B0
→ atomic transaction: A→P + complete Program contract
→ Program P active
→ barrier released
```

## 16. Agent weakens the contract

```text
objective requires compatibility
→ Agent omits compatibility verification
→ Host structural checks pass
→ Application does not accept exact draft
```

Result: no canonical Program.

This protects authority, not plan quality: if the caller knowingly accepts the draft, the acceptance is authoritative but not proof that the plan is objectively good.

## 17. Agent over-expands scope

```text
objective: narrow parser fix
→ Agent adds broad unrelated cleanup
```

Bounds/DAG validation cannot prove semantic necessity. Exact scope is visible to the accepting caller rather than automatically becoming required work.

## 18. Draft superseded

```text
D1/H1 presented
→ D2/H2 replaces it
→ accept H1
```

Result: `stale`; no Program creation.

## 19. Policy changes

```text
D under P0
→ Host policy becomes P1 and adds required verification
→ accept old H(D,B0,P0)
```

Result: stale; re-present exact new contract.

## 20. Workspace changes while pending

```text
D planned against B0
→ another Program / foreground action / external edit / Git change produces B1
→ accept D
→ Host acquires mutation barrier and re-observes
```

If `B1 != B0` or equivalence cannot be proven: stale; no Program.

## 21. Long-running foreground mutation already started

Current execution shape permits:

```text
foreground mutating operation O
→ operation.started canonical
→ capability.execute() running outside admission queue
→ creation accept arrives
```

Unsafe design:

```text
creation merely re-observes current files
→ Program commits
→ O writes after observation
```

Preferred result:

```text
creation cannot acquire mutation barrier while O owns mutating execution
→ wait/reject until O is terminal and required reconciliation resolved
→ only then capture final current base and create
```

Canonical event order alone is not treated as environmental isolation.

## 22. New Host-mediated mutation tries to start during final creation

```text
creation holds Workspace mutation barrier
→ unrelated mutating capability request arrives
```

Result: it cannot begin environmental execution until the creation barrier is released. It may be rejected, queued, or delayed according to the final Host policy, but it cannot cross the protected freshness/admission window.

## 23. Mutation starts after creation but before later dispatch

```text
Program P active but not dispatching
→ foreground mutation M runs and settles
→ later scheduler considers P
```

At dispatch the Host reacquires mutation barrier and rechecks P's accepted creation base. Changed base => no ProgramAttempt dispatch. Static first-slice contract is not silently rewritten.

## 24. Long-running mutation tries to cross ProgramAttempt start

Unsafe:

```text
pre-dispatch base recheck
→ unrelated mutating O starts
→ ProgramAttempt starts
→ O writes underneath attempt
```

Preferred:

```text
scheduler acquires Workspace mutation barrier first
→ rechecks base
→ starts ProgramAttempt while retaining/transferring mutation authority
→ unrelated Host-mediated mutator cannot start until attempt relinquishes authority
```

This is the minimum Host-controlled environmental exclusion needed for the creation/dispatch freshness claim.

## 25. Out-of-band external edit

The Host barrier cannot prevent a human editor or non-ALCODE process from changing the repository.

Therefore the study makes no “transactional worktree” claim. External changes remain observations; accepted-base and verification-freshness checks fail closed when detected. A later execution contract may require additional observation checks at mutating-operation boundaries, but that is not silently assumed here.

## 26. Duplicate acceptance

```text
accept A
→ atomic transaction records A→P + Program P
→ response lost
→ retry A
```

Result: duplicate maps to existing P. No second ProgramStateId.

## 27. Crash during creation transaction

Recovery sees either:

```text
no A→P mapping and no Program batch
```

or:

```text
A→P mapping + complete Program batch
```

Never a half-created Program and never a committed Program whose accept command is forgotten.

## 28. Crash during planning

No Program exists. Replacement planning may restart from durable caller intent and a fresh planning observation. Agent-local partial plan is disposable.

## 29. Crash after pending draft presentation

Host-owned pending state must recover the exact draft/lossless reference, digest, source request, planning observation, policy identity, and source session. A regenerated different draft cannot inherit old acceptance identity.

## 30. Agent replacement

Before Host-owned draft presentation, partial Agent-local planning is discarded. After presentation, replacement Agent cannot substitute a different draft under the existing digest.

## 31. UI disconnect

Disconnect does not cancel or erase a pending draft. Reconnect uses Host snapshot/replay.

## 32. Source session stops before acceptance

First-slice rule: the pending draft becomes stale/non-acceptable. A later session requests a fresh creation flow.

## 33. Planner requests mutation before Program exists

Fail closed. Creation planning is read-only.

## 34. Future ArtifactRef/evidenceRef proposed as immutable requirement identity

Reject. Stable logical requirement semantics must exist at creation; runtime evidence later satisfies them.

---

# Part VI — Preferred contract details

## 35. ProgramCreationDraft

Illustrative semantic shape:

```ts
interface ProgramCreationDraft {
  sourceCreationRequestId: string;
  sourceObjective: string;
  planningObservation: PlanningObservationIdentity;
  workItems: ProgramCreationWorkItem[];
  mandatoryVerification: ProgramCreationVerificationRequirement[];
  policyGenerationOrDigest: string;
}
```

Draft-local keys can wire dependencies/verification before canonical IDs exist. Canonical ProgramState/WorkItem/VerificationObligation IDs are Host-minted during accepted creation.

The exact draft digest covers all semantics whose change would alter acceptance.

## 36. PlanningObservationIdentity

This is a bounded identity for the Workspace/repository facts materially used by planning. Depending on the final implementation it may include/digest:

- Git HEAD;
- dirty-worktree or bounded workspace fingerprint;
- repository configuration identity;
- bounded relevant path observations;
- CodeIntelligence revision/provider observation when relied upon;
- Host canonical source-event cut supplied to planning.

Required properties:

1. Host can determine whether the accepted planning base remains current/equivalent;
2. unknown/unavailable equivalence fails closed;
3. it remains an observation identity, not a second canonical Workspace truth system.

## 37. Mandatory verification authorship

Agent may propose task-specific deterministic requirements. Host policy may add non-removable requirements.

Host can mechanically validate:

- predicate kind/schema;
- bounds;
- freshness scope shape;
- policy minima;
- forbidden future concrete evidence identities;
- draft-key/reference integrity.

Host cannot generally prove that a finite Agent-proposed verification set is semantically sufficient for arbitrary natural-language intent. That is why semantic acceptance is a separate role.

## 38. Initial topology authorship

Agent proposes repository-specific decomposition. Host validates DAG integrity, bounds, field shapes, and policy. Application accepts the exact topology as part of the draft.

This does not give Agent a post-creation automatic `program.work.added` authority path.

## 39. Pending draft durability

An acceptable draft cannot live only in Agent/React memory. Host-owned pending state must preserve:

```text
draft or lossless bounded reference
+ digest
+ source creation request
+ planning observation identity
+ policy identity
+ source session
```

It is provenance/interaction state, not ProgramState truth before acceptance.

## 40. Atomic accepted-creation cut

One event-store transaction must durably bind:

```text
accept command A → ProgramStateId P
```

with the complete initial Program facts, conceptually:

```text
program.created
program.session.attached
program.work.added × N
program.verification.required × M
```

Exact event spelling may differ; the semantic guarantees may not.

## 41. Workspace mutation barrier

The study does not prescribe a class name or lock implementation. It requires a Host-owned coordination mechanism with these semantics:

```text
all Host-mediated mutating capability execution participates
```

and:

```text
creation-finalization owner
or
active ProgramAttempt owner
```

can exclude unrelated Host-mediated mutating operation lifetimes while freshness-critical decisions are made/executed.

The barrier spans environmental execution lifetime, not just event append. A mutating operation does not release environmental authority merely because `operation.started` was durably appended.

Read-only capabilities may remain concurrent when they cannot mutate the Workspace.

Indeterminate/unreconciled mutating operation state fails closed for creation/dispatch quiescence.

## 42. Creation/dispatch split

The barrier is not held for the entire time an inactive Program waits for a session. Instead:

```text
creation acceptance:
  acquire barrier
  → final freshness check
  → atomic Program creation
  → release
```

and later:

```text
ProgramAttempt dispatch:
  acquire barrier
  → quiescence/reconciliation check
  → accepted-base recheck
  → admit attempt
  → transfer/retain mutation ownership for attempt
```

This avoids blocking unrelated Workspace work merely because an active Program is parked, while preventing a mutator from crossing either protected boundary.

---

# Part VII — Cross-decision consequences

## 43. Completion contract

If the verification-centered completion model is promoted, this study supplies the missing creation authorship/acceptance boundary for mandatory verification requirements.

## 44. Verification freshness

Three identities remain distinct:

```text
PlanningObservationIdentity
  → was the initial semantic plan based on the current Workspace?

ProgramState revision / ProgramAttemptId
  → is this execution claim current?

verification subjectGeneration
  → is this verification satisfaction current for its obligation?
```

Do not collapse them.

## 45. Agent work addition

Accepted initial Agent planning does not reopen automatic post-creation topology mutation.

## 46. Structural bounds

Creation drafts and pending public representation use final local/aggregate bounds plus their own explicit bounded projection/draft size.

## 47. Operation correlation

Pre-Program planning operations are not ProgramAttempt operations. They remain read-only. Once a ProgramAttempt starts, normal ProgramAttempt→operation correlation applies.

## 48. Cancellation

Pre-creation draft withdrawal/expiry is Application interaction lifecycle, not `program.cancelled`. Program cancellation applies after creation.

## 49. Scheduler concurrency

The existing recommendation of one active ProgramAttempt per Workspace is **not by itself sufficient** to prevent a foreground/non-Program mutating capability from crossing Program execution.

If this creation recommendation is promoted, consolidation must also express the Workspace mutation-exclusion invariant for Host-mediated mutations. That is a refinement of environmental execution authority, not a license for multi-Program scheduling.

---

# Part VIII — Acceptance-proof consequences

## 50. AC refinements if later promoted

No new AC family is required; existing AC-10 criteria can absorb the behavior.

### AC-10-02 — deterministic model/rebuild

Prove the complete accepted objective/topology/mandatory verification contract is established at one creation cut and rebuilds without Agent/draft service state.

### AC-10-03 — session attachment

Prove initial creation attaches the current source session; stopped-session draft acceptance rejects stale.

### AC-10-05 — DAG/scheduler

Apply bounds/DAG validation to initial draft. Add proof that ProgramAttempt dispatch requires current accepted creation base and Workspace mutating-operation exclusion/quiescence.

### AC-10-08 — Completion Oracle

Runtime evidence cannot rewrite creation-time mandatory requirements.

### AC-10-09 — recovery/Agent integration

Replacement during planning cannot turn Agent-local partial state into Program truth. Pending exact drafts are Host-owned. Creation recovery preserves exactly-one mapping.

### AC-10-10 — Application projection/ownership

Add creation request/draft/accept interaction, stale/duplicate behavior, pending draft reconnect, exact command→Program mapping, and proof that UI/Agent cannot create ProgramState directly.

### AC-10-06 / operation uncertainty interaction

Creation and dispatch must fail closed while a Host-mediated mutating operation is still executing or has unresolved/indeterminate effect state relevant to Workspace mutation safety.

## 51. Required negative proofs if promoted

```text
Agent draft exists + no exact Application acceptance
→ no Program
```

```text
D1 superseded by D2
→ accept D1
→ stale
```

```text
D planned at B0
→ Workspace changes to B1
→ accept D
→ stale; no Program
```

```text
foreground mutating O already executing
→ creation acceptance tries to finalize
→ cannot cross O's mutation lifetime
```

```text
creation holds mutation barrier
→ unrelated mutating operation requests start
→ it does not begin environmental execution before barrier release
```

```text
Program active/parked
→ mutation changes accepted base
→ later dispatch rechecks
→ no ProgramAttempt
```

```text
scheduler holds mutation barrier and starts Attempt A
→ unrelated Host-mediated mutator tries to start
→ cannot cross A's mutation authority lifetime
```

```text
accepted creation transaction commits
→ response lost / Host crashes
→ accept command retries
→ same ProgramStateId returned
→ no duplicate Program
```

```text
crash during accepted-creation transaction
→ replay sees none or complete mapping+Program batch
→ never partial Program
```

```text
Agent proposes future ArtifactRef/evidenceRef as immutable requirement identity
→ reject
```

```text
pre-Program planner requests mutating capability
→ reject/fail closed
```

```text
Host/UI restart after draft presentation
→ same exact pending draft/digest/base recoverable
```

---

# Part IX — Comparison and recommendation

## 52. Comparison

| Alternative | Semantic authority | Natural-language UX | Freshness | Crash/idempotence | First-slice scope | Result |
|---|---|---|---|---|---|---|
| A. Application full contract | strong | weak default | can be strong | strong | moderate | accommodate |
| B. Host deterministic synthesis | unsupported for general tasks | good | possible | possible | misleading | reject |
| C. Agent auto-admit | weak | excellent | possible | possible | small | reject |
| D. Exact fresh Application acceptance + atomic Host create | strong | good | **strong** | **strong** | moderate | **prefer** |
| E. Canonical planning lifecycle | strong | good | strong | strong | large | defer |
| F. Delegated auto-accept | intentionally weaker | excellent | strong | strong | moderate | defer |
| G. Objective-only then mutable contract | weak | good | complex | complex | large | reject |
| H. Model/judge acceptance | no deterministic principal | good | possible | possible | moderate | advisory only |

## 53. Recommendation

**Recommend Alternative D for the first executable Phase 1.0 slice, conditional on Workspace mutating-operation exclusion at creation finalization and ProgramAttempt dispatch/execution.**

Preferred chain:

```text
caller objective
        ↓
Host-owned creation request
        ↓
planning observation B0
        ↓
read-only Agent semantic proposal
        ↓
Host deterministic validation
+ non-removable policy requirements
        ↓
Host-owned exact pending draft H(D,B0,P0)
        ↓
Application accepts exact H
        ↓
Host acquires Workspace mutation barrier
        ↓
no active/unreconciled Host mutator
+ current base == B0
        ↓
serialized atomic transaction:
  accept command → ProgramStateId
  + complete initial Program contract
        ↓
Program active
        ↓
when dispatching:
  reacquire mutation barrier
  + recheck accepted base
  + admit ProgramAttempt
  + retain/transfer Host-mediated mutation authority
```

Concise authority rule:

> **The caller authors intent; the Agent proposes semantics; Host policy may add mandatory constraints; the Application accepts the exact fresh contract; the Host alone makes acceptance and complete Program creation atomic and canonical; Host-mediated mutating execution cannot cross the freshness-critical creation/dispatch boundary.**

This is the smallest design found that preserves natural Agent planning without allowing a replaceable Agent/model to silently choose the immutable completion burden, admitting a stale repository plan, duplicating Programs after crash/retry, or relying on canonical event ordering as if it were environmental mutation isolation.

---

# Part X — Remaining dependencies

## 54. Verification requirement predicate taxonomy

Freeze-readiness still requires a closed deterministic verification-requirement predicate taxonomy that can be authored at creation without future concrete evidence identifiers or free-text truth evaluation.

## 55. Planning observation identity

The final contract must define the minimum bounded observation identity/digest sufficient to reject stale creation drafts. It should reuse existing Git/Workspace/CodeIntelligence observation substrate where sufficient rather than inventing another Workspace truth authority.

## 56. Workspace mutation barrier semantics

The review of current `CapabilityBroker` execution exposes a cross-cutting dependency that must be resolved before freeze if this recommendation is promoted:

- which Host subsystem owns the Workspace environmental mutation barrier;
- exactly when mutating operations acquire/release it;
- whether a ProgramAttempt holds it for the whole attempt or through a narrower provably safe interval;
- how cancellation, timeout, Host crash, and indeterminate/reconciliation state release or preserve exclusion;
- how foreground/Application work is rejected, queued, or delayed while Program mutation authority is held;
- how read-only operations remain concurrent.

This is not implementation authorization. It is a correctness dependency revealed by the creation study.

## 57. Out-of-band workspace edits

No Host-only barrier can prevent arbitrary external edits. The frozen contract must remain honest about that limitation and define where observation revalidation detects/fails closed on such changes without claiming a transaction across SQLite and the worktree.

## 58. Implementation details that can remain open

- exact Application command/event names;
- exact pending-draft storage/reference shape;
- draft digest canonicalization;
- command→Program mapping event spelling;
- random+atomic versus deterministic ProgramStateId as secondary defense;
- exact `PlanningObservationIdentity` fields;
- UI presentation;
- exact read-only planning allowlist.

None may weaken authority, freshness, idempotency, or environmental mutation exclusion.

## 59. Planning status

This document remains a recommendation only.

It does not:

- amend `docs/phase-1.0-plan.md`;
- supersede `docs/phase-1.0-open-decisions-study.md`;
- consolidate the artifact-evidence amendment;
- approve or freeze Phase 1.0;
- authorize implementation.

If accepted, its conclusions belong in a later explicitly authorized Phase 1.0 consolidation decision.