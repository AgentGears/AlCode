# ALCODE Phase 1.0 — Program Creation and Contract Authorship Study

**Status:** DRAFT / non-normative planning study  
**Approval:** not approved; not frozen; implementation not authorized  
**Repository base studied:** `main` at `ff211b5c0c7d9f93946ab6a2ad42e45a58ca693c`  
**Relationship to Phase 1.0:** studies one additional contract question exposed by the interaction between Program creation, immutable completion requirements, and the first-slice topology decision. It does not amend `docs/phase-1.0-plan.md`, change AC-10 criteria, approve/freeze Phase 1.0, or authorize implementation.

## 1. Purpose

The current Phase 1.0 draft says that the Host owns ProgramState and Program creation, that Program creation occurs under a Host session, and that the objective/completion contract is immutable after creation. The current alternatives study additionally recommends a first-slice completion contract of universal Host Completion Oracle predicates plus immutable mandatory verification requirements, while deferring Agent-originated canonical work addition after creation.

Taken together, those choices expose a question that is not yet answered explicitly:

> Who supplies the semantic content of the initial Program contract — the objective, initial required work topology, and mandatory verification requirements — and who is authorized to accept that content before the Host makes it canonical?

“Host owns ProgramState” answers the canonical-admission question. It does **not** by itself answer semantic authorship or semantic acceptance.

This study separates those roles and compares credible first-slice alternatives.

## 2. Decision scope

This study is limited to the creation boundary before the first `ProgramAttempt` is issued.

The decision concerns:

- origin of the immutable objective;
- authorship of the initial required work DAG;
- authorship of mandatory verification requirements;
- Host policy additions to those requirements;
- whether Agent/model planning output may become canonical automatically;
- whether an Application/user authorization is required for the exact proposed contract;
- when the contract becomes immutable;
- crash/replacement/reconnect semantics before and during creation;
- atomicity and idempotence of the canonical creation cut.

It does **not** decide:

- post-creation topology mutation beyond the already-studied Decision 3;
- exact verification predicate taxonomy;
- exact structural bound values;
- Phase 1 implementation details that do not affect authority or replay semantics;
- future plan versioning/amendment;
- subagents, remote workers, distributed planning, or general workflow engines.

## 3. Method

The same alternatives-study method is used here:

1. derive the requirement from the current governing draft and current source;
2. separate semantic authorship from canonical authority;
3. enumerate genuinely distinct alternatives, including removal/deferral of mechanisms;
4. attack each with normal, stale, crash, replacement, replay, reconnect, and authority-failure histories;
5. eliminate alternatives with unresolved duplicate authority, silent contract mutation, stale acceptance, partial creation, or model output becoming terminal authority without an explicit authorization boundary;
6. compare surviving alternatives on scope, complexity, testability, UX, and successor compatibility;
7. recommend the smallest correct first-slice authority model.

Correctness is a gate. Convenience does not compensate for an unresolved authority failure.

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

The draft currently models:

```ts
interface ProgramState {
  programStateId: ProgramStateId;
  objective: string;
  completionCriteria: CompletionCriterion[];
  ...
}
```

and says the objective and completion criteria are immutable after creation for Phase 1.0.

The existing open-decisions study recommends replacing the concrete-reference `CompletionCriterion[]` with:

```text
immutable objective
+ immutable mandatory verification requirements
+ universal Host Completion Oracle invariants
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

`docs/phase-1.0-plan.md` currently lists proposed Agent proposal classes including work decomposition/addition, evidence, blockers, verification evidence, and artifact/evidence references.

There is no current Phase 1 contract specifying:

- a `program.create` Application command;
- a Program creation draft/proposal message;
- a Program creation approval interaction;
- an exact draft identity/digest;
- who authors mandatory verification requirements before creation.

### 4.5 The current Application Protocol accepts natural-language input, not Program contracts

`packages/application-protocol/src/types.ts` currently exposes:

```text
input.submit
execution.cancel
queue.promote
permission.respond
```

`input.submit` carries free text plus requested disposition. There is no Program creation command and no generic semantic-contract approval interaction.

The Application Protocol does, however, already establish useful principles:

- commands have stable `commandId` identity;
- decisions distinguish accepted/rejected/stale/duplicate/noop/failed;
- pending interactions are Host-owned structured state;
- reconnect rebuilds from Host snapshot/events rather than renderer memory;
- the Experience Plane never becomes canonical authority.

### 4.6 Current user intent is admitted without Agent semantic rewriting

`HostApplicationService` durably records accepted input and execution state before delivering START_NOW work to the Agent.

The Application input text therefore already has a durable Host-owned source event/command identity that can serve as the provenance source for a Program objective.

### 4.7 The current Agent Protocol has no Program creation vocabulary

`packages/agent-protocol/src/messages.ts` currently has session/input/context/capability/evidence/idle messages but no `program_state_v1`, Program creation draft, ProgramAttempt, or Program proposal message.

Any first-slice creation-planning protocol is therefore new work and should be kept narrow.

### 4.8 Host admission can atomically append a batch

`CanonicalAdmissionQueue` serializes Host state-changing work around one workspace event store.

`WorkspaceEventStore.append()` admits all drafts before SQL and writes the batch inside one SQLite transaction. If one draft fails, the batch is not partially persisted.

That gives Phase 1 a natural creation linearization point:

```text
validate exact creation contract
→ append complete initial Program event batch atomically
```

A first-slice design does not need a partially initialized active ProgramState.

### 4.9 Existing architecture distinguishes proposal from authority

ADR 0005 says:

```text
Agent proposes actions and produces evidence.
Host authorizes, persists, mediates, and performs lifecycle transitions.
```

The same ADR permits Agent-proposed semantic reasoning transitions to cross a Host validation/admission boundary while keeping Host canonical authority.

But there is a crucial distinction here: initial Program topology and mandatory verification requirements define the future completion burden. If the Agent controls those semantics without another authorization boundary, it can indirectly control when Host completion becomes reachable.

### 4.10 Reasoning state is not ProgramState authority

The current reasoning subsystem already has objective and verification-planning concepts, but Phase 1 explicitly keeps reasoning and ProgramState as independent reducers.

A reasoning objective or `verification.planned` node may inform a Program creation draft; it must not silently become ProgramState truth.

### 4.11 Current design notes already separate objective, decomposition, and evidence

`docs/phase-1.0-design-notes.md` recommends preserving a separation between:

- immutable objective/completion contract;
- mutable work decomposition;
- implementation evidence/artifacts;
- verification obligations and satisfaction evidence;
- Host completion decision.

That separation is compatible with Agent planning, but it still leaves open who accepts the initial decomposition and obligations.

## 5. The role distinction the current plan needs

The creation question becomes clearer if five roles are named separately.

### 5.1 Intent originator

The source that says what the Program is for.

For the normal product path this is the Application/user request.

### 5.2 Semantic planner

The component that proposes a bounded decomposition and task-specific verification requirements.

For the normal coding-agent path this is naturally the replaceable Agent/model, operating under Host supervision.

### 5.3 Policy contributor

The Host may impose deterministic non-removable requirements independent of Agent preference, for example mandatory safety or repository policy verification.

### 5.4 Semantic acceptance authority

The actor authorized to say:

> This exact proposed objective/work/verification contract is the Program I intend to create.

This role is not automatically the same as the semantic planner or the canonical owner.

### 5.5 Canonical authority

Only the Host may turn the accepted contract into canonical `program.*` state.

This distinction is the central finding of the study:

```text
Host canonical ownership
!=
Agent semantic authorship
!=
Application semantic acceptance
```

## 6. Non-negotiable first-slice requirements

Any acceptable creation model should satisfy all of the following.

### 6.1 Exact objective provenance

The Program objective must have a mechanically discoverable source. Agent paraphrase must not silently replace the caller's objective.

### 6.2 No Agent indirect completion authority

An Agent must not be able to choose a trivially weak work/verification contract and thereby make `program.completed` reachable without an explicit authorization boundary.

### 6.3 No hidden model-as-truth authority

Moving the same LLM call from the Agent process into the Host does not make semantic plan adequacy deterministic. A Host-invoked model remains a proposal source unless another explicit rule authorizes its output.

### 6.4 Immutable active contract

Once the Program becomes active, the first-slice immutable objective and mandatory verification contract cannot be silently changed by later execution evidence.

If static topology is selected, the initial required DAG is also fixed except for explicit Host mechanisms already authorized by the final contract.

### 6.5 Atomic initial state

A crash must not leave:

```text
program.created
but no required work/verification contract
```

or any other partially initialized active Program.

### 6.6 Idempotent creation

Duplicate delivery/retry of the same accepted creation command must not create two ProgramStateIds.

### 6.7 Stale acceptance protection

If a draft is revised, policy changes, the source objective changes, or the pending creation request is superseded, an old approval must not create the new/different Program accidentally.

### 6.8 Replacement/reconnect honesty

Agent replacement or UI reconnect must not reconstruct the accepted contract from old Agent memory or renderer-local state.

### 6.9 Bounded planning

Creation proposals must obey structural bounds before they can become canonical.

### 6.10 No runtime-generated completion references

Creation-time mandatory requirements must use stable requirement semantics/identities known at creation. A draft cannot require a future concrete ArtifactRef or future canonical evidence reference as the immutable requirement itself.

### 6.11 No mutation before contract authorization

Creation planning should not mutate the workspace before the Program contract is authorized. Otherwise the system can cause environmental effects for work that has not yet become an accepted Program.

For the first slice, creation planning should therefore be read-only at the capability boundary.

## 7. Alternative A — Application supplies the full structured contract

The Application command provides:

```text
objective
initial work DAG
mandatory verification requirements
```

The Host validates and atomically creates the Program. The Agent does not participate in contract authoring.

### Advantages

- strongest deterministic authority boundary;
- no model-generated contract becomes canonical implicitly;
- simple Host validation and replay;
- exact command content can be idempotently bound to Program creation;
- useful future API path for advanced callers or externally generated plans.

### Disadvantages

- requires the user/Application to understand internal Program DAG and verification vocabulary;
- moves coding-agent planning responsibility into the Experience Plane or caller;
- poor default product ergonomics for natural-language coding tasks;
- duplicates planning logic outside the Agent;
- does not exploit the semantic planner the product already owns.

### Failure pressure

This alternative is correct but makes the public caller effectively a workflow authoring client. It is a useful compatible API shape, not the strongest default first-slice product path.

**Classification:** correct; not preferred as the only/default path.

## 8. Alternative B — Host deterministically synthesizes the contract from objective text

The Application supplies only objective text. The Host creates the work DAG and verification requirements without Agent participation.

### Advantages

- Host remains the apparent source of all canonical Program semantics;
- no approval interaction;
- simple external API.

### Disadvantages

- arbitrary coding-task decomposition is not deterministically derivable from free text by the current Host;
- task-specific verification requirements often require semantic repository reasoning;
- implementing a model call inside the Host merely hides Agent/model authorship rather than removing it;
- describing a model-generated Host plan as deterministic Host truth would violate the observation/authority discipline.

### Failure history

```text
objective: fix intermittent parser regression without breaking compatibility
→ Host needs repository-specific decomposition and verification plan
→ no deterministic semantic function exists in current source
```

Either the Host cannot create a useful contract, or it invokes a model. If it invokes a model and automatically treats that output as canonical truth, the architecture has merely relabeled the semantic planner.

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
- Agent may omit required work or verification and make completion too easy;
- Agent may over-expand the initial Program within valid structural bounds;
- the Agent indirectly defines the Host Completion Oracle's objective-specific burden;
- a compromised/buggy Agent can cause a misleadingly weak Program contract without an external acceptance step.

### Authority failure history

```text
caller objective: fix bug and preserve backward compatibility
→ Agent draft contains one work item: "edit parser"
→ Agent draft contains no compatibility verification
→ DAG/bounds/predicate kinds are valid
→ Host auto-admits
→ work item completes
→ universal Oracle predicates can eventually all become true
```

The Host has not itself proven that the contract preserves the caller's semantic requirement. If the draft is auto-admitted, Agent planning quality has become an indirect terminal-authority input.

**Classification:** reject as the normative first-slice path.

## 10. Alternative D — Agent proposes; Application accepts exact draft; Host atomically creates

Flow:

```text
explicit Program creation request + objective
→ Host starts bounded read-only planning episode
→ Agent returns ProgramCreationDraft
→ Host validates structure/bounds/policy and adds mandatory Host-policy requirements
→ Host exposes exact bounded draft as pending Application interaction
→ Application accepts exact draft identity/digest
→ Host revalidates inside canonical admission
→ atomic initial Program event batch
→ Program becomes active
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
  owns validation + canonical admission + ProgramState
```

### Advantages

- preserves natural-language Agent planning;
- makes explicit that Agent output is a proposal, not Program truth;
- caller can see the exact completion burden before it becomes immutable;
- Host can add safety/policy requirements without letting Agent remove them;
- exact draft digest supports stale rejection and reconnect;
- aligns with Phase 0.8's structured pending-interaction principle;
- supports deterministic negative proofs;
- does not require a new pre-active ProgramState lifecycle;
- later automated callers can accept the same exact draft through the Application Protocol without moving canonical authority out of Host.

### Disadvantages

- adds one creation interaction/round trip;
- requires a new Application Protocol creation/draft/acceptance surface;
- requires bounded durable representation of a pending creation draft;
- can block waiting for caller acceptance;
- the user may approve a poor plan, so this establishes authority, not semantic perfection.

### Important distinction

This design does **not** claim user approval proves the plan is semantically correct. It proves only that the Agent did not silently choose the immutable completion burden on its own.

**Classification:** preferred first-slice authority model.

## 11. Alternative E — create a canonical ProgramState in `planning` lifecycle, then finalize

The Host immediately creates:

```text
ProgramState lifecycle = planning
objective fixed
work/verification mutable during planning
```

The Agent plans durably inside the Program identity. A later `program.activated` or `program.contract.finalized` transition freezes the contract and enables scheduling.

### Advantages

- planning survives Host/Agent replacement under the same ProgramStateId;
- all planning proposals can be correlated to one durable Program identity;
- no separate pre-Program pending-draft state;
- supports future iterative planning naturally.

### Disadvantages

- expands Program lifecycle from `active|completed|cancelled` to include pre-active planning;
- requires revision/attempt semantics before ordinary ProgramAttempts exist;
- requires cancellation/attachment/recovery/read-model rules for planning Programs;
- weakens the current “immutable at creation” boundary into “immutable at activation”;
- encourages plan amendment/versioning complexity earlier than required;
- substantially widens the first-slice state machine.

### Assessment

This is architecturally coherent and may become attractive if durable multi-turn planning itself becomes a product requirement. It is more machinery than the Phase 1 signature objective currently requires.

**Classification:** correct but defer.

## 12. Alternative F — explicit delegated auto-accept

The Application command says, in effect:

```text
create a Program from this objective
and authorize the Host to accept an Agent-generated plan automatically
subject to Host validation/policy
```

The caller authorizes a planning process rather than one exact draft.

### Advantages

- natural autonomous UX;
- semantic acceptance authority can be described as delegated by the caller rather than silently claimed by the Agent;
- no second interaction;
- compatible with unattended/API use.

### Disadvantages

- caller never sees the exact immutable completion burden before creation;
- a bad/compromised Agent can still select a degenerate contract inside structural bounds;
- the difference between “caller authorized planning” and “caller accepted this contract” is material when `program.completed` is presented later;
- harder to prove that Agent output did not effectively control completion scope.

### Assessment

Explicit delegation is stronger than silent auto-admission, but it deliberately accepts a weaker semantic-governance boundary. It is a reasonable later convenience mode after the exact-draft path is established and behaviorally evaluated.

**Classification:** accommodate/defer; not first-slice normative path.

## 13. Alternative G — create from objective only, then let Agent populate required topology/verification canonically

Flow:

```text
program.created(objective)
→ Agent later adds required work
→ Agent later adds mandatory verification requirements
→ execution continues
```

### Advantages

- highly adaptive;
- Program identity exists before planning;
- simple initial create command.

### Disadvantages

- the completion contract is mutable after creation;
- creates a window in which an active Program has no final required work/verification burden;
- post-creation Agent additions reintroduce the exact semantic scope-expansion problem identified in Decision 3;
- crash/replay must distinguish incomplete planning from executable active state;
- completion could race contract construction unless another lifecycle/finalization barrier is added, at which point this becomes Alternative E.

**Classification:** reject in this form.

## 14. Alternative H — independent model/judge approves Agent-created contract

A second model, critic, or reasoning process evaluates whether the proposed Program contract adequately matches the objective. If it says yes, Host creates the Program automatically.

### Advantages

- can improve plan quality;
- may catch omissions without requiring user interaction;
- useful behavioral-evaluation technique.

### Disadvantages

- another model judgment is not deterministic canonical truth;
- model agreement does not create a new authorization principal;
- replay would preserve the decision but cannot prove semantic correctness from canonical state;
- turns a quality evaluator into a control-plane authority;
- increases model cost and complexity without resolving the authority question.

**Classification:** useful advisory quality layer; reject as canonical acceptance authority.

## 15. Cross-alternative canonical histories

### 15.1 Normal creation under Alternative D

```text
Application command C requests Program creation with objective O
→ Host durably admits creation request / source input
→ Host runs read-only Agent planning under current session
→ Agent proposes bounded draft D
→ Host validates D and adds policy requirements
→ Host records/presents exact pending draft with digest H(D)
→ Application accepts H(D)
→ Host enters canonical admission
→ revalidates D is current and policy is unchanged
→ appends one atomic initial Program batch
→ ProgramState P is active with full initial DAG + mandatory verification
→ only now may scheduler issue first ProgramAttempt
```

### 15.2 Agent proposes a trivially weak contract

```text
objective requires bug fix + compatibility preservation
→ Agent proposes one trivial work item and no meaningful verification
```

Required first-slice result:

```text
Host may structurally validate the proposal
but
no exact Application acceptance
=> no canonical Program
```

The Agent has proposal authority, not semantic acceptance authority.

### 15.3 Agent proposes broader work than objective

```text
objective: fix parser bug
→ Agent draft includes unrelated repository cleanup
```

The Host may not claim deterministic semantic compatibility merely because the DAG is valid. The broader scope is visible in the draft and requires explicit acceptance.

### 15.4 Draft revised before acceptance

```text
D1 presented, digest H1
→ Agent/Host policy produces revised D2, digest H2
→ old Application accept(H1) arrives
```

Required result:

```text
reject stale
no Program created from D2 under H1 acceptance
```

### 15.5 Host policy changes before acceptance

```text
D1 presented under policy generation P1
→ Host policy now requires additional verification V
→ accept(D1/P1) arrives
```

Required result:

```text
old draft is stale
→ regenerate/present D2 including V
→ require acceptance of D2
```

A later policy may tighten execution regardless, but the immutable Program completion contract must not silently differ from the exact contract accepted at creation.

### 15.6 Duplicate acceptance

```text
Application accepts creation draft with commandId A
→ Host creates Program P
→ network retry delivers A again
```

Required result:

```text
duplicate decision references same P
no second ProgramStateId
```

### 15.7 Crash before draft exists

```text
creation request durable
→ Agent planning begins
→ Host/Agent crash before draft is presented
```

No ProgramState exists yet. On reopen, Host may safely restart read-only planning from the durable creation request/source objective. No external ProgramAttempt or mutating effect has occurred.

### 15.8 Agent replacement while draft is being generated

```text
Agent A planning
→ Agent A replaced
```

A partial Agent-local draft is disposable. Replacement Agent B may regenerate a proposal from Host-owned source input/current read-only observations.

No Program contract has been authorized yet.

### 15.9 Crash after draft presentation but before acceptance

If the draft is a pending Application interaction, its exact content/digest must be Host-owned durable state sufficient for reconnect.

```text
D/H presented
→ Host crashes
→ reopen
→ Application reconnects
→ sees same pending D/H
```

The Host must not silently regenerate a semantically different draft and treat the old acceptance as valid.

### 15.10 Crash during canonical creation

```text
accept H(D)
→ Host validates
→ event batch append starts
→ crash
```

Because append is transactional, recovery sees either:

```text
no Program events
```

or:

```text
complete initial Program event batch
```

Never a partially initialized active Program.

### 15.11 UI disconnect

A UI disconnect is not cancellation and must not erase a pending creation interaction. Reconnect uses Application Protocol snapshot/replay.

### 15.12 Session stop before acceptance

The current plan says Program creation occurs under a Host session. For the first slice, a pending creation draft tied to a stopped session should not be accepted silently from that obsolete session.

Simplest rule:

```text
session stops before Program creation
→ pending creation draft becomes non-acceptable/stale
→ later session requests a fresh creation flow
```

Cross-session continuation is a ProgramState property after creation, not a requirement for pre-Program planning.

### 15.13 Mutation requested during creation planning

```text
Agent planning draft
→ requests mutating capability before Program exists
```

Required first-slice result:

```text
deny/fail closed
```

Creation planning may inspect bounded current workspace state, but it must not create environmental effects before the contract is authorized.

### 15.14 Runtime-generated reference in proposed immutable requirement

```text
Agent proposes mandatory requirement:
artifact handle = future artifact:sha256:...
```

Required result:

```text
reject malformed/semantically invalid creation draft
```

The requirement must identify a stable logical predicate/obligation known at creation; future evidence later satisfies it.

## 16. Comparative summary

| Alternative | Correct authority model | Natural-language UX | Durable/replay clean | First-slice scope | Recommendation |
|---|---|---|---|---|---|
| A. Application full structured contract | yes | weak default | strong | moderate | accommodate |
| B. Host deterministic synthesis | no general solution | good | superficially strong | misleading/large | reject |
| C. Agent auto-admit | weak | excellent | mechanically clean | small | reject |
| D. Agent draft + exact Application acceptance + Host atomic create | yes | good | strong | moderate | **prefer** |
| E. Canonical planning lifecycle then finalize | yes | good | strong | large | defer |
| F. Explicit delegated auto-accept | intentionally weaker | excellent | strong | small-moderate | defer |
| G. Objective-only active Program then mutable contract | no | good | complex | large | reject |
| H. Model/judge approval | no deterministic authority | good | mechanically replayable | moderate-large | advisory only |

## 17. Recommendation

**Recommend Alternative D for the first executable Phase 1.0 slice.**

The first-slice creation authority chain should be:

```text
Application/user objective
        ↓
Host-owned creation request
        ↓
read-only Agent semantic planning
        ↓
bounded ProgramCreationDraft proposal
        ↓
Host structural/policy validation
+ deterministic mandatory Host-policy additions
        ↓
exact bounded draft identity/digest
        ↓
explicit Application acceptance of that exact draft
        ↓
Host revalidation inside canonical admission
        ↓
atomic initial ProgramState event batch
        ↓
active ProgramState
        ↓
first ProgramAttempt may be issued
```

The roles are therefore:

```text
objective origin:            Application/user
semantic decomposition:      Agent proposal
mandatory policy additions:  Host policy
semantic acceptance:         Application caller
canonical authority:         Host
execution authority:         Host scheduler/ProgramAttempt
completion authority:        Host Completion Oracle
```

### 17.1 Why explicit exact-draft acceptance is preferred

The Agent must be allowed to plan; otherwise ALCODE would move workflow authoring into the user interface.

But if the Agent's proposed work and verification contract is auto-admitted, the Agent can indirectly choose how easy it is for Host completion to become true.

The smallest clean boundary is therefore not “Host semantically understands the plan.” It is:

```text
Agent proposes
Host validates what can be validated deterministically
Application accepts the exact semantics
Host makes them canonical
```

### 17.2 This is authority, not a claim of semantic perfection

User/Application acceptance does not prove that the draft is a good plan. Behavioral evaluation still matters.

The correctness guarantee is narrower and testable:

> No replaceable Agent/model may silently choose or mutate the immutable Program completion burden by itself.

## 18. Proposed creation-contract shape

Exact TypeScript names are implementation details, but the semantic draft should contain enough information to authorize the whole initial Program contract.

Illustrative shape:

```ts
interface ProgramCreationDraft {
  sourceCreationRequestId: string;
  sourceObjective: string;
  workItems: ProgramCreationWorkItem[];
  mandatoryVerification: ProgramCreationVerificationRequirement[];
  policyGenerationOrDigest: string;
}
```

Draft-local references should not require canonical ProgramState IDs before creation.

For example:

```ts
interface ProgramCreationWorkItem {
  draftKey: string;
  description: string;
  dependencyKeys: string[];
  verificationKeys: string[];
  affectedPaths?: string[];
}
```

and:

```ts
interface ProgramCreationVerificationRequirement {
  draftKey: string;
  predicate: ClosedDeterministicVerificationPredicate;
  freshnessScope: BoundedVerificationFreshnessScope;
  source: "agent_proposed" | "host_policy";
}
```

The important semantic rules are:

- objective is caller-sourced;
- local draft keys are not durable task identities;
- canonical IDs are Host-minted/admitted at creation;
- verification predicates are closed and deterministic;
- no future ArtifactRef/evidence ref is the requirement identity;
- Host-policy requirements cannot be removed by Agent proposal;
- all content is bounded before presentation/admission.

## 19. Exact objective handling

The first-slice canonical objective should preserve the Application-supplied objective text exactly after ordinary pre-persistence safety/redaction admission.

An Agent may produce:

- planning rationale;
- a short title;
- decomposition summaries;
- verification explanations.

Those may be displayed as advisory draft content, but they must not silently replace the immutable objective.

Recommended provenance on creation should mechanically identify the source creation command/input event.

## 20. Mandatory verification authorship

Mandatory verification should be assembled from two non-equivalent sources.

### 20.1 Agent-proposed task-specific requirements

The Agent may propose requirements derived from repository/task understanding.

Examples conceptually include:

- relevant tests must pass;
- typecheck/build must pass;
- expected artifact-presence predicate;
- compatibility check;
- targeted behavior verification.

The proposal is not itself verification truth and is not canonical until exact creation acceptance/admission.

### 20.2 Host-policy requirements

The Host may add deterministic requirements required by product/workspace policy.

These are **additive and non-removable** by the Agent.

If Host policy changes the proposed contract before acceptance, the draft identity changes and old acceptance becomes stale.

### 20.3 What the Host cannot truthfully claim

The Host can validate:

- type/schema;
- bounds;
- duplicate IDs/keys;
- closed predicate kinds;
- deterministic predicate parameter shape;
- freshness-scope validity;
- policy-required minima;
- forbidden runtime-generated references.

The Host cannot generally prove from current deterministic state that an Agent-proposed verification set is semantically sufficient for an arbitrary natural-language objective.

That insufficiency is exactly why semantic acceptance is separate from Host validation.

## 21. Initial work-topology authorship

The same authority split applies to initial work.

The Agent is the natural semantic proposer because decomposition quality requires repository/task reasoning.

The Host validates deterministic properties:

- structural bounds;
- unique draft keys;
- dependency existence;
- self-dependency rejection;
- cycle rejection;
- aggregate bounds;
- allowed field sizes;
- policy-required constraints.

The Application accepts the exact proposed topology as part of the creation draft.

After canonical creation, the first-slice static-topology decision remains intact: Agent execution does not gain an automatic canonical `program.work.added` path merely because the Agent authored the accepted initial draft.

## 22. Creation planning execution boundary

A pre-Program planning episode is not a `ProgramAttempt` because no ProgramState exists yet.

For the first slice, it can reuse the existing supervised session/foreground Agent execution machinery, with one additional policy rule:

> Program creation planning is read-only with respect to workspace mutation.

Allowed planning inputs may include bounded:

- files;
- Git observations;
- CodeIntelligence observations;
- existing Host context;
- repository configuration;
- read-only capability results.

Mutating capability requests fail closed until the Program is created and an authorized ProgramAttempt exists.

This prevents “planning” from becoming an untracked execution phase.

## 23. Pending draft durability

If an exact draft is presented for Application acceptance, it must not exist only in React/local Agent memory.

The semantic requirement is:

```text
pending draft body or lossless bounded reference
+ exact digest
+ source creation request identity
+ current policy identity
+ session identity
```

must be Host-owned state sufficient to survive UI reconnect and Host restart.

The exact event spelling remains open. Plausible implementation shapes include:

- an Application-domain pending creation interaction event containing the bounded draft;
- an Application-domain event containing a lossless Host-owned bounded draft reference plus digest.

The draft is **not** ProgramState truth before acceptance.

A renderer-local modal or Agent-local JSON object is insufficient.

## 24. Canonical creation cut

After exact acceptance, the Host should revalidate and append the complete initial Program facts in one canonical admission cut.

Conceptually:

```text
program.created
program.session.attached
program.work.added × N
program.verification.required × M
```

may be admitted as one atomic batch.

The exact event payload partition can be decided during consolidation/implementation, but the semantic invariant is:

> An active ProgramState cannot become canonically visible without its complete accepted initial contract.

The Host may mint canonical `ProgramStateId`, `ProgramWorkItemId`, and `VerificationObligationId` values while translating the accepted draft-local keys inside this admission.

## 25. Creation idempotency and stale rules

The public creation protocol should follow existing Application Protocol precedent.

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
accept draft whose required Host policy generation changed
→ stale; regenerate/re-present
```

```text
accept after Program already created from same creation request
→ duplicate/noop with existing ProgramStateId
```

No retry path may create a second ProgramState for the same accepted creation command.

## 26. Replay and rebuild

After Program creation, projection rebuild must require no creation-draft service, Agent, model, or UI state.

The canonical Program events themselves contain the accepted objective/topology/verification semantics required to rebuild ProgramState.

The pre-creation draft is provenance/interaction history, not a dependency for rebuilding the active Program.

This distinction is important:

```text
creation draft
→ explains what was proposed/accepted

canonical program events
→ are ProgramState truth after creation
```

## 27. Relationship to the existing seven decisions

### Decision 1 — completion contract

If the verification-centered completion recommendation is promoted, this study supplies the missing authorship/acceptance boundary for immutable mandatory verification requirements.

### Decision 2 — verification freshness

Creation requirements define stable obligation identity/predicate/freshness scope. Later satisfaction and `subjectGeneration` state remain separate runtime facts.

### Decision 3 — Agent work addition

This study does not reopen the recommendation to defer Agent-originated canonical topology mutation after creation.

Agent authorship of an **accepted initial draft** is different from Agent authority to mutate an already-active Program.

### Decision 4 — structural bounds

Creation drafts must obey the final local and aggregate ProgramState bounds before presentation/admission. Draft/pending-interaction serialization may need an additional bounded public representation.

### Decision 5 — operation correlation

Pre-Program read-only planning operations are not ProgramAttempt-owned operations. After creation, capability operations use the final ProgramAttempt correlation design.

### Decision 6 — cancellation

Program cancellation applies after Program creation. Pre-creation draft withdrawal is an Application interaction lifecycle, not `program.cancelled`.

### Decision 7 — scheduler scope

No Program scheduler slot is consumed until the Program is active and the creation admission is complete.

## 28. Acceptance-criterion consequences if later promoted

This study does not change AC-10 today. If the recommendation is promoted during consolidation, the existing ACs can absorb it without a new AC family.

### AC-10-02 — deterministic Program model and rebuild

Refine to prove that the immutable objective and mandatory verification contract are fully established at the creation cut and rebuild identically without draft/Agent state.

### AC-10-03 — session attachment and continuity

Prove initial creation/attachment occurs under the active source session and that stopped-session pending drafts cannot create a Program under stale authority.

### AC-10-05 — DAG integrity

Apply DAG/local/aggregate bounds to the accepted initial creation draft before canonical creation.

### AC-10-09 — structured Agent integration/replacement

Prove replacement during creation planning cannot turn partial Agent-local state into an accepted Program contract; any pending accepted-able draft is Host-owned and exact.

### AC-10-10 — Application/read-model projection and ownership

Add the Program creation request/draft/accept interaction, duplicate/stale semantics, reconnect behavior, and explicit proof that UI/Agent cannot create ProgramState directly.

### AC-10-08 — Completion Oracle

Add a negative proof that runtime evidence cannot rewrite creation-time mandatory verification requirements.

## 29. Required negative proofs if promoted

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
accepted creation batch crashes during append
→ replay sees zero or complete initial Program contract, never partial
```

```text
duplicate accepted creation command
→ exactly one ProgramStateId
```

```text
Host/UI restart after draft presentation
→ same exact pending draft/digest recoverable
```

```text
Agent replacement before acceptance
→ cannot silently substitute a different draft under old acceptance identity
```

## 30. Scope and successor compatibility

The recommendation deliberately avoids several larger systems.

It does **not** require:

- a general plan-versioning engine;
- mutable Program contracts;
- a canonical `planning` ProgramState lifecycle;
- background autonomous contract mutation;
- a second model/judge as truth authority;
- remote approval infrastructure;
- multi-user consensus;
- subagent planning;
- dynamic workflow DSLs.

It preserves clean successor paths:

- structured Application-authored contracts can be added later;
- explicit delegated auto-accept can be added later as a policy/convenience mode;
- a durable `planning` lifecycle can be introduced if multi-turn Program planning becomes a real requirement;
- post-creation scope expansion can use the separately studied explicit authorization path;
- behavioral plan-quality evaluation can improve without changing canonical ownership.

## 31. Open implementation details that do not block the architectural recommendation

The following can remain implementation-design questions after the authority model is selected:

1. exact Application command/event names;
2. whether pending draft content is inlined in an Application event or referenced losslessly through another bounded Host-owned mechanism;
3. exact draft digest canonicalization format;
4. whether the Host mints tentative internal IDs before acceptance or translates draft-local keys only during creation admission;
5. exact read-only planning capability allowlist;
6. exact UI presentation of the draft;
7. whether advanced callers may submit a fully structured draft directly in the first slice or only later.

None of these should weaken the authority invariant.

## 32. One remaining design dependency

This study exposes one narrower dependency for freeze-readiness:

> The closed deterministic verification-requirement predicate taxonomy must be defined well enough that an Agent/Application can author mandatory requirements at creation without relying on future runtime evidence identifiers or free-text truth evaluation.

This dependency already follows from the existing completion-contract recommendation; the creation study makes its authoring consequence explicit.

## 33. Final recommendation package

The preferred first-slice creation model is:

```text
caller intent is authoritative source text
        ↓
Host persists creation request
        ↓
Agent may inspect read-only bounded workspace state
        ↓
Agent proposes initial work + task-specific verification
        ↓
Host validates deterministic structure/policy
and adds non-removable policy requirements
        ↓
Host persists/presents exact bounded pending draft
        ↓
Application explicitly accepts exact draft identity/digest
        ↓
Host revalidates inside serialized canonical admission
        ↓
atomic complete initial Program event batch
        ↓
ProgramState active and immutable completion contract established
        ↓
Program scheduler may issue first ProgramAttempt
```

The concise authority rule is:

> **The caller authors intent; the Agent proposes semantics; Host policy may add mandatory constraints; the Application accepts the exact contract; the Host alone makes it canonical.**

This is the smallest first-slice model found that preserves natural Agent planning without allowing a replaceable Agent/model to silently control the immutable Program completion burden.

## 34. Planning status

This is a recommendation only.

It does not:

- amend `docs/phase-1.0-plan.md`;
- supersede `docs/phase-1.0-open-decisions-study.md`;
- consolidate the artifact-evidence amendment;
- approve or freeze Phase 1.0;
- authorize implementation.

If accepted, its conclusions should be incorporated only as part of a later explicit Phase 1.0 consolidation decision.