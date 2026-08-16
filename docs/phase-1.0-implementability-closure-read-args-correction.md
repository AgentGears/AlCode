# Phase 1.0 Implementability Closure — Planning Read Argument Correction

**Status:** incorporated correction to the Phase 1.0 implementability-closure amendment; not approval; not freeze; implementation not authorized  
**Base amendment:** `docs/phase-1.0-implementability-closure-amendment.md`  
**Reason:** exact-head implementability review found that a sealed planning dependency containing only an argument digest cannot reconstruct the exact read after Host restart before first dispatch.

## 1. Precedence

This correction controls wherever §9.2/§9.5 and I9/I10 of the implementability-closure amendment imply that `canonicalArgsDigest` alone is sufficient durable input for later planning-base recheck.

The exact candidate represented by PR #46 is therefore the governing Phase 1.0 base contract plus the implementability-closure amendment plus this correction. Nothing here approves/freezes Phase 1.0 or authorizes implementation.

## 2. Corrected durable planning-read dependency

The sealed `PlanningObservationIdentity` must retain the **bounded canonical arguments required to re-execute every planning read**, not only their digest.

The semantic shape is corrected to:

```ts
interface PlanningReadDependencyV1 {
  readContractId: string;
  readContractVersion: number;

  // Exact bounded canonical invocation value required for replay/recheck.
  canonicalArgs: JsonValue;
  canonicalArgsDigest: string;

  canonicalResultDigest: string;
  coverageIdentity: string;
  providerBindingRevision?: string;
}
```

`canonicalArgsDigest` remains useful as immutable identity/integrity material; it does **not** replace the canonical arguments themselves.

A Host planning read contract defines a finite canonical argument schema and byte limit. Admission rejects an argument value that cannot be represented completely under that contract. The canonical arguments are sealed into durable planning provenance and count toward its bounded serialized representation; they are not reconstructed from Agent text, transcript history, model output, or a hash preimage.

A future implementation may replace inline `canonicalArgs` with an immutable durable content/reference form only if the reference is itself canonical Program-creation provenance, resolves without mutable external state, has the same boundedness/integrity semantics, and deterministically yields the exact canonical invocation value. A transient cache key or current provider lookup is insufficient.

## 3. Corrected recheck procedure

Before canonical Program creation and before first ProgramAttempt dispatch, the Host rechecks each sealed dependency using the durable canonical invocation value:

```text
for every sealed PlanningReadDependencyV1:
  load the exact persisted canonicalArgs
  verify canonicalDigest(canonicalArgs) == canonicalArgsDigest
  invoke the exact readContractId/readContractVersion with canonicalArgs
  under the required coverage/provider identity semantics
  → canonicalize the complete result
  → compare current canonicalResultDigest with the sealed digest

all args integrity + result/provenance comparisons equal
→ dependency recheck passes

missing/unresolvable/malformed/over-bound canonicalArgs
OR args digest mismatch
OR result/provenance mismatch
OR incomplete/unknown read
→ planning base stale/unavailable
→ creation/first dispatch fails closed
```

Restart therefore needs no pre-crash process memory to reproduce the first-dispatch recheck.

## 4. Crash/rebuild proof

Required history:

```text
planning readContract=file.read.v1 with canonicalArgs { path: "a" }
→ Host stores canonicalArgs + canonicalArgsDigest + result digest in sealed Bplan
→ Program is created
→ Host crashes before first ProgramAttempt dispatch
→ all process memory/cache is lost
→ reopen rebuilds Program creation provenance
→ exact canonicalArgs { path: "a" } are available from canonical state
→ Host re-executes file.read.v1
→ equality permits first-dispatch bridge; difference/unknown blocks it
```

Forbidden history:

```text
sealed dependency contains only hash(args)
→ restart
→ Host guesses/reconstructs path/query from transcript/model/current cache
```

That is not deterministic rebuild and is not Phase 1.0 compliant.

## 5. Retest consequence

I9 and I10 are strengthened:

```text
I9 planning read result changes between proposal and creation/first dispatch
   → exact durable canonicalArgs allow the read to be re-executed after restart
   → changed result/provenance makes Bplan stale

I10 sealed planning dependency loses its transient pre-crash read state
   → canonicalArgs remain reconstructible from canonical provenance
   → Host never requires a hash preimage/current cache/model transcript to recheck
```

All other implementability-closure decisions remain unchanged.