# Phase 1.0 Verification Predicate Taxonomy — Artifact Output Binding Correction

**Status:** incorporated correction to PR #42 verification-predicate taxonomy study  
**Approval:** non-normative planning only; not approved; not frozen; implementation not authorized

**Precedence:** this correction controls wherever the earlier PR #42 study/corrections define a `ProgramOutputSlotId` only by slot identity plus producer work item, or otherwise allow an Agent/tool-supplied slot label to decide which concrete artifact satisfies the slot.

It does not amend the governing Phase 1.0 plan or authorize implementation.

---

## 1. Problem

The first artifact correction correctly replaced this ambiguous predicate:

```text
artifact_present(producedByWorkItemId)
```

with a stable creation-time logical output slot.

However, a slot shaped only as:

```ts
interface ProgramOutputSlotV1 {
  outputSlotId: ProgramOutputSlotId;
  producerWorkItemId: ProgramWorkItemId;
}
```

still does not tell the Host how to distinguish two artifacts emitted by the same work item.

Example:

```text
W-build
  ├─ log artifact L
  └─ package artifact P

S-package.producerWorkItemId = W-build
```

If the only runtime distinction is a tool/Agent assertion saying “P belongs to S-package”, the Host is trusting the same unverified semantic label that the correction intended to remove. If it refuses that label, it has no mechanical basis for binding either artifact.

Therefore a slot needs not only a stable logical identity but a stable **Host-owned output binding contract**.

---

## 2. Separate logical slot identity from mechanical output binding

Use two concepts:

```text
ProgramOutputSlotId
→ immutable logical deliverable identity inside the Program contract

ArtifactOutputBindingContractV1
→ immutable Host-defined rule that mechanically identifies which canonical artifact-bearing output channel is eligible to bind that slot
```

The ArtifactRef remains runtime content identity.

Conceptually:

```ts
type ArtifactOutputBindingContractV1 = {
  kind: "host_artifact_output";
  contractVersion: 1;
  operationContractId: string;
  outputChannel: string;
};

interface ProgramOutputSlotV1 {
  outputSlotId: ProgramOutputSlotId;
  producerWorkItemId: ProgramWorkItemId;
  binding: ArtifactOutputBindingContractV1;
}
```

Exact field names and branded types are implementation design. The authority model is not:

> **The Program creation contract must persist enough Host-defined, versioned output-binding semantics to let the Host mechanically decide whether a concrete canonical artifact output is eligible for a required slot without trusting an Agent/provider-supplied semantic slot label.**

---

## 3. `operationContractId` is a Host semantic contract, not a mutable plugin name

`operationContractId` in the illustration means a stable Host-defined operation/output contract family whose output semantics are versioned by ALCODE/Host protocol.

It is not equivalent to:

```text
toolName
plugin name
MCP server name
provider-defined result schema name
```

The same authority rule selected for `operation_result` applies here:

```text
replaceable provider output
→ stable Host adapter/operation contract
→ Host-derived canonical artifact output channel
→ slot binding eligibility
```

A raw dynamic provider that can arbitrarily call one result “package” and another “log” cannot directly decide which artifact satisfies `S-package`.

If no stable Host output contract can distinguish the required output, that artifact requirement cannot use `artifact_present` in the first slice.

---

## 4. Output channels are closed within the Host contract

The `outputChannel` illustration is not a globally extensible free-form role string.

For a particular Host output contract/version, the set and semantics of output channels are fixed by that contract.

Example conceptual Host contract:

```text
host-command-artifact-output-v1
  channels:
    primary_output
    diagnostic_output
```

or a more specific adapter:

```text
host-package-build-v1
  channels:
    package
    build_log
```

The exact set is implementation/product design for supported first-slice artifact-producing operations. The semantic requirement is that channel meaning is Host-defined/versioned and cannot be changed by a provider without changing the Host contract identity/version.

A Program creation draft may select from channels that the Host currently supports. It may not mint a new arbitrary channel string and thereby grant it terminal authority.

---

## 5. Canonical operation history must retain the output contract/channel fact

For replay and provenance, an artifact-bearing canonical operation/result/evidence chain that is eligible for slot binding must mechanically expose or resolve:

```text
operationId
ProgramStateId / ProgramAttemptId when scoped
stable Host operation/output contract identity + version
Host-derived output channel
ArtifactRef
output relation = output
source/result event identity
ordinary outcome/effect/quiescence provenance as applicable
```

The exact field placement may be root operation history, artifact-bearing durable result content, evidence history, or an equivalent lossless combination.

The key rule is:

> **Replay must not ask the current provider registry what an old artifact output meant.**

Historical binding eligibility is determined from the persisted Host contract/channel provenance admitted at the time.

---

## 6. Corrected slot-binding admission rule

A concrete ArtifactRef `R` may bind required slot `S` only when the Host can prove all of:

```text
S exists in immutable Program creation contract
current obligation predicate refers to S
S.producerWorkItemId matches the canonical producing work ownership
producing operation/evidence is admissible for current Program/Attempt or explicitly current-reconciled
persisted Host output contract identity/version == S.binding.operationContractId/version
persisted Host-derived output channel == S.binding.outputChannel
artifact relation is ordinary output, not inspection_representation
R resolves through HostArtifactStore and passes integrity checks
current obligation subjectGeneration is the generation being satisfied
all execution-base/effect/quiescence requirements for decisive evidence hold
```

An Agent message such as:

```text
slotId = S-package
artifactRef = L
```

is only a proposal. It cannot make the binding canonical when `L` came from a different Host output channel.

---

## 7. Work-item identity remains useful but is not enough by itself

The stable producer work item remains part of the slot contract because it prevents output from another work item from being substituted.

The complete eligibility key is therefore conceptually:

```text
producer work identity
+ Host output contract identity/version
+ Host-defined output channel
```

not merely:

```text
producer work identity
```

and not merely:

```text
Agent-selected slot ID
```

---

## 8. One operation may emit multiple channels deterministically

A single canonical operation may produce multiple ArtifactRefs.

Example:

```text
operation O under host-package-build-v1
→ channel package   → ArtifactRef P
→ channel build_log → ArtifactRef L
```

Then:

```text
S-package binding = (host-package-build-v1, package)
S-log     binding = (host-package-build-v1, build_log)
```

`P` can bind `S-package`; `L` cannot, even though both share the same producer work item and operation.

If two artifacts are emitted on the same channel and the Host contract does not define deterministic multiplicity/selection semantics, neither arbitrary “first” nor Agent choice may acquire terminal authority. The Host contract must either:

- define that the channel is singular; or
- define a bounded deterministic selector/index as part of its versioned semantics.

For the smallest Phase 1 contract, prefer **singular required output channels**.

---

## 9. Provider adapters may derive channels, providers do not authorize them

A provider adapter may parse provider-specific result data to produce a Host contract's output channels, but that adapter is part of the stable Host semantic boundary.

The architecture is:

```text
provider-specific result
→ Host-owned versioned adapter/contract validation
→ Host-derived channel + ArtifactRef canonical result
→ Program slot binding
```

not:

```text
provider/Agent says role = package
→ Host trusts label
→ slot satisfied
```

If adapter validation fails or the provider result cannot be mapped unambiguously, no binding is admitted.

---

## 10. Relationship to the artifact seam `relation`

The existing artifact seam's closed relation:

```text
output
inspection_representation
```

remains useful but has a different purpose.

It distinguishes ordinary produced output from a representation generated specifically for Agent inspection. It is intentionally too coarse to distinguish two ordinary outputs such as a package and a build log.

Therefore:

```text
relation
!=
Program output channel
```

Both may appear in canonical artifact-bearing content without creating duplicate authority:

- `relation` answers the generic artifact-seam role;
- Host output contract/channel answers which stable Program deliverable slot the output may bind.

---

## 11. Creation-time support validation

A Program cannot canonically require an arbitrary Host output contract/channel that the current Phase 1 implementation does not support.

At creation/admission, the Host validates:

```text
binding contract kind/version supported
operation/output contract identity known as Host-defined stable semantics
output channel valid for that exact contract/version
producer work item exists
slot IDs unique and bounded
```

Application acceptance confirms the exact semantic contract, but cannot turn an unsupported free-form channel into a Host-defined verifier.

A later Host upgrade must continue to interpret already-admitted contract versions for replay, or fail compatibility explicitly rather than reinterpret them.

---

## 12. Required histories

### 12.1 Log cannot satisfy package slot

```text
Program creation:
  S-package = W-build + host-package-build-v1/channel=package

current W-build operation:
  host-package-build-v1/channel=build_log → ArtifactRef L
```

Required result:

```text
producer work matches
but output channel does not
→ L cannot bind S-package
→ artifact_present(S-package) remains unsatisfied
```

### 12.2 Correct package binds

```text
same current producing operation/attempt
→ host-package-build-v1/channel=package → ArtifactRef P
→ P resolves/integrity passes
```

Required result:

```text
all binding facts match
→ Host may canonically bind P to S-package evidence
→ artifact_present(S-package) may satisfy current generation
```

### 12.3 Agent lies about slot

```text
canonical output says channel=build_log, ArtifactRef=L
→ Agent proposes { slotId: S-package, artifactRef: L }
```

Required result:

```text
Host compares canonical output contract/channel
→ mismatch
→ reject binding/satisfaction
```

### 12.4 Dynamic provider changes its labels

```text
provider generation P0 maps raw result through Host contract C-v1
→ Host derives channel package
→ provider replaced by P1
→ P1 emits arbitrary provider label "package" for a diagnostic artifact
```

Required result:

```text
provider label alone has no authority
→ Host C-v1 adapter/validation must independently derive eligible channel
→ if it cannot, no slot binding
```

### 12.5 Historical replay after provider replacement

```text
old canonical output recorded C-v1/channel=package → ArtifactRef R
→ provider registry later changes
→ projection deleted/rebuilt
```

Required result:

```text
replay consumes persisted C-v1/channel provenance
→ same historical slot-binding state
→ no current provider lookup required
```

---

## 13. Acceptance-proof consequences

If later consolidated:

### AC-10-02

Prove output-slot definitions rebuild with:

```text
slot ID
producer work item
stable Host output contract identity/version
Host-defined singular output channel
```

and reject unsupported/free-form binding contracts at creation.

### AC-10-04 / AC-10-06

Prove a stale attempt or wrong Host output channel cannot bind a required slot even when its ArtifactRef remains valid retained content.

### AC-10-07

Fresh current evidence must bind the correct slot/channel for the current `subjectGeneration`; same ArtifactRef from stale/wrong-channel evidence is insufficient.

### AC-10-08

Completion through artifact-backed satisfaction requires the decisive ArtifactRef to have been bound through the exact immutable slot binding contract, followed by the already-selected live terminal ArtifactStore integrity recheck.

A current explicit waiver remains the separate evidence-free acceptance path and does not require such a binding.

---

## 14. Corrected final artifact predicate model

Where this correction changes earlier PR #42 documents:

```ts
interface ProgramOutputSlotV1 {
  outputSlotId: ProgramOutputSlotId;
  producerWorkItemId: ProgramWorkItemId;
  binding: {
    kind: "host_artifact_output";
    contractVersion: 1;
    operationContractId: HostOperationContractId;
    outputChannel: HostOutputChannelId;
  };
}

interface ArtifactPresentPredicateV1 {
  kind: "artifact_present";
  outputSlotId: ProgramOutputSlotId;
}
```

Exact type spelling is illustrative.

The first-slice semantic invariant is:

> **A required artifact slot is mechanically bindable only through an immutable, versioned Host-owned output contract/channel that distinguishes the intended output from every other output of the same work item. Agent/provider labels are proposals/data, never slot-binding authority.**

This preserves the intentionally narrow `artifact_present` predicate without introducing a generic artifact query DSL.
