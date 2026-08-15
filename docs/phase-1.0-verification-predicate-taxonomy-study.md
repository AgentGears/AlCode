# ALCODE Phase 1.0 — Verification Predicate Taxonomy Study

**Status:** DRAFT / non-normative planning study  
**Approval:** not approved; not frozen; implementation not authorized  
**Repository base studied:** `main` at `db8205966e6b23b8937ca9bcee3cd987687752dc`  
**Relationship to Phase 1.0:** closes the remaining semantic question created by the verification-centered completion recommendation. It does not amend `docs/phase-1.0-plan.md`, change AC-10 acceptance criteria, approve/freeze Phase 1.0, or authorize implementation.

## 1. Decision question

The current governing draft still contains a four-kind `CompletionCriterion` union. The later non-normative open-decisions study recommends removing that separate criterion engine from the first executable slice and defining Program completion as:

```text
immutable objective
+ immutable mandatory verification requirements
+ universal Host Completion Oracle invariants
```

That recommendation is not freeze-ready until the verification requirements themselves are closed and deterministic.

This study asks:

> **What exact first-slice verification predicate taxonomy is expressive enough to prove ordinary coding-program completion requirements, while remaining immutable at Program creation, Host-evaluable, replay-safe, freshness-indexed, bounded, and free of model/plugin authority?**

The answer must also establish:

1. whether every canonical verification obligation is mandatory in the first slice;
2. what evidence may satisfy each predicate kind;
3. what must be revalidated at satisfaction and terminal completion;
4. how verification operations that themselves may mutate the Workspace behave;
5. how the taxonomy composes with `subjectGeneration`, execution-base freshness, ArtifactRef provenance, waivers, and replay.

---

# Part I — Existing constraints and repository facts

## 2. The old CompletionCriterion union is not a sufficient final contract

The governing draft currently proposes:

```ts
type CompletionCriterion =
  | { kind: "all_required_work_completed" }
  | { kind: "verification_obligation_satisfied"; obligationId: VerificationObligationId }
  | { kind: "artifact_present"; handle: string }
  | { kind: "canonical_evidence_accepted"; evidenceRef: string };
```

At the same time, the draft says the objective and completion criteria are immutable after Program creation.

The open-decisions study identifies two defects:

- `all_required_work_completed` duplicates a universal Completion Oracle predicate;
- `verification_obligation_satisfied` duplicates the universal requirement that mandatory verification be current or waived;
- a future-produced artifact handle does not exist at Program creation;
- a future evidence reference does not exist at Program creation.

The study therefore recommends moving objective-specific terminal requirements into immutable mandatory verification obligations with a closed deterministic predicate taxonomy.

This document evaluates that derived requirement rather than assuming the old union should survive.

## 3. Program creation now has an explicit semantic-authorship boundary

`docs/phase-1.0-program-creation-authorship-study.md` separates:

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

For a verification-centered completion contract, the exact mandatory verification requirements are part of the creation draft that the Application accepts and the Host canonically admits.

This matters because the Host cannot deterministically prove that a proposed test, path scope, or artifact requirement is semantically sufficient for the human objective. The first-slice authority rule is therefore:

> **The Agent may propose verification semantics, but a replaceable model does not acquire completion authority merely by proposing a weak predicate. The Application accepts one exact bounded contract; Host policy may add or conservatively widen requirements; the Host then owns canonical enforcement.**

## 4. Verification freshness already has a selected authority model

The open-decisions study recommends per-obligation monotonic `subjectGeneration` rather than one Program-global epoch.

The important rule is:

```text
satisfaction is current
iff
satisfaction.verifiedGeneration == obligation.subjectGeneration
```

A later mutation advances the generation whenever the Host cannot deterministically prove the mutation is irrelevant to the obligation's accepted bounded freshness scope.

Physical observations, Git state, CodeIntelligence, path sets, digests and ArtifactRefs may support the relevance decision. They do not replace `subjectGeneration` as ProgramState freshness authority.

This study does not create a second freshness system.

## 5. Execution-base freshness is a separate authority

The merged execution-freshness and execution-base studies distinguish:

```text
ProgramAttemptExecutionBase
  = (WorkspaceEffectGeneration, ExecutionObservationIdentity)

verification freshness
  = per-obligation subjectGeneration
```

A verification satisfaction may be admitted only from a trusted current execution cut. A current `subjectGeneration` cannot rescue a stale ProgramAttempt or an unknown execution base, and a current execution base does not by itself satisfy a verification obligation.

## 6. Current canonical operation evidence is concrete but not yet Program verification authority

Current `packages/host-runtime/src/capability-broker.ts` records, for ordinary capability execution:

```text
operation.requested
operation.started
action.recorded
→ environmental execution
operation.completed
evidence.recorded
→ optional reasoning verification.result.correlated
```

Current `evidence.recorded` includes concrete facts such as:

- `operationId`;
- source event identity;
- tool name;
- evidence kind;
- execution outcome;
- success bit;
- optional exit code;
- stdout/stderr digests;
- command text when the invocation has a `command` field;
- action identity.

This is useful evidence substrate. It is not yet a ProgramState satisfaction decision.

## 7. Reasoning verification is intentionally the wrong authority layer for Program completion

`@alcode/reasoning` already has an expressive `VerificationContractPayload` with:

```ts
interface OutcomePredicate {
  field: string;
  operator: string;
  value: unknown;
}

interface OutcomeExpression {
  allOf: OutcomePredicate[];
  anyOf: OutcomePredicate[];
}
```

It also supports digest/signature matching and epistemic support/contradiction edges.

That subsystem is useful for cognition, but the Phase 1 plan explicitly keeps the reasoning reducer independent from ProgramState. A reasoning event may support Program evidence; it does not itself satisfy a Program verification obligation.

Therefore the existence of a generic reasoning expression language is not evidence that Program completion should depend on one.

## 8. Artifact identity, provenance, and verification remain separate

The active artifact-evidence amendment establishes:

```text
ArtifactRef resolves
!=
current ProgramState evidence
!=
current verification satisfaction
```

Artifact-backed evidence must pass through Host-admitted provenance/correlation and the same `subjectGeneration` freshness system as other evidence.

A retained identical ArtifactRef does not carry satisfaction from generation G1 to G2.

The current `HostArtifactStore` is content-addressed and bounded. `describe()`/`read()` can deterministically reject a missing, non-regular, oversized or digest-corrupt artifact. The store currently has no ordinary retained-artifact deletion API, but physical unavailability/corruption remains a fail-closed condition when the artifact is resolved.

## 9. Inspection-dependent verification is deliberately outside the current first-slice obligation

The artifact seam studies establish correct future rules for inspection provenance and fail-closed capability negotiation. The active artifact-evidence amendment deliberately does not make renderer, image/media delivery, `artifact_inspection_v1`, or canonical inspection-delivery implementation part of the current Phase 1 executable slice.

The v1 predicate taxonomy therefore must not smuggle model/visual inspection into the first slice under a generic predicate name.

## 10. Program verification definitions must be immutable

If verification obligations replace a separate `CompletionCriterion[]`, their definitions are part of the immutable Program completion burden.

For the first slice:

```text
verification obligation definition
= admitted at Program creation
= immutable for Program lifetime
```

Runtime evidence may satisfy, invalidate, or waive an obligation. It may not rewrite the obligation's predicate or freshness scope.

A future contract-amendment product would require a distinct authority/versioning design and remains successor scope.

---

# Part II — Required properties

## 11. One authority per fact

The final model must keep these facts separate:

```text
VerificationPredicate
  what proof is required

VerificationFreshnessScope
  what Workspace subject may make that proof stale

subjectGeneration
  canonical freshness ordinal for that obligation

canonical evidence
  what was actually observed/executed/produced

ProgramAttemptExecutionBase
  whether the execution cut is current and trusted

waiver
  explicit authorization to proceed without satisfaction

Completion Oracle
  final Host terminal decision
```

No evidence reference or artifact handle becomes a predicate definition after execution.

## 12. Closed means closed

A first-slice predicate kind must have Host-defined semantics that do not depend on:

- a current plugin registry;
- a model prompt;
- an arbitrary evaluator name;
- current reasoning-graph code;
- current provider metadata not persisted in canonical history;
- a free-form expression language whose operators can be extended without a protocol change.

Unsupported kinds fail creation/admission.

## 13. Predicate definitions must be stable before evidence exists

A valid predicate may contain only stable logical identities and bounded values available at Program creation.

It may not require a concrete future:

```text
operationId
ArtifactRef
evidenceRef
ProgramAttemptId
AgentGenerationId
```

Those identities belong to later evidence/provenance that attempts to satisfy the already-existing requirement.

## 14. Evidence must be specific enough to prove the predicate

The opposite failure is a predicate so generic that any Host-admitted evidence can satisfy it.

The rule is:

> **Canonical evidence admission proves provenance and observed facts; the predicate defines which of those facts count as proof. “Some evidence exists” is not itself a sufficient correctness predicate.**

## 15. All first-slice canonical verification obligations are mandatory

The first slice should not introduce optional/advisory Program verification obligations.

Semantic rule:

```text
obligation exists canonically
=> Program completion requires
   current satisfaction for its current subjectGeneration
   OR a current valid explicit waiver
```

Work items may reference obligations for local eligibility/completion gating, but Program completion checks every Program verification obligation.

Advisory checks remain Agent/reasoning/planning information rather than canonical Program obligations.

This removes the ambiguity that would otherwise require `mandatory?: boolean` plus a second rule deciding which obligations actually count.

## 16. Waiver is not a predicate kind

A waiver is an authority transition orthogonal to verification semantics.

For Phase 1:

```text
program.verification.waived
```

is explicit, durable, Host-authorized, exact-current-state checked, and records actor/source/reason according to the final public command design.

The Completion Oracle interprets an obligation as terminally acceptable when it is either:

```text
satisfied for current subjectGeneration
OR
validly waived
```

A predicate evaluator does not return `waived`, and an Agent cannot synthesize a waiver by producing evidence.

## 17. No Boolean completion DSL is needed

All mandatory verification obligations are conjoined by the universal Completion Oracle:

```text
V1 acceptable
AND V2 acceptable
AND ...
AND Vn acceptable
```

The first slice does not need `and`, `or`, or `not` inside predicate definitions.

If a real future requirement needs disjunction, it should be added through an explicit new bounded requirement form rather than prematurely introducing a general workflow/rule language.

---

# Part III — Alternatives

## 18. Alternative A — keep the old CompletionCriterion union and leave verification predicates implementation-defined

### Advantages

- least documentation churn;
- retains the current draft shape;
- allows implementation flexibility.

### Correctness problems

- future artifact/evidence references remain impossible to author immutably at creation;
- two criterion kinds duplicate universal Oracle predicates;
- “verification obligation satisfied” still does not define what deterministic predicate made the obligation satisfiable;
- replay compatibility would depend on implementation choices never frozen in the durable contract.

**Classification:** reject.

## 19. Alternative B — reuse the generic reasoning VerificationContract/OutcomeExpression language

### Advantages

- existing code and tests;
- expressive field/operator matching;
- can represent many command-result assertions.

### Correctness/architecture problems

- reasoning and ProgramState are deliberately independent reducers;
- reasoning support/contradiction is epistemic evidence, not terminal Program authority;
- a generic `field/operator/value` language effectively becomes a durable rule DSL;
- evaluator/operator evolution becomes a Program replay/versioning concern;
- contract matching by digest/signature is not the same as current ProgramAttempt/current-generation admission;
- model-created reasoning contracts could acquire indirect completion authority.

Reasoning results may be referenced as evidence in the future, but the reasoning evaluator should not become the Program verification authority.

**Classification:** reject for ProgramState verification authority.

## 20. Alternative C — extensible predicate registry/plugins

Example:

```text
predicate.kind = "plugin:foo/check-bar"
→ current registry resolves evaluator
```

### Advantages

- maximum extensibility;
- domain-specific verification can be added without changing core types.

### Correctness problems

- replay truth depends on which evaluator/version is installed later;
- plugin replacement can change terminal truth for durable Programs;
- unavailable evaluator can strand rebuild or silently alter interpretation;
- conflicts with closed Host-owned completion semantics.

**Classification:** reject.

## 21. Alternative D — one generic `canonical_evidence_accepted` predicate

### Advantages

- very small schema;
- every future evidence class could fit.

### Correctness problem

It is circular:

```text
evidence was accepted
→ therefore verification is satisfied
```

without a stable requirement defining *why* that evidence proves the objective-specific fact.

Evidence acceptance establishes provenance/shape/currentness. It does not make every evidence record semantically interchangeable.

**Classification:** reject as a predicate kind.

## 22. Alternative E — no objective-specific predicates; rely only on work completion and universal Oracle state

### Advantages

- smallest possible semantic model;
- no predicate taxonomy to version.

### Correctness problem

A coding Program could complete after all work nodes report completed without proving tests/build checks or a required deliverable. The Host would have no objective-specific deterministic proof burden.

**Classification:** reject as too weak.

## 23. Alternative F — closed v1 union over a few deterministic proof classes

Under this family, every predicate kind is defined by the Host protocol, immutable at creation, and satisfied only through the exact evidence class specified by that kind.

Candidate proof classes:

1. exact Host capability operation succeeds;
2. a normalized Workspace path has a required direct state;
3. an output artifact produced for a stable work item remains present/resolvable.

No generic expression language, plugin registry, model judgment, or runtime-generated reference is part of the predicate definition.

**Classification:** preferred family.

## 24. Alternative F1 — operation-result + artifact-presence only

This is the smallest useful F variant.

Workspace path checks could be expressed by invoking an exact Host read/check capability and requiring that operation to succeed.

### Advantages

- only two predicate kinds;
- all non-artifact checks go through one operation evidence path.

### Disadvantages

- path existence semantics become capability/provider semantics rather than a direct Host predicate;
- a later capability implementation change can alter what “success” means for the same logical path fact;
- simple current Workspace facts require an operation solely to translate them into success/failure.

**Classification:** viable, but less explicit than F2.

## 25. Alternative F2 — operation-result + Workspace-path-state + artifact-presence

This adds one narrow direct Workspace predicate.

### Advantages

- covers the dominant first-slice coding verification classes without a DSL;
- direct path state does not depend on a capability's interpretation of missing files;
- artifact presence remains a distinct HostArtifactStore fact rather than an operation side effect;
- operation-result handles tests/build/lint/typecheck and other executable checks;
- future inspection or semantic predicates can be added by an explicit versioned contract change.

### Disadvantages

- one more predicate kind than F1;
- direct path state proves only existence/type, not content correctness;
- exact capability operation semantics still need stable request matching for operation-result.

**Classification:** preferred.

---

# Part IV — Recommended v1 taxonomy

## 26. Recommendation

**Recommend Alternative F2 for the first executable Phase 1.0 slice.**

The semantic taxonomy should be equivalent to:

```ts
type VerificationPredicateV1 =
  | OperationResultPredicateV1
  | WorkspacePathStatePredicateV1
  | ArtifactPresentPredicateV1;
```

Exact TypeScript names/field placement remain implementation design. The three semantic kinds and their authority rules are the recommendation.

## 27. Predicate kind 1 — exact operation result

Illustrative shape:

```ts
interface OperationResultPredicateV1 {
  kind: "operation_result";
  invocation: {
    toolName: string;
    args: unknown;              // canonicalized and bounded at creation
    argsDigest: string;         // derived/checkable identity
  };
  requiredOutcome: "succeeded";
  requiredExitCode?: number;
}
```

### 27.1 Stable definition

The immutable requirement identifies an exact bounded Host capability invocation by:

```text
toolName
+ canonical arguments
+ canonical argument digest
```

The digest is a checkable derived identity, not a replacement for the stored canonical arguments.

A runtime `operationId` is not part of the definition. The later operation is evidence attempting to satisfy the definition.

### 27.2 Satisfaction rule

An `operation_result` obligation may be satisfied only when the Host can mechanically prove:

```text
canonical root operation.requested exists
AND operation is Program/Attempt-admissible under current Phase 1 ownership rules
AND requested toolName/args exactly match the immutable invocation spec
AND operation reaches terminal execution outcome = succeeded
AND requiredExitCode, when specified, exactly matches
AND effect/reconciliation state is safe for the verification cut
AND mutation quiescence requirements are satisfied
AND current execution base is trusted
AND obligation subjectGeneration is still the generation being verified
```

`stdout`, `stderr`, free-text summaries, model interpretation and arbitrary result-object fields are provenance/debugging inputs in v1, not programmable completion predicates.

If a future requirement needs structured result assertions, add a specific closed predicate/version after a concrete use case rather than introducing `field/operator/value` now.

### 27.3 Capability policy remains separate

Persisting an invocation requirement does not pre-authorize the operation.

At execution time the ordinary Host capability/policy/permission path still applies. If the required capability is unavailable or denied, the obligation remains unsatisfied; the requirement itself does not widen authority.

### 27.4 Provider replacement does not rewrite the immutable predicate

The Program predicate identifies the Host capability invocation, not a mutable provider registry entry as replay truth.

Operation-local provider/binding/containment provenance required for effect recovery remains canonical operation history under the execution-base protocol.

If a future predicate truly requires one exact provider implementation/version, that is a new explicit requirement rather than an implicit lookup of whatever provider is current.

## 28. Predicate kind 2 — Workspace path state

Illustrative shape:

```ts
interface WorkspacePathStatePredicateV1 {
  kind: "workspace_path_state";
  path: NormalizedWorkspacePath;
  requiredState: "file" | "directory" | "symlink" | "absent";
}
```

### 28.1 Narrow semantics

This predicate proves only the direct bounded path fact named by the contract.

It does **not** prove:

- file contents are correct;
- source compiles;
- a directory contains a particular tree;
- a symlink target is semantically acceptable;
- a generated output was inspected;
- a path belongs in Git.

Those facts require another verification obligation when needed.

### 28.2 Protected direct observation

Satisfaction requires a complete current Host Workspace observation under the selected execution-base protocol.

The Host records/references enough canonical observation evidence to show which execution base and path-state observation supported admission.

Unknown/incomplete path observation fails closed. It is not interpreted as `absent`.

## 29. Predicate kind 3 — output artifact present

Illustrative shape:

```ts
interface ArtifactPresentPredicateV1 {
  kind: "artifact_present";
  producedByWorkItemId: ProgramWorkItemId;
}
```

The stable obligation identity plus the stable source work-item identity replace the old future-generated `{ handle }` criterion.

### 29.1 Satisfaction evidence supplies the future ArtifactRef

The predicate is created before the artifact exists.

Later satisfaction evidence binds a concrete ArtifactRef through canonical Program/Attempt/operation provenance:

```text
immutable obligation V
  producedByWorkItemId = W

current execution of W
→ canonical operation/evidence provenance
→ output ArtifactRef R
→ Host verifies R resolves/integrity
→ evidence E refers to R
→ E may satisfy V for current subjectGeneration
```

The contract never mutates to insert `R`.

### 29.2 Presence remains narrow

`artifact_present` means only:

- the candidate is an output artifact admitted through current Program evidence for the required source work item;
- its Host ArtifactRef resolves as a regular retained artifact;
- the retained bytes satisfy the content-addressed integrity check available to the Host.

It does not mean the artifact is semantically correct or inspected.

If the objective requires a valid package, rendered diagram, executable binary, or visually correct image, a separate verification obligation must prove the relevant correctness property. Inspection-dependent predicates remain deferred from v1.

### 29.3 No media-type predicate in v1

Current `HostArtifactStore.describe()` does not persist/recover media type as artifact-store authority. The first-slice presence predicate therefore should not make media type part of terminal truth.

A future artifact metadata contract may add a closed media/type requirement if the retained metadata becomes durable and authoritative.

---

# Part V — Freshness scope and mandatory-obligation rules

## 30. Predicate kind and freshness scope are orthogonal

The predicate answers:

```text
what must be proven?
```

The freshness scope answers:

```text
which later Workspace changes make that proof stale?
```

Do not encode path freshness implicitly inside `operation_result`, and do not make `artifact_present` automatically evergreen merely because the ArtifactRef is content-addressed.

## 31. Close the first-slice freshness-scope surface conservatively

For the first slice, the smallest sufficient scope taxonomy is:

```ts
type VerificationFreshnessScopeV1 =
  | { kind: "workspace" }
  | { kind: "paths"; paths: readonly NormalizedWorkspacePath[] };
```

The path collection is normalized, deduplicated and bounded.

Rationale:

- `workspace` is the safe fallback when semantic dependency cannot be narrowed;
- `paths` permits useful precision without a ProgramModel;
- an artifact or operation can still be verified against the Workspace sources from which its correctness derives;
- omitting a `none`/evergreen scope prevents a weak planner-generated flag from silently making a mandatory coding verification immune to all Workspace mutation.

This deliberately over-invalidates some artifact-only requirements. That is preferable to a first-slice escape hatch that can under-invalidate mandatory verification.

## 32. Scope authorship follows the Program creation authority model

A proposed narrow path scope is semantic content, not a Host-proven dependency graph.

Therefore:

```text
Agent may propose scope
Host validates syntax/bounds/normalization
Host policy may widen scope or add requirements
Application accepts the exact final contract
Host canonically enforces it
```

The Host must not claim it proved semantic sufficiency merely because paths are syntactically valid.

At runtime, however, the Host owns the deterministic overlap/unknown-impact policy against the accepted scope.

## 33. Unknown impact remains fail-closed

Use the already-selected policy:

```text
known overlap              → invalidate
known disjoint             → retain
impact unknown             → invalidate every scope not provably disjoint
accepted scope unavailable → fail closed
```

A capability's self-reported changed paths are not sufficient authority by themselves. Host-observed/trusted-complete impact evidence from the execution-base protocol controls reuse.

---

# Part VI — Verification operations that may mutate the Workspace

## 34. The self-mutation problem

Tests, builds and linters are commonly launched through a broad capability and may write caches, generated files, lock state or coverage output.

A naive history is unsafe:

```text
V at subjectGeneration G7
→ run verification operation O
→ O reports success
→ O also modifies the subject V was supposed to verify
→ Host records V satisfied for the post-operation state
```

The successful result may describe an earlier point inside O's execution, not the final Workspace state after all writes/descendants quiesce.

Phase 1 must not infer “verification of the final post-effect state” from generic operation success.

## 35. Separate effect certainty, quiescence, freshness impact, and predicate success

For an `operation_result` predicate these are four different questions:

```text
1. Did the operation report the required terminal outcome?
2. Is its Workspace effect confirmed/absent/indeterminate?
3. Has the mutating executor/descendant set actually quiesced?
4. Did its confirmed Workspace impact change the verification subject?
```

The PR #41 execution-base protocol already requires the first three to remain distinct. Verification adds the fourth.

## 36. Recommended v1 rule for a Workspace-mutating verification operation

A `may_write` verification operation can satisfy an obligation only after:

1. its effect certainty is resolved;
2. mutation quiescence is canonically proven;
3. a complete protected post-effect observation exists;
4. Host-derived impact is known well enough to compare with the obligation's accepted freshness scope.

Then:

```text
impact provably disjoint from V scope
→ V generation need not advance because of O
→ O's successful result may satisfy V for the current generation

impact overlaps V scope
OR impact is not provably disjoint
→ V subjectGeneration advances / prior generation becomes stale
→ O's generic success result MUST NOT automatically satisfy the new generation
```

The final branch is intentionally conservative.

A stronger future verification capability may explicitly define post-effect semantics that prove the final state after all writes. Generic Host capability success in v1 does not.

## 37. Why “just satisfy the new generation” is rejected

Consider:

```text
test process determines success
→ child/cleanup writer changes a source/config file
→ process result is returned
→ writer later becomes quiescent
```

Even if the final effect is confirmed and observation is complete, the success result does not prove that the test evaluated the final changed source/config state.

Binding the same result to the newly advanced generation would turn ordering ignorance into verification authority.

**Classification:** reject generic post-effect self-certification.

## 38. Common harmless writes remain practical

A test that writes only `coverage/`, cache output, or other paths provably disjoint from a source-scoped obligation can still satisfy the obligation after quiescence and post-observation.

If exact impact is unavailable, use a more precise Host capability/provider or accept the conservative invalidation/re-run behavior. Safety wins over optimistic reuse.

## 39. Indeterminate effect or unknown quiescence never satisfies

```text
operation outcome succeeded/failed/etc.
+ effect indeterminate
OR writer quiescence unknown
→ no Program verification satisfaction
```

Reconciliation may later establish a safe current Workspace state, but any verification after that proceeds under the ordinary fresh-attempt/current-generation rules.

---

# Part VII — Satisfaction, replay, and terminal revalidation

## 40. Satisfaction is a Host-owned canonical transition

An Agent may submit evidence or request verification evaluation. It cannot emit `program.verification.satisfied`.

The Host admits satisfaction only after evaluating the immutable predicate against current admissible evidence.

## 41. Minimum satisfaction record

The canonical satisfaction fact should be mechanically able to recover at least:

```text
VerificationObligationId
predicate kind/version identity
verified subjectGeneration
decisive canonical evidence ref(s)
ProgramState revision at admission
ProgramAttemptId when attempt-scoped
Host predicate result
```

The satisfaction record need not duplicate full operation/artifact provenance. Its evidence references resolve that history.

## 42. Satisfaction admission cut

Immediately before `program.verification.satisfied` becomes canonical, the Host must revalidate inside the serialized admission cut, or revalidate all dependent canonical state after entering it:

```text
Program active
exact current Program revision
obligation exists and immutable definition matches
current subjectGeneration == generation being satisfied
current ProgramAttempt ownership where required
no stale Agent generation/request ownership
no blocking unresolved effect/reconciliation condition
no durable writer-quiescence barrier that invalidates the trusted cut
execution-base/current-observation requirements for the predicate are satisfied
decisive evidence is canonical and admissible for current Program state
predicate-specific evidence check succeeds
```

A preliminary evaluator result outside canonical admission is advisory until this currentness cut succeeds.

## 43. Replay does not rerun external verification

Deleting projections and rebuilding from canonical history must reproduce:

- obligation definitions;
- `subjectGeneration` history;
- satisfaction history;
- invalidation history;
- waiver history;
- accepted evidence references.

Replay does **not** rerun commands, reopen old model judgments, or ask the current plugin registry to reinterpret old predicates.

The predicate definition/version is immutable canonical history. The satisfaction event records that the Host admitted the predicate result at its historical cut.

## 44. Live artifact presence gets an additional terminal check

`artifact_present` has one fact that can fail outside ProgramState event history: the retained bytes may become unavailable/corrupt.

For the first slice, require:

```text
artifact presence/integrity checked at satisfaction admission
AND
artifact presence/integrity rechecked by the Completion Oracle at the terminal cut
```

If the artifact is unavailable before completion, the Program does not complete from the old satisfaction merely because the satisfaction event exists.

This does not make ArtifactRef a second ProgramState authority. The ArtifactStore remains the Host byte authority and the terminal predicate deliberately queries it.

After `program.completed` is canonically admitted, later storage corruption does not retroactively rewrite the terminal Program history.

## 45. Workspace path state gets terminal currentness through the execution-base protocol

A path-state satisfaction is freshness-indexed and supported by a complete Host observation.

Before Program completion, the Completion Oracle must operate on a trusted current execution base/current Workspace observation as required by the execution-base protocol. Covered external drift therefore cannot be hidden behind an old path-state satisfaction.

A relevant current Workspace difference invalidates/fails the obligation under the normal `subjectGeneration` rules before completion.

## 46. Operation-result evidence is historical immutable evidence once admitted

A canonical operation result does not disappear like artifact bytes. Its continuing relevance is controlled by `subjectGeneration`, not by rerunning the operation at every Completion Oracle evaluation.

Therefore:

```text
current verifiedGeneration == current subjectGeneration
+ canonical admitted operation evidence remains valid
→ no terminal re-execution required
```

A later relevant mutation makes it stale through generation advancement.

---

# Part VIII — Canonical histories

## 47. Test command succeeds without Workspace mutation

```text
Program created with V-test
predicate = operation_result(exact test invocation)
scope = workspace
subjectGeneration G1
→ current attempt executes exact invocation
→ operation terminal succeeded, effect not_applicable/absent for Workspace
→ current execution base trusted
→ Host admits V-test satisfied for G1
→ later no relevant mutation
→ Completion Oracle may rely on V-test
```

## 48. Wrong command cannot satisfy

```text
V-test requires exact "pnpm test"
→ Agent runs "pnpm lint"
→ operation succeeds
→ evidence is canonical
```

Required result:

```text
canonical evidence remains valid history
but invocation mismatch
→ V-test remains unsatisfied
```

## 49. Stale successful test cannot satisfy after mutation

```text
V-test satisfied at G3
→ relevant source mutation
→ V-test advances to G4
→ old operation evidence still exists
```

Required result:

```text
verifiedGeneration G3 != current G4
→ old satisfaction historical only
→ Completion Oracle rejects
```

## 50. Verification operation writes only disjoint cache paths

```text
V scope = packages/a/src/**
→ exact test operation succeeds
→ Host proves changed paths only .cache/test/**
→ writer quiesced
→ post-effect observation complete
```

Required result:

```text
impact provably disjoint
→ V generation unchanged
→ exact operation evidence may satisfy V
```

## 51. Verification operation changes its own subject

```text
V scope = packages/a/** at G8
→ test operation succeeds
→ operation also changes packages/a/generated.ts
→ writer quiesces
→ changed path overlaps V scope
```

Required result:

```text
V advances to G9
→ test result from the overlapping mutation does not automatically certify G9
→ V remains unsatisfied for G9
```

## 52. Verification operation impact unknown

```text
V path-scoped
→ exact operation succeeds
→ Workspace effect confirmed
→ exact changed paths unavailable
```

Required result:

```text
not provably disjoint
→ fail closed / invalidate V
→ same result does not self-certify new generation
```

## 53. Future artifact requirement without future handle

```text
Program creation
→ V-artifact predicate producedByWorkItemId = W-build
→ no ArtifactRef exists yet
→ W-build executes
→ current canonical evidence admits output ArtifactRef R
→ Host verifies R integrity/presence
→ V-artifact satisfied for current generation
```

No completion-contract mutation is needed.

## 54. Stale-attempt artifact cannot satisfy

```text
Attempt A for W-build produces R
→ A superseded/interrupted
→ Attempt B becomes current
→ late A evidence proposes R for V-artifact
```

Required result:

```text
R may still resolve
but stale Attempt provenance is not current evidence
→ no satisfaction without explicit current Host reconciliation/admission
```

## 55. Same ArtifactRef at a new generation requires fresh evidence

```text
V-artifact satisfied with R at G1
→ relevant mutation → G2
→ R still resolves
→ fresh current execution reproduces identical bytes and same content-addressed R
```

Required result:

```text
old G1 satisfaction remains stale
→ new current canonical evidence for G2 is required
→ R identity alone does not restore satisfaction
```

## 56. Artifact disappears before terminal completion

```text
V-artifact satisfied with R at current generation
→ retained bytes become unavailable/corrupt before Program completion
→ no ProgramState mutation occurred
```

Required result:

```text
Completion Oracle terminal artifact recheck fails
→ program.completed is not admitted
```

## 57. Path absent is not observation unknown

```text
V requires path x absent
→ current protected observation cannot completely inspect required surface
```

Required result:

```text
unknown != absent
→ V remains unsatisfied
```

## 58. Reasoning support does not automatically satisfy Program verification

```text
reasoning verification contract matches action
→ reasoning verification.result.correlated says supports
```

Required result:

```text
reasoning evidence may be referenced/advisory
but Program V remains unchanged
unless Host evaluates V's own closed predicate and admits satisfaction
```

## 59. Waiver after failed verification

```text
V-test unsatisfied
→ Application/user issues authorized waiver at exact current Program revision
→ Host admits durable waiver with actor/reason
```

Required result:

```text
V-test predicate did not become true
but Completion Oracle may treat V-test as acceptable by explicit waiver
```

A later Agent message cannot fabricate the same result.

---

# Part IX — Rejected extensions for v1

## 60. No arbitrary result-field predicates

Do not add:

```text
stdout matches regex
JSON field X comparator Y value Z
arbitrary operator names
```

as generic v1 Program predicates.

If a command needs rich semantics, make the verification command itself exit successfully only when the desired condition holds, or later add a specific Host-defined result predicate with a concrete use case.

## 61. No model/LLM semantic-judgment predicate

Do not add:

```text
Agent says correct
critic confidence > threshold
model score >= N
reasoning hypothesis supported
```

as canonical first-slice completion truth.

Model/reasoning output may be evidence or planning input. It is not the Host's deterministic completion predicate.

## 62. No inspection predicate in v1

Do not add visual/artifact semantic inspection to the first-slice taxonomy merely because the artifact seam has designed a future provenance path.

When inspection is separately approved, the new predicate must require the canonical delivery/provenance semantics already identified by the artifact seam. Until then, artifact presence remains presence only.

## 63. No generic human-approval predicate

Human/Application authority already exists through exact Program creation acceptance and explicit waiver/cancellation/rebase commands.

A generic `human_approved` verification predicate would blur semantic acceptance with evidence. If future workflow needs manual sign-off as a positive completion requirement rather than a waiver, add a dedicated closed command/evidence contract then.

---

# Part X — Acceptance-proof consequences

## 64. No new AC family is required

If this study is later promoted during consolidation, the existing AC-10 set can absorb the taxonomy.

### AC-10-02 — deterministic ProgramState model and rebuild

Prove:

- immutable `VerificationPredicateV1` definitions survive replay exactly;
- unsupported predicate kinds reject creation;
- all canonical obligations are mandatory by default;
- satisfaction/invalidation/waiver state rebuilds identically;
- no current plugin/model registry is required to interpret old predicates.

### AC-10-04 — exact state-indexed attempt validity

Prove stale ProgramAttempt/Agent results cannot satisfy an attempt-scoped obligation even when the underlying operation or ArtifactRef remains valid history.

### AC-10-05 — deterministic bounded scheduling

Work awaiting required verification does not become completed/eligible merely from Agent assertion. Verification definition/scope collections remain within approved structural bounds.

### AC-10-06 — effect uncertainty and durable attempt correlation

Add negative proofs that:

- indeterminate verification operation effect cannot satisfy;
- unknown writer quiescence cannot satisfy;
- stale-attempt operation/artifact evidence cannot satisfy without explicit current reconciliation/admission.

### AC-10-07 — durable verification freshness

Prove:

```text
satisfied G1
→ relevant mutation
→ subjectGeneration G2
→ old evidence remains historical
→ no satisfaction at G2 until fresh predicate-matching evidence
```

Also prove the verification-operation self-mutation rule:

```text
operation reports success
→ own effect overlaps/unknown vs obligation scope
→ generation advances
→ same operation result does not certify the new generation
```

### AC-10-08 — serialized Completion Oracle

Prove:

- every canonical obligation is current-satisfied or validly waived;
- artifact presence/integrity is rechecked at terminal cut;
- universal work/completion predicates are not duplicated through a second criterion engine;
- evidence admitted after creation cannot rewrite immutable predicate definitions.

### AC-10-09 — recovery

Rebuild must not rerun verification commands or consult current evaluator registries. Recovery preserves historical evidence, generations, waivers and outstanding unsafe execution state before any new verification admission.

### AC-10-10 — Application/read model

Expose bounded obligation state including at least:

```text
obligation identity
predicate kind
current/stale/waived status
subjectGeneration
whether new verification is required
```

Do not expose arbitrary evaluator/plugin internals as canonical UI authority.

---

# Part XI — Consolidation consequences

## 65. Supersede the current CompletionCriterion union if this recommendation is promoted

A later Phase 1.0 consolidation should remove the old concrete-reference `CompletionCriterion[]` from the first-slice semantic model.

The completion contract becomes:

```text
immutable caller objective
+ immutable mandatory VerificationObligationV1[]
+ universal Host Completion Oracle predicates
```

There is no separate `canonical_evidence_accepted` completion requirement.

## 66. Proposed obligation shape for consolidation

Illustrative only:

```ts
interface VerificationObligationV1 {
  obligationId: VerificationObligationId;
  predicateVersion: "verification-predicate-v1";
  predicate: VerificationPredicateV1;
  freshnessScope: VerificationFreshnessScopeV1;
  subjectGeneration: number;
}
```

The definition fields are immutable. `subjectGeneration` and satisfaction/waiver state evolve through canonical transitions.

Exact storage/event placement remains implementation design.

## 67. Creation-time policy/profile expansion

If Host policy offers convenient named verification profiles such as “standard TypeScript checks”, the profile name must not become the replay-time predicate authority.

At creation:

```text
current policy/profile
→ expands to concrete bounded VerificationObligationV1 definitions
→ exact expanded definitions shown/accepted as appropriate
→ concrete definitions become canonical
```

Replay consumes the concrete stored predicates, not whatever the profile means in a later Host version.

## 68. First-slice completeness claim

The recommended taxonomy intentionally proves only three classes of objective-specific fact:

```text
exact admitted verification operation succeeded
current Workspace path has a direct required state
current Program-produced output artifact is retained and resolvable
```

That is sufficient for the first executable coding-agent slice when combined with:

- immutable human/Application acceptance of the exact verification contract;
- work-DAG completion;
- execution-base freshness;
- per-obligation subjectGeneration;
- operation/effect uncertainty;
- blockers;
- ProgramAttempt validity;
- universal Completion Oracle quiescence.

A future requirement outside these classes is evidence for a deliberate predicate-v2 extension, not a reason to freeze a generic DSL now.

---

# Part XII — Final recommendation and confidence

## 69. Recommendation package

If later promoted, Phase 1.0 should adopt all of the following together:

1. remove the separate first-slice `CompletionCriterion[]` engine;
2. make every canonical Program verification obligation mandatory for completion unless explicitly waived;
3. use one closed `VerificationPredicateV1` union with exactly:
   - `operation_result`;
   - `workspace_path_state`;
   - `artifact_present`;
4. use only closed bounded `workspace | paths` freshness scopes in v1;
5. preserve per-obligation `subjectGeneration` as the sole Program verification freshness authority;
6. admit satisfaction only through Host evaluation of current canonical/protected evidence at an exact current-state cut;
7. reject generic reasoning expressions, plugin evaluators, Boolean DSLs, free-form evidence predicates and model judgments as Program completion authority;
8. keep waiver as a separate explicit Host-authorized transition;
9. for `may_write` verification operations, require resolved effect + durable quiescence + complete post-observation + provably disjoint impact before the same result can satisfy the current generation; overlapping/unknown self-impact invalidates and cannot self-certify the new generation;
10. recheck `artifact_present` resolution/integrity at the Completion Oracle terminal cut;
11. defer inspection-dependent verification until its separately designed delivery/provenance contract is approved;
12. persist concrete predicate definitions/versioning so replay never consults mutable current policy/evaluator registries.

## 70. Confidence

**High** on:

- rejecting runtime-generated completion references;
- making Program verification obligations mandatory by default;
- separating waiver from predicate truth;
- rejecting generic reasoning/plugin/model predicate authority;
- operation/path/artifact as the minimal useful v1 proof classes;
- per-obligation subjectGeneration and fail-closed unknown impact;
- self-mutation cannot generically certify its own new verification generation;
- replay consuming stored predicate definitions rather than current registries.

**Medium-high** on adding `workspace_path_state` rather than forcing all such checks through operation-result evidence. It adds one small Host-native predicate but avoids provider-dependent interpretation of elementary path facts.

**Medium** on requiring Completion Oracle live artifact re-resolution rather than defining a stronger ArtifactStore retention guarantee. The current ArtifactStore is effectively append-only for retained content but does not make physical availability a canonical event fact. Terminal re-resolution is the smaller fail-closed contract for Phase 1.

## 71. Falsifiers / evidence that should change the recommendation

Reconsider the exact v1 union if repository evidence shows any of the following before consolidation:

- a signature Phase 1 scenario requires an objective-specific deterministic fact that cannot be represented by operation success, direct path state, or retained output artifact presence;
- a direct Workspace path predicate cannot be evaluated under the selected execution observation contract without creating a second Workspace authority;
- current capability semantics cannot preserve an exact immutable invocation identity across restart/replay without provider-dependent reinterpretation;
- a realistic required verification operation necessarily modifies its own verification subject and no safe non-overlapping/post-state verification path exists;
- ArtifactStore lifecycle guarantees can be made canonical enough that terminal live presence recheck is unnecessary;
- structural-bound measurement demonstrates that storing exact bounded invocation specs causes unacceptable ProgramState/projection growth, requiring a canonical referenced contract artifact with equivalent immutable semantics.

## 72. Remaining Phase 1 planning work after this study

If this recommendation survives review, the remaining pre-consolidation evidence task is **empirical structural-bound measurement**.

After that measurement, the project can prepare one consolidation amendment that reconciles the governing plan with the accepted planning studies. This study itself does not perform that consolidation, approve/freeze Phase 1, or authorize implementation.
