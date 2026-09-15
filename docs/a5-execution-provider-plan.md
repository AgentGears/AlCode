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
Host Operation + immutable generation-bound execution binding
        ↓
provider execution in that exact generation
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

> **All capability execution and observations that claim to address one execution world must bind to the same exact, Host-owned, non-reusable execution-world generation.**

A third invariant is:

> **Provider lifecycle observation is epistemic evidence, not synthetic truth: activation, teardown, provider loss, and Operation effects remain separately represented whenever occurrence is uncertain.**

---

## 2. Authority boundary

A5 adds a physical execution substrate below existing Host authority.

```text
ProgramState / ProgramRevision
        ↓
ProgramAttempt authority
        ↓
Host currentness + execution-world generation fence
        ↓
CapabilityBroker / verification control
        ↓
Host Operation identity
        ↓
immutable generation-bound execution binding
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
- select a successor generation for an already-admitted Operation;
- convert provider/process status directly into effect truth;
- satisfy verification on its own authority;
- complete a Program;
- expose a provider/world handle to the Agent as an execution token.

---

## 3. Bounded design-review corrections incorporated

The first candidate review produced three bounded corrections. They are incorporated throughout this version and are part of the candidate contract.

### R1 — Use one Host-owned non-reusable generation identity, not `worldId + worldGenerationId`

A5 permits one current execution world per existing `workspaceId`. A second stable logical-world identity would add another durable identity without an independently required semantic subject.

The candidate therefore uses:

```text
workspaceId
providerKind
executionWorldGenerationId
providerDescriptorDigest
effectivePolicyDigest
```

A7 may later create multiple concurrent Workspace/worktree execution domains with their own Workspace identities. A5 does not pre-allocate that identity model.

### R2 — Activation and teardown have uncertainty windows

Provider world creation/activation and provider teardown are environmental effects. Host loss can occur after a provider request but before durable positive evidence is recorded.

A5 therefore uses prepare → provider action → positive evidence semantics. Missing evidence remains unknown. A prepared activation is not equivalent to a proven provider invocation or a proven active world; a teardown request is not equivalent to proven closure.

### R3 — Operation execution captures an immutable generation-bound binding

A currentness check at Operation admission is insufficient if provider replacement can race between `operation.started` and `capability.execute()`.

Each admitted world-scoped Operation must capture a Host-internal execution binding to the exact generation admitted for that Operation. The binding cannot transparently migrate to a successor generation. If the captured generation becomes unavailable, the Operation fails or remains uncertainty/reconciliation-bound according to existing semantics; it is never rebound to a replacement generation.

---

## 4. Candidate semantic decisions

### D1 — Add one Host-owned execution-world generation identity

Each physical execution world admitted by ALCODE is represented by one Host-owned, non-reusable generation identity.

Conceptually:

```ts
interface ExecutionWorldIdentityV1 {
  workspaceId: string;
  providerKind: string;
  executionWorldGenerationId: string;
  effectivePolicyDigest: string;
  providerDescriptorDigest: string;
}
```

Exact field names are reversible. Required semantics are not:

- `workspaceId` retains its existing durable ALCODE meaning;
- `executionWorldGenerationId` is fresh and never reused after retirement, loss, failed/uncertain activation, or recreation unless a later frozen continuity rule explicitly proves the same generation never ceased to be the same physical world;
- material policy/provider changes that cannot prove semantic continuity create a fresh generation;
- provider-native container/VM/session IDs are optional provenance and never substitute for the Host generation identity;
- no second durable `worldId` is required by A5.

The generation identity is not a capability token. Current Host authority is always required separately.

### D2 — Bind ProgramAttempt execution base to exact generation

`ProgramAttemptExecutionBase` must include or reference the exact execution-world generation in addition to the existing Host `workspaceEffectGeneration` and observed state.

Conceptually:

```text
ProgramAttemptExecutionBase
  executionWorld
    workspaceId
    providerKind
    executionWorldGenerationId
    providerDescriptorDigest
    effectivePolicyDigest
  workspaceEffectGeneration
  observation
    coverageDigest
    stateDigest
    ...
```

Currentness therefore means both:

1. the same exact execution-world generation is current; and
2. the observed execution state is current according to existing execution-base rules.

Identical repository bytes in a replacement generation do not preserve an old Attempt.

### D3 — One Host-owned provider/world owner binds coherent services

Introduce a `WorkspaceExecutionProvider`-class semantic boundary that creates/adopts one execution-world generation and supplies the services that must be coherent for that generation.

Candidate shape:

```ts
interface WorkspaceExecutionProviderV1 {
  descriptor(): ExecutionProviderDescriptorV1;
  prepareActivation(input: ExecutionWorldActivationV1): Promise<ExecutionProviderActivationHandleV1>;
  discover?(input: ExecutionWorldDiscoveryV1): Promise<ExecutionWorldDiscoveryResultV1>;
}

interface ExecutionWorldV1 {
  identity: ExecutionWorldIdentityV1;
  filesystem: FilesystemCapability;
  process: TerminalCapability | ProcessCapability;
  observeExecutionBase(): Promise<...>;
  observePath?(...): Promise<...>;
  requestClose(): Promise<ExecutionWorldCloseObservationV1>;
}
```

The exact package and interface split is implementation-owned. What matters is the coherence rule: filesystem/process/world-current observations that claim the same generation must be generation-bound services supplied by the same Host-resolved world owner.

### D4 — Keep subsystem-specific providers beneath one coherent world

A5 should not force filesystem, subprocess, semantic observation, and future browser execution into one lowest-common-denominator executor.

A world owner may compose subsystem-specific adapters, consistent with APR-034, provided all authority-sensitive world-scoped services are bound to the same exact execution-world generation.

Example:

```text
ExecutionWorld G7
   ├─ filesystem adapter      ┐
   ├─ process adapter         │ exact same G7 binding
   ├─ path-state observer     │
   └─ execution-base observer ┘
```

The Host rejects a composition whose adapters cannot establish a common exact generation.

### D5 — Host selects/fences the current generation; Agent never selects it

The Agent continues to see semantic tools such as `read`, `write`, `edit`, `bash`, etc. It does not send a container ID, VM ID, SSH handle, provider ID, or execution-world generation as authority.

At capability admission the Host resolves the current execution-world generation and validates it against ProgramAttempt authority when Program-backed.

For non-Program work, the Host still binds any world-scoped Operation to the exact current generation used for execution.

Historical or Agent-invented world identifiers in arguments are ordinary untrusted data and cannot redirect execution.

### D6 — Operation admission captures an immutable generation-bound execution binding

When a world-scoped Operation is admitted, the Host captures a generation-specific execution binding for the exact admitted generation.

Conceptually:

```text
admission cut
  current generation = G0
  ProgramAttempt current for G0? yes
  Host Operation O minted
  durable O → G0 provenance appended
  internal execution binding = provider binding for G0
        ↓
provider replacement may make current generation G1
        ↓
O still executes only through captured G0 binding
```

The binding:

- is Host-internal and non-serializable as Agent authority;
- is generation-specific, not a lookup of “whatever is current” at execution time;
- cannot migrate to G1 if G0 is retired/replaced;
- may become unusable if G0 is lost;
- does not by itself prove provider invocation or environmental effect occurrence.

If G0 becomes unavailable after admission, ordinary Operation uncertainty/reconciliation semantics decide closure. The Host must not execute O against G1 merely to preserve availability.

### D7 — Durable Operation provenance records exact generation

For every world-scoped Host Operation, `operation.requested` or an equivalent same-admission durable fact records bounded execution-world provenance sufficient to reconstruct which physical generation was targeted.

At minimum:

```text
providerKind
executionWorldGenerationId
providerDescriptorDigest
effectivePolicyDigest
```

Provider-native instance IDs may be recorded when safe and bounded but are optional.

World provenance explains where execution was admitted. It does not prove the effect happened.

### D8 — World lifecycle is Host-canonical, uncertainty-aware, and rebuildable

A5 records enough lifecycle facts to reconstruct generation state without inventing provider certainty.

Candidate semantic states:

```text
prepared
active
retiring
closed
lost_or_unknown
```

Candidate lifecycle evidence may use events such as:

```text
execution.world.activation.prepared
execution.world.activation.observed
execution.world.retirement.requested
execution.world.closure.observed
execution.world.lost
```

Exact event spelling is reversible. The epistemic rules are not.

Activation protocol:

```text
Host chooses provider + effective policy
        ↓
Host mints fresh generation G
        ↓
durable activation.prepared(G)
        ↓
provider activation/create/adopt attempt
        ↓
positive generation-bound provider evidence?
   yes → durable activation.observed(G) → G may become current/active
   no / Host loss → activation occurrence remains indeterminate
```

If the Host loses ownership after `activation.prepared` but before positive evidence, restart must discover/reconcile before blindly creating a conflicting successor. Historical preparation alone never proves that a provider world exists.

Teardown protocol:

```text
G active/retiring
        ↓
durable retirement/close request
        ↓
provider teardown attempt
        ↓
positive closure evidence?
   yes → durable closure.observed(G) → closed
   no / Host loss → closure remains unknown/lost; G is fenced from new work
```

Transport loss, timeout, process exit, or a returned error does not synthesize closure evidence.

Do not create an independently mutable provider database that can diverge from canonical Workspace history.

### D9 — Replacement/reconnect is a freshness cut

An execution-world generation is non-reusable.

If a provider is recreated, replaced, or reconnected and cannot prove continuity at the semantic strength required by ALCODE, the Host uses a fresh generation. Existing ProgramAttempts bound to the old generation become stale.

Provider-native “same container name,” “same remote session,” “same mount path,” or identical repository bytes are not enough.

A provider may support stronger continuity only if the later frozen contract defines bounded, testable evidence for it. The safe default is fresh generation.

### D10 — Preserve existing Operation uncertainty semantics

Provider lifecycle and Operation effect truth remain separate.

```text
provider lost
  ≠ operation absent

activation prepared
  ≠ provider activation definitely occurred

teardown requested
  ≠ world definitely closed

container exited
  ≠ mutation definitely quiesced

provider returned error
  ≠ effect absent
```

Existing execution outcome, effect status, reconciliation status, writer barriers, and quiescence proof semantics remain authoritative.

Provider-specific reconciliation may inspect the generation or external evidence, but the Host owns the durable resolution.

### D11 — Extend, do not replace, quiescence contracts

A5 may add execution-world provenance to operation-scoped containment and recovery evidence, but should reuse the existing quiescence model.

A mutating world-scoped capability that requires operation-scoped containment must still produce the exact Host-validated proof for its containment instance. World shutdown alone does not synthesize that proof unless the frozen provider contract proves that the exact relevant containment ended.

The generation-bound execution binding from D6 and quiescence containment identity are independent fences. Matching one never substitutes for the other.

### D12 — Define explicit containment policy profiles

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

The provider exposes a bounded semantic descriptor of which controls it can enforce. The Host validates the selected policy against provider support before activation/use.

Mandatory unsupported controls fail closed; they are never silently downgraded.

The existing local provider may use an explicitly named local/trusted profile and must not be described as hostile-code isolation.

### D13 — Secrets remain Host-controlled and non-durable in raw form

Execution-world descriptors, policy digests, lifecycle events, and Operation provenance must be secret-free.

If a capability requires a secret in an isolated world:

- Host policy decides whether projection is permitted;
- the provider receives the secret only through an explicit ephemeral mechanism;
- raw secret values are not persisted in world descriptors/events;
- environment inheritance is deny-by-default or explicitly bounded by the selected profile;
- world teardown must not be treated as proof that an externally exposed credential is safe; existing incident rules remain applicable.

A5 does not create a general secret manager product.

### D14 — World-bound verification must observe the same generation

Any verifier that claims filesystem/process state from the execution world must bind its observation or verifier Operation to the same exact generation as the ProgramAttempt being verified.

The existing direct local path observer must therefore be abstracted behind a world-bound observation seam for isolated execution.

Host verifier definitions remain canonical. Provider/world observation is evidence only.

### D15 — Planning observations remain distinct from execution authority

A5 does not automatically move every planning/semantic observation into the execution provider.

Rules:

- raw filesystem planning reads that must reflect the execution world should use the world-bound filesystem seam;
- semantic CodeIntelligence may remain a separate provider only when it can establish freshness/provenance against the exact current execution world/base;
- if that freshness cannot be established for an isolated backend, the semantic capability is unavailable or explicitly incomplete/stale rather than silently reading a different local copy;
- planning evidence never becomes execution authority.

This preserves APR-042 without turning A5 into a semantic-graph objective.

### D16 — Local provider is the compatibility oracle

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

The local provider must use the same generation/lifecycle semantics. A synchronous local activation may immediately produce positive evidence, but it must not create a second implicit identity/currentness model.

### D17 — One real isolated backend is required for A5 closure

A provider interface proven only by mocks does not establish physical isolation.

A5 closure therefore requires:

- the production local provider; and
- at least one production-capable physically isolated provider on an explicitly supported platform.

The specific backend technology is an implementation choice, not part of this candidate architecture contract. Unsupported platforms/backends must fail clearly rather than falling back from isolated to local execution without explicit user/Host policy.

Local execution remains the product default unless a separate product decision promotes an isolated provider to default.

### D18 — A5 does not introduce remote execution protocol semantics

An isolated provider may happen to use a local daemon/API internally, but A5 does not freeze general remote-worker leases, distributed claims, network retry identity, or multi-machine Host authority.

Those remain A9 concerns.

If a chosen isolated backend is reached over an API, its transport is an implementation detail beneath the same A5 generation/lifecycle contract; loss still follows ordinary uncertainty rules.

### D19 — A5 does not add parallel execution domains

A5 establishes the identity/containment contract for one current execution-world generation per Workspace at a time.

A7 may later create multiple isolated Workspace identities/worktrees and execute them concurrently. A5 must not weaken the existing one-writer-per-Workspace rule merely to demonstrate provider substitution.

---

## 5. Candidate lifecycle

Normal activation and execution:

```text
Host opens locked Workspace W
        ↓
Host selects execution provider P + requested containment policy C
        ↓
P descriptor proves support; Host derives effective policy E
        ↓
Host mints fresh generation G
        ↓
Host durably records activation prepared for (W, P, G, E)
        ↓
provider activates/creates/adopts physical world for G
        ↓
Host receives positive generation-bound activation evidence
        ↓
Host durably records G active/current
        ↓
world-bound execution-base observation B
        ↓
ProgramAttempt A issued against (W, G, B)
        ↓
Agent inference / capability proposal
        ↓
Host validates A + capability + current G
        ↓
Host admits Operation O with durable G provenance
        ↓
Host captures immutable G execution binding for O
        ↓
world-bound capability executes through captured G binding
        ↓
provider result / quiescence evidence / possible uncertainty
        ↓
Host settles O using existing effect rules
        ↓
world-bound re-observation under same current G
        ↓
verification / retry / successor / Completion
```

Activation crash window:

```text
activation.prepared(G0) durable
        ↓
provider activation may or may not occur
        ↓
Host ownership lost before positive evidence
        ↓
G0 activation occurrence = indeterminate
        ↓
restart discovery/reconciliation required
        ↓
only positive evidence may adopt/close G0;
otherwise a safe fresh successor is created only after conflict is resolved
```

Replacement:

```text
G0 active
  ↓ provider replacement/loss/recreation
G0 fenced from new work
  ↓
old Attempts referencing G0 are stale
  ↓
any already-admitted O@G0 remains bound to G0 and settles independently
  ↓
fresh G1 activation protocol
  ↓
fresh observation
  ↓
fresh Attempt if Program work remains
```

Teardown crash window:

```text
G0 retirement/close requested durably
        ↓
provider teardown may or may not complete
        ↓
Host ownership lost before closure evidence
        ↓
G0 closure = indeterminate
        ↓
restart discovery/reconciliation
```

Historical lifecycle records never create new provider authority.

---

## 6. Candidate domain/protocol changes

### 6.1 ProgramState execution base

Extend the execution-base shape with one bounded execution-world generation reference/snapshot.

Historical Attempt bases remain immutable. Migration/versioning must preserve existing local histories rather than reinterpret old records as isolated-world claims.

### 6.2 Host execution-provider service

Add one Host-owned service/registry responsible for:

- provider selection;
- descriptor and containment-policy validation;
- fresh generation minting;
- durable activation preparation;
- provider activation/adoption observation;
- current-generation lookup/fencing;
- generation-specific execution binding capture;
- retirement/close requests;
- discovery/reconciliation after uncertain activation/closure/loss;
- world-bound capability/observation access.

It is an authority **adapter**, not a second Program scheduler, Operation store, or effect oracle.

### 6.3 CapabilityBroker integration

For world-scoped capabilities, the Host admission cut:

1. resolves the current generation;
2. validates ProgramAttempt generation currentness when Program-backed;
3. mints the ordinary Host Operation;
4. persists exact Operation→generation provenance in the same protected admission path; and
5. captures the exact generation-bound provider execution binding used by that Operation.

The Agent supplies none of these authority fields.

The execution phase uses the captured binding, not a later “current provider” lookup.

### 6.4 Execution observation

Replace or adapt the free-standing production `ProgramExecutionObservationSourceV1` so an authority-bearing execution-base observation is explicitly bound to one exact execution-world generation.

An observation may still become `unknown`; provider unavailability must not fabricate a stale-as-current base.

### 6.5 Verification/path observation

World-state verifiers use a generation-bound observation interface rather than direct Host-local paths when the selected execution world is isolated.

Operation-result verifiers continue through ordinary CapabilityBroker/Operation execution and inherit the exact generation binding of their Host-generated verifier Operation. Host verifier work is not falsely attributed to a model inference merely because it verifies model-caused work.

### 6.6 Planning reads

Raw planning reads should be sourced from the active execution world where execution-world freshness matters. Optional semantic providers such as CodeIntelligence require an explicit freshness bridge to the same generation/base or become unavailable/incomplete for that provider.

### 6.7 Durable lifecycle projection

A Host rebuild must derive at least:

```text
per generation:
  workspaceId
  providerKind
  providerDescriptorDigest
  effectivePolicyDigest
  lifecycle state
  activation preparation evidence
  positive activation evidence, if any
  retirement/close request, if any
  positive closure evidence, if any
  loss/unknown state, if any

per Workspace:
  exact current active generation, or none/unknown
```

Projection replay cannot contact a provider, create a world, mark a world active, or mint authority.

### 6.8 Application / Agent Protocol

No new Agent authority field is required merely to implement A5. Provider selection and generation identity remain Host-side unless a later product requirement needs safe read-only exposure.

The Application Protocol may later expose a bounded execution-environment status snapshot, but A5 closure does not require clients to select provider-native IDs or manipulate lifecycle directly.

---

## 7. Candidate containment contract

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

## 8. Candidate acceptance criteria

These criteria are review candidates. They become binding only if this plan is explicitly frozen.

### AC-A5-01 — Fresh non-reusable execution-world generation

Tests prove each activation/recreation/replacement that lacks proven continuity uses a fresh Host-owned `executionWorldGenerationId`. An old or forged generation cannot redirect new execution.

### AC-A5-02 — ProgramAttempt binds exact execution-world generation

A ProgramAttempt execution base durably binds the exact current generation plus existing observation/effect-generation state. Recreate-same-bytes ABA makes the old Attempt stale even if repository state digest is identical.

### AC-A5-03 — Coherent filesystem/process/observation generation

Conformance tests prove filesystem reads/writes, process execution, execution-base observation, and world-state verification all target one exact generation. A deliberately split provider composition is rejected before execution.

### AC-A5-04 — Host-resolved generation cannot be Agent-forged

The Agent protocol carries no authority to choose historical/provider-native world handles. Host resolves and validates the current generation. Adversarial requests cannot select G0 after G1 is current.

### AC-A5-05 — Immutable admitted Operation→generation binding

A deterministic race test admits O while G0 is current, switches the Workspace current generation to G1 before provider execution, and proves O either executes only through its captured G0 binding or fails/remains uncertainty-bound. O must never execute through G1.

Replay reconstructs the durable chain:

```text
ProgramAttempt A? / InferenceEpoch I?
  → Host Operation O
  → executionWorldGenerationId G0
```

without making G0 an effect or Program authority fact.

### AC-A5-06 — Activation uncertainty is represented honestly

A deterministic fixture persists activation preparation, allows the provider activation request to occur or possibly occur, then loses Host ownership before positive evidence is durable.

After restart, the generation is not assumed active or absent. Discovery/reconciliation is required before conflicting activation. Historical preparation alone cannot mark the generation current.

### AC-A5-07 — Teardown uncertainty is represented honestly

A deterministic fixture requests provider teardown and loses Host ownership before positive closure evidence is durable.

After restart, the world is not marked closed merely because teardown was requested, transport ended, or the provider returned an error. Positive closure evidence or bounded reconciliation is required.

### AC-A5-08 — Provider loss preserves Operation uncertainty

A deterministic fixture loses the provider after a mutating Operation is admitted and may have executed. The Operation remains indeterminate/reconciliation-bound according to existing rules; no provider-loss path fabricates `effect=absent` or success.

### AC-A5-09 — Quiescence semantics survive provider replacement/loss

Mutating capabilities cannot clear writer/quiescence barriers merely because a container/provider stopped. Exact supported proof or recovery evidence is required under the existing Host quiescence contract.

### AC-A5-10 — Mandatory containment controls fail closed

An isolated-profile provider missing one required control (for example network isolation, memory bound, or mount confinement) is rejected before production capability execution. There is no silent isolated→local downgrade.

### AC-A5-11 — Secret-free durable world provenance

World/provider descriptors, lifecycle evidence, and Operation provenance contain no raw credentials, authorization headers, secret environment values, or unrestricted environment snapshots. Explicit secret projection remains ephemeral and policy-controlled.

### AC-A5-12 — World-bound verification

A fixture proves a mutation in an isolated generation cannot be “verified” by accidentally observing the Host-local copy or a different generation. Generation mismatch or unsupported observation fails closed.

### AC-A5-13 — Local-provider behavioral equivalence

The A5 local provider passes the existing ProgramAgent/A1/P-02/S-02/A2 product proof surface without changing Host authority, Operation semantics, verification, recovery, or Completion behavior.

### AC-A5-14 — Real physical isolation proof

At least one supported isolated provider executes a deterministic coding fixture where:

- workspace mutations occur inside the isolated world;
- undeclared host filesystem access is denied;
- ambient secret/environment access is denied;
- required resource/network policy is enforced according to the selected test profile;
- Host Operations and execution-base re-observation remain correct.

A fake provider alone cannot satisfy this criterion.

### AC-A5-15 — Replacement/restart reconstruction

After Host restart/rebuild, canonical events reconstruct generation identity, active/retired/closed/lost-or-unknown state, ProgramAttempt binding, activation/teardown uncertainty, and Operation→generation provenance.

Historical generation records cannot reactivate a provider, mark uncertain activation as successful, or mint execution authority.

### AC-A5-16 — Unsupported provider/platform behavior is explicit

If the selected isolated backend is unavailable on a platform, configuration fails clearly or that provider is declared unsupported. Tests prove the system does not silently execute locally while reporting isolated execution.

### AC-A5-17 — Exact-head product gate

Add one permanent deterministic gate, expected command:

```text
pnpm gate:a5-execution-provider
```

The gate composes focused A5 semantic/adversarial/conformance proofs with the predecessor gates needed to prove no ProgramAttempt/Operation/S-02/A2 regression on the same exact candidate head.

External/cloud services are not blocking CI dependencies. A physically isolated backend used by the blocking gate must be reproducible in the supported CI environment or have an equivalent deterministic platform-specific gate with exact-head evidence.

---

## 9. Candidate adversarial scenarios

### Scenario A — same-bytes generation ABA

```text
Attempt A → G0 / digest D
G0 destroyed or lost
G1 created / digest D
A requests mutation
```

Expected: stale before Operation admission because G0 ≠ G1.

### Scenario B — split-generation composition

```text
filesystem → G1
process    → G2
observer   → G1
```

Expected: invalid provider composition; no product execution.

### Scenario C — provider disappears after Operation admission

```text
Operation O admitted under G1
provider may execute mutation
provider connection/world disappears
```

Expected: Operation truth remains independently indeterminate until reconciliation; G1 loss prevents new work but does not rewrite O.

### Scenario D — reconnect with unproven continuity

Provider returns a handle with the same provider-native name after disconnect.

Expected: fresh Host generation unless frozen continuity evidence proves the exact physical world never changed; old Attempt otherwise stale.

### Scenario E — policy ABA

Same content/provider-native world name is recreated with materially different mount/network/secret policy.

Expected: fresh effective-policy digest and, absent proven continuity under the frozen identity rule, fresh generation and stale old authority.

### Scenario F — Agent forges a generation

Agent sends historical or invented world identity through args/protocol metadata.

Expected: ignored/rejected as data; Host-selected current generation is decisive.

### Scenario G — world-state verifier points local

Verifier attempts direct Host-local path observation while Program execution targets isolated G1.

Expected: not accepted as verification of G1; exact generation-bound observation required.

### Scenario H — unsupported network isolation

Policy requires no network, provider reports network control unsupported.

Expected: activation/use fails closed.

### Scenario I — teardown race with child process

Provider reports top-level command ended while a child continues writing.

Expected: no quiescence proof until the exact containment contract establishes child/process-tree termination; writer barrier remains.

### Scenario J — S-02 nested mutation in isolated generation

One A2 inference emits `run_code`, which dispatches several nested world-scoped capabilities.

Expected: each subcall remains a separate Host Operation with A2 explicit parentage and the same Host-resolved current execution-world generation. Code Mode does not receive direct provider authority.

### Scenario K — dynamic capability ABA plus world replacement

A dynamic capability provider revision and execution-world generation are both replaced.

Expected: both fences are checked independently. Matching one never revives the other.

### Scenario L — Host restart with lost active generation

Host crashes while G1 exists; on restart provider continuity cannot be proven.

Expected: G1 is not assumed current merely from historical activation. Host discovers/reconciles; if continuity is not proven, G1 is fenced/lost and any successor uses a fresh generation. Operations recover independently.

### Scenario M — activation prepared, Host lost before activation evidence

```text
activation.prepared(G0)
provider activation request may have occurred
Host lost
```

Expected: G0 occurrence is indeterminate. Restart cannot mark G0 active or create a conflicting G1 until discovery/reconciliation resolves the activation conflict sufficiently for safe progress.

### Scenario N — teardown requested, Host lost before closure evidence

```text
retirement.requested(G0)
provider teardown may have occurred
Host lost
```

Expected: G0 is fenced from new work but not marked closed. Restart discovery/reconciliation establishes closure or retains lost/unknown state.

### Scenario O — generation replacement races admitted Operation execution

```text
G0 current
O admitted and durably bound to G0
G1 becomes current before O calls provider
```

Expected: O executes only through captured G0 binding or fails/remains uncertainty-bound. It never transparently executes in G1.

---

## 10. Candidate implementation ownership

A likely ownership split is:

- `@alcode/program-state`: versioned execution-world generation identity inside execution-base semantics; no provider process code.
- `@alcode/host-runtime`: provider/world lifecycle authority adapter, uncertainty-aware activation/teardown, current-generation fencing, generation-bound Operation binding, durable world/Operation provenance, recovery integration.
- `@alcode/coding-agent` or a new execution-provider package: local and isolated provider implementations plus capability adapters; no canonical Program authority.
- `@alcode/storage`: event/projection support only if needed; canonical events remain source of truth.
- `@alcode/agent-protocol`: no required new Agent authority surface; changes only if product evidence requires read-only bounded world metadata.
- planning/verification adapters: world-bound observation integration where they claim execution-state freshness.

A new package such as `@alcode/execution-provider` is plausible if it produces a cleaner dependency graph, but package creation is reversible and not a frozen requirement.

---

## 11. Candidate implementation slices

A shortest coherent sequence is:

```text
A5-1  execution-world generation identity
      + provider contract
      + uncertainty-aware activation/teardown lifecycle
      + local provider compatibility adapter

A5-2  ProgramAttempt execution-base binding
      + Host current-generation fencing
      + immutable admitted Operation→generation execution binding
      + durable Operation→generation provenance

A5-3  world-bound execution observation / path verification
      + provider replacement/loss/restart discovery and reconciliation

A5-4  one real isolated provider
      + explicit mount/env/network/resource/secret containment policy

A5-5  S-02/A2/product composition proof
      + adversarial activation/teardown/loss/ABA gate
      + as-built closure
```

Slices may be combined if fewer PRs produce a safer atomic change. Intermediate slices must not claim A5 closure.

---

## 12. Required predecessor compatibility

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

## 13. Explicit exclusions

A5 does **not** authorize or require:

- multiple simultaneous execution worlds in one Workspace;
- a second stable logical `worldId` in addition to the generation identity;
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
- treating provider activation preparation as proof the provider world exists;
- treating teardown request/transport loss as proof the world is closed;
- transparently rebinding an admitted Operation to a successor generation;
- treating container/VM rollback as generic proof of effect absence;
- persisting raw secrets for reproducibility;
- choosing a specific container/VM vendor as a constitutional dependency;
- making isolated execution the product default without a separate explicit product decision.

---

## 14. Failure / rollback rule

Reversible mechanisms include:

- interface/package names;
- exact lifecycle event names;
- whether provider descriptors use one or several digests;
- concrete local adapter structure;
- selected first isolated backend technology;
- exact policy field names/defaults;
- projection/index strategy;
- implementation PR slicing.

A demonstrated blocker may change those mechanisms while preserving the semantic requirements.

Do **not** solve implementation difficulty by:

- moving Program or Operation authority into the provider;
- accepting Agent-supplied generation identity as execution authority;
- reusing a generation after unproven replacement/reconnect;
- treating matching repository bytes as proof of physical-world continuity;
- allowing filesystem/process/verification observation to silently address different generations;
- treating activation preparation as positive activation evidence;
- treating teardown request or transport/process loss as positive closure evidence;
- allowing an admitted Operation to execute through a successor generation;
- silently weakening mandatory containment controls;
- making provider loss mean mutation absence;
- bypassing existing quiescence/reconciliation;
- weakening local predecessor semantics to fit a generic provider API.

---

## 15. Candidate completion definition

If this plan is later approved/frozen, A5 would be complete only when:

1. the frozen A5 acceptance criteria pass on one exact candidate head;
2. local execution remains behaviorally compatible with the closed predecessor product path;
3. one real isolated provider proves physical containment under an explicit supported profile;
4. execution-base currentness includes exact execution-world generation and defeats recreate-same-bytes ABA;
5. filesystem/process/world-state verification are mechanically coherent under one generation;
6. every admitted world-scoped Operation is durably correlated to and internally executed through its exact immutable generation-bound binding;
7. activation and teardown crash windows preserve uncertainty until positive evidence/reconciliation resolves them;
8. provider loss/replacement preserves ordinary Operation uncertainty, quiescence, and reconciliation;
9. durable replay reconstructs lifecycle and Operation→generation provenance without resurrecting authority;
10. S-02 nested calls and A2 inference causality continue to route through ordinary Host Operations into the selected generation; and
11. the permanent exact-head A5 gate plus declared predecessor compatibility checks pass.

Successful A5 closure would establish **physical execution-provider isolation under Host authority**. It would not authorize procedures, parallel workspaces, subagents, remote execution, or autonomous scheduling.

---

## 16. Candidate review questions after bounded correction

The first review questions concerning identity multiplicity, lifecycle uncertainty, and Operation rebinding are resolved by R1–R3 above. Before freeze, review should still explicitly answer:

1. Which containment-policy changes are identity/currentness relevant versus ordinary provider configuration?
2. What is the minimal positive activation evidence contract for local and isolated providers?
3. What bounded discovery/reconciliation evidence is sufficient to resolve an activation that was prepared before Host loss?
4. What positive closure evidence is sufficient to mark a generation closed rather than `lost_or_unknown`?
5. What is the minimal continuity proof, if any, that permits reconnect without a fresh generation?
6. Which planning reads must be world-bound in A5 versus deferred to provider-specific support?
7. Is `TerminalCapability` sufficient as the semantic process surface, or should A5 introduce a richer subprocess capability while preserving the model-facing `bash` tool?
8. Which existing local process supervisor should be canonicalized behind the local provider to avoid duplicate process-lifecycle implementations?
9. What exact isolated profile is required for closure on CI, independent of backend vendor?
10. Does generation replacement require immediate Attempt retirement events, or is failing currentness on next admission plus recovery sufficient?
11. Which generation/provider metadata is safe/useful to expose to the Experience Plane without creating a control path?

These are design-review questions, not permission to broaden A5 beyond the bounded objective above.
