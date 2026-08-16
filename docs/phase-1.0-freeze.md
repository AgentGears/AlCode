# ALCODE Phase 1.0 — Freeze Decision

**Status:** FROZEN — approved for implementation  
**Decision date:** 2026-08-16  
**Approved contract head:** `main@5588c6782fe896d496970a1855eae7d30c58ec38`

## Decision

Phase 1.0 is explicitly approved and frozen against the exact reviewed candidate at `main@5588c6782fe896d496970a1855eae7d30c58ec38`.

This is the separate approval/freeze decision required by the Phase 1.0 draft. It supersedes only candidate-status language saying Phase 1.0 is DRAFT, not approved, not frozen, or implementation unauthorized. It does not otherwise rewrite, broaden, weaken, or reinterpret the reviewed contract.

Implementation is authorized to proceed against the frozen contract. This decision does not assert that implementation has started or completed.

## Frozen contract

The frozen contract is exactly this composition at the approved head:

1. `docs/phase-1.0-plan.md` — blob `31b1614b3cfd982022d3b9d014276f4631972eff`;
2. `docs/phase-1.0-implementability-closure-amendment.md` — blob `7e7ac15334c53c5458b14466a4d04bd6711fd032`;
3. `docs/phase-1.0-implementability-closure-read-args-correction.md` — blob `6a9a81ea823918c87d3fb1c3d1a52d7e4e202f55`.

Precedence remains exactly as those documents specify: the planning-read correction overrides the amendment where stated; the amendment overrides the base plan where stated; the base plan governs unaffected semantics.

The approved Git commit is the atomic repository commitment to that composition. Its tree is `fc2607e7db0bb019edd5b32ca9f45f0ec859016c`; the blob identities above bind the exact normative bytes. Verification resolves that exact commit/tree/path set rather than a mutable branch tip or reconstructed prose.

## Frozen acceptance boundary

The composed contract's **AC-10-01 through AC-10-11**, **Scenarios A through H**, incorporated implementability amendment, and planning-read-argument correction are frozen.

The correction requiring durable bounded exact canonical planning-read arguments, or an equivalent immutable durable canonical reference, is part of the frozen contract and may not be weakened to digest-only reconstruction.

All structural hard ceilings, authority boundaries, freshness/quiescence semantics, recovery rules, verification-generation semantics, Completion Oracle rules, cancellation semantics, and explicit exclusions defined by the composed contract remain in force exactly as reviewed.

## Change control

Acceptance criteria are frozen when implementation begins. Contributors may not add gates, strengthen proof requirements, expand scope, reinterpret accepted criteria into materially more work, or reopen accepted authority decisions merely because a stronger design is possible.

A frozen criterion may change only under project change control when concrete implementation evidence demonstrates that the accepted result would otherwise be incorrect, unsafe, corrupted, or materially unusable. Reversible choices explicitly left open by the contract remain implementation-owned.

## Scope boundary

All explicit Phase 1.0 exclusions remain excluded. This freeze does not authorize successor scope, and no successor phase is authorized by this decision.

## Review evidence

`docs/phase-1.0-whole-contract-adversarial-review.md` records no known remaining P0/P1/P2 contract correctness finding after its validated corrections. The subsequent implementability closure and exact-head correction closed the concrete implementation-semantic gaps before the approved head was merged.

Those reviews are evidence only; they create no additional acceptance criteria. External audit or attestation is not part of the accepted Phase 1.0 proof boundary and is not introduced as a new freeze requirement.

## Implementation authority

Phase 1.0 implementation may now proceed directly against this frozen contract. Implement the frozen objective, resolve ordinary reversible details through repository evidence and bounded tests, change the contract only for a demonstrated blocker, and close Phase 1.0 when the frozen acceptance criteria pass at the exact implementation head.
