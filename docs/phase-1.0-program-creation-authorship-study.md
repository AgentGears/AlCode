# ALCODE Phase 1.0 — Program Creation and Contract Authorship Study

**Status:** DRAFT / non-normative planning study  
**Approval:** not approved; not frozen; implementation not authorized  
**Repository base studied:** `main` at `ff211b5c0c7d9f93946ab6a2ad42e45a58ca693c`  
**Relationship to Phase 1.0:** studies one additional contract question exposed by Program creation, immutable completion requirements, and the first-slice topology decision. It does not amend `docs/phase-1.0-plan.md`, change AC-10 acceptance criteria, approve/freeze Phase 1.0, or authorize implementation.

## 1. Question

The current Phase 1.0 draft says the Host owns ProgramState and Program creation. The existing alternatives study recommends an immutable first-slice completion contract built from universal Completion Oracle invariants plus mandatory verification requirements, and recommends no automatic Agent-originated canonical topology mutation after creation.

That leaves one material question:

> Who supplies the semantic content of the initial Program contract — objective, initial required work topology, and mandatory verification requirements — and who is authorized to accept that content before the Host makes it canonical?

“Host owns ProgramState” answers canonical ownership. It does **not** answer semantic authorship or semantic acceptance.

The study also checks the consequences of making that initial contract immutable:

- the accepted draft must be tied to the Workspace/repository observation it was planned against;
- one accepted creation request/draft must produce at most one ProgramState even if multiple accept commands race or the Host crashes/retries;
- a current pending creation draft must remain acceptable long enough for the Application to decide rather than being invalidated by ordinary Agent-idle session completion;
- already-running Host-mediated mutations cannot be treated as if canonical admission ordering froze the environment;
- the study must distinguish **creation freshness** from the separate problem of **attempt-time out-of-band workspace mutation**.

## 2. Scope and guarantee boundary

This study covers the boundary from caller intent through canonical Program creation and the first ProgramAttempt dispatch decision.

It studies:

- objective provenance;
- initial DAG authorship;
- mandatory verification authorship;
- Host policy additions;
- exact semantic acceptance;
- pending creation-request/draft lifecycle and single consumption;
- pending-draft interaction with Host session completion;
- draft freshness against Workspace/repository observations;
- Host-mediated mutation races at creation/dispatch;
- exact-draft stale protection;
- creation atomicity/idempotence;
- crash/replacement/reconnect behavior.

It does **not** claim snapshot isolation for an entire ProgramAttempt or entire Program lifetime.

In particular:

> **“Creation freshness” in this document means that the accepted contract was planned against an identified Workspace/repository observation and that the Host revalidated that observation at the protected creation/dispatch boundary. It does not mean arbitrary external processes are prevented from changing the repository after dispatch.**

A human editor or non-ALCODE process can still mutate the worktree after dispatch. That is a separate runtime correctness question. This study therefore makes its preferred creation model **conditional**: it is suitable for promotion only together with a separately resolved attempt-time out-of-band mutation detection/fail-closed contract.

This study does not decide the final verification predicate taxonomy, exact structural-limit numbers, general Program contract versioning, subagents, remote workers, or a general workflow language.

## 3. Method

For each alternative:

1. identify intent origin, semantic proposal, acceptance, and canonical authority;
2. identify what the Host can validate deterministically;
3. bind proposal semantics to the Workspace/repository observation used for planning;
4. exercise Agent-idle/session completion, stale draft, policy change, duplicate accept with distinct command IDs, in-flight mutation, crash, retry, replacement, replay, and reconnect histories;
5. reject unresolved duplicate authority, partial creation, duplicate creation, stale creation, self-invalidating normal flows, or model/Agent indirect completion authority;
6. separate what this creation decision proves from runtime concurrency questions it does not prove.

Correctness is a gate. Where another unresolved subsystem is required for correctness, the recommendation is explicitly conditional rather than silently assuming that subsystem exists.

---

# Part I — Repository facts

## 4. Current facts

### 4.1 Host canonical ownership is already established

`docs/phase-1.0-plan.md` assigns Program creation/attachment, canonical admission, scheduling, verification admission, and terminal authority to `@alcode/host-runtime`. Program creation occurs under a Host session and records initial attachment.

That establishes canonical ownership, not semantic authorship.

### 4.2 Creation-time semantics are load-bearing

The current plan makes objective/completion semantics immutable after creation. The open-decisions study recommends a first-slice completion contract of:

```text
immutable objective
+ immutable mandatory verification requirements
+ universal Host Completion Oracle invariants
```

The same study recommends no automatic Agent-originated required-work addition after creation.

Therefore both mandatory verification authorship and initial DAG authorship become part of the initial completion burden.

### 4.3 No Program creation protocol exists yet

Current Application Protocol commands cover input, execution cancellation, queue promotion, and permission response. Current Agent Protocol has no Program creation vocabulary.

So the creation authority boundary remains a planning decision.

### 4.4 Application Protocol provides useful precedent

Existing behavior already uses:

- stable `commandId`;
- accepted/rejected/stale/duplicate/noop/failed decisions;
- Host-owned structured pending interactions;
- reconnect from Host snapshot/replay;
- disposable renderer state.

These patterns can support exact Program-draft acceptance without moving authority into the Experience Plane.

### 4.5 Caller intent already has durable Host provenance

`HostApplicationService` durably admits accepted user input before Agent execution. A Program objective can preserve and reference this Host-owned source rather than an Agent paraphrase.

### 4.6 Canonical batch append is atomic

`CanonicalAdmissionQueue` serializes Host event-store append work. `WorkspaceEventStore.append()` validates and commits the batch in one SQLite transaction.

That supports atomic creation of the complete initial Program contract.

### 4.7 Exactly-one creation requires more than command-level deduplication

If Program events commit but the accept command is recorded handled in a later transaction, a crash can produce:

```text
accept A
→ Program P commits
→ crash before A recorded handled
→ retry A
→ new ProgramStateId P2
```

So the accept-command result must be part of the same creation transaction.

But command-level deduplication alone is still insufficient. Two clients can use different command IDs against one pending draft:

```text
accept A1 targets draft D
accept A2 targets draft D
```

If both are independently treated as valid commands, both could create Programs.

Therefore the stronger invariant is:

> **One pending creation request / exact draft may be canonically consumed at most once, and that consumption, the accept-command → ProgramStateId mapping, and the complete initial Program event batch must share the same serialized atomic creation cut.**

A later accept command targeting an already-consumed draft/request resolves to the existing Program result (duplicate/noop semantics) rather than minting another ProgramStateId.

### 4.8 Pending draft/request currency is canonical Host state

A draft can become invalid while an acceptance is waiting for environmental mutation exclusion:

- a newer draft supersedes it;
- Host policy changes;
- source session explicitly stops;
- creation request is withdrawn/expired;
- another accept command consumes it.

Therefore a pre-barrier check is not enough. Exact draft identity, source request lifecycle, source-session currency, and policy identity must be revalidated **inside the same serialized canonical admission that consumes the draft and creates the Program**.

### 4.9 Current Agent-idle behavior would otherwise stop the planning session

Current `HostRuntime.handleAgentMessage` handles `agent.idle` by immediately calling `assessAndComplete(sessionId, true)`.

`CognitionCoordinator.assessCompletion` currently blocks session completion for:

- pending operations;
- pending verification contracts;
- blocking diagnostics;
- incomplete durable work;
- non-idle Agent state.

It does **not** currently know about pending Application interactions or a future ProgramCreationDraft.

Therefore an unmodified current flow would do this:

```text
Agent finishes read-only Program planning
→ exact draft becomes pending for Application acceptance
→ Agent reports idle
→ no current completion blocker sees that pending draft
→ session may stop as completed
→ creation rule says stopped source-session draft is stale
```

That would make the preferred normal creation flow self-invalidating.

The Phase 1 creation contract must therefore integrate pending creation interaction state with Host session completion.

### 4.10 Canonical admission does not exclude environmental execution

Current `CapabilityBroker` behavior admits operation requested/started state, then runs `capability.execute()` outside `CanonicalAdmissionQueue`, then later appends terminal/evidence state.

Therefore:

```text
canonical event ordering
!=
environmental mutation lifetime exclusion
```

A long-running mutating capability can execute across another canonical admission.

### 4.11 Workspace/repository state is an observation substrate

The worktree/Git/CodeIntelligence state is not a participant in the SQLite transaction. A creation plan derived from repository state must therefore carry an observation identity; the Host cannot claim a transactionally frozen repository.

### 4.12 Reasoning/model output is not ProgramState authority

Reasoning state, CodeIntelligence observations, tool results, and model output can inform a draft but do not silently become Program truth.

---

# Part II — Authority model

## 5. Distinct roles

### Intent originator

Application/user supplies the objective.

### Semantic planner

Replaceable Agent/model proposes repository-specific decomposition and task-specific verification requirements.

### Policy contributor

Host policy may add deterministic non-removable requirements.

### Semantic acceptance authority

Application caller accepts one exact proposed contract.

### Canonical authority

Host alone validates currentness, consumes the pending creation request/draft, and admits ProgramState.

### Session lifecycle authority

Host owns session completion and must treat a current pending Program creation interaction as unresolved Host-owned work/interaction state. Agent idleness alone cannot close the session while the draft remains accept-able.

### Environmental mutation coordinator

Host coordinates Host-mediated mutating capability execution so already-running mutations cannot cross freshness-critical creation/dispatch checks.

The central distinction is:

```text
Host canonical ownership
!=
Agent semantic authorship
!=
Application semantic acceptance
```

---

# Part III — Requirements

## 6. Non-negotiable creation invariants

### 6.1 Exact objective provenance

Canonical objective preserves caller-supplied intent after ordinary persistence safety/redaction. Agent titles/summaries remain advisory.

### 6.2 No Agent indirect completion authority

A replaceable Agent cannot automatically select a weak or over-broad immutable completion burden merely because the proposal is structurally valid.

### 6.3 No hidden Host-model authority

Putting a model call inside Host code does not make semantic adequacy deterministic.

### 6.4 Complete immutable initial contract

An active Program cannot be canonically visible without its entire accepted initial objective, required topology, and mandatory verification contract.

### 6.5 Single-consumption creation identity

The Host must give the pending creation request/draft a stable Host-owned identity sufficient to answer:

```text
is this exact draft still current and unconsumed?
```

Only the current unconsumed draft/request may create a Program.

### 6.6 Crash-safe exactly-one mapping

One exact accepted creation request/draft maps to at most one ProgramStateId across:

- same-command retry;
- different accept command IDs;
- response loss;
- Host crash;
- reconnect;
- concurrent accept attempts.

The atomic creation cut consumes the draft/request, records the accept-command result/mapping, and writes the complete Program batch together.

### 6.7 Exact-draft stale protection

Changed/superseded draft, policy identity, source objective, explicitly stopped/superseded source session, or non-current request invalidates old acceptance.

Currency is revalidated at the canonical creation linearization point, not only when the command first arrives.

### 6.8 Pending creation interaction blocks ordinary session completion

Once an exact current ProgramCreationDraft is durably presented for Application acceptance:

```text
pending creation interaction
→ session completion blocked
```

The planning Agent may be idle; Agent idleness is not a reason to discard the pending interaction or stop the source session.

The session may leave this blocked state when the pending creation interaction is resolved, for example by:

- successful Program creation/initial attachment;
- explicit rejection/withdrawal;
- expiry/supersession under a defined Application rule;
- explicit session stop/cancellation that makes the draft stale.

After a non-create resolution, normal session completion may be reassessed.

This rule keeps “Program creation occurs under an active Host session” coherent with an asynchronous Application acceptance round trip.

### 6.9 Planning-observation stale protection

Each draft is bound to a bounded `PlanningObservationIdentity`. Changed or unprovably equivalent planning base makes acceptance stale/fail-closed.

### 6.10 Host-mediated mutation exclusion at freshness-critical boundaries

Observation checks are not sufficient while a Host-mediated mutating capability is already executing.

Final creation acceptance must acquire Host-owned Workspace mutating-operation exclusion such that:

- no Host-mediated mutator is executing when final planning-base observation is taken;
- unresolved/indeterminate mutation fails closed for quiescence;
- no unrelated Host-mediated mutator can begin environmental execution before the accepted-creation transaction completes.

Before ProgramAttempt dispatch, Host reacquires the same class of exclusion, checks quiescence/reconciliation, and rechecks the accepted creation base.

### 6.11 Canonical revalidation after waiting for environmental exclusion

The mutation barrier can require waiting. During that wait, canonical state can change.

Therefore after the barrier is acquired and the planning observation is confirmed current, the Host must enter serialized canonical admission and revalidate **all** of:

- exact pending draft identity/digest;
- source creation request is current and unconsumed;
- source session remains active/eligible for creation;
- pending creation interaction remains unresolved/current;
- policy identity still matches;
- no superseding/cancelling Application interaction won the canonical race.

Only then may that same admission atomically consume the draft/request and create the Program.

### 6.12 Host-mediated mutation exclusion during ProgramAttempt execution

If the Host claims an unrelated Host-mediated mutation cannot race an active ProgramAttempt, the environmental exclusion must span execution lifetime, not just `program.attempt.started` admission.

The preferred first-slice direction is therefore that the dispatch barrier transfers/retains Host-mediated mutation authority for the active ProgramAttempt, while read-only work may remain concurrent where safe.

The exact barrier lifecycle is a remaining freeze-readiness dependency.

### 6.13 Creation freshness is not full runtime freshness

The above barrier cannot control arbitrary external editors/processes.

This study guarantees only:

```text
creation acceptance is current at protected creation cut
+
first ProgramAttempt dispatch begins from a revalidated accepted base
+
Host-mediated unrelated mutators cannot cross the protected execution authority
```

It does **not** guarantee:

```text
external worktree remains unchanged for entire ProgramAttempt
```

A separate runtime out-of-band mutation detection/fail-closed contract is required before Phase 1 can make a stronger end-to-end freshness claim.

### 6.14 Read-only pre-Program planning

Before Program creation there is no ProgramAttempt. Creation planning may inspect bounded Workspace state but mutating capability requests fail closed.

### 6.15 Bounded contract

Draft topology, paths, requirements, text, and public representation are bounded before presentation/admission.

### 6.16 No future concrete evidence IDs in immutable requirements

Future ArtifactRefs/evidenceRefs may satisfy requirements later but cannot be creation-time requirement identities.

### 6.17 Host-owned pending draft

A pending acceptable draft must survive reconnect/restart as Host-owned structured state rather than Agent/renderer memory.

---

# Part IV — Alternatives

## 7. Alternative A — Application supplies full structured contract

```text
Application objective + DAG + mandatory verification
→ Host validates
→ Host creates
```

**Strengths:** explicit semantic authority, clean replay/idempotence.  
**Weaknesses:** caller becomes workflow author; poor default natural-language coding UX.

**Result:** correct; accommodate as an advanced path, not preferred default.

## 8. Alternative B — Host deterministically synthesizes from objective

**Strengths:** simple external API.  
**Weaknesses:** arbitrary coding decomposition/verification is not deterministically derivable by current Host; Host-internal model use merely relabels model authorship.

**Result:** reject as a general solution.

## 9. Alternative C — Agent proposes and Host auto-admits

```text
objective
→ Agent DAG/verification
→ Host structural validation
→ automatic creation
```

**Strengths:** excellent autonomous UX.  
**Weaknesses:** Host cannot deterministically prove semantic adequacy; Agent can omit necessary work/verification or over-expand scope and thereby indirectly define the future completion burden.

**Result:** reject as normative first-slice authority model.

## 10. Alternative D — Agent proposes; Application accepts exact fresh draft; Host atomically consumes and creates

```text
caller objective
→ Host creation request R
→ capture planning observation B0
→ read-only Agent proposal D(B0)
→ Host structural/policy validation + mandatory policy additions
→ Host persists current pending draft identity D/H(D,B0,P0) under R
→ pending creation interaction blocks ordinary session completion
→ Agent may become idle while source session remains active
→ Application accept command A targets exact D/H
→ Host acquires Workspace mutating-operation exclusion
→ waits/fails closed on active or unreconciled Host-mediated mutator
→ reobserve base
→ mismatch/unknown => stale, no Program
→ enter serialized canonical admission
→ revalidate D is still current/unconsumed under R
  + pending interaction still current
  + source session active
  + policy still P0
  + no superseding interaction won
→ one atomic transaction:
     consume R/D
     + resolve pending creation interaction as accepted
     + record accept A → ProgramStateId P
     + complete initial Program contract/attachment
→ Program active under that source session
```

At first dispatch:

```text
acquire mutation exclusion
→ check Host-mediated mutation quiescence/reconciliation
→ recheck accepted base
→ stale => no dispatch
→ current => admit ProgramAttempt
→ retain/transfer Host-mediated mutation authority for attempt lifetime
```

**Strengths:** natural Agent planning; exact semantic acceptance; pending decision survives Agent idle; current planning base; Host policy minima; exactly-one creation across same/different accept command IDs; stale policy/session/draft races close at one canonical cut; no false reliance on canonical ordering for Host-mediated mutation isolation.  
**Weaknesses:** extra interaction; new pending-draft lifecycle and session-completion blocker; observation identity; environmental mutation coordination; does not by itself solve out-of-band external edits after dispatch.

**Result:** **preferred, conditional on separate attempt-time out-of-band mutation semantics before Phase 1 freeze.**

## 11. Alternative E — canonical `planning` lifecycle then finalize

Coherent and durable for iterative planning, but adds a new lifecycle, mutable pre-active contract, recovery/cancellation rules, and still needs semantic acceptance/freshness.

**Result:** defer unless durable multi-turn planning becomes a concrete requirement.

## 12. Alternative F — explicit delegated auto-accept

Caller explicitly delegates acceptance of any bounded Agent plan passing Host validation.

Better than silent auto-admit, but caller never accepts the exact immutable burden.

**Result:** accommodate/defer as later convenience mode.

## 13. Alternative G — objective-only active Program, Agent fills contract later

Makes required contract mutable after creation and reopens post-creation Agent scope-expansion problem.

**Result:** reject.

## 14. Alternative H — second model/judge accepts plan

Potential quality signal, not a deterministic authorization principal.

**Result:** advisory only.

---

# Part V — Canonical/adversarial histories

## 15. Normal preferred creation

```text
C supplies O / opens creation request R
→ capture B0
→ Agent proposes D(B0)
→ Host validates + policy-adds
→ current pending D/H(D,B0,P0) durable under R
→ pending creation interaction blocks session completion
→ Agent reports idle; session remains active awaiting Application decision
→ A accepts H
→ acquire Host mutation exclusion
→ no active/unreconciled Host mutator
→ current base == B0
→ enter canonical admission
→ D/R/pending interaction/session/policy all still current
→ atomic consume(R,D) + resolve interaction + A→P + complete Program batch/attachment
→ P active under same source session
```

## 16. Planner becomes idle before user decides

Current source behavior would otherwise attempt session completion on `agent.idle`.

Required Phase 1 result:

```text
ProgramCreationDraft D is pending/current
→ Agent reports idle
→ completion assessment sees pending Program-creation interaction
→ session completion rejected/blocked
→ D remains current and acceptable
```

The Agent need not keep producing tokens or reasoning. What remains active is the Host session/interaction authority required for acceptance.

## 17. Pending interaction resolved without Program creation

```text
D pending
→ user rejects/withdraws D (or defined expiry/supersession resolves it)
→ creation interaction no longer blocks session completion
→ Host may reassess ordinary session completion
```

No `program.cancelled` event is needed because no Program existed.

## 18. Weak Agent draft

Agent omits a semantic requirement but draft is structurally legal.

Without exact Application acceptance: no Program. The Agent is proposer, not semantic acceptance authority.

User acceptance is authority, not proof that the plan is objectively good.

## 19. Over-broad Agent draft

Agent adds unrelated cleanup to a narrow objective. DAG validity cannot prove necessity. Exact proposed scope must be accepted rather than auto-admitted.

## 20. Draft superseded before command arrives

```text
D1/H1 current under R
→ D2/H2 supersedes D1
→ accept H1
```

Result: stale; no Program.

## 21. Draft superseded while acceptance waits for mutation barrier

```text
A accepts current D1/H1
→ A waits for long-running Host mutator
→ canonical interaction supersedes D1 with D2
→ barrier later acquired
→ B0 still happens to match
→ creation enters canonical admission
```

Required result:

```text
revalidation sees D1 no longer current
→ stale
→ no Program from D1
```

Environmental freshness does not substitute for canonical draft currency.

## 22. Explicit source-session stop while draft is pending

Ordinary Agent-idle completion is blocked, but explicit session stop/cancellation may still win a canonical race.

```text
D pending under session S
→ explicit stop of S admitted
→ later accept D
```

Result: stale; no Program. A later session starts a fresh creation flow.

## 23. Policy/session changes while acceptance waits

```text
A targets D under policy P0 and active session S
→ waits for mutation exclusion
→ policy becomes P1 OR explicit stop of S wins
→ barrier becomes available
```

Creation admission revalidates current policy/session and rejects stale. A pre-wait check is insufficient.

## 24. Two distinct accept commands race one draft

```text
A1 targets current D/H under R
A2 targets same current D/H under R
```

Canonical admission serializes them.

If A1 wins:

```text
A1 admission consumes R/D and creates P
→ A2 admission observes R/D already consumed
→ duplicate/noop result references P
→ no P2
```

Different `commandId` values do not bypass semantic single-consumption.

## 25. Policy changed before initial acceptance

```text
D under P0
→ policy P1 adds required verification
→ accept old H
→ stale; re-present
```

## 26. Workspace changed while draft pending

```text
D planned at B0
→ Workspace becomes B1
→ accept D
→ protected final reobserve B1
→ B1 != B0
→ stale; no Program
```

## 27. Long-running Host-mediated mutation predates acceptance

Current CapabilityBroker shape permits:

```text
operation.started
→ capability.execute() running outside admission queue
→ creation acceptance arrives
```

Unsafe: reobserve while mutation is still running, create, then mutation writes.

Preferred: creation cannot cross that mutating execution lifetime; barrier acquisition waits/fails closed until terminal/reconciled quiescence, then reobserves.

## 28. New Host-mediated mutation arrives during final creation

While creation owns environmental mutation exclusion, unrelated mutating capability execution cannot start. Final policy may reject, queue, or delay it, but it cannot cross the protected boundary.

## 29. Mutation occurs while Program is parked before dispatch

Creation barrier is not held indefinitely. A foreground mutation may legitimately occur while Program is active but undispatched. Later dispatch reacquires exclusion and rechecks accepted base. Changed base => no ProgramAttempt.

## 30. Host-mediated mutator tries to cross attempt start

Scheduler acquires exclusion before final base check and does not release a gap before ProgramAttempt environmental authority begins. Unrelated Host-mediated mutator cannot cross the active attempt's protected execution authority.

## 31. External edit after dispatch

```text
ProgramAttempt begins from validated B0
→ human editor/non-ALCODE process changes repository
```

This is **outside the creation-freshness guarantee**. The Host mutation barrier cannot prevent it.

The study therefore does not claim that the attempt remains continuously based on B0.

Before Phase 1 freeze, a separate runtime rule must decide how ALCODE detects and fails closed on out-of-band changes during attempts. Credible directions include observation checks at mutating capability admission, evidence admission, verification satisfaction, and/or Completion Oracle cuts, but this study does not select that runtime policy.

## 32. Same-command duplicate acceptance / response loss

```text
A accepted
→ atomic consume(R,D) + resolve interaction + A→P + Program P commits
→ response lost / crash
→ A retried
→ duplicate maps to P
```

No second ProgramStateId.

## 33. Different-command duplicate acceptance after response loss

```text
A1 consumes R/D and creates P
→ client did not receive result
→ another client sends A2 targeting same D/H
```

Result:

```text
R/D already consumed by P
→ A2 duplicate/noop references P
→ no second Program
```

## 34. Crash during atomic creation

Replay sees either:

```text
R/D still pending, pending interaction unresolved, no A→P, no Program batch
```

or:

```text
R/D consumed by P
+ pending interaction resolved accepted
+ A→P mapping
+ complete Program batch
```

Never partial Program and never consumed-without-Program if those facts are one transaction.

## 35. Crash/replacement during planning

No Program exists. Agent-local partial plan is disposable. Replacement planning restarts from durable caller intent and fresh observation.

## 36. Crash after pending draft presentation

Host-owned pending state recovers exact draft/lossless reference, digest, source request, planning observation, policy identity, source session, pending/consumed lifecycle, and the fact that it blocks ordinary session completion while current.

A regenerated different draft cannot inherit old acceptance.

## 37. UI disconnect

Disconnect does not cancel pending draft or stop the Host session. Reconnect uses Host state.

## 38. Source session explicitly stops before acceptance

First-slice rule: pending draft becomes stale/non-acceptable; later session starts a fresh creation flow.

Ordinary idle-driven completion is distinct and is blocked while the draft is current.

## 39. Pre-Program planner requests mutation

Fail closed. Planning is read-only.

## 40. Future ArtifactRef/evidenceRef used as immutable requirement ID

Reject. Requirement must have stable logical identity/semantics at creation.

---

# Part VI — Preferred semantic shapes

## 41. ProgramCreationDraft

Illustrative shape:

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

The Host-owned pending interaction also needs a lifecycle equivalent to:

```text
current pending draft
| superseded/stale/withdrawn/rejected
| consumed by ProgramStateId
```

Exact event/type names remain implementation design.

Draft-local keys wire work/verification before canonical IDs exist. Host mints canonical Program/WorkItem/VerificationObligation IDs during accepted creation.

Exact draft digest covers all semantics whose change would alter acceptance.

## 42. PlanningObservationIdentity

A bounded identity for repository/Workspace facts materially used in planning. Depending on final design it may include/digest:

- Git HEAD;
- dirty-worktree/bounded workspace fingerprint;
- repository configuration identity;
- relevant-path observations;
- CodeIntelligence revision/provider observation when relied upon;
- Host canonical event cut supplied to planning.

Required properties:

1. Host can decide whether accepted planning base remains equivalent at creation/dispatch;
2. unknown equivalence fails closed;
3. it remains an observation identity, not a second canonical Workspace truth system.

## 43. Verification authorship

Agent may propose task-specific deterministic verification requirements. Host policy may add non-removable requirements.

Host can mechanically validate schema, bounds, predicate kind, freshness-scope shape, policy minima, draft references, and ban future concrete evidence identities.

Host cannot generally prove semantic sufficiency of an arbitrary finite verification set for natural-language intent. That is why semantic acceptance is distinct.

## 44. Topology authorship

Agent proposes repository-specific DAG; Host validates bounds/DAG/policy; Application accepts exact topology as part of draft.

This does not grant post-creation automatic Agent work-add authority.

## 45. Pending draft durability, session blocker, and single consumption

Host-owned pending state preserves:

```text
creationRequestId
+ current draftId
+ draft or lossless bounded reference
+ digest
+ planning observation
+ policy identity
+ source session
+ lifecycle/currentness
+ consumed ProgramStateId when applicable
```

Before acceptance it is interaction/provenance state, not ProgramState truth.

Its current/unconsumed state is nevertheless canonical **Application control state** for deciding both:

- whether Program creation is authorized; and
- whether ordinary Host session completion is currently allowed.

A current pending creation draft is a session-completion blocker even when the Agent is idle.

## 46. Accepted-creation transaction

One serialized event-store transaction must atomically establish all semantic effects of successful acceptance:

```text
creation request/draft R/D:
  pending/current → consumed by ProgramStateId P

pending creation interaction:
  unresolved → accepted/resolved by ProgramStateId P

accept command A:
  accepted → ProgramStateId P

Program P:
  complete initial canonical contract + source-session attachment
```

Conceptually Program facts include:

```text
program.created
program.session.attached
program.work.added × N
program.verification.required × M
```

Exact event spelling may differ; atomic semantics may not.

This transaction revalidates immediately before append that:

- R/D is still current and unconsumed;
- exact digest matches the accepted draft;
- pending interaction remains unresolved/current;
- source session is active/eligible;
- policy identity still matches;
- the Host-observed planning base was confirmed current under mutation exclusion;
- no canonical superseding interaction has won before this cut.

## 47. Host-mediated mutation exclusion

The study does not prescribe a class name or lock implementation. It requires a Host-owned mechanism whose protected interval spans environmental execution, not just event append.

At creation:

```text
accept command received
→ acquire exclusion
→ wait/fail closed on active/unreconciled Host mutator
→ final Workspace observation recheck
→ enter canonical admission
→ revalidate R/D/pending interaction/session/policy currentness
→ atomically consume+resolve+create
→ release
```

At dispatch:

```text
acquire exclusion
→ quiescence/reconciliation check
→ accepted-base recheck
→ admit ProgramAttempt
→ retain/transfer Host-mediated mutation authority for attempt lifetime
```

Read-only operations may remain concurrent where safe.

---

# Part VII — Cross-decision consequences

## 48. Completion contract

If verification-centered completion is promoted, this study supplies creation authorship/acceptance for mandatory verification requirements.

## 49. Verification freshness

Keep separate:

```text
PlanningObservationIdentity
  creation/dispatch plan base

ProgramCreationRequestId / ProgramCreationDraftId
  exact semantic authorization + single consumption

ProgramState revision + ProgramAttemptId
  execution claim currency

verification subjectGeneration
  verification satisfaction currency
```

Attempt-time out-of-band mutation detection may consume the same observation substrate but must not collapse these identities.

## 50. Agent work addition

Accepted initial Agent planning is not post-creation Agent topology authority.

## 51. Structural bounds

Creation drafts and pending public representation require final local/aggregate limits plus their own explicit bounded serialized size.

## 52. Operation correlation/uncertainty

Creation/dispatch must fail closed while a Host-mediated mutating operation is still executing or its effect remains unresolved/indeterminate for mutation safety.

## 53. Session lifecycle

A pending creation interaction is a new Phase 1 Host-owned session-completion blocker.

This does not redefine Program completion. It prevents the **pre-Program source session** from being auto-completed by `agent.idle` while an exact Program-creation decision is outstanding.

The blocker disappears when the interaction resolves or is explicitly invalidated.

## 54. Scheduler concurrency

“One active ProgramAttempt per Workspace” does not alone exclude foreground/non-Program mutating capabilities.

If this study is promoted, consolidation must represent Host-mediated environmental mutation exclusion as a separate invariant or scheduler/capability integration refinement.

## 55. Out-of-band runtime mutation

This is an explicit **separate freeze-readiness decision**, not an assumed property of Program creation.

The eventual Phase 1 contract must decide how an active ProgramAttempt detects/fails closed when external, non-Host-mediated changes invalidate the workspace observation it is operating against.

---

# Part VIII — Acceptance-proof consequences

## 56. Existing ACs can absorb creation semantics

No new AC family is required for the creation-authorship decision itself.

- **AC-10-02:** complete accepted objective/topology/mandatory verification at one rebuildable creation cut.
- **AC-10-03:** current source-session creation; pending creation draft blocks ordinary session completion; explicit stopped-session draft rejects stale.
- **AC-10-05:** initial DAG bounds; no dispatch on stale accepted base; Host-mediated mutation exclusion at dispatch.
- **AC-10-06:** active/unreconciled mutating operation blocks protected creation/dispatch.
- **AC-10-08:** runtime evidence cannot rewrite creation-time mandatory requirements.
- **AC-10-09:** replacement/idle cannot promote or discard Agent-local/pending creation state incorrectly; creation recovery preserves exact single consumption and exactly-one Program mapping.
- **AC-10-10:** creation request/draft/accept, pending interaction blocker, stale/duplicate, pending reconnect, single-consumption lifecycle, atomic command/draft→Program mapping, UI/Agent no direct create.

Attempt-time out-of-band mutation detection may require refinement of AC-10-04/05/06/07 once its policy is selected; this study does not pretend that proof already exists.

## 57. Required negative proofs if promoted

```text
Agent draft exists + no exact acceptance
→ no Program
```

```text
D pending
→ Agent reports idle
→ session remains active because creation interaction is unresolved
→ D remains acceptable
```

```text
D pending
→ explicit session stop wins
→ D stale
→ later acceptance rejected
```

```text
D1 superseded by D2
→ accept D1
→ stale
```

```text
accept D1 starts
→ waits on mutation barrier
→ D2 supersedes D1 / policy changes / session explicitly stops
→ admission revalidates
→ stale; no Program from D1
```

```text
A1 and A2 use different command IDs for same current draft D
→ exactly one consumes D and creates P
→ other returns duplicate/noop referencing P
```

```text
D planned at B0
→ Workspace B1 before creation
→ accept
→ stale; no Program
```

```text
Host mutating O still executing
→ creation tries finalization
→ cannot cross O lifetime
```

```text
creation exclusion held
→ unrelated Host mutator requests start
→ no environmental execution until exclusion released
```

```text
Program parked
→ Workspace changes
→ later dispatch
→ stale base; no ProgramAttempt
```

```text
ProgramAttempt has Host mutation authority
→ unrelated Host mutator tries to start
→ cannot cross protected attempt lifetime
```

```text
atomic accepted creation commits
→ response lost / crash
→ retry same accept command
→ same ProgramStateId
```

```text
atomic accepted creation commits
→ different accept command targets same draft
→ consumed draft maps to existing ProgramStateId
→ no duplicate Program
```

```text
crash inside accepted-creation transaction
→ replay sees pending/unconsumed interaction with no Program
  OR resolved/consumed + command mapping + complete Program
```

```text
pre-Program planner requests mutation
→ reject
```

```text
pending draft survives Host/UI reconnect exactly and still blocks idle completion
```

No test in this section claims that an arbitrary external editor cannot change the worktree after dispatch.

---

# Part IX — Comparison and recommendation

## 58. Comparison

| Alternative | Semantic authority | Natural-language UX | Creation freshness | Single consumption/idempotence | Session-lifecycle coherence | Result |
|---|---|---|---|---|---|---|
| A. Application full contract | strong | weak default | strong possible | strong | simple | accommodate |
| B. Host deterministic synthesis | unsupported general semantics | good | possible | possible | simple | reject |
| C. Agent auto-admit | weak | excellent | possible | possible | simple | reject |
| D. Exact fresh Application acceptance + atomic consume/create | strong | good | **strong at creation/dispatch** | **strong** | **explicit blocker** | **prefer conditionally** |
| E. Canonical planning lifecycle | strong | good | strong | strong | large new lifecycle | defer |
| F. Delegated auto-accept | intentionally weaker | excellent | strong | strong | simple | defer |
| G. Objective-only mutable contract | weak | good | complex | complex | complex | reject |
| H. Model/judge acceptance | no deterministic principal | good | possible | possible | simple | advisory only |

## 59. Recommendation

**Recommend Alternative D for the first executable Phase 1.0 creation model, conditional on resolving the separately identified attempt-time out-of-band mutation policy before Phase 1 freeze.**

Preferred chain:

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
Host-owned exact current pending D/H(D,B0,P0)
        ↓
pending creation interaction blocks ordinary session completion
        ↓
Agent may idle; source session remains active
        ↓
Application accept command A targets exact D
        ↓
Host mutating-operation exclusion
+ current B0 revalidation
        ↓
serialized canonical revalidation:
  D still current/unconsumed
  pending interaction unresolved/current
  R still current
  source session still active/eligible
  policy still P0
        ↓
atomic transaction:
  consume R/D by ProgramStateId P
  + resolve interaction accepted
  + A→P
  + complete initial Program contract + attachment
        ↓
Program active
        ↓
when first dispatch is considered:
Host mutating-operation exclusion
+ accepted-base recheck
+ ProgramAttempt admission
+ Host-mediated mutation authority transfer/retention
```

Concise rule:

> **The caller authors intent; the Agent proposes semantics; Host policy may add mandatory constraints; the Application accepts an exact current pending contract; the Host keeps that pending interaction alive across Agent idle, then alone revalidates and single-consumes the authorization while making complete Program creation atomic and canonical. Creation/dispatch freshness is protected from Host-mediated mutating execution, but it is not a claim of full worktree snapshot isolation after dispatch.**

---

# Part X — Remaining freeze-readiness dependencies

## 60. Closed verification-requirement predicate taxonomy

Must be defined well enough to author immutable creation-time requirements without future concrete evidence IDs or free-text truth evaluation.

## 61. PlanningObservationIdentity

Must define the minimum bounded Workspace/repository observation sufficient to reject stale draft acceptance/dispatch while reusing existing observation substrate where possible.

## 62. Host-mediated Workspace mutation barrier

Must define:

- owner;
- acquisition/release around mutating capability execution;
- interaction with ProgramAttempt lifetime;
- cancellation/timeout/crash behavior;
- indeterminate/reconciliation behavior;
- foreground work rejection/queueing/delay;
- read-only concurrency.

## 63. Pending creation lifecycle and session-completion integration

The final contract must specify enough Host-owned Application control state to prove:

```text
one creation request
→ one current exact draft at a time
→ current pending draft blocks ordinary session completion
→ at most one consumed ProgramStateId
```

including supersede/reject/withdraw/expiry/explicit-session-stop/consumed behavior and duplicate acceptance with different command IDs.

This can remain an Application-domain interaction model; it does not require a canonical `planning` ProgramState lifecycle.

## 64. Attempt-time out-of-band mutation detection

This is a **separate correctness dependency**.

The frozen Phase 1 contract must decide what happens if a human editor or non-ALCODE process changes the repository after ProgramAttempt dispatch.

Possible solution families to study separately include:

- fail-closed Workspace observation checks before every mutating Program capability admission plus verification/completion cuts;
- attempt-scoped expected observation generations advanced only by Host-correlated Program effects;
- filesystem/repository snapshot or stronger isolation where available;
- a hybrid observation-generation + correlation model.

This study deliberately does not pick among them because that is an execution-freshness decision, not a semantic-authorship decision.

Until it is resolved, no consolidated Phase 1 contract should claim continuous attempt/worktree freshness.

## 65. Planning status

This remains a recommendation only.

It does not amend the governing plan, supersede the existing seven-decision study, consolidate amendments, approve/freeze Phase 1.0, or authorize implementation.