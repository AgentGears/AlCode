# A5 — Sandboxed Execution Providers / Physical Execution-Provider Isolation Plan

**Status:** CANDIDATE DESIGN CONTRACT — NOT FROZEN / NO IMPLEMENTATION AUTHORITY  
**Draft date:** 2026-09-15  
**Baseline:** `main@79e8950e5d09273e1446429b793ba526f2453822`  
**Forcing evidence:** [`a5-execution-provider-gap-study.md`](./a5-execution-provider-gap-study.md)  
**Predecessors:** Phase 1.0/1.1, S-01, P-01, A1, P-02, S-02, A2/S-04  
**Authority:** This document is a review candidate only. It does not authorize implementation until explicitly approved/frozen.

---

## 1. Objective

Introduce one Host-owned, provider-neutral execution-world boundary so the existing local execution path and at least one physically isolated backend can implement the same ALCODE execution semantics without moving canonical authority out of the Host.

A5 must make it mechanically true that:

```text
ProgramAttempt execution base
        ↓
exact current execution-world generation
        ↓
world-bound filesystem/process/verification observation
        ↓
Host CapabilityBroker admission
        ↓
Host Operation
        ↓
provider execution
        ↓
effect / quiescence / reconciliation
        ↓
world-bound re-observation
        ↓
verification / Completion
```

The central invariant is:

> **An execution provider supplies and observes a physical world; it never becomes a second Program, capability-admission, Operation, verification, recovery, or Completion authority.**

A second invariant is:

> **All capability execution and observations that claim to address one execution world must bind to the same exact, non-reusable world generation.**

---

## 2. Authority boundary

A5 adds a physical execution substrate below existing Host authority.

```text
ProgramState / ProgramRevision
        ↓
ProgramAttempt authority
        ↓
Host currentness + world-generation fence
        ↓
CapabilityBroker / verification control
        ↓
Host Operation identity
        ↓
WorkspaceExecutionProvider
        ↓
ExecutionWorld generation
        ├─ filesystem
        ├─ process/terminal
        ├─ execution-base observation
        └─ world-bound verification observation
        ↓
provider evidence
        ↓
Host effect / quiescence / reconciliation
        ↓
Host verification / Completion
```

The provider must not:

- admit or mutate ProgramState;
- decide whether a ProgramAttempt is current;
- bypass Host capability policy/approval;
- mint Host Operation identity;
- convert process/provider status directly into effect truth;
- satisfy verification on its own authority;
- complete a Program;
- expose a provider/world handle to the Agent as an execution token.

---

## 3. Candidate semantic decisions

### D1 — Add a Host-owned execution-world generation identity

Each active physical execution world is represented by a Host-owned, non-reusable generation identity.

Conceptually:

```ts
interface ExecutionWorldIdentityV1 {
  workspaceId: string;
  providerKind: string;
  worldId: string;
  worldGenerationId: string;
  effectivePolicyDigest: string;
  providerDescriptorDigest: string;
}
```

Exact field names are reversible. Required semantics are not:

- `workspaceId` retains its existing durable ALCODE meaning;
- `worldId` identifies the logical execution world within that Workspace;
- `worldGenerationId` is fresh and never reused after retirement/loss/recreation;
- material policy/provider changes that cannot prove semantic continuity create a fresh generation;
- provider-native container/VM/session IDs are optional provenance and never substitute for the Host generation identity.

The world identity is not a capability token. Current Host authority is always required separately.

### D2 — Bind ProgramAttempt execution base to exact world generation

`ProgramAttemptExecutionBase` must include or reference the exact execution-world identity/generation in addition to the existing Host `workspaceEffectGeneration` and observed state.

Conceptually:

```text
ProgramAttemptExecutionBase
  executionWorld
    workspaceId
    providerKind
    worldId
    worldGenerationId
    policy/provider digest(s)
  workspaceEffectGeneration
  observation
    coverageDigest
    stateDigest
    ...
```

Currentness therefore means both:

1. the same exact world generation is current; and
2. the observed execution state is current according to the existing execution-base rules.

Identical repository bytes in a replacement world do not preserve an old Attempt unless the provider/Host can prove continuity under the frozen generation contract.

### D3 — One Host-owned provider/world owner binds coherent services

Introduce a `WorkspaceExecutionProvider`-class semantic boundary that opens/resolves an `ExecutionWorld` generation and supplies the services that must be coherent for that world.

Candidate shape:

```ts
interface WorkspaceExecutionProviderV1 {
  descriptor(): ExecutionProviderDescriptorV1;
  activate(input: ExecutionWorldActivationV1): Promise<ExecutionWorldV1>;
}

interface ExecutionWorldV1 {
  identity: ExecutionWorldIdentityV1;
  filesystem: FilesystemCapability;
  process: TerminalCapability | ProcessCapability;
  observeExecutionBase(): Promise<...>;
  observePath?(...): Promise<...>;
  lifecycle: ExecutionWorldLifecycleV1;
}
```

The exact package and interface split is implementation-owned. What is frozen only after approval is the coherence rule: filesystem/process/world-current observations that claim the same world must come from the same exact world generation.

### D4 — Keep subsystem-specific providers beneath one coherent world

A5 should not force filesystem, subprocess, semantic observation, and future browser execution into one lowest-common-denominator executor.

A world owner may compose subsystem-specific adapters, consistent with APR-034, provided all authority-sensitive world-scoped services are bound to the same exact world generation.

Example:

```text
ExecutionWorld G7
   ├─ filesystem adapter
   ├─ process adapter
   ├─ path-state observer
   └─ execution-base observer
```

The Host rejects a composition whose adapters cannot establish common world identity.

### D5 — Host selects and fences the current world; Agent never selects it

The Agent continues to see semantic tools such as `read`, `write`, `edit`, `bash`, etc. It does not send a container ID, VM ID, SSH handle, provider ID, or world generation as authority.

At capability admission the Host resolves the current world generation and validates it against ProgramAttempt authority when Program-backed.

For non-Program work, the Host still binds any world-scoped Operation to the exact current world generation used for execution.

This prevents an Agent from replaying a historical world identity to redirect execution.

### D6 — Durable Operation provenance records exact world generation

For every world-scoped Host Operation, `operation.requested` (or an equivalent same-admission durable fact) records bounded execution-world provenance sufficient to reconstruct which physical world generation was targeted.

At minimum:

```text
providerKind
worldId
worldGenerationId
provider/effective-policy digest reference
```

Provider-native instance IDs may be recorded when safe and bounded but are optional.

World provenance explains where execution was admitted. It does not prove the effect happened.

### D7 — World lifecycle is Host-canonical and rebuildable

A5 should record the minimum durable lifecycle facts necessary to reconstruct world generations and invalidation, for example:

```text
execution.world.activated
execution.world.retiring
execution.world.closed
execution.world.lost
```

Exact event spelling is reversible.

The durable facts must distinguish at least:

- current active generation;
- intentional retirement/replacement;
- confirmed clean closure when evidence supports it;
- lost/unknown provider world;
- successor generation.

Do not create an independently mutable provider database that can diverge from canonical Workspace history.

### D8 — Replacement/reconnect is a freshness cut

A world generation is non-reusable.

If a provider is recreated, replaced, or reconnected and cannot prove continuity at the semantic strength required by ALCODE, the Host mints/adopts a fresh generation. Existing ProgramAttempts bound to the old generation become stale.

Provider-native “same container name,” “same remote session,” or “same mount path” is not enough.

A provider may support stronger continuity only if the later frozen contract defines testable evidence for it. The safe default is fresh generation.

### D9 — Preserve existing Operation uncertainty semantics

Provider lifecycle and Operation effect truth remain separate.

```text
provider lost
  ≠ operation absent

container exited
  ≠ mutation definitely quiesced

provider returned error
  ≠ effect absent
```

Existing execution outcome, effect status, reconciliation status, writer barriers, and quiescence proof semantics remain authoritative.

Provider-specific reconciliation may inspect the world or external evidence, but the Host owns the durable resolution.

### D10 — Extend, do not replace, quiescence contracts

A5 may add provider/world provenance to operation-scoped containment and recovery evidence, but should reuse the existing quiescence model.

A mutating world-scoped capability that requires operation-scoped containment must still produce the exact Host-validated proof for its containment instance. World shutdown alone does not synthesize that proof unless the provider contract explicitly proves the relevant containment ended.

### D11 — Define explicit containment policy profiles

A5 distinguishes local trusted execution from physically isolated execution.

Candidate Host policy object:

```text
ExecutionContainmentPolicy
  filesystem/mount rules
  user/privilege rule
  CPU limit
  memory limit
  process-count limit
  wall-time limit
  output/result limits
  network/egress rule
  ambient-env rule
  secret projection rule
  cleanup/teardown rule
```

The provider exposes a bounded semantic descriptor of which controls it can enforce. Host validates the selected policy against provider support before world activation/use.

Mandatory unsupported controls fail closed; they are never silently downgraded.

The existing local provider may use an explicitly named local/trusted profile and must not be described as hostile-code isolation.

### D12 — Secrets remain Host-controlled and non-durable in raw form

Execution-world descriptors, policy digests, lifecycle events, and Operation provenance must be secret-free.

If a capability requires a secret in an isolated world:

- Host policy decides whether projection is permitted;
- the provider receives the secret only through an explicit ephemeral mechanism;
- raw secret values are not persisted in world descriptors/events;
- environment inheritance is deny-by-default or explicitly bounded by the selected profile;
- world teardown must not be treated as proof that an externally exposed credential is safe; existing incident rules remain applicable.

A5 does not create a general secret manager product.

### D13 — World-bound verification must observe the same generation

Any verifier that claims filesystem/process state from the execution world must bind its observation or verifier Operation to the same world generation as the ProgramAttempt being verified.

The existing direct local path observer must therefore be abstracted behind a world-bound observation seam for isolated execution.

Host verifier definitions remain canonical. Provider/world observation is evidence only.

### D14 — Planning observations remain distinct from execution authority

A5 does not automatically move every planning/semantic observation into the execution provider.

Rules:

- raw filesystem planning reads that must reflect the execution world should use the world-bound filesystem seam;
- semantic CodeIntelligence may remain a separate provider only when it can establish freshness/provenance against the exact current execution world/base;
- if that freshness cannot be established for an isolated backend, the semantic capability is unavailable or explicitly incomplete/stale rather than silently reading a different local copy;
- planning evidence never becomes execution authority.

This preserves APR-042 without turning A5 into a semantic-graph objective.

### D15 — Local provider is the compatibility oracle

The existing local product path becomes the first A5 provider implementation or is wrapped by one with equivalent semantics.

A5 may refactor `Workspace`, `LocalFilesystem`, `LocalTerminal`, execution-base observation, path observation, and capability construction to make the provider boundary explicit, but local behavior must preserve all closed predecessor contracts.

The abstraction must not weaken:

- Workspace locking;
- ProgramAttempt currentness;
- capability policy/approval;
- dynamic capability generation fences;
- Operation/effect/reconciliation semantics;
- S-02 orchestration;
- A2 inference provenance;
- verification;
- Completion.

### D16 — One real isolated backend is required for A5 closure

A provider interface proven only by mocks does not establish physical isolation.

A5 closure therefore requires:

- the production local provider; and
- at least one production-capable physically isolated provider on an explicitly supported platform.

The specific backend technology is an implementation choice, not part of this candidate architecture contract. Unsupported platforms/backends must fail clearly rather than falling back from isolated to local execution without explicit user/Host policy.

Local execution remains the product default unless a separate product decision promotes an isolated provider to default.

### D17 — A5 does not introduce remote execution protocol semantics

An isolated provider may happen to use a local daemon/API internally, but A5 does not freeze general remote-worker leases, distributed claims, network retry identity, or multi-machine Host authority.

Those remain A9 concerns.

If a chosen isolated backend is reached over an API, its transport is an implementation detail beneath the same local A5 world-generation contract; loss still follows ordinary uncertainty rules.

### D18 — A5 does not add parallel execution domains

A5 establishes the identity/containment contract for one current execution world per Workspace at a time.

A7 may later create multiple isolated Workspace identities/worktrees and execute them concurrently. A5 must not weaken the existing one-writer-per-Workspace rule merely to demonstrate provider substitution.

---

## 4. Candidate lifecycle

```text
Host opens locked Workspace W
        ↓
Host selects execution provider P + containment policy C
        ↓
P validates support for C
        ↓
Host activates logical execution world X
        ↓
Host durably records fresh generation G
        ↓
world-bound execution-base observation B
        ↓
ProgramAttempt A issued against (W, X, G, B)
        ↓
Agent inference / capability proposal
        ↓
Host validates A + capability + current G
        ↓
Host admits Operation O with durable G provenance
        ↓
world-bound capability executes through G
        ↓
provider result / quiescence evidence / possible uncertainty
        ↓
Host settles O using existing effect rules
        ↓
world-bound re-observation under same current G
        ↓
verification / retry / successor / Completion
```

Replacement:

```text
G0 active
  ↓ provider replacement/loss/recreation
G0 retired/lost
  ↓
old Attempts referencing G0 are stale
  ↓
fresh G1 activated
  ↓
fresh observation
  ↓
fresh Attempt if Program work remains
```

Already-admitted Operations from G0 retain independent settlement/reconciliation obligations.

---

## 5. Candidate domain/protocol changes

### 5.1 ProgramState execution base

Extend the execution-base shape with one bounded execution-world identity reference/snapshot.

Historical Attempt bases remain immutable. Migration/versioning must preserve existing local histories rather than reinterpret old records as isolated-world claims.

### 5.2 Host execution-provider service

Add one Host-owned service/registry responsible for:

- provider selection;
- world activation;
- fresh world generation identity;
- current-generation lookup/fencing;
- provider descriptor/policy validation;
- retirement/loss transitions;
- world-bound capability/observation access.

It is an authority **adapter**, not a second Program scheduler or Operation store.

### 5.3 CapabilityBroker integration

For world-scoped capabilities, Host admission resolves an execution-world binding and validates ProgramAttempt world currentness before execution.

The Agent does not supply this binding.

Durable Operation provenance records the Host-resolved binding.

### 5.4 Execution observation

Replace or adapt the free-standing production `ProgramExecutionObservationSourceV1` so an authority-bearing execution-base observation is explicitly bound to one exact execution-world generation.

An observation may still become `unknown`; provider unavailability must not fabricate a stale-as-current base.

### 5.5 Verification/path observation

World-state verifiers use a world-bound observation interface rather than direct Host-local paths when the selected execution world is isolated.

Operation-result verifiers continue through ordinary CapabilityBroker/Operation execution.

### 5.6 Planning reads

Raw planning reads should be sourced from the active world where execution-world freshness matters. Optional semantic providers such as CodeIntelligence require an explicit freshness bridge to the same world/base or become unavailable/incomplete for that provider.

### 5.7 Application / Agent Protocol

No new Agent authority field is required merely to implement A5. Provider selection and world identity should remain Host-side unless a later product requirement needs safe read-only exposure.

The Application Protocol may later expose a bounded execution-environment status snapshot, but A5 closure does not require clients to select provider-native IDs or manipulate world lifecycle directly.

---

## 6. Candidate containment contract

A provider descriptor should separate stable semantics from sensitive/provider-native details.

Conceptually:

```text
ExecutionProviderDescriptor
  providerKind
  adapterId/version
  supportedPolicyFeatures
  semanticConfigDigest
```

World activation binds an **effective** policy, not merely a requested policy.

Candidate mandatory controls for an isolated profile:

- explicit repository/workspace mount;
- no host filesystem access outside declared mounts;
- unprivileged execution or equivalent bounded privilege contract;
- bounded CPU;
- bounded memory;
- bounded process count;
- bounded wall time;
- bounded stdout/stderr/results;
- default-deny or explicitly declared network/egress policy;
- scrubbed ambient environment;
- explicit secret projection only;
- deterministic teardown attempt;
- process-tree/world lifecycle observation sufficient for quiescence/recovery semantics.

Exact numeric defaults are implementation/product policy, not architecture.

---

## 7. Candidate acceptance criteria

These criteria are review candidates. They become binding only if this plan is explicitly frozen.

### AC-A5-01 — Fresh non-reusable world generation

Tests prove each activation/recreation/replacement that lacks proven continuity produces a fresh Host-owned `worldGenerationId`. An old or forged generation cannot redirect new execution.

### AC-A5-02 — ProgramAttempt binds exact execution world

A ProgramAttempt execution base durably binds the exact current world generation plus existing observation/effect-generation state. Recreate-same-bytes ABA makes the old Attempt stale even if repository state digest is identical.

### AC-A5-03 — Coherent filesystem/process/observation world

Conformance tests prove filesystem reads/writes, process execution, execution-base observation, and world-state verification all target one exact world generation. A deliberately split provider composition is rejected before execution.

### AC-A5-04 — Host-resolved world binding cannot be Agent-forged

The Agent protocol carries no authority to choose historical/provider-native world handles. Host resolves and validates the current world binding. Adversarial requests cannot select G0 after G1 is current.

### AC-A5-05 — Durable Operation → world reconstruction

Replay reconstructs an exact chain:

```text
ProgramAttempt A? / InferenceEpoch I?
  → Host Operation O
  → execution world X generation G
```

without making G an effect or Program authority fact.

### AC-A5-06 — Provider loss preserves Operation uncertainty

A deterministic fixture loses the provider after a mutating Operation is admitted and may have executed. The Operation remains indeterminate/reconciliation-bound according to existing rules; no provider-loss path fabricates `effect=absent` or success.

### AC-A5-07 — Quiescence semantics survive provider replacement/loss

Mutating capabilities cannot clear writer/quiescence barriers merely because a container/provider stopped. Exact supported proof or recovery evidence is required under the existing Host quiescence contract.

### AC-A5-08 — Mandatory containment controls fail closed

An isolated-profile provider missing one required control (for example network isolation, memory bound, or mount confinement) is rejected before production capability execution. There is no silent isolated→local downgrade.

### AC-A5-09 — Secret-free durable world provenance

World/provider descriptors and Operation provenance contain no raw credentials, authorization headers, secret environment values, or unrestricted environment snapshots. Explicit secret projection remains ephemeral and policy-controlled.

### AC-A5-10 — World-bound verification

A fixture proves a mutation in an isolated world cannot be “verified” by accidentally observing the Host-local copy. World identity mismatch or unsupported observation fails closed.

### AC-A5-11 — Local-provider behavioral equivalence

The A5 local provider passes the existing ProgramAgent/A1/P-02/S-02/A2 product proof surface without changing Host authority, Operation semantics, or Completion behavior.

### AC-A5-12 — Real physical isolation proof

At least one supported isolated provider executes a deterministic coding fixture where:

- workspace mutations occur inside the isolated world;
- undeclared host filesystem access is denied;
- ambient secret/environment access is denied;
- required resource/network policy is enforced according to the selected test profile;
- Host Operations and execution-base re-observation remain correct.

A fake provider alone cannot satisfy this criterion.

### AC-A5-13 — Replacement/restart reconstruction

After Host restart/rebuild, canonical events reconstruct world generations, current/retired/lost state, ProgramAttempt world binding, and Operation→world provenance. Historical world records cannot reactivate a provider or mint execution authority.

### AC-A5-14 — Unsupported provider/platform behavior is explicit

If the selected isolated backend is unavailable on a platform, configuration fails clearly or that provider is declared unsupported. Tests prove the system does not silently execute locally while reporting isolated execution.

### AC-A5-15 — Exact-head product gate

Add one permanent deterministic gate, expected command:

```text
pnpm gate:a5-execution-provider
```

The gate composes focused A5 semantic/adversarial/conformance proofs with the predecessor gates needed to prove no ProgramAttempt/Operation/S-02/A2 regression on the same exact candidate head.

External/cloud services are not blocking CI dependencies. A physically isolated backend used by the blocking gate must be reproducible in the supported CI environment or have an equivalent deterministic platform-specific gate with exact-head evidence.

---

## 8. Candidate adversarial scenarios

### Scenario A — same-bytes world ABA

```text
Attempt A → G0 / digest D
G0 destroyed
G1 created / digest D
A requests mutation
```

Expected: stale before Operation admission because G0 ≠ G1.

### Scenario B — split-world composition

```text
filesystem → G1
process    → G2
observer   → G1
```

Expected: invalid provider composition; no product execution.

### Scenario C — provider disappears after dispatch

```text
Operation O admitted under G1
provider may execute mutation
provider connection/world disappears
```

Expected: Operation truth remains independently indeterminate until reconciliation; G1 loss prevents new work but does not rewrite O.

### Scenario D — reconnect with unproven continuity

Provider returns a handle with the same provider-native name after disconnect.

Expected: fresh Host world generation; old Attempt stale.

### Scenario E — policy ABA

Same content/world name is recreated with materially different mount/network/secret policy.

Expected: fresh effective-policy digest/generation and stale old authority.

### Scenario F — Agent forges a world generation

Agent sends historical or invented world identity through args/protocol metadata.

Expected: ignored/rejected as data; Host-selected current binding is decisive.

### Scenario G — world-state verifier points local

Verifier attempts direct Host-local path observation while Program execution targets isolated G1.

Expected: not accepted as verification of G1; world-bound observation required.

### Scenario H — unsupported network isolation

Policy requires no network, provider reports network control unsupported.

Expected: world activation/use fails closed.

### Scenario I — teardown race with child process

Provider reports top-level command ended while a child continues writing.

Expected: no quiescence proof until exact containment contract establishes child/process-tree termination; writer barrier remains.

### Scenario J — S-02 nested mutation in isolated world

One A2 inference emits `run_code`, which dispatches several nested world-scoped capabilities.

Expected: each subcall remains a separate Host Operation with A2 explicit parentage and the same Host-resolved current execution-world generation. Code Mode does not receive direct provider authority.

### Scenario K — dynamic capability ABA plus world replacement

A dynamic capability provider revision and execution world are both replaced.

Expected: both fences are checked independently. Matching one never revives the other.

### Scenario L — Host restart with lost world

Host crashes while G1 exists; on restart provider continuity cannot be proven.

Expected: G1 is not assumed current merely from historical activation. Host records/derives loss or activates fresh G2, recovers Operations, and requires fresh Attempt authority.

---

## 9. Candidate implementation ownership

A likely ownership split is:

- `@alcode/program-state`: versioned execution-world identity inside execution-base semantics; no provider process code.
- `@alcode/host-runtime`: provider/world lifecycle authority adapter, current-generation fencing, CapabilityBroker binding, durable world/Operation provenance, recovery integration.
- `@alcode/coding-agent` or a new execution-provider package: local and isolated provider implementations plus capability adapters; no canonical Program authority.
- `@alcode/storage`: event/projection support only if needed; canonical events remain source of truth.
- `@alcode/agent-protocol`: no required new Agent authority surface; changes only if product evidence requires read-only bounded world metadata.
- planning/verification adapters: world-bound observation integration where they claim execution-state freshness.

A new package such as `@alcode/execution-provider` is plausible if it produces a cleaner dependency graph, but package creation is reversible and not a frozen requirement.

---

## 10. Candidate implementation slices

A shortest coherent sequence is:

```text
A5-1  execution-world identity + semantic provider contract
      + local provider compatibility adapter

A5-2  ProgramAttempt execution-base binding
      + Host current-world fencing
      + durable Operation→world provenance

A5-3  world-bound execution observation / path verification
      + provider replacement/loss/restart semantics

A5-4  one real isolated provider
      + explicit mount/env/network/resource/secret containment policy

A5-5  S-02/A2/product composition proof
      + adversarial provider-loss/ABA gate
      + as-built closure
```

Slices may be combined if fewer PRs produce a safer atomic change. Intermediate slices must not claim A5 closure.

---

## 11. Required predecessor compatibility

A5 must not regress the following established proofs:

```text
ProgramState / ProgramAttempt
A1 adaptive revision/currentness
P-01 production Agent
P-02 planning + typed verification retry
S-02 Code Mode
A2 inference provenance
Operation uncertainty/reconciliation
workspace locking / recovery
```

The final exact-head A5 gate should compose the minimum permanent predecessor gates that mechanically prove these interactions rather than rerun unrelated historical work solely for ceremony.

---

## 12. Explicit exclusions

A5 does **not** authorize or require:

- multiple simultaneous execution worlds in one Workspace;
- Git-worktree parallelism;
- subagents/delegation;
- remote worker leases or distributed scheduling;
- multi-machine canonical Host authority;
- procedure learning/promotion;
- a semantic software graph;
- browser execution;
- a second model provider;
- `graph-v1` promotion;
- direct Agent/provider-native sandbox controls;
- arbitrary ambient OS/network authority for Code Mode;
- replacing CapabilityBroker with provider RPC;
- treating container/VM rollback as generic proof of effect absence;
- persisting raw secrets for reproducibility;
- choosing a specific container/VM vendor as a constitutional dependency;
- making isolated execution the product default without a separate explicit product decision.

---

## 13. Failure / rollback rule

Reversible mechanisms include:

- interface/package names;
- exact lifecycle event names;
- whether world/provider descriptors use one or several digests;
- concrete local adapter structure;
- selected first isolated backend technology;
- exact policy field names/defaults;
- projection/index strategy;
- implementation PR slicing.

A demonstrated blocker may change those mechanisms while preserving the semantic requirements.

Do **not** solve implementation difficulty by:

- moving Program or Operation authority into the provider;
- accepting Agent-supplied world identity as execution authority;
- reusing a world generation after unproven replacement/reconnect;
- treating matching repository bytes as proof of physical-world continuity;
- allowing filesystem/process/verification observation to silently address different worlds;
- silently weakening mandatory containment controls;
- making provider loss mean mutation absence;
- bypassing existing quiescence/reconciliation;
- weakening local predecessor semantics to fit a generic provider API.

---

## 14. Candidate completion definition

If this plan is later approved/frozen, A5 would be complete only when:

1. the frozen A5 acceptance criteria pass on one exact candidate head;
2. local execution remains behaviorally compatible with the closed predecessor product path;
3. one real isolated provider proves physical containment under an explicit supported profile;
4. execution-base currentness includes exact world generation and defeats recreate-same-bytes ABA;
5. filesystem/process/world-state verification are mechanically coherent under one world generation;
6. provider loss/replacement preserves ordinary Operation uncertainty, quiescence, and reconciliation;
7. durable replay reconstructs world lifecycle and Operation→world provenance without resurrecting authority;
8. S-02 nested calls and A2 inference causality continue to route through ordinary Host Operations into the selected world; and
9. the permanent exact-head A5 gate plus declared predecessor compatibility checks pass.

Successful A5 closure would establish **physical execution-provider isolation under Host authority**. It would not authorize procedures, parallel workspaces, subagents, remote execution, or autonomous scheduling.

---

## 15. Candidate review questions

Before freeze, review should explicitly answer:

1. Is `worldId + worldGenerationId` necessary, or is one non-reusable generation identity sufficient?
2. Which containment-policy changes are identity/currentness relevant versus ordinary provider configuration?
3. Should world lifecycle events be workspace-canonical even for local provider activation, or can deterministic local generation be derived safely?
4. What is the minimal continuity proof, if any, that permits reconnect without fresh generation?
5. Which planning reads must be world-bound in A5 versus deferred to provider-specific support?
6. Is `TerminalCapability` sufficient as the semantic process surface, or should A5 introduce a richer subprocess capability while preserving the model-facing `bash` tool?
7. Which existing local process supervisor should be canonicalized behind the local provider to avoid duplicate process-lifecycle implementations?
8. What exact isolated profile is required for closure on CI, independent of backend vendor?
9. Does world replacement require immediate Attempt retirement events, or is failing currentness on next admission plus recovery sufficient?
10. Which world metadata is safe/useful to expose to the Experience Plane without creating a control path?

These are design-review questions, not permission to broaden A5 beyond the bounded objective above.
