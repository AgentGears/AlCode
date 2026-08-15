# ALCODE Phase 1.0 — Program Creation and Contract Authorship Study

**Status:** DRAFT / non-normative planning study  
**Approval:** not approved; not frozen; implementation not authorized  
**Repository base studied:** `main` at `ff211b5c0c7d9f93946ab6a2ad42e45a58ca693c`  
**Relationship to Phase 1.0:** studies one additional contract question exposed by Program creation, immutable completion requirements, and the first-slice topology decision. It does not amend `docs/phase-1.0-plan.md`, change AC-10 acceptance criteria, approve/freeze Phase 1.0, or authorize implementation.

## 1. Question

The Phase 1.0 draft says the Host owns ProgramState and Program creation. The existing alternatives study recommends an immutable first-slice completion contract built from universal Completion Oracle invariants plus mandatory verification requirements, and recommends no automatic Agent-originated canonical topology mutation after creation.

That leaves one material question:

> Who supplies the semantic content of the initial Program contract — objective, initial required work topology, and mandatory verification requirements — and who is authorized to accept that content before the Host makes it canonical?

“Host owns ProgramState” answers canonical ownership. It does **not** answer semantic authorship or semantic acceptance.

The study also pressure-tests consequences that become load-bearing at this boundary:

- exact-draft single consumption across duplicate/racing accepts;
- crash-safe mapping from accepted creation to one ProgramStateId;
- Workspace/repository observation provenance for the proposed plan;
- Host-mediated mutation lifetime races;
- pending-draft versus Agent-idle/session-stop races;
- the limit of any freshness claim when external processes can modify the worktree.

## 2. Scope and guarantee boundary

This study covers caller intent through canonical Program creation and the observations/Host coordination immediately preceding first ProgramAttempt dispatch.

It studies:

- objective provenance;
- initial DAG authorship;
- mandatory verification authorship;
- Host policy additions;
- exact semantic acceptance;
- pending creation-request/draft lifecycle and single consumption;
- pending-draft integration with session completion/stop;
- planning-observation identity;
- Host-mediated mutation races;
- creation atomicity/idempotence;
- crash/replacement/reconnect behavior.

It does **not** claim filesystem snapshot isolation.

The precise observation guarantee is deliberately narrow:

> **A draft is bound to an identified planning observation. Before canonical creation, while conflicting Host-mediated mutating execution is excluded, the Host performs a last observation check and requires that check to match the draft's planning base. That proves what the Host last observed; it does not prove that an external editor/process could not modify the worktree after that check and before the SQLite creation transaction commits.**

The same qualification applies to a pre-dispatch observation check. It proves the last Host observation matched the accepted base; it does not prove an external writer cannot change the worktree in the check-to-execution gap.

Therefore canonical Program creation is **semantic authorization**, not a filesystem-consistency certificate. Alternative D below is suitable for promotion only together with a separately resolved attempt-time out-of-band mutation detection/fail-closed policy before Phase 1 freeze.

## 3. Method

For each alternative this study asks:

1. where intent originates;
2. who proposes topology and verification semantics;
3. who may accept those semantics;
4. what the Host can validate deterministically;
5. what observation the proposal was based on;
6. what remains true under stale draft, policy change, Agent idle, ordinary completion, explicit stop, in-flight mutation, external edit, crash, retry, replacement, replay, and reconnect;
7. whether any Agent/model gains indirect completion authority.

Correctness is a gate. Where correctness depends on a separately unresolved runtime mechanism, the recommendation is explicitly conditional instead of assuming that mechanism exists.

---

# Part I — Repository facts

## 4. Current facts

### 4.1 Host canonical ownership is already established

`docs/phase-1.0-plan.md` assigns Program creation/attachment, canonical admission, scheduling, verification admission, and terminal authority to `@alcode/host-runtime`. Program creation occurs under a Host session and records the initial attachment.

This establishes **canonical ownership**, not semantic authorship.

### 4.2 Creation-time semantics are load-bearing

The current draft makes objective/completion semantics immutable after creation. The open-decisions study recommends a first-slice completion contract of:

```text
immutable objective
+ immutable mandatory verification requirements
+ universal Host Completion Oracle invariants
```

The same study recommends no automatic Agent-originated required-work addition after creation.

If those recommendations are later promoted, initial verification requirements and the initial required DAG become part of the immutable completion burden.

### 4.3 No Program creation protocol exists yet

Current `@alcode/application-protocol` commands cover ordinary input, execution cancellation, queue promotion, and permission response. Current `@alcode/agent-protocol` has no Program creation vocabulary.

The semantic creation boundary is therefore still a planning question.

### 4.4 Application Protocol provides useful precedent

Current Application behavior already uses:

- stable `commandId`;
- accepted/rejected/stale/duplicate/noop/failed decisions;
- Host-owned structured pending interactions;
- reconnect from Host snapshot/replay;
- disposable Experience Plane state.

Those patterns can support exact Program-draft acceptance without moving canonical authority into the renderer.

### 4.5 Caller intent already has durable Host provenance

`HostApplicationService` durably admits accepted user input before Agent execution. A Program objective can therefore preserve/reference a Host-owned source command/input event rather than an Agent paraphrase.

### 4.6 Canonical event batches are atomic

`CanonicalAdmissionQueue` serializes Host event-store append work around one Workspace event store. `WorkspaceEventStore.append()` validates the batch and commits it in one SQLite transaction.

That permits complete initial Program facts to become canonical atomically.

### 4.7 Exactly-one creation requires semantic single consumption

Command-level deduplication is not sufficient.

Unsafe crash history:

```text
accept A
→ Program P commits
→ Host crashes before A is recorded handled
→ retry A
→ fresh ProgramStateId P2
```

Unsafe distinct-command history:

```text
A1 targets pending draft D
A2 targets the same pending draft D
→ both commandIds are individually new
```

Therefore the stronger invariant is:

> **One Host-owned creation request/exact draft may be canonically consumed at most once. Consumption of that request/draft, the successful accept-command result/mapping, and the complete initial Program batch share one serialized atomic creation cut.**

A later accept targeting an already-consumed draft resolves to the existing Program result rather than minting another ProgramStateId.

### 4.8 Draft/request currentness can change while acceptance waits

A pending draft can be superseded, withdrawn, invalidated by policy, invalidated by an explicit source-session stop, or consumed by another acceptance while a caller waits for environmental mutation exclusion.

Consequently pre-wait validation is advisory only. Current request/draft/session/policy state must be revalidated inside the same canonical admission that consumes the draft and creates the Program.

### 4.9 Current Agent-idle completion has a snapshot-to-stop race

Current `HostRuntime.handleAgentMessage` handles `agent.idle` by calling `assessAndComplete(sessionId, true)`.

Current completion assessment does not know about a future pending ProgramCreationDraft. In addition, current session stop checks session state before enqueueing `session.stopped`; the check is not revalidated inside that append admission.

So merely adding “pending draft blocks completion” as a pre-check is insufficient. A possible race is:

```text
idle completion snapshot sees no draft
→ draft becomes Host-owned/current
→ stale completion path later appends session.stopped
→ newly pending draft becomes unusable
```

Phase 1 must close this by linearization, not by an earlier snapshot.

### 4.10 Canonical admission does not exclude environmental execution lifetime

Current capability execution admits requested/started facts and then executes the capability outside `CanonicalAdmissionQueue`; terminal/evidence facts arrive later.

Therefore:

```text
canonical event order
!=
environmental mutation lifetime exclusion
```

A Host-mediated mutating operation can already be executing while another canonical admission occurs.

### 4.11 Worktree/Git state is observational, not a SQLite transaction participant

The Workspace repository is not transactionally frozen by the event-store transaction. Git/files/CodeIntelligence are observation inputs, not a second canonical Program truth system.

This fact bounds what `PlanningObservationIdentity` can prove.

### 4.12 Reasoning/model output is not ProgramState authority

Reasoning state, model output, tool results, CodeIntelligence observations, and artifacts may inform a creation proposal. None becomes ProgramState truth without the relevant Host admission/authorization boundary.

---

# Part II — Authority model

## 5. Distinct roles

### 5.1 Intent originator

The Application/user supplies the objective.

### 5.2 Semantic planner

The replaceable Agent/model is the natural source of repository-specific work decomposition and task-specific verification proposals.

### 5.3 Policy contributor

Host policy may add deterministic, non-removable requirements.

### 5.4 Semantic acceptance authority

The Application caller may authorize one exact proposed contract.

### 5.5 Canonical authority

The Host alone validates canonical currentness, single-consumes the pending creation authorization, and admits ProgramState.

### 5.6 Session lifecycle authority

The Host owns session completion/stop. Pending Program creation and session terminal transitions therefore need one linearization model.

### 5.7 Environmental mutation coordinator

The Host coordinates **Host-mediated** mutating capability lifetimes around freshness-critical checks. This authority does not extend to arbitrary external processes.

The central separation is:

```text
caller intent
!=
Agent semantic proposal
!=
Application semantic acceptance
!=
Host canonical authority
```

---

# Part III — Non-negotiable requirements

## 6. Creation invariants

### 6.1 Exact objective provenance

The canonical objective preserves caller-supplied intent after ordinary pre-persistence safety/redaction. Agent titles/summaries remain advisory.

### 6.2 No Agent indirect completion authority

A replaceable Agent cannot automatically select a weak or over-broad immutable completion burden merely because its proposal passes schema/DAG/bounds checks.

### 6.3 No hidden model-as-Host authority

Moving a model call inside Host code does not make semantic adequacy deterministic. A Host-invoked model remains a proposal source unless another rule authorizes its exact semantics.

### 6.4 Complete immutable initial contract

An active Program cannot become canonically visible without its complete accepted initial objective, required topology, and mandatory verification requirements.

### 6.5 Single-consumption creation identity

Host-owned pending creation state must answer deterministically:

```text
is this exact creation request/draft current and unconsumed?
```

Only a current, unconsumed draft/request can create a Program.

### 6.6 Crash-safe exactly-one mapping

One exact accepted creation request/draft maps to at most one ProgramStateId across:

- same-command retry;
- different accept command IDs;
- concurrent accepts;
- response loss;
- Host crash;
- reconnect.

### 6.7 Canonical draft/session/policy revalidation

After any wait outside the canonical admission lane, successful creation revalidates inside that lane:

- exact draft identity/digest;
- creation request current/unconsumed;
- pending interaction current/unresolved;
- source session active/eligible;
- policy identity;
- absence of a winning supersede/withdraw/stop interaction.

That same admission single-consumes and creates.

### 6.8 Pending creation blocks ordinary idle completion — atomically

A current pending creation interaction is a Host-owned blocker to **ordinary idle-driven session completion**.

The blocker must be checked at the session terminal linearization point, not only in a prior completion snapshot.

For Phase 1:

```text
draft-presentation admission
and
ordinary idle-completion/session-stop admission
```

share the Host canonical admission lane and each revalidates current session/pending-creation state inside its own admission.

Race semantics:

```text
draft presentation wins first
→ pending interaction becomes current
→ later ordinary completion recheck sees blocker
→ no session.stopped
```

```text
ordinary completion wins first
→ session.stopped becomes canonical
→ later draft-presentation admission rechecks session
→ no acceptable pending draft is created
```

This closes the `agent.idle` snapshot-to-stop race.

### 6.9 Explicit session stop is different from idle completion

An explicit Host-authorized session stop may resolve/invalidate a pending creation interaction, but it must race acceptance on the same canonical lane.

Required order semantics:

```text
explicit stop wins
→ in one canonical cut invalidate/resolve pending draft as non-acceptable
  + append session.stopped
→ later acceptance is stale
```

```text
acceptance wins
→ atomically consume draft + create/attach Program
→ later explicit stop revalidates the now Program-attached session
→ follows ordinary Program-attached session-stop / attempt-interruption semantics
```

Pre-enqueue checks are advisory; the winning state is determined by revalidation inside canonical admission.

### 6.10 PlanningObservationIdentity is evidence of observation, not isolation

Every creation draft is bound to a bounded planning observation `B0` representing the repository/Workspace facts materially used to produce it.

Before canonical creation, while Host-mediated mutating execution is excluded, the Host performs a final observation. If that observation does not match `B0`, or equivalence cannot be established, creation rejects stale/fail-closed.

But:

```text
last Host observation == B0
```

means only that. It does **not** mean:

```text
external worktree == B0 at SQLite commit
```

because an external writer can change files after the check.

### 6.11 Host-mediated mutation exclusion at freshness-critical boundaries

Final creation observation/admission cannot cross an already-running Host-mediated mutating capability.

A Host-owned Workspace mutation barrier (name/implementation open) must ensure:

- no Host-mediated mutator is still executing when the last creation observation is taken;
- unresolved/indeterminate Host-mediated mutation fails closed for quiescence;
- no unrelated Host-mediated mutator starts before the creation admission completes.

Before ProgramAttempt dispatch, the Host reacquires the same class of exclusion and performs another observation check.

### 6.12 Host-mediated exclusion may need to span ProgramAttempt execution

If Phase 1 promises that unrelated **Host-mediated** mutators cannot race an active ProgramAttempt, the barrier must cover environmental execution lifetime rather than only `program.attempt.started` append.

The exact acquisition/release/transfer rules remain a freeze-readiness dependency.

### 6.13 No continuous external-worktree freshness claim

Neither the creation barrier nor canonical admission prevents a human editor or non-ALCODE process from changing the repository.

This study therefore proves no continuous attempt/worktree snapshot property.

A separate attempt-time out-of-band mutation detection/fail-closed contract must be selected before Phase 1 freeze if runtime correctness depends on detecting those changes.

### 6.14 Pre-Program planning is read-only

Before Program creation there is no ProgramAttempt. Creation planning may inspect bounded Workspace state; mutating capability requests fail closed.

### 6.15 Bounded contract

Draft work, dependencies, paths, verification requirements, text, and serialized/public representation are bounded before presentation/admission.

### 6.16 No future concrete evidence identity in immutable requirements

Future ArtifactRefs/evidenceRefs can later support satisfaction but cannot themselves be the creation-time identity of an immutable requirement.

### 6.17 Pending draft is Host-owned durable control state

An acceptable pending draft cannot exist only in Agent or renderer memory. Its exact semantics/currentness must survive reconnect/restart.

---

# Part IV — Alternatives

## 7. Alternative A — Application supplies the full structured contract

```text
Application supplies objective + DAG + mandatory verification
→ Host validates
→ Host creates
```

**Advantages**

- explicit semantic authority;
- simple replay/idempotence;
- no model-generated plan auto-admission.

**Disadvantages**

- caller becomes a workflow author;
- poor default natural-language coding UX;
- planning logic moves out of the Agent.

**Classification:** correct; accommodate as a possible advanced API, not the preferred default path.

## 8. Alternative B — Host deterministically synthesizes from objective text

**Advantages:** simple external API, no approval round trip.

**Disadvantages:** arbitrary repository-specific decomposition and verification are not deterministically derivable by the current Host; using a model inside Host merely relabels model authorship.

**Classification:** reject as a general first-slice solution.

## 9. Alternative C — Agent proposes and Host auto-admits

```text
objective
→ Agent proposes DAG + verification
→ Host validates schema/bounds/DAG/policy
→ Host automatically creates
```

**Advantages:** natural autonomous UX, small interaction surface.

**Disadvantages:** deterministic structural checks cannot prove semantic adequacy. A weak or over-broad Agent plan can become the immutable completion burden without an external semantic acceptance principal.

**Classification:** reject as the normative first-slice authority model.

## 10. Alternative D — Agent proposes; Application accepts exact draft; Host single-consumes and creates

Preferred semantic flow:

```text
caller objective
→ Host opens creation request R
→ Host captures planning observation B0
→ read-only Agent proposes D(B0)
→ Host validates structure/bounds/policy and adds mandatory Host requirements
→ Host canonically presents current pending draft D/H(D,B0,P0) under R
→ pending interaction blocks ordinary idle completion
→ Application accept command A targets exact D/H
→ Host acquires Host-mediated Workspace mutation exclusion
→ waits/fails closed on active/unreconciled Host mutator
→ Host performs last external observation check against B0
→ mismatch/unknown => stale, no Program
→ Host enters serialized canonical admission
→ revalidates R/D/pending interaction/session/policy
→ one atomic transaction:
     consume R/D by ProgramStateId P
     + resolve pending interaction accepted
     + record A → P
     + write complete initial Program contract + attachment
→ Program P active
```

Important qualification:

```text
last Host observation matched B0
```

is the external-state fact available to the creation transaction. The transaction does not certify that no external process wrote after that observation.

Before first ProgramAttempt dispatch:

```text
acquire Host-mediated mutation exclusion
→ ensure Host-mediated quiescence/reconciliation
→ perform another observation check against accepted planning base
→ mismatch/unknown => no dispatch
→ match => ProgramAttempt may be canonically admitted
```

Again, the check proves the last Host observation, not external filesystem isolation through the following execution interval.

**Advantages**

- preserves natural Agent planning;
- Agent remains a proposer, not semantic acceptance authority;
- exact immutable burden is accepted explicitly;
- Host policy minima are non-removable;
- one draft/request is single-consumed across racing command IDs;
- exact creation is crash-idempotent;
- pending interaction survives Agent idle;
- stale canonical request/session/policy races are closed at one admission cut;
- Host-mediated in-flight mutators cannot cross the protected observation/admission boundary.

**Disadvantages**

- adds a creation-draft/accept interaction;
- adds durable pending-draft lifecycle and session-completion integration;
- requires `PlanningObservationIdentity`;
- requires Host-mediated mutation coordination;
- does not solve arbitrary external edits after the last observation.

**Classification:** **preferred for semantic authorship/authorization, conditional on separate attempt-time out-of-band mutation semantics before Phase 1 freeze.**

## 11. Alternative E — canonical `planning` ProgramState lifecycle then finalize

**Advantages:** durable multi-turn planning under one ProgramStateId.

**Disadvantages:** adds pre-active Program lifecycle, mutable contract/finalization, recovery, cancellation, attachment, and versioning complexity; still needs semantic acceptance and observation rules.

**Classification:** coherent but defer unless durable multi-turn planning becomes a concrete requirement.

## 12. Alternative F — explicit delegated auto-accept

Caller explicitly authorizes the Host to accept whatever bounded Agent plan passes Host validation/policy.

**Advantages:** autonomous UX, explicit delegation rather than hidden authority.

**Disadvantages:** caller never accepts the exact immutable burden; Agent plan quality becomes more load-bearing.

**Classification:** accommodate/defer as a later convenience mode.

## 13. Alternative G — objective-only active Program, Agent populates contract later

**Advantages:** adaptive, simple initial create.

**Disadvantages:** makes completion contract mutable after creation and reopens post-creation Agent scope-expansion authority; requires a finalization state to become safe.

**Classification:** reject in this form.

## 14. Alternative H — second model/judge approves Agent plan

**Advantages:** may improve plan quality.

**Disadvantages:** another model judgment is not a deterministic authorization principal; model agreement does not solve canonical semantic authority.

**Classification:** advisory quality layer only.

---

# Part V — Adversarial histories

## 15. Normal preferred creation

```text
creation request R with objective O
→ capture B0
→ Agent proposes D(B0)
→ Host validates + policy-adds
→ canonical pending D/H under R
→ Agent may become idle; session remains active because pending interaction blocks idle completion
→ Application A accepts D/H
→ acquire Host-mediated mutation exclusion
→ Host last-observation check matches B0
→ enter canonical admission
→ R/D/interaction/session/policy all current
→ atomic consume(R,D) + resolve interaction + A→P + complete Program batch/attachment
→ P active
```

## 16. Agent-idle races draft presentation

Possible concurrent messages:

```text
Agent draft proposal handler
Agent idle handler
```

Required Phase 1 result is determined by canonical ordering, not handler start order.

If draft presentation wins:

```text
pending draft becomes canonical
→ ordinary completion terminal admission revalidates
→ sees pending creation blocker
→ no session stop
```

If ordinary completion wins:

```text
session stop becomes canonical
→ draft-presentation admission revalidates source session
→ does not publish an acceptable draft
```

There is no state in which an already-current pending draft is invalidated by a stale idle-completion snapshot.

## 17. Explicit stop races acceptance

```text
pending D under session S
→ explicit stop and accept A race
```

Stop first:

```text
stop admission revalidates S + D
→ atomically invalidates/resolves D and stops S
→ A later sees stale D
→ no Program
```

Acceptance first:

```text
creation admission consumes D and creates/attaches P
→ later stop admission revalidates Program-attached S
→ follows Program-attached stop/ProgramAttempt interruption semantics
→ cannot retroactively invalidate P
```

## 18. Draft superseded while acceptance waits

```text
A targets D1
→ A waits for mutation exclusion
→ D2 supersedes D1 canonically
→ barrier becomes available
```

Creation admission revalidates and rejects D1 stale. A pre-wait check does not authorize later creation.

## 19. Policy/session changes while acceptance waits

Same rule: after barrier acquisition, creation admission revalidates policy and source-session/pending-interaction currency. If either changed, old acceptance rejects stale.

## 20. Two distinct accept commands race one draft

```text
A1(commandId=1) targets D
A2(commandId=2) targets D
```

Canonical admission serializes them.

If A1 consumes D and creates P, A2 observes D already consumed and resolves duplicate/noop referencing P. Distinct command IDs do not create P2.

## 21. Same-command response loss/crash

```text
A accepted
→ atomic consume(D) + A→P + Program P commits
→ response lost / Host crash
→ A retried
```

Retry resolves to P; no second ProgramStateId.

## 22. Crash during accepted-creation transaction

Recovery sees either:

```text
D still pending/unconsumed
+ no successful A→P
+ no Program batch
```

or:

```text
D consumed by P
+ interaction resolved accepted
+ A→P
+ complete initial Program contract
```

Never a partial active Program if those facts share one transaction.

## 23. Workspace changes while draft is pending

```text
D planned at B0
→ Workspace/repository observation becomes B1
→ A accepts D
→ Host last-observation check sees B1
```

If `B1 != B0` or equivalence cannot be proven: stale/fail-closed; no Program creation from D.

## 24. Host-mediated mutation already executing

Current architecture can have:

```text
operation.started canonical
→ mutating capability.execute() still running outside admission queue
→ Program creation acceptance arrives
```

Creation cannot treat event order as quiescence. It waits/fails closed until Host-mediated mutation execution is terminal and required reconciliation is resolved, then performs its last observation check.

## 25. External write after final creation observation

Unavoidable without stronger filesystem isolation:

```text
Host-mediated mutation exclusion held
→ Host observes B0
→ external editor writes B1
→ SQLite accepted-creation transaction commits P
```

This history is **not excluded by Alternative D**.

What is true canonically is:

```text
P was semantically authorized from exact draft D bound to B0
and
the Host's last pre-creation observation matched B0
```

What is **not** established is:

```text
worktree equalled B0 at Program transaction commit
```

The Program may therefore exist canonically even though an external change crossed the observation-to-commit window. Program creation is not a claim that execution is safe against that change. Before execution, the Host observes again, and the final frozen runtime contract must separately define attempt-time out-of-band mutation detection/fail-closed behavior.

## 26. Program parked, Workspace later changes

The creation barrier is not held while an active Program waits for a session/dispatch. A later dispatch performs another observation check under Host-mediated mutation exclusion.

A mismatch prevents dispatch. A match means only that the Host's last check matched; it is not filesystem snapshot isolation.

## 27. External write after dispatch observation

```text
Host last pre-dispatch observation matches accepted base
→ external writer changes repository
→ ProgramAttempt starts
```

This is also possible without a stronger runtime mechanism.

Therefore the study does **not** describe pre-dispatch observation as proof that the worktree is unchanged at attempt start or during attempt execution. The attempt-time out-of-band mutation policy is a separate freeze dependency.

## 28. Host-mediated mutator tries to cross attempt start

This case **is** under Host control. If the frozen contract promises Host-mediated mutation isolation, the scheduler acquires environmental mutation authority before its last observation check and does not release a gap before ProgramAttempt Host-mediated mutation authority begins.

## 29. Agent replacement during planning

Before a draft is Host-owned/pending, partial Agent-local planning is disposable. Replacement Agent can re-plan from durable caller intent and a fresh observation.

Once exact D is Host-owned and pending, a replacement Agent cannot substitute a different D2 under D's identity.

## 30. Host/UI restart after draft presentation

Pending Host state recovers exact draft/lossless reference, digest, request identity, planning observation, policy identity, source session, lifecycle, and consumed ProgramStateId if applicable.

Renderer-local state is not needed to decide currentness.

## 31. Pending interaction resolved without creation

Rejection/withdrawal/defined expiry/supersession clears the creation interaction as a blocker. No `program.cancelled` fact is needed because no Program existed.

## 32. Planner requests mutation before Program exists

Fail closed. Pre-Program semantic planning is read-only.

## 33. Future ArtifactRef/evidenceRef proposed as immutable requirement identity

Reject. The creation-time requirement identifies a stable logical predicate/obligation; future evidence later satisfies it.

---

# Part VI — Preferred semantic shapes

## 34. ProgramCreationDraft

Illustrative shape only:

```ts
interface ProgramCreationDraft {
  creationRequestId: ProgramCreationRequestId;
  draftId: ProgramCreationDraftId;
  sourceObjective: string;
  planningObservation: PlanningObservationIdentity;
  workItems: ProgramCreationWorkItem[];
  mandatoryVerification: ProgramCreationVerificationRequirement[];
  policyGenerationOrDigest: string;
}
```

Draft-local keys wire work/verification before canonical Program identities exist. The Host mints canonical `ProgramStateId`, work-item IDs, and verification-obligation IDs during accepted creation.

The exact draft digest covers every semantic field whose change would alter acceptance.

## 35. Pending creation lifecycle

Host-owned Application control state needs semantics equivalent to:

```text
creation request R
  └─ current exact draft D
       ├─ pending/current
       ├─ superseded/rejected/withdrawn/expired
       └─ consumed by ProgramStateId P
```

At most one current draft exists under the first-slice request model, and a request/draft is consumed at most once.

Pending current D blocks ordinary idle completion of the source session.

## 36. PlanningObservationIdentity

This is a bounded description/digest of repository/Workspace observations materially used by planning. Final fields are open, but may include/digest:

- Git HEAD;
- dirty-worktree/bounded Workspace fingerprint;
- repository configuration identity;
- relevant-path observations;
- CodeIntelligence revision/provider observation when relied upon;
- Host canonical source-event cut supplied to planning.

Required semantics:

1. the Host can compare a later observation with the planning base;
2. unknown equivalence fails closed for creation/dispatch decisions that require a match;
3. the identity remains observational evidence, not a second canonical Workspace truth;
4. matching it never implies transactional exclusion of external writers.

## 37. Mandatory verification authorship

The Agent may propose task-specific closed deterministic verification requirements. Host policy may add non-removable requirements.

The Host can deterministically validate schema, bounds, predicate kind, parameter shape, freshness-scope shape, policy minima, draft references, and the ban on future concrete evidence identities.

The Host cannot generally prove semantic sufficiency of an arbitrary finite verification set for natural-language intent. That is why semantic acceptance is a distinct role.

## 38. Initial topology authorship

The Agent proposes repository-specific DAG decomposition. The Host validates bounds, dependency integrity, cycles, field shape, and policy. The Application accepts the exact topology as part of D.

This does not grant Agent post-creation automatic `program.work.added` authority.

## 39. Accepted-creation transaction

One serialized event-store transaction atomically establishes:

```text
R/D:
  pending/current → consumed by P

pending interaction:
  unresolved → accepted/resolved by P

accept command A:
  accepted → P

Program P:
  complete initial canonical contract + source-session attachment
```

Conceptual Program facts may include:

```text
program.created
program.session.attached
program.work.added × N
program.verification.required × M
```

Exact event spelling is implementation design; atomic semantic effects are not.

Immediately before append, the admission revalidates all **canonical** currentness conditions: R/D, interaction, source session, policy, and competing transitions.

The last Workspace observation check is evidence supplied to this decision; because the external worktree is not transactionally coupled to SQLite, the append does not upgrade that observation into a filesystem-at-commit guarantee.

## 40. Session terminal linearization

Phase 1 integration must strengthen current session-stop behavior.

### Ordinary idle completion

Preliminary completion assessment may still occur outside canonical admission, but terminal append authorization must be revalidated inside the same Host admission lane that can publish a pending creation interaction.

Inside that cut, ordinary completion verifies at minimum:

```text
session still terminal-eligible
AND
no current unresolved Program-creation interaction blocks completion
```

### Explicit stop

Explicit stop also revalidates inside canonical admission.

If a pending creation interaction exists and stop wins, that same logical cut invalidates/resolves it before/with session stop so later acceptance is stale.

If Program creation won first, stop sees the Program-attached state and applies the final Program/session stop semantics rather than relying on a pre-create snapshot.

## 41. Host-mediated Workspace mutation exclusion

This study does not prescribe a lock/class name. It requires coordination over **Host-mediated mutating execution lifetimes**, not merely event append.

Creation sequence:

```text
accept received
→ acquire Host-mediated mutation exclusion
→ wait/fail closed on active/unreconciled Host mutator
→ take last Workspace observation
→ mismatch/unknown => stale
→ canonical R/D/session/policy revalidation + atomic create
→ release
```

Dispatch sequence:

```text
acquire Host-mediated mutation exclusion
→ quiescence/reconciliation check
→ take last accepted-base observation
→ mismatch/unknown => no dispatch
→ admit ProgramAttempt
→ retain/transfer Host-mediated mutation authority if final execution model requires it
```

These sequences exclude Host-mediated races. They do not exclude external processes.

---

# Part VII — Relationship to existing Phase 1 decisions

## 42. Completion contract

If verification-centered completion is promoted, this study supplies the missing authorship/acceptance boundary for immutable mandatory verification requirements.

## 43. Verification freshness

Keep distinct:

```text
PlanningObservationIdentity
  → observation base for initial semantic plan

ProgramCreationRequestId / ProgramCreationDraftId
  → exact semantic authorization + single consumption

ProgramState revision + ProgramAttemptId
  → execution-claim currency

verification subjectGeneration
  → verification-satisfaction currency
```

Do not collapse these identities.

## 44. Agent work addition

Agent authorship of an exact accepted **initial** draft is different from Agent authority to mutate required topology after Program activation.

This study does not reopen the existing recommendation to defer automatic post-creation Agent topology mutation.

## 45. Structural bounds

Creation draft and pending Application projection need final local/aggregate Program bounds plus an explicit bounded serialized representation.

## 46. Operation correlation and uncertainty

Creation/dispatch must fail closed on relevant Host-mediated mutating operations that are still executing or unresolved/indeterminate. This composes with, rather than replaces, operation uncertainty semantics.

## 47. Scheduler/environmental concurrency

“One active ProgramAttempt per Workspace” alone does not exclude foreground/non-Program mutating capabilities.

If promoted, Phase 1 needs a separate Host-mediated environmental mutation-exclusion invariant or an equivalent capability/scheduler integration rule.

## 48. Session lifecycle

A pending Program-creation interaction is a new Host-owned blocker to **automatic idle completion**.

Both draft presentation and automatic session terminal admission need same-lane currentness revalidation to close the asynchronous message-handler race.

Explicit stop remains available but must linearize against acceptance and atomically invalidate a pending draft if stop wins.

## 49. Out-of-band runtime mutation

External/non-Host mutation is a **separate freeze-readiness decision**.

Neither `PlanningObservationIdentity` nor Host-mediated mutation exclusion can guarantee continuous worktree state. The eventual Phase 1 contract must define how an active ProgramAttempt detects/fails closed on out-of-band changes relevant to its execution/evidence/verification.

---

# Part VIII — Acceptance-proof consequences

## 50. Existing ACs can absorb the creation-authorship decision

No new AC family appears necessary for authorship itself.

- **AC-10-02:** complete accepted objective/topology/mandatory verification established at one rebuildable creation cut.
- **AC-10-03:** source-session creation/attachment; pending creation blocks idle completion at terminal admission; explicit stop versus acceptance linearizes deterministically.
- **AC-10-05:** initial DAG/bounds; last pre-dispatch observation mismatch blocks dispatch; Host-mediated mutation coordination at dispatch.
- **AC-10-06:** active/unreconciled Host-mediated mutating operation blocks protected creation/dispatch; uncertainty remains uncertainty.
- **AC-10-08:** runtime evidence cannot rewrite creation-time mandatory requirements.
- **AC-10-09:** replacement/idle cannot promote, discard, or invalidate pending creation state through stale snapshots; creation recovery preserves single consumption/exactly-one Program mapping.
- **AC-10-10:** creation request/draft/accept projection; stale/duplicate; reconnect; pending lifecycle; atomic request/draft/command→Program semantics; UI/Agent cannot create ProgramState directly.

The separately unresolved attempt-time out-of-band mutation policy may require additional refinements to AC-10-04/05/06/07 once selected.

## 51. Required negative proofs if promoted

```text
Agent draft exists + no exact Application acceptance
→ no Program
```

```text
Agent idle completion snapshot starts before draft presentation
→ draft presentation wins canonical admission
→ terminal admission rechecks pending blocker
→ session remains active; draft remains acceptable
```

```text
ordinary idle completion wins canonical admission first
→ session stopped
→ later draft-presentation admission rechecks session
→ no acceptable draft created
```

```text
explicit stop and acceptance race
→ stop first: pending draft invalidated + session stopped; accept stale
→ accept first: Program created/attached; later stop follows Program-attached semantics
```

```text
accept D1 waits on mutation barrier
→ D2 supersedes D1 / policy changes / explicit session stop wins
→ creation admission revalidates
→ no Program from stale D1
```

```text
A1 and A2 use different commandIds for same D
→ exactly one consumes D and creates P
→ other resolves duplicate/noop to P
```

```text
accepted creation commits
→ response lost / crash
→ retry A
→ same ProgramStateId P
```

```text
crash inside accepted-creation transaction
→ replay sees unconsumed/no Program OR consumed + mapping + complete Program
→ never partial Program
```

```text
D planned at B0
→ last Host pre-creation observation sees B1
→ stale; no Program
```

```text
Host-mediated mutator still executing
→ creation cannot take protected final observation/create across its lifetime
```

```text
last Host observation sees B0
→ external process writes B1 before SQLite commit
→ Program may still commit
→ system does NOT claim worktree-at-commit == B0
```

```text
last Host pre-dispatch observation sees accepted base
→ external process writes before attempt execution
→ this study does NOT claim the attempt remained current
→ separately selected runtime out-of-band policy must govern
```

```text
pre-Program planner requests mutating capability
→ reject/fail closed
```

```text
Host/UI restart with pending draft
→ exact draft/currentness/blocker state rebuilds from Host-owned state
```

---

# Part IX — Comparison and recommendation

## 52. Comparison

| Alternative | Semantic authority | Natural-language UX | Observation provenance | Single-consumption/idempotence | Session-lifecycle coherence | Result |
|---|---|---|---|---|---|---|
| A. Application full contract | strong | weak default | can be explicit | strong | simple | accommodate |
| B. Host deterministic synthesis | unsupported for general semantics | good | possible | possible | simple | reject |
| C. Agent auto-admit | weak | excellent | possible | possible | simple | reject |
| D. Exact draft acceptance + atomic single-consume/create | **strong** | good | **explicit but non-isolating** | **strong** | **explicit linearization** | **prefer conditionally** |
| E. Canonical planning lifecycle | strong | good | explicit possible | strong | large new lifecycle | defer |
| F. Delegated auto-accept | intentionally weaker | excellent | explicit possible | strong | simple | defer |
| G. Objective-only mutable contract | weak | good | complex | complex | complex | reject |
| H. Model/judge acceptance | no deterministic principal | good | possible | possible | simple | advisory only |

## 53. Recommendation

**Recommend Alternative D for the first executable Phase 1.0 semantic creation model, conditional on resolving the separately identified attempt-time out-of-band mutation policy before Phase 1 freeze.**

Preferred authority chain:

```text
caller objective
        ↓
Host-owned creation request R
        ↓
PlanningObservationIdentity B0
        ↓
read-only Agent semantic proposal D
        ↓
Host deterministic validation + policy additions
        ↓
Host-owned exact pending D/H(D,B0,P0)
        ↓
pending interaction blocks automatic idle completion at terminal admission
        ↓
Application accept A targets exact D
        ↓
Host-mediated mutation exclusion
+ last Host observation compared with B0
        ↓
serialized canonical revalidation:
  D/R current + unconsumed
  interaction unresolved/current
  source session active/eligible
  policy still P0
        ↓
atomic transaction:
  consume R/D by ProgramStateId P
  + resolve interaction accepted
  + A→P
  + complete initial Program contract/attachment
        ↓
Program active
```

The concise authority rule is:

> **The caller authors intent; the Agent proposes semantics; Host policy may add mandatory constraints; the Application accepts one exact Host-owned pending contract; the Host alone revalidates and single-consumes that authorization while making complete Program creation atomic and canonical. PlanningObservationIdentity records what repository state the plan was based on, but neither it nor SQLite admission certifies the external worktree state at commit time.**

This is the smallest model found that preserves natural Agent planning without silently granting the Agent immutable completion-burden authority or creating duplicate Programs under retry/race.

---

# Part X — Remaining freeze-readiness dependencies

## 54. Closed verification-requirement predicate taxonomy

The final contract must define the closed deterministic requirement predicates well enough to author immutable creation-time obligations without future concrete evidence IDs or free-text truth evaluation.

## 55. PlanningObservationIdentity

The final contract must define the minimum bounded observation representation and equivalence rule. It should reuse Git/Workspace/CodeIntelligence observation substrate where sufficient and must not be described as filesystem isolation.

## 56. Host-mediated Workspace mutation barrier

The final contract must define:

- owning Host subsystem;
- which mutating capability executions participate;
- acquisition/release;
- interaction with ProgramAttempt lifetime;
- cancellation/timeout/Host-crash behavior;
- indeterminate/reconciliation behavior;
- foreground work rejection/queueing/delay;
- read-only concurrency.

## 57. Pending creation lifecycle and session-terminal integration

The final contract must specify Host-owned Application control state sufficient to prove:

```text
one creation request
→ one current exact draft at a time
→ current pending draft blocks automatic idle completion at the terminal cut
→ explicit stop can atomically invalidate it if stop wins
→ at most one consumed ProgramStateId
```

Both draft presentation and session terminal transitions must revalidate on the same canonical admission lane. Pre-enqueue snapshots are not terminal authorization.

This does not require a canonical `planning` ProgramState lifecycle.

## 58. Attempt-time out-of-band mutation detection

This is a **separate correctness dependency**.

The frozen Phase 1 contract must decide what happens when a human editor or non-ALCODE process changes the repository during the observation-to-execution window or after ProgramAttempt execution starts.

Credible solution families to study separately include:

- fail-closed observation checks at mutating capability/evidence/verification/completion boundaries;
- attempt-scoped expected observation generations advanced only by correlated Host effects;
- filesystem/repository snapshot or stronger isolation where actually available;
- a hybrid observation-generation + operation-correlation model.

Until this is resolved, no consolidated Phase 1 contract should claim continuous ProgramAttempt/worktree freshness.

## 59. Planning status

This document remains a recommendation only.

It does not:

- amend `docs/phase-1.0-plan.md`;
- supersede `docs/phase-1.0-open-decisions-study.md`;
- consolidate the artifact-evidence amendment;
- approve or freeze Phase 1.0;
- authorize implementation.

If accepted, its conclusions belong only in a later explicitly authorized Phase 1.0 consolidation decision.