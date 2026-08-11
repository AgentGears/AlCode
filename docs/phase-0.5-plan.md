# Phase 0.5 — Host runtime + durable cognition integration

Status: **CLOSED**
Base: Phase 0.4 closed on `main` at `4c82c8c`.
Closure: PR #7 merged on 2026-08-11; source head `82aac97ceb74f0ae6151f27ab352d20c5b2e053d`; squash/main commit `9b06f4ace2921db599d5bbecce1bd21c73748d39`.
Verification: CI run `31522355607` completed successfully; `pnpm gate:0.5` passed while composing `gate:0.4`, including the replaceable-Agent, Host-recovery, durable-work, completion-authority, and ownership-boundary proofs.

This file is the frozen implementation plan and completed contract for Phase 0.5. The body is retained as the authoritative scope that was executed; it is not an open work list.

## Objective

Establish a Host-owned runtime that supervises a replaceable Agent behind an explicit semantic protocol boundary, mediates environmental capability execution, binds the existing memory and reasoning semantic engines to canonical Host-owned events/projections, and proves continuity across Agent replacement and Host recovery.

The load-bearing proof is:

```text
kill Agent
!= kill session
!= lose operation identity
!= lose reasoning
!= lose memory
!= repeat environmental mutation

replace Agent
→ resume
→ orient
→ act
```

## Frozen ownership

The Host owns session lifetime, workspace authority, permissions/policy, capability execution, operation identity/lifecycle, canonical event admission, projection barriers, recovery, durable supervised work, and the final completion transition.

The Agent proposes actions and produces criterion evidence. It does not own the event store, workspace lock, operation persistence, scheduler claims, environmental processes, or final lifecycle transition.

`@alcode/cognition-runtime` owns orchestration semantics: orientation, recall policy, verification/evidence policy, reinforcement decisions, consolidation policy, and completion assessment evidence. It never owns SQLite, the OS lock, capability processes, or direct canonical event append.

The existing `@alcode/memory` and `@alcode/reasoning` packages remain semantic engines and stay frozen except for additive integration events/adapters required to bind environmental action into their already-frozen semantics.

## Packages and surfaces

```text
packages/agent-protocol
packages/host-runtime
packages/cognition-runtime
extensions/cognition
```

The initial transport is local Node IPC. The semantic Agent Protocol is frozen; universal wire encoding and remote transport remain deferred.

`extensions/cognition` is a thin Agent-side adapter only. It may import `@alcode/agent-core` and `@alcode/agent-protocol`; it must not import storage, workspace locking, memory, reasoning, or SQLite.

## Agent Protocol v1

Agent → Host:

- hello
- assistant.message
- capability.request
- criterion.evidence
- agent.idle
- agent.error

Host → Agent:

- hello
- session.open
- session.resume
- input.admitted
- context.provide
- capability.result
- cancel
- shutdown

Every protocol request/response has protocol-local correlation identity. Durable `operationId` is always minted by the Host.

Phase 0.5 `context.provide` is only bootstrap/orientation metadata. It is not transcript reconstruction, token budgeting, compaction, or graph context compilation; those remain 0.6/0.7.

## Host session semantics

### Open

```text
resolve workspace
→ acquire writable ownership
→ open locked store
→ catch up projections
→ recover interrupted operations/work
→ start durable session
→ supervise Agent
```

### Agent replacement

Agent exit does not append `runtime.session.stopped`. The Host keeps the session alive, may finish already-authorized Host-owned capability execution, launches a replacement Agent, sends `session.resume`, and the replacement calls `orient` against the same durable state.

### Host reopen

A durable session with `runtime.session.started` and no stop is resumed, not started again. Startup catches up projections and applies Phase 0.2 operation uncertainty recovery before attaching a replacement Agent.

### Stop

Only the Host may stop the session after completion/cancellation/shutdown policy. It catches correctness-critical projections, shuts the Agent down, closes the DB, then releases the workspace lock.

## Canonical admission queue

All Host state-changing requests pass through one serial canonical admission queue. It provides a stable semantic snapshot immediately before validation and resolves Phase 0.4 `ReasoningBatchIntent.symbolicRefs` without introducing a second store.

Atomic reasoning batches are appended as one canonical event batch after symbolic references are resolved to deterministic event-sequence-derived node IDs.

## Storage read-model facade

The locked store remains opaque. Add bounded read APIs for operations, transcript, memory, and reasoning. In particular, add a `ReasoningQuery` that returns a session-scoped projection snapshot that the Host converts to `@alcode/reasoning` graph state. No raw SQLite handle crosses the Host/storage boundary.

No schema change is required for this phase unless concrete implementation evidence proves otherwise.

## Cognition runtime

Primary operations:

- orient(snapshot)
- recall(snapshot, request)
- capability-result interpretation
- verification correlation
- memory reinforcement decisions
- completion assessment

Orientation is structured state, not provider prompt text. It includes active objective/hypotheses/assumptions/alternatives, pending verification contracts, decisive evidence, diagnostics, and pending operations.

## Memory binding

- Search recall records `memory.reinforced(kind=seen)` for returned memories.
- Direct memory-ID recall records `memory.reinforced(kind=used)`.
- `remember` validates memory semantics and Host-supplied provenance, then admits `memory.created`.
- Every fifth use may request bounded durable consolidation work.
- No automatic transcript extraction, offload/rehydration, or detached worker.

## Reasoning integration events

Add only the environmental integration events needed by 0.5:

- `action.recorded`
- `evidence.recorded`
- `verification.result.correlated`

The reducer/projection turn environmental capability lifecycle into durable reasoning artifacts. Read-only results become Observation evidence; mutating/execution results become ActionResult evidence. Verification correlation preserves Phase 0.4 conservative semantics: unique untrusted match creates EXECUTES only; trusted support/contradiction adds epistemic edges; ambiguous/unmatched outcomes create no correlation event.

## Capability lifecycle

Before environmental execution:

```text
freeze args
→ Host policy
→ prospective verification match
→ mint operationId
→ append operation.requested + operation.started + action.recorded
→ catch operations/reasoning projections
→ execute Host-owned capability
```

After execution:

```text
normalize result
→ evaluate verification outcome
→ append operation.completed + evidence.recorded + optional verification.result.correlated
→ catch operations/reasoning projections
→ return result to Agent
```

If the Agent dies after Host execution begins, the Host operation identity survives. If the Host dies after a possible external mutation but before terminal commit, Phase 0.2 recovery marks the operation indeterminate/pending and no automatic retry occurs.

## Host policy

0.5 provides an owned policy contract, not permission UX. Read-only tools may be allowed by default; mutating tools are configurable allow/deny; unknown tools deny. A denied request must not append `operation.started` and must not execute environmental code.

## Durable supervised work

Keep scheduler scope minimal and event-sourced. Use `runtime.work.requested/claimed/completed/failed/interrupted` events and reconstruct the small work ledger from canonical events. Only `memory.consolidation` is activated in 0.5.

A consolidation retry uses idempotent semantic admission keyed by `workId`, proving recovery without duplicate semantic effect. No cron, timers, priorities, recurring automation, remote workers, leases, or distributed claims.

## Completion authority

Agent idle/stop is criterion evidence, not authority. Host completion requires:

1. clean Agent idle/stop evidence;
2. no requested/started/pending operation;
3. no pending verification contract for active reasoning;
4. no blocking diagnostic (`contradicted_dependency`, `evidence_staleness`, `unsupported_conclusion`);
5. no incomplete session-scoped durable cognition work.

`missing_falsifier` is advisory by itself.

Only the Host performs the final `runtime.session.stopped` transition.

## Required proofs

- cognition reasoning roundtrip
- cognition memory roundtrip
- verification roundtrip including trusted/untrusted/ambiguous behavior
- atomic open-investigation symbolic-reference resolution
- permission before environmental execution
- operation visible before environmental action
- Agent replacement continuity with same session/operation/cognition state
- Host reopen with uncertain mutation: pending reconciliation, no automatic retry
- durable memory-consolidation recovery without duplicate semantic effect
- Host completion authority
- extension thinness / Agent no-storage/no-workspace-authority boundary checks

## Exit gate

`pnpm gate:0.5` composes `gate:0.4` and emits `passed` only when the frozen proofs above pass.

## Explicit exclusions

Phase 0.5 does not implement: verbatim transcript context reconstruction (0.6), graph context compilation (0.7), token budgeting/compaction, START_NOW/GUIDE/QUEUE admission semantics (0.8), application/UI protocol, hooks/MCP/ACP (0.9), remote Agent transport, public wire encoding, SSH/WSL/Docker workspace backends, browser subsystem, subagents/multi-agent identity, task/workflow engine, general scheduler/automation, recurring work, distributed claims, memory extraction, Ola offload/rehydration, automatic transcript→memory creation, learned/RL cognition policy, or provider redesign.

## Frozen closure criterion

Phase 0.5 closes when a Host-owned runtime supervises an Agent behind an explicit replaceable protocol boundary; the Agent can request but cannot directly execute environmental capabilities or mutate durable cognition; memory and reasoning transitions pass through Host validation into canonical events and rebuildable projections; capability outcomes become durable Action/Observation evidence and are conservatively correlated with prospective verification contracts; Host-owned session, operation, and cognition state survive Agent replacement and Host recovery; bounded durable cognition work survives interruption without duplicate semantic effects; the Host—not the Agent—owns completion; and `pnpm gate:0.5` emits `passed` while composing the closed Phase 0.4 gate.
