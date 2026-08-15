# Phase 1.0 Verification Predicate Taxonomy — Terminal Artifact Correction

**Status:** incorporated correction to PR #42 verification-predicate taxonomy study  
**Approval:** non-normative planning only; not approved; not frozen; implementation not authorized

**Precedence:** this correction controls wherever the earlier PR #42 study/corrections imply that an `artifact_present` obligation must have a live bound ArtifactRef at the Completion Oracle cut even when the obligation is being accepted through a current explicit waiver.

It does not amend the governing Phase 1.0 plan or authorize implementation.

---

## 1. Problem

The selected verification model intentionally makes these two terminally acceptable states distinct:

```text
current satisfaction for current subjectGeneration
OR
current authorized waiver for current subjectGeneration
```

For an `artifact_present` obligation, the satisfaction path has decisive output-slot evidence and a concrete ArtifactRef. The waiver path means the authorized caller explicitly accepts proceeding **without** that required verification evidence for the current generation.

Therefore this unconditional wording is incorrect:

```text
artifact_present obligation
→ Completion Oracle always re-resolves a bound ArtifactRef
```

A valid waiver may exist before any artifact was ever bound to the required output slot. Requiring a live ArtifactRef in that case would silently make artifact obligations non-waivable and contradict the general waiver contract.

---

## 2. Correct terminal rule

At the Completion Oracle cut, evaluate each verification obligation through exactly one current acceptance path:

```text
A. current satisfaction path
   satisfaction.verifiedGeneration == obligation.subjectGeneration

OR

B. current waiver path
   waiver.waivedGeneration == obligation.subjectGeneration
```

For `artifact_present`, the live ArtifactStore resolution/integrity recheck applies **only to path A**, because only path A claims that a concrete retained artifact proves the predicate.

Conceptually:

```text
artifact obligation accepted by current satisfaction
→ resolve the ArtifactRef decisively bound to the required ProgramOutputSlotId
→ verify regular retained artifact + content-address integrity
→ failure blocks program.completed

artifact obligation accepted by current waiver
→ do not require or invent an ArtifactRef binding
→ validate current waiver authority/generation
→ the predicate remains false/unsatisfied, but the obligation is terminally acceptable by explicit authorization
```

This does not weaken artifact evidence. It preserves the distinction between evidence-backed satisfaction and authority-backed waiver.

## 3. A waiver does not create artifact evidence

The Host must not synthesize any of the following from a waiver:

```text
ArtifactRef
output-slot binding
artifact evidence record
predicate success
```

The durable state continues to say, semantically:

```text
artifact requirement V is not satisfied
but V is explicitly waived for current generation G
```

If the Program projection exposes verification state, `waived` remains distinguishable from `satisfied`.

## 4. Relevant later mutation still expires the waiver

The earlier generation-indexing correction remains unchanged:

```text
waiver.waivedGeneration == current subjectGeneration
```

A relevant mutation that advances the artifact obligation from G1 to G2 makes the G1 waiver historical. Completion then requires either:

```text
fresh artifact-backed satisfaction at G2
OR
fresh explicit waiver at G2
```

No terminal ArtifactRef check occurs merely because the stale G1 history once contained an artifact or waiver.

## 5. Required histories

### 5.1 Waive before any artifact exists

```text
V-package = artifact_present(S-package) at G1
→ no ArtifactRef has ever been bound to S-package
→ authorized Application waiver records waivedGeneration = G1
→ all other Completion Oracle predicates become true
```

Required result:

```text
V-package accepted through current waiver
→ no ArtifactRef lookup required for V-package
→ absence of artifact evidence does not defeat the waiver
```

### 5.2 Satisfied artifact disappears before completion

```text
V-package satisfied at G1 by slot binding S-package → ArtifactRef R
→ R becomes unavailable/corrupt before terminal completion
→ no current waiver exists
```

Required result:

```text
Completion Oracle takes satisfaction path
→ live ArtifactStore recheck of R fails
→ program.completed rejected
```

### 5.3 Artifact satisfaction exists, then current waiver is issued

```text
V-package had current satisfaction backed by R
→ authorized current waiver for same generation is also admitted under final command rules
→ R later unavailable before completion
```

The terminal authority model must choose the explicit current acceptance state deterministically. The simplest Phase 1 reducer/read-model rule is:

```text
current waiver makes the obligation acceptable through waiver path
```

and therefore does not require R to remain present for terminal acceptance.

If implementation instead models satisfaction and waiver as concurrent facts, the Completion Oracle still accepts the obligation when **either** valid path holds; it must not force the satisfaction-path ArtifactRef recheck when a valid current waiver independently authorizes completion.

### 5.4 Waiver becomes stale

```text
V-package waived at G1
→ relevant mutation advances V-package to G2
```

Required result:

```text
G1 waiver non-current
→ no artifact-backed G2 satisfaction
→ Completion Oracle rejects
```

---

## 6. Acceptance-proof consequence

If later consolidated, AC-10-08 should prove both branches explicitly:

```text
artifact_present + current satisfaction
→ decisive current-generation output-slot evidence exists
→ terminal ArtifactRef resolution/integrity rechecked
```

and:

```text
artifact_present + current generation waiver
→ no ArtifactRef required
→ waiver authority/generation is revalidated
→ obligation may be terminally acceptable without pretending the artifact exists
```

A waiver must never be projected or replayed as predicate satisfaction.

---

## 7. Corrected recommendation

The final PR #42 recommendation is therefore:

> **Live terminal artifact re-resolution is a condition on artifact-backed satisfaction, not a condition on an artifact obligation accepted by current explicit waiver.**

All output-slot identity, ArtifactRef provenance, subject-generation freshness, stale-attempt rejection, and ArtifactStore integrity rules from the earlier study/corrections remain unchanged.
