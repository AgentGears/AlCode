# ALCODE Phase 1.1 — Authority-Binding and Retry Amendment

**Status:** DRAFT — corrective amendment to the Phase 1.1 candidate; not approved; not frozen; implementation not authorized

**Applies to:** `docs/phase-1.1-plan.md` at reviewed candidate head `184b1b1aeedaeed122b41feb1fe763ff934ec235`.

This amendment closes one freeze-blocking authority-binding gap plus two bounded protocol/orchestration ambiguities found during pre-freeze review. It does not reopen Phase 1.0 semantics. ProgramState revision, ProgramAttempt identity, `(G,O)` freshness, operation ownership, verification generations, quiescence, recovery, rebase, cancellation, Completion Oracle authority, and hard ceilings remain unchanged.

Where this amendment conflicts with `docs/phase-1.1-plan.md`, this amendment controls. All other Phase 1.1 candidate text remains unchanged.

---

## A. Inference-bound ProgramAttempt authority

Phase 1.1 must preserve causal authority from the exact Host state used for an inference to every environmental action produced by that inference.

For every Program-backed inference, the Host supplies the current `ProgramAttemptProjectionV1`. The Agent-side capability proxy for that same inference must capture both:

- the capability binding exposed for that inference, including any dynamic capability revision; and
- the exact `ProgramAttemptAuthorityV1` exposed for that inference:
  - `programStateId`;
  - `expectedProgramRevision`;
  - `programAttemptId`;
  - `workItemId`;
  - `agentGeneration`.

Every Agent-originated capability request formed during that Program-backed inference must echo the captured ProgramAttempt authority unchanged together with the capability binding required by the existing capability protocol.

Before `operation.requested` is admitted and before any environmental execution begins, the Host must fail-closed unless all of the following hold:

1. the request carries a complete, well-formed ProgramAttempt authority tuple;
2. the tuple belongs to the request Session and ProgramState;
3. `expectedProgramRevision` equals the exact current Program revision;
4. `programAttemptId` equals the exact current active Attempt;
5. `workItemId` equals the current Attempt work item;
6. `agentGeneration` equals the Attempt generation and the originating Agent connection/generation is still current;
7. the current Program execution base remains valid at the existing protected routing cut under the frozen Phase 1.0 `(G,O)` rules;
8. recovery, writer-barrier, quiescence, capability-binding, and all other existing Phase 1.0/0.9 admission requirements pass.

A missing, malformed, superseded, or stale Program authority on a Program-backed Agent capability request must return a stale/denied result before `operation.requested` and before environmental execution.

**The Host must not infer, substitute, repair, or rebind Agent-originated Program authority from the Session's newer current ProgramAttempt.** Session-to-current-Attempt resolution may remain an internal Host convenience for Host-originated operations that already possess Host authority, but it is not an authority-recovery path for Agent-originated capability requests.

This rule is the ProgramAttempt analogue of dynamic capability-generation binding: the action is authorized only under the exact authority state the model actually observed, not whatever authority happens to be current when a delayed call arrives.

### Required stale-inference proof

AC-11-04 must include this race:

```text
Attempt A authorizes inference
→ model forms capability call T under A
→ A is interrupted
→ Attempt B is issued for the same Session
→ delayed T arrives carrying A authority
→ no operation.requested
→ no environmental execution
→ program_execution_stale (or equivalent stable stale result)
```

The proof must also cover the stronger ABA-isolation variant where the Agent process, Session, tool name, and dynamic capability generation remain unchanged while only the Program revision/Attempt authority changes.

---

## B. Phase 1.1 Agent capability split

`program_state_v1` retains its Phase 1.0 meaning: the Agent can consume the bounded Host-owned `ProgramAttemptProjectionV1`.

Phase 1.1 adds a distinct additive capability token:

```text
program_execution_v1
```

`program_execution_v1` means the Agent can participate in the Phase 1.1 Program-backed execution transport, including:

- the planning/proposal message in §5.2;
- the progress-proposal message in §7.2; and
- inference-bound Program capability requests carrying the exact ProgramAttempt authority described in §A.

An Agent may advertise `program_execution_v1` only when it also advertises `program_state_v1`. The supported Phase 1.1 Program-backed product path requires both capabilities.

Phase 1.1 keeps Agent Protocol version 1 for these additive message forms. Capability negotiation, not an unconditional protocol-version bump, is the compatibility boundary.

An older Agent that advertises `program_state_v1` but not `program_execution_v1` remains valid for the Phase 1.0 AttemptProjection contract but is not a fully capable Phase 1.1 Program execution peer. The Host must not assume the new outbound proposal semantics from `program_state_v1` alone, and Program-backed Agent capability requests that lack the §A authority binding must fail closed.

### Acceptance-criterion corrections

For AC-11-02, replace the `program_state_v1` eligibility statement with: a real replaceable coding Agent that negotiated both `program_state_v1` and `program_execution_v1` can perform Host-tracked planning reads and submit the bounded Program proposal. Negative coverage must include a peer that advertises only `program_state_v1`.

For AC-11-05, replace the `program_state_v1` eligibility statement with: the current Agent must have both `program_state_v1` and `program_execution_v1` to submit Phase 1.1 progress proposals. Negative coverage must include a peer that advertises only `program_state_v1`.

For AC-11-04, the current Agent must have both capabilities for the supported Phase 1.1 default execution route, and every Program-backed capability request must carry the exact inference-bound Program authority from §A.

---

## C. Verification failure and retry orchestration

Scenario E requires one deterministic Phase 1.1 product interpretation of `ProgramVerificationServiceV1` returning `not_satisfied`.

For the default Phase 1.1 path:

1. `not_satisfied` never marks the work item `completed` and never satisfies/waives verification by implication;
2. if the Program remains active and the verification result is still current, the Host retires the current execution Attempt using existing Phase 1.0 transitions and returns the work item to `pending` so it is retryable;
3. the resulting authoritative state is an active Program with no active Attempt, the work item pending, and verification still unsatisfied/current according to existing generation rules;
4. no timer, polling loop, or immediate autonomous redispatch is introduced;
5. a later admitted Application/user/Host continuation event may cause the existing deterministic scheduler to issue a **fresh** ProgramAttempt if all frozen dispatch conditions pass;
6. the fresh Attempt receives current Program revision, current `(G,O)` execution-base authority, a fresh non-reusable `ProgramAttemptId`, and freshly rendered Host context.

The implementation may realize the retry-state transition with the existing exact-revision `work.lifecycle.set` and `attempt.interrupt` semantics in any serialized order that produces the required final canonical state. No new ProgramState transition kind is required by this amendment.

A verification failure that coincides with execution-base mismatch, recovery uncertainty, cancellation, terminalization, or another stale authority condition must preserve the existing Phase 1.0 fail-closed result instead of forcing the retry state above.

### Scenario E correction

Scenario E becomes:

```text
Agent finishes execution work
→ work reaches awaiting_verification
→ current verifier returns not_satisfied / required state absent
→ Host does not complete work
→ current Attempt is retired and work becomes pending under exact current authority
→ Program remains active and idle; projection shows retryable/unsatisfied control state
→ later admitted continuation event
→ fresh ProgramAttempt
→ corrected execution
→ fresh current verification succeeds
→ work completes
```

The stale Attempt must not be reused for the corrective execution.

---

## D. Frozen-candidate effect

If Phase 1.1 is later explicitly approved/frozen, the frozen acceptance boundary is:

- `docs/phase-1.1-plan.md` as the base candidate;
- this authority-binding and retry amendment with precedence where stated;
- AC-11-01 through AC-11-08 as corrected above; and
- Scenarios A through F, with Scenario E corrected above and the required AC-11-04 stale-inference proof included.

This amendment does not itself freeze Phase 1.1 and does not authorize implementation.
