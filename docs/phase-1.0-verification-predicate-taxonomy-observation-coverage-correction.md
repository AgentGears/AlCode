# Phase 1.0 Verification Predicate Taxonomy — Observation Coverage Correction

**Status:** incorporated correction to PR #42 verification-predicate taxonomy study  
**Approval:** non-normative planning only; not approved; not frozen; implementation not authorized

**Precedence:** this correction controls wherever the earlier PR #42 study/corrections permit a verification freshness scope whose declared Workspace dependencies are not completely represented by the Program's current Phase 1 execution-observation profile.

It does not amend the governing Phase 1.0 plan or authorize implementation.

---

## 1. Problem

The execution-base protocol deliberately defines `ExecutionObservationIdentity` over a bounded semantic Workspace surface.

For the selected local Git profile, tracked files and untracked non-ignored files are covered, while ignored dependency/build caches may be outside the observation surface. Therefore:

```text
external change only in ignored excluded content
→ ExecutionObservationIdentity may remain unchanged
```

The verification taxonomy cannot safely admit a path freshness scope such as:

```text
subtree(node_modules)
```

under a profile that explicitly excludes `node_modules`, because later external mutation there may be invisible to both observation-drift detection and path-impact evidence.

Merely validating path syntax, normalization and bounds is insufficient.

---

## 2. Verification scope must be observable under the bound execution profile

The Host must validate a second compatibility relation:

```text
verification freshness scope
⊆
semantic coverage of the Program's selected/current ExecutionObservation profile
```

For the v1 `paths` scope, every `exact` or `subtree` entry must be **completely representable and observable** under that profile's declared coverage semantics.

Semantic rule:

> **A path-scoped verification obligation is admissible/current only when every declared path-scope entry is covered by the execution-observation profile used to establish the Program's trusted execution base.**

A path that is explicitly excluded, conditionally unobservable, outside the Workspace root, hidden by a sparse/provider coverage rule, or otherwise not completely represented by that profile cannot be treated as safely freshness-indexed through ordinary `subjectGeneration` impact rules.

## 3. `coverageDigest` is evidence of the exact coverage contract, not a path-membership oracle

PR #41 defines `ExecutionObservationIdentity.coverageDigest` to bind the observation profile/version, provider/workspace/root identity, included surfaces, exclusions, normalization, symlink/submodule behavior, and other coverage-changing configuration.

The Host already possesses the semantic coverage descriptor/configuration from which that digest is derived. Verification admission uses that Host-owned descriptor to decide whether a path-scope entry is covered; it does not attempt to infer path membership from the digest bytes alone.

Conceptually:

```text
coverage descriptor C
→ deterministic validateScopeEntryCovered(C, entry)
→ coverageDigest(C) participates in ExecutionObservationIdentity
```

The descriptor/profile contract is Host-defined and versioned. This does not create a model/plugin evaluator.

## 4. Creation/admission rule

At Program creation, after syntax/bounds/normalization and predicate/scope compatibility checks, the Host also checks scope/observation compatibility against the execution-observation profile selected for that Workspace/Program execution contract.

For a `paths` scope:

```text
for every entry E:
  E is fully covered by selected observation profile
```

If any entry is not covered:

```text
→ reject Program creation/admission for that obligation
```

unless an already-supported stronger permitted observation profile is selected that can represent the declared scope completely.

Phase 1 does not invent an automatic stronger profile or silently widen raw filesystem observation merely to accept the obligation.

## 5. Default local Git profile example

Under the selected local Git `workspace-observation-v1` profile:

```text
tracked packages/a/src/x.ts
→ covered

untracked non-ignored packages/a/generated.txt
→ covered, subject to bounds/profile rules

ignored node_modules/**
→ excluded from ordinary current-checkout observation surface

ignored build cache directory
→ excluded unless the selected profile explicitly says otherwise
```

Therefore:

```text
scope = paths([subtree(node_modules)])
→ reject under the default local Git profile
```

A verification operation may still *use* dependency caches as execution environment. The point is narrower: a Program verification contract may not claim that changes to an explicitly unobserved path are freshness-tracked by the ordinary path-scope mechanism.

If correctness truly depends on excluded state, it needs a stronger approved observation/isolation profile or a future capability/evidence freshness contract that covers that state explicitly.

## 6. `workspace` scope means the selected observed Workspace semantic surface

The v1 `workspace` scope is not a claim that every byte under the filesystem root is continuously observed.

It means:

```text
all semantic Workspace state covered by the selected ExecutionObservation profile
```

The shared-worktree guarantee boundary from PR #41 remains unchanged.

Thus an Agent/Application that chooses `workspace` is accepting the selected profile's explicit coverage/exclusions; the Host must not describe it as “all filesystem inputs to every command.”

## 7. Runtime coverage continuity is fail-closed

Creation-time compatibility is necessary but not sufficient if the execution-observation coverage later changes.

Because Phase 1 treats different `coverageDigest` values as non-equivalent for exact currentness, a later change in profile/coverage cannot silently preserve verification freshness.

Required rule:

```text
accepted/current verification satisfaction at coverage C1
→ execution observation later has different coverage C2
→ Host cannot prove Phase 1 exact coverage continuity
→ affected verification currentness fails closed
```

For first-slice semantics, treat that loss/change of coverage as an unknown freshness impact:

```text
→ invalidate/advance subjectGeneration for obligations whose freshness depended on C1
→ old satisfaction and old waiver become historical for the prior generation
```

A subsequent rebase to a complete execution base under C2 does not resurrect C1 verification state. Fresh current verification or a fresh current-generation waiver is required.

This composes the existing two rules rather than adding another freshness counter:

```text
ExecutionObservation coverage changed
→ relevance/continuity unknown
→ existing fail-closed verification invalidation
→ subjectGeneration advances
```

## 8. Observation result `unknown` remains non-acceptable

If the Host cannot produce a complete observation under the required profile/coverage—for example because bounds are exceeded, submodule state cannot be represented, or a provider cannot inspect a required entry—then:

```text
ExecutionObservationResult = unknown
```

and no current verification satisfaction may be admitted from that cut.

The Application cannot rebase or waive observation completeness into existence. It may explicitly waive a verification obligation for the resulting current verification generation only once ordinary Program authority/currentness requirements permit such a waiver; that waiver remains an authorization to proceed without predicate evidence, not proof that the unobserved state was acceptable.

## 9. Relationship to `workspace_path_state(P)` coverage rule

The prior scope correction remains necessary and is now refined to two independent checks:

```text
A. predicate/scope compatibility:
   workspace_path_state(P) requires scope to cover P

B. scope/observation compatibility:
   every path-scope entry, including the one covering P, must itself be covered by the selected execution-observation profile
```

Both must pass.

Example:

```text
predicate = workspace_path_state(node_modules/pkg/index.js, file)
scope = paths([exact(node_modules/pkg/index.js)])
```

The scope covers the predicate path syntactically, but under the default local Git profile the entry is outside ordinary observation coverage, so Program creation/admission rejects it.

## 10. Host-known mutation does not make excluded external state observable

A Host-known `may_write` operation still participates in mutation coordination and causal generation even when it may write excluded content.

That does not solve freshness for external writes to the same excluded content between protected cuts.

Therefore Host operation correlation is not a substitute for requiring declared path freshness dependencies to be observationally covered.

## 11. Required histories

### 11.1 Ignored path rejected

```text
selected profile excludes ignored node_modules/**
→ V scope = paths([subtree(node_modules)])
→ Host creation/admission rejects V
```

### 11.2 Covered path accepted

```text
selected profile covers tracked packages/a/**
→ V scope = paths([subtree(packages/a)])
→ all other scope checks pass
→ V may become canonical
```

### 11.3 Coverage changes after satisfaction

```text
V satisfied at G4 under coverageDigest C1
→ Workspace/provider/profile coverage changes to C2
→ C2 != C1
```

Required result:

```text
exact execution-base coverage continuity is not established
→ verification freshness fails closed
→ V advances/invalidates to G5
→ G4 satisfaction/waiver cannot be reused
```

### 11.4 Stronger profile is unavailable

```text
V explicitly depends on excluded path P
→ no permitted Phase 1 observation profile completely covers P
```

Required result:

```text
reject obligation/Program creation
```

Do not silently reinterpret the scope as `workspace`, drop P, or pretend provider output tracks it.

## 12. Acceptance-proof consequences

If later consolidated:

### AC-10-02

Prove Program creation rejects path-scoped obligations containing entries outside the selected execution-observation profile's declared coverage.

### AC-10-04 / AC-10-05

A successor attempt cannot treat a Program as verification-current after an execution-observation coverage change merely because prior `stateDigest`-covered values appear unchanged.

### AC-10-07

Add proofs for:

```text
covered path satisfaction
→ coverageDigest changes
→ subjectGeneration advances/freshness invalidates
→ old satisfaction and waiver non-current
```

and:

```text
ignored/excluded path proposed as freshness dependency
→ creation rejected
```

### AC-10-08

Completion requires verification currentness under the same trusted current execution-observation coverage contract; a stale satisfaction from an earlier coverage contract cannot satisfy terminal completion.

## 13. Corrected final rule

Where this correction changes the earlier PR #42 documents:

> **The v1 `workspace | paths` freshness taxonomy is scoped to the semantic surface that the selected versioned ExecutionObservation profile can completely observe. Every explicit path entry must be covered by that profile, and any later non-equivalent observation coverage causes fail-closed verification invalidation rather than silent freshness reuse.**

`subjectGeneration` remains the sole Program verification freshness ordinal. `coverageDigest` remains execution-observation identity, not a second verification generation.
