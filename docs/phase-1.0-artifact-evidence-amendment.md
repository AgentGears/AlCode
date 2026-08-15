# ALCODE Phase 1.0 — Artifact Evidence Planning Amendment

**Status:** DRAFT — amendment to the current Phase 1.0 working plan; not approved; not frozen; implementation not authorized  
**Planning base:** `main` at `09ef2bd2bc8901b6c62dc9e579df178b4d433631`  
**Amends:** `docs/phase-1.0-plan.md`  
**Basis:** `docs/phase-1.0-artifact-seam-validation.md`

> This amendment promotes only the artifact semantics proven necessary for correctness of the existing Phase 1.0 proposal. It does not add rendering, multimodal inspection, an artifact tool-result protocol, a renderer, Mermaid support, or a new AC-10 family. Phase 1.0 remains a draft planning proposal until explicit approval.

## 1. Amendment effect

The Phase 1.0 working plan is amended by the following two semantic invariants and their associated acceptance-proof clarifications:

1. **Artifact identity is not evidence admission.** A retained content-addressed Host artifact may support ProgramState evidence only through Host-admitted canonical provenance/correlation. Artifact existence, successful resolution, digest equality, or an Agent reference to the artifact does not by itself make the artifact current evidence, satisfy verification, complete work, or satisfy the Completion Oracle.
2. **Artifact-backed evidence uses ProgramState verification freshness.** Artifact-backed verification evidence is indexed by the same verification subject generation/freshness rule as every other verification evidence source. Continued existence of the same ArtifactRef, or reproduction of identical bytes, cannot carry verification satisfaction across a relevant subject-generation change.

These invariants are part of the current Phase 1.0 working planning set from this amendment onward. They remain amendable until Phase 1.0 is explicitly approved and frozen.

Where this document narrows or clarifies the corresponding artifact/evidence language in `docs/phase-1.0-plan.md`, this amendment controls until the plan is consolidated.

## 2. Governing invariant — artifact identity is not evidence admission

Phase 1.0 already distinguishes Host artifacts, canonical evidence, ProgramAttempt validity, verification satisfaction, and Host-only completion. This amendment makes the authority boundary explicit.

The required relationship is:

```text
HostArtifactStore
  → retained bytes + content identity

canonical operation/evidence correlation
  → how/when/by which ProgramAttempt the artifact became an observed result

ProgramState verification admission
  → whether that evidence satisfies a current obligation

Completion Oracle
  → whether current canonical predicates permit terminal completion
```

The following implication is forbidden:

```text
ArtifactRef resolves
=> current ProgramState evidence
```

Instead:

```text
ArtifactRef resolves
AND canonical provenance/evidence is admissible for current ProgramState/ProgramAttempt state
AND any required verification predicate is satisfied for the current subject generation
=> artifact-backed evidence may contribute to ProgramState decisions
```

An ArtifactRef therefore remains an evidence/provenance input, not an authority that can mutate ProgramState or satisfy an obligation by its existence alone.

### 2.1 Stale ProgramAttempt rule

If Attempt A produces or references ArtifactRef `R`, and Attempt A is later interrupted, superseded, or otherwise no longer current, `R` does not become current evidence merely because the bytes remain retained and resolvable.

Example:

```text
Attempt A current
→ operation O1 produces ArtifactRef R
→ Attempt A interrupted
→ Attempt B becomes current
→ late result/proposal from A references R
```

Required result:

```text
R may remain a valid content-addressed artifact
but
A's stale provenance cannot become current ProgramState evidence automatically
```

Any reuse of `R` must occur through an explicit Host admission path that is valid under the current ProgramState, current ProgramAttempt where applicable, and current verification state.

### 2.2 Crash-before-evidence rule

Artifact retention and canonical evidence admission are separate facts.

Example:

```text
capability execution computes bytes B
→ HostArtifactStore retains ArtifactRef R
→ Host crashes before canonical terminal operation/evidence admission
→ Host reopens
```

Required result:

```text
R may physically resolve
but
ProgramState cannot infer that the interrupted operation completed successfully
and
R cannot satisfy verification or completion merely from store presence
```

Recovery/reconciliation must establish whatever canonical operation/evidence facts are required before the artifact can be relied upon.

### 2.3 Same bytes, different provenance

Content addressing intentionally permits identical bytes to share one ArtifactRef.

Therefore:

```text
Attempt A → bytes B → ArtifactRef R
Attempt B → bytes B → ArtifactRef R
```

means one content identity with two potentially different execution/provenance histories. ProgramState correctness must depend on the admitted current evidence chain, not on the uniqueness of `R`.

This is why ProgramAttempt/provenance ownership must not be embedded as the unique identity of the content-addressed blob.

## 3. Governing invariant — artifact-backed evidence shares verification freshness

Artifact evidence does not introduce an artifact-specific freshness system.

If verification obligation `V` is satisfied using artifact-backed evidence for subject generation `G1`, a relevant later mutation that advances the verification subject to `G2` makes that satisfaction non-current according to the same rules as non-artifact evidence.

Required relationship:

```text
subject generation G1
→ ArtifactRef R admitted as part of evidence E1
→ V satisfied for G1

relevant mutation
→ subject generation G2

R remains retained and byte-identical
but
V is stale for G2
```

Content-addressed persistence preserves historical identity. It does not preserve current verification relevance.

### 3.1 Identical output at a new generation

A fresh verification at `G2` may produce bytes identical to an older result:

```text
G1 → operation O1 → bytes B → ArtifactRef R → evidence E1 → V satisfied
→ relevant mutation → G2 → V stale
→ operation O2 at G2 → bytes B → ArtifactRef R
```

The reused ArtifactRef does not itself restore satisfaction.

Only a fresh Host-admitted evidence/provenance chain associated with the current verification subject can restore `V`:

```text
O2 / current state
→ canonical evidence E2
→ Host evaluates current predicate
→ V satisfied for G2
```

This preserves one freshness authority: ProgramState verification state.

## 4. `artifact_present` CompletionCriterion clarification

The proposed Phase 1.0 `CompletionCriterion` currently includes:

```ts
{ kind: "artifact_present"; handle: string }
```

For Phase 1.0, this criterion has a deliberately narrow meaning:

> `artifact_present` means only that the specified Host artifact is present/resolvable according to the deterministic artifact-presence predicate defined by the final contract.

It does **not** mean that:

- an Agent inspected the artifact;
- the artifact is visually correct;
- the artifact is semantically correct;
- a verification obligation concerning the artifact is satisfied;
- the artifact is current evidence for a ProgramAttempt merely because it exists.

If correctness requires verification, that requirement must be represented separately by the applicable verification obligation or other closed CompletionCriterion.

This distinction prevents `artifact_present` from becoming an implicit inspection or semantic-verification bypass.

## 5. AC-10-06 amendment — artifact provenance and stale-attempt negatives

The existing AC-10-06 remains **Effect uncertainty and durable attempt correlation**. No new acceptance criterion is added.

Its proof target is extended with the following artifact-specific negative cases.

### AC-10-06-A — stale-attempt artifact remains non-current

```text
Attempt A current
→ attempt-originated operation produces ArtifactRef R
→ canonical correlation binds R/evidence to A
→ A interrupted or superseded
→ Attempt B current
→ R still resolves
→ late A result or Agent proposal references R
```

Required proof:

```text
R does not become current ProgramState evidence from existence or late reference
→ stale ProgramAttempt correlation is respected
→ no work completion / verification satisfaction / Completion Oracle success is admitted from A's stale result
```

Explicit current-state Host reconciliation/admission is required before any reuse.

### AC-10-06-B — orphan retained artifact is not successful operation evidence

```text
operation under current Attempt A produces bytes
→ HostArtifactStore retains R
→ Host crashes before canonical terminal operation/evidence admission
→ reopen/recovery
```

Required proof:

```text
R may resolve
→ operation/evidence state remains whatever canonical recovery proves
→ ProgramState does not infer successful evidence from artifact-store presence
```

This composes with existing uncertainty/reconciliation semantics rather than creating an artifact-specific recovery doctrine.

## 6. AC-10-07 amendment — artifact freshness negatives

The existing AC-10-07 remains **Durable verification freshness**. No artifact-specific freshness AC or gate is added.

Its required proof corpus is extended with the following cases.

### AC-10-07-A — retained ArtifactRef cannot cross a subject-generation change

```text
verification V satisfied with artifact-backed canonical evidence E1 / ArtifactRef R at G1
→ relevant mutation
→ verification subject becomes G2
→ R remains byte-identical and resolvable
```

Required proof:

```text
V is stale/non-current at G2
→ Completion Oracle rejects any dependency on V
→ R's continued existence does not restore satisfaction
```

### AC-10-07-B — identical bytes require fresh current evidence

```text
V stale at G2
→ fresh verification operation runs for G2
→ operation produces the same bytes as G1
→ content-addressed store returns the same ArtifactRef R
```

Required proof:

```text
R alone does not restore V
→ a new canonical evidence/provenance admission for the G2 verification is required
→ only Host acceptance of current evidence may make V current again
```

### AC-10-07-C — projection rebuild preserves the distinction

After reopen/rebuild, the same canonical log plus the same retained artifact bytes must reconstruct the same verification result:

```text
old satisfaction at G1
+ later invalidating mutation to G2
+ ArtifactRef R still resolvable
→ rebuilt ProgramState still represents V as stale at G2
```

Artifact-store availability cannot override canonical verification freshness during projection rebuild.

## 7. Scope boundary — inspection remains deferred

The validation study also established two correct future constraints that are **not promoted into the Phase 1.0 implementation obligation by this amendment**:

- explicit canonical proof of inspection delivery when Agent inspection is actually relied upon;
- fail-closed behavior when a required inspection path is unavailable or unsupported.

Those constraints become mandatory when a later approved implementation introduces inspection-dependent verification.

Phase 1.0 therefore does not, by this amendment, require:

- `artifact_ref_v1` or `artifact_inspection_v1` protocol implementation;
- non-text tool-result content;
- Agent image/media ingestion;
- a canonical inspection-delivery event or receipt;
- rendering or rasterization;
- `diagram.validate`, `diagram.render`, `artifact.inspect`, or export tooling;
- Mermaid or another diagram dialect;
- browser rendering;
- provider-specific media encoding.

The current `context.projection_compiled` receipt must not be treated as inspection-delivery proof. It proves the Host's compiled context decision, not successful transport/model ingestion.

## 8. No new Phase 1.0 acceptance surface

This amendment deliberately modifies existing Phase 1.0 semantics rather than creating a separate artifact subsystem.

The acceptance mapping is:

```text
artifact provenance / stale-attempt correctness
→ AC-10-06

artifact-backed verification freshness
→ AC-10-07

artifact_present interpretation
→ existing closed CompletionCriterion / AC-10-08 evaluation
```

No new `AC-10-12` or artifact-specific gate family is introduced.

The proposed `gate:1.0` shape therefore remains unchanged. The existing operation-correlation, verification-freshness, reducer/rebuild, and completion-linearization gates must cover the added negative cases if implementation is later approved.

## 9. Consolidation rule

Before Phase 1.0 is approved/frozen, the working plan should eventually be consolidated so that the promoted text is incorporated directly into `docs/phase-1.0-plan.md` and this amendment can remain as design history.

Until that consolidation:

```text
docs/phase-1.0-plan.md
+ this amendment
= current Phase 1.0 working planning contract on artifact evidence/freshness
```

This amendment does not approve the Phase 1.0 plan, does not freeze any AC-10 criterion, and does not authorize implementation.
