# ALCODE Roadmap — Durable Autonomous Software Engineering Runtime

**Status:** Active architecture orientation after A2/S-04 closure.  
**Closed product baseline:** `main@eed99c2fde14e4e0e981c67b873fb91db3ed3c5f` closes A2/S-04 Reconstructable Inference Provenance on top of A1/P-01, P-02, and S-02.  
**Next load-bearing design candidate:** A5 — Sandboxed Execution Providers / physical execution-provider isolation.  
**Authority:** This roadmap defines direction and dependency order only. It does **not** by itself authorize implementation of a successor objective.

ALCODE is a Host-governed adaptive Program runtime with real model execution, semantic planning, typed verification retry, replaceable Agent generations, bounded local Code Mode orchestration, and mechanically reconstructable inference causality. The next load-bearing problem is no longer adaptive Program meaning, local orchestration, or inference provenance. It is establishing an explicit physical execution-world/provider boundary before the architecture expands into learned procedures, parallel workspaces, delegation, and remote workers.

This document is the durable architectural navigation surface. Exact state machines, acceptance criteria, implementation slices, gate commands, and closure evidence belong in objective plans and as-built records.

---

## 1. Document role and governance

ALCODE uses four document classes:

```text
Architecture Constitution
        │ non-negotiable ownership/correctness laws
        ▼
Roadmap
        │ long-term direction + sequencing rationale
        ▼
Objective / Phase Plan
        │ exact bounded semantics + frozen acceptance criteria
        ▼
Implementation + Gate + As-Built Closure
```

A roadmap entry is not implementation authority. The normal progression remains:

```text
roadmap direction
      ↓
concrete forcing objective
      ↓
study / bounded design work
      ↓
candidate plan
      ↓
explicit approval / freeze
      ↓
implementation
      ↓
executable closure gate
      ↓
as-built closure record
```

Completion of one objective never silently authorizes the next. Optional improvements discovered during execution remain backlog material unless they are demonstrated blockers for the frozen objective.

---

## 2. North star

**ALCODE is a durable, model-independent autonomous software-engineering runtime centered on long-running Programs rather than chat sessions or Agent processes. Programs span sessions, Agent generations, provider/model choices, Host lifetimes, and eventually multiple execution environments. Agents provide replaceable cognition; the Host retains canonical authority over work state, execution admission, environmental effects, recovery, verification, and completion.**

The central hierarchy is:

```text
Long-horizon objective
        ↓
ProgramState
        ↓
ProgramRevision
        ↓
WorkItem / generation
        ↓
ProgramAttempt
        ↓
replaceable Agent generation
        ↓
InferenceEpoch provenance
        ↓
provider inference / local orchestration
        ↓
Host capabilities
        ↓
Operations
        ↓
effects / reconciliation / recovery
        ↓
verification
        ↓
Completion Oracle
```

The LLM is cognition inside this runtime. It is never canonical execution authority. `InferenceEpoch` is durable provenance, not a capability token or Program authority.

---

## 3. Product boundary

ALCODE targets developers, advanced individual users, open-source users, and researchers who need a powerful, hackable autonomous software-engineering runtime.

It is not an enterprise governance platform. The roadmap does not target corporate RBAC hierarchies, organization administration, compliance dashboards, enterprise identity integration, approval bureaucracies, or multi-tenant governance consoles.

ALCODE still requires permissions, provenance, isolation, capability control, effect tracking, recovery, and reproducibility because those are correctness and autonomy properties. CLI, web, desktop, IDE, and future API surfaces are clients of the runtime; they do not own canonical Program truth.

---

## 4. Governing architectural invariants

The Architecture Constitution and hard rules remain authoritative. Future stages must preserve these constraints:

1. **Program > Session > Agent process.** Long-running objective identity survives interaction and cognition processes.
2. **Host canonical authority.** Only the privileged Host admits canonical Program transitions, Operations, verification state, recovery state, and completion.
3. **Long-horizon intent is durable; short-horizon cognition is disposable.** Program meaning may span days; inference scopes and local orchestration remain replaceable.
4. **Progressive decomposition, not state explosion.** Durable Program topology contains meaningful engineering obligations, not every local action.
5. **Execution authority is renewable.** Stale, replaced, interrupted, or failed Attempts are not resumed as though authority survived.
6. **Effects are facts, not model claims.** Environmental truth comes from Host-governed Operations and reconciliation evidence.
7. **Uncertainty remains uncertainty.** Timeout, cancellation, process loss, provider loss, or transport failure never proves a mutation or provider invocation did not happen.
8. **No blind mutation retry.** Indeterminate mutation requires recovery/reconciliation before another conflicting mutation is admitted.
9. **Verification is freshness-bound.** Passing evidence applies to an exact subject/execution base and may become stale after material change.
10. **Agent/inference completion is advisory.** Agent, provider, or local-worker completion cannot complete a Program.
11. **Composition ≠ authority.** Workflows, plugins, procedures, subagents, and remote workers may compose Host-authorized capabilities but do not gain independent authority.
12. **Inference provenance ≠ authority.** Historical model causality is reconstructable without becoming a capability token or current Program fact.
13. **Learning ≠ promotion authority.** Learned code cannot self-install into the trusted runtime or mint new capabilities.
14. **Remote execution ≠ remote canonical authority.** Remote workers execute admitted work; the logical Host decides what may execute and what results mean canonically.
15. **Scheduler = policy; Host state machines = truth.** Scheduling choices cannot create effect, verification, completion, or semantic Program facts.
16. **Semantic observation ≠ execution truth.** Code intelligence, semantic graphs, procedures, and knowledge may improve planning but never substitute for ProgramAttempt, execution-base, Operation, verification, or completion authority.

---

## 5. Current position — adaptive Program + semantic planning + Code Mode + inference provenance closed

```text
Phase 0.0–0.9 foundation                         CLOSED
Phase 1.0 Durable ProgramState                   CLOSED
Phase 1.1 Default Program execution              CLOSED
S-01 Replaceable Agent runtime                   CLOSED
P-01 Production Program Agent                    CLOSED
A1 Adaptive Program revision/decomposition       CLOSED
P-02 Semantic planning + typed verification      CLOSED
S-02 ProgramAttempt-aware Code Mode              CLOSED
A2/S-04 Reconstructable Inference Provenance     CLOSED
                                                   │
                                                   ▼
NEXT LOAD-BEARING DESIGN CANDIDATE
A5 physical execution-provider isolation          DESIGN NOT YET FROZEN
```

The current product path is approximately:

```text
caller objective
  ↓
durable Host input admission
  ↓
Host planning episode
  ↓
model planning through bounded tracked reads
  + semantic CodeIntelligence observations
  + exact Host verifier catalog
  ↓
bounded Program proposal
  ↓
Host validation / explicit Application acceptance
  ↓
adaptive ProgramState / ProgramRevision
  ↓
fresh ProgramAttempt under exact WorkItem-generation authority
  ↓
replaceable Agent generation
  ↓
exact Host inference authorization cut
  ↓
Host-minted InferenceEpoch provenance
  ↓
provider inference
    ├─ direct Host capability calls
    └─ S-02 run_code
          ↓ bounded Agent-local QuickJS control flow
          ↓ explicit outer/subcall lineage
          ↓ every environmental sub-dispatch returns to Host
  ↓
Host Operations / effect truth
  ↓
typed Host verification
    ├─ fail → retire Attempt → durable failure → fresh retry
    └─ pass → satisfy work → fresh successor when ready
  ↓
optional Host-admitted semantic Program revision
  ↓
Completion Oracle
  ↓
Program.completed
```

### Closed foundation now proven

The closed baseline includes:

- append-only canonical event history and rebuildable projections;
- durable Operation identity, effect uncertainty, reconciliation, quiescence, and recovery;
- Host-owned capability admission and execution lifecycle;
- durable transcript reconstruction and replaceable-Agent hydration;
- governed context projection with `verbatim-v1` safe default and opt-in `graph-v1`;
- dynamic capability-generation fencing and Host-governed adapters;
- Durable ProgramState, ProgramRevision, WorkItem generations, ProgramAttempt authority, execution-base freshness, verification generations, recovery barriers, and Completion Oracle;
- model-driven Program planning with Host-tracked repository reads;
- P-02 semantic symbol/reference/diagnostic planning observations;
- typed Host verification with durable failed-verifier retry under fresh Attempt authority;
- replay-safe Attempt driving, successor execution, Agent replacement, and restart recovery;
- S-02 inference-scoped local Code Mode with bounded QuickJS workers and ordinary Host Operations for every environmental sub-dispatch;
- A2 Host-minted non-authorizing inference epochs binding exact context/provider/capability/Attempt provenance to assistant, tool, Code Mode subcall, and Operation causality;
- provider-invocation preparation/uncertainty semantics that do not fabricate remote-provider evidence after Agent loss;
- restart reconstruction of inference causality without reviving historical authority.

### Current structural limitation

The ordinary execution path still assumes one local Host-owned execution world. ALCODE has strong logical authority and a bounded local Code Mode VM, but it does not yet expose a general `WorkspaceExecutionProvider`-class contract under which local filesystem/process execution and an isolated backend implement the same semantic world identity, freshness, containment, teardown, and effect semantics.

That is the forcing boundary for A5. It is intentionally distinct from S-02: Code Mode has no ambient environmental authority and is not a general-purpose OS sandbox.

---

## 6. Architectural timescales

The architecture preserves distinct timescales:

```text
LONG — durable semantic intent
ProgramState
ProgramRevision
WorkItem / generation

MEDIUM — renewable execution authority
ProgramAttempt
AgentGeneration
WorkspaceExecutionIdentity (future A5/A7/A9)
Delegation (future A8)

SHORT — disposable cognition and orchestration
InferenceEpoch provenance
InferenceScope
run_code local program
individual capability calls
```

`InferenceEpoch` belongs to the short-horizon layer even when its provenance is durably recorded. Durable recording does not promote it into execution authority.

---

# 7. Forward roadmap

The A-series is the dependency map. Status labels below reflect actual repository state.

## A1 — Adaptive Program Revision and Progressive Decomposition — CLOSED

A1 provides semantic Program revisions distinct from operational CAS revision, WorkItem identity/generation, progressive decomposition, RevisionImpact, relevance-scoped invalidation, adaptive Attempt authority, recovery/rebuild semantics, and Completion interaction.

A1 remains the canonical semantic foundation for later parallel/delegated work.

## A2 / S-04 — Reconstructable Inference Provenance — CLOSED

**Goal achieved:** make one provider inference mechanically reconstructable and provider-neutral at the semantic provenance layer without turning historical inference into execution authority.

The landed implementation uses a Host-minted fresh `InferenceEpochId` and one coherent authorization cut that binds the existing context receipt, Agent generation, provider/model/adapter semantic descriptor, capability catalog/binding snapshot, and ProgramAttempt/execution-base provenance when present.

The durable causal shape is:

```text
context receipt + exact Host inference cut
        ↓
InferenceEpoch
        ↓
provider/model invocation lifecycle
        ↓
assistant/tool call
        ↓
optional run_code parent/subcalls
        ↓
Host Operation identities
```

Provider-native request/response identifiers remain optional observed metadata. Preparation does not prove provider invocation; Agent terminal reports alone do not prove provider response. Historical epochs cannot mint current authority.

A2 demonstrates provider-neutral provenance semantics using the production Anthropic adapter plus a deterministic non-Anthropic fixture. It does **not** claim broad live-provider product diversity.

## A3 — Semantic SDLC Capability Layer — PARTIALLY REALIZED / INCREMENTAL

P-02 and prior phases already provide several typed semantic surfaces: planning reads, CodeIntelligence, typed verification contracts, filesystem/edit/process capabilities, and artifact/verification semantics.

A3 is not a prerequisite megaphase. Add typed engineering capabilities when semantics materially improve correctness, evidence, authorization, reconciliation, reproducibility, or measured model efficiency. A generic process capability remains a deliberate escape hatch for project-specific commands.

Future candidates include richer repository status/diff/refactor/build/test/coverage/artifact operations where measured need justifies the contract.

A future semantic software/object graph may also become part of this observation layer if representative repositories demonstrate that raw reads plus CodeIntelligence repeatedly force reconstruction of stable relationships. Such a graph remains planning evidence, never Program or execution truth.

## A4 — Capability Workflow VM / Code Mode — CLOSED AS S-02 BOUNDED REALIZATION

S-02 supplies the bounded product realization:

```text
model-written local program
        ↓
fresh isolated QuickJS worker
        ↓
pure local control flow
        ↓
exact inference SDK snapshot
        ↓
CapabilityBroker for every environmental sub-dispatch
        ↓
ordinary Host Operations
```

S-02 intentionally excludes ambient filesystem/network/process/Host authority, nested Code Mode, durable local-worker state, and direct Program/verification/Completion transitions.

A broader arbitrary generated-code runtime is **not** implied by S-02 closure and requires separately proven physical isolation policy.

## A5 — Sandboxed Execution Providers — NEXT DESIGN CANDIDATE

**Goal:** add physical execution isolation while keeping the Host outside the sandbox and preserving the existing authority/effect model.

The target boundary is a `WorkspaceExecutionProvider`-class semantic contract supporting the existing local path and at least one isolated execution environment. Later remote providers should extend the same contract rather than create a second execution model.

A serious isolation backend should provide, where relevant:

- one coherent execution world for filesystem and subprocess capabilities;
- exact execution-world/generation identity;
- explicit mounts and workspace roots;
- unprivileged execution;
- CPU, memory, process-count, wall-time, and output bounds;
- network restrictions;
- scrubbed environment and explicit secret projection;
- deterministic cleanup and observed process-tree exit;
- execution-base observation strong enough for ProgramAttempt freshness;
- backend replacement/reconnect semantics that invalidate stale authority;
- preservation of Host Operation/effect uncertainty and reconciliation.

The local provider must preserve current behavior rather than redefining existing execution semantics merely to fit the abstraction.

**Current state:** roadmap candidate only. No A5 plan or acceptance criteria are frozen by this file.

## A6 — Procedure Optimization and Lifecycle

**Goal:** convert repeated successful experience into governed reusable procedures without allowing learned code to self-install or acquire authority.

```text
atomic Host capabilities
        ↓
ephemeral S-02 orchestration
        ↓
validated reusable procedure candidates
        ↓
static validation + isolated evaluation + verification
        ↓
versioned promoted ProcedureGeneration
```

A large Procedure Registry should remain separate from the bounded Active Procedure Projection shown to one inference. Context-linked procedure discovery may later reduce global context pressure, but procedure text remains non-authoritative.

Core invariant:

> A self-improving Agent may learn new ways to compose authority; it must never learn new authority for itself.

## A7 — Isolated Parallel Workspace Execution

**Goal:** introduce useful concurrency through independently identified execution domains rather than weakening same-workspace serialization.

Initial isolation can use Git worktrees or equivalent independently identified workspace generations. A future `WorkspaceExecutionIdentity` should distinguish repository/base revision, branch/worktree, environment generation, sandbox identity, and observed state.

Parallel work creates an explicit integration boundary:

```text
isolated implementation
        ↓
local verification
        ↓
Host integration operation
        ↓
new integrated workspace generation
        ↓
integration verification
```

Passing verification on branch/worktree A does not verify the merged integration workspace.

## A8 — Durable Delegation over Replaceable Agents

**Goal:** add bounded subagent/delegation semantics only after adaptive Programs and isolated execution domains exist.

The durable object is work/delegation, not the worker process:

```text
Program WorkItem
      ↓
Delegation
      ↓
ProgramAttempt
      ↓
replaceable AgentGeneration
```

A Delegation may carry an authority ceiling, workspace identity, specialization hint, resource/cost budget, and current Attempt. Agent/model replacement never changes the identity of the delegated obligation. Authority topology remains Host-centered.

## A9 — Remote Execution

**Goal:** move execution across machines without moving canonical authority away from the Host.

The remote protocol must preserve Operation identity, worker generation/incarnation, leases/fencing, transport retry identity, idempotency identity, exact execution-base identity, effect reconciliation, result provenance/authenticity, and worker-loss handling.

Timeout or worker disappearance can never mean “the mutation did not happen.”

## A10 — Autonomous Program Policy Scheduling

**Goal:** add long-running autonomous policy over the canonical Program runtime.

By this stage the runtime should already derive semantic eligibility, issue Attempts, isolate execution domains, delegate work, and preserve recovery truth. A10 adds policy sophistication rather than becoming the first source of scheduling truth.

```text
Scheduler = policy
Host state machines = truth
```

The scheduler observes canonical state and proposes/advises admissions. It does not create completion, effect, or verification facts.

## A11 — Research / Runtime Ecosystem and Product Maturity

**Goal:** make ALCODE a strong experimental and developer runtime without turning it into enterprise administration software.

Likely extension seams include `ModelProvider`, `PlanningStrategy`, `ContextStrategy`, `MemoryStrategy`, `ReasoningStrategy`, `VerificationStrategy`, `ProcedureLearner`, `CapabilityProvider`, `AgentRuntimeModule`, `WorkspaceExecutionProvider`, `SchedulingStrategy`, and `DelegationStrategy`.

Benchmark principle:

> **same model, different harness**

---

## 8. Dependency rationale from the current position

The preferred load-bearing sequence is now:

```text
A5 physical execution-provider isolation
      ↓
A6 governed procedure lifecycle
      ↓
A7 parallel isolated workspaces
      ↓
A8 durable delegation / subagents
      ↓
A9 remote execution
      ↓
A10 autonomous policy scheduling
      ↓
A11 research/runtime ecosystem maturity
```

A3 semantic capability expansion remains demand-driven alongside these stages; A4 is already closed by S-02's bounded realization.

The major dependencies are:

- **A2 before broader execution/delegation — satisfied:** later workers/providers are easier to compare, diagnose, and recover now that causal inference history is exact.
- **Physical isolation before learned/broader generated execution:** synthesized code should not gain unrestricted OS/network authority because it was produced by a model or learned from successful trajectories.
- **Procedure lifecycle before autonomous procedure reuse:** retention and promotion need evidence/version boundaries, not successful text alone.
- **Isolated workspaces before subagents:** safe parallel effects should exist before multiplying cognition workers.
- **Local isolation before remote workers:** distributed failure modes should extend a proven execution-provider identity/containment contract.
- **Autonomous scheduling late:** sophisticated policy is valuable only after trustworthy semantic work, execution domains, delegation, provenance, procedure applicability, and recovery exist.

---

## 9. Verification and completion direction

Adaptive Program semantics make completion stricter, not more model-dependent.

The Completion Oracle should continue to establish at one protected canonical cut that:

- all required current work is satisfied;
- no unresolved required decomposition remains;
- mandatory verification is current;
- no active Attempt remains;
- no unresolved blocker prevents completion;
- no execution-base mismatch remains;
- no unresolved indeterminate effect remains;
- no writer/quiescence barrier remains;
- required artifacts/outputs are present;
- the current integration workspace is the workspace actually verified.

A2 inference provenance is not an independent completion predicate. Model/provider self-assessment remains non-authoritative.

Future A5/A7/A9 work must preserve the same rule while extending “current execution workspace” into an explicit provider/world identity.

---

## 10. Benchmark direction

Future stages should preserve two benchmark families.

### Coding capability

Measure task success, tests/regressions, patch quality, wall-clock time, token/model/tool calls, human interventions, and eventually parallel speedup.

### Runtime integrity

Adversarially test Agent/Host loss, stale Attempt/revision/inference provenance claims, workspace drift, timeout after write, execution-provider replacement, worker disappearance, duplicate requests, verification invalidation, capability-generation replacement, and procedure dependency drift. Measure duplicate effects, stale-authority admission, recovery/reconciliation correctness, invalid evidence reuse, false provenance joins, and incorrect completion.

Every major objective should retain the established proof discipline: semantic proof, adversarial lifecycle proof, recovery proof, and capability proof where relevant.

---

## 11. Immediate next action after A2

A1, P-02, S-02, and A2/S-04 are closed. Their closure does not automatically authorize unrelated successor implementation.

The next load-bearing **design candidate** is **A5 — Sandboxed Execution Providers**.

A bounded A5 forcing/design study should determine whether one semantic execution-provider contract can support both the current local filesystem/process world and an isolated backend while preserving:

```text
ProgramAttempt currentness
execution-base freshness
coherent filesystem/process world identity
Host capability admission
Operation/effect uncertainty
reconciliation
quiescence/process-tree exit
secret/environment policy
resource/network containment
provider replacement/reconnect invalidation
```

The study should explicitly separate semantic contract requirements from backend-specific mechanisms and should identify the minimum conformance proof needed before any plan is frozen.

No container runtime, sandbox vendor, remote protocol, procedure system, subagent model, or scheduler is selected by this roadmap update.

---

## 12. Roadmap maintenance rule

Update this file when:

1. a major objective closes and the current-position section becomes stale;
2. explicit product direction changes the long-term architecture;
3. implementation evidence proves a roadmap dependency or architectural assumption wrong;
4. a durable stage is intentionally added, removed, or materially reordered.

Do not rewrite the roadmap because a reversible mechanism, PR sequence, provider choice, or local implementation detail changes. Historical facts belong in objective plans and closure records.

---

## 13. Current status summary

```text
CLOSED FOUNDATION / PRODUCT CAPABILITY
────────────────────────────────────────────────────────────
0.x  Owned Host/runtime, durability, cognition, context,
     Application Protocol, adapters
1.0  Durable ProgramState
1.1  Default Program-backed execution
S-01 Replaceable Agent runtime
P-01 Production Program Agent
A1   Adaptive Program revision / progressive decomposition
P-02 Semantic planning + typed verification retry
S-02 ProgramAttempt-aware Code Mode
A2   Reconstructable Inference Provenance
A4   Capability Workflow VM — bounded realization via S-02

NEXT LOAD-BEARING DESIGN CANDIDATE
────────────────────────────────────────────────────────────
A5   Sandboxed Execution Providers / physical isolation     NOT FROZEN

INCREMENTAL / FUTURE
────────────────────────────────────────────────────────────
A3   Semantic SDLC capability expansion                    DEMAND-DRIVEN
A6   Procedure optimization and lifecycle
A7   Isolated parallel workspace execution
A8   Durable delegation / replaceable subagents
A9   Remote execution
A10  Autonomous Program policy scheduling
A11  Research/runtime ecosystem and product maturity
```

The immediate architectural boundary is:

```text
adaptive Program + semantic planning + local orchestration
+ exact reconstructable inference causality               CLOSED / PROVEN
                         │
                         ▼
provider-neutral physical execution-world isolation        NEXT DESIGN CANDIDATE
                         │
                         ▼
procedures → parallelism → delegation → remote → policy
```

That ordering preserves ALCODE's central design: cognition, orchestration, and execution environments may become richer, but canonical authority remains concentrated in durable Host state machines and Operations.
