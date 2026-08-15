# Phase 1.0 Verification Predicate Taxonomy — Scope Correction

**Status:** incorporated correction to PR #42 verification-predicate taxonomy study  
**Approval:** non-normative planning only; not approved; not frozen; implementation not authorized

**Precedence:** this correction controls wherever `docs/phase-1.0-verification-predicate-taxonomy-study.md` or `docs/phase-1.0-verification-predicate-taxonomy-review-corrections.md` conflicts with the rules below.

It does not amend the governing Phase 1.0 plan or authorize implementation.

---

## 1. Purpose

Review of the first correction exposed two remaining freshness-scope gaps:

1. `paths` could be admitted with an empty entry set, which is semantically equivalent to the intentionally rejected evergreen/`none` scope;
2. a `workspace_path_state(P)` predicate could be paired with a path scope that did not cover `P`, allowing a later change to the very path being asserted to appear disjoint and leave stale satisfaction current.

Both are correctness failures because they can preserve a verification satisfaction after the accepted verification subject has materially changed.

---

## 2. Path-scoped freshness is non-empty by construction

The first-slice scope remains conceptually:

```ts
type VerificationPathScopeEntryV1 =
  | { kind: "exact"; path: NormalizedWorkspacePath }
  | { kind: "subtree"; root: NormalizedWorkspacePath };

type VerificationFreshnessScopeV1 =
  | { kind: "workspace" }
  | {
      kind: "paths";
      entries: readonly [VerificationPathScopeEntryV1, ...VerificationPathScopeEntryV1[]];
    };
```

Exact TypeScript spelling is illustrative. The semantic rule is mandatory:

> **A `paths` freshness scope contains at least one normalized bounded entry. Empty path scopes are rejected at Program creation/canonical admission.**

This preserves the earlier decision not to expose an evergreen/`none` verification scope in the first slice.

An implementation may encode non-emptiness through a tuple type, constructor, validator, or equivalent deterministic representation, but malformed canonical creation events with zero entries are invalid.

## 3. Why empty cannot mean “no Workspace dependency”

A zero-entry scope would imply:

```text
for every known Workspace mutation M:
M intersects no declared entry
→ M is disjoint
→ subjectGeneration never advances because of Workspace mutation
```

That is the same semantic escape hatch as:

```text
{ kind: "none" }
```

which the taxonomy deliberately excludes because a weak creation-time proposal could otherwise make a mandatory coding verification permanently fresh.

If a future requirement is genuinely independent of Workspace state, that should be introduced as an explicit reviewed predicate/freshness mode with visible semantics, not encoded accidentally as an empty collection.

---

## 4. Predicate/scope compatibility is validated at creation

A verification obligation is not valid merely because its predicate and freshness scope are each well-formed independently.

The Host must also enforce deterministic **predicate/scope compatibility** during Program creation/admission wherever the predicate itself names Workspace state that must stay fresh.

For v1 this creates one mandatory special case:

> **`workspace_path_state(P)` requires a freshness scope that covers `P`.**

Valid forms are:

```text
scope = workspace
```

or:

```text
scope = paths(entries)
AND at least one entry covers P
```

## 5. Coverage function

Use the same normalized path and path-segment semantics already selected for freshness overlap.

Conceptually:

```ts
covers(entry, P) =
  entry.kind == "exact"
    ? normalize(entry.path) == normalize(P)
    : P == entry.root || P is a normalized descendant of entry.root on a path-segment boundary;
```

Examples:

```text
predicate path = packages/a/config.json
scope exact(packages/a/config.json)
→ valid

predicate path = packages/a/config.json
scope subtree(packages/a)
→ valid

predicate path = packages/a/config.json
scope exact(packages/a/other.json)
→ invalid creation

predicate path = packages/a/config.json
scope subtree(packages/ab)
→ invalid creation
```

String-prefix matching without a segment boundary remains forbidden.

## 6. The scope may be wider than the predicate's own path

Coverage is a minimum safety requirement, not an equality requirement.

A path-state predicate may legitimately depend on more than the direct path it names. Therefore these are valid:

```text
workspace_path_state(P)
+ scope = workspace
```

or:

```text
workspace_path_state(P)
+ scope includes exact(P)
+ additional exact/subtree entries
```

Host policy may conservatively widen a proposed scope before Application acceptance, as already established by the Program creation authority model.

## 7. The Host does not infer semantic sufficiency beyond the mandatory coverage check

For `workspace_path_state(P)`, direct coverage of `P` is mechanically required because the predicate's truth necessarily depends on `P`.

For `operation_result` and `artifact_present`, the Host cannot generally derive the complete semantic Workspace dependency set from the predicate alone. Those scopes remain part of the exact accepted Program contract, with Host policy able to widen them and runtime unknown impact failing closed.

This correction therefore does **not** invent a ProgramModel or repository dependency graph.

---

## 8. Corrected mutation history for path-state predicates

Required history:

```text
V predicate = workspace_path_state(P, file)
V scope covers P
V satisfied at subjectGeneration G1
→ P deleted/replaced/retargeted in a way relevant to its required direct state
→ Host impact evidence includes P or cannot prove disjointness
```

Required result:

```text
mutation intersects V's accepted scope
→ V subjectGeneration advances to G2
→ G1 satisfaction becomes historical/stale
→ Completion Oracle cannot rely on G1
→ fresh current predicate evidence is required for G2
```

The correctness of this history does not depend on an unconditional second predicate engine at terminal completion; it follows from the accepted freshness scope actually covering the predicate's own state.

The Completion Oracle still operates on the trusted current execution/observation cut required by the execution-base protocol.

## 9. External ABA remains within the existing guarantee boundary

This correction does not claim continuous filesystem isolation.

If an external process changes `P` and restores an observationally identical state between protected observations, the existing shared-worktree external-ABA limitation remains. The correction closes deterministic scope undercoverage; it does not upgrade the Phase 1 guarantee to snapshot isolation.

---

## 10. Required negative proofs

### 10.1 Empty path scope

```text
Program creation proposes obligation V
scope = { kind: paths, entries: [] }
→ Host rejects creation/admission
→ no canonical evergreen verification scope is created
```

### 10.2 Path-state scope misses its own path

```text
V predicate = workspace_path_state(packages/a/config.json, file)
scope = paths([exact(packages/a/other.json)])
→ Host rejects creation/admission
```

### 10.3 Ancestor subtree covers predicate path

```text
V predicate = workspace_path_state(packages/a/config.json, file)
scope = paths([subtree(packages/a)])
→ valid
→ later change to packages/a/config.json intersects scope
→ subjectGeneration advances
```

### 10.4 Prefix collision is not coverage

```text
V predicate path = packages/ab/config.json
scope = paths([subtree(packages/a)])
→ scope does not cover predicate path
→ creation/admission rejected
```

### 10.5 Wider scope remains allowed

```text
V predicate = workspace_path_state(packages/a/config.json, file)
scope = workspace
→ valid
```

---

## 11. Acceptance-proof consequences

If later consolidated:

### AC-10-02

Prove obligation creation rejects:

- `paths` with zero entries;
- `workspace_path_state(P)` whose non-workspace scope does not cover `P`.

The exact/subtree coverage result must rebuild deterministically from canonical definitions.

### AC-10-07

Add the histories in §10 and prove that a later direct change to `P` cannot leave a current satisfaction merely because the obligation's accepted scope omitted `P`—because such an obligation cannot become canonical in the first place.

### AC-10-08

Completion relies only on obligations whose definitions passed predicate/scope compatibility validation at creation and whose current satisfaction/waiver generation equals the current `subjectGeneration`.

---

## 12. Corrected final freshness recommendation

Where this correction changes the earlier documents, the v1 freshness contract is now:

```text
VerificationFreshnessScopeV1
  = workspace
  | paths(non-empty bounded entries)

entry
  = exact(normalized path)
  | subtree(normalized root)
```

with these invariants:

1. no empty path scope;
2. no hidden evergreen/`none` scope;
3. deterministic normalized exact/subtree segment-boundary overlap;
4. `workspace_path_state(P)` must be paired with `workspace` or a path entry that covers `P`;
5. unknown/incomplete impact remains fail-closed;
6. per-obligation `subjectGeneration` remains the sole Program verification freshness authority.

These rules narrow the accepted contract; they do not add a new subsystem or general path-pattern language.
