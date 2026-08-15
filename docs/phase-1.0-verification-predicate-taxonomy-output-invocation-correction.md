# Phase 1.0 Verification Predicate Taxonomy — Artifact Production Invocation Correction

**Status:** incorporated correction to PR #42 verification-predicate taxonomy study  
**Approval:** non-normative planning only; not approved; not frozen; implementation not authorized

**Precedence:** this correction controls wherever `docs/phase-1.0-verification-predicate-taxonomy-output-binding-correction.md` treats producer work identity plus Host output contract/channel as sufficient to bind a required artifact slot.

It does not amend the governing Phase 1.0 plan or authorize implementation.

---

## 1. Problem

A work item may invoke the same Host operation/output contract more than once.

Example:

```text
W-build current attempt
  → call C-v1(args = debug)   → channel package → ArtifactRef D
  → call C-v1(args = release) → channel package → ArtifactRef R
```

If `S-release` is defined only by:

```text
producer work = W-build
Host contract = C-v1
output channel = package
```

then both `D` and `R` satisfy the slot-binding checks even though only the release invocation is the intended producer.

Phase 1 explicitly permits one ProgramAttempt to execute multiple correlated capability operations, so this is not an artificial history.

The immutable slot binding therefore needs to identify the required **production invocation/step**, not only the surrounding work item and output channel.

---

## 2. Introduce a stable creation-time production-step identity

The Program creation contract should be able to define an immutable bounded production step for every artifact output slot that is intended to carry terminal verification authority.

Illustrative shape:

```ts
type ProgramArtifactProductionStepId = Branded<"ProgramArtifactProductionStepId">;

interface ProgramArtifactProductionStepV1 {
  productionStepId: ProgramArtifactProductionStepId;
  workItemId: ProgramWorkItemId;
  operation: HostOperationInvocationSpecV1;
}

interface HostOperationInvocationSpecV1 {
  hostOperationContractId: HostOperationContractId;
  hostOperationContractVersion: number;
  args: unknown;
  argsDigest: string;
}

interface ProgramOutputSlotV1 {
  outputSlotId: ProgramOutputSlotId;
  productionStepId: ProgramArtifactProductionStepId;
  outputChannel: HostOutputChannelId;
}
```

Exact type names/normalization placement remain implementation design.

The semantic invariant is:

> **A terminally relevant artifact output slot identifies one immutable Host-defined production invocation specification plus one Host-defined output channel. Runtime evidence cannot satisfy the slot merely because it came from the right work item or the right contract family.**

---

## 3. Production step is semantic Program contract, not a runtime operation ID

The production-step identity exists before execution.

It is not:

```text
operationId
ProgramAttemptId
Agent request ID
provider generation ID
```

Those are runtime provenance.

The production step instead says what concrete Host operation invocation is eligible to produce the required output:

```text
stable Host operation contract identity/version
+ canonical bounded arguments
+ canonical args digest
```

A later `operationId` may claim/correlate to that step only after Host admission verifies the exact immutable spec.

---

## 4. Share the same exact-invocation authority model as `operation_result`

The verification taxonomy already requires `operation_result` to use a stable versioned Host verification-operation contract plus exact canonical invocation arguments.

Artifact production should not create a weaker parallel rule.

Where practical, consolidation may normalize both concepts through one reusable immutable creation-time structure such as:

```text
HostOperationInvocationSpecV1
```

with:

- Host-defined contract identity/version;
- canonical bounded arguments;
- deterministic argument digest;
- no runtime operation ID.

`operation_result` uses that spec to decide which operation result can satisfy a verification predicate.

`artifact_present` uses a production step containing that spec plus a Host-defined output channel to decide which artifact output can bind the logical slot.

The exact storage normalization is implementation design; equality semantics must be the same.

---

## 5. Runtime operation admission binds the operation to the production step only after exact validation

An Agent may request:

```text
productionStepId = S
operation contract/args = ...
```

but the step identity is not trusted by assertion.

Before the Host admits the Program-linked root `operation.requested`, or in the same canonical admission cut that creates that root, it verifies:

```text
S exists in immutable Program contract
S.workItemId == current ProgramAttempt.workItemId
current ProgramAttempt / Program revision / Agent generation ownership is exact
requested Host operation contract identity/version == S.operation contract identity/version
canonical requested args == S.operation.args
args digest == S.operation.argsDigest
ordinary capability policy/authorization allows execution
```

Only then may canonical operation history record the mechanically lossless production-step correlation.

A request that names the right step ID but different args is rejected as a step mismatch; it may still be executed later as an ordinary operation if separately authorized, but it cannot acquire that production-step authority.

---

## 6. Canonical output binding now requires step correlation plus output channel

A concrete ArtifactRef `R` may bind output slot `O` only when canonical history proves:

```text
O exists in immutable Program contract
O.productionStepId == canonical producing operation's admitted productionStepId
producing operation's persisted Host contract/version/args satisfy that production step
artifact was emitted on O.outputChannel under that Host output contract
artifact relation is output
current ProgramAttempt/evidence ownership is admissible or explicitly current-reconciled
ArtifactRef resolves/integrity passes
current verification subjectGeneration matches the satisfaction being admitted
execution-base/effect/quiescence requirements hold
```

This is stronger than checking work item + contract + channel.

---

## 7. Debug/release example

Creation:

```text
step P-debug:
  contract = host-package-build-v1
  args = { mode: debug }

step P-release:
  contract = host-package-build-v1
  args = { mode: release }

slot S-release:
  productionStepId = P-release
  channel = package
```

Runtime:

```text
operation O1 claims P-debug
Host verifies args={mode:debug}
→ channel package → ArtifactRef D

operation O2 claims P-release
Host verifies args={mode:release}
→ channel package → ArtifactRef R
```

Required result:

```text
D cannot bind S-release
R may bind S-release
```

The two artifacts may share work item, Host contract and output channel. The immutable production-step/invocation identity distinguishes them.

---

## 8. Same exact production step may execute again after interruption/retry

The production step is a logical specification, not a one-shot operation identity.

Across fresh ProgramAttempts:

```text
Attempt A executes step P-release → operation O1 → ArtifactRef R1
A becomes stale/interrupted
Attempt B executes same immutable step P-release → operation O2 → ArtifactRef R2
```

Both operations remain historical.

Only current admissible/reconciled evidence for the current verification generation may satisfy `artifact_present(S-release)`.

Thus the step is reusable as a specification across attempts while runtime operation/evidence currentness still prevents stale artifact reuse.

---

## 9. Multiple identical invocations within one current attempt

If the same exact production-step specification is executed more than once within one current attempt, each operation is semantically an execution of the same creation-time production requirement.

For v1, the slot remains **singularly satisfied by one decisive current canonical output binding** selected/admitted by the Host from predicate-matching evidence.

The Agent cannot choose a non-matching invocation, but more than one matching execution may exist.

If a future use case requires distinguishing two executions that have identical Host contract, arguments and output channel within the same work item, that distinction must be represented by two distinct immutable production-step definitions with an additional Host-enforced step discriminator/sequencing contract. Do not infer semantic identity from runtime call order.

The first slice does not use “first operation”, “last operation”, or arbitrary sequence number as hidden terminal semantics.

---

## 10. Provider replacement remains behind the Host operation contract

The previous correction remains unchanged:

```text
provider-specific execution/result
→ stable Host operation/output adapter contract
→ Host-validated exact invocation + output channel
→ canonical production-step/output provenance
```

The production-step spec does not use a raw plugin/MCP tool name as replay authority.

If the current provider cannot execute or map the stable Host operation contract safely, the required production step remains unavailable/unsatisfied; the provider cannot silently reinterpret it.

---

## 11. Creation-time support and bounds

At Program creation/admission, the Host validates:

```text
productionStepId unique and bounded
referenced workItemId exists
Host operation contract/version supported
arguments canonicalizable and within approved bounds
argsDigest matches canonical arguments
output slot references an existing production step
output channel is valid/singular for that production step's Host contract/version
```

Host policy may reject unsafe or unsupported production steps before Application acceptance/canonical creation.

Structural-bound measurement will determine exact count/argument-size ceilings; this study requires finite deterministic limits.

---

## 12. Replay/rebuild

Canonical Program history preserves immutable production-step definitions and output-slot definitions.

Canonical operation/evidence history preserves the step correlation and Host operation/output contract provenance for each eligible artifact-producing execution.

Rebuild therefore computes the same binding relation without:

```text
rerunning the operation
consulting current provider registry
trusting Agent labels
inferring from operation order
```

---

## 13. Required negative proofs

### 13.1 Wrong invocation, same work/contract/channel

```text
S-release requires P-release args={mode:release}
→ current operation uses same contract/channel but args={mode:debug}
→ Agent labels output as S-release
```

Required:

```text
production-step mismatch
→ no S-release binding
→ no artifact satisfaction
```

### 13.2 Right step ID, wrong args

```text
Agent requests productionStepId=P-release
but sends args={mode:debug}
```

Required:

```text
Host rejects production-step correlation at operation admission
→ runtime assertion cannot rewrite immutable step spec
```

### 13.3 Correct invocation and channel

```text
operation admitted against P-release exact spec
→ Host-derived channel=package
→ ArtifactRef R current/provenance-valid
```

Required:

```text
R may bind S-release
```

### 13.4 Old attempt runs exact step

```text
Attempt A exact P-release → R1
→ A interrupted
→ Attempt B current
```

Required:

```text
R1 remains historical but cannot satisfy current generation merely because production-step identity matches
```

---

## 14. Acceptance-proof consequences

If later consolidated:

### AC-10-02

Prove production-step and output-slot definitions deterministically rebuild and contain immutable exact Host operation invocation semantics.

### AC-10-04 / AC-10-06

Prove root operation admission cannot claim a production step with the wrong contract/version/arguments, and stale-attempt exact-step output does not become current evidence.

### AC-10-07

Artifact satisfaction for current `subjectGeneration` requires decisive evidence from an operation canonically correlated to the exact immutable production step and output channel.

### AC-10-08

Completion through artifact-backed satisfaction relies only on an ArtifactRef bound through the exact production-step/output-slot contract, then applies the existing terminal ArtifactStore recheck. Current waiver remains the independent evidence-free acceptance path.

---

## 15. Corrected final artifact slot model

Where this correction changes earlier PR #42 documents, the conceptual model is:

```ts
interface ProgramArtifactProductionStepV1 {
  productionStepId: ProgramArtifactProductionStepId;
  workItemId: ProgramWorkItemId;
  operation: HostOperationInvocationSpecV1;
}

interface ProgramOutputSlotV1 {
  outputSlotId: ProgramOutputSlotId;
  productionStepId: ProgramArtifactProductionStepId;
  outputChannel: HostOutputChannelId;
}

interface ArtifactPresentPredicateV1 {
  kind: "artifact_present";
  outputSlotId: ProgramOutputSlotId;
}
```

with:

```text
HostOperationInvocationSpecV1
= stable Host operation contract identity/version
+ exact canonical bounded args
+ deterministic args digest
```

The semantic invariant is:

> **A required artifact is identified before execution by an immutable logical output slot whose producer is one exact Host-defined production invocation/step and one Host-defined output channel. Runtime operation IDs and ArtifactRefs prove executions of that requirement; they never define or retarget the requirement.**
