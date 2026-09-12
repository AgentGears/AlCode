# ALCODE Roadmap — Durable Autonomous Software Engineering Runtime

**Status:** Active architecture orientation after A1, P-02, and S-02 closure.  
**Closed product baseline:** `main@bc321ac350ddf90d28b69abfc254eaa9af8969be` closes S-02 Code Mode product integration on top of A1/P-01 and P-02.  
**Next frozen design:** A2 / S-04 — Reconstructable Inference Provenance.  
**Authority:** This roadmap defines direction and dependency order only. It does **not** by itself authorize implementation of a successor objective.

ALCODE is now a Host-governed adaptive Program runtime with real model execution, semantic planning, typed verification retry, replaceable Agent generations, and bounded local Code Mode orchestration. The next load-bearing problem is no longer adaptive Program meaning or local orchestration. It is making the exact causal relationship between one provider inference and durable Host facts mechanically reconstructable before the architecture expands into more execution environments, learned procedures, parallel workspaces, delegation, and remote workers.

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

The LLM is cognition inside this runtime. It is never canonical execution authority.

---

## 3. Product boundary

ALCODE targets developers, advanced individual users, open-source users, and researchers who need a powerful, hackable autonomous software-engineering runtime.

It is not an enterprise governance platform. The roadmap does not target corporate RBAC hierarchies, organization administration, compliance dashboards, enterprise identity integration, approval bureaucracies, or multi-tenant governance consoles.

ALCODE still requires permissions, provenance, isolation, capability control, effect tracking, recovery, and reproducibility because those are correctness and autonomy properties. CLI, web, desktop, IDE, and future API surfaces are clients of the runtime; they do not own canonical Program truth.

---

## 4. Governing architectural invariants

The Architecture Constitution remains authoritative. Future stages must preserve these constraints:

1. **Program > Session > Agent process.** Long-running objective identity survives interaction and cognition processes.
2. **Host canonical authority.** Only the privileged Host admits canonical Program transitions, Operations, verification state, recovery state, and completion.
3. **Long-horizon intent is durable; short-horizon cognition is disposable.** Program meaning may span days; inference scopes and local orchestration remain replaceable.
4. **Progressive decomposition, not state explosion.** Durable Program topology contains meaningful engineering obligations, not every local action.
5. **Execution authority is renewable.** Stale, replaced, interrupted, or failed Attempts are not resumed as though authority survived.
6. **Effects are facts, not model claims.** Environmental truth comes from Host-governed Operations and reconciliation evidence.
7. **Uncertainty remains uncertainty.** Timeout, cancellation, process loss, or transport failure never proves a mutation did not happen.
8. **No blind mutation retry.** Indeterminate mutation requires recovery/reconciliation before another conflicting mutation is admitted.
9. **Verification is freshness-bound.** Passing evidence applies to an exact subject/execution base and may become stale after material change.
10. **Agent completion is advisory.** Agent/provider/local-worker completion cannot complete a Program.
11. **Composition ≠ authority.** Workflows, plugins, procedures, subagents, and remote workers may compose Host-authorized capabilities but do not gain independent authority.
12. **Inference provenance ≠ authority.** Historical model causality may be reconstructable without becoming a capability token or current Program fact.
13. **Learning ≠ promotion authority.** Learned code cannot self-install into the trusted runtime or mint new capabilities.
14. **Remote execution ≠ remote canonical authority.** Remote workers execute admitted work; the logical Host decides what may execute and what results mean canonically.
15. **Scheduler = policy; Host state machines = truth.** Scheduling choices cannot create effect, verification, completion, or semantic Program facts.

---

## 5. Current position — adaptive Program + semantic planning + Code Mode closed

The current architecture is:

```text
Phase 0.0–0.9 foundation                         CLOSED
Phase 1.0 Durable ProgramState                   CLOSED
Phase 1.1 Default Program execution              CLOSED
S-01 Replaceable Agent runtime                   CLOSED
P-01 Production Program Agent                    CLOSED
A1 Adaptive Program revision/decomposition       CLOSED
P-02 Semantic planning + typed verification      CLOSED
S-02 ProgramAttempt-aware Code Mode               CLOSED
                                                   │
                                                   ▼
NEXT LOAD-BEARING FRONTIER
A2 / S-04 reconstructable inference provenance   DESIGN FROZEN
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
provider inference
    ├─ direct Host capability calls
    └─ S-02 run_code
          ↓ bounded Agent-local QuickJS control flow
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
- S-02 inference-scoped local Code Mode with bounded QuickJS workers and ordinary Host Operations for every environmental sub-dispatch.

### Current structural limitation

The runtime has strong execution authority but cannot yet mechanically reconstruct an exact provider inference after restart.

Today it can durably show context receipts, assistant/tool transcript, ProgramAttempt facts, and Host Operations. It cannot yet prove one exact causal chain across all of them because there is no durable inference identity/provider binding, assistant transcript is not context-receipt-bound, `operation.requested` drops the incoming provider/model `toolCallId`, and S-02 nested parentage is not explicit durable data.

The forcing analysis is recorded in [`a2-inference-provenance-gap-study.md`](./a2-inference-provenance-gap-study.md). The bounded frozen design is [`a2-inference-provenance-plan.md`](./a2-inference-provenance-plan.md).

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
WorkspaceExecutionIdentity (future parallel/remote)
Delegation (future)

SHORT — disposable cognition and orchestration
InferenceEpoch provenance
InferenceScope
run_code local program
individual capability calls
```

`InferenceEpoch` belongs to the short-horizon layer even when its provenance is durably recorded. Durable recording does not promote it into execution authority.

---

# 7. Forward roadmap

The A-series remains the long-term dependency map. Status labels below reflect actual repository state rather than the historical pre-A1 snapshot.

## A1 — Adaptive Program Revision and Progressive Decomposition — CLOSED

A1 is implemented and landed. It provides semantic Program revisions distinct from operational CAS revision, WorkItem identity/generation, progressive decomposition, RevisionImpact, relevance-scoped invalidation, adaptive Attempt authority, recovery/rebuild semantics, and Completion interaction.

A1 remains the canonical semantic foundation for later parallel/delegated work.

## A2 — Durable Inference Provenance and Provider Independence — NEXT

**Goal:** make model inference operationally reconstructable and provider-neutral without turning historical inference into execution authority.

The S-04 gap study has now proved that current receipts/events are insufficient. The frozen design introduces a Host-minted non-authorizing inference epoch/correlation contract that reuses existing context receipts, ProgramAttempt authority, capability snapshots, transcript, and Operation truth.

Expected causal shape:

```text
context receipt + exact Host inference cut
        ↓
InferenceEpoch
        ↓
provider/model invocation
        ↓
assistant tool call
        ↓
optional run_code parent/subcalls
        ↓
Host Operation identities
```

The epoch is provenance, never current execution authority. Provider-native request/response IDs are optional metadata; ALCODE's Host-minted epoch is the cross-provider identity.

A2 establishes a provider-neutral semantic descriptor and lifecycle contract but does not require adding a second live production provider as a closure condition.

## A3 — Semantic SDLC Capability Layer — PARTIALLY REALIZED / INCREMENTAL

P-02 and prior phases already provide several typed semantic surfaces: planning reads, CodeIntelligence, typed verification contracts, filesystem/edit/process capabilities, and artifact/verification semantics.

A3 is no longer treated as a single prerequisite megaphase. Add typed engineering capabilities when semantics materially improve correctness, evidence, authorization, reconciliation, or reproducibility. A generic process capability remains a deliberate escape hatch for project-specific commands.

Future candidates include richer repository status/diff/refactor/build/test/coverage/artifact operations where measured need justifies the contract.

## A4 — Capability Workflow VM / Code Mode — CLOSED AS S-02 BOUNDED REALIZATION

S-02 supplies the bounded product realization of this stage:

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

A broader arbitrary generated-code runtime is **not** implied by S-02 closure and would require later physical isolation policy.

## A5 — Sandboxed Execution Providers

**Goal:** add physical execution isolation while keeping the Host outside the sandbox.

Introduce a `WorkspaceExecutionProvider`-class boundary supporting the existing local path and isolated environments such as containers, then later remote containers/VMs.

A serious isolation backend should provide explicit mounts, unprivileged execution, CPU/memory/process/output bounds, network restrictions, scrubbed environment, explicit secret projection, deterministic cleanup, and execution-base observation strong enough for Program authority.

S-02 may remain available before A5 because its local VM has no ambient environmental authority; arbitrary generated OS code must not become a normal path merely because Code Mode exists.

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

A large Procedure Registry should remain separate from the bounded Active Procedure Projection shown to one inference.

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
A2 reconstructable inference provenance
      ↓
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

- **Inference provenance before broader provider/delegated execution:** later workers/providers are much easier to compare, diagnose, and recover if causal inference history is exact first.
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

A2 inference provenance must not be added to this list as an independent completion predicate except insofar as a later explicitly frozen objective requires provenance integrity for a specific audit/product guarantee. Model/provider self-assessment remains non-authoritative.

---

## 10. Benchmark direction

Future stages should preserve two benchmark families.

### Coding capability

Measure task success, tests/regressions, patch quality, wall-clock time, token/model/tool calls, human interventions, and eventually parallel speedup.

### Runtime integrity

Adversarially test Agent/Host loss, stale Attempt/revision/inference provenance claims, workspace drift, timeout after write, worker disappearance, duplicate requests, verification invalidation, capability-generation replacement, and procedure dependency drift. Measure duplicate effects, stale-authority admission, recovery/reconciliation correctness, invalid evidence reuse, false provenance joins, and incorrect completion.

Every major objective should retain the established proof discipline: semantic proof, adversarial lifecycle proof, recovery proof, and capability proof where relevant.

---

## 11. Immediate next action after S-02

A1, P-02, and S-02 are closed. Their closure does not automatically authorize unrelated successor implementation.

The bounded next design objective is **A2 / S-04 — Reconstructable Inference Provenance**.

The forcing study has established that current receipts/events cannot mechanically reconstruct one exact inference because:

```text
no durable InferenceEpoch identity
provider/model effective semantics are not durably bound
assistant transcript is not context-receipt/inference-bound
operation.requested does not retain provider/model toolCallId
S-02 nested parentage is not explicit durable data
exact binding-bearing inference catalog is not durably attached to one inference
```

The frozen A2 plan corrects those gaps with a Host-minted non-authorizing epoch plus minimal lifecycle/correlation facts. It explicitly excludes subagents, worktrees, remote execution, procedure learning, general scheduling, and a requirement to add another live provider.

Production A2 implementation remains a separate explicit execution step after the design-freeze documentation is reviewed and landed.

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
A4   Capability Workflow VM — bounded realization via S-02

CURRENT FROZEN DESIGN — IMPLEMENTATION SEPARATE
────────────────────────────────────────────────────────────
A2 / S-04  Reconstructable inference provenance           NEXT

INCREMENTAL / FUTURE
────────────────────────────────────────────────────────────
A3   Semantic SDLC capability expansion                    DEMAND-DRIVEN
A5   Sandboxed execution providers
A6   Procedure optimization and lifecycle
A7   Isolated parallel workspace execution
A8   Durable delegation / replaceable subagents
A9   Remote execution
A10  Autonomous Program policy scheduling
A11  Research/runtime ecosystem and product maturity
```

The immediate architectural boundary is:

```text
adaptive single-Agent Program + local orchestration     CLOSED / PROVEN
                         │
                         ▼
exact reconstructable provider-inference causality      NEXT IMPLEMENTATION CANDIDATE
                         │
                         ▼
physical isolation → procedures → parallelism → delegation → remote
```

That ordering preserves ALCODE's central design: cognition and orchestration may become richer, but canonical authority remains concentrated in durable Host state machines and Operations.
