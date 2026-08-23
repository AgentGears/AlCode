# ALCODE P-01 — Production Program Agent As-Built and Closure Record

**Status:** P-01 closure record. It is valid only for a commit at which `pnpm gate:product-agent` passes.

**Frozen contract:** `P-01_PRODUCTION_PROGRAM_AGENT_PLAN.md`, SHA-256 `6dec7f9a40e27e866f18891e393dfea3e7935321c0f7179b650b65cf5d3f86b0`.

This document records the as-built implementation of AC-P01-01 through AC-P01-12. It does not add acceptance criteria and does not authorize successor work.

## Delivery slices

| Slice | Merged evidence |
|---|---|
| PR 1 — production provider | #135 |
| PR 2 — planning semantic client/catalog/reads | #138 |
| PR 3 — bounded model planner and proposal | #141 |
| PR 4 — Host verifier catalog and real verification | #145 |
| PR 5 — replay-safe Attempt driver/retry/replacement/recovery | #154, merged as `7df24eeec7ecd931615b90b12d808367139b5565` |
| PR 6 — product gate and closure record | the commit containing this document; authoritative only when its `product-agent` GateReceipt passes at exact `GITHUB_SHA` |

## Acceptance mapping

| Criterion | As-built proof surface |
|---|---|
| AC-P01-01 | `provider-selection.ts` selects the real production ModelProvider when scripted test mode is absent; provider tests prove there is no silent test-provider fallback. |
| AC-P01-02 | planning reads are exposed only through the privileged semantic Agent protocol client; normal planner code does not own raw transport or mutation capabilities. |
| AC-P01-03 | planning-read and verifier catalogs are exact bounded episode snapshots; tracked observations carry canonical identities/digests and are rechecked before first dispatch. |
| AC-P01-04 | `program-planner.ts` runs bounded model planning and exposes a structured Program proposal tool; failure does not fall back to the legacy one-item production shim. |
| AC-P01-05 | model output remains proposal only. Host sealing/validation is separate from explicit Application acceptance; non-interactive CLI acceptance requires `--accept-program`. |
| AC-P01-06 | the product publishes a real Host verifier catalog, enforces nonempty verification, and executes Host-owned path/operation verification rather than model self-judgment. |
| AC-P01-07 | Host→Agent `program.attempt.execute` carries exact Session/Program/Attempt/work/generation authority. The worker refreshes Host context before inference, coalesces only live duplicate execution, permits later re-drive, and fails stale authority closed. |
| AC-P01-08 | negative verification records durable bounded `program.verification.failed` facts, retires the old Attempt, returns work pending, and projects the latest Host failure fact into the fresh retry Attempt. |
| AC-P01-09 | successful verification can dispatch the next structurally-ready work item and the runtime re-requests execution without new caller input. |
| AC-P01-10 | Agent replacement retires dead-generation Attempt authority before fresh authority. Interrupted Operations and transcript gaps are recovered through Host-owned truth; certain/quiescent settlement can continue while indeterminate mutation recovery blocks redispatch. |
| AC-P01-11 | execution-base/effect uncertainty and Completion Oracle semantics remain unchanged. Stale first dispatch and finite product-drive exhaustion cancel/fail explicitly; same-Session automatic replan is not introduced. |
| AC-P01-12 | `scripts/gate/gate-product-agent.ts` composes `gate:1.1`, P-01-specific AC01–11 proofs, relevant S-01 lifecycle/authority tests, and ownership typechecks. `.github/workflows/p-01-product-agent.yml` runs that authoritative gate on the exact PR/main commit. |

## Default product flow

```text
caller objective
  → durable Host input admission
  → Host planning episode
  → model planning through tracked Host reads + exact verifier catalog
  → bounded Program proposal
  → Host validation/seal
  → explicit Application acceptance
  → fresh Host ProgramAttempt
  → Host-requested Agent execution with refreshed exact Attempt context
  → Host-mediated coding capabilities
  → Agent requests awaiting verification
  → Host verifier execution
      fail → old Attempt retired + bounded Host failure fact → fresh retry Attempt
      pass → work complete → fresh successor Attempt if structurally ready
  → Completion Oracle
  → Program.completed
```

## Exact closure gate

`pnpm gate:product-agent` is the authoritative P-01 closure command. It emits the repository `GateReceipt` shape with `GITHUB_SHA` as the implementation identity in CI and blocks on any failed composed check.

The gate covers:

- real provider selection/no silent mock fallback;
- semantic planning client, bounded exact catalogs, tracked reads, stale-base handling, and model proposal;
- explicit Application acceptance;
- real Host verifier catalog/nonempty policy/path verification;
- exact Attempt execution protocol/context/re-drive behavior;
- verification failure, fresh retry authority, and bounded Host failure context;
- multi-work successor dispatch;
- Agent-loss/replacement retirement, transcript closure, and recovery gating;
- execution-base/effect fail-closed behavior and Completion Oracle;
- Phase 1.1 plus relevant S-01 lifecycle/authority composition;
- protocol/Host/Agent type ownership.

No live API credential, public network, third-party model availability, or provider billing is required for the blocking gate. Deterministic scripted providers are test fixtures only.

## Closure boundary

When the exact-head `product-agent` GateReceipt passes, AC-P01-01 through AC-P01-12 are satisfied and P-01 is complete under `EXECUTION_AND_CLOSURE_CONTROL.md`.

P-01 closure does **not** authorize Code Mode, durable child/subagent Sessions, durable Inference Epoch work, remote execution, dynamic package/plugin loading, or any other successor objective.

## Non-blocking follow-up

The frozen plan separately identifies optional future improvements such as semantic CodeIntelligence planning tools, additional provider adapters, richer verifier catalogs, richer retry summaries, read-only Program policy, improved proposal UX, and provider/model evaluation. None is required for P-01 closure.
