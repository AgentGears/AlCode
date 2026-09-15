# ALCODE Comprehensive Project Review — 2026-09-15

**Status:** Current-state architecture review after A2/S-04 closure  
**Repository baseline:** `main@eed99c2fde14e4e0e981c67b873fb91db3ed3c5f`  
**Landed tree:** `8a695ff31afc98f24454e561d47ef3a5a9536ecb`  
**Scope:** Assess the landed product/runtime, validate the roadmap trajectory, identify concrete drift or architectural defects, and record bounded corrections.  
**Authority:** This review may correct documentation and status drift. It does **not** itself authorize implementation of a successor objective.

---

## 1. Executive assessment

ALCODE has crossed an important architectural threshold. It is no longer best described as a coding-agent loop with added durability. The landed system is a **durable autonomous software-engineering runtime / transactional control plane in which LLMs are replaceable semantic workers rather than canonical authority**.

The closed stack now includes:

```text
0.0–0.9  owned Host/runtime, durability, cognition, context,
         Application Protocol, plugins/MCP/hooks/ACP/CodeIntelligence
1.0      Durable ProgramState
1.1      Default Program-backed execution
S-01     Replaceable Agent runtime
P-01     Production Program Agent
A1       Adaptive Program revision / progressive decomposition
P-02     Semantic planning + typed verification retry
S-02     ProgramAttempt-aware Code Mode
A2/S-04  Reconstructable Inference Provenance
```

The architecture is internally coherent. The central authority doctrine remains intact across all later additions:

> The model may reason, plan, propose, and request actions. The Host alone owns canonical work state, executable authority, capability admission, environmental effect truth, verification, recovery, and completion.

The A2 landing materially strengthens that doctrine rather than weakening it. One provider inference can now be durably reconstructed across context, provider/model semantics, capability bindings, assistant output, direct tool calls, S-02 nested subcalls, and Host Operations without allowing historical inference provenance to become current authority.

**Review conclusion:** the project trajectory remains sound. No evidence supports reordering the roadmap around subagents, semantic graphs, procedures, or remote execution. The next load-bearing design candidate should move from A2 to **A5 — Sandboxed Execution Providers / physical execution-provider isolation**. A5 implementation is not authorized by this review; the next step is a bounded design/forcing study and freeze only if separately approved.

The one demonstrated project-level defect is **documentation/status drift**: several active navigation documents still describe S-02 as the current baseline and A2 as future work even though A2 is closed on `main`. Those files should be corrected immediately because they now misstate repository reality and would distort subsequent planning.

---

## 2. Evidence baseline

A2/S-04 was reviewed on exact candidate head:

```text
f23a6cc54b5d1f48109e1eb4d60854905626c312
```

and squash-merged as:

```text
eed99c2fde14e4e0e981c67b873fb91db3ed3c5f
```

The landed tree is:

```text
8a695ff31afc98f24454e561d47ef3a5a9536ecb
```

The permanent post-merge `A2 Inference Provenance` workflow passed on that exact `main` commit, including `pnpm gate:a2-inference-provenance`. The A2 gate composes the declared S-02/product predecessor proof surface. The repository also exposes the prior permanent phase/product gates through `package.json`.

At review time:

- there are no open pull requests;
- there are no open issues;
- `main` points to the A2 landing commit;
- the repository contains the expected owned package boundaries for Agent, Host, ProgramState, context, AI/provider adapters, CodeIntelligence, Code Mode, plugins/MCP/hooks/ACP, storage, transcript, memory, reasoning, and Application Protocol.

This review therefore treats A2 as **closed**, not as an active implementation objective.

---

## 3. Current architecture

The effective runtime now has the following causal and authority shape:

```text
caller objective
  ↓
Host durable input admission
  ↓
Host planning episode
  ↓
Host-tracked planning observations
  + semantic CodeIntelligence
  + exact verifier catalog
  ↓
model Program proposal
  ↓
Host validation / seal
  ↓
explicit Application acceptance
  ↓
adaptive ProgramState / ProgramRevision / WorkItem generation
  ↓
fresh ProgramAttempt
  ↓
replaceable Agent generation
  ↓
exact Host inference authorization cut
  ↓
InferenceEpoch provenance
  ↓
provider inference
    ├─ direct Host-mediated capability calls
    └─ S-02 run_code
          ↓ fresh bounded QuickJS worker
          ↓ explicit parent/subcall lineage
          ↓ each environmental subcall returns to Host admission
  ↓
independent Host Operations / effect truth
  ↓
typed Host verification
    ├─ failure → retire Attempt + durable failure → fresh retry Attempt
    └─ success → satisfy work + fresh successor Attempt when ready
  ↓
optional Host-admitted semantic Program revision
  ↓
Completion Oracle
  ↓
Program.completed
```

The most important separations are still explicit:

1. **Agent proposal is not Host admission.**
2. **Observation is not canonical Program truth.**
3. **Capability visibility is not execution authorization.**
4. **Operation return is not effect certainty.**
5. **Inference/worker completion is not objective completion.**
6. **Inference provenance is not executable authority.**

These separations are now reinforced across the major runtime surfaces rather than concentrated in one subsystem.

---

## 4. Domain-by-domain assessment

### 4.1 Canonical durability and ownership — strong

The event log remains the durable historical record and projections remain rebuildable. Host state-changing admission is serialized. Workspace write ownership remains single-writer and process-held. Agent, UI, adapters, and local orchestration workers remain replaceable participants rather than state owners.

No review evidence suggests a need to replace the event/projection architecture or split canonical authority across services.

**Disposition:** preserve.

### 4.2 Program semantics and execution authority — strong

ProgramState, ProgramRevision, WorkItem generation, and ProgramAttempt provide a clear separation between durable intent and renewable execution authority. Verification failure, successor work, Agent replacement, and semantic Program revision all result in fresh authority rather than accidental continuation of stale execution rights.

This remains one of ALCODE's strongest differentiators relative to session-oriented agent systems.

**Disposition:** preserve; do not collapse future delegation or scheduling into ProgramState shortcuts.

### 4.3 Environmental effects and recovery — strong

Capability execution is Host-owned and durable Operations retain independent identity from provider/model tool calls. Effect uncertainty remains explicit; failure, cancellation, timeout, Agent loss, or transport loss do not prove absence of mutation. Reconciliation remains the mechanism that can settle indeterminate effects.

A2 correctly leaves this layer untouched: inference records explain causality but do not settle Operation effects.

**Disposition:** preserve as the non-negotiable basis for later isolated/remote execution.

### 4.4 Replaceable Agent runtime — strong

Session lifetime, Agent process lifetime, ProgramAttempt lifetime, and inference lifetime are distinct. Agent replacement cannot transfer local state as authority. Durable transcript/context/Program/Operation state lives outside the Agent.

This is the correct substrate for eventual delegation because it already treats a worker as replaceable cognition rather than as durable work identity.

**Disposition:** preserve.

### 4.5 Planning and semantic observation — strong, intentionally bounded

P-01/P-02 provide model-driven planning through Host-governed tracked reads and semantic CodeIntelligence. Planning observations are bounded, freshness-aware evidence, not execution authority.

The UnifiedModel study and Architecture Pattern Register make a credible case for a future semantic software/object graph and context-linked procedure discovery. That evidence strengthens the *planning-side* direction, but it does not demonstrate that ALCODE currently needs a semantic graph before physical isolation. The existing adoption trigger remains appropriate: promote such a layer only when representative repositories show repeated, material reconstruction cost or planning-quality loss that the typed semantic layer measurably improves.

**Disposition:** keep A3 semantic capability expansion demand-driven; do not insert a semantic-graph megaphase ahead of A5.

### 4.6 Inference provenance — closed and correctly non-authorizing

A2 now provides a Host-minted `InferenceEpochId` with one coherent authorization cut binding Session, Agent generation, context receipt/source sequence, provider/model semantics, capability catalog/bindings, and ProgramAttempt/execution-base provenance when present.

The provider-preparation fence preserves uncertainty honestly: durable preparation permits the Agent to invoke the provider but does not prove invocation occurred. Agent terminal reports do not manufacture provider response evidence. Assistant evidence and actually observed provider-native identifiers can establish stronger observation state.

Direct and Code Mode tool causality is durably reconstructable, including explicit S-02 `parentToolCallId` and `localSubcallIndex` rather than parsing local identifier strings.

**Disposition:** A2 closed. Do not expand InferenceEpoch into a lease, capability, completion fact, or Program authority.

### 4.7 Code Mode — strong bounded realization, not a sandbox

S-02 solves local orchestration efficiency without granting ambient environmental access. A fresh QuickJS worker receives only an exact projected SDK; every environmental sub-dispatch returns to ordinary Host capability admission and gets its own Operation identity.

This is useful containment, but it should not be confused with a general-purpose hostile-code security boundary or an execution-provider abstraction. The roadmap is correct to require stronger physical isolation before arbitrary generated OS code or remote execution becomes a normal execution path.

**Disposition:** preserve S-02 as a local orchestration transport. Do not grow it sideways into A5.

### 4.8 Extensions and external protocols — strong adapter discipline

Phase 0.9 successfully keeps Agent Plugins, MCP, hooks, ACP, and CodeIntelligence below Host authority. Dynamic capability generations are non-reusable and inference-visible tool catalogs are bound to exact Host snapshots. External protocols terminate at adapters rather than becoming the internal state model.

The project already has ownership/static boundary tests. UnifiedModel's architecture guard is a useful engineering reference, but there is no evidence that ALCODE needs a new independent architecture-governance subsystem before the next product objective.

**Disposition:** preserve and extend existing boundary tests only when a new objective creates a concrete dependency edge worth enforcing.

### 4.9 Product/experience surface — adequate for the architecture stage

The Experience Plane is correctly disposable and consumes Host-authored public state. The architecture is substantially ahead of product polish, but that is not currently a correctness defect. Full graph/context/trace inspectors, kanban-style multi-agent UI, browser execution, and richer product surfaces remain deferred unless separately selected as product objectives.

**Disposition:** no roadmap reordering based solely on UI breadth.

---

## 5. What changed after A2

Before A2, the primary unresolved causal gap was:

```text
provider inference
   ? exact durable identity
   ? exact provider/model semantics
   ? exact context/capability cut
   ? assistant correlation
   ? direct tool → Operation correlation
   ? run_code nested lineage
```

After A2, that gap is closed. The architecture can now distinguish three different things that must remain separate:

```text
ProgramAttempt     = renewable execution authority
InferenceEpoch     = reconstructable cognition provenance
Operation          = durable environmental execution/effect truth
```

That distinction is the key reason the roadmap can now safely move to execution-environment isolation. Multiplying execution environments before fixing inference causality would have made debugging, comparison, replacement, and later delegation substantially harder.

---

## 6. Trajectory validation

The current dependency order remains justified:

```text
A2  reconstructable inference provenance            CLOSED
 ↓
A5  physical execution-provider isolation            NEXT DESIGN CANDIDATE
 ↓
A6  governed reusable procedure lifecycle
 ↓
A7  isolated parallel workspaces
 ↓
A8  durable delegation / replaceable subagents
 ↓
A9  remote execution
 ↓
A10 autonomous Program policy scheduling
 ↓
A11 research/runtime ecosystem maturity
```

A3 remains incremental and demand-driven. A4 is already closed as the bounded S-02 realization.

### Why A5 should remain next

A5 addresses the next genuinely load-bearing boundary: today ALCODE has strong **logical** execution authority, but the ordinary local filesystem/process world is still one physical execution environment. Future procedures, parallelism, delegation, and remote workers all become materially safer if environmental execution first has a provider-neutral world boundary with exact identity and containment semantics.

The Architecture Pattern Register's capability Definition/Provider/Consumer separation is especially relevant here. A5 is the first stage where local filesystem/process execution and an isolated backend need to implement the same ALCODE semantic contract. The provider abstraction must carry ALCODE freshness, authority, effect, and recovery semantics rather than hiding them behind a lowest-common-denominator shell interface.

A bounded A5 design should answer at least these questions before implementation:

```text
1. What is the semantic WorkspaceExecutionProvider contract?
2. What identifies one execution world/generation?
3. How do filesystem and subprocess capabilities prove they address the same world?
4. How does ProgramAttempt execution-base authority bind to that world?
5. What invalidates an Attempt when a backend/world is replaced or reconnected?
6. Which containment controls are semantic requirements vs backend policy?
7. How are mounts, environment, secrets, network, CPU/memory/process/output bounds expressed?
8. How are teardown/quiescence and lost-worker uncertainty represented?
9. How does the existing local provider preserve current behavior exactly?
10. Which conformance tests prove local and isolated providers obey the same authority/effect contract?
```

A reasonable future implementation slicing would be:

```text
A5-1  semantic execution-provider contract + local adapter
A5-2  execution-world identity/freshness and coherent fs/process world
A5-3  isolated/container backend + explicit resource/network/env boundaries
A5-4  replacement/loss/quiescence/effect-recovery semantics
A5-5  product composition gate + as-built closure
```

This is a **design recommendation only**, not an implementation authorization or frozen acceptance boundary.

---

## 7. Alternatives considered

### Move directly to subagents / A8 — rejected for now

Subagents multiply cognition before the runtime has independently identified execution domains. That would make parallel effects and workspace ownership the harder problem while delegation identity is being introduced at the same time. A7/A8 sequencing remains safer: isolate execution domains first, then make durable delegation target those domains.

### Move directly to remote execution / A9 — rejected for now

Remote failure adds transport retries, reconnect, worker incarnation, leases/fencing, and uncertain side effects. A local isolated provider boundary should establish the world-identity and containment contract before distribution adds network failure modes.

### Move procedure learning ahead of isolation / A6 before A5 — rejected for now

Reusable procedures can eventually compose existing authority safely, but model-generated or learned execution patterns raise the value of containment. Physical isolation should precede broad reusable generated execution.

### Promote a semantic software graph as the next major phase — deferred

The UnifiedModel-derived pattern is compelling for planning quality and context efficiency, but no current repository evidence demonstrates that low-level reads + CodeIntelligence are the dominant bottleneck. The pattern remains a future candidate with a measurable adoption trigger.

### Add a second live model provider immediately — not required

A2 proves provider-neutral provenance semantics with Anthropic plus a deterministic non-Anthropic fixture. A second live provider may become useful for product breadth or comparative evaluation, but it is not required to make the current architecture valid and should not displace the A5 forcing boundary without explicit product direction.

---

## 8. Risks and watch items

These are not current blockers.

### R1 — Active documentation drift

README, roadmap, backlog, constitution status text, and A2 closure documentation still contain pre-A2 status claims. This is a real navigation/planning defect and is corrected by the companion documentation changes to this review.

### R2 — Provider-neutral semantics are not the same as broad provider diversity

The runtime now has a stronger provider-neutral inference contract, but production provider breadth remains intentionally limited. Future documentation should avoid using “provider independence” to imply a multi-provider product matrix that has not been implemented or tested live.

### R3 — `WorkspaceExecutionProvider` is not yet a concrete runtime abstraction

The roadmap names this future boundary, but current code does not yet expose such an abstraction. That is expected pre-A5 state, not technical debt to patch opportunistically. It should be designed under an explicit A5 contract rather than inserted piecemeal.

### R4 — Single-writer workspace semantics remain intentionally conservative

A7 will eventually need independently identified workspaces/worktrees rather than weakening same-workspace single-writer ownership. The current rule should remain unchanged until that objective is designed.

### R5 — Semantic graph/procedure candidates can create authority confusion if promoted casually

Any future semantic graph or procedure layer must remain planning/context evidence. Procedure text, semantic relationships, and model-selected applicability must never mint capability, verification, Program, or completion authority.

### R6 — `graph-v1` remains non-default

Nothing in A1–A2 changes the original evidence threshold for promoting graph context to the default. `verbatim-v1` remains the safety baseline unless a separate evidence-based product decision changes it.

---

## 9. Required adjustments from this review

The following changes are justified now because they correct factual drift rather than create new architecture:

1. Update `README.md` to identify A2/S-04 as closed and `main@eed99c2...` as the current closure point.
2. Update `docs/roadmap.md` so A2 is closed and A5 is the next **design candidate**, while preserving the rule that roadmap direction is not implementation authority.
3. Update `docs/backlog.md` so the inference-identity and durable tool-call correlation items record A2 implementation rather than future design status.
4. Update the status section of `docs/constitution.md` without changing its ten frozen principles.
5. Update `docs/a2-inference-provenance-as-built.md` with final reviewed/landed closure evidence.
6. Preserve the frozen A2 plan as historical contract, but add a closure note so readers do not mistake its original pre-implementation status for current repository state.

No code/runtime correction is required by the review evidence.

---

## 10. Architecture decision after review

### Current status

```text
A2 / S-04  CLOSED on main@eed99c2fde14e4e0e981c67b873fb91db3ed3c5f
```

### Trajectory

```text
A5 design/forcing study → A6 → A7 → A8 → A9 → A10 → A11
```

with A3 continuing as demand-driven semantic capability expansion.

### Explicit non-decisions

This review does **not** authorize:

- A5 implementation;
- a container technology or sandbox vendor;
- arbitrary model-written OS code;
- procedure learning/promotion;
- worktree parallelism;
- subagents/delegation;
- remote execution;
- autonomous scheduling;
- semantic graph implementation;
- `graph-v1` default promotion;
- a second live model provider.

Those remain separate product/design decisions under normal change control.

---

## 11. Review disposition

The landed architecture is coherent and the planned dependency order remains valid. The only demonstrated correction required by this review is repository documentation/status convergence after A2 closure.

**Disposition: Proceed with a bounded correction.**
