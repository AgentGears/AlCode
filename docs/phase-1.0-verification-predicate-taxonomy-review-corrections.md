# Phase 1.0 Verification Predicate Taxonomy — Review Corrections

**Status:** incorporated correction to PR #42 verification-predicate taxonomy study  
**Approval:** non-normative planning only; not approved; not frozen; implementation not authorized

**Precedence:** this correction controls wherever `docs/phase-1.0-verification-predicate-taxonomy-study.md` conflicts with the rules below.

It does not amend the governing Phase 1.0 plan or authorize implementation.

---

## 1. Purpose

Review of the initial taxonomy exposed four correctness gaps:

1. an artifact-presence predicate identified only the producing work item, allowing the wrong artifact from a multi-output work item to satisfy the requirement;
2. an operation-result predicate identified only `toolName + args`, allowing a replaceable dynamic provider to redefine what `succeeded` means;
3. path freshness scope used ordinary normalized paths while examples relied on implicit subtree/glob semantics;
4. waiver validity was not explicitly indexed by verification `subjectGeneration`.

All four are load-bearing because each could allow Program completion without the exact requirement or authorization accepted at creation.

This correction closes them without adding a generic rule language or a second verification authority.

---

# Part I — Stable artifact output identity

## 2. `producedByWorkItemId` alone is insufficient

A work item may produce multiple Host-retained artifacts:

```text
W-build
  ├─ diagnostic/log artifact L
  ├─ metadata artifact M
  └─ required package artifact P
```

A predicate defined only as:

```ts
{ kind: "artifact_present", producedByWorkItemId: W_build }
```

cannot distinguish `P` from `L` or `M`.

That allows a non-deliverable artifact to satisfy a deliverable requirement.

## 3. Add a stable creation-time logical output slot

The immutable Program creation contract should be able to define bounded logical output slots.

Illustrative shape:

```ts
type ProgramOutputSlotId = Branded<"ProgramOutputSlotId">;

interface ProgramOutputSlotV1 {
  outputSlotId: ProgramOutputSlotId;
  producerWorkItemId: ProgramWorkItemId;
}

interface ArtifactPresentPredicateV1 {
  kind: "artifact_present";
  outputSlotId: ProgramOutputSlotId;
}
```

Exact TypeScript/package placement remains implementation design.

The semantic rule is normative for the recommendation:

> **An artifact-presence requirement names one stable logical output slot that exists at Program creation. Runtime evidence binds a concrete ArtifactRef to that slot; the runtime ArtifactRef never becomes part of the immutable predicate definition.**

## 4. Output-slot authority

An output slot is not an ArtifactRef and is not a second byte authority.

```text
ProgramOutputSlotId
→ stable logical deliverable requirement

ArtifactRef
→ Host content-addressed byte identity

canonical operation/evidence history
→ proof that a particular current Program execution produced/bound ArtifactRef R to slot S
```

The HostArtifactStore remains byte authority.

## 5. Slot binding is Host-owned and provenance-checked

An Agent/tool report may propose or label an output, but it cannot make the binding canonical by assertion.

A concrete ArtifactRef may satisfy slot `S` only when canonical evidence proves at least:

```text
S exists in the immutable Program contract
S.producerWorkItemId == producing/current work identity
ArtifactRef was admitted as an output of current Program-linked execution
ProgramAttempt/evidence provenance is current or explicitly reconciled/admitted
ArtifactRef resolves and passes integrity checks
obligation subjectGeneration is current
```

If a work item has two required artifacts, the Program defines two distinct output slots.

## 6. Historical retries may bind different artifacts to the same slot

A slot is stable across attempts; a concrete artifact is not.

Example:

```text
slot S-package belongs to work W
→ Attempt A produces R1
→ A later becomes stale
→ Attempt B produces R2
```

Both bindings may remain historical canonical evidence. Only evidence admissible for the current verification generation/Program state can satisfy the slot-backed obligation.

Identical bytes may yield the same content-addressed ArtifactRef across attempts. Fresh current evidence is still required after freshness invalidation.

## 7. Corrected artifact predicate recommendation

Replace the initial illustrative predicate:

```ts
interface ArtifactPresentPredicateV1 {
  kind: "artifact_present";
  producedByWorkItemId: ProgramWorkItemId;
}
```

with semantic equivalence to:

```ts
interface ArtifactPresentPredicateV1 {
  kind: "artifact_present";
  outputSlotId: ProgramOutputSlotId;
}
```

The slot itself records the stable producer work item.

No free-form artifact label or runtime handle is needed.

---

# Part II — Stable operation verification semantics

## 8. `toolName + args` does not by itself freeze success semantics

Current dynamic provider registration permits a provider generation to be replaced while exposing the same capability name.

If a verification predicate means only:

```text
run tool T with args A
and accept outcome = succeeded
```

then a replacement dynamic provider can alter implementation and effectively redefine what `succeeded` means without changing the Program contract.

That would reintroduce provider/plugin authority into terminal verification.

## 9. Distinguish operation identity from verification semantics identity

The first slice needs two separate concepts:

```text
operationId
→ identity of one concrete external operation/effect history

VerificationOperationContractV1
→ immutable Host-defined semantics under which that operation result is allowed to prove a Program verification predicate
```

The second must exist before evidence and be immutable in the Program contract.

## 10. Corrected operation-result predicate

Illustrative shape:

```ts
interface OperationResultPredicateV1 {
  kind: "operation_result";
  verificationOperationContract: {
    kind: "host_verification_operation";
    contractVersion: 1;
    operationKind: string;
  };
  invocation: {
    args: unknown;
    argsDigest: string;
  };
  requiredOutcome: "succeeded";
  requiredExitCode?: number;
}
```

`operationKind` spelling remains illustrative. It is **not** an arbitrary plugin registry key.

The semantic requirement is:

> **Every v1 `operation_result` predicate is interpreted by a stable versioned Host verification-operation contract whose success facts are defined by ALCODE/Host semantics, not by whatever replaceable provider currently owns a tool name.**

## 11. Eligible v1 verification operations

A capability result is eligible for `operation_result` verification only when the Host can map it to an admitted stable verification-operation contract.

Examples of acceptable architecture families include:

```text
Host-owned process/command verification adapter
→ Host observes primitive process result
→ Host-defined v1 semantics derive succeeded/exit status

Host-owned deterministic verification adapter
→ Host defines exact result semantics in a versioned contract
```

A raw dynamic MCP/plugin capability whose provider is the sole authority for what its `succeeded` result means is **not** directly eligible to satisfy a v1 Program verification predicate.

It may still execute as an ordinary capability and produce canonical evidence. That evidence simply does not acquire Program terminal-verification authority unless a stable Host verification adapter/contract validates it.

## 12. Dynamic providers can participate behind a stable Host contract

This correction does not prohibit dynamic providers from helping verification.

It requires authority narrowing:

```text
replaceable provider result
→ stable Host verification adapter/contract
→ Host-derived predicate result
→ Program verification admission
```

If the Host cannot establish that stable contract, Program creation rejects that `operation_result` predicate or the obligation remains unsatisfied.

## 13. Provider generation remains operation provenance, not verification freshness

This correction does not create a Program-global provider snapshot or a new freshness counter.

Operation-local provider/binding/containment provenance remains governed by the execution-base/quiescence planning decisions.

`subjectGeneration` remains verification freshness authority.

If a future verification requirement explicitly wants one named provider/profile generation as part of its semantics, that must be a new explicit predicate/contract field. It is not inferred from whichever provider happens to run.

## 14. Replay rule

Replay consumes the immutable stored `VerificationOperationContractV1` identity/version and historical Host-admitted satisfaction result.

It does not:

- query the current dynamic provider registry;
- reinterpret historical success under a replacement plugin;
- rerun the old verification operation.

A Host upgrade that cannot interpret an admitted v1 contract is a protocol-compatibility failure, not permission to reinterpret the requirement.

---

# Part III — Closed path-scope semantics

## 15. No implicit glob language

The initial study's illustrative scope:

```ts
{ kind: "paths"; paths: readonly NormalizedWorkspacePath[] }
```

is insufficient because examples used `packages/a/**` without defining glob behavior.

Phase 1 must not leave overlap semantics to implementation convention.

## 16. Corrected bounded path-scope entry

Use a closed scope-entry taxonomy equivalent to:

```ts
type VerificationPathScopeEntryV1 =
  | {
      kind: "exact";
      path: NormalizedWorkspacePath;
    }
  | {
      kind: "subtree";
      root: NormalizedWorkspacePath;
    };

type VerificationFreshnessScopeV1 =
  | { kind: "workspace" }
  | { kind: "paths"; entries: readonly VerificationPathScopeEntryV1[] };
```

No arbitrary glob/regex syntax is part of v1.

## 17. Exact-entry semantics

```text
{ kind: exact, path: P }
```

matches only the normalized Workspace entry `P` itself.

A mutation to descendant `P/x` does not match an exact entry `P` unless the Host impact model also reports the parent entry `P` as changed.

## 18. Subtree-entry semantics

```text
{ kind: subtree, root: R }
```

matches:

```text
R itself
OR
any normalized descendant whose path begins with R + one path-separator boundary
```

String-prefix accidents are forbidden.

Example:

```text
root packages/a
matches packages/a
matches packages/a/src/x.ts

does not match packages/ab/x.ts
```

Normalization/case rules come from the authoritative Workspace provider/profile used by the execution-observation contract; verification scope does not invent different path normalization.

## 19. Renames, directory effects and unknown impact

The Host impact evidence must classify a rename/directory mutation strongly enough to compare against exact/subtree entries.

If it cannot prove disjointness:

```text
impact unknown
→ fail closed
→ invalidate affected/non-provably-disjoint obligations
```

The scope evaluator must not guess disjointness from incomplete changed-path lists.

## 20. Bounds

Both:

- number of path-scope entries per obligation; and
- normalized path length

remain subject to the structural-bound measurement/consolidation work.

The semantic requirement is finite enforced bounds and deterministic normalization/deduplication.

---

# Part IV — Waiver freshness

## 21. A waiver is an authorization for one verification subject generation

The initial study correctly separates waiver authority from predicate truth but left “valid waiver” underspecified.

For Phase 1, use the safer state-indexed rule:

```text
waiver is current
iff
waiver.waivedGeneration == obligation.subjectGeneration
```

A waiver records the exact generation for which the Application/authorized actor accepted proceeding without evidence.

## 22. Relevant mutation makes an earlier waiver non-current

Required history:

```text
V at G1
→ authorized waiver W records waivedGeneration = G1
→ Completion Oracle may accept V at G1
→ relevant mutation advances V to G2
```

Then:

```text
W remains historical authorization for G1
but W.waivedGeneration != current G2
→ W cannot satisfy completion at G2
→ new current verification or a new explicit waiver is required
```

This prevents a one-time risk acceptance from silently covering a materially changed verification subject.

## 23. No permanent/evergreen waiver in v1

The first slice does not introduce:

```text
waive forever
ignore all future generations
```

as a hidden waiver flag.

If successor product requirements need a persistent exemption, that should be an explicit separate contract/authorization mode with its own visible semantics.

## 24. Waiver remains orthogonal to predicate evaluation

The predicate did not become true.

Program terminal acceptability is:

```text
(current satisfaction for current subjectGeneration)
OR
(current authorized waiver for current subjectGeneration)
```

The Agent cannot create either state by assertion.

---

# Part V — Corrected canonical histories

## 25. Multi-output work item

```text
Program creation defines:
  W-build
  slot S-log
  slot S-package
  V-package = artifact_present(S-package)

Attempt executes W-build
→ retains log ArtifactRef L bound to S-log
→ package production fails
```

Required result:

```text
L resolves
but L is not bound to S-package
→ V-package remains unsatisfied
→ Program cannot complete from the log artifact
```

## 26. Correct output produced later

```text
fresh current attempt for W-build
→ output ArtifactRef P canonically bound to S-package
→ P resolves/integrity passes
→ current generation matches
```

Then `P` may satisfy `V-package`.

## 27. Provider replacement under the same tool name

```text
Program created with operation_result requirement Q
→ Q uses Host verification-operation contract C-v1
→ dynamic provider P0 exposes tool T
→ P0 replaced by P1, same tool name T
→ P1 claims success under different provider semantics
```

Required result:

```text
P1 raw success does not by itself satisfy Q
→ only evidence validated through C-v1's stable Host semantics is eligible
```

No mutable provider registry lookup redefines Q.

## 28. Path subtree overlap

```text
V scope entry = subtree(packages/a)
→ changed path = packages/a/src/x.ts
```

Required result:

```text
segment-boundary descendant match
→ relevant
→ V invalidated/subjectGeneration advances
```

## 29. Prefix collision

```text
V scope entry = subtree(packages/a)
→ changed path = packages/ab/src/x.ts
```

Required result:

```text
not a descendant on a path-segment boundary
→ may be treated disjoint if no other impact intersects V
```

## 30. Waiver then mutation

```text
V at G4
→ Application waives V for G4
→ relevant mutation
→ G5
```

Required result:

```text
G4 waiver historical only
→ Completion Oracle rejects until V is satisfied or freshly waived for G5
```

---

# Part VI — Acceptance-proof corrections

## 31. AC-10-02

If later consolidated, additionally prove:

- output slots are stable creation-time logical identities and rebuild exactly;
- artifact predicates reference output slots, never arbitrary runtime outputs from a work item;
- Host verification-operation contract identity/version is persisted with `operation_result` definitions;
- path scopes rebuild with exact/subtree semantics rather than implementation-defined globs.

## 32. AC-10-06

Add negative proofs:

```text
same toolName + args
+ replacement dynamic provider reports succeeded
+ no matching stable Host verification-operation contract result
→ no Program verification satisfaction
```

and:

```text
stale Attempt artifact bound historically to required output slot
→ later slot requirement current at newer generation
→ old binding alone does not satisfy
```

## 33. AC-10-07

Add proofs:

```text
waive at G1
→ relevant mutation → G2
→ G1 waiver non-current
```

and exact/subtree path overlap boundary cases.

## 34. AC-10-08

Terminal completion must require, for each obligation:

```text
current satisfaction generation == current subjectGeneration
OR
current waiver generation == current subjectGeneration
```

For artifact predicates it additionally revalidates the ArtifactRef currently bound through the accepted output-slot evidence.

---

# Part VII — Corrected recommendation package

## 35. Final recommendation after review

Where this correction changes the initial study, the recommended Phase 1 package is:

1. no separate first-slice `CompletionCriterion[]` engine;
2. all canonical verification obligations mandatory unless explicitly waived for the **current** subject generation;
3. closed `VerificationPredicateV1` with exactly:
   - `operation_result` under a stable versioned **Host verification-operation contract**;
   - `workspace_path_state`;
   - `artifact_present` referring to a stable creation-time **ProgramOutputSlotId**;
4. closed freshness scopes:
   - `workspace`;
   - bounded `paths` with explicit `exact | subtree` entries and segment-boundary semantics;
5. no generic glob/regex freshness language;
6. no raw dynamic-provider success as terminal Program verification authority;
7. no arbitrary artifact from the right work item as sufficient proof of the intended deliverable;
8. per-obligation `subjectGeneration` remains freshness authority for both satisfaction and waiver currency;
9. all self-mutation, quiescence, evidence, replay and artifact terminal-recheck rules from the initial study remain in force unless explicitly changed here.

## 36. Confidence after correction

**High** that these corrections are required for deterministic terminal authority:

- output-slot identity closes multi-artifact ambiguity;
- stable Host verification-operation semantics closes provider replacement authority drift;
- exact/subtree path entries close overlap ambiguity without a glob DSL;
- generation-indexed waivers close stale risk-authorization reuse.

No additional Phase 1 subsystem is introduced. Each correction narrows an existing authority boundary.
