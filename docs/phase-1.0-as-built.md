# ALCODE Phase 1.0 — As-Built Implementation Map

**Status:** IMPLEMENTED; closure requires `pnpm gate:1.0` to pass at the exact final implementation source head.

**Frozen contract:** `docs/phase-1.0-freeze.md`, approving the composed Phase 1.0 contract at `main@5588c6782fe896d496970a1855eae7d30c58ec38`.

This document records the implementation surfaces that realize the frozen contract. It does not add or reinterpret acceptance criteria.

## Canonical Program semantics

- `@alcode/program-state` owns pure bounded ProgramState identity, creation validation, DAG/eligibility, revision algebra, Attempt transitions, verification generations, terminal semantics, and deterministic canonical limits.
- `@alcode/storage` persists optional `programStateId` without changing historical omitted-field fingerprints and derives rebuildable Program projections from canonical events.
- The Host remains the only operational authority for creation acceptance, execution-base observations, dispatch, root operation admission, effect generation, quiescence/reconciliation, verification satisfaction/waiver, rebase, cancellation, recovery, and completion.

## Planning and creation

`packages/host-runtime/src/planning-read.ts` and `program-creation.ts` implement tracked read dependencies with durable exact canonical arguments, sealed planning observation identity, exact pre-acceptance/pre-first-dispatch recheck, single-consumption creation drafts, and source-session/objective provenance.

## Execution authority and recovery

`program-dispatch.ts`, `program-operation-correlation` coverage, and `program-recovery.ts` implement exact Program revision/Attempt/Agent-generation authority, protected `(WorkspaceEffectGeneration, ExecutionObservationIdentity)` freshness, Workspace-domain single-attempt scheduling, root P/A/O correlation, immutable request-time access/quiescence contracts, durable writer barriers, mismatch/rebase control, effect generation, reconciliation, and reopen recovery.

## Verification and terminal authority

`program-verification.ts` implements the frozen closed v1 verification predicates, generation-indexed freshness, path scopes, output/production-step binding, artifact-backed evidence, and explicit current-generation waivers. `program-terminal.ts` implements exact-revision cancellation and the Host-only Completion Oracle with protected terminal observation and terminal mutual exclusion.

## Agent and Application projections

The Agent Protocol negotiates `program_state_v1`; HostRuntime supplies a bounded current AttemptProjection tied to exact Program/Attempt/Agent-generation authority. The replaceable coding Agent renders that structured projection as untrusted model data and never owns canonical Program truth.

`@alcode/application-protocol` and Host `program-application.ts` expose the bounded authoritative public Program projection and exact Host-owned commands for creation acceptance, rebase, cancellation, session attachment/detachment, and dispatch. Client state remains disposable.

## Gate mapping

`pnpm gate:1.0` composes the exact closed `gate:0.9`, exercises the frozen AC-10-01 through AC-10-11 proof surfaces and Scenarios A through H, runs the Phase 1 ownership/type boundary checks, and emits the existing GateReceipt with the exact `GITHUB_SHA` when run in CI.

Phase 1.0 is complete only when that gate reports `status: "passed"` at the exact final implementation source head. No successor scope is authorized by a successful Phase 1.0 gate.
