# ALCODE

A memory-native, verifier-driven coding agent and durable autonomous software-engineering runtime. TypeScript end-to-end.

ALCODE replaces a prior host-dependent plugin topology (Ola + Ouroboros as ZCode MCP sidecars) with an owned, integrated product in which memory, reasoning, tools, model access, persistence, UI, durable Program state, execution, verification, recovery, and inference provenance are governed by one codebase. The append-only event log is the canonical durable record; the Host owns admission, policy, execution lifecycle, recovery, transcript/context truth, Program truth, verification, and completion, while the Agent and Experience Plane consume Host-owned protocols and disposable projections.

**Status:** the closed product baseline now includes Phases 0.0–0.9, Phase 1.0 Durable ProgramState, Phase 1.1 Default Program Execution, S-01 Replaceable Agent Runtime, P-01 Production Program Agent, A1 Adaptive Program semantics, P-02 semantic planning + typed verification retry, S-02 Code Mode / ProgramAttempt-aware local orchestration, and A2/S-04 Reconstructable Inference Provenance. The current `main` closure point is `eed99c2fde14e4e0e981c67b873fb91db3ed3c5f` (`feat(a2): durable inference provenance and causal tool correlation (#318)`).

The runtime is no longer fixed-topology. Canonical Program meaning can evolve through A1 semantic revisions and WorkItem generations; P-02 gives the planner bounded Host-governed semantic code observations and typed verifier retry closure; S-02 allows one provider inference to perform bounded local orchestration while every environmental sub-dispatch still crosses ordinary Host capability/ProgramAttempt authority and receives an independent Host Operation identity; A2 makes the exact provider-inference → assistant/tool → Operation causal chain reconstructable without turning inference history into current authority.

The next load-bearing roadmap candidate is **A5 — Sandboxed Execution Providers / physical execution-provider isolation**. This is roadmap direction only: A5 requires a separately authorized bounded design/freeze before implementation.

`verbatim-v1` remains the product default; `graph-v1` remains opt-in.

`ref/` (gitignored) holds studied reference codebases — not part of this repo.

## Read first

1. [`docs/constitution.md`](docs/constitution.md) — the frozen architectural principles.
2. [`docs/roadmap.md`](docs/roadmap.md) — durable architecture direction and current sequencing.
3. [`docs/rules.md`](docs/rules.md) — hard runtime, storage, effect, cognition, context, Application, and extension rules.
4. [`docs/event-contract.md`](docs/event-contract.md) — canonical event envelope, producer, identity, versioning, and ownership semantics.
5. [`docs/a1-adaptive-program-freeze.md`](docs/a1-adaptive-program-freeze.md) — frozen A1 adaptive Program contract.
6. [`docs/p-01-production-program-agent-as-built.md`](docs/p-01-production-program-agent-as-built.md) — Production Program Agent closure.
7. [`docs/p02-macos-closure-evidence.md`](docs/p02-macos-closure-evidence.md) — P-02 platform closure evidence.
8. [`docs/s02-code-mode-as-built.md`](docs/s02-code-mode-as-built.md) — S-02 Code Mode as-built closure record.
9. [`docs/a2-inference-provenance-gap-study.md`](docs/a2-inference-provenance-gap-study.md) — forcing evidence for A2.
10. [`docs/a2-inference-provenance-plan.md`](docs/a2-inference-provenance-plan.md) — frozen A2/S-04 contract.
11. [`docs/a2-inference-provenance-as-built.md`](docs/a2-inference-provenance-as-built.md) — A2/S-04 implementation and closure mapping.
12. [`docs/project-review-2026-09-15.md`](docs/project-review-2026-09-15.md) — post-A2 comprehensive status/trajectory review.
13. [`docs/backlog.md`](docs/backlog.md) — deferred work with reactivation conditions.

Historical Phase plans and closure records remain under `docs/` and retain their original frozen/closure roles.

### Architecture decisions

- [`docs/adr/0001-event-and-projection-commit-semantics.md`](docs/adr/0001-event-and-projection-commit-semantics.md)
- [`docs/adr/0002-workspace-identity-and-locking.md`](docs/adr/0002-workspace-identity-and-locking.md)
- [`docs/adr/0003-tool-operation-uncertainty-and-recovery.md`](docs/adr/0003-tool-operation-uncertainty-and-recovery.md)
- [`docs/adr/0004-secret-admission-and-erasure.md`](docs/adr/0004-secret-admission-and-erasure.md)
- [`docs/adr/0005-runtime-ownership-boundaries.md`](docs/adr/0005-runtime-ownership-boundaries.md)

### Operational

- [`docs/threat-model.md`](docs/threat-model.md)
- [`docs/operation-recovery.md`](docs/operation-recovery.md)
- [`docs/provenance/`](docs/provenance/) — per-import provenance records.

## Current product path

```text
caller objective
  → durable Host input admission
  → Host planning episode
  → model planning through bounded tracked reads
      including P-02 semantic code observations
  → exact Host verifier catalog
  → bounded Program proposal
  → Host validation / seal
  → explicit Application acceptance
  → adaptive ProgramState / semantic ProgramRevision
  → fresh ProgramAttempt under exact WorkItem generation authority
  → replaceable Agent generation
  → exact Host inference authorization cut
  → Host-minted InferenceEpoch provenance
  → provider inference
      ├─ direct Host-mediated capabilities
      └─ optional S-02 run_code
             → bounded Agent-local QuickJS control flow
             → explicit parent/subcall lineage
             → each environmental subcall returns to ordinary Host admission
  → independent Host Operations / effect truth
  → typed Host verification
      fail → retire Attempt + durable failure fact → fresh retry Attempt
      pass → complete work → fresh successor Attempt when ready
  → optional semantic Program revision when admitted by Host authority
  → Completion Oracle
  → Program.completed
```

The Agent remains replaceable cognition. It does not own canonical ProgramState, semantic revision admission, ProgramAttempt currency, capability admission, Operation/effect truth, recovery, verification, execution-base identity, or completion. S-02 does not change that rule: `run_code` is a disposable local orchestration transport, not a second environmental authority. A2 also does not change it: `InferenceEpochId` explains durable causal provenance and is never accepted as executable authority.

## What ALCODE is built from

- **Agent loop:** pi (MIT), acquired as licensed source and converted into ALCODE-owned infrastructure. Provenance: [`docs/provenance/pi.md`](docs/provenance/pi.md).
- **Memory:** Ola-derived semantic contracts — retrieval, strength, reinforcement, lifecycle, and consolidation semantics.
- **Reasoning:** Ouroboros-derived semantic core — reasoning graph, falsifiers, verification contracts, critic, and diagnostics.
- **Host/runtime:** ALCODE-owned Agent Protocol, Host runtime, canonical admission, capability brokerage, adaptive Program authority, execution/recovery, verification, completion, and inference-provenance admission.
- **Transcript/context:** ALCODE-owned rich transcript domain, durable reconstruction, `verbatim-v1`, governed `graph-v1`, Host context authority, receipts, and replaceable-Agent hydration.
- **Code intelligence:** Host-governed revision-tracked semantic observations used by P-02 planning without making LSP/provider state canonical execution truth.
- **Code Mode:** fresh bounded S-02 QuickJS workers projected from one exact inference capability snapshot; environmental work remains ordinary Host Operations.
- **Inference provenance:** Host-minted A2 inference epochs bind one exact context/provider/capability/ProgramAttempt cut to assistant/tool/Operation lineage while remaining non-authorizing historical evidence.
- **Application Protocol + React experience:** Host-authored public state/commands consumed by disposable clients.
- **Extension and observation adapters:** Host-governed plugins, MCP, hooks, ACP, and CodeIntelligence adapters that do not become a second control plane.

## Why this shape

The prior topology ran cognition as per-session sidecars beneath an external host. ALCODE removes that accidental distribution by owning the cognitive loop and placing durable execution authority in the Host. Sessions, Agent processes, provider inference, local orchestration workers, clients, plugins, and later isolated/remote workers are replaceable participants around durable Host-owned truth.

The current load-bearing hierarchy is:

```text
ProgramState
     ↓
ProgramRevision / WorkItem generation
     ↓
ProgramAttempt
     ↓
Agent Generation
     ↓
InferenceEpoch provenance
     ↓
direct tool call OR S-02 local orchestration
     ↓
CapabilityBroker
     ↓
Host Operation
     ↓
effect / recovery / verification
     ↓
Completion Oracle
```

`InferenceEpoch` is deliberately a causal/provenance layer, not another authority level: current execution still requires ProgramAttempt/capability/execution-base validity and environmental truth still belongs to Host Operations.

## Closed milestones

```text
0.0–0.9  Owned foundation, durability, cognition, context, UI, adapters [CLOSED]
1.0      Durable ProgramState                                         [CLOSED]
1.1      Default Program-backed execution                             [CLOSED]
S-01     Replaceable Agent runtime                                    [CLOSED]
P-01     Production Program Agent                                     [CLOSED]
A1       Adaptive Program revision / progressive decomposition         [CLOSED]
P-02     Semantic planning + typed verification retry                 [CLOSED]
S-02     ProgramAttempt-aware Code Mode                               [CLOSED]
A2/S-04  Reconstructable Inference Provenance                         [CLOSED]
```

Every closed objective is backed by executable proof and/or an exact closure record. Gates drive sequencing, not calendars.

## Next

The repository is now at the boundary between a powerful adaptive single-Agent Program runtime with reconstructable inference causality and later provider-diverse execution environments, reusable procedures, parallel workspaces, delegation, and remote workers.

The next load-bearing roadmap candidate is **A5 — Sandboxed Execution Providers**: define a provider-neutral execution-world boundary that preserves current ProgramAttempt authority, execution-base freshness, Host Operation/effect uncertainty, teardown/quiescence, and Host canonical control while allowing the existing local path and an isolated backend to inhabit the same semantic contract.

A5 is intentionally before reusable learned procedures, isolated parallel workspaces, durable delegation/subagents, and remote execution. The roadmap remains:

```text
A5 physical execution-provider isolation
  → A6 governed reusable procedures
  → A7 isolated parallel workspaces
  → A8 durable delegation / subagents
  → A9 remote execution
  → A10 autonomous policy scheduling
  → A11 research/runtime ecosystem maturity
```

A3 semantic SDLC capability expansion remains demand-driven alongside these stages. A5 implementation is **not** authorized merely by appearing here; a bounded design/freeze remains a separate client decision.
