# A5 — Sandboxed Execution Providers / Physical Execution-Provider Isolation — Gap Study

**Status:** FORCING / GAP STUDY — no implementation authority  
**Study date:** 2026-09-15  
**Repository baseline:** `main@79e8950e5d09273e1446429b793ba526f2453822`  
**Baseline tree:** `d8730634f41fc77b868359bb05b4f0b239c3df13`  
**Predecessors:** Phase 1.0/1.1, S-01, P-01, A1, P-02, S-02, A2/S-04  
**Purpose:** Determine whether the current local execution composition has a real forcing gap that justifies a provider-neutral physical execution-world boundary before procedures, parallel workspaces, delegation, and remote execution.  
**Authority:** This study may establish need and constrain a later design. It does **not** freeze an A5 contract, select a sandbox technology, or authorize production implementation.

---

## 1. Executive finding

The A5 adoption trigger is met.

ALCODE already has strong **logical execution authority**:

- ProgramAttempt currentness and execution-base freshness;
- Host-owned capability admission;
- durable Operation identity;
- explicit effect uncertainty and reconciliation;
- writer/quiescence barriers;
- typed verification and Completion authority;
- replaceable Agent generations;
- S-02 bounded local orchestration;
- A2 reconstructable inference causality.

What it does **not** yet have is one first-class Host-owned identity and contract for the **physical execution world** in which filesystem observation, filesystem mutation, subprocess execution, verification observation, and later isolated/remote execution occur.

The production CLI currently constructs these concerns next to one another from the same local root, but their coherence is a composition convention rather than a mechanically enforced runtime invariant:

```text
local root
  ├─ LocalWorkspace.filesystem
  ├─ bash workingDirectory
  ├─ execution-base observer
  ├─ verifier path observer
  ├─ planning reads / CodeIntelligence
  └─ Host capability adapters
```

That is sufficient for the closed single-local-workspace product, because all pieces are composed inside one process around one local path. It is not a sufficient contract for adding an isolated container, VM, remote sandbox, or replaceable execution backend. A future backend could otherwise satisfy each interface individually while accidentally splitting filesystem/process/observation semantics across different worlds, or could reconnect/recreate a world without making the old ProgramAttempt stale.

The forcing requirement is therefore:

> **ALCODE needs a Host-owned execution-world/provider contract that makes the exact world used for observation, filesystem/process capability execution, freshness, containment, and teardown explicit and generation-fenced, while leaving Program, Operation, verification, recovery, and Completion authority in the Host.**

A5 should introduce that semantic boundary before broader model-generated execution, reusable procedures, parallel workspaces, durable delegation, or remote workers.

---

## 2. Current execution architecture

The relevant current production path is:

```text
WorkspaceRegistry / locked Workspace store
        ↓
local repository root
        ├─ createLocalWorkspace(root)
        │    ├─ LocalFilesystem
        │    └─ LocalTerminal
        │
        ├─ createDefaultHostCapabilities(workspace)
        │    ├─ read/write/edit/grep/ls/find
        │    └─ bash(root)
        │
        ├─ ProgramExecutionObservationSourceV1
        │    └─ git HEAD/status or bounded file-tree digest
        │
        ├─ verifier path observations
        │    └─ direct local lstat(root-relative path)
        │
        └─ CodeIntelligence / planning reads
             └─ local root + supervised local processes

Host Program runtime
        ↓
ProgramAttempt + expectedExecutionBase
        ↓
CapabilityBroker
        ↓
HostCapability.execute(...)
        ↓
local filesystem / local process
        ↓
Operation effect / quiescence / reconciliation
        ↓
re-observed execution base
```

This architecture is correct for the current local product. The problem appears only when a second physical execution implementation is introduced.

---

## 3. Existing contracts that A5 must preserve

A5 is not a replacement for the existing authority model. It must compose with it.

### 3.1 Workspace identity

ADR 0002 already separates:

- `repositoryId` — stable registered repository identity;
- `workspaceId` — execution/state workspace identity used by durable events;
- repository lineage/fingerprint — recognition evidence.

Worktrees may share `repositoryId` while using distinct `workspaceId`s. The existing `workspaceId` must not be silently redefined to mean a container ID, VM ID, SSH connection, or remote sandbox handle.

### 3.2 ProgramAttempt execution base

`ProgramAttemptExecutionBase` currently contains:

```ts
workspaceEffectGeneration
observation: {
  kind: "workspace-observation-v1"
  providerKind
  workspaceIdentity
  coverageDigest
  stateDigest
}
```

This already provides a strong **observed state** contract and a causal Host effect generation. Dispatch/recovery/verification compare bases canonically and fail closed when observation is unknown or stale.

A5 should extend the meaning available to this cut; it should not discard `workspaceEffectGeneration`, observation completeness, or state digest semantics.

### 3.3 CapabilityBroker / Operation truth

`CapabilityBroker` already owns:

- capability lookup and dynamic-generation fencing;
- Host policy / approval hooks;
- Program operation routing;
- `operation.requested` / `operation.started` / completion facts;
- mutation writer barriers;
- operation-scoped quiescence evidence;
- effect generation advancement;
- reconciliation contracts;
- A2 inference/tool-call provenance.

A5 must remain **below** this authority. A provider executes an admitted Operation; it does not admit one.

### 3.4 Quiescence and reconciliation

The current Host contracts already distinguish:

- execution completion;
- containment/quiescence proof;
- effect certainty;
- reconciliation.

A sandbox/container exit must not collapse those dimensions. A provider saying “process ended” is not automatically evidence that every externally visible effect is known, and a lost provider must not imply effect absence.

### 3.5 S-02 Code Mode

S-02 provides fresh bounded QuickJS workers with no ambient environmental authority. Every environmental subcall returns through ordinary Host capability admission.

A5 is therefore not “make Code Mode more sandboxed.” It addresses the physical environment **behind** Host-admitted capabilities, especially filesystem/process execution. S-02 remains a local orchestration transport.

### 3.6 A2 inference provenance

A2 binds model causality to context/provider/capability/Attempt provenance and Host Operations. `InferenceEpochId` remains non-authorizing. A5 does not need to make an execution provider visible to the model merely to preserve causal truth; Operation/execution-base events can carry the relevant world provenance on the Host side.

---

## 4. Concrete forcing gaps

### G1 — No first-class execution-world identity or non-reusable world generation

The current execution base records `providerKind`, `workspaceIdentity`, coverage, state digest, and Host effect generation. It does not identify one exact instantiated physical world or a non-reusable generation of that world.

That distinction matters once an execution backend can be recreated or reconnected.

Example:

```text
Attempt A observes container/world W generation G0
        ↓
backend is destroyed
        ↓
new container/world W generation G1 happens to expose identical files
        ↓
old Attempt A submits a capability
```

A state digest alone can be identical across G0 and G1. If replacement is semantically relevant — because process state, mounts, credentials, network policy, kernel/container boundary, or unseen external state changed — the old Attempt must not remain current merely because repository bytes match.

**Required direction:** a physical execution world needs a Host-verifiable, non-reusable generation identity. Replacement/recreation/reconnect that cannot prove continuity mints a new generation and invalidates old execution authority.

### G2 — Observation and execution are separate injected dependencies

`ProgramExecutionRuntimeOptionsV1` receives `observations` separately from `host.capabilities`. The production CLI constructs both from the same local root, but no type/runtime contract proves that they describe and mutate the same world.

Today:

```text
observations.observe()        // local root chosen by caller
HostCapability.execute()      // concrete capability chosen by caller
```

A future composition could accidentally bind:

```text
observer → container A
filesystem → container B
bash → host local filesystem
```

while all three individually satisfy their interfaces.

**Required direction:** execution-base observation and world-bound filesystem/process capabilities must be obtained from, or explicitly bound to, one execution-world owner/generation.

### G3 — Filesystem/process coherence is conventional, not mechanically enforced

The existing `Workspace` abstraction bundles identity, filesystem, and terminal and was intentionally designed for future SSH/WSL/Docker/remote implementations. That is valuable groundwork. However, the production Host later flattens the workspace into ordinary `HostCapability` objects; `HostCapability.execute()` receives no execution-world identity.

The current local implementation also allows filesystem requests to contain absolute paths and resolves relative paths against the local root. That is a local capability behavior, not a portable sandbox/mount policy. A5 must not infer confinement merely from the word “workspace.”

**Required direction:** the A5 provider contract must define which paths/mounts constitute the world and ensure all world-scoped execution capabilities address that same exact generation. Any host-path escape or external mount must be explicit policy, not an accidental property of a local adapter.

### G4 — Physical containment is not a provider-level semantic contract

Current local process mechanisms provide useful bounded behavior, including timeout/cancellation, process-tree termination, output limits in the local tool path, scrubbed environment in the Host external-process supervisor, and operation-scoped quiescence contracts.

They do not collectively define a physical sandbox contract covering:

- CPU budget;
- memory budget;
- process-count budget;
- filesystem/mount policy;
- network policy;
- environment/secret projection policy;
- privilege/user identity;
- deterministic world teardown;
- provider lifecycle/replacement identity.

`safe-network.ts` is Host outbound-integration/SSRF hardening, not a sandbox network namespace or egress policy.

**Required direction:** A5 must define containment requirements semantically, then let each provider prove which controls it implements. Unsupported mandatory controls fail closed; they are not silently approximated.

### G5 — Provider/world replacement is not part of ProgramAttempt currentness

Current `ProgramAttemptRuntimeFactsV2` exposes `executionBaseCurrent: boolean`. It does not separately model whether the physical backend generation is still the one under which the Attempt was issued.

For a single local root this is acceptable. For a replaceable provider it is insufficient unless world generation is embedded into the execution-base equality/currentness proof.

**Required direction:** ProgramAttempt execution-base currentness must include exact execution-world generation identity. A replacement/reconnect without proven continuity makes the old base stale before new world-scoped execution.

### G6 — Verification/path observation can bypass a future execution provider

The current default verifier path observer uses direct local `lstat` against the Host root, while command verification routes through the Host `bash` capability and the general execution observer is separately injected.

That is coherent locally because every path resolves to the same host filesystem. It would be wrong for an isolated world if verification reads host-local files while mutations occur inside the isolated world.

Likewise, planning reads and CodeIntelligence currently point at the local root. Not every planning observation must move into A5 immediately, but any observation asserted as the **current execution world** must be world-bound.

**Required direction:** distinguish:

```text
execution-authority observation  → must be world-bound
verification of execution state  → must be world-bound when it claims world state
planning-only semantic evidence  → may remain separate, with explicit provenance/freshness
```

### G7 — Operation provenance does not identify the physical world that executed it

`operation.requested` records tool/call/program/inference/quiescence/reconciliation data. It does not currently need a physical-world identity because only one local world exists.

With multiple provider instances, later recovery must be able to answer:

```text
Which exact execution world/generation received Operation O?
Was that generation still alive when the Host lost contact?
Which provider-specific reconciliation/quiescence evidence applies?
```

**Required direction:** world identity should be durable Operation provenance for world-scoped capabilities. It must not become effect truth by itself.

### G8 — Provider loss must preserve, not simplify, uncertainty

A container/VM/remote worker can disappear after a mutation was sent but before a result or teardown proof is durably observed.

The existing ALCODE rule remains decisive:

> timeout, cancellation, process loss, provider loss, or transport failure does not prove a mutation did not happen.

A5 therefore cannot define provider loss as automatic rollback or effect absence unless a specific provider supplies transactional evidence strong enough to prove that claim.

**Required direction:** provider lifecycle state and Operation effect state remain separate. Lost-world recovery uses existing reconciliation/quiescence semantics, extended with provider-specific evidence where available.

### G9 — Local behavior must survive the abstraction unchanged

A provider abstraction is only useful if it preserves the current local path rather than rewriting its semantics to a lowest common denominator.

The current local product depends on:

- one Host and one Workspace lock;
- current ProgramAttempt/execution-base rules;
- ordinary Host capabilities;
- dynamic binding fences;
- quiescence/reconciliation;
- S-02 and A2 provenance;
- typed verification;
- Completion Oracle.

**Required direction:** the existing local implementation becomes the first provider/conformance implementation. A5 must prove semantic equivalence for the closed local path before an isolated backend is trusted.

---

## 5. What is already reusable

A5 should be a relatively narrow architectural addition because the hard control-plane pieces already exist.

| Existing mechanism | A5 role |
| --- | --- |
| `workspaceId` / repository identity | durable state/workspace identity; not physical backend generation |
| `ProgramAttemptExecutionBase` | authority cut to extend with execution-world identity |
| `workspaceEffectGeneration` | Host causal generation for confirmed Workspace mutations |
| `ProgramExecutionObservationSourceV1` | observation semantics to move behind/bind to provider world |
| `CapabilityBroker` | remains capability/Operation admission authority |
| `HostCapability` | model-independent Host semantic capability surface |
| dynamic capability generations | precedent for non-reusable provider-generation fencing |
| quiescence contracts | containment settlement evidence |
| reconciliation contracts | uncertain-effect recovery |
| `ExternalProcessSupervisor` | reusable local process-supervision mechanism, not full sandbox |
| S-02 Code Mode | orchestration above A5; no direct physical authority |
| A2 InferenceEpoch | cognition provenance independent of A5 authority |
| verifier catalog / path observations | verification semantics to bind to execution world where applicable |

---

## 6. Candidate semantic boundary

The forcing evidence supports a `WorkspaceExecutionProvider`-class boundary, but exact TypeScript names remain design work.

Conceptually:

```text
Host
  ↓ selects / owns
WorkspaceExecutionProvider
  ↓ opens/resolves
ExecutionWorld
  identity:
    workspaceId
    providerKind/providerId
    worldId
    worldGeneration
    policy/config digest(s)
  services:
    execution-base observation
    filesystem capability
    process/terminal capability
    world-bound verification observation
    lifecycle/quiescence/reconciliation hooks
```

The critical rule is not the class name. It is:

> **One world identity must cover every capability and observation that claims to act on or describe that execution world.**

A provider may internally expose separate filesystem and process adapters, consistent with execution-subsystem separation, but they must be owned by the same world generation when semantic coherence requires it.

---

## 7. Identity model — distinctions that must remain explicit

A5 should not overload existing identities.

```text
repositoryId
  = registered repository identity

workspaceId
  = durable ALCODE execution/state workspace identity

ProgramAttemptId
  = renewable authority to perform current Program work

InferenceEpochId
  = reconstructable model-cognition provenance

OperationId
  = durable Host environmental action/effect identity

ExecutionWorldIdentity
  = exact physical world/provider generation targeted by world-scoped work
```

Candidate world identity should include enough information to distinguish recreation and provider substitution. A likely semantic minimum is:

```text
workspaceId
providerKind/providerId
worldId
worldGeneration       // fresh, non-reusable on unproven replacement/recreation
policyDigest?         // only for controls whose change invalidates continuity
```

Whether mount/environment/network/containment policy digests are separate fields or one canonical world-config digest is a reversible design choice. The important invariant is that material execution-world policy changes cannot masquerade as continuity under an old authority cut.

---

## 8. Local vs isolated provider

A5 should prove at least two implementations at the contract level:

### Local provider

Wraps/preserves the existing local Workspace behavior. It may use:

- current LocalFilesystem/LocalTerminal or refactored equivalents;
- current local execution-base observer;
- current verifier observations;
- current process supervision.

The local provider must not claim stronger hostile-code isolation than the operating system/process mechanisms actually provide.

### Isolated provider

Provides a physically separated execution world with explicit controls. The study deliberately does **not** choose Docker, Podman, Firecracker, a cloud sandbox, or another backend. The contract should be implementable by more than one mechanism.

Minimum expected policy categories are:

```text
filesystem/mounts
execution user/privilege
CPU
memory
process count
wall time
stdout/stderr/result bounds
network/egress
ambient environment
secret projection
cleanup/teardown
```

A provider must declare supported controls; mandatory policy that cannot be enforced fails closed.

---

## 9. Local/remote and subsystem boundaries

The Architecture Pattern Register already contains useful candidate patterns:

- APR-013 — Capability Definition / Provider / Consumer Separation;
- APR-025 — Coherent Shared Remote Execution Environment;
- APR-033 — Remote Workspace Abstraction;
- APR-034 — Execution-Subsystem Separation;
- APR-042 — Read-Only Semantic Observation with Freshness Fence.

A5 should adopt the relevant **local/isolation** portions without prematurely implementing remote execution. In particular:

- filesystem/process providers may remain subsystem-specific;
- a shared world owner/generation supplies coherence;
- provider internals remain below Host authority;
- semantic observations stay evidence, not authority;
- remote leases/transport protocols remain A9 work unless a local-isolation contract cannot be stated without them.

---

## 10. Candidate invariants for later freeze review

The forcing study supports the following invariants as candidates for the A5 design review:

1. **Host remains canonical.** An execution provider never admits Program transitions, Operations, verification, or Completion.
2. **World identity is not authority.** Possessing an `ExecutionWorldIdentity` never authorizes execution; current Program/capability authority is still required.
3. **One coherent world.** Filesystem/process/verification observations that claim the same world must bind to the same exact world generation.
4. **Replacement fences authority.** World recreation/replacement/reconnect without proven continuity creates a fresh non-reusable generation and invalidates stale Attempt/currentness claims.
5. **Observation remains evidence.** A world handle or provider connection is not an execution-base digest; Host must observe/re-observe state.
6. **Operation truth remains independent.** Provider result/loss/teardown never fabricates effect certainty.
7. **Containment is explicit.** Required mount/env/network/resource/secret controls are declared and enforceable or admission fails closed.
8. **Local equivalence.** The local provider preserves the current product semantics and gates.
9. **No ambient Agent authority.** Agent/S-02 continue to invoke only Host-advertised capabilities; provider handles are not Agent capabilities.
10. **No hidden split brain.** A provider composition that binds execution and authoritative observation to different worlds is invalid.

---

## 11. Adversarial cases a frozen A5 plan should cover

### A — recreate-same-bytes ABA

World G0 is replaced by G1 with identical repository bytes.

Expected: old ProgramAttempt is stale because world generation changed, even if `stateDigest` matches.

### B — split filesystem/process provider

Filesystem reads target world A while bash targets world B.

Expected: composition rejected before production execution; no “same workspace” claim may be inferred from matching path strings.

### C — provider loss after admitted mutation

Host admits Operation O, provider may execute the mutation, then provider/transport disappears before result.

Expected: O retains ordinary uncertainty/reconciliation semantics; provider loss does not mean `effect=absent`.

### D — stale reconnect

Provider reconnects to a world whose continuity cannot be proven.

Expected: mint fresh world generation; old Attempt does not resume as current.

### E — changed containment policy

Same world contents are mounted with a materially different network/mount/secret policy.

Expected: policy change cannot silently reuse an authority-bearing world generation when the frozen contract classifies that policy as identity-relevant.

### F — verifier observes host instead of sandbox

Mutation runs in isolated world, path verifier reads host-local repository.

Expected: impossible in a valid world-bound configuration or detected as world-identity mismatch.

### G — unsupported mandatory control

Selected provider cannot enforce required network isolation or memory limit.

Expected: fail closed before model capability execution; do not silently downgrade.

### H — teardown without quiescence proof

Provider reports world/container stopped but cannot establish the exact operation containment proof required by a mutating capability.

Expected: existing quiescence/writer barriers remain unresolved as required; teardown status does not synthesize proof.

### I — local-provider regression

A5 local provider runs the closed production scenario.

Expected: ProgramAttempt, Operation, A2 provenance, S-02 nested calls, verification, recovery, and Completion semantics remain equivalent to the pre-A5 local baseline.

---

## 12. Explicit non-goals of A5

The forcing evidence does not justify broadening A5 into:

- durable delegation/subagents;
- parallel worktrees/workspaces;
- remote Host authority;
- general remote-worker leases;
- procedure learning/promotion;
- browser automation;
- a new scheduler;
- a semantic software graph;
- `graph-v1` promotion;
- arbitrary model-authored Host extensions;
- direct Agent access to container/VM/SSH APIs;
- a generic “execute arbitrary code” bypass around capability admission;
- replacement of Operation uncertainty/reconciliation with sandbox status;
- selection of a specific sandbox vendor/runtime as architecture.

A5 may create seams later reused by A7/A9, but it should close on local + isolated execution semantics first.

---

## 13. Study conclusion

The repository already contains many pieces normally associated with execution-provider design: a Workspace abstraction, semantic filesystem/terminal capabilities, execution-base observation, ProgramAttempt freshness, Host capability admission, process supervision, quiescence, reconciliation, and provider-generation fencing in adjacent domains.

The missing piece is the **coherent physical world contract** joining those pieces.

Without A5, adding an isolated or remote backend would require composition conventions that are not represented in ProgramAttempt currentness or durable Operation provenance. That would create exactly the split-brain and ABA risks the rest of ALCODE is designed to eliminate.

Therefore the forcing study recommends proceeding to a bounded A5 design review around a Host-owned `WorkspaceExecutionProvider` / `ExecutionWorldIdentity` concept, with the local path as the compatibility oracle and one isolated backend as the second conformance implementation.

**Study disposition:** A5 is justified as the next load-bearing design objective. Production implementation remains unauthorized until a candidate contract is separately reviewed/frozen.
