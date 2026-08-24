# ALCODE A1 — Architecture Freeze and Implementation Authorization

**Status:** **FROZEN — A1 implementation authorized within this exact contract.**  
**Freeze date:** 2026-08-24.  
**Reviewed repository head:** `main@fc8f2b8b833d943fe995621d717b5f7fff617a4f`.  
**Objective:** A1 — Adaptive Program Revision and Progressive Decomposition.

This record is the explicit freeze decision required by the A1 candidate plan. It identifies the exact reviewed contract blobs, resolves the plan's two remaining evidence-dependent blockers, freezes the acceptance/gate boundary, and authorizes production A1 implementation within that boundary.

This record does not rewrite the reviewed candidate documents. Their internal `DRAFT` / `implementation not authorized` wording records their status before this separate approval decision. This file is the independent authority that those documents explicitly required.

---

## 1. Exact frozen contract

The A1 implementation contract is the following exact set of repository blobs:

| Artifact | Frozen blob SHA |
|---|---|
| `docs/a1-adaptive-program-plan.md` | `a800769bf8974f6cd5832548bc26b5a889fa6af4` |
| `docs/a1-adaptive-program-study.md` | `845de9a2f005e5704c54136f09b7a57effc7185e` |
| `docs/a1-limits-study.md` | `be94644aa1626f0d07262297ffc4ec954e03c3cc` |
| `docs/a1-protocol-compatibility-study.md` | `dd742aa9d6dbdb2eeb52d5091668882b11080c20` |
| `docs/a1-freeze-resolution-evidence.md` | `14fa83ac48d891fa91bbcc97f8995a14fef50cd1` |

The plan blob is primary. The as-built study constrains compatibility with the P-01 baseline. The two evidence studies resolve the numeric-limit and Agent-protocol decisions intentionally left open by the plan. The blocker-resolution record defines how those evidence artifacts compose with the plan.

If a future edit changes any frozen semantic rule, authority boundary, acceptance criterion, required scenario, hard limit, or protocol-compatibility rule, that change requires a new explicit architecture decision; editing a filename does not silently mutate this freeze.

---

## 2. Frozen architectural decisions

The normative decisions in Section 0 of the frozen plan are approved without exception:

1. `ProgramState.revision` remains whole-state CAS/currentness; semantic `ProgramRevision` is separate.
2. A1 first slice auto-admits no semantic revision. Refinement, correction, and scope amendment require exact Application acceptance of a Host-sealed draft.
3. Unknown semantic classification rejects; it is not silently escalated.
4. `WorkAuthorityEnvelope` comparison is mechanical only.
5. Parent discharge is derived, recursive, and non-vacuous.
6. Decomposing already-satisfied work is a correction.
7. Attempt dependency receipts are direct-only; direct dependency generation change invalidates the Attempt in A1.
8. `issuedUnderProgramRevisionId` is provenance, not a global equality lease.
9. Verification semantic subjects are explicit; program-wide verification is conservatively staled by every semantic revision in A1.
10. Verification is not transferred implicitly across supersession/withdrawal.
11. One admitted semantic revision is one atomic canonical semantic-cut event.
12. Legacy semantic adoption is explicit and quiescent; no active V1 Attempt is converted in place.
13. Pending semantic drafts are noncanonical and do not block Completion merely by existing.
14. At most one sealed pending semantic draft exists per Program; there is no automatic semantic rebase.
15. Semantic revision formation is a Host-requested revision-planning episode, not an execution-Attempt tool call.
16. First-dispatch/current-execution facts are never inferred from `ProgramState.revision == 1`.
17. Already admitted Operations preserve independent effect/quiescence/reconciliation truth across semantic invalidation.
18. A1 remains one active ProgramAttempt per Workspace execution domain.

The Host remains canonical authority throughout. Agent reasoning is proposal/advisory input only. Application acceptance does not bypass Host structural validation, effect truth, verification, recovery, or Completion Oracle authority.

---

## 3. Frozen A1 hard limits

The limits study is approved. A1 production code must enforce these ceilings deterministically before canonical admission:

```text
current WorkItems                         128      unchanged
total dependency edges                  1024      unchanged
canonical current ProgramState           4 MiB    unchanged
Agent Attempt projection                128 KiB   unchanged
Application Program projection          256 KiB   unchanged

maximum decomposition depth                8
maximum direct children/decomposition      8
semantic ProgramRevisions/Program         32      includes initial/baseline
semantic revision proposal                 3 MiB
canonical RevisionImpact                 256 KiB
sealed pending semantic draft              4 MiB
WorkAuthorityEnvelope                      8 KiB
semantic rationale/diagnostic text         4 KiB
```

No retry/replanning pattern may bypass these limits through repeated smaller transitions. Existing Phase-1 limits continue to apply in addition to these A1-specific limits.

No latency or throughput SLO is part of the correctness freeze. Performance metrics may be observed by the A1 gate but cannot weaken a semantic invariant.

---

## 4. Frozen Agent-protocol strategy

The protocol compatibility study is approved:

```text
AGENT_PROTOCOL_VERSION = 1
```

A1 adds negotiated capabilities:

```text
program_state_v2
program_execution_v2
program_revision_v1
```

Required compatibility rules:

- existing `program_state_v1` and `program_execution_v1` semantics remain unchanged;
- `ProgramAttemptAuthorityV1.expectedProgramRevision` retains whole-state revision meaning;
- adaptive Programs use explicitly discriminated V2 Attempt authority/projections after A1 initialization/baseline adoption;
- `program_execution_v2` requires `program_state_v2`;
- `program_revision_v1` requires `program_state_v2`;
- unsupported A1/V2 messages are never sent to a peer that did not advertise the required capability;
- fixed-topology Programs may continue through V1 on a new Host;
- an adaptive Program fails closed rather than dispatching V2 work to an incompatible Agent;
- Agent replacement/reconnect renegotiates capabilities for the new generation and never inherits dead-generation protocol authority.

Changed Program execution message families use explicit per-message/per-payload V2 discriminators while the base hello protocol stays at version 1. Revision-planning messages are independently versioned and capability-gated.

A future change that reinterprets any V1 field or requires unsupported A1 messages to cross to a legacy peer is outside this freeze.

---

## 5. Frozen acceptance criteria

**AC-A1-01 through AC-A1-14 in the exact frozen plan blob are authoritative and implementation-blocking.**

No acceptance criterion may be weakened, silently omitted, or reclassified as informational during implementation.

The acceptance boundary includes, among other things:

- separate state and semantic revisions;
- exact WorkItem identity/generation and bounded topology;
- exact semantic-draft authority and stale-parent arbitration;
- mechanical authority containment;
- deterministic canonical `RevisionImpact`;
- unaffected Attempt retention under fresh Host admission;
- affected Attempt invalidation before replacement authority;
- deterministic verification semantic impact;
- exact legacy baseline/recovery behavior;
- cancellation and Completion Oracle closure;
- explicit bounds/protocol compatibility;
- already-admitted mutation/effect truth surviving semantic invalidation;
- exact composed A1 gate and as-built closure.

---

## 6. Frozen adversarial scenarios

**Required Scenarios A through Q in the exact frozen plan blob are authoritative gate scenarios.**

They include:

- unrelated semantic revision with retained active Attempt;
- decomposition of active work and stale-authority rejection;
- concurrent semantic proposals;
- correction invalidating verification;
- scope-amendment exact acceptance;
- crash at semantic admission cut;
- Agent replacement after retained revision;
- cancellation race;
- Completion with unresolved decomposition;
- ambiguous/invalid refinement classification;
- bound exhaustion;
- authority-envelope smuggling;
- vacuous-discharge prevention;
- decomposition of already-satisfied work;
- in-flight mutation settling after Attempt invalidation;
- pending draft versus Completion;
- first dispatch after operational revision churn/baseline adoption.

A1 cannot close unless the exact-head gate proves these scenarios and the frozen AC set.

---

## 7. Frozen implementation dependency order

The dependency order in the frozen plan is approved as architecture guidance. PR numbering may vary only when repository dependency analysis preserves the same semantic dependency graph.

The required order is conceptually:

```text
semantic kernel
  + WorkItem generation/topology/discharge
  + mechanical authority envelope
  + verification semantic subjects
  + hard limits
        ↓
semantic revision transaction
  + deterministic RevisionImpact
  + atomic semantic-cut event
        ↓
Host revision-planning / exact draft / Application acceptance
        ↓
AttemptAuthority V2 + protocol compatibility
        ↓
eligibility / retained-vs-invalidated execution / Completion
        ↓
recovery / legacy adoption / projections / product integration
        ↓
exact-head A1 gate + as-built closure
```

The implementation must not defer verification-subject semantics until after `RevisionImpact`, because deterministic impact depends on explicit semantic subjects.

---

## 8. Gate and closure authority

A future exact-head A1 gate must compose, not replace, the authoritative closed P-01/S-01/Phase-1 proof surface.

At minimum the A1 gate must include:

1. semantic kernel proofs;
2. bounds/rejection proofs;
3. protocol old/new compatibility proofs;
4. adversarial lifecycle proofs A-Q;
5. recovery/rebuild proofs;
6. CapabilityBroker/currentness proofs;
7. in-flight effect-truth composition proofs;
8. the authoritative predecessor product gate(s).

The gate must emit the repository's machine-readable `GateReceipt` on the exact candidate head.

A1 closes only when:

- the exact-head composed gate passes;
- an A1 as-built/closure record maps every frozen AC to implementation and proof evidence;
- the closure record states any as-built implementation choices that remain within this frozen semantic contract.

Implementation success claims before that point are not A1 closure.

---

## 9. Explicit implementation authorization

**A1 production implementation is authorized as of this freeze, but only within the exact contract identified above.**

Authorized implementation work includes the minimum production changes required to satisfy the frozen A1 plan, limits, protocol strategy, AC-A1-01..14, and Scenarios A-Q.

This authorization does **not** authorize:

- Capability Workflow VM / Code Mode;
- arbitrary generated Python/JavaScript/shell execution;
- container sandbox implementation;
- learned/reusable procedures or procedure optimization;
- parallel same-Workspace ProgramAttempts;
- worktree execution placement;
- durable subagent/delegation teams;
- remote workers/SSH/VM execution;
- autonomous portfolio/policy scheduling;
- A2 or any later roadmap objective.

Completion of one A1 implementation slice does not authorize an adjacent excluded objective.

---

## 10. Change-control rule after freeze

Implementation may choose ordinary local names, module boundaries, helper abstractions, and PR slicing when they preserve this contract.

A change requires explicit architecture re-review before merge if it would:

- alter Host/Agent/Application authority;
- change semantic revision or WorkItem identity/generation meaning;
- change parent discharge;
- weaken fail-closed behavior;
- change Attempt retention/invalidation semantics;
- change verification subject/invalidation meaning;
- reinterpret V1 protocol fields;
- alter the frozen A1 hard limits;
- weaken any frozen acceptance criterion or required scenario;
- introduce an excluded roadmap capability.

The architecture freeze is a semantic contract, not a ban on implementation-level engineering judgment.

---

## 11. Decision

```text
A1 architecture study                 COMPLETE
A1 candidate architecture             REVIEWED
A1 freeze-boundary review             RESOLVED
A1 numeric limits                     FROZEN
A1 Agent protocol strategy            FROZEN
AC-A1-01..AC-A1-14                    FROZEN
Scenarios A..Q                        FROZEN
A1 implementation                     AUTHORIZED
A1 closure                            NOT YET
A2 implementation                     NOT AUTHORIZED
```

The next valid repository action is bounded A1 implementation under this freeze.
