# Phase 1.0 Execution-Base Protocol Study — Review Corrections

**Status:** incorporated correction to `docs/phase-1.0-execution-base-protocol-study.md`  
**Approval:** non-normative planning only; not approved; not frozen; implementation not authorized  
**Applies to:** PR #41 execution-base protocol study and all later consolidation work that consumes it

This document records correctness corrections identified during review of the execution-base protocol study.

**Precedence:** where this correction conflicts with `docs/phase-1.0-execution-base-protocol-study.md`, this document controls. A later consolidation must use the corrected semantics below, not superseded wording in the initial study.

These corrections do not amend `docs/phase-1.0-plan.md`, change AC-10, approve/freeze Phase 1.0, or authorize implementation.

---

# 1. Persist WorkspaceAccessClass in immutable operation history

## 1.1 Problem

The study recommends:

```text
WorkspaceEffectGeneration
= replayable ordinal of first confirmed transitions
  of Host-classified Workspace-mutating operations
```

and introduces:

```ts
type WorkspaceAccessClass =
  | "none"
  | "read_only"
  | "may_write";
```

Current `operation.requested` persists `isReadOnly`, but not this Workspace-specific classification.

If rebuild asks the **current** capability registry what an old operation's Workspace access was, replay is not deterministic. Providers can be replaced, bindings can change, and a non-read-only operation can have Workspace access `none`.

## 1.2 Corrected invariant

> **Every operation admitted into the Phase 1 Workspace-effect protocol records its Host-authorized `WorkspaceAccessClass` in immutable canonical root operation history. Replay consumes that persisted request-time classification and never asks the current capability registry to reinterpret the historical operation.**

The natural location is `operation.requested`.

Illustrative shape:

```ts
interface OperationRequestedPayloadV2 {
  operationId: string;
  toolName: string;
  args: unknown;
  isReadOnly: boolean;
  workspaceAccessClass: "none" | "read_only" | "may_write";
  // see §2 for operation-local execution/quiescence provenance
}
```

Exact schema spelling/version is implementation design. The semantic requirement is not.

## 1.3 Request-time authority

The Host determines and persists the class from the then-authorized binding/policy contract:

```text
trusted binding => none
→ persist none

trusted binding => read_only
→ persist read_only

trusted binding => may_write
→ persist may_write

missing / malformed / untrusted Workspace classification
→ persist may_write conservatively
```

The Agent, tool result, later provider generation, or model output cannot rewrite it.

## 1.4 `WorkspaceAccessClass` is not `isReadOnly`

They answer different questions:

```text
isReadOnly
  generic operation/effect/policy semantics

WorkspaceAccessClass
  whether this operation can touch the Workspace environmental domain
```

Examples:

```text
network POST:
  isReadOnly = false
  workspaceAccessClass = none

repository grep:
  isReadOnly = true
  workspaceAccessClass = read_only

arbitrary shell:
  isReadOnly = false
  workspaceAccessClass = may_write
```

Do not mechanically derive the new field from `isReadOnly` for new Phase 1 operations.

## 1.5 Corrected generation reducer

```text
persisted workspaceAccessClass != may_write
→ never advances WorkspaceEffectGeneration

persisted workspaceAccessClass == may_write
AND operation effect has not reached confirmed
→ no advance

persisted workspaceAccessClass == may_write
AND operationId reaches canonical EffectStatus=confirmed for the first time
→ advance WorkspaceEffectGeneration exactly once
```

Replay uses canonical request/effect/reconciliation facts only.

It must not consult:

```text
current capability metadata
current plugin/provider registry
current Host policy
Agent assertions
watcher state
```

## 1.6 Legacy histories need a deterministic protocol origin

Pre-Phase-1 operation history lacks this field. Do not retrospectively classify legacy operations from current provider metadata.

Preferred activation sequence:

```text
recover existing durable state
→ resolve or surface every pre-existing mutation uncertainty required for safe activation
→ prove Host-mediated mutator quiescence under §3/§4
→ obtain complete current ExecutionObservationIdentity O0
→ canonically establish Phase 1 Workspace-execution baseline B0
→ define WorkspaceEffectGeneration G0 = 0 at B0
→ all later participating operation.requested events persist WorkspaceAccessClass
```

Illustrative event name:

```text
workspace.execution.baseline.established
```

The name is not selected here. Its meaning is limited:

> after required recovery/quiescence, the Host accepted complete observation O0 as the origin of the Phase 1 Workspace execution lineage.

It does not fabricate causal generations for operations that predate the protocol.

## 1.7 Rebuild proof

Required history:

```text
baseline B0, G0
→ O1 requested class none, effect confirmed
→ G0
→ O2 requested class may_write, effect indeterminate
→ G0
→ O2 reconciliation confirmed
→ G1
→ capability registry/provider replaced
→ delete projection + rebuild
→ still G1 without consulting replacement provider
```

Also:

```text
legacy operation before B0 lacks WorkspaceAccessClass
→ rebuild does not infer its class from current registry
→ baseline remains the generation origin
```

---

# 2. Persist the operation-local provider/quiescence contract used by recovery

## 2.1 Why WorkspaceAccessClass alone is insufficient

Mutation quiescence can depend on the execution provider incarnation that actually started an operation.

History:

```text
operation O starts through provider/binding generation P0
P0 permits a detached writer to outlive the Host/provider call
→ Host crashes
→ provider is replaced by P1
P1 guarantees Host-lifetime containment
```

Restart must not inspect P1 and conclude that O's old writer could not have survived. That would apply a new provider's containment semantics to an old operation.

The earlier capability-resolution validation deliberately did not require provider-generation provenance because no then-current acceptance predicate consumed it. This execution-base protocol adds such a consumer: **recovery/quiescence may need to reason about the provider incarnation and containment contract that actually owned O.**

Therefore operation-local provider provenance is now required for this narrow purpose.

This does **not** select a ProgramAttempt-wide provider snapshot.

## 2.2 Corrected invariant

> **A `may_write` operation persists the immutable Host-authorized execution/quiescence contract—and, where recovery or reconciliation can address a particular provider incarnation, that incarnation/binding identity—used when the operation starts. Restart/replay never substitutes the current provider's containment semantics for the historical operation's semantics.**

## 2.3 Minimal semantic shape

Illustrative root/request semantics:

```ts
type MutationContainmentContract =
  | "operation_scoped_containment"
  | "host_lifetime_containment"
  | "external_writer_may_survive";

interface WorkspaceExecutionBindingProvenance {
  contractVersion: 1;
  mutationContainment: MutationContainmentContract;
  providerBindingRevision?: string;
  providerGenerationId?: string;
}
```

Exact names and whether provider identity is one field or several remain implementation design.

The mandatory property is that every fact used later to prove historical quiescence is stable canonical operation provenance rather than mutable registry lookup.

## 2.4 Closed contract semantics

### `operation_scoped_containment`

The Host-authorized adapter guarantees that its explicit quiescence proof covers all Workspace-mutation-capable descendants/resources of that operation.

The operation still needs an actual quiescence proof; merely receiving a timeout/cancel outcome is not enough.

### `host_lifetime_containment`

The Host-authorized provider guarantees that any Workspace-mutation-capable execution resource created under the operation cannot survive the provider/Host containment lifetime identified by the persisted provenance.

On a later Host lifetime, recovery may use that **persisted historical contract** plus proof the relevant prior containment lifetime ended to establish quiescence.

### `external_writer_may_survive`

The provider contract admits that a mutation-capable writer may survive the caller/Host/provider lifetime.

Host restart alone cannot establish quiescence. Recovery needs provider-specific evidence or explicit authorized external recovery.

## 2.5 Missing/unknown contract fails closed

For a new Phase 1 `may_write` operation:

```text
missing / malformed / untrusted mutation-containment contract
→ treat as external_writer_may_survive
```

Do not optimistically infer containment from current implementation behavior.

## 2.6 Provider identity is operation-local, not Program authority

Persisting provider/binding provenance here does not collapse:

```text
ProgramState revision
ProgramAttemptId
operationId
provider generation
WorkspaceEffectGeneration
```

It simply lets recovery answer:

> which historical execution/containment contract governed operation O?

The operation remains O because of `operationId`; provider identity does not replace ProgramAttempt ownership.

## 2.7 Rebuild/replacement proof

```text
O requested under P0
workspaceAccessClass = may_write
mutationContainment = external_writer_may_survive
providerGenerationId = P0
→ Host crashes
→ current provider is P1 with host_lifetime_containment
→ rebuild
→ O still uses P0/external-survival semantics
→ restart cannot infer quiescence from P1
```

And the reverse:

```text
O requested under persisted host_lifetime_containment P0
→ P0 containment lifetime provably ends with Host/provider loss
→ P1 differs
→ recovery may establish O quiescent from the persisted P0 contract + ended-lifetime proof
→ no need to ask P1 what P0 meant
```

---

# 3. Effect certainty and mutation quiescence are separate

## 3.1 Problem

The initial study allowed wording equivalent to:

```text
retain environmental coordination until execution returns
OR
until the Host can durably classify the operation indeterminate
```

That `OR` is unsafe.

A timed-out/cancelled capability may:

```text
ignore cancellation
continue after the caller stops awaiting it
leave a child/grandchild process running
detach a writer
return an indeterminate outcome while later writes remain possible
```

`EffectStatus=indeterminate` answers whether the effect is known. It does not prove the writer stopped.

## 3.2 Corrected separation

Keep two independent state machines:

```text
Effect certainty
  confirmed | absent | indeterminate | not_applicable

Mutation quiescence
  unknown | proven_quiescent
```

Effect certainty is operation/effect authority.

Quiescence is the environmental safety property required before another Host mutator or stable reconciliation observation can cross the old writer's lifetime.

## 3.3 Release rule

> **A `may_write` operation's environmental exclusion/barrier may be released for ordinary/reconciliation use only after that operation's ability to produce further Workspace writes is proven quiescent under its persisted historical execution contract. Terminal outcome or effect classification alone is insufficient.**

Normal case:

```text
executor returns
AND Host adapter proves all mutation-capable descendants/resources quiescent
→ quiescence proven
```

Timeout case:

```text
timeout/cancel signalled
→ caller returns timed_out/cancelled
→ effect may be indeterminate or even already confirmed
→ descendant writer may still run
→ quiescence remains unknown
→ Workspace remains blocked
```

## 3.4 Evidence that is not quiescence proof by itself

None of these alone is enough:

```text
AbortSignal sent
timeout fired
caller stopped awaiting
operation terminal event appended
effect marked indeterminate
effect marked confirmed
quiet watcher
no change observed for a short interval
current replacement provider claims stronger containment
```

Quiescence proof is Host/provider-specific and bound to the persisted operation-local contract from §2.

## 3.5 `confirmed` may precede quiescence

A `may_write` operation can have a known confirmed effect while a descendant may still produce further writes.

Therefore this history is valid:

```text
operation effect confirmed
→ WorkspaceEffectGeneration advances once
→ mutation quiescence remains unknown
→ no trusted post-effect Program base yet
→ Workspace mutation/reconciliation barrier remains
```

Generation tracks the operation's first confirmed effect transition, not the moment every possible write finished.

The eventual post-quiescence observation establishes the stable checked state that a Program can adopt.

## 3.6 `absent` requires quiescence for a may-write operation

A final claim of `EffectStatus=absent` would be unsafe while the same writer may still act.

Therefore for `workspaceAccessClass=may_write`:

```text
final absent resolution
requires
proven_quiescent first
```

An intermediate diagnostic may suspect no effect, but canonical final absence used for recovery cannot precede quiescence.

## 3.7 Reconciliation requires quiescence

Correct sequence:

```text
effect indeterminate
→ establish proven quiescence under historical contract
→ acquire reconciliation environmental authority
→ obtain reconciliation evidence/observations
→ canonical resolution confirmed | absent | unresolved
```

If quiescence remains unknown, a reconciliation result that depends on the same live Workspace is not trustworthy and remains blocked.

---

# 4. Unknown quiescence is durable canonical barrier state

## 4.1 Why an in-memory coordinator is insufficient

History:

```text
may_write O starts
→ O has confirmed effect
→ terminal effect fact persisted
→ detached child can still write
→ quiescence unknown
→ Host crashes
```

If unknown quiescence exists only in an in-memory mutex, restart sees a terminal confirmed operation and may have neither a nonterminal-operation recovery case nor unresolved effect uncertainty to block on.

The environmental exclusion would silently disappear.

Therefore quiescence/barrier state must be reconstructible from canonical history.

## 4.2 Corrected invariant

> **For every `may_write` operation, canonical history makes mutation quiescence reconstructible. From the operation's environmental start until a canonical quiescence proof is admitted, replay treats that operation as an outstanding Workspace writer barrier regardless of whether execution outcome/effect status is already terminal.**

## 4.3 Preferred event/projection shape

The exact event name is open. Semantics can be equivalent to:

```text
operation.requested
  persists WorkspaceAccessClass + execution/quiescence provenance

operation.started for may_write
  → derived quiescence status = unknown / writer barrier active

operation.completed / interrupted / reconciliation facts
  → update outcome/effect only
  → DO NOT implicitly clear writer barrier

operation.mutation_quiesced
  → Host-owned monotonic proof under persisted historical contract
  → derived quiescence status = proven_quiescent
  → writer barrier clears
```

A normal capability adapter that proves quiescence at return may append the terminal fact and `operation.mutation_quiesced` in the same canonical batch.

A timeout/cancel path that cannot prove quiescence omits the quiesced fact, even if it can append a terminal/indeterminate/confirmed effect fact.

## 4.4 Quiescence fact is monotonic

Once correctly proven for operation O:

```text
unknown → proven_quiescent
```

There is no transition back for the same historical writer. The proof means the old operation can no longer produce Workspace writes under the persisted containment contract.

If a later new operation writes, it has a new `operationId` and its own quiescence state.

## 4.5 Canonical proof contents

A quiescence admission needs enough stable provenance to show what rule was used, for example:

```ts
interface MutationQuiescedPayload {
  operationId: string;
  proofKind:
    | "operation_containment_ended"
    | "host_provider_lifetime_ended"
    | "external_recovery";
  providerBindingRevision?: string;
  providerGenerationId?: string;
}
```

Exact fields are open. The Host must validate the proof against the **persisted request-time contract**, not current provider metadata.

## 4.6 Restart barrier

Before enabling ProgramAttempt dispatch, ordinary `may_write` capability admission, stable Workspace reconciliation, verification satisfaction, or completion:

```text
rebuild operation/quiescence projection
→ find every post-baseline may_write operation that started and lacks canonical proven-quiescent fact
→ attempt allowed provider-specific historical quiescence proof
→ if proof succeeds, canonically record quiescence
→ if proof cannot be established, keep Workspace fail-closed
```

This applies even when:

```text
execution outcome is terminal
AND effectStatus = confirmed
```

Effect certainty does not clear the writer barrier.

## 4.7 Host crash does not itself prove quiescence

Whether Host/provider loss proves quiescence depends on the operation's persisted historical containment contract.

```text
persisted host_lifetime_containment
+ proof relevant old containment lifetime ended
→ quiescence may be proven
```

```text
persisted external_writer_may_survive
→ Host death alone is insufficient
→ explicit provider/external recovery evidence required
```

Do not inspect a replacement provider and apply its contract retroactively.

## 4.8 Two barriers may remain after timeout

A timed-out mutator can produce:

```text
Barrier A: writer-liveness/quiescence unknown
Barrier B: effect certainty indeterminate
```

The safe order is:

```text
first prove writer quiescence
→ then reconcile effect uncertainty
→ then direct current observation/rebase
→ then fresh ProgramAttempt
```

They are separate and both may need durable state.

---

# 5. Corrected mutation sequence

With all review corrections applied:

```text
Host resolves capability binding
→ determine WorkspaceAccessClass
→ determine closed MutationContainmentContract
→ capture provider/binding incarnation identity if historical recovery may address it
→ acquire Workspace coordinator authority
→ direct pre-observation
→ canonical operation.requested persists:
     operationId
     WorkspaceAccessClass
     operation-local execution/quiescence provenance
→ operation.started
→ for may_write: canonical history now derives quiescence=unknown / writer barrier active
→ environmental execution

when execution outcome/effect information becomes known:
  persist operation outcome/effect facts as allowed
  if effect first becomes confirmed and persisted class is may_write:
     WorkspaceEffectGeneration advances exactly once
  DO NOT clear writer barrier merely from terminal/effect state

if historical contract + Host evidence prove writer quiescent:
  canonically admit mutation-quiesced fact
  → writer barrier clears

if quiescence unknown:
  no ordinary Host mutation
  no stable reconciliation
  no Program continuation/verification/completion that assumes trusted base

once quiescent:
  if effect confirmed:
     obtain complete post observation
     → current-attempt continuation only if all Program/currentness predicates still hold

  if effect absent:
     G unchanged
     → obtain complete current observation

  if effect indeterminate:
     reconcile
     → confirmed: first confirmed transition advances G once
     → absent: G unchanged
     → unresolved: effect barrier remains

reconciliation and replay use persisted historical operation semantics,
not the current provider registry
```

---

# 6. Protocol baseline and legacy histories

The Phase 1 execution protocol still needs a deterministic activation origin because legacy operations lack the new request-time fields.

Before baseline B0:

```text
recover existing canonical state
→ deal with pre-existing mutation uncertainty under legacy recovery semantics
→ establish that no pre-baseline Host-controlled writer remains capable of mutating the Workspace
→ obtain complete current ExecutionObservationIdentity O0
→ canonical B0
→ G0 = 0
```

From B0 onward:

```text
every participating operation.requested persists WorkspaceAccessClass
and required execution/quiescence provenance
```

Replay never manufactures those fields for older events from the current registry.

If safe baseline activation cannot establish that no legacy writer remains live, Phase 1 execution-protocol activation fails closed rather than pretending B0 is stable.

---

# 7. Required negative proofs

## 7.1 Historical classification replay

```text
O requested under provider P0
workspaceAccessClass = none
→ provider replaced by P1 where same tool name is may_write
→ rebuild
→ historical O remains none
→ no false G advance
```

## 7.2 Historical containment replay

```text
O requested under P0
mutationContainment = external_writer_may_survive
→ Host crashes
→ P1 says host_lifetime_containment
→ restart
→ P1 cannot prove old O quiescent merely by its own current contract
```

## 7.3 Normal atomic quiescence

```text
may_write O runs under operation_scoped_containment
→ adapter proves all mutation-capable descendants ended
→ terminal fact + mutation-quiesced admitted atomically
→ writer barrier clears
```

## 7.4 Timeout ignores cancellation

```text
may_write O starts
→ timeout
→ child keeps writing
→ terminal timed_out/indeterminate persisted
→ no mutation-quiesced fact
→ writer barrier survives
→ no reconciliation/other Host mutation crosses child lifetime
```

## 7.5 Confirmed terminal before quiescence

```text
O effect confirmed
→ G advances
→ quiescence unknown
→ Host crashes
→ replay sees terminal confirmed + missing quiesced fact
→ Workspace still blocked
```

This is the key proof that environmental safety does not vanish on restart.

## 7.6 Absent cannot precede quiescence

```text
may_write O writer still possibly live
→ attempted final absent resolution
→ reject/defer until quiescence proven
```

## 7.7 Reconciliation after quiescence only

```text
O indeterminate
→ writer quiescence unknown
→ reconciliation request
→ blocked
→ quiescence later proven
→ reconciliation may inspect stable Workspace
```

## 7.8 Host-lifetime containment proof

```text
O request persisted host_lifetime_containment + P0 identity
→ Host/P0 lifetime ends
→ recovery proves that historical containment lifetime ended
→ append O mutation-quiesced idempotently
→ replacement P1 semantics irrelevant to O
```

## 7.9 Detached writer survives Host

```text
O persisted external_writer_may_survive
→ Host dies
→ detached process still possible
→ restart cannot infer quiescence
→ Workspace remains fail-closed until external/provider proof
```

## 7.10 Duplicate quiescence admission

```text
same proof retried
→ same operationId already proven quiescent
→ no duplicate semantic transition
→ WorkspaceEffectGeneration unaffected
```

---

# 8. Acceptance-criterion consequences

If these conclusions are later consolidated, existing AC families absorb them.

## AC-10-06 — operation correlation / uncertainty / effect lineage

Require proof that:

```text
request-time WorkspaceAccessClass is immutable canonical operation history
provider replacement cannot alter generation rebuild
first confirmed persisted may_write operation advances G exactly once
quiescence state does not alter or duplicate G
```

Also keep explicit:

```text
indeterminate effect != proof writer stopped
confirmed effect != proof writer stopped
```

## AC-10-09 — recovery barrier

Require proof that:

```text
operation-local containment/provider provenance is replayable
started may_write without quiesced fact is a durable writer barrier
terminal confirmed may_write without quiesced fact is also a durable writer barrier
restart applies the historical containment contract, not replacement-provider semantics
unknown quiescence blocks mutation/reconciliation/scheduler admission
quiescence proof is canonical/idempotent
only after quiescence may effect reconciliation establish a stable current base
```

## AC-10-05 — scheduler/environmental coordination

Require the Workspace coordinator to consult the rebuilt outstanding-writer barrier before granting ProgramAttempt reservations or mutation/reconciliation leases.

---

# 9. Status after review corrections

The preferred architecture remains:

```text
versioned complete ExecutionObservationIdentity
+
Host Workspace mutation coordination
+
operation-derived WorkspaceEffectGeneration
+
fail-closed drift/effect uncertainty
+
explicit Application rebase before fresh attempt
```

Four additional statements are now mandatory:

```text
1. WorkspaceAccessClass is immutable request-time canonical operation history.

2. Any provider/containment semantics used later to prove historical mutator
   quiescence are immutable operation-local provenance; current provider
   metadata cannot reinterpret an old operation.

3. Effect certainty and mutation quiescence are separate state machines.

4. Unknown mutation quiescence is a durable/rebuildable Workspace writer
   barrier until a Host-validated canonical quiescence proof is admitted.
```

These corrections strengthen the original direction; they do not authorize implementation or make Phase 1.0 approved/frozen.
