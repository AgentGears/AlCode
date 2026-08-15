# ALCODE Phase 1.0 — Open Contract Decisions Study

**Status:** DRAFT / non-normative planning study  
**Approval:** not approved; not frozen; implementation not authorized  
**Repository base studied:** `main` at `ed3286e74c5f87b2be23ffd80d57eb9f897877f6`  
**Relationship to Phase 1.0:** compares the remaining open decisions in `docs/phase-1.0-plan.md`. It does not amend the governing plan, change AC-10 acceptance criteria, approve/freeze Phase 1.0, or authorize implementation.

## 1. Purpose

The current Phase 1.0 draft has seven explicit open contract questions:

1. final `CompletionCriterion` shape;
2. verification freshness representation and unknown-impact policy;
3. whether Agent work-addition proposals belong in the first executable slice;
4. final structural bounds;
5. exact durable `ProgramAttemptId` correlation on capability operations;
6. program-level cancellation authorization/lifecycle semantics;
7. scheduler concurrency scope.

The purpose of this study is to identify credible alternatives for each question, compare their correctness and implementation consequences, attack them with canonical failure histories, and produce a recommendation suitable for a later consolidation decision.

The study uses the same rule established by the earlier artifact and capability-resolution validation work:

> Correctness is a gate, not a weighted preference. An option that creates duplicate authority, replay ambiguity, stale-result ambiguity, unsafe completion, or unbounded canonical work is eliminated even if it is simpler or more flexible. Among the remaining correct options, prefer the smallest design that preserves the Phase 1.0 objective and does not pre-commit ALCODE to successor architecture.

## 2. Current repository facts that constrain the choices

The alternatives are evaluated against the current code and current Phase 1.0 working design, not against an imagined future runtime.

### 2.1 ProgramState is intended to be exact, durable, Host-owned state

The Phase 1.0 draft already requires:

- exact `expectedProgramRevision === current.revision` checks;
- a fresh `ProgramAttemptId` for each dispatch;
- Host-only canonical ProgramState transitions;
- deterministic DAG eligibility;
- durable operation/attempt correlation;
- current-state-indexed verification;
- a serialized Host Completion Oracle;
- startup recovery before scheduler admission;
- projection rebuild from canonical events.

Any alternative selected here must compose with those invariants rather than creating a second authority.

### 2.2 The Completion Oracle already contains universal completion predicates

`docs/phase-1.0-plan.md` currently requires, independently of `CompletionCriterion`, that completion sees all of the following on one canonical state cut:

```text
lifecycle active
all required work completed
mandatory verification current or waived
no unresolved blocker
no active ProgramAttempt
no linked requested/started operation or unresolved indeterminate effect
no linked retryable durable work
no unresolved admitted transcript/tool obligation
every typed CompletionCriterion true
```

This means any `CompletionCriterion` design must justify why it is not merely a duplicate representation of an already-universal predicate.

### 2.3 Current proposed completion criteria contain runtime-generated references

The present draft proposes:

```ts
type CompletionCriterion =
  | { kind: "all_required_work_completed" }
  | { kind: "verification_obligation_satisfied"; obligationId: VerificationObligationId }
  | { kind: "artifact_present"; handle: string }
  | { kind: "canonical_evidence_accepted"; evidenceRef: string };
```

At the same time, the draft says objective and completion criteria are immutable after ProgramState creation.

That creates a contract tension for `artifact_present {handle}` and `canonical_evidence_accepted {evidenceRef}` when the artifact/evidence is produced during execution: its concrete handle/reference does not exist at ProgramState creation time. Any final design must remove that temporal inconsistency rather than papering over it.

### 2.4 Operation identity is already rooted in `operation.requested`

The current operation model defines one immutable `operationId`. `operation.requested` creates the operation record; `operation.started`, terminal events, evidence and recovery correlate back through that identity. `packages/storage/src/operations.ts` stores one row per operation and reconstructs lifecycle/effect/reconciliation state from the canonical log.

Current `OperationRequestedPayload` is:

```ts
interface OperationRequestedPayload {
  operationId: string;
  toolName: string;
  args: unknown;
  isReadOnly: boolean;
}
```

Current `EventDraft` has `workspaceId`, `sessionId`, optional `operationId`, causation and correlation, but no ProgramState/ProgramAttempt identity yet.

### 2.5 Canonical admission is workspace-scoped and serialized

`CanonicalAdmissionQueue` is instantiated around one `WorkspaceEventStore`. `HostRuntime` is constructed with one `LockedWorkspaceStore` and owns one admission queue, one capability broker, one session manager, one context service and one durable-work dispatcher for that workspace runtime.

That matters for scheduler concurrency: a “global” Program scheduler inside one current `HostRuntime` is already operating inside one locked workspace/admission domain.

### 2.6 Current execution cancellation is request-first and stale-safe

Application Protocol v1 already has:

```ts
execution.cancel {
  expectedExecutionId
}
```

`HostApplicationService` rejects a stale cancel when the active execution changed, appends `application.execution.cancel_requested` before signaling the Agent, and keeps execution lifecycle distinct from the cancellation request. This is useful prior art for Program cancellation, but ProgramState terminal semantics are stronger and must not be conflated with one foreground Agent execution.

### 2.7 Existing Host bounds use explicit finite limits

Examples include the content-addressed `HostArtifactStore`, which has finite artifact and inline-read limits, and Application Protocol replay, which has a finite replay-event bound. The repository therefore already favors explicit bounded Host behavior rather than unbounded collections.

The Phase 1 decision is whether ProgramState should use only local field limits, aggregate complexity limits, configurable budgets, or a combination.

## 3. Decision summary

The detailed dossiers below support the following working recommendations.

| Decision | Working recommendation | Confidence | Governing reason |
|---|---|---:|---|
| Completion contract | Remove the current concrete-reference `CompletionCriterion` union from the first slice; make universal Oracle predicates plus immutable mandatory verification requirements the Phase 1 completion contract. If a separate criterion list survives later, it may reference only stable requirement IDs known at creation. | medium-high | Current kinds duplicate Oracle predicates and two kinds cannot safely reference future-generated handles while criteria are immutable. |
| Verification freshness | Per-obligation monotonic `subjectGeneration` plus a closed freshness scope; invalidate whenever a later mutation is not provably disjoint. | high | One global epoch over-invalidates; content/workspace fingerprints cannot safely become authority without the ProgramModel Phase 1 excludes. |
| Agent work addition | Defer Agent-originated canonical work addition from the first executable slice. Keep Host-owned `program.work.added` for initial/explicit Host topology, and preserve an Agent suggestion/report seam without topology authority. | high | Structural validation is easy; semantic scope expansion is not deterministically Host-verifiable from current Phase 1 state. |
| Structural bounds | Use layered local + aggregate canonical ceilings, with a separate smaller Agent/public projection budget. Do not make replay validity depend on mutable runtime policy. Final numeric values require corpus measurement before freeze. | high on shape; low on final numbers | Local-only maxima multiply into pathological total state; configurable-only limits can make replay semantics policy-dependent. |
| Operation correlation | Put `programStateId` on the event envelope and `programAttemptId` on root `operation.requested`; derive operation ownership in projections from that root and `operationId`. Validate attempt/revision in the same canonical admission that creates the operation. | high | One canonical ownership declaration; no link-event race; no ProgramAttempt identity duplication on every operation event. |
| Program cancellation | User/Application-authorized exact-revision terminal cancellation that atomically invalidates the active attempt, records actor/reason, and never claims to undo or settle linked external effects. Operation uncertainty/reconciliation remains separately durable. | high | Cancellation is an authority cutoff, not rollback. Waiting for environmental quiescence can deadlock cancellation on indeterminate effects. |
| Scheduler concurrency | One active ProgramAttempt per Workspace runtime/admission domain in Phase 1.0. No same-workspace Program parallelism; independent workspace runtimes may proceed independently. | high | Matches current HostRuntime ownership grain and avoids cross-Program workspace races without serializing unrelated workspaces at a process-global level. |

These are study recommendations, not governing decisions. Promotion requires a separate planning amendment/consolidation step and explicit user approval of the resulting contract.

---

# Decision 1 — Completion contract / `CompletionCriterion`

## 4. Problem statement

Phase 1 needs an immutable answer to:

> What must be true before this ProgramState may complete?

The current design has two layers:

1. universal Completion Oracle predicates; and
2. a Program-specific `CompletionCriterion[]` list.

The design must preserve an immutable completion contract without creating duplicate truth or allowing runtime-generated evidence to redefine what completion means.

## 5. Non-negotiable constraints

A valid solution must satisfy all of these:

- Host-evaluable and deterministic;
- rebuildable from canonical events plus deterministic Host queries explicitly allowed by the contract;
- unsupported/free-text criterion kinds cannot delegate truth to an Agent/model;
- runtime evidence may satisfy a requirement but must not redefine the requirement;
- stale evidence cannot satisfy completion;
- artifact identity is not evidence admission;
- criteria/requirements cannot depend on an identifier that does not exist yet if the completion contract is immutable at Program creation;
- the mutable work decomposition must not silently rewrite the immutable objective/completion contract.

## 6. Alternative A — keep the current four-kind union unchanged

```ts
type CompletionCriterion =
  | { kind: "all_required_work_completed" }
  | { kind: "verification_obligation_satisfied"; obligationId: VerificationObligationId }
  | { kind: "artifact_present"; handle: string }
  | { kind: "canonical_evidence_accepted"; evidenceRef: string };
```

### Advantages

- already documented;
- closed and simple to serialize;
- straightforward switch-based Host evaluator;
- superficially self-describing.

### Disadvantages

- `all_required_work_completed` duplicates a universal Completion Oracle predicate;
- `verification_obligation_satisfied` duplicates universal mandatory-verification logic unless the system introduces optional versus completion-required obligations;
- `artifact_present {handle}` cannot identify a future-produced artifact at creation time if the criteria are immutable;
- `canonical_evidence_accepted {evidenceRef}` has the same future-reference defect;
- allowing criteria to be amended later to install those references would weaken the immutable completion-contract boundary;
- direct evidence references risk bypassing verification freshness unless the criterion itself grows freshness semantics.

### Failure history

```text
Program P created
→ completionCriteria includes requirement for future build artifact
→ artifact does not exist yet
```

The current shape has no stable identifier for “the final build artifact requirement”; it only has a concrete Host artifact handle.

Either:

```text
A. criterion cannot be created yet
```

or:

```text
B. criterion is added/rewritten after execution
```

B allows execution state to mutate the supposedly immutable completion contract.

**Classification:** reject unchanged.

## 7. Alternative B — keep criteria but allow only stable logical requirement identities

Example shape:

```ts
type CompletionCriterion =
  | { kind: "verification_requirement_current"; requirementId: VerificationObligationId }
  | { kind: "artifact_requirement_satisfied"; requirementId: ProgramArtifactRequirementId }
  | { kind: "evidence_requirement_satisfied"; requirementId: ProgramEvidenceRequirementId };
```

Concrete ArtifactRefs/evidence refs later satisfy those stable requirements through canonical Host admission.

### Advantages

- preserves an explicit immutable Program-level completion list;
- avoids concrete future-reference defects;
- separates “requirement identity” from “evidence that satisfied it”;
- makes objective-specific completion rules self-describing.

### Disadvantages

- introduces additional requirement identity/types not currently needed elsewhere;
- duplicates verification obligation semantics if artifact/evidence requirements can be expressed as deterministic verification obligations;
- adds reducers and satisfaction state for multiple requirement families;
- risks building a generic rule/requirement framework prematurely.

**Classification:** correct but probably over-general for Phase 1.

## 8. Alternative C — Boolean predicate AST

Example:

```ts
type CompletionExpr =
  | { kind: "and"; items: CompletionExpr[] }
  | { kind: "or"; items: CompletionExpr[] }
  | { kind: "not"; item: CompletionExpr }
  | { kind: "work_completed"; workItemId: ProgramWorkItemId }
  | { kind: "verification_current"; obligationId: VerificationObligationId }
  | { kind: "artifact_requirement_satisfied"; requirementId: string };
```

### Advantages

- expressive while still deterministic;
- can model sophisticated terminal rules without free text;
- future additions can remain typed.

### Disadvantages

- effectively creates a workflow/rule DSL;
- combinatorial validation/testing burden;
- can express confusing states such as `not(verification_current(...))`;
- makes completion harder to inspect and explain;
- directly conflicts with the Phase 1 goal of a bounded simple work-state machine rather than a general workflow language.

**Classification:** reject for Phase 1; successor only if real use cases require Boolean composition.

## 9. Alternative D — extensible criterion registry

Builtin or plugin-defined criterion names resolve to Host evaluators.

### Advantages

- highly extensible;
- capability/plugin ecosystem could add domain-specific predicates.

### Disadvantages

- replay correctness becomes dependent on installed evaluator versions;
- plugins could influence terminal Program truth;
- criterion availability/versioning becomes part of durable-state compatibility;
- contradicts the desired closed Host-owned completion taxonomy.

**Classification:** reject.

## 10. Alternative E — no separate Phase 1 `CompletionCriterion[]`; universal Oracle + immutable mandatory verification requirements

Under this design the Program completion contract is composed from:

```text
immutable objective
+ immutable initial mandatory verification requirements
+ universal Completion Oracle invariants
```

The work DAG is execution decomposition. It may explain how the objective is achieved, but cannot weaken the immutable mandatory verification requirements.

Examples that the old criteria attempted to express become verification requirements with deterministic predicates:

```text
artifact must exist
→ mandatory verification requirement: artifact-presence predicate

specific canonical evidence must be accepted/current
→ mandatory verification requirement: evidence-acceptance predicate

all required work completed
→ universal Completion Oracle predicate
```

### Advantages

- one terminal authority model rather than Oracle predicates plus a second criterion engine;
- removes concrete future-reference defects;
- variable objective-specific correctness already belongs naturally in verification obligations;
- preserves the Truthmark-derived separation between immutable completion contract and mutable decomposition;
- artifact freshness automatically uses the existing verification subject-generation model;
- smaller reducer, schema and acceptance surface.

### Disadvantages

- requires the verification-obligation contract itself to have a closed deterministic predicate taxonomy before freeze;
- if a future Program requirement is truly neither work-state nor verification, Phase 1 would need a new explicit requirement type rather than dropping it into a generic criterion list;
- less superficially “complete” when looking only at one `completionCriteria` field because the completion contract is distributed across universal invariants and mandatory obligations.

## 11. Canonical histories for Alternative E

### 11.1 Future artifact

```text
P created with mandatory verification obligation V-final-artifact
→ V has deterministic artifact-presence requirement identity
→ work executes
→ Host records produced ArtifactRef R through operation/evidence provenance
→ Host evaluates V against current ProgramState subject generation
→ V satisfied with current canonical evidence referencing R
→ Completion Oracle may use V
```

No immutable contract mutation is required to install `R`.

### 11.2 Stale artifact

```text
V satisfied with R at generation G1
→ relevant mutation → G2
→ R still resolves
→ V is stale at G2
→ Completion Oracle rejects
```

The old `artifact_present` primitive alone could not express this freshness distinction.

### 11.3 Mutable work decomposition

```text
P completion obligations fixed
→ work decomposition changes under an authorized future topology mechanism
→ obligations do not change
```

The means may change; the completion contract does not.

## 12. Recommendation for Decision 1

**Recommend Alternative E for the first executable Phase 1.0 slice.**

The current `CompletionCriterion` union should not be frozen as written. Its two global kinds duplicate the Completion Oracle; its concrete artifact/evidence references are temporally incompatible with immutable creation-time criteria for future outputs.

A later plan consolidation should either:

1. remove `completionCriteria` from the Phase 1 semantic model and define the immutable Program completion contract as universal Completion Oracle invariants plus immutable mandatory verification requirements; or
2. if reviewers demonstrate a non-verification objective-specific terminal requirement, use Alternative B and introduce a stable requirement identity rather than a runtime artifact/evidence reference.

### Derived requirement

If Alternative E is selected, Phase 1 freeze-readiness must include one additional design check:

> The verification obligation acceptance predicate taxonomy must itself be closed, Host-evaluable and deterministic.

That is not a new subsystem. It is where the determinism previously assigned to `CompletionCriterion` moves.

---

# Decision 2 — Verification freshness

## 13. Problem statement

A verification result is only valid for the state it actually checked. Phase 1 needs a durable way to decide whether accepted evidence remains current after later mutations, without introducing a full canonical code graph.

There are two sub-decisions:

1. how freshness identity is represented; and
2. what happens when mutation relevance is uncertain.

## 14. Alternative A — one Program-wide verification epoch

```text
Program verification epoch E
→ any verification satisfies at E
→ any relevant mutation increments E
→ all old verification stale
```

### Advantages

- easiest reducer/replay model;
- no stale evidence can cross a generation change;
- trivial Completion Oracle check.

### Disadvantages

- over-invalidates unrelated obligations;
- expensive long-running verification may be repeatedly discarded by unrelated changes;
- multi-work-item Programs become unnecessarily sequential around verification;
- makes later per-obligation precision a migration rather than an extension.

Example:

```text
package A tests satisfied
→ documentation-only mutation in package B
→ global epoch advances
→ package A tests stale
```

**Classification:** correct but materially over-conservative.

## 15. Alternative B — per-obligation subject generation

Each verification obligation owns a monotonic generation:

```ts
interface VerificationObligationState {
  obligationId: VerificationObligationId;
  subjectGeneration: number;
  currentSatisfaction?: {
    verifiedGeneration: number;
    evidenceRefs: string[];
  };
}
```

A relevant mutation advances only the obligations that may be affected.

### Advantages

- one local freshness authority per obligation;
- stale/current comparison is trivial;
- artifact-backed evidence fits directly;
- no full code graph required;
- rebuild from canonical invalidation/satisfaction events is straightforward.

### Disadvantages

- requires a deterministic relevance policy;
- if relevance is uncertain, the Host must choose between safety and excess invalidation;
- obligation scope must be represented somehow.

**Classification:** strong candidate.

## 16. Alternative C — direct workspace/content fingerprint

Evidence records the exact hash/fingerprint of source inputs and is current only while that fingerprint matches.

### Advantages

- strong physical linkage between evidence and source bytes;
- potentially eliminates explicit invalidation events;
- duplicate evidence can be reused when the exact subject fingerprint recurs.

### Disadvantages

- defining the complete verification subject is the hard problem;
- tests/builds often depend on generated state, configuration, environment and transitive files not captured by obvious path hashes;
- without a canonical ProgramModel, the fingerprint can falsely claim freshness;
- provider/toolchain/environment identity also becomes part of the fingerprint problem;
- risks turning observations into canonical authority.

**Classification:** reject as the freshness authority. Digests remain useful provenance inputs.

## 17. Alternative D — per-obligation generation plus bounded freshness scope and provenance

This combines Alternative B with a closed, conservative scope descriptor. Illustrative shape:

```ts
type VerificationFreshnessScope =
  | { kind: "workspace" }
  | { kind: "paths"; paths: string[] }
  | { kind: "artifact"; artifactRequirementId: string }
  | { kind: "operation"; operationRequirementId: string };
```

The exact taxonomy remains subject to implementation design, but the rule is:

```text
subjectGeneration is canonical freshness authority
scope/provenance observations decide whether to advance it
```

Digests, Git state, CodeIntelligence observations and affected paths may improve relevance decisions but never replace `subjectGeneration` as ProgramState truth.

### Advantages

- preserves one clear freshness authority;
- supports conservative invalidation without a ProgramModel;
- future language-aware observations can improve precision without migrating the canonical model;
- separates logical freshness from physical provenance.

### Disadvantages

- more schema than bare per-obligation generations;
- requires explicit treatment of unknown/partial affected paths;
- a bad scope declaration can still over- or under-invalidate, so Host admission must own scope creation.

**Classification:** preferred.

## 18. Unknown-impact policy alternatives

### U1 — unknown mutation invalidates every verification obligation

Safe, but repeats the global-epoch over-invalidation problem.

### U2 — obligation-level `invalidateOnUnknown` flag

Flexible, but makes freshness safety a configuration bit that can be accidentally disabled on a mandatory check.

### U3 — block Program progress until impact is resolved

Strong safety, but can deadlock work on uncertainty that is not environmental effect uncertainty and may never become better-known.

### U4 — invalidate every obligation whose scope is not provably disjoint

Rules:

```text
known overlap                    → invalidate
known disjoint                   → retain
mutation affected paths unknown → invalidate workspace/path-sensitive obligations
obligation scope unknown         → invalidate
artifact/operation requirement with proven independent subject
                                 → retain only when deterministic disjointness is established
```

This is fail-closed without making every mutation globally invalidating.

**Preferred unknown-impact policy:** U4.

## 19. Event histories

### 19.1 Known overlap

```text
V subjectGeneration G7, scope paths [packages/a/**]
→ evidence E satisfies G7
→ mutation M changes packages/a/src/x.ts
→ Host admits invalidation / advances V to G8
→ E remains historical only
```

### 19.2 Known disjoint mutation

```text
V scope packages/a/**
→ mutation changes docs/changelog.md
→ Host proves disjoint under bounded path policy
→ V remains current
```

### 19.3 Unknown effects

```text
mutation operation terminal but exact affected paths unavailable
→ V is workspace/path-sensitive
→ relevance not provably disjoint
→ V advances generation
```

This is distinct from `EffectStatus.indeterminate`. The external effect may be confirmed while its exact impact set is still too imprecise for freshness reuse.

### 19.4 Same artifact bytes after invalidation

```text
V satisfied with ArtifactRef R at G1
→ relevant mutation → G2
→ fresh verification reproduces identical bytes R
→ old satisfaction remains stale
→ new Host-admitted evidence for G2 may satisfy V
```

## 20. Recommendation for Decision 2

**Recommend Alternative D + unknown-impact policy U4.**

Use the name `subjectGeneration` or `verificationSubjectGeneration`, not `verificationEpoch`, because the identity is per obligation rather than a global temporal epoch.

The final contract should state:

> A verification satisfaction is current exactly when its verified subject generation equals the obligation’s current subject generation. A later mutation advances that generation whenever the Host cannot deterministically prove the mutation is irrelevant to the obligation’s bounded freshness scope.

Canonical invalidation may be represented by explicit `program.verification.invalidated` events or an equivalent event that deterministically advances the generation. The important property is rebuildable generation history, not the final event spelling.

---

# Decision 3 — Agent work-addition proposals

## 21. Problem statement

Long-running coding tasks often discover additional work. But canonical work topology is authority: every added required node can delay completion, widen mutation scope and change the scheduler’s future actions.

The question is not whether Agents may *suggest* discovered work. The question is whether an Agent proposal may directly enter a Host admission path that creates new required canonical work in the first Phase 1 slice.

## 22. Alternative A — static topology after Program creation

Initial Program creation admits the bounded DAG. During execution Agents can report blockers/evidence but cannot add canonical work.

### Advantages

- simplest reducer and scheduler;
- completion requirements cannot grow during execution;
- no semantic scope-expansion authorization problem;
- exact bounds can be checked once at creation;
- easier replay and behavioral evaluation.

### Disadvantages

- discoveries may require user/Host intervention or a new ProgramState;
- initial decomposition has to be good enough;
- less adaptive for real repository work.

**Classification:** correct and smallest.

## 23. Alternative B — automatic Agent add-only proposals

Agent proposes:

```text
new work description
dependencies
verification requirements
affected paths
```

Host checks current revision, bounds and DAG integrity, then admits `program.work.added`.

Existing work is never edited/deleted/replaced.

### Advantages

- topology evolution is monotonic;
- handles discovered work naturally;
- much simpler than split/replace semantics;
- append-only history remains understandable.

### Disadvantages

- structural validity is deterministic, but semantic objective compatibility is not;
- an Agent can expand required work indefinitely while staying inside structural bounds;
- added work can widen allowed mutation surfaces or verification cost;
- “Host validates completion-contract compatibility” is not sufficient unless that validation is itself deterministic or explicitly authorized.

Failure history:

```text
objective: fix one parser defect
→ Agent proposes broad repository cleanup as new required work
→ DAG/bounds are valid
→ Host has no deterministic semantic predicate proving cleanup belongs to immutable objective
```

Automatically admitting the node gives the Agent indirect authority to redefine scope.

**Classification:** reject as an automatic first-slice path.

## 24. Alternative C — add-only proposals require explicit scope-expansion authorization

Agent may propose add-only work, but Host exposes it as a user/application approval interaction. Only an explicit authorized command makes it canonical.

### Advantages

- preserves adaptivity;
- human/upper-level authority decides semantic scope expansion;
- topology remains monotonic.

### Disadvantages

- adds a new Program interaction/approval flow to Phase 1;
- continuation can block waiting for a human decision;
- requires public projection/UI command surface;
- large first-slice scope for a behavior not needed to prove durable ProgramState itself.

**Classification:** correct, but probably successor scope.

## 25. Alternative D — add/split/replace work topology

### Advantages

- most natural adaptive planning;
- permits correcting bad decomposition rather than accumulating nodes.

### Disadvantages

- dependencies/evidence/active-attempt references to replaced nodes need complex migration semantics;
- stale Agent proposals become much harder to reason about;
- objective/plan versioning begins to resemble a workflow product;
- significantly expands acceptance criteria.

**Classification:** reject for Phase 1.

## 26. Alternative E — advisory discovered-work reports, Host topology unchanged

Agent can submit a typed/non-authoritative report such as:

```text
discovered work candidate
reason
suggested dependencies
suggested verification
```

The Host may expose it to the user or convert it only through a separately authorized Host command. In the first executable slice, no automatic conversion is required.

### Advantages

- Agent can surface discoveries without owning topology;
- keeps the future Agent proposal seam open;
- does not require topology-mutation UI now;
- aligns with “Agent proposes; Host decides.”

### Disadvantages

- first slice may require explicit user intervention for genuinely necessary discovered work;
- the Program may remain blocked rather than autonomously expanding.

**Classification:** preferred companion to static topology.

## 27. Recommendation for Decision 3

**Recommend Alternative A + E for the first executable Phase 1.0 slice.**

Do not implement an Agent-originated canonical work-addition proposal in Phase 1.0 unless a later concrete scenario proves the signature objective cannot be satisfied without it.

Keep `program.work.added` as a Host-owned semantic event because initial decomposition and explicit future Host commands may need it. But the first Agent Protocol proposal taxonomy should omit automatic work topology mutation.

This decision can be revisited after the base ProgramState lifecycle is proven. The likely successor is Alternative C: add-only expansion with explicit authorization and a fresh Program revision/attempt boundary.

---

# Decision 4 — Structural bounds

## 28. Problem statement

Finite per-field limits are necessary but not sufficient. Independent local maxima can multiply into a much larger canonical state than any individual limit suggests.

The current planning defaults include, among others:

```text
256 work items
32 direct dependencies per work item
128 blockers
256 verification obligations
32 evidence refs per work item/obligation
128 affected paths per work item
16 KiB objective
8 KiB work description
256 KiB public/Agent ProgramState projection
```

At the maxima, 256 × 32 permits 8,192 dependency references; 256 × 128 permits 32,768 affected-path entries; 256 × 8 KiB permits roughly 2 MiB of work-description text alone. The public/Agent projection is intentionally smaller, so the full canonical state cannot simply be serialized wholesale into Agent context.

## 29. Alternative A — local per-field limits only

### Advantages

- straightforward validation;
- easy error messages;
- matches the current draft structure.

### Disadvantages

- multiplicative worst cases remain large;
- a Program can hit pathological total graph/evidence/path/text volume while every local field is legal;
- performance guarantees are harder to state.

**Classification:** insufficient alone.

## 30. Alternative B — one aggregate serialized-byte limit only

### Advantages

- simple total storage budget;
- naturally caps text-heavy state.

### Disadvantages

- byte size does not bound graph algorithm cost or object counts;
- a compact but very large node/edge graph can still be expensive;
- error behavior depends on serialization details;
- hard to give useful semantic diagnostics.

**Classification:** insufficient alone.

## 31. Alternative C — configurable Host policy limits only

Each Host chooses its own maxima.

### Advantages

- deployment flexibility;
- high-resource deployments can permit larger Programs.

### Disadvantages

- if replay/reducer validity rechecks current limits, a previously valid canonical Program could become invalid after restart under a different configuration;
- cross-installation acceptance evidence becomes less comparable;
- exact Phase 1 support envelope is unclear.

A configurable admission policy is useful, but it must not become a replay validity predicate for already-canonical state.

**Classification:** useful as a tightening layer, not the only contract.

## 32. Alternative D — persisted per-Program resource budget

At creation the Program stores its admitted limits.

### Advantages

- later Host restarts know the exact expansion budget originally granted;
- configuration changes do not change that Program’s legal future growth;
- supports differentiated Program sizes.

### Disadvantages

- adds budget semantics and migration surface;
- users/Agents may need to reason about remaining quotas;
- premature for the first ProgramState implementation.

**Classification:** correct but over-designed for Phase 1 unless adaptive work addition is selected.

## 33. Alternative E — layered local + aggregate canonical ceilings, plus separate projection budget

The contract defines:

```text
local limits
  max work items
  max direct deps/item
  max evidence refs/obligation
  max text per field
  ...

aggregate limits
  max total dependency edges
  max total affected-path entries
  max total evidence refs
  max total bounded text bytes
  possibly max total artifact references

projection limits
  separate Host-selected bounded Agent/public projection size
```

A deployment may set stricter admission policy, but never broader than the canonical hard ceilings. Once canonical events are admitted, replay does not reject them because a later runtime policy became stricter.

### Advantages

- bounds both local abuse and multiplicative blowup;
- gives deterministic worst-case reducer/graph complexity;
- keeps Agent context budgeting separate from canonical durability;
- allows operational policy tightening without invalidating history.

### Disadvantages

- more counters to validate;
- exact values need empirical evidence;
- aggregate errors may be less obvious to users without good diagnostics.

**Classification:** preferred.

## 34. Numeric values: what can and cannot be decided from current evidence

The current repository and planning corpus establish that finite bounds are required, but they do **not** provide an empirical workload distribution for long-horizon ProgramStates.

Therefore this study should not pretend the existing provisional numbers are proven optimal.

What can be decided now:

- the canonical contract needs finite local ceilings;
- the canonical contract also needs aggregate ceilings for multiplicative collections;
- the Agent/public projection has an independent smaller bound;
- policy may tighten new admissions but cannot invalidate replay of already-canonical state;
- graph validation must remain bounded by explicit `V` and `E` maxima.

What requires measurement before freeze:

- max work items;
- max total edges;
- max obligations;
- max path/evidence totals;
- total Program text bytes;
- projection size that still supports realistic Agent continuation.

## 35. Candidate measurement protocol

Before freeze, construct a small corpus of realistic ProgramState shapes:

```text
small bug fix
cross-package feature
large migration
repository-wide mechanical refactor
multi-stage verification-heavy task
artifact-producing task
Host reopen after partial completion
```

For each, record:

```text
work item count
edge count
blocker count
verification obligation count
affected-path entries
evidence refs
serialized canonical projection bytes
AttemptProjection bytes
rebuild time
eligibility/DAG-validation time
```

Select limits with a meaningful safety factor above observed realistic tasks while retaining explicit worst-case guarantees.

## 36. Recommendation for Decision 4

**Recommend Alternative E.**

Do not freeze the current numerical defaults yet. Freeze the *shape* of the bound policy first, then derive the numbers from the measurement corpus.

A likely final contract should contain both local and aggregate maxima. For example, `maxDependenciesPerWorkItem` should be accompanied by `maxTotalDependencyEdges`; `maxAffectedPathsPerWorkItem` by `maxTotalAffectedPathEntries`; and per-field text bounds by a total ProgramState text budget.

---

# Decision 5 — Durable ProgramAttempt → operation correlation

## 37. Problem statement

For every capability operation initiated under a ProgramAttempt, Phase 1 must mechanically answer:

```text
Which ProgramState owned this operation?
Which ProgramAttempt authorized it?
```

That ownership must survive Agent replacement, Host crash/reopen, terminal operation completion and projection rebuild. It must not create a second operation authority.

## 38. Alternative A — copy ProgramStateId and ProgramAttemptId onto every operation/evidence event

Example:

```text
operation.requested(P,A,O)
operation.started(P,A,O)
operation.completed(P,A,O)
evidence.recorded(P,A,O)
```

### Advantages

- every event is locally self-describing;
- easy queries without joining to the root operation.

### Disadvantages

- duplicates immutable ownership data across many canonical facts;
- conflicting values become theoretically representable;
- every operation-related event schema must understand ProgramAttempt identity;
- ProgramAttempt becomes cross-domain envelope-like machinery rather than root execution provenance.

**Classification:** correct only with heavy consistency validation; unnecessary duplication.

## 39. Alternative B — root ownership on `operation.requested`

Extend the root operation creation fact:

```ts
interface OperationRequestedPayload {
  operationId: string;
  toolName: string;
  args: unknown;
  isReadOnly: boolean;
  programAttemptId?: string;
}
```

The event envelope carries optional `programStateId` as already proposed by Phase 1.

For a ProgramAttempt-linked operation:

```text
operation.requested envelope.programStateId = P
payload.programAttemptId = A
payload.operationId = O
```

All later operation/evidence facts resolve ownership through immutable `operationId` O.

The operations derived projection may copy `program_state_id` and `program_attempt_id` into the row for efficient query. That is derived indexing, not a second canonical authority.

### Advantages

- exactly one canonical declaration of operation ownership;
- fits the existing operation lifecycle root;
- terminal/recovery facts remain simple;
- no separate link event can be missing;
- replay naturally reconstructs ownership alongside the operation row.

### Disadvantages

- queries from a terminal event to ProgramAttempt require resolving O’s root/projection;
- `OperationRequestedPayload` gains a Program-specific optional field.

**Classification:** strong candidate.

## 40. Alternative C — separate `program.operation.linked` canonical event

```text
operation.requested O
program.operation.linked P A O
```

The two can be appended in one CanonicalAdmissionQueue batch.

### Advantages

- operation payload remains generic;
- Program-specific ownership stays in `program.*` domain events.

### Disadvantages

- creates two canonical facts for one ownership relationship;
- every reader must define behavior if replay contains O without the link or an invalid link;
- batching can prevent interleaving in the intended path but does not eliminate malformed historical/input combinations as a semantic possibility;
- recovery and evidence queries require another event family/projection.

**Classification:** correct with strict batch invariants but weaker than root ownership.

## 41. Alternative D — generic `correlationId`/causation only

Infer ProgramAttempt ownership by conventions in existing correlation fields.

### Advantages

- minimal schema change.

### Disadvantages

- loses typed mechanical discoverability;
- conventions become a hidden schema;
- unrelated correlations can share identifiers;
- harder to validate at operation admission.

**Classification:** reject.

## 42. Alternative E — put both ProgramStateId and ProgramAttemptId in the global event envelope

### Advantages

- uniform indexing;
- every event type can be ProgramAttempt-scoped without payload changes.

### Disadvantages

- ProgramAttempt is intentionally Program-local identity, while the events package is cross-domain infrastructure;
- encourages unrelated events to carry attempt identity even when not semantically part of attempt authority;
- expands envelope compatibility surface more than necessary.

**Classification:** reject for `ProgramAttemptId`; retain the existing proposal for cross-domain `ProgramStateId` only.

## 43. The linearization requirement

Whichever storage shape is chosen, the most important correctness rule is not merely “fields exist.” It is:

```text
current ProgramState/Attempt validity check
AND operation.requested admission
must share one canonical serialization point
```

Unsafe shape:

```text
check A is current at revision R
→ await unrelated work
→ A becomes interrupted / R advances
→ append operation.requested owned by stale A
```

Required Phase 1 behavior:

```text
enter canonical admission
→ re-read/revalidate current P/A/R
→ append operation.requested(P,A,O)
→ leave admission
```

This is separate from the existing dynamic-capability binding TOCTOU hardening question. ProgramAttempt validity must be exact even if provider binding stays unchanged.

## 44. Crash/replay histories

### 44.1 Crash immediately after root operation admission

```text
operation.requested(P,A,O) canonical
→ Host crashes before operation.started
→ reopen
```

Recovery can reconstruct O as linked to P/A and apply existing interrupted/indeterminate semantics without a missing second link.

### 44.2 Late terminal result after Attempt superseded

```text
operation.requested(P,A,O)
→ A interrupted
→ B current
→ operation.completed(O)
```

The terminal result remains historically owned by A because O’s root ownership is immutable. It cannot automatically become B evidence.

### 44.3 Projection rebuild

```text
replay operation.requested(P,A,O)
→ insert operation row with P/A
→ later operation lifecycle events update same row by O
```

Ownership is deterministic.

## 45. Recommendation for Decision 5

**Recommend Alternative B.**

Final semantic shape:

```text
Event envelope
  programStateId?         // cross-domain Program identity

operation.requested
  operationId
  programAttemptId?       // exact execution authority when Program-linked
  ... existing fields

operation.started/completed/interrupted/evidence
  operationId             // ownership resolves through root O

operations projection
  derived programStateId/programAttemptId columns for efficient queries
```

For a ProgramAttempt-originated operation, both ProgramState and ProgramAttempt correlation are mandatory. A non-Program operation carries neither attempt ownership field.

No separate `program.operation.linked` event is required.

---

# Decision 6 — Program-level cancellation

## 46. Problem statement

Program cancellation has two very different possible meanings:

1. **authority termination:** no further work/results may mutate this ProgramState; or
2. **environmental rollback/quiescence:** all effects caused by the Program have stopped or been undone.

Phase 1 can guarantee the first. It cannot generally guarantee the second because external effects may already have occurred or may be indeterminate.

The contract must not imply rollback that the operation model cannot prove.

## 47. Alternative A — immediate terminal cancellation / authority cutoff

At one canonical admission cut:

```text
validate explicit authorized cancel against current revision
→ interrupt/invalidate active ProgramAttempt if any
→ admit program.cancelled
```

After that:

- no new attempts dispatch;
- late Agent/attempt results reject as stale/terminal;
- linked operations keep their own operation lifecycle/effect/reconciliation history;
- cancellation does not claim to undo prior workspace/external effects.

### Advantages

- deterministic and exact;
- completion/cancel race is easy to serialize;
- does not deadlock on indeterminate effects;
- Program authority ends immediately;
- composes cleanly with operation uncertainty.

### Disadvantages

- `cancelled` does not mean all external execution has physically stopped;
- UI/read models must surface outstanding operations/reconciliation separately if relevant.

**Classification:** strong candidate.

## 48. Alternative B — `cancelling` lifecycle until all linked operations quiesce

```text
cancel requested
→ lifecycle cancelling
→ stop new dispatch
→ interrupt active attempt
→ wait for all linked requested/started/indeterminate operations
→ program.cancelled
```

### Advantages

- terminal `cancelled` has stronger environmental/quiescence meaning;
- user may find the status intuitive.

### Disadvantages

- an indeterminate effect can keep the Program in `cancelling` indefinitely;
- reconciliation may be impossible or require user action unrelated to desire to abandon the objective;
- adds lifecycle/recovery states;
- conflates Program authority with external-effect certainty.

**Classification:** reject for Phase 1.

## 49. Alternative C — separate graceful cancel and abort modes

### Advantages

- exposes both semantics explicitly.

### Disadvantages

- doubles command/lifecycle surface;
- difficult to explain which mode is safe;
- not needed to prove the Phase 1 objective.

**Classification:** successor only.

## 50. Authorization alternatives

### Auth A — Agent may propose cancellation

Reject. The Agent must not own terminal Program authority.

### Auth B — any user/application command for the attached session cancels immediately

Better, but should still be stale-safe and auditable.

### Auth C — explicit Host/Application command with expected Program revision, actor/source metadata and optional reason

Illustrative command:

```ts
program.cancel {
  programStateId
  expectedProgramRevision
  reason?
}
```

The application/authentication boundary establishes caller authority; the ProgramService validates current revision and lifecycle. Canonical payload records available actor/client/command provenance and reason.

This explicit command is itself the authorization. A second permission prompt is unnecessary unless a later product policy chooses one.

**Preferred authorization:** Auth C.

## 51. Atomicity with active attempt

Cancellation must not create a window where the Program is logically cancelled but a still-current attempt can commit a late result.

Preferred canonical transition:

```text
enter Program canonical admission
→ verify lifecycle active + exact expected revision
→ if active Attempt A:
     append/derive attempt interruption for A
→ append program.cancelled with stable idempotency key
→ projection becomes terminal
→ leave admission
→ best-effort signal Agent/execution cancellation outside canonical truth
```

The exact batch ordering can be chosen so the reducer never exposes a terminal Program with a valid current attempt.

## 52. Completion versus cancellation race

```text
completion preliminary check passes
↔ user cancel arrives
```

Because both terminal admissions use the same canonical lane:

```text
cancel first
→ lifecycle cancelled
→ completion revalidation rejects

completion first
→ lifecycle completed
→ later cancel rejects/noops as already terminal
```

Exactly one terminal fact becomes effective.

## 53. Outstanding operation after cancellation

```text
A starts mutating operation O
→ program.cancelled interrupts A
→ O later returns succeeded/failed/indeterminate
```

Correct result:

```text
O remains historical operation owned by cancelled P/A
ProgramState remains cancelled
O cannot complete work or satisfy current Program verification
operation uncertainty/reconciliation remains canonical for workspace safety/audit
```

Cancellation must not synthesize `absent` effect or “rollback succeeded.”

## 54. Recommendation for Decision 6

**Recommend Alternative A + Auth C.**

Define `program.cancelled` as an immediate Host-owned authority cutoff, not environmental rollback or proof of quiescence.

Required fields/semantics should include:

- ProgramStateId;
- exact expected Program revision at command/admission;
- actor/client/command provenance where available;
- optional bounded reason;
- stable idempotency key;
- terminal mutual exclusion with `program.completed`;
- atomic invalidation/interruption of the active ProgramAttempt.

Outstanding operations remain visible and continue through ordinary operation/reconciliation semantics.

---

# Decision 7 — Scheduler concurrency scope

## 55. Problem statement

The draft currently says:

> at most one active `ProgramAttemptId` exists globally across the Host Program scheduler.

The important question is what “global” means: whole process, workspace runtime, ProgramState, or something more granular.

Concurrency must not allow one Program to mutate a Workspace while another Program assumes an incompatible current workspace state unless ALCODE has a conflict/isolation model strong enough to prove safety.

Phase 1 does not yet have such a multi-Program conflict model.

## 56. Current implementation grain

Current `HostRuntimeOptions` contains one `LockedWorkspaceStore`. One `HostRuntime` therefore owns:

```text
one Workspace store/lock
one CanonicalAdmissionQueue
one CapabilityBroker
one SessionManager
one context/recovery domain
```

A future Program scheduler naturally lives inside that same workspace runtime unless architecture changes.

This makes two options operationally close today:

```text
one attempt globally inside HostRuntime
≈
one attempt per Workspace runtime
```

But “per Workspace” is the more accurate semantic boundary and does not accidentally prohibit independent workspaces managed by separate runtime instances.

## 57. Alternative A — one active attempt process-global

### Advantages

- simplest imaginable arbitration;
- no cross-workspace concurrency concerns.

### Disadvantages

- serializes unrelated workspaces for no semantic reason;
- couples scheduling to deployment/process topology;
- a later process that hosts multiple workspace runtimes would suffer artificial contention.

**Classification:** over-broad.

## 58. Alternative B — one active attempt per Workspace runtime/admission domain

Programs sharing a workspace serialize; independent workspace runtimes may execute concurrently.

### Advantages

- matches current HostRuntime ownership boundary;
- prevents cross-Program same-workspace mutation/verification races;
- concurrency scales naturally by independent workspaces;
- does not require write-set conflict analysis;
- recovery and canonical admission remain local to one workspace.

### Disadvantages

- one slow Program blocks other Programs in the same workspace;
- cannot exploit obviously-disjoint work inside one repository.

**Classification:** preferred Phase 1 boundary.

## 59. Alternative C — one active attempt per ProgramState

Multiple ProgramStates in one Workspace may execute simultaneously.

### Advantages

- materially higher throughput;
- independent Programs do not block each other at scheduler level.

### Disadvantages

- Program A can mutate files while Program B’s attempt is using observations or verification from the same workspace;
- workspace-wide verification freshness becomes a cross-Program concern;
- operation/effect ordering across Programs affects each other’s assumptions;
- current Attempt Contracts do not yet prove disjoint read/write sets;
- no workspace snapshot/worktree isolation is in Phase 1 scope.

Failure history:

```text
P1/A1 reads source S and begins verification
→ P2/A2 mutates S in same workspace
→ P1/A1 continues without a ProgramState-local event explaining that external Program mutation
```

To make this safe ALCODE would need a workspace mutation/revision observation that invalidates P1 correctly, or isolation/conflict control strong enough to prevent the overlap. That is beyond the current first slice.

**Classification:** reject for Phase 1.

## 60. Alternative D — bounded pool with read/write conflict arbitration

Attempts may run concurrently when declared authority boundaries do not conflict.

### Advantages

- eventual efficient same-workspace concurrency;
- aligns with future Attempt Contract write/read boundaries.

### Disadvantages

- correctness depends on complete read/write-set declarations;
- unknown/indirect effects must fail closed;
- becomes a resource/lease/conflict scheduler;
- large acceptance/recovery expansion.

**Classification:** successor scope.

## 61. Alternative E — parallel DAG attempts within one ProgramState

### Advantages

- maximum task-level throughput.

### Disadvantages

- changes the fundamental ProgramAttempt model;
- multiple active attempts can race on work, evidence, verification and completion;
- requires parallel dependency/result arbitration and likely workspace isolation.

**Classification:** explicitly successor scope.

## 62. Multi-Program fairness under Alternative B

One attempt per Workspace does not need sophisticated fairness in Phase 1, but deterministic selection must be stated if more than one ProgramState is eligible.

Candidate policies:

```text
F1 oldest eligible ProgramState/work creation sequence
F2 round-robin across ProgramState IDs
F3 explicit active attached session only, then deterministic creation order
```

Current Phase 1 already requires an active attached session/execution episode. Therefore a minimal deterministic rule can select among eligible attached Programs by canonical Program creation/attachment sequence, then work creation sequence.

Fairness optimization can remain successor scope as long as starvation is bounded by explicit user execution episodes rather than an autonomous background queue.

## 63. Recommendation for Decision 7

**Recommend Alternative B.**

Replace the ambiguous phrase “globally single-attempt” in a later consolidated plan with the stronger semantic statement:

> Within one Workspace runtime/canonical admission domain, at most one ProgramAttempt is active at a time in Phase 1.0. ProgramStates sharing that Workspace serialize execution. Independent Workspace runtimes are not serialized by this invariant.

This preserves the intended first-slice simplicity while avoiding accidental process-global coupling.

The recommendation assumes, consistently with the current event store, that one ProgramState belongs to one Workspace. The consolidated plan should state that workspace scope explicitly if it is not already sufficiently clear from the Program event envelope.

---

# Cross-decision analysis

## 64. Why these decisions should be made together

The seven questions are not independent.

### 64.1 Completion contract ↔ work addition

If the Agent can add required work, `all required work completed` is not a stable objective-specific completion contract. The immutable completion requirements must remain separate from mutable decomposition.

Deferring Agent work addition makes the first slice simpler, but the completion design should still preserve that separation so add-only topology can be added later without redefining the objective.

### 64.2 Completion contract ↔ verification freshness

Moving objective-specific terminal requirements into mandatory verification obligations only works if verification currentness has exact durable semantics. Therefore Decision 1 depends on Decision 2.

### 64.3 Operation correlation ↔ verification evidence

When verification evidence comes from a capability operation, the Host must be able to resolve:

```text
verification obligation
→ canonical evidence
→ operationId
→ ProgramAttemptId
→ ProgramStateId
```

Root operation ownership gives this chain one unambiguous execution provenance.

### 64.4 Cancellation ↔ operation correlation

Immediate Program cancellation is safe only because later operation results remain tied to the cancelled/superseded Attempt rather than being reclassified as current work.

### 64.5 Scheduler concurrency ↔ freshness

Same-workspace parallel Programs would cause mutations outside a Program’s own attempt history to affect verification freshness. Per-Workspace single-attempt scheduling avoids requiring that cross-Program invalidation machinery in Phase 1.

### 64.6 Structural bounds ↔ Agent work addition

If Agent topology expansion is deferred, Phase 1 bounds primarily protect Program creation and Host-owned work additions. If adaptive add-only proposals are later introduced, aggregate remaining-budget semantics may need another decision.

## 65. Canonical ownership model after the recommended decisions

The recommendations converge on this authority split:

```text
Workspace
  owns one canonical event/admission domain

ProgramState
  owns objective, durable work state, blockers,
  mandatory verification state, lifecycle and completion authority

ProgramAttempt
  owns one current bounded execution claim

operation.requested
  owns durable link from one operation to its ProgramAttempt

Operation
  owns execution/effect/reconciliation history

Verification obligation
  owns subjectGeneration and current accepted evidence

ArtifactStore
  owns retained byte identity only

Agent
  proposes/reports; never owns topology, verification satisfaction,
  cancellation or completion
```

No selected option creates a second canonical owner for an existing fact.

## 66. Combined adversarial histories

The following scenarios exercise multiple decisions at once and should become freeze-readiness proofs even if not all become distinct ACs.

### H1 — stale operation admission attempt

```text
Program P revision R10, Attempt A current
→ Agent requests capability
→ before operation admission, P advances / A interrupted
→ capability path enters canonical admission
→ current P/A/R revalidation fails
→ no operation.requested owned by stale A
```

### H2 — cancellation versus in-flight operation

```text
A owns O
→ user cancels P at exact revision
→ A interrupted + P cancelled canonically
→ O completes late
→ O remains historical A result
→ no Program work/verification/completion transition from O
```

### H3 — cancellation versus completion

```text
Completion Oracle preliminary evaluation true
→ cancellation canonical first
→ completion enters admission and revalidates
→ lifecycle cancelled → reject
```

Reverse ordering yields completed and rejects/noops cancellation.

### H4 — verification under unknown impact

```text
V current at G3
→ confirmed mutation occurs but affected paths are unavailable
→ V scope is workspace/path-sensitive
→ Host cannot prove disjoint
→ V advances G4
→ Completion Oracle rejects old evidence
```

### H5 — same-workspace second Program waits

```text
P1 Attempt A active
P2 has eligible work + active attached session
→ scheduler does not issue P2 attempt
→ A terminal/interrupted
→ canonical reevaluation
→ deterministic next Program/work selected
```

### H6 — independent workspace runtimes

```text
Workspace W1 HostRuntime: P1/A1 active
Workspace W2 HostRuntime: P2 eligible
→ Phase 1 per-Workspace invariant does not serialize W2 behind W1
```

### H7 — future discovered work

```text
Agent discovers additional necessary task
→ emits advisory work-discovery report
→ no canonical required work added automatically
→ Program may block / user explicitly authorizes future topology expansion
```

The Agent cannot silently widen the completion path.

### H8 — artifact-backed completion requirement

```text
mandatory verification obligation V-artifact fixed at Program creation
→ later operation produces ArtifactRef R
→ evidence E linked to current Attempt satisfies V at G
→ relevant mutation advances V to G+1
→ R remains retained
→ completion rejects until fresh evidence satisfies G+1
```

This demonstrates why a direct immutable `artifact_present {handle}` criterion is weaker than a stable requirement with fresh evidence.

## 67. Acceptance-criterion consequences if recommendations are later promoted

No new AC family appears necessary. Likely changes are refinements to existing ACs.

### AC-10-02 — deterministic ProgramState model

Would need the final completion-contract/verification-predicate model and aggregate bounds.

### AC-10-04 — exact state-indexed attempt validity

Would include operation-admission revalidation so a stale Attempt cannot create a new Program-linked operation after losing authority.

### AC-10-05 — DAG / scheduler

Would change “globally single-attempt” wording to one active attempt per Workspace runtime/admission domain and prove cross-Program same-workspace serialization.

### AC-10-06 — effect uncertainty / attempt correlation

Would adopt root `operation.requested` ProgramAttempt ownership and derive later evidence ownership through `operationId`.

### AC-10-07 — verification freshness

Would specify per-obligation `subjectGeneration` and fail-closed unknown-impact invalidation.

### AC-10-08 — Completion Oracle

Would remove redundant concrete runtime-reference criteria if Alternative E is selected and add the cancellation/completion exact-order proof.

### AC-10-10 — Application/read model

Would need the explicit Program cancellation command/read-model state only if cancellation is part of the executable public slice.

These are later plan-consolidation consequences. This study does not change those ACs.

## 68. Decisions that remain intentionally deferred

The recommendations do not pull the following into Phase 1:

- Boolean workflow/criterion DSL;
- plugin-defined Completion Oracle predicates;
- adaptive Agent-controlled work topology;
- work split/replace/versioning;
- persisted per-Program resource budgets;
- same-workspace parallel Programs;
- distributed leases;
- parallel DAG attempts/subagents;
- worktree/snapshot isolation;
- full canonical ProgramModel/code graph;
- content fingerprint as canonical freshness authority;
- provider-generation identity as ProgramState freshness;
- graceful/abort dual cancellation modes;
- environmental rollback semantics.

## 69. Remaining evidence needed before a final consolidation decision

Most architectural choices are supportable from the current contract and code. One area still needs empirical evidence: **numeric structural bounds**.

Before freezing Phase 1, run the measurement protocol in §35 and record the observed realistic maxima. That study may adjust the current provisional numbers but should not change the selected layered-bound architecture unless evidence shows a material issue.

A second, smaller freeze-readiness check is required if Decision 1 removes `CompletionCriterion`: confirm the final verification-obligation predicate taxonomy is closed and sufficient for all Phase 1 required scenarios, including artifact-presence requirements.

## 70. Final recommendation package

Subject to explicit approval in a later step, the strongest coherent Phase 1 contract emerging from these alternatives is:

```text
ProgramState belongs to one Workspace

immutable objective
+ immutable mandatory verification requirements
+ universal Host Completion Oracle invariants
        ↓
Host-owned bounded work DAG
        ↓
Agent executes but does not mutate required topology in first slice
        ↓
exact current ProgramAttempt + Program revision
        ↓
operation.requested durably binds operation to ProgramState/ProgramAttempt
        ↓
Host-observed evidence
        ↓
per-obligation subjectGeneration freshness
        ↓
fail-closed invalidation when relevance is not provably disjoint
        ↓
per-Workspace single active ProgramAttempt
        ↓
Host-only serialized completion or explicit terminal cancellation
```

Structural limits are layered local + aggregate ceilings with a separately bounded Agent/public projection.

Program cancellation immediately ends Program authority but never fabricates rollback or effect certainty.

The work plan remains deliberately narrower than a general workflow engine, parallel scheduler, mutable plan/versioning system or runtime-component framework.

## 71. Next step

This study should be reviewed as a non-normative planning artifact first.

If the recommendations survive review, the next distinct objective is a **single Phase 1.0 consolidation amendment** that:

1. updates the stale repository-base annotation;
2. incorporates the already-active artifact-evidence amendment;
3. resolves the seven open questions according to the approved decisions;
4. removes superseded wording and open-question entries;
5. adds only the necessary negative proofs to existing AC-10 criteria;
6. keeps Phase 1.0 DRAFT / not approved / not frozen until the user separately approves the consolidated contract.

This document itself does not perform that consolidation and does not authorize implementation.