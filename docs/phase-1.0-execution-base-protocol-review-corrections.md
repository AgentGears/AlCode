# Phase 1.0 Execution-Base Protocol Study — Review Corrections

**Status:** incorporated correction to `docs/phase-1.0-execution-base-protocol-study.md`  
**Approval:** non-normative planning only; not approved; not frozen; implementation not authorized  
**Applies to study head:** the PR #41 study beginning at `2a7b81d913f350157bb4318ab386bc1970d53282`

This file records two correctness corrections identified during review of the execution-base protocol study.

**Precedence:** where this correction conflicts with wording in `docs/phase-1.0-execution-base-protocol-study.md`, this correction controls the recommendation. A later consolidation must use the corrected semantics below, not the superseded wording.

The corrections do not amend `docs/phase-1.0-plan.md`, change AC-10, approve/freeze Phase 1.0, or authorize implementation.

---

## 1. Persist WorkspaceAccessClass in immutable operation history

### 1.1 Problem

The study recommends:

```text
WorkspaceEffectGeneration
= replayable ordinal of first confirmed transitions
  of Host-classified Workspace-mutating operations
```

and introduces a Host-owned request-time classification:

```ts
type WorkspaceAccessClass =
  | "none"
  | "read_only"
  | "may_write";
```

The current implementation's `operation.requested` payload persists only `isReadOnly`; it does **not** persist this new Workspace-specific classification.

If replay later consults the current capability registry/provider to recover `WorkspaceAccessClass`, generation is not deterministic. Capability metadata can change, providers can disappear, and a non-read-only capability may have external effects while having Workspace access `none`.

Therefore the original study was incomplete wherever it implied that generation could be rebuilt from operation effects without also making request-time Workspace classification immutable.

### 1.2 Corrected invariant

> **Every operation admitted into the Phase 1 Workspace-effect lineage records its Host-authorized `WorkspaceAccessClass` in immutable canonical operation history at the root operation request. Replay consumes that persisted classification and never asks the current capability registry what the historical operation meant.**

The natural location is `operation.requested` because it is already the durable root of operation identity and request semantics.

Illustrative Phase 1 payload extension:

```ts
interface OperationRequestedPayloadV2 {
  operationId: string;
  toolName: string;
  args: unknown;
  isReadOnly: boolean;
  workspaceAccessClass: "none" | "read_only" | "may_write";
}
```

Exact schema spelling/version is implementation design. The semantic requirement is not.

### 1.3 Request-time authority

The persisted value is determined by the Host at request admission from the then-authorized capability binding/policy contract.

Rules:

```text
trusted Host binding says none
→ persist none

trusted Host binding says read_only
→ persist read_only

trusted Host binding says may_write
→ persist may_write

missing / malformed / untrusted Workspace classification
→ persist may_write conservatively
```

The Agent, tool result, model output, or later plugin generation cannot rewrite the historical classification.

A later provider replacement does not reinterpret an already-requested operation.

### 1.4 WorkspaceAccessClass remains distinct from isReadOnly

Do not derive the new field mechanically from `isReadOnly` for new Phase 1 operations.

Examples:

```text
network POST capability
  isReadOnly = false
  WorkspaceAccessClass = none
```

```text
repository grep
  isReadOnly = true
  WorkspaceAccessClass = read_only
```

```text
arbitrary shell
  isReadOnly = false
  WorkspaceAccessClass = may_write
```

The two fields answer different questions:

```text
isReadOnly
  → generic operation/effect/policy semantics

WorkspaceAccessClass
  → whether this invocation participates in Workspace environmental coordination
    and Workspace-effect lineage
```

### 1.5 Generation reducer

The corrected generation rule is:

```text
for an operation admitted into the Workspace-effect protocol:

persisted workspaceAccessClass != may_write
→ never advances WorkspaceEffectGeneration

persisted workspaceAccessClass == may_write
AND effect has not reached confirmed
→ no advance

persisted workspaceAccessClass == may_write
AND operationId reaches canonical EffectStatus=confirmed for the first time
→ advance WorkspaceEffectGeneration exactly once
```

Replay uses only canonical request/effect/reconciliation facts.

It does not consult:

- current capability metadata;
- current plugin/provider registry;
- current Host policy;
- Agent assertions;
- watcher state.

### 1.6 Existing/legacy operation histories need a deterministic protocol origin

Pre-Phase-1 operation rows/events do not contain `WorkspaceAccessClass`. They must not be retrospectively reinterpreted using whatever capability registry happens to exist during replay.

Preferred migration/activation rule:

```text
recover/reconcile every pre-existing operation whose effect may still be active/uncertain
→ prove Host-mediated Workspace mutation quiescence as required by Correction 2
→ obtain complete current ExecutionObservationIdentity O0
→ canonically establish the Workspace execution-protocol baseline
→ set WorkspaceEffectGeneration origin G0 = 0
→ from that canonical boundary onward, every participating operation.requested
  carries persisted WorkspaceAccessClass
```

The baseline fact may have an implementation event name such as:

```text
workspace.execution.baseline.established
```

but the exact spelling is not selected here.

Its meaning is limited:

> at activation cut C, after required recovery/quiescence checks, the Host accepted complete current observation O0 as the origin of the Phase 1 Workspace execution lineage.

It does **not** claim to reconstruct a causal Workspace-effect generation for operations that occurred before the protocol existed.

This is safe because execution freshness requires the current observed base, while the generation ordinal exists to distinguish **subsequent Host-known causal transitions** from that accepted origin.

### 1.7 Rebuild proof

Delete/rebuild must prove:

```text
baseline event B at sequence S, G=0
→ operation O1 requested with persisted class none, confirmed
→ G remains 0
→ operation O2 requested with persisted class may_write, indeterminate
→ G remains 0
→ O2 reconciled confirmed
→ G becomes 1 exactly once
→ provider registry replaced
→ rebuild
→ same G=1 and same O2 ownership without consulting replacement provider
```

Also prove:

```text
legacy operation before baseline lacks workspaceAccessClass
→ rebuild does not infer its class from current registry
→ generation origin remains the canonical baseline
```

### 1.8 Consequence for the main study

Sections describing:

- `WorkspaceAccessClass`;
- generation derivation;
- operation root ownership;
- replay/recovery;
- AC-10-06 generation proofs;

must be read with this additional invariant:

> **request-time Workspace classification is itself a canonical input to the replayable generation reducer.**

---

## 2. Mutation exclusion cannot be released merely because an operation became indeterminate

### 2.1 Problem

The study's cancellation/timeout discussion allowed wording equivalent to:

```text
retain environmental coordination until execution returns
OR
until the Host can durably classify the operation as indeterminate
```

That `OR` is unsafe.

A timed-out/cancelled capability may:

- ignore cancellation;
- continue executing after the caller stops awaiting it;
- leave a child/grandchild process running;
- detach a process that keeps writing the Workspace;
- return an indeterminate outcome while environmental writes are still possible.

Durably recording:

```text
EffectStatus = indeterminate
```

answers:

> do we know whether/what effect occurred?

It does **not** answer:

> has the mutating executor stopped being able to write?

Releasing the mutation coordinator and beginning reconciliation while the original writer can still mutate would make the reconciliation observation itself stale or meaningless.

### 2.2 Corrected separation

Keep these concepts distinct:

```text
Effect certainty
  confirmed | absent | indeterminate | not_applicable

Mutation quiescence
  proven_quiescent | unknown
```

The exact type/event spelling is open. The distinction is mandatory.

Effect certainty belongs to the durable operation/reconciliation model.

Quiescence is the Host/provider control property needed before another Host-mediated Workspace mutator or authoritative reconciliation observation may proceed.

### 2.3 Corrected mutation-sublease release rule

> **A Workspace-mutating operation's environmental exclusion may be released for ordinary/reconciliation use only after that operation's ability to produce further Workspace writes is proven quiescent. Merely persisting a terminal outcome or `EffectStatus=indeterminate` is insufficient.**

Normal case:

```text
capability executor returns
AND Host adapter proves its mutation lifetime is quiescent
→ mutation sublease may end
→ terminal/reconciliation rules continue
```

Timeout/cancellation case:

```text
signal cancellation/timeout
→ executor/descendants may still write
→ persist outcome/effect uncertainty as allowed
→ mutation quiescence remains unknown
→ do not let another Host mutator/reconciliation inspection cross that writer
```

### 2.4 What counts as quiescence proof

Proof is capability/provider-specific and Host-owned.

Examples can include:

- direct process handle known exited with all mutation-capable children contained by a Host-owned process/job group;
- provider operation contract says completion atomically ends the mutation lifetime;
- isolated Workspace provider revokes/terminates the execution environment;
- explicit external/user recovery proves the detached writer is gone.

Examples that are **not** sufficient by themselves:

- `AbortSignal` was sent;
- timeout fired;
- caller stopped awaiting the process;
- `operation.completed` was appended;
- effect was marked indeterminate;
- no filesystem change was observed for a short interval;
- watcher is quiet.

### 2.5 Unknown quiescence is a Workspace execution barrier

If quiescence cannot be proven:

```text
Workspace mutation quiescence = unknown
→ no new ProgramAttempt
→ no ordinary Host may_write capability
→ no reconciliation result that depends on a stable Workspace observation
→ no verification satisfaction/completion that requires a trusted execution base
```

The Host may surface diagnostics/control to the Application.

A safe recovery path may require:

- terminating/containing the writer;
- closing/restarting the responsible execution provider;
- explicit user intervention;
- or, in a future architecture, abandoning an isolated attempt Workspace.

The system must not manufacture progress by simply releasing the mutex.

### 2.6 Reconciliation cannot start while the original writer is still live/unknown

Corrected reconciliation sequence:

```text
operation effect indeterminate
→ first establish proven mutation quiescence
→ acquire reconciliation environmental authority
→ obtain reconciliation evidence/observations
→ canonical resolution confirmed / absent / unresolved
```

If quiescence remains unknown, reconciliation that relies on the same live Workspace remains blocked.

This is stronger than merely preserving effect uncertainty and is necessary to make reconciliation evidence trustworthy.

### 2.7 Host crash/restart does not automatically prove quiescence

A Host process death releases in-memory locks, but it may not prove an external/detached child process stopped.

Therefore Phase 1 startup must treat a surviving prior mutating operation as requiring both:

```text
effect reconciliation
AND
mutation-quiescence establishment
```

where the capability/provider model admits lingering execution.

If the Host has a containment mechanism whose lifetime guarantees descendants die with the Host/provider, that guarantee can establish quiescence. Otherwise startup remains fail-closed until quiescence is proven or the Workspace is explicitly recovered by an authorized path.

### 2.8 Corrected cancellation/timeout sequence

Read the main study's cancellation section as:

```text
Program cancellation/attempt interruption wins
→ prohibit new Program operations
→ signal in-flight mutator cancellation
→ persist terminal/indeterminate operation fact when known
→ KEEP environmental mutation exclusion/barrier while writer quiescence is unknown
→ once proven quiescent:
     release live writer exclusion
     retain effect-uncertainty barrier if effect remains indeterminate
→ reconcile effect
→ only after safe current-base reauthorization may a fresh attempt start
```

This yields two sequential barriers when needed:

```text
writer-liveness barrier
then
external-effect-certainty barrier
```

They must not be collapsed.

### 2.9 Required negative proofs

Add:

```text
timed-out mutator ignores AbortSignal
→ operation effect becomes indeterminate
→ child still can write
→ no reconciliation / other Host mutation crosses child lifetime
```

```text
operation marked indeterminate
→ writer quiescence unknown
→ Workspace does not become mutation-admissible merely because canonical uncertainty exists
```

```text
writer later proven quiescent
→ effect still indeterminate
→ other ordinary mutation still blocked by effect-uncertainty policy until reconciliation
```

```text
Host crashes with detached mutator possible
→ reopen does not infer quiescence from Host death alone
→ capability/provider containment proof or explicit recovery required
```

```text
reconciliation begins only after quiescence proof
→ reconciliation observation cannot be invalidated by the original Host-controlled writer continuing to execute
```

### 2.10 Consequence for the main study

Any wording in the main study that allows environmental coordination to be released solely because an in-flight mutator has been durably classified `indeterminate` is superseded.

The corrected invariant is:

> **Effect uncertainty can be canonical while mutation liveness is still unsafe. Quiescence is a separate prerequisite for releasing environmental exclusion and for trustworthy reconciliation.**

---

## 3. Corrected consolidated execution sequence

With both review corrections applied, the critical mutation path becomes:

```text
Host-authorized capability binding
→ determine request-time WorkspaceAccessClass
→ acquire required Workspace coordinator reservation/sublease
→ pre-observe exact current base
→ canonical operation.requested persists WorkspaceAccessClass
→ operation.started
→ environmental execution
→ establish execution outcome / effect status when possible
→ establish whether mutation lifetime is proven quiescent

if writer quiescence unknown:
  persist available operation uncertainty
  → keep Workspace mutation admission blocked
  → do not reconcile against unstable Workspace

once writer proven quiescent:
  if effect confirmed:
    first confirmed transition for persisted may_write operation
    → G advances exactly once
    → complete post-observation required for same-attempt continuation

  if effect absent:
    → G unchanged
    → complete post-observation/currentness still required

  if effect indeterminate:
    → G unchanged
    → current attempt non-continuable
    → reconciliation

reconciliation uses persisted historical WorkspaceAccessClass
→ confirmed: first confirmed transition advances G exactly once
→ absent: G unchanged
→ unresolved: uncertainty remains
```

Replay reconstructs causal lineage from:

```text
canonical protocol baseline
+ immutable operation.requested WorkspaceAccessClass
+ canonical operation effect/reconciliation transitions
```

not from the current capability registry.

---

## 4. Acceptance-criterion correction

If these study conclusions are later consolidated, AC-10-06 and AC-10-09 need explicit proof of both corrections.

### AC-10-06

Prove:

```text
request-time workspaceAccessClass persisted
→ provider replaced
→ replay produces identical WorkspaceEffectGeneration
```

and:

```text
indeterminate effect
!=
proof executor stopped
```

### AC-10-09

Prove:

```text
Host reopen with prior mutator that may still have a live external writer
→ no mutation/reconciliation/scheduler admission
→ quiescence established by capability/provider-specific proof
→ then effect reconciliation/current observation
→ then normal admission may resume
```

---

## 5. Status after correction

These corrections strengthen the original recommendation rather than changing its direction.

The preferred architecture remains:

```text
versioned complete execution observation
+
Host Workspace mutation coordination
+
operation-derived WorkspaceEffectGeneration
+
fail-closed drift/uncertainty
+
explicit rebase before fresh attempt
```

But two additional statements are now mandatory:

1. **the operation's Workspace classification is immutable canonical request history;**
2. **effect uncertainty and mutator quiescence are separate barriers.**
