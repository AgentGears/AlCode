# ALCODE Phase 1.0 — Program Creation and Contract Authorship Study

**Status:** DRAFT / non-normative planning study  
**Approval:** not approved; not frozen; implementation not authorized  
**Repository base studied:** `main` at `ff211b5c0c7d9f93946ab6a2ad42e45a58ca693c`  
**Relationship to Phase 1.0:** studies one additional contract question exposed by the interaction between Program creation, immutable completion requirements, and the first-slice topology decision. It does not amend `docs/phase-1.0-plan.md`, change AC-10 acceptance criteria, approve/freeze Phase 1.0, or authorize implementation.

## 1. Purpose

The current Phase 1.0 draft says that the Host owns ProgramState and Program creation, that Program creation occurs under a Host session, and that the objective/completion contract is immutable after creation. The current alternatives study additionally recommends a first-slice completion contract of universal Host Completion Oracle predicates plus immutable mandatory verification requirements, while deferring Agent-originated canonical work addition after creation.

Taken together, those choices expose a question that is not answered explicitly:

> Who supplies the semantic content of the initial Program contract — the objective, initial required work topology, and mandatory verification requirements — and who is authorized to accept that content before the Host makes it canonical?

“Host owns ProgramState” answers the canonical-admission question. It does **not** by itself answer semantic authorship or semantic acceptance.

This study separates those roles, compares credible first-slice alternatives, and pressure-tests the creation boundary for stale workspace observations and crash-safe idempotency.

## 2. Decision scope

This study is limited to the creation boundary before the first `ProgramAttempt` is issued.

The decision concerns:

- origin of the immutable objective;
- authorship of the initial required work DAG;
- authorship of mandatory verification requirements;
- Host policy additions to those requirements;
- whether Agent/model planning output may become canonical automatically;
- whether an Application/user authorization is required for the exact proposed contract;
- what Workspace/repository observation the proposed contract is valid for;
- when the contract becomes immutable;
- crash/replacement/reconnect semantics before and during creation;
- atomicity and idempotence of the canonical creation cut.

It does **not** decide:

- post-creation topology mutation beyond the already-studied Decision 3;
- exact verification predicate taxonomy;
- exact structural bound values;
- Phase 1 implementation details that do not affect authority, freshness, or replay semantics;
- future plan versioning/amendment;
- subagents, remote workers, distributed planning, or general workflow engines.

## 3. Method

The same alternatives-study method is used here:

1. derive the requirement from the current governing draft and current source;
2. separate semantic authorship from canonical authority;
3. enumerate genuinely distinct alternatives, including removal/deferral of mechanisms;
4. attack each with normal, stale, crash, replacement, replay, reconnect, concurrent-workspace-change, and authority-failure histories;
5. eliminate alternatives with unresolved duplicate authority, silent contract mutation, stale acceptance, partial creation, duplicate creation after crash, or model output becoming terminal authority without an explicit authorization boundary;
6. compare surviving alternatives on scope, complexity, testability, UX, and successor compatibility;
7. recommend the smallest correct first-slice authority model.

Correctness is a gate. Convenience does not compensate for an unresolved authority failure.

---

# Part I — Repository facts and derived constraints

## 4. Current repository facts

### 4.1 The Host already owns Program creation and canonical admission

`docs/phase-1.0-plan.md` assigns creation/attachment, canonical ProgramState admission, scheduling, verification admission, and terminal authority to `@alcode/host-runtime`.

The draft also says:

```text
Program creation occurs under a Host session
and records the initial attachment.
```

This establishes **canonical ownership**, not semantic authorship.

### 4.2 The objective is intended to be immutable

The draft currently models an objective and completion criteria on ProgramState and says that objective/completion contract is immutable after creation for Phase 1.0.

The existing open-decisions study recommends replacing the concrete-reference `CompletionCriterion[]` with:

```text
immutable objective
+ immutable mandatory verification requirements
+ universal Completion Oracle invariants
```

That recommendation is non-normative, but if later promoted it makes creation-time obligation authorship load-bearing.

### 4.3 Static first-slice topology makes initial decomposition load-bearing

The existing open-decisions study recommends that the first executable slice not admit Agent-originated canonical work addition after creation.

Under that recommendation:

```text
initial required topology
=> future scheduler work universe
```

so initial decomposition is not merely advisory planning text. It becomes part of what the Host requires before completion.

### 4.4 The current plan names Agent proposals but not a creation protocol

`docs/phase-1.0-plan.md` lists proposed Agent proposal classes including work decomposition/addition, evidence, blockers, verification evidence, and artifact/evidence references.

There is no current Phase 1 contract specifying:

- a `program.create` Application command;
- a Program creation draft/proposal message;
- a Program creation approval interaction;
- an exact draft identity/digest;
- the Workspace/repository observation against which a draft was planned;
- who authors mandatory verification requirements before creation;
- the crash-safe mapping from an accepted creation command to exactly one ProgramStateId.

### 4.5 The current Application Protocol accepts natural-language input, not Program contracts

`packages/application-protocol/src/types.ts` currently exposes:

```text
input.submit
execution.cancel
queue.promote
permission.respond
```

`input.submit` carries free text plus requested disposition. There is no Program creation command and no generic semantic-contract approval interaction.

The Application Protocol does establish useful principles:

- commands have stable `commandId` identity;
- decisions distinguish accepted/rejected/stale/duplicate/noop/failed;
- pending interactions are Host-owned structured state;
- reconnect rebuilds from Host snapshot/events rather than renderer memory;
- the Experience Plane never becomes canonical authority.

### 4.6 Current user intent is admitted without Agent semantic rewriting

`HostApplicationService` durably records accepted input and execution state before delivering START_NOW work to the Agent.

The Application input text therefore already has a durable Host-owned source command/event identity that can serve as provenance for a Program objective.

### 4.7 The current Agent Protocol has no Program creation vocabulary

`packages/agent-protocol/src/messages.ts` currently has session/input/context/capability/evidence/idle messages but no `program_state_v1`, Program creation draft, ProgramAttempt, or Program proposal message.

Any first-slice creation-planning protocol is new work and should be kept narrow.

### 4.8 Host admission can atomically append a batch

`CanonicalAdmissionQueue` serializes Host state-changing work around one Workspace event store.

`WorkspaceEventStore.append()` admits all drafts before SQL and writes the complete batch inside one SQLite transaction. If one draft fails, the batch is not partially persisted.

That gives Phase 1 a natural creation linearization point:

```text
validate exact accepted creation contract
→ append the command-to-Program acceptance mapping
  + complete initial Program event batch
  in one transaction
```

An active ProgramState does not need a partially initialized intermediate state.

### 4.9 Existing duplicate handling depends on durable command identity

The existing Application service detects duplicates by finding a previously persisted command decision/effect. That precedent matters for Program creation.

If the Host were to commit the Program events first, crash, and only later persist that the accept command had been handled, a retry could mint a second ProgramStateId.

Therefore the first-slice creation invariant must be stronger than “the Program events are atomic”:

> **The semantic acceptance command must be durably bound to the created ProgramStateId in the same atomic creation cut, or the ProgramStateId must be deterministically derived from a stable creation identity.**

This study recommends the first form because it composes directly with current Application command idempotence.

### 4.10 Existing architecture distinguishes proposal from authority

ADR 0005 says:

```text
Agent proposes actions and produces evidence.
Host authorizes, persists, mediates, and performs lifecycle transitions.
```

The same architecture permits Agent-proposed semantic transitions to cross a Host validation/admission boundary while keeping Host canonical authority.

But initial Program topology and mandatory verification requirements define the future completion burden. If the Agent controls those semantics without another authorization boundary, it can indirectly control when Host completion becomes reachable.

### 4.11 Reasoning state is not ProgramState authority

The current reasoning subsystem already has objective and verification-planning concepts, but Phase 1 explicitly keeps reasoning and ProgramState as independent reducers.

A reasoning objective or `verification.planned` node may inform a Program creation draft; it must not silently become ProgramState truth.

### 4.12 Current design notes separate objective, decomposition, and evidence

`docs/phase-1.0-design-notes.md` recommends preserving a separation between:

- immutable objective/completion contract;
- work decomposition;
- implementation evidence/artifacts;
- verification obligations and satisfaction evidence;
- Host completion decision.

That separation is compatible with Agent planning, but still leaves open who accepts the initial decomposition and obligations.

### 4.13 Workspace/repository state is observation, not a SQLite transaction participant

ALCODE already distinguishes canonical Host event state from mutable workspace/Git observations. There is no transaction spanning SQLite and the external worktree.

A ProgramCreationDraft that was semantically derived from repository state is therefore valid only relative to the bounded observation it planned against.

This creates a distinct freshness requirement:

```text
planning base != Program revision
planning base != ProgramAttemptId
planning base != verification subjectGeneration
```

The creation draft needs its own bounded **planning observation identity**.

### 4.14 Pre-Program planning does not naturally consume Program scheduler authority

No ProgramState exists before creation, so there is no ProgramAttempt yet. A creation planner can therefore run under the existing supervised session/foreground execution machinery, but it must not gain mutating ProgramAttempt authority by implication.

---

## 5. Role decomposition

The creation question becomes clearer if five roles are named separately.

### 5.1 Intent originator

The source that says what the Program is for.

For the normal product path this is the Application/user request.

### 5.2 Semantic planner

The component that proposes a bounded decomposition and task-specific verification requirements.

For the normal coding-agent path this is naturally the replaceable Agent/model, operating under Host supervision.

### 5.3 Policy contributor

The Host may impose deterministic non-removable requirements independent of Agent preference, for example repository/product policy verification.

### 5.4 Semantic acceptance authority

The actor authorized to say:

> This exact proposed objective/work/verification contract, for this exact planning observation, is the Program I intend to create.

This role is not automatically the same as the semantic planner or canonical owner.

### 5.5 Canonical authority

Only the Host may turn the accepted contract into canonical `program.*` state.

The central distinction is:

```text
Host canonical ownership
!=
Agent semantic authorship
!=
Application semantic acceptance
```

---

## 6. Non-negotiable first-slice requirements

### 6.1 Exact objective provenance

The Program objective must have a mechanically discoverable source. Agent paraphrase must not silently replace the caller's objective.

### 6.2 No Agent indirect completion authority

An Agent must not be able to choose a trivially weak work/verification contract and thereby make `program.completed` reachable without an explicit authorization boundary.

### 6.3 No hidden model-as-truth authority

Moving the same LLM call from the Agent process into the Host does not make semantic plan adequacy deterministic. A Host-invoked model remains a proposal source unless another explicit rule authorizes its output.

### 6.4 Immutable active contract

Once the Program becomes active, the first-slice immutable objective and mandatory verification contract cannot be silently changed by later execution evidence.

If static topology is selected, the initial required DAG is also fixed except for explicit Host mechanisms authorized by the final contract.

### 6.5 Atomic complete initial state

A crash must not leave:

```text
program.created
but no required work/verification contract
```

or any other partially initialized active Program.

### 6.6 Crash-safe exactly-one creation mapping

Duplicate/retried delivery of one accepted creation command must map to exactly one ProgramStateId even if the Host crashes at the creation boundary.

The acceptance/command decision mapping must therefore be included in the same atomic transaction as initial Program creation, or an equivalently strong deterministic Program identity rule must be used.

### 6.7 Exact-draft stale protection

If a draft is revised, policy changes, the source objective changes, the source session stops, or the pending creation request is superseded, an old acceptance must not create a different/newer Program contract accidentally.

### 6.8 Planning-observation stale protection

The exact draft must be bound to the bounded Workspace/repository observation used to produce it.

If that observation changes before acceptance, or if the Host cannot establish equivalence, acceptance fails stale/fail-closed and a fresh plan is required.

### 6.9 Replacement/reconnect honesty

Agent replacement or UI reconnect must not reconstruct the accepted contract from old Agent memory or renderer-local state.

### 6.10 Bounded planning

Creation proposals must obey structural bounds before they can become canonical.

### 6.11 No runtime-generated completion references

Creation-time mandatory requirements must use stable requirement semantics/identities known at creation. A draft cannot require a future concrete ArtifactRef or future canonical evidence reference as the immutable requirement itself.

### 6.12 No mutation before contract authorization

Creation planning should not mutate the workspace before the Program contract is authorized. Otherwise the system can cause environmental effects for work that has not yet become an accepted Program.

For the first slice, creation planning should therefore be read-only at the capability boundary.

### 6.13 No false filesystem transaction claim

Because external workspace state is not transactionally locked with the event store, the contract must not claim that one SQLite admission transaction freezes the repository.

The Host must instead:

1. bind the draft to a captured planning observation;
2. re-observe/revalidate that base immediately before creation admission;
3. serialize Host-mediated mutations against the creation admission where possible;
4. recheck the accepted creation base before first ProgramAttempt dispatch;
5. fail closed if the base has changed.

For immutable first-slice topology, a post-creation/pre-dispatch base mismatch cannot be repaired by silently changing the Program. The Program must remain non-dispatchable and require explicit cancellation/recreation or another later-approved recovery rule.

---

# Part II — Alternatives

## 7. Alternative A — Application supplies the full structured contract

The Application command provides:

```text
objective
initial work DAG
mandatory verification requirements
planning observation identity
```

The Host validates and atomically creates the Program. The Agent does not participate in contract authoring.

### Advantages

- strongest explicit semantic authority boundary;
- no model-generated contract becomes canonical implicitly;
- simple Host validation and replay;
- exact command content can be idempotently bound to creation;
- useful future API path for advanced callers or externally generated plans.

### Disadvantages

- requires the caller to understand internal Program DAG and verification vocabulary;
- moves coding-agent planning responsibility into the Experience Plane/caller;
- poor default product ergonomics for natural-language coding tasks;
- duplicates planning logic outside the Agent;
- does not exploit the semantic planner the product already owns.

**Classification:** correct; accommodate as a possible advanced API, not the preferred default path.

## 8. Alternative B — Host deterministically synthesizes the contract from objective text

The Application supplies only objective text. The Host creates the work DAG and verification requirements without Agent participation.

### Advantages

- Host appears to be the source of all Program semantics;
- no approval round trip;
- simple external API.

### Disadvantages

- arbitrary coding-task decomposition is not deterministically derivable from free text by the current Host;
- task-specific verification often requires semantic repository reasoning;
- invoking a model inside the Host merely hides Agent/model authorship rather than removing it;
- describing model-generated Host planning as deterministic Host truth would violate the observation/authority discipline.

**Classification:** reject as a general Phase 1 solution.

## 9. Alternative C — Agent proposes the entire contract and Host auto-admits it

Flow:

```text
Application objective
→ Agent proposes initial DAG + mandatory verification
→ Host validates bounds/schema/DAG/policy
→ Host creates Program automatically
```

### Advantages

- natural agent UX;
- minimal interaction latency;
- Agent can inspect repository context and produce task-specific decomposition;
- Host still owns canonical append and structural validation.

### Disadvantages

- structural validation cannot prove semantic adequacy to the objective;
- Agent may omit required work/verification and make completion too easy;
- Agent may over-expand the initial Program while remaining structurally valid;
- Agent indirectly defines the objective-specific completion burden;
- no external principal accepts the exact semantics before they become immutable.

### Authority-failure history

```text
caller objective: fix bug and preserve backward compatibility
→ Agent draft contains one work item: "edit parser"
→ Agent draft contains no compatibility verification
→ DAG/bounds/predicate kinds are structurally valid
→ Host auto-admits
→ work eventually completes
→ universal Oracle predicates can become true
```

The Host has not proven semantic adequacy. Automatic admission would make Agent planning quality an indirect terminal-authority input.

**Classification:** reject as the normative first-slice path.

## 10. Alternative D — Agent proposes; Application accepts exact fresh draft; Host atomically creates

Flow:

```text
explicit Program creation request + objective
→ Host captures bounded planning observation B0
→ Host starts bounded read-only Agent planning episode
→ Agent returns ProgramCreationDraft D bound to B0
→ Host validates structure/bounds/policy and adds mandatory Host-policy requirements
→ Host captures the final bounded draft body + digest H(D,B0,policy)
→ Host exposes exact draft as pending Application interaction
→ Application accepts exact draft identity/digest
→ Host re-observes Workspace/repository base
→ if base != B0: stale, no Program creation
→ Host enters canonical admission and revalidates draft/policy/session
→ append acceptance-command→Program mapping
  + complete initial Program event batch
  atomically
→ Program becomes active
→ before first ProgramAttempt, Host rechecks accepted creation base
→ only matching base may dispatch
```

### Authority model

```text
Application/user
  owns objective origin + exact semantic acceptance

Agent
  owns proposal generation only

Host policy
  may add deterministic non-removable requirements

Host
  owns observation capture, deterministic validation,
  canonical admission, ProgramState, execution and completion
```

### Advantages

- preserves natural-language Agent planning;
- makes explicit that Agent output is a proposal, not Program truth;
- caller can see the exact completion burden before it becomes immutable;
- Host can add policy requirements without letting Agent remove them;
- exact draft digest supports stale rejection and reconnect;
- planning-observation binding rejects plans made obsolete before acceptance;
- atomic accept-command mapping closes crash/retry duplicate creation;
- aligns with Phase 0.8 structured interaction and command-idempotence principles;
- supports deterministic negative proofs;
- does not require a canonical pre-active ProgramState lifecycle;
- advanced automated callers can later use the same contract without moving canonical authority out of Host.

### Disadvantages

- adds one creation interaction/round trip;
- requires a new Application Protocol creation/draft/acceptance surface;
- requires bounded durable representation of a pending creation draft;
- requires a bounded planning-observation identity and freshness check;
- can block waiting for caller acceptance;
- the caller may approve a poor plan, so this establishes authority, not semantic perfection;
- external worktree state still cannot be frozen transactionally with SQLite, so a final pre-dispatch observation check remains necessary.

**Classification:** preferred first-slice authority model.

## 11. Alternative E — create a canonical ProgramState in `planning` lifecycle, then finalize

The Host immediately creates:

```text
ProgramState lifecycle = planning
objective fixed
work/verification mutable during planning
```

The Agent plans durably inside Program identity. A later `program.activated` or `program.contract.finalized` transition freezes the contract and enables scheduling.

### Advantages

- planning survives Host/Agent replacement under one ProgramStateId;
- all planning facts can correlate to durable Program identity;
- supports iterative planning naturally.

### Disadvantages

- expands lifecycle from `active|completed|cancelled` to include pre-active planning;
- requires revision/attachment/cancellation/recovery/read-model rules for planning Programs;
- weakens “immutable at creation” into “immutable at activation”;
- encourages plan versioning complexity earlier than required;
- still needs a semantic acceptance authority unless planning finalization is auto-admitted;
- planning-observation freshness remains necessary.

**Classification:** coherent but defer unless durable multi-turn planning becomes a concrete requirement.

## 12. Alternative F — explicit delegated auto-accept

The Application command authorizes the Host to accept an Agent-generated bounded plan automatically subject to Host validation/policy.

### Advantages

- autonomous UX;
- semantic authority can be described as explicitly delegated rather than silently assumed;
- no second interaction;
- suitable for unattended/API use.

### Disadvantages

- caller never sees the exact immutable completion burden before creation;
- a bad/compromised Agent can still choose a degenerate contract inside structural bounds;
- “authorize a planner” is materially weaker than “accept this exact contract” when later presenting `program.completed`;
- behavior quality becomes more load-bearing.

**Classification:** accommodate/defer as a later policy/convenience mode, not the normative first slice.

## 13. Alternative G — create from objective only, then let Agent populate required topology/verification canonically

Flow:

```text
program.created(objective)
→ Agent later adds required work
→ Agent later adds mandatory verification requirements
→ execution continues
```

### Advantages

- adaptive;
- Program identity exists before planning;
- simple initial create command.

### Disadvantages

- completion contract is mutable after creation;
- creates a window with no final work/verification burden;
- post-creation Agent additions reintroduce Decision 3's semantic scope-expansion problem;
- completion could race contract construction unless a finalization lifecycle is added, which becomes Alternative E.

**Classification:** reject in this form.

## 14. Alternative H — independent model/judge approves Agent-created contract

A second model, critic, or reasoning process evaluates whether the proposed contract adequately matches the objective. If it says yes, Host creates the Program automatically.

### Advantages

- may improve plan quality;
- can catch omissions without user interaction;
- useful as behavioral evaluation/advisory evidence.

### Disadvantages

- another model judgment is not deterministic canonical truth;
- model agreement does not create a new authorization principal;
- turns quality evaluation into control-plane authority;
- still requires planning-observation freshness;
- increases cost and complexity without resolving the authority question.

**Classification:** useful advisory layer; reject as canonical semantic acceptance authority.

---

# Part III — Adversarial histories

## 15. Normal creation under Alternative D

```text
Application command C requests Program creation with objective O
→ Host persists creation request/source input
→ Host captures planning observation B0
→ Host runs read-only Agent planning
→ Agent proposes bounded draft D for B0
→ Host validates D and adds policy requirements
→ Host persists/presents exact pending draft H(D,B0,P0)
→ Application accept command A targets that exact draft
→ Host re-observes B1
→ B1 == B0
→ Host enters canonical admission
→ validates A, current draft, source session, policy P0, bounds and freshness
→ mints ProgramStateId P and canonical local IDs
→ in one event-store transaction records:
     A accepted → P
     program.created(P, ...)
     program.session.attached(P, ...)
     program.work.added × N
     program.verification.required × M
→ Program P active
→ before first dispatch Host checks creation base still current
→ first ProgramAttempt may be issued
```

## 16. Weak Agent contract

```text
objective requires bug fix + compatibility preservation
→ Agent proposes one trivial work item and weak/no compatibility verification
```

Required result:

```text
Host may structurally validate proposal
but
no exact Application acceptance
=> no canonical Program
```

The Agent has proposal authority, not semantic acceptance authority.

## 17. Over-broad Agent contract

```text
objective: fix parser defect
→ Agent includes unrelated repository cleanup
```

The Host may not claim deterministic semantic compatibility merely because the DAG is valid. The broader scope is visible in the exact draft and requires acceptance.

## 18. Draft revision before acceptance

```text
D1 presented, H1
→ revised D2 presented, H2
→ old accept(H1) arrives
```

Required result:

```text
stale
no Program created from D2 under H1 acceptance
```

## 19. Host policy change before acceptance

```text
D1 planned/presented under policy P1
→ Host policy now requires additional verification V
→ accept(D1/P1) arrives
```

Required result:

```text
stale
→ regenerate/present D2 under P2
→ require acceptance of D2
```

The immutable Program contract must not silently differ from the exact contract accepted at creation.

## 20. Workspace changes while draft is pending

```text
B0 = repository/workspace observation used for planning
→ Agent proposes D for B0
→ D/H presented
→ foreground work, another Program, external editor, Git checkout,
  repository configuration change, or other relevant mutation changes state to B1
→ accept(H) arrives
```

Required result:

```text
Host re-observes current planning base
B1 != B0 or equivalence cannot be proven
→ stale/fail closed
→ no Program created from D
→ fresh planning required
```

A structurally valid draft is not enough if the repository facts it planned against are stale.

## 21. Host-mediated mutation races acceptance

Host-mediated mutations and the final creation admission share Host canonical ordering where applicable.

If a Host mutation that changes the planning base is admitted first, creation revalidation must observe the newer base and reject stale acceptance.

If creation is admitted first, the Program is created against its accepted base; any later mutation is ordered after creation and must be handled by the normal Program freshness/verification rules. Before first dispatch, the accepted base is still rechecked.

## 22. External edit in the observation-to-append window

The repository is not transactionally frozen with the event store.

History:

```text
Host re-observes B0 immediately before creation
→ external editor changes file after observation
→ atomic Program event batch commits
```

The contract must not pretend this cannot happen.

Required first-slice safety rule:

```text
before first ProgramAttempt dispatch
→ recapture/revalidate accepted creation base
→ mismatch => no dispatch
```

Because first-slice topology/requirements are immutable, the Host must not silently patch the Program to match the new workspace. The Program remains non-dispatchable pending explicit cancellation/recreation or another later-approved recovery mechanism.

## 23. Duplicate acceptance without crash

```text
accept command A
→ Host creates P and records A→P in same transaction
→ network retry delivers A again
```

Required result:

```text
duplicate
→ returns/references same P
→ no second ProgramStateId
```

## 24. Crash after Program events but before separate acceptance receipt — forbidden design

Unsafe design:

```text
accept A
→ Host commits Program P events
→ CRASH
→ A→P command decision not yet persisted
→ retry A
→ Host sees no handled command
→ mints P2
```

This violates exactly-one creation.

Therefore Program creation must not split semantic acceptance and Program creation into separate crashable commits.

## 25. Crash during atomic accepted creation

Recommended design:

```text
accept A
→ Host validates
→ one SQLite transaction starts with A→P mapping + complete Program batch
→ CRASH
```

Recovery sees either:

```text
none of the batch
```

or:

```text
A→P mapping + complete initial Program contract
```

A retry can therefore either perform the creation once or return the existing P; it cannot legitimately mint a second ProgramStateId.

## 26. Crash before draft exists

```text
creation request durable
→ read-only planning begins
→ Agent/Host crashes before a draft is presented
```

No ProgramState exists. On reopen, Host may restart read-only planning from durable source intent and fresh Workspace observation.

## 27. Agent replacement during planning

```text
Agent A planning D
→ Agent A replaced before D is Host-owned/presented
```

A partial Agent-local draft is disposable. Agent B may regenerate from Host-owned source intent and a fresh planning observation.

If exact D has already become a Host-owned pending interaction, replacement Agent B cannot silently substitute D2 under D's old identity.

## 28. Crash after draft presentation before acceptance

If the draft is a pending Application interaction, its exact body or lossless bounded reference, digest, source request identity, planning observation identity, policy identity, and source session identity must be Host-owned durable state.

```text
D/H/B0/P0 presented
→ Host crashes
→ reopen
→ Application reconnects
→ same pending D/H/B0/P0 is visible
```

The Host must not regenerate a different draft and accept it under the old identity.

## 29. UI disconnect

A UI disconnect is not cancellation and must not erase a pending creation interaction. Reconnect uses Host snapshot/replay.

## 30. Session stop before acceptance

For the first slice:

```text
source session stops before Program creation
→ pending creation draft becomes stale/non-acceptable
→ later session must request a fresh creation flow
```

Cross-session continuation is a ProgramState property **after** creation, not a requirement for pre-Program planning.

## 31. Mutation requested during creation planning

```text
Agent planning draft
→ requests mutating capability before Program exists
```

Required result:

```text
deny/fail closed
```

Creation planning may inspect bounded current workspace state but must not create environmental effects before the contract is authorized.

## 32. Runtime-generated reference in immutable requirement

```text
Agent proposes mandatory requirement:
future ArtifactRef or future canonical evidenceRef
```

Required result:

```text
reject creation draft
```

The immutable requirement identifies a stable logical predicate/obligation known at creation; future evidence later satisfies it.

---

# Part IV — Preferred contract

## 33. Comparative summary

| Alternative | Authority correct | Natural-language UX | Freshness story | Crash/idempotence story | First-slice scope | Assessment |
|---|---|---|---|---|---|---|
| A. Application full contract | yes | weak default | explicit | strong | moderate | accommodate |
| B. Host deterministic synthesis | no general solution | good | possible | possible | misleading/large | reject |
| C. Agent auto-admit | weak | excellent | possible | possible | small | reject |
| D. Agent draft + exact fresh Application acceptance + atomic Host create | yes | good | strong | strong | moderate | **prefer** |
| E. Canonical planning lifecycle then finalize | yes | good | strong | strong | large | defer |
| F. Explicit delegated auto-accept | intentionally weaker | excellent | strong | strong | small-moderate | defer |
| G. Objective-only active Program then mutable contract | no | good | complex | complex | large | reject |
| H. Model/judge approval | no deterministic principal | good | possible | possible | moderate-large | advisory only |

## 34. Recommendation

**Recommend Alternative D for the first executable Phase 1.0 slice.**

The first-slice creation authority chain should be:

```text
Application/user objective
        ↓
Host-owned creation request
        ↓
Host-captured bounded planning observation B0
        ↓
read-only Agent semantic planning
        ↓
bounded ProgramCreationDraft proposal bound to B0
        ↓
Host structural/bounds/policy validation
+ deterministic mandatory Host-policy additions
        ↓
exact bounded draft body + digest
+ planning observation identity
+ policy identity
        ↓
explicit Application acceptance of that exact draft
        ↓
Host re-observes B0-equivalent current state
and revalidates inside canonical admission
        ↓
one atomic accepted-creation transaction:
  accept-command → ProgramStateId mapping
  + complete initial Program event batch
        ↓
active ProgramState
        ↓
pre-dispatch accepted-base recheck
        ↓
first ProgramAttempt may be issued
```

The roles are:

```text
objective origin:            Application/user
semantic decomposition:      Agent proposal
mandatory policy additions:  Host policy
semantic acceptance:         Application caller
planning freshness:          Host observation/revalidation
canonical authority:         Host
execution authority:         Host scheduler/ProgramAttempt
completion authority:        Host Completion Oracle
```

### 34.1 Why exact-draft acceptance is preferred

The Agent must be allowed to plan; otherwise workflow authoring moves into the user interface.

But if the Agent's proposed work and verification contract is automatically admitted, the Agent can indirectly choose how easy it is for Host completion to become true.

The smallest clean authority boundary is:

```text
Agent proposes
Host validates what can be validated deterministically
Application accepts exact semantics
Host makes them canonical
```

### 34.2 Why freshness belongs in creation authorization

The proposal is based on repository facts. A draft accepted after those facts changed is not the same semantic proposal the caller reviewed.

Therefore acceptance is over:

```text
contract semantics
+ planning observation identity
+ Host policy identity
```

not just over a pretty-printed DAG.

### 34.3 Why command mapping belongs in the creation cut

The Program event batch being atomic is insufficient for exactly-one creation if the accept command can be forgotten separately.

The semantic creation transaction must make this implication durable:

```text
accepted creation command A
=> exactly one ProgramStateId P
```

The recommended implementation shape is to record the Application decision/mapping and Program batch together under the same Host admission transaction.

### 34.4 Authority is not semantic perfection

Application acceptance does not prove that the draft is a good plan. Behavioral evaluation still matters.

The correctness guarantee is narrower and testable:

> No replaceable Agent/model may silently choose or mutate the immutable Program completion burden, and no stale repository plan may be silently activated as if it were current.

---

## 35. Proposed ProgramCreationDraft semantics

Exact TypeScript names are implementation details, but the semantic draft needs enough information to authorize the whole initial Program contract and its planning base.

Illustrative shape:

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

The exact draft digest covers the canonical bounded representation of all fields whose change would alter semantic acceptance.

Draft-local references should not require canonical ProgramState IDs before creation.

```ts
interface ProgramCreationWorkItem {
  draftKey: string;
  description: string;
  dependencyKeys: string[];
  verificationKeys: string[];
  affectedPaths?: string[];
}
```

```ts
interface ProgramCreationVerificationRequirement {
  draftKey: string;
  predicate: ClosedDeterministicVerificationPredicate;
  freshnessScope: BoundedVerificationFreshnessScope;
  source: "agent_proposed" | "host_policy";
}
```

Important rules:

- objective is caller-sourced;
- local draft keys are not durable Program identities;
- canonical IDs are Host-minted/admitted at creation;
- verification predicates are closed and deterministic;
- no future ArtifactRef/evidence ref is the immutable requirement identity;
- Host-policy requirements cannot be removed by Agent proposal;
- planning observation is explicit and bounded;
- all content is bounded before presentation/admission.

## 36. PlanningObservationIdentity

The architectural requirement is a stable, bounded representation of the Workspace/repository facts that materially informed planning.

It may include or digest, where relevant:

- Git HEAD/commit identity;
- dirty-worktree or bounded workspace observation fingerprint;
- repository configuration identity;
- bounded affected/read-path observations;
- CodeIntelligence revision/provider observation when actually relied upon;
- source-event cut for Host-canonical facts supplied to the planner.

The exact field set is an implementation/design decision, but two properties are normative if this recommendation is promoted:

1. it is sufficient for the Host to decide whether the accepted planning base is still current/equivalent;
2. unknown/unavailable equivalence fails closed rather than silently treating a stale draft as current.

This identity is **not** a claim that the external worktree participates in the SQLite transaction.

## 37. Exact objective handling

The canonical objective should preserve the Application-supplied objective text after ordinary pre-persistence safety/redaction admission.

An Agent may produce advisory:

- planning rationale;
- short title;
- decomposition summary;
- verification explanation.

Those do not silently replace the immutable objective.

Creation provenance should identify the source creation command/input event mechanically.

## 38. Mandatory verification authorship

Mandatory verification is assembled from two non-equivalent sources.

### 38.1 Agent-proposed task-specific requirements

The Agent may propose task/repository-specific requirements such as relevant tests, typecheck/build, compatibility checks, targeted behavior verification, or artifact-presence predicates.

The proposal is not verification truth and is not canonical until exact creation acceptance/admission.

### 38.2 Host-policy requirements

The Host may add deterministic requirements required by product/workspace policy.

These are additive and non-removable by the Agent.

If policy changes the proposed contract before acceptance, the draft identity changes and old acceptance becomes stale.

### 38.3 What the Host can validate mechanically

The Host can validate:

- schema/type;
- local and aggregate bounds;
- duplicate draft keys;
- closed predicate kinds;
- deterministic predicate parameter shape;
- freshness-scope validity;
- policy-required minima;
- forbidden runtime-generated references;
- planning-observation identity format/currentness.

### 38.4 What the Host cannot generally prove

The Host cannot generally prove from current deterministic state that an Agent-proposed verification set is semantically sufficient for an arbitrary natural-language objective.

That is why semantic acceptance is separate from structural/policy validation.

## 39. Initial work-topology authorship

The Agent is the natural semantic proposer because decomposition quality requires repository/task reasoning.

The Host validates deterministic properties:

- structural bounds;
- unique draft keys;
- dependency existence;
- self-dependency rejection;
- cycle rejection;
- aggregate bounds;
- allowed field sizes;
- policy-required constraints;
- creation-base currentness.

The Application accepts the exact proposed topology as part of the creation draft.

After creation, the first-slice static-topology recommendation remains intact: Agent execution does not gain an automatic canonical `program.work.added` path merely because the Agent authored the accepted initial draft.

## 40. Creation planning execution boundary

A pre-Program planning episode is not a `ProgramAttempt` because no ProgramState exists yet.

For the first slice it can reuse supervised session/foreground Agent execution with one additional policy rule:

> Program creation planning is read-only with respect to workspace mutation.

Allowed inputs may include bounded files, Git observations, CodeIntelligence observations, repository configuration, Host context, and read-only capability results.

Mutating capability requests fail closed until the Program is created and an authorized ProgramAttempt exists.

## 41. Pending draft durability

If an exact draft is presented for acceptance, it must not exist only in React/local Agent memory.

Host-owned durable state must preserve enough to recover:

```text
pending draft body or lossless bounded reference
+ exact draft digest
+ source creation request identity
+ planning observation identity
+ current policy identity
+ source session identity
```

The exact event spelling remains open. Plausible shapes include an Application-domain pending Program-creation interaction containing the bounded draft or a lossless Host-owned bounded reference plus digest.

The draft is **not** ProgramState truth before acceptance.

## 42. Canonical accepted-creation cut

After exact acceptance, Host revalidates and appends all of the following in one event-store transaction:

```text
application/program creation accept-command decision or command→Program mapping
program.created
program.session.attached
program.work.added × N
program.verification.required × M
```

Exact payload partition is implementation design. The semantic invariants are:

> An active ProgramState cannot become canonically visible without its complete accepted initial contract.

and:

> The accepted Application command cannot be forgotten separately from the Program it created.

The Host may mint ProgramStateId, ProgramWorkItemId, and VerificationObligationId values while translating accepted draft-local keys inside this same admission.

## 43. Creation idempotency and stale rules

At minimum:

```text
duplicate accept command
→ same semantic result / same ProgramStateId
```

```text
accept unknown draft
→ rejected
```

```text
accept superseded draft digest
→ stale
```

```text
accept after source session stopped
→ stale/rejected in first slice
```

```text
accept after Host policy identity changed
→ stale; regenerate/re-present
```

```text
accept after planning observation changed
→ stale; re-plan/re-present
```

```text
accept after Program already created from same accept command
→ duplicate with existing ProgramStateId
```

No retry path may mint a second ProgramState for the same accepted creation command.

## 44. Replay and rebuild

After Program creation, projection rebuild requires no creation-draft service, Agent, model, UI state, or current planning observation.

Canonical Program events contain the accepted objective/topology/verification semantics required to rebuild ProgramState.

The pre-creation draft remains provenance/interaction history:

```text
creation draft + acceptance mapping
→ explains what was proposed and authorized

canonical program events
→ are ProgramState truth after creation
```

---

# Part V — Relationship to existing decisions and acceptance proofs

## 45. Relationship to the seven existing open-decision recommendations

### 45.1 Completion contract

If the verification-centered completion recommendation is promoted, this study supplies the missing authorship/acceptance boundary for immutable mandatory verification requirements.

### 45.2 Verification freshness

Creation requirements define stable obligation predicate/freshness scope. Runtime satisfaction and `subjectGeneration` remain separate facts.

Creation **planning** freshness is a different identity: it answers whether the initial semantic plan is still based on the Workspace state it was authored against.

### 45.3 Agent work addition

This study does not reopen the recommendation to defer Agent-originated canonical topology mutation after creation.

Agent authorship of an **accepted initial draft** is different from Agent authority to mutate an already-active Program.

### 45.4 Structural bounds

Creation drafts must obey final local and aggregate ProgramState bounds before presentation/admission. Pending draft/public representation also needs an explicit bound.

### 45.5 Operation correlation

Pre-Program read-only planning operations are not ProgramAttempt-owned operations. After creation, capability operations use the final ProgramAttempt correlation design.

### 45.6 Cancellation

Program cancellation applies after Program creation. Pre-creation draft withdrawal is an Application interaction lifecycle, not `program.cancelled`.

### 45.7 Scheduler scope

No Program scheduler slot is consumed until creation completes. Before first attempt, the accepted creation base must still be current.

## 46. Acceptance-criterion consequences if later promoted

This study does not change AC-10 today. If promoted during consolidation, existing ACs can absorb the behavior without a new AC family.

### AC-10-02 — deterministic Program model and rebuild

Prove the immutable objective and mandatory verification contract are fully established at one creation cut and rebuild identically without draft/Agent state.

### AC-10-03 — session attachment and continuity

Prove initial creation/attachment occurs under the active source session and stopped-session pending drafts cannot create a Program under stale authority.

### AC-10-05 — DAG integrity and scheduling

Apply DAG/local/aggregate bounds to the accepted initial draft. Prove no first attempt dispatches when the accepted creation observation is stale.

### AC-10-08 — Completion Oracle

Prove runtime evidence cannot rewrite creation-time mandatory verification requirements.

### AC-10-09 — recovery and structured Agent integration

Prove replacement during creation planning cannot turn partial Agent-local state into an accepted contract; a pending acceptable draft is Host-owned and exact.

### AC-10-10 — Application/read-model projection and ownership

Add creation request/draft/accept interaction, command→Program idempotency mapping, duplicate/stale semantics, planning-observation freshness, reconnect behavior, and proof that UI/Agent cannot create ProgramState directly.

## 47. Required negative proofs if promoted

A final contract should include tests equivalent to:

```text
Agent draft produced
+ no Application acceptance
→ no program.created
```

```text
D1 presented
→ D2 supersedes D1
→ accept D1
→ stale; no Program created
```

```text
D planned at B0
→ Workspace changes to B1
→ accept D
→ stale; no Program created
```

```text
D accepted at B0
→ external edit crosses final observation/append window
→ pre-dispatch observation mismatch
→ no ProgramAttempt dispatch
```

```text
Agent proposes invalid/cyclic/over-bound topology
→ reject before presentation/admission
```

```text
Agent omits Host-required policy verification
→ Host adds it or rejects; Agent cannot remove it
```

```text
Agent proposes future ArtifactRef/evidenceRef as immutable requirement identity
→ reject
```

```text
planning Agent requests mutating capability
→ deny/fail closed
```

```text
accepted creation transaction crashes
→ replay sees neither mapping nor Program, or mapping + complete Program contract
→ never partial Program
```

```text
Program transaction committed
→ Host crashes before response delivery
→ same accept command retries
→ existing command→Program mapping returns same ProgramStateId
→ no second Program created
```

```text
Host/UI restart after draft presentation
→ same exact pending draft/digest/base recoverable
```

```text
Agent replacement before acceptance
→ cannot silently substitute a different draft under old acceptance identity
```

---

# Part VI — Scope and remaining dependencies

## 48. Scope and successor compatibility

The recommendation does **not** require:

- a general plan-versioning engine;
- mutable Program contracts;
- a canonical `planning` ProgramState lifecycle;
- background autonomous contract mutation;
- a second model/judge as truth authority;
- remote approval infrastructure;
- multi-user consensus;
- subagent planning;
- dynamic workflow DSLs;
- a transactional filesystem snapshot mechanism that the current architecture does not possess.

It preserves clean successor paths:

- structured Application-authored contracts can be added later;
- explicit delegated auto-accept can be added later as a policy/convenience mode;
- a durable `planning` lifecycle can be introduced if multi-turn Program planning becomes a real requirement;
- post-creation scope expansion can use a separately authorized path;
- behavioral plan-quality evaluation can improve without changing canonical ownership.

## 49. Open implementation details that do not block the architectural recommendation

1. exact Application command/event names;
2. whether pending draft content is inlined or referenced losslessly through a bounded Host-owned mechanism;
3. exact draft canonicalization/digest format;
4. exact command→Program mapping event spelling;
5. whether ProgramStateId is random and transactionally mapped to accept command, or deterministically derived as an additional defense;
6. exact `PlanningObservationIdentity` field set and digest algorithm;
7. exact read-only planning capability allowlist;
8. exact UI presentation of the draft;
9. whether advanced callers may submit a fully structured draft in the first slice or only later.

None may weaken the authority, idempotency, or freshness invariants.

## 50. Freeze-readiness dependencies

Two narrower dependencies remain before this recommendation could become a frozen implementation contract.

### 50.1 Closed verification-requirement predicate taxonomy

The deterministic verification-requirement predicate taxonomy must be defined well enough that Agent/Application can author immutable requirements at creation without future runtime evidence identifiers or free-text truth evaluation.

### 50.2 Planning observation identity

The final contract must define the minimum bounded observation token/digest sufficient to reject stale ProgramCreationDraft acceptance without pretending the external worktree is transactionally frozen with SQLite.

This should reuse existing Git/Workspace/CodeIntelligence observation substrates where sufficient rather than inventing a second workspace truth authority.

## 51. Final recommendation package

The preferred first-slice creation model is:

```text
caller intent is authoritative source text
        ↓
Host persists creation request
        ↓
Host captures bounded planning observation
        ↓
Agent inspects read-only bounded Workspace state
        ↓
Agent proposes initial work + task-specific verification
        ↓
Host validates deterministic structure/policy
and adds non-removable policy requirements
        ↓
Host persists/presents exact bounded pending draft
bound to planning observation + policy identity
        ↓
Application explicitly accepts exact draft identity/digest
        ↓
Host re-observes and revalidates currentness
        ↓
one serialized atomic accepted-creation transaction
records command→Program mapping + complete Program contract
        ↓
ProgramState active
        ↓
Host rechecks accepted creation base before first dispatch
        ↓
Program scheduler may issue first ProgramAttempt
```

The concise authority rule is:

> **The caller authors intent; the Agent proposes semantics; Host policy may add mandatory constraints; the Application accepts the exact fresh contract; the Host alone makes that acceptance and complete Program creation atomic and canonical.**

This is the smallest first-slice model found that preserves natural Agent planning without allowing a replaceable Agent/model to silently control the immutable Program completion burden, without accepting a plan against a stale Workspace base, and without permitting crash/retry to create duplicate Programs.

## 52. Planning status

This is a recommendation only.

It does not:

- amend `docs/phase-1.0-plan.md`;
- supersede `docs/phase-1.0-open-decisions-study.md`;
- consolidate the artifact-evidence amendment;
- approve or freeze Phase 1.0;
- authorize implementation.

If accepted, its conclusions should be incorporated only as part of a later explicit Phase 1.0 consolidation decision.