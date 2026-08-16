# ALCODE Phase 1.0 — Freeze Decision

**Status:** FROZEN — approved for implementation  
**Decision date:** 2026-08-16  
**Approved contract head:** `main@5588c6782fe896d496970a1855eae7d30c58ec38`

## Decision

Phase 1.0 is explicitly approved and frozen against the exact reviewed candidate at `main@5588c6782fe896d496970a1855eae7d30c58ec38`.

This is the separate approval/freeze decision required by the Phase 1.0 draft. It supersedes only the candidate-status language that says Phase 1.0 is DRAFT, not approved, not frozen, or implementation unauthorized. It does not otherwise rewrite, broaden, weaken, or reinterpret the reviewed contract.

Implementation of the frozen Phase 1.0 objective is authorized. This decision does not assert that implementation has started or completed.

## Frozen contract composition

The frozen contract is the exact composition already defined by the reviewed candidate:

1. `docs/phase-1.0-plan.md` at approved head `5588c6782fe896d496970a1855eae7d30c58ec38` — blob `31b1614b3cfd982022d3b9d014276f4631972eff`;
2. `docs/phase-1.0-implementability-closure-amendment.md` at that same approved head — blob `7e7ac15334c53c5458b14466a4d04bd6711fd032`;
3. `docs/phase-1.0-implementability-closure-read-args-correction.md` at that same approved head — blob `6a9a81ea823918c87d3fb1c3d1a52d7e4e202f55`.

Precedence remains exactly as those documents specify:

```text
planning-read argument correction
  overrides the implementability amendment where stated

implementability amendment
  overrides the base plan where stated

base plan
  governs all unaffected Phase 1.0 semantics
```

Supporting studies and review documents remain rationale/evidence and do not independently alter the frozen contract.

## Frozen acceptance boundary

The Phase 1.0 acceptance boundary is now frozen as the composed contract's **AC-10-01 through AC-10-11**, together with the required **Scenarios A through H** and their incorporated amendment/correction semantics.

In particular, the freeze includes the reviewed closures for:

- Host-owned `ProgramState` authority and exact revision semantics;
- fresh non-reusable `ProgramAttemptId` execution authority;
- tracked-read planning provenance with durable exact canonical read arguments and restart-safe recheck;
- immutable first-slice required-work topology;
- Workspace execution freshness through `WorkspaceEffectGeneration` plus `ExecutionObservationIdentity`;
- the closed first-slice freshness-cut taxonomy;
- Host-owned `WorkspaceAccessClass` derivation;
- operation-local historical mutation-containment/quiescence contracts and canonical `operation.mutation_quiesced` proof;
- Workspace-domain writer barriers that gate Program and ordinary Host mutation admission;
- same-Workspace ProgramAttempt serialization with deterministic busy/no-hidden-queue behavior;
- recovery source-session attribution;
- one-revision-per-effective-atomic-Program-transition algebra;
- lazy Program-local verification-impact catch-up for parked Programs;
- generation-indexed mandatory verification and crash-safe mismatch/verification-impact composition before rebase;
- artifact identity remaining distinct from evidence authority;
- Host-only serialized Completion Oracle authority;
- cancellation as terminal authority cutoff rather than rollback;
- historical envelope omission/fingerprint/digest compatibility;
- the frozen structural hard ceilings and bounded projections.

The implementability correction requiring durable bounded exact canonical planning-read arguments, or an equivalent immutable durable canonical reference, is part of the frozen contract and may not be weakened to digest-only reconstruction.

## Change control

Implementation begins with the acceptance criteria frozen.

After this decision, a contributor may not add gates, strengthen proof requirements, expand scope, reinterpret an accepted criterion into materially more work, or reopen accepted Phase 1.0 authority decisions merely because a stronger design is possible.

A frozen criterion may change only under project change control when concrete implementation evidence demonstrates that the accepted result would otherwise be incorrect, unsafe, corrupted, or materially unusable.

Implementation-owned reversible choices remain implementation-owned where the contract explicitly leaves them open.

## Scope boundary

All explicit Phase 1.0 exclusions remain excluded. This freeze does not authorize successor scope such as multi-Program orchestration, same-Workspace parallel ProgramAttempts, topology amendment, subagent teams, recurring automation, isolated/remote Workspace providers, browser execution, marketplace expansion, or other excluded later-phase work.

No successor phase is authorized by this decision.

## Review evidence

The whole-contract adversarial review recorded no known remaining P0/P1/P2 contract correctness finding after its validated corrections. The subsequent implementability closure retest likewise closed its concrete implementation-semantic gaps, including the restart-safe planning-read argument correction, before the approved head was merged.

Those reviews are evidence for the decision; they do not create additional acceptance criteria beyond the frozen composed contract.

## Implementation authority

Phase 1.0 implementation may now proceed directly against this frozen contract.

The governing execution rule is:

> Implement the frozen objective, resolve ordinary reversible details through repository evidence and bounded tests, change the contract only for a demonstrated blocker, and close Phase 1.0 when the frozen acceptance criteria pass at the exact implementation head.
