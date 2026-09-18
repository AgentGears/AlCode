# A5 — Execution-Provider Isolation Freeze

**Status:** FROZEN / IMPLEMENTATION AUTHORIZED  
**Freeze date:** 2026-09-15  
**Implementation baseline:** `main@4c324c9b34d500ff103dd7afd93fcf08d5c0a30b`  
**Candidate contract:** [`a5-execution-provider-plan.md`](./a5-execution-provider-plan.md)  
**Reviewed resolution:** [`a5-execution-provider-design-review-2026-09-15.md`](./a5-execution-provider-design-review-2026-09-15.md)

## Frozen objective

Introduce one Host-owned, provider-neutral execution-world boundary so the existing local execution path and at least one physically isolated backend implement the same ALCODE execution semantics without moving canonical authority out of the Host.

The reviewed candidate contract and review resolution are frozen for implementation. Where the pre-review gap study contains illustrative alternatives, the reviewed resolution governs.

## Frozen invariant

> An execution provider supplies and observes a physical world; it never becomes a second Program, capability-admission, Operation, verification, recovery, or Completion authority.

The exact physical target of world-scoped work is identified by `workspaceId + executionWorldGenerationId`. The generation is Host-owned, fresh/non-reusable, non-authorizing, and distinct from provider-native instance identity.

An admitted world-scoped Operation captures an immutable generation-specific execution binding. Replacement generation G1 never inherits an Operation admitted against G0.

Provider lifecycle evidence remains epistemically distinct from Operation effect truth. Activation preparation is not proof of activation; teardown request is not proof of closure; provider loss is not proof of effect absence; closure is not proof of Operation quiescence.

## Frozen acceptance criteria

- **AC-A5-01 — generation currentness / same-bytes ABA:** an Attempt bound to G0 is rejected before protected capability execution after recreation as G1, even when repository bytes are identical; a fresh G1 Attempt may proceed.
- **AC-A5-02 — policy/provider freshness:** a material provider/effective-policy change without proven semantic continuity produces a fresh generation and invalidates old generation-bound authority.
- **AC-A5-03 — coherent world services:** filesystem mutation, process execution, execution-base observation, and verification observation that claim one world bind to the same exact generation.
- **AC-A5-04 — Agent cannot select world:** Agent/model input cannot redirect execution with forged or historical generation/provider-native identifiers.
- **AC-A5-05 — immutable Operation binding:** an Operation admitted to G0 executes only through its captured G0 binding or fails/remains uncertainty-bound; it never executes through later G1.
- **AC-A5-06 — restart reconstruction:** durable history reconstructs Operation→generation causality after restart without minting authority or settling effect truth.
- **AC-A5-07 — provider loss preserves effect uncertainty:** provider loss during mutation never implies effect absence; Host reconciliation resolves the fact or leaves it indeterminate.
- **AC-A5-08 — required isolation controls fail closed:** unsupported mandatory isolation policy rejects activation/use; no silent downgrade may claim isolation.
- **AC-A5-09 — secret-free durable provenance:** provider descriptors, policy descriptors/digests, lifecycle facts, and Operation world provenance contain no raw secrets or authentication material.
- **AC-A5-10 — local compatibility:** the local trusted provider preserves all closed predecessor contracts and gates.
- **AC-A5-11 — real isolated backend:** an automated supported-platform integration proves filesystem confinement, resource bounds, network policy, environment/secret scrubbing, process-tree containment, and teardown evidence.
- **AC-A5-12 — verification same generation:** isolated-world mutation cannot be verified by observing another Host-local copy.
- **AC-A5-13 — S-02 composition:** `run_code` subcalls route through ordinary Host capabilities into the exact isolated generation while preserving A2 nested provenance and Host effect truth.
- **AC-A5-14 — lifecycle uncertainty:** Host loss after activation preparation or teardown request preserves unknown occurrence/closure until bounded discovery/reconciliation supplies positive evidence.
- **AC-A5-15 — permanent gate:** `pnpm gate:a5-execution-provider` exercises A5 conformance/adversarial proof plus relevant predecessor gates on the exact implementation head.

## Frozen adversarial scenarios

Same-bytes ABA; forged generation input; generation replacement between Operation admission and dispatch; activation loss window; teardown loss window; provider disconnect during mutation; stale Attempt after reconnect; verifier world mismatch; planning world mismatch; unsupported mandatory policy; secret injection; lingering descendants; S-02 isolated composition; restart/rebuild equality; and local-provider compatibility.

## Implementation slices

1. **A5-1:** execution-world generation identity/lifecycle and local compatibility adapter.
2. **A5-2:** ProgramAttempt generation binding, immutable Operation binding, and durable world provenance.
3. **A5-3:** generation-bound planning/verification observation and lifecycle recovery.
4. **A5-4:** one real `isolated-v1` provider with containment-policy enforcement.
5. **A5-5:** S-02/A2 composition, adversarial closure proof, permanent gate, exact-head review and merge.

## Scope boundary

This freeze authorizes A5 only. It does not authorize A6 reusable procedures, A7 parallel workspaces, A8 durable subagents, A9 remote execution, or a generalized terminal/session redesign.
