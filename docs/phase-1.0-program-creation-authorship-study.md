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
- complete observation provenance for the repository facts actually exposed to the semantic planner;
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
- how planning observations are captured with complete provenance and, for tracked-dependency mode, sealed after planning;
- Host-mediated mutation races;
- creation atomicity/idempotence;
- crash/replacement/reconnect behavior.

It does **not** claim filesystem snapshot isolation.

The precise observation guarantee is deliberately narrow:

> **The final draft is bound either to a Host-sealed identity of the bounded repository/Workspace observations actually made available to planning, or to the identity of an equivalent bounded immutable planning snapshot whose contents were fixed before the planner's first semantic read. Before canonical creation, while conflicting Host-mediated mutating execution is excluded, the Host rechecks that exact accepted observation base. A matching check proves what the Host last observed; it does not prove that an external editor/process could not modify the live worktree after that check and before the SQLite creation transaction commits.**

The same qualification applies to the pre-first-dispatch observation check. It proves the last Host observation matched the accepted planning base; it does not prove an external writer cannot change the worktree in the check-to-execution gap.

Therefore canonical Program creation is **semantic authorization**, not a filesystem-consistency certificate. Alternative D below is suitable for promotion only together with a separately resolved attempt-time out-of-band mutation detection/fail-closed policy before Phase 1 freeze.

## 3. Method

For each alternative this study asks:

1. where intent originates;
2. who proposes topology and verification semantics;
3. who may accept those semantics;
4. what the Host can validate deterministically;
5. what repository/Workspace observations the planner actually consumed and how that set is captured/sealed;
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

### 4.12 A pre-planning token is insufficient when planning discovers its own dependencies

The semantic planner can discover relevant files, directories, symbols, Git state, configuration, and search results only **during** planning.

If the Host captures a narrow `B0` before those reads, then a file the planner later relies upon may be omitted from `B0`. A final equality check against that incomplete token can succeed even though a fact the plan actually used changed.

Therefore the planning base cannot simply be “whatever was known before the Agent started.” The final draft must be bound either to a **sealed observation dependency set produced after the proposal**, or to a **bounded immutable planning snapshot fixed before the planner's first semantic read and used as the exclusive source of all permitted planning reads**. A live view digested only after planning is not sufficient.

### 4.13 Reasoning/model output is not ProgramState authority

Reasoning state, model output, tool results, CodeIntelligence observations, and artifacts may inform a creation proposal. None becomes ProgramState truth without the relevant Host admission/authorization boundary.

---

# Part II — Authority model

## 5. Distinct roles

### 5.1 Intent originator

The Application/user supplies the objective.

### 5.2 Semantic planner

The replaceable Agent/model is the natural source of repository-specific work decomposition and task-specific verification proposals.

### 5.3 Observation provider/tracker

The Host controls the read-only Workspace/repository interfaces made available during Program planning and records the observation identities/dependencies returned through them.

The Agent may decide **what to inspect**, but it may not self-assert the authoritative observation base.

### 5.4 Policy contributor

Host policy may add deterministic, non-removable requirements.

### 5.5 Semantic acceptance authority

The Application caller may authorize one exact proposed contract.

### 5.6 Canonical authority

The Host alone validates canonical currentness, single-consumes the pending creation authorization, and admits ProgramState.

### 5.7 Session lifecycle authority

The Host owns session completion/stop. Pending Program creation and session terminal transitions therefore need one linearization model.

### 5.8 Environmental mutation coordinator

The Host coordinates **Host-mediated** mutating capability lifetimes around observation-sensitive checks. This authority does not extend to arbitrary external processes.

The central separation is:

```text
caller intent
!=
Agent semantic proposal
!=
Host-tracked observation provenance
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

### 6.10 PlanningObservationIdentity exactly covers semantic planning inputs

The Host must not bind the final ProgramCreationDraft only to a token captured before the planner discovers what it needs to inspect.

A correct first-slice contract permits either of these implementation families:

**Full immutable planning-snapshot strategy**

```text
Host creates one bounded immutable planning snapshot S before the first semantic planning read
→ every permitted Workspace/repository planning read is served exclusively from S
→ S's identity is fixed for the planning episode
→ Agent submits draft D
→ D binds to S's exact identity
```

A live Workspace view that can change while planning runs and is merely digested after the proposal is **not** this strategy. It can bind D to bytes the planner never saw and is therefore unsafe.

**Tracked dependency strategy**

```text
Host supplies read-only planning capabilities
→ every file/directory/search/Git/config/CodeIntelligence observation delivered to the planner carries Host-observed identity/dependency metadata at delivery time
→ Host accumulates the complete dependency set
→ Agent submits draft D
→ Host seals the accumulated dependency set into Bplan
→ D is bound to Bplan
```

The final draft binding is established **after** the proposal is produced. In snapshot mode, the snapshot identity itself was already fixed before the first read and remains immutable; in tracked-dependency mode, the dependency accumulator is sealed after the proposal.

If a planning input cannot be represented in the selected observation model, or the planner can read Workspace state through an untracked side channel, the Host cannot honestly claim complete observation provenance. The first-slice creation path must then fail closed or use the immutable-snapshot strategy.

### 6.11 Sealed observation completeness includes non-file reads

A tracked planning dependency is not necessarily just a path digest.

Examples that may need representation include:

- file content/version;
- directory listing/absence;
- search/query result set;
- Git HEAD/status/diff information;
- repository configuration;
- CodeIntelligence revision/provider observation;
- Host-canonical facts supplied to planning.

If a plan depends on an absence/query result, recording only files later opened is insufficient.

### 6.12 Rechecking the accepted planning base is observational, not isolation

Before canonical creation, while Host-mediated mutating execution is excluded, the Host re-evaluates the accepted `Bplan` dependencies or compares the current live Workspace/repository state with the accepted immutable snapshot identity/equivalence model.

If the recheck differs or equivalence is unknown, creation rejects stale/fail-closed.

But:

```text
last Host recheck == accepted planning base
```

means only that. It does **not** mean:

```text
external worktree == accepted planning base at SQLite commit
```

because an external writer can change files after the check.

### 6.13 Host-mediated mutation exclusion at observation-sensitive boundaries

Final creation recheck/admission cannot cross an already-running Host-mediated mutating capability.

A Host-owned Workspace mutation barrier (name/implementation open) must ensure:

- no Host-mediated mutator is still executing when the final creation observation is taken;
- unresolved/indeterminate Host-mediated mutation fails closed for quiescence;
- no unrelated Host-mediated mutator starts before the creation admission completes.

Before the **first ProgramAttempt dispatch**, the Host reacquires the same class of exclusion and performs another observation check against the accepted creation-time planning base.

That creation-time `Bplan` recheck is a bridge from accepted planning to **first execution only**. Once a ProgramAttempt has legitimately mutated the Workspace, later dispatch freshness must be indexed by the current execution-aware Program/Workspace state or generation; later dispatches must not compare the live Workspace back to immutable creation-time `Bplan` as if no authorized Program mutation had occurred.

### 6.14 Host-mediated exclusion may need to span ProgramAttempt execution

If Phase 1 promises that unrelated **Host-mediated** mutators cannot race an active ProgramAttempt, the barrier must cover environmental execution lifetime rather than only `program.attempt.started` append.

The exact acquisition/release/transfer rules remain a freeze-readiness dependency.

### 6.15 No continuous external-worktree freshness claim

Neither the creation barrier nor canonical admission prevents a human editor or non-ALCODE process from changing the repository.

This study therefore proves no continuous attempt/worktree snapshot property.

A separate attempt-time out-of-band mutation detection/fail-closed contract must be selected before Phase 1 freeze if runtime correctness depends on detecting those changes.

### 6.16 Pre-Program planning is read-only

Before Program creation there is no ProgramAttempt. Creation planning may inspect bounded Workspace state; mutating capability requests fail closed.

Read-only access used for planning must participate in the selected immutable-snapshot or tracked-dependency observation model if its result can influence D.

### 6.17 Bounded contract

Draft work, dependencies, paths, verification requirements, text, planning-observation representation, and serialized/public representation are bounded before presentation/admission.

### 6.18 No future concrete evidence identity in immutable requirements

Future ArtifactRefs/evidenceRefs can later support satisfaction but cannot themselves be the creation-time identity of an immutable requirement.

### 6.19 Pending draft is Host-owned durable control state

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

## 10. Alternative D — Agent proposes; Host owns complete planning provenance; Application accepts exact draft; Host single-consumes and creates

Preferred semantic flow:

```text
caller objective
→ Host opens creation request R
→ Host chooses one bounded read-only planning provenance mode:
     snapshot mode: create immutable snapshot S before first semantic read
                    and serve all permitted planning reads from S
     tracked mode:  start Host-owned dependency accumulation
→ Agent chooses/read-inspects repository facts through the selected Host interfaces
→ Agent proposes D
→ Host establishes Bplan:
     snapshot mode: Bplan = exact identity of immutable S
     tracked mode:  seal complete delivered-observation dependency set after proposal
→ Host validates D + Bplan structure/bounds/policy and adds mandatory Host requirements
→ Host canonically presents current pending draft D/H(D,Bplan,P0) under R
→ pending interaction blocks ordinary idle completion
→ Application accept command A targets exact D/H
→ Host acquires Host-mediated Workspace mutation exclusion
→ waits/fails closed on active/unreconciled Host mutator
→ Host rechecks accepted Bplan against current live Workspace/repository observation
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
last Host observation matched accepted Bplan
```

is the external-state evidence available to the creation transaction. The transaction does not certify that no external process wrote after that observation.

Before first ProgramAttempt dispatch:

```text
acquire Host-mediated mutation exclusion
→ ensure Host-mediated quiescence/reconciliation
→ recheck the accepted Bplan
→ mismatch/unknown => no first dispatch
→ match => first ProgramAttempt may be canonically admitted
```

Again, the check proves the last Host observation, not external filesystem isolation through the following execution interval. It is not a rule that every successor dispatch rechecks immutable creation-time `Bplan`; successor dispatch freshness must use execution-aware state that can advance with legitimate Program-correlated mutations.

**Advantages**

- preserves natural Agent planning;
- tracked mode covers dependencies discovered during planning, while snapshot mode guarantees every read came from one immutable view;
- Agent remains proposer, not semantic acceptance authority;
- exact immutable burden is accepted explicitly;
- Host policy minima are non-removable;
- one draft/request is single-consumed across racing command IDs;
- exact creation is crash-idempotent;
- pending interaction survives Agent idle;
- stale canonical request/session/policy races are closed at one admission cut;
- Host-mediated in-flight mutators cannot cross the protected observation/admission boundary.

**Disadvantages**

- adds creation-draft/accept interaction;
- adds durable pending lifecycle/session integration;
- requires either complete Host-tracked delivered-read provenance or a bounded immutable planning snapshot;
- requires a bounded `PlanningObservationIdentity` representation;
- requires Host-mediated mutation coordination;
- does not solve arbitrary external edits after the final observation.

**Classification:** **preferred for semantic authorship/authorization, conditional on a complete bounded planning-observation strategy and separate attempt-time out-of-band mutation semantics before Phase 1 freeze.**

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

Tracked-dependency mode:

```text
creation request R with objective O
→ start Host-tracked read-only planning
→ Agent reads F1, directory Q, Git G, configuration C through tracked interfaces
→ Agent proposes D
→ Host seals Bplan = identities/dependencies of F1 + Q + G + C
→ Host validates + policy-adds
→ canonical pending D/H(D,Bplan,P0) under R
→ Agent may become idle; session remains active because pending interaction blocks idle completion
→ Application A accepts D/H
→ acquire Host-mediated mutation exclusion
→ Host recheck of sealed Bplan matches
→ enter canonical admission
→ R/D/interaction/session/policy all current
→ atomic consume(R,D) + resolve interaction + A→P + complete Program batch/attachment
→ P active
```

Immutable-snapshot mode has the same acceptance/creation half, but the Host first fixes snapshot S before the planner's first semantic read, serves every permitted planning read from S, and binds D to S's identity after proposal generation.

## 16. Planner discovers a relevant path after planning starts

```text
planning begins
→ Agent reads repository index/search result Q
→ Q reveals file F not known at start
→ Agent reads F
→ D depends on F
```

Required result in tracked-dependency mode:

```text
F and Q are included in the sealed dependency set Bplan
```

In immutable-snapshot mode, Q and F must both be read from the already-fixed S; discovery after planning begins does not authorize a live-worktree side read.

A pre-planning token that omitted F cannot be the final authoritative planning base.

## 17. A dependency changes during planning

Tracked-dependency mode:

```text
Agent reads A@v1
→ Workspace changes A to v2
→ Agent later reads B@v1
→ Agent proposes D based on observed A@v1/B@v1
→ Host seals those observed dependencies
```

Before creation, recheck against the sealed set cannot silently treat current A@v2 as equivalent to A@v1. Mismatch => stale/re-plan unless the selected equivalence model can prove semantic equivalence deterministically.

Immutable-snapshot mode:

```text
Host fixes S with A@v1
→ Agent reads A@v1 from S
→ external Workspace changes live A to v2
→ Agent continues reading only S
→ D binds to S
```

The planner never silently switches to A@v2 during that episode. Before creation, the Host compares current live state to accepted S/Bplan; mismatch/unknown => stale/re-plan unless deterministic equivalence is proved.

## 18. Untracked planning read

```text
Agent can inspect Workspace fact X through a side channel not represented by Host tracking/immutable snapshot
→ D may depend on X
```

The Host cannot claim complete `PlanningObservationIdentity` provenance.

First-slice response: fail closed for this creation mode or remove that side channel from semantic planning. The Agent may not self-assert “X did not matter” as canonical freshness evidence.

## 19. Agent-idle races draft presentation

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

## 20. Explicit stop races acceptance

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

## 21. Draft superseded while acceptance waits

```text
A targets D1
→ A waits for mutation exclusion
→ D2 supersedes D1 canonically
→ barrier becomes available
```

Creation admission revalidates and rejects D1 stale. A pre-wait check does not authorize later creation.

## 22. Policy/session changes while acceptance waits

Same rule: after barrier acquisition, creation admission revalidates policy and source-session/pending-interaction currency. If either changed, old acceptance rejects stale.

## 23. Two distinct accept commands race one draft

```text
A1(commandId=1) targets D
A2(commandId=2) targets D
```

Canonical admission serializes them.

If A1 consumes D and creates P, A2 observes D already consumed and resolves duplicate/noop referencing P. Distinct command IDs do not create P2.

## 24. Same-command response loss/crash

```text
A accepted
→ atomic consume(D) + A→P + Program P commits
→ response lost / Host crash
→ A retried
```

Retry resolves to P; no second ProgramStateId.

## 25. Crash during accepted-creation transaction

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

## 26. Workspace changes while draft is pending

```text
D bound to accepted Bplan
→ a dependency represented by Bplan changes in the live Workspace
→ A accepts D
→ Host final recheck sees mismatch
```

Mismatch/unknown => stale/fail-closed; no Program creation from D.

## 27. Host-mediated mutation already executing

Current architecture can have:

```text
operation.started canonical
→ mutating capability.execute() still running outside admission queue
→ Program creation acceptance arrives
```

Creation cannot treat event order as quiescence. It waits/fails closed until Host-mediated mutation execution is terminal and required reconciliation is resolved, then performs its last observation recheck.

## 28. External write after final creation observation

Unavoidable without stronger filesystem isolation:

```text
Host-mediated mutation exclusion held
→ Host rechecks accepted Bplan successfully
→ external editor writes B1
→ SQLite accepted-creation transaction commits P
```

This history is **not excluded by Alternative D**.

What is true canonically is:

```text
P was semantically authorized from exact draft D bound to accepted Bplan
and
the Host's last pre-creation recheck matched Bplan
```

What is **not** established is:

```text
worktree equalled Bplan at Program transaction commit
```

The Program may therefore exist canonically even though an external change crossed the observation-to-commit window. Program creation is not a claim that execution is safe against that change. Before first execution, the Host observes again, and the final frozen runtime contract must separately define attempt-time out-of-band mutation detection/fail-closed behavior.

## 29. Program parked before first execution, Workspace later changes

The creation barrier is not held while an active Program waits for its **first** ProgramAttempt dispatch. A delayed first dispatch rechecks the accepted creation-time planning base under Host-mediated mutation exclusion.

A mismatch prevents that first dispatch. A match means only that the Host's last check matched; it is not filesystem snapshot isolation.

Once any ProgramAttempt has run, the immutable creation-time planning base is no longer the generic dispatch-freshness base: legitimate Program-correlated mutation may have advanced Workspace state. A later work-item/attempt dispatch must use the current execution-aware Program/Workspace generation/freshness contract rather than requiring equality with original `Bplan`.

## 30. External write after first-dispatch observation

```text
Host last pre-first-dispatch recheck matches accepted planning base
→ external writer changes repository
→ first ProgramAttempt starts
```

This is possible without a stronger runtime mechanism.

Therefore the study does **not** describe the pre-first-dispatch observation as proof that the worktree is unchanged at first-attempt start or during ProgramAttempt execution. The attempt-time out-of-band mutation policy is a separate freeze dependency.

## 31. Host-mediated mutator tries to cross attempt start

This case **is** under Host control. If the frozen contract promises Host-mediated mutation isolation, the scheduler acquires environmental mutation authority before its last observation check and does not release a gap before ProgramAttempt Host-mediated mutation authority begins.

## 32. Agent replacement during planning

A replacement Agent cannot inherit an unsealed self-asserted observation base. Planning restarts from durable caller intent unless the Host can continue the same bounded tracked planning episode without losing observation provenance, or can continue to serve the same immutable snapshot S.

Once exact D+Bplan is Host-owned and pending, a replacement Agent cannot substitute D2 under D's identity.

## 33. Host/UI restart after draft presentation

Pending Host state recovers exact draft/lossless reference, digest, accepted planning observation identity, request identity, policy identity, source session, lifecycle, and consumed ProgramStateId if applicable.

Renderer-local state is not needed to decide currentness.

## 34. Pending interaction resolved without creation

Rejection/withdrawal/defined expiry/supersession clears the creation interaction as a blocker. No `program.cancelled` fact is needed because no Program existed.

## 35. Planner requests mutation before Program exists

Fail closed. Pre-Program semantic planning is read-only.

## 36. Future ArtifactRef/evidenceRef proposed as immutable requirement identity

Reject. The creation-time requirement identifies a stable logical predicate/obligation; future evidence later satisfies it.

---

# Part VI — Preferred semantic shapes

## 37. ProgramCreationDraft

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

`planningObservation` is Host-owned, never an arbitrary Agent-provided digest. In tracked-dependency mode the Host seals it after semantic planning. In immutable-snapshot mode it identifies the snapshot fixed before the first planning read, and the final draft binds to that exact identity after proposal generation.

Draft-local keys wire work/verification before canonical Program identities exist. The Host mints canonical `ProgramStateId`, work-item IDs, and verification-obligation IDs during accepted creation.

The exact draft digest covers every semantic field whose change would alter acceptance, including the accepted planning observation identity and policy identity.

## 38. Pending creation lifecycle

Host-owned Application control state needs semantics equivalent to:

```text
creation request R
  └─ current exact draft D + accepted Bplan
       ├─ pending/current
       ├─ superseded/rejected/withdrawn/expired
       └─ consumed by ProgramStateId P
```

At most one current draft exists under the first-slice request model, and a request/draft is consumed at most once.

Pending current D blocks ordinary idle completion of the source session.

## 39. PlanningObservationIdentity

The architectural requirement is **complete bounded provenance for the planning view that actually influenced the proposal**.

The final implementation may choose one of two families, provided it proves completeness:

### 39.1 Full bounded immutable planning snapshot

Before the first semantic planning read, the Host creates one bounded immutable snapshot S. Every permitted Workspace/repository semantic planning read is served exclusively from S for that episode. The snapshot identity is fixed before the first read and cannot be replaced by a digest of later live state. After the Agent submits D, the Host binds D to S's exact identity.

The live Workspace may change while planning runs; that does not change what the Agent reads from S. Later creation and **first-dispatch** rechecks compare current live state to the accepted snapshot identity/equivalence model and fail closed on mismatch/unknown. This is planning-input immutability, not a claim that the live worktree itself was frozen.

After a ProgramAttempt legitimately changes the Workspace, successor dispatch freshness is not established by comparing live state back to S; it must use the execution-aware current state/generation selected by the runtime contract.

### 39.2 Host-tracked observation dependency set

Every read-only observation delivered to planning contributes deterministic dependency metadata to a Host-owned accumulator **at delivery time**. The Host seals the accumulator only after the Agent submits the proposal.

The dependency model must cover the semantics of the read, not only file paths. For example, a directory listing or search query may depend on a result set/absence state.

### 39.3 Required properties

Whichever family is selected:

1. all Workspace/repository observations that can influence D are covered;
2. the Host, not the Agent, establishes the identity/provenance;
3. snapshot mode fixes identity before the first semantic planning read and binds D to it after proposal generation; tracked mode captures observation identities as delivered and seals the accumulator after the relevant planning reads/proposal;
4. the representation is bounded;
5. the Host can later re-evaluate/equivalence-check it against live state for creation and the first-dispatch bridge;
6. unknown/incomplete equivalence fails closed;
7. matching is evidence of the Host observation only, not transactional external-write exclusion.

This is a freeze-readiness design dependency; this study intentionally does not pretend the exact digest/schema is already selected.

## 40. Mandatory verification authorship

The Agent may propose task-specific closed deterministic verification requirements. Host policy may add non-removable requirements.

The Host can deterministically validate schema, bounds, predicate kind, parameter shape, freshness-scope shape, policy minima, draft references, and the ban on future concrete evidence identities.

The Host cannot generally prove semantic sufficiency of an arbitrary finite verification set for natural-language intent. That is why semantic acceptance is a distinct role.

## 41. Initial topology authorship

The Agent proposes repository-specific DAG decomposition. The Host validates bounds, dependency integrity, cycles, field shape, and policy. The Application accepts the exact topology as part of D.

This does not grant Agent post-creation automatic `program.work.added` authority.

## 42. Accepted-creation transaction

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

The last planning-base recheck is evidence supplied to this decision; because the external worktree is not transactionally coupled to SQLite, the append does not upgrade that observation into a filesystem-at-commit guarantee.

## 43. Session terminal linearization

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

## 44. Host-mediated Workspace mutation exclusion

This study does not prescribe a lock/class name. It requires coordination over **Host-mediated mutating execution lifetimes**, not merely event append.

Creation sequence:

```text
accept received
→ acquire Host-mediated mutation exclusion
→ wait/fail closed on active/unreconciled Host mutator
→ recheck accepted Bplan
→ mismatch/unknown => stale
→ canonical R/D/session/policy revalidation + atomic create
→ release
```

**First-dispatch sequence:**

```text
acquire Host-mediated mutation exclusion
→ quiescence/reconciliation check
→ recheck accepted Bplan
→ mismatch/unknown => no first dispatch
→ admit first ProgramAttempt
→ retain/transfer Host-mediated mutation authority if final execution model requires it
```

This `Bplan` recheck is a creation-to-first-execution bridge only. After a ProgramAttempt legitimately changes the Workspace, a successor dispatch uses the execution-aware current Program/Workspace generation/freshness state; it does not compare the live Workspace back to immutable creation-time `Bplan`.

These sequences exclude Host-mediated races. They do not exclude external processes.

---

# Part VII — Relationship to existing Phase 1 decisions

## 45. Completion contract

If verification-centered completion is promoted, this study supplies the missing authorship/acceptance boundary for immutable mandatory verification requirements.

## 46. Verification freshness

Keep distinct:

```text
PlanningObservationIdentity
  → accepted observation base for initial semantic plan and first-execution bridge

ProgramCreationRequestId / ProgramCreationDraftId
  → exact semantic authorization + single consumption

ProgramState revision + ProgramAttemptId
  → execution-claim currency

verification subjectGeneration
  → verification-satisfaction currency
```

Do not collapse these identities.

## 47. Agent work addition

Agent authorship of an exact accepted **initial** draft is different from Agent authority to mutate required topology after Program activation.

This study does not reopen the existing recommendation to defer automatic post-creation Agent topology mutation.

## 48. Structural bounds

Creation draft, pending Application projection, and planning-observation dependency/snapshot representation need final local/aggregate limits plus an explicit bounded serialized representation.

## 49. Operation correlation and uncertainty

Creation and the **first-dispatch bridge** must fail closed on relevant Host-mediated mutating operations that are still executing or unresolved/indeterminate. This composes with, rather than replaces, operation uncertainty semantics. Successor dispatch uses the execution-aware runtime freshness model rather than reusing creation-time `Bplan` as a perpetual baseline.

## 50. Scheduler/environmental concurrency

“One active ProgramAttempt per Workspace” alone does not exclude foreground/non-Program mutating capabilities.

If promoted, Phase 1 needs a separate Host-mediated environmental mutation-exclusion invariant or an equivalent capability/scheduler integration rule.

## 51. Session lifecycle

A pending Program-creation interaction is a new Host-owned blocker to **automatic idle completion**.

Both draft presentation and automatic session terminal admission need same-lane currentness revalidation to close the asynchronous message-handler race.

Explicit stop remains available but must linearize against acceptance and atomically invalidate a pending draft if stop wins.

## 52. Out-of-band runtime mutation

External/non-Host mutation is a **separate freeze-readiness decision**.

Neither accepted `PlanningObservationIdentity` nor Host-mediated mutation exclusion can guarantee continuous worktree state. The eventual Phase 1 contract must define how an active ProgramAttempt detects/fails closed on out-of-band changes relevant to execution/evidence/verification.

---

# Part VIII — Acceptance-proof consequences

## 53. Existing ACs can absorb the creation-authorship decision

No new AC family appears necessary for authorship itself.

- **AC-10-02:** complete accepted objective/topology/mandatory verification established at one rebuildable creation cut.
- **AC-10-03:** source-session creation/attachment; pending creation blocks idle completion at terminal admission; explicit stop versus acceptance linearizes deterministically.
- **AC-10-05:** initial DAG/bounds; planning-observation completeness/bounds; last pre-first-dispatch `Bplan` recheck mismatch blocks the first dispatch; Host-mediated mutation coordination at that creation-to-first-execution bridge; successor dispatch freshness is execution-state indexed rather than equality-to-creation-`Bplan`.
- **AC-10-06:** active/unreconciled Host-mediated mutating operation blocks protected creation/first-dispatch bridging; uncertainty remains uncertainty. Successor runtime mutation/freshness behavior remains governed by the execution-aware contract.
- **AC-10-08:** runtime evidence cannot rewrite creation-time mandatory requirements.
- **AC-10-09:** replacement/idle cannot promote, discard, or invalidate pending creation state through stale snapshots; creation recovery preserves single consumption/exactly-one Program mapping.
- **AC-10-10:** creation request/draft/accept projection; stale/duplicate; reconnect; pending lifecycle; atomic request/draft/command→Program semantics; UI/Agent cannot create ProgramState directly.

The separately unresolved attempt-time out-of-band mutation policy may require additional refinements to AC-10-04/05/06/07 once selected.

## 54. Required negative proofs if promoted

```text
Agent draft exists + no exact Application acceptance
→ no Program
```

```text
snapshot mode selected
→ Host fixes immutable S before first semantic planning read
→ every permitted planning read is served from S
→ live Workspace changes A@v1 → A@v2 during planning
→ planner continues to observe A@v1 from S
→ D binds to S, never to a post-hoc digest of A@v2
```

```text
planner discovers F after planning begins
→ D depends on F
→ tracked mode: sealed Bplan includes F (and discovery/query dependency where relevant)
→ snapshot mode: F is read from already-fixed S, not live Workspace state
```

```text
planner reads fact X through an untracked channel
→ Host cannot prove complete planning base
→ creation flow fails closed / channel not permitted
```

```text
A@v1 read during tracked planning
→ A becomes v2 before acceptance
→ sealed Bplan recheck mismatches
→ stale; no Program
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
Host-mediated mutator still executing
→ creation cannot recheck/create across its execution lifetime
```

```text
last Host recheck matches Bplan
→ external process writes before SQLite commit
→ Program may still commit
→ system does NOT claim worktree-at-commit == Bplan
```

```text
last Host pre-first-dispatch recheck matches Bplan
→ external process writes before first ProgramAttempt execution
→ this study does NOT claim the first attempt remained current
→ separately selected runtime out-of-band policy must govern
```

```text
first ProgramAttempt legitimately mutates a dependency represented in creation Bplan
→ successor dispatch does NOT require live Workspace == creation Bplan
→ successor dispatch uses execution-aware current state/generation
```

```text
pre-Program planner requests mutating capability
→ reject/fail closed
```

```text
Host/UI restart with pending draft
→ exact draft + accepted planning base + currentness/blocker state rebuilds from Host-owned state
```

---

# Part IX — Comparison and recommendation

## 55. Comparison

| Alternative | Semantic authority | Natural-language UX | Planning observation completeness | Single-consumption/idempotence | Session-lifecycle coherence | Result |
|---|---|---|---|---|---|---|
| A. Application full contract | strong | weak default | caller-dependent | strong | simple | accommodate |
| B. Host deterministic synthesis | unsupported for general semantics | good | possible | possible | simple | reject |
| C. Agent auto-admit | weak | excellent | possible | possible | simple | reject |
| D. Complete planning provenance + exact acceptance + atomic single-consume/create | **strong** | good | **required/provable strategy** | **strong** | **explicit linearization** | **prefer conditionally** |
| E. Canonical planning lifecycle | strong | good | still required | strong | large new lifecycle | defer |
| F. Delegated auto-accept | intentionally weaker | excellent | still required | strong | simple | defer |
| G. Objective-only mutable contract | weak | good | complex | complex | complex | reject |
| H. Model/judge acceptance | no deterministic principal | good | still required | possible | simple | advisory only |

## 56. Recommendation

**Recommend Alternative D for the first executable Phase 1.0 semantic creation model, conditional on selecting a complete bounded planning-observation strategy and resolving the separately identified attempt-time out-of-band mutation policy before Phase 1 freeze.**

Preferred authority chain:

```text
caller objective
        ↓
Host-owned creation request R
        ↓
Host selects one bounded read-only planning provenance mode:
  immutable snapshot S fixed before first semantic read
  OR Host-tracked delivered-observation accumulation
        ↓
Agent chooses observations and proposes D through that mode
        ↓
Host establishes complete Bplan after proposal:
  D binds to already-fixed immutable S identity
  OR Host seals complete tracked dependency set
        ↓
Host deterministic validation + policy additions
        ↓
Host-owned exact pending D/H(D,Bplan,P0)
        ↓
pending interaction blocks automatic idle completion at terminal admission
        ↓
Application accept A targets exact D
        ↓
Host-mediated mutation exclusion
+ last Host recheck of accepted Bplan
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
        ↓
first-dispatch bridge only:
  Host-mediated exclusion + one final accepted-Bplan recheck
        ↓
after first ProgramAttempt:
  successor freshness advances with execution-aware Program/Workspace state
```

The concise authority rule is:

> **The caller authors intent; the Agent proposes semantics only from bounded Host-controlled planning inputs; the Host owns complete planning provenance either by fixing one immutable snapshot before the first semantic read or by capturing each delivered observation and sealing the dependency set after the proposal; the Application accepts one exact Host-owned pending contract bound to that provenance; the Host alone revalidates and single-consumes that authorization while making complete Program creation atomic and canonical. The accepted planning base records what planning depended on and bridges that authorization to the first ProgramAttempt, but it is not a perpetual execution baseline and neither it nor SQLite admission certifies external worktree state at commit time.**

This is the smallest model found that preserves natural Agent planning without silently granting the Agent immutable completion-burden authority, accepting a plan whose actual planning dependencies are untracked, creating duplicate Programs under retry/race, or pinning successor dispatches to stale creation-time Workspace state.

---

# Part X — Remaining freeze-readiness dependencies

## 57. Closed verification-requirement predicate taxonomy

The final contract must define the closed deterministic requirement predicates well enough to author immutable creation-time obligations without future concrete evidence IDs or free-text truth evaluation.

## 58. Complete bounded PlanningObservationIdentity

The final contract must choose/prove one complete bounded planning-input provenance strategy:

- **full immutable snapshot:** one bounded snapshot identity is fixed before the first semantic planning read and all permitted planning reads are served exclusively from that snapshot; or
- **Host-tracked dependency set:** every Workspace/repository observation that can influence D is captured with identity/dependency metadata at delivery time and the complete accumulator is sealed after proposal generation.

It must define representation, bounds, query/absence semantics, re-evaluation/equivalence rules, restart behavior, and treatment of any otherwise-untracked read channels.

The draft binding is established after proposal generation. Snapshot identity is fixed before the first planning read; tracked-dependency identity is sealed only after the complete delivered-read set is known. A live mutable planning view may not be digested after the fact and treated as if it represented what the planner actually saw.

## 59. Host-mediated Workspace mutation barrier

The final contract must define:

- owning Host subsystem;
- which mutating capability executions participate;
- acquisition/release;
- interaction with ProgramAttempt lifetime;
- cancellation/timeout/Host-crash behavior;
- indeterminate/reconciliation behavior;
- foreground work rejection/queueing/delay;
- read-only concurrency.

## 60. Pending creation lifecycle and session-terminal integration

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

## 61. Attempt-time out-of-band mutation detection and successor dispatch base

This is a **separate correctness dependency**.

The frozen Phase 1 contract must decide what happens when a human editor or non-ALCODE process changes the repository during the observation-to-execution window or after ProgramAttempt execution starts.

It must also define the execution-aware current state/generation used for **successor ProgramAttempt dispatches after legitimate Program-correlated mutations**. Immutable creation-time `Bplan` is not that successor baseline.

Credible solution families to study separately include:

- fail-closed observation checks at mutating capability/evidence/verification/completion boundaries;
- attempt-scoped expected observation generations advanced only by correlated Host effects;
- filesystem/repository snapshot or stronger isolation where actually available;
- a hybrid observation-generation + operation-correlation model.

Until this is resolved, no consolidated Phase 1 contract should claim continuous ProgramAttempt/worktree freshness or define successor dispatch freshness by equality to creation-time `Bplan`.

## 62. Planning status

This document remains a recommendation only.

It does not:

- amend `docs/phase-1.0-plan.md`;
- supersede `docs/phase-1.0-open-decisions-study.md`;
- consolidate the artifact-evidence amendment;
- approve or freeze Phase 1.0;
- authorize implementation.

If accepted, its conclusions belong only in a later explicitly authorized Phase 1.0 consolidation decision.