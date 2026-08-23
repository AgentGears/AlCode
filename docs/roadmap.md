# ALCODE Roadmap — Durable Autonomous Software Engineering Runtime

**Status:** Active architecture orientation after P-01 closure.  
**Closed product baseline:** `main@e6a9025b767a8fc9026bcd72670a338e8a37c059` closes P-01 — Production Program Agent.  
**Authority:** This roadmap defines direction and dependency order only. It does **not** authorize implementation of a successor objective.

ALCODE has completed the transition from an owned coding-agent foundation into a Host-governed, verifier-driven Program runtime with a real production model path. The next architectural problem is no longer how to run one bounded coding episode. It is how long-running software-engineering intent can evolve safely while execution, verification, recovery, Agent replacement, parallel work, and later learned capabilities remain correctly related to that intent.

This document is the durable architectural navigation surface for that evolution. Detailed state machines, acceptance criteria, implementation slices, gate commands, and closure evidence belong in separate objective plans and as-built records.

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

The roadmap answers:

1. What is ALCODE becoming?
2. What has already been built and closed?
3. What architectural stages remain?
4. Why should they occur in this order?

A roadmap entry is **not implementation authority**. A successor objective requires:

```text
roadmap direction
      ↓
concrete client objective
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

Completion of one objective never automatically authorizes the next. Improvements and ideas discovered during execution remain backlog material unless they are demonstrated blockers for the frozen objective.

---

## 2. North star

**ALCODE is a durable, model-independent autonomous software-engineering runtime centered on long-running Programs rather than chat sessions or Agent processes. Programs can span sessions, Agent generations, model/provider choices, Host lifetimes, and execution environments. Programs progressively decompose engineering objectives into durable work and ultimately precise Host-governed SDLC operations. Agents provide replaceable cognition; the Host retains canonical authority over work state, execution admission, environmental effects, recovery, verification, and completion. Experience can later be compiled into reusable procedural capabilities without allowing learned code to acquire independent execution authority.**

The central product abstraction is therefore the durable engineering Program.

```text
Long-horizon objective
        │
        ▼
ProgramState
        │
        ▼
ProgramRevision
        │
        ▼
WorkItem
        │
        ▼
ProgramAttempt
        │
        ▼
short-horizon cognition / orchestration
        │
   ┌────┼─────────────┐
   ▼    ▼             ▼
reasoning   workflow VM   learned procedure
        │
        ▼
Host semantic capabilities
        │
        ▼
Operations
        │
        ▼
effects / reconciliation / recovery
        │
        ▼
verification
        │
        ▼
Completion Oracle
```

The LLM is a cognition engine inside this runtime. It is never canonical execution authority.

---

## 3. Product boundary

ALCODE targets developers, advanced individual users, open-source users, and researchers who need a powerful, hackable autonomous software-engineering runtime.

It is **not** an enterprise governance platform. The roadmap does not target corporate RBAC hierarchies, organization administration, compliance dashboards, enterprise identity integration, approval bureaucracies, or multi-tenant governance consoles.

ALCODE still requires permissions, provenance, isolation, capability control, effect tracking, recovery, and reproducibility because these are correctness and autonomy requirements. CLI, web, desktop, IDE, and future API surfaces are clients of the runtime; they do not own canonical Program truth.

---

## 4. Governing architectural invariants

The Architecture Constitution remains authoritative. Future stages must preserve these long-horizon constraints:

1. **Program > Session > Agent process.** Long-running objective identity survives short-lived interaction and cognition processes.
2. **Host canonical authority.** Only the privileged Host admits canonical Program transitions, Operations, verification state, recovery state, and completion.
3. **Long-horizon intent is durable; short-horizon cognition is disposable.** Program meaning may span days; inference scopes, local plans, Agent runs, and generated orchestration should be cheap to replace.
4. **Progressive decomposition, not state explosion.** Durable Program topology contains meaningful engineering obligations, not every file read, edit, command, or test rerun.
5. **Execution authority is renewable.** Stale, replaced, interrupted, or failed Attempts are not resumed as though authority survived.
6. **Effects are facts, not model claims.** Environmental truth comes from Host-governed Operations and reconciliation evidence.
7. **Uncertainty remains uncertainty.** Timeout, process loss, transport failure, or worker disappearance never proves a mutation did not happen.
8. **No blind mutation retry.** Indeterminate mutation requires recovery/reconciliation before another mutation is admitted.
9. **Verification is freshness-bound.** Passing evidence applies to an exact subject generation/execution base and may become stale after material change.
10. **Agent completion is advisory.** Agent idle or self-assessment cannot complete a Program.
11. **Composition ≠ authority.** Workflows, plugins, procedures, subagents, and remote workers may compose Host-authorized capabilities but do not gain independent authority.
12. **Learning ≠ promotion authority.** Learned code cannot self-install into the trusted runtime or mint new capabilities.
13. **Remote execution ≠ remote canonical authority.** Remote workers execute admitted work; the logical Host decides what may execute and what results mean canonically.
14. **Scheduler = policy; Host state machines = truth.** Scheduling choices cannot create effect, verification, completion, or semantic Program facts.

---

## 5. Current position — closed foundation through P-01

ALCODE currently has a fixed-topology autonomous Program runtime.

```text
Phase 0.0–0.9 foundation              CLOSED
Phase 1.0 Durable ProgramState        CLOSED
Phase 1.1 Default Program execution   CLOSED
S-01 Replaceable Agent runtime        CLOSED
P-01 Production Program Agent         CLOSED
                                        │
                                        ▼
NEXT ARCHITECTURAL FRONTIER
Adaptive Program semantics             PLANNED / NOT AUTHORIZED
```

The current production path is approximately:

```text
caller objective
  ↓
durable Host input admission
  ↓
Host planning episode
  ↓
real model planning through tracked Host reads
  + exact Host verifier catalog
  ↓
bounded Program proposal
  ↓
Host validation and seal
  ↓
explicit Application acceptance
  ↓
fresh ProgramAttempt
  ↓
Host-requested Agent execution
  ↓
Host-mediated coding capabilities
  ↓
Host verification
    ├─ fail → retire Attempt → durable failure fact → fresh retry Attempt
    └─ pass → complete work → fresh successor Attempt if structurally ready
  ↓
Completion Oracle
  ↓
Program.completed
```

The authoritative P-01 as-built record is [`p-01-production-program-agent-as-built.md`](./p-01-production-program-agent-as-built.md).

### Proven baseline

The closed baseline includes:

- append-only canonical event history and rebuildable projections;
- durable Operation identity, effect uncertainty, reconciliation, and recovery;
- Host-owned capability admission and execution lifecycle;
- durable transcript reconstruction and replaceable-Agent hydration;
- governed context projection with `verbatim-v1` safe baseline and optional `graph-v1`;
- Host-owned Application Protocol and disposable React projection;
- Host-governed plugin/adaptor and code-observation boundaries;
- durable ProgramState, fixed required-work topology, ProgramAttempt authority, execution-base freshness, verification generations, recovery barriers, and Completion Oracle;
- default Program-backed local coding execution;
- replaceable Agent generations with scoped AgentRun and Inference lifetimes;
- production model-provider selection with no silent mock fallback;
- bounded model-driven Program planning through Host-tracked semantic reads;
- exact planning-time Host verifier catalog and real Host verification;
- replay-safe ProgramAttempt driving, retry, successor execution, Agent replacement, and fail-closed recovery.

### Current structural limitation

The accepted Program topology remains fixed after Program creation.

Current ALCODE can robustly execute:

```text
accepted fixed Program DAG
        ↓
Attempts
        ↓
verification / retry / successors
        ↓
completion
```

It cannot yet safely evolve canonical Program meaning while work is in flight:

```text
Program revision R1
        ↓
execution discovers missing/incorrect work
        ↓
revision proposal
        ↓
Program revision R2
        ↓
retain unaffected execution/evidence
invalidate affected execution/evidence
        ↓
continue under evolved canonical meaning
```

That is the next load-bearing architectural problem.

---

## 6. Architectural timescales

The forward architecture should preserve three distinct timescales.

```text
LONG — durable semantic intent
ProgramState
ProgramRevision
WorkItem

MEDIUM — renewable execution authority
ProgramAttempt
AgentGeneration
WorkspaceExecutionIdentity
Delegation

SHORT — disposable cognition and orchestration
InferenceScope
local task plan
WorkflowInvocation
individual capability calls
```

Conflating these timescales creates lifecycle bugs. A Program should not disappear because an Agent dies; an Attempt should not survive semantic invalidation; an inference should not become durable authority merely because its provenance is recorded.

---

# 7. Forward roadmap

The A-series is the preferred dependency order for the next architecture. Stage names describe outcomes, not pre-authorized implementation projects.

## A1 — Adaptive Program Revision and Progressive Decomposition

**Goal:** Allow canonical Program meaning and work topology to evolve safely after Program creation while preserving correct relationships to in-flight Attempts, verification evidence, recovery state, and future parallel work.

Expected semantic shape:

```text
ProgramState
    │
    ▼
ProgramRevision
    │
    ▼
RevisionImpact
    │
    ▼
WorkItem
    │
WorkItemGeneration
    │
    ▼
AttemptAuthority
    │
    ▼
ProgramAttempt
```

A1 should define immutable/revisioned Program semantic transitions, compare-and-swap revision admission, stale concurrent proposal rejection, WorkItem identity/generation, progressive child decomposition, refinement/correction/scope-amendment distinctions, inherited authority envelopes, RevisionImpact, relevance-scoped Attempt/verification invalidation, rebuildable revision lineage, and completion rules proving no unresolved required decomposition remains.

A1 should introduce only the eligibility/Attempt-admission semantics required by adaptive work. It should **not** introduce general parallel workspaces, durable subagent teams, Code Mode, learned procedures, or remote workers.

**Why first:** Every later long-horizon feature becomes harder and less trustworthy if canonical Program meaning cannot evolve rigorously.

## A2 — Durable Inference Provenance and Provider Independence

**Goal:** Make model inference operationally reconstructable and provider-independent without turning historical inference into execution authority.

P-01 already provides a real production model path. A2 is therefore the durable provenance/provider-abstraction stage, not “add the first production model.”

A future `InferenceRecord` should causally bind inference identity to ProgramState/Revision/Attempt/WorkItem, Agent generation/run, provider/model configuration, context receipt, capability projection, workspace execution base, request/response identity, tool-call lineage, outcome, and timestamps.

Invariant:

> **InferenceRecord is causal provenance, never execution authority.**

Replaying historical inference creates new current authority; it does not resurrect an old Attempt, generation, or capability scope.

Provider direction may include Anthropic, OpenAI, OpenAI-compatible services, and local/self-hosted OpenAI-compatible providers where product requirements justify them.

## A3 — Semantic SDLC Capability Layer

**Goal:** Add typed engineering operations where semantics improve verification, reconciliation, authorization, reproducibility, or evidence quality.

Candidate capability families include repository inspection/status, code and symbol search, dependency inspection, patch/create/delete/refactor operations, build/tests/benchmark/typecheck/lint/static analysis/coverage, Git operations, and artifact inspection/comparison.

These are semantic façades over Host-governed effects, not a second authority layer. A generic process capability remains a deliberate escape hatch for unknown project-specific commands.

Rule:

> Create a semantic capability when its semantics materially improve correctness, evidence, authorization, recovery, or reproducibility.

## A4 — Capability Workflow VM

**Goal:** Let the model author short-lived control programs for mechanical sequences without another model inference for every step.

“Code Mode” may be a product label; architecturally this should be a restricted capability-oriented workflow VM:

```text
Generated Workflow IR
        │
        ▼
disposable interpreter
   ┌────┴──────────────┐
   ▼                   ▼
pure computation    capability instruction
                         │
                         ▼
                  CapabilityBroker
                         │
                         ▼
                     Operation
```

The initial IR should support bounded variables, conditionals, loops, pure transformations, structured capability calls/errors, and returns. Before physical sandboxing exists it must not provide direct filesystem/network access, arbitrary process spawning, dynamic module loading, `eval`, event-log mutation, ProgramState mutation, or secret access.

Workflow failure never replaces Operation truth. A partially executed workflow may contain confirmed, failed, or indeterminate Operations that remain individually authoritative.

## A5 — Sandboxed Execution Providers

**Goal:** Add physical isolation while keeping the Host outside the sandbox.

Introduce a `WorkspaceExecutionProvider`-class abstraction supporting local process execution and isolated environments such as containers, then later remote containers/VMs.

The first serious isolation backend should provide explicit mounts, unprivileged execution, CPU/memory/process/output bounds, network restrictions, scrubbed environment, explicit secret projection, and deterministic cleanup.

A4 may precede A5 only while the Workflow VM is restricted to Host capability instructions. Arbitrary generated code should not become a normal execution path before physical isolation exists.

## A6 — Procedure Optimization and Lifecycle

**Goal:** Convert repeated successful experience into governed reusable procedures without allowing learned code to self-install or acquire independent authority.

```text
Level 0 — atomic Host capabilities
Level 1 — ephemeral Workflow VM programs
Level 2 — validated reusable procedures
```

Expected lifecycle:

```text
trajectories
  ↓
Candidate
  ↓
static validation
  ↓
sandbox evaluation
  ↓
behavioral verification
  ↓
Experimental
  ↓
promotion decision
  ↓
Stable ProcedureGeneration
   ┌───────┼─────────┐
   ▼       ▼         ▼
 merge  quarantine  retire
```

The target is a **Procedure Optimization System**, not merely a Skill Store. A large Procedure Registry should be distinct from the small context-specific Active Procedure Projection shown to an inference.

Procedure applicability is evidence-bound and version-sensitive. Capability-contract changes, ecosystem assumptions, execution-provider requirements, or observed failure domains may invalidate applicability without erasing provenance.

Core invariant:

> A self-improving Agent may learn new ways to compose authority; it must never learn new authority for itself.

## A7 — Isolated Parallel Workspace Execution

**Goal:** Introduce useful concurrency through independent execution domains rather than weakening same-workspace serialization.

Initial isolation can use Git worktrees or equivalent independently identified workspace generations. A future `WorkspaceExecutionIdentity` should distinguish repository/base revision, branch/worktree, environment generation, sandbox identity, and observed workspace state.

Parallel work creates an explicit integration boundary:

```text
branch/worktree implementation
        ↓
local verification
        ↓
integration operation
        ↓
new integrated workspace generation
        ↓
integration verification
```

Passing verification on branch A does not verify the merged integration workspace. Same-workspace serialization remains the safe default.

## A8 — Durable Delegation over Replaceable Agents

**Goal:** Add bounded subagent/delegation semantics only after the Program can evolve and independent execution domains exist.

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

A Delegation may carry an authority ceiling, workspace identity, specialization hint, resource/cost budget, and current Attempt. Agent or model replacement must not change the identity of the delegated obligation. Authority topology remains Host-centered rather than forming chains of privileged Agents.

## A9 — Remote Execution

**Goal:** Move execution across machines without moving canonical authority away from the Host.

The remote protocol must preserve Operation identity, worker generation/incarnation, leases/fencing, transport retry identity, idempotency identity, effect reconciliation, result provenance/authenticity, and worker-loss handling.

The existing separation between execution outcome, effect certainty, and reconciliation state remains intact. Timeout or worker disappearance cannot mean “the mutation did not happen.”

## A10 — Autonomous Program Policy Scheduling

**Goal:** Add long-running autonomous policy over the canonical Program runtime.

By this stage the runtime should already derive semantic eligibility, issue Attempts, isolate execution domains, delegate work, and preserve recovery truth. A10 adds policy sophistication rather than becoming the first scheduler.

The scheduler may reason about required/eligible work, refinement, concurrency, workspace/provider placement, model/Agent specialization, procedure projection, blockers, stale evidence, replan decisions, and budget.

```text
Scheduler = policy
Host state machines = truth
```

The scheduler observes canonical state and proposes/advises admissions. It does not create completion, effect, or verification facts.

## A11 — Research / Runtime Ecosystem and Product Maturity

**Goal:** Make ALCODE a strong experimental and developer runtime without turning it into an enterprise administration platform.

Likely extension seams include `ModelProvider`, `PlanningStrategy`, `ContextStrategy`, `MemoryStrategy`, `ReasoningStrategy`, `VerificationStrategy`, `ProcedureLearner`, `CapabilityProvider`, `AgentRuntimeModule`, `WorkspaceExecutionProvider`, `SchedulingStrategy`, and `DelegationStrategy`.

The target research property is that the same Program/repository/capability environment can be exercised across different models and harness strategies while preserving the Host correctness substrate.

Benchmark principle:

> **same model, different harness**

---

## 8. Dependency rationale

Preferred ordering:

```text
adaptive Programs
      ↓
durable inference provenance
      ↓
semantic SDLC capabilities
      ↓
Workflow VM
      ↓
sandboxed execution
      ↓
procedure optimization
      ↓
parallel isolated workspaces
      ↓
durable delegation / subagents
      ↓
remote execution
      ↓
autonomous policy scheduling
      ↓
research/runtime ecosystem maturity
```

The order may change only through an explicit successor objective. Several dependencies are architectural:

- **Adaptive Programs before subagents:** multiple Agents executing a fixed plan faster is not long-horizon adaptation.
- **Semantic capabilities before Workflow VM/procedures:** reusable orchestration is safer over typed Host-governed effects than over opaque shell behavior.
- **Workflow VM before procedures:** a restricted executable representation gives candidate procedures a governable form before long-term retention.
- **Sandbox before broader learned execution:** synthesized code should not gain unrestricted OS/network authority because it was learned from successful trajectories.
- **Isolated workspaces before subagents:** safe parallel effects should exist before multiplying cognition workers.
- **Local isolation before remote workers:** distributed failure modes should extend a proven local execution-provider contract.
- **Autonomous scheduling late:** sophisticated policy is valuable only after trustworthy semantic work, execution domains, delegation, procedure applicability, and recovery state exist.

---

## 9. Verification and completion direction

As Program semantics become dynamic, completion must become stricter rather than more model-dependent.

The eventual Completion Oracle should be able to establish at one protected canonical cut that:

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

Implementation done is not equivalent to verification current. Previous passing evidence is not automatically current after material Program or workspace change.

---

## 10. Benchmark direction

Future stages should preserve two benchmark families.

### Coding capability

Measure task success, tests/regressions, patch quality, wall-clock time, token/model/tool calls, human interventions, and eventually parallel speedup.

### Runtime integrity

Adversarially test Agent/Host loss, stale Attempt/revision/inference authority, workspace drift, timeout after write, worker disappearance, duplicate requests, verification invalidation, and procedure dependency drift. Measure duplicate effects, stale-authority admission, recovery/reconciliation correctness, invalid evidence reuse, and incorrect completion.

Every major objective should retain the established proof discipline: semantic proof, adversarial lifecycle proof, recovery proof, and capability proof where relevant.

---

## 11. Immediate next action after P-01

P-01 is closed. Its closure does **not** authorize successor work.

The recommended next architecture objective is **A1 — Adaptive Program Revision and Progressive Decomposition**.

Before A1 implementation begins, its separate plan should freeze at least:

```text
What exactly is a ProgramRevision?
What transaction admits the next revision?
How are stale revision proposals rejected?
What changes preserve WorkItemId?
What advances WorkItemGeneration?
What requires a new WorkItemId?
What does decomposed mean?
How is a child graph bounded by inherited authority?
What is refinement vs correction vs scope amendment?
Which revisions invalidate which Attempts?
Which revisions invalidate which verification evidence?
How is RevisionImpact derived?
How do concurrent revision proposals race?
How does recovery reproduce exact revision lineage?
How does cancellation interact with pending revision work?
How does Completion prove no unresolved required decomposition remains?
```

The A1 plan must be explicitly reviewed and frozen before A1 production implementation begins.

---

## 12. Roadmap maintenance rule

This file is intentionally more stable than objective plans.

Update it when:

1. a major objective closes and the current-position section becomes stale;
2. explicit product direction changes the long-term architecture;
3. implementation evidence proves a roadmap dependency or architectural assumption wrong;
4. a durable stage is intentionally added, removed, or materially reordered.

Do **not** rewrite the roadmap because an implementation detail, PR sequence, provider choice, or reversible mechanism changes. Historical implementation facts belong in phase plans and closure records rather than accumulating indefinitely here.

---

## 13. Current status summary

```text
CLOSED FOUNDATION
────────────────────────────────────────────────────────
0.x  Owned Host/runtime, durability, cognition, context,
     Application Protocol, adapters
1.0  Durable ProgramState
1.1  Default Program-backed execution
S-01 Replaceable Agent runtime
P-01 Production Program Agent

FORWARD ARCHITECTURE — NOT AUTOMATICALLY AUTHORIZED
────────────────────────────────────────────────────────
A1   Adaptive Program revision and decomposition     NEXT
A2   Durable inference provenance/provider breadth
A3   Semantic SDLC capabilities
A4   Capability Workflow VM
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
fixed-topology autonomous Program      CLOSED / PROVEN
                 │
                 ▼
adaptive long-horizon Program          NEXT DESIGN OBJECTIVE
```

That transition should be solved rigorously before adding higher-level execution features that depend on evolving Program meaning.
