# ALCODE Phase 1.1 — As-Built Mapping

**Status:** implementation mapping for the client-authorized bounded Phase 1.1 objective

This document records where the Phase 1.1 default Program execution path is implemented. It does not alter Phase 1.0 semantics or add acceptance criteria.

## Acceptance mapping

| Criterion | As-built proof surface |
|---|---|
| AC-11-01 | `createProgramExecutionRuntimeV1` composes the production Host Program authority graph; runtime tests prove Program-backed capability execution cannot use the legacy direct path. |
| AC-11-02 | `ProgramPlanningServiceV1` + Agent Protocol `program_execution_v1` carry Host-issued planning episodes and bounded Agent proposals to Host-sealed pending drafts. |
| AC-11-03 | ordinary Application `program.creation.accept` is the exact acceptance route; `ProgramExecutionApplicationPortV1` schedules first dispatch after accepted/idempotent acceptance. |
| AC-11-04 | `ProgramAgentServiceV1`, inference-bound Attempt projection, and `CapabilityBroker` require current Program revision/Attempt/work/Session/Agent generation before environmental execution. |
| AC-11-05 | Agent `program.progress` is bounded to evidence/advisory blockers/awaiting-verification; Host execution control owns verification, work completion, and successor dispatch. |
| AC-11-06 | Program-backed `agent.idle` is routed through `ProgramExecutionControlV1`; only `ProgramTerminalServiceV1`/Completion Oracle can terminalize successful Program work. |
| AC-11-07 | Application/web Program projection and controls are Host-authored; restart/reconnect/reattachment/replacement tests rebuild the same Program truth and mint fresh Agent/Attempt authority. |
| AC-11-08 | `packages/coding-agent/src/cli.ts` now resolves a durable Workspace, starts the replaceable Agent protocol worker, enters `createProgramExecutionRuntimeV1`, requires explicit CLI Application acceptance, and completes through Program terminal authority. `scripts/gate/gate-1.1.ts` composes `gate:1.0` and the Phase 1.1 proof surfaces. |

## Default CLI route

```text
alcode -p
  → WorkspaceRegistry + locked durable Workspace store
  → createProgramExecutionRuntimeV1
  → replaceable AgentSupervisor / Agent Protocol
  → Host-admitted caller objective + planning episode
  → Agent bounded Program proposal
  → Host-sealed pending ProgramCreationDraft
  → explicit CLI Application acceptance
  → ProgramState + fresh ProgramAttempt
  → Host-mediated capabilities
  → Host verification / successor control
  → Completion Oracle
  → authoritative Application terminal projection
```

Non-interactive execution must pass `--accept-program`; without that flag the CLI requires an interactive confirmation and does not treat the Agent proposal as Application acceptance.

Low-level `runAgentLoop` remains a library/compatibility primitive and is still used inside the replaceable Agent worker. It is no longer the ordinary `alcode -p` product entrypoint.

## Gate

`pnpm gate:1.1` first runs the exact closed `gate:1.0`, then runs the Phase 1.1 composition/planning/acceptance/Attempt/progress/terminal/product/CLI proofs and required crash, replacement, divergence, verification-retry, and terminal-race scenarios. The gate emits the existing `GateReceipt` shape using `GITHUB_SHA` as the implementation source identity when executed in CI.
