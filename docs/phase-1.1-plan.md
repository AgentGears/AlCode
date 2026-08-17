# ALCODE Phase 1.1 — Default Program Execution Path

**Status:** DRAFT — candidate bounded contract; not approved; not frozen; implementation not authorized

**Prepared:** 2026-08-18 against `main@5715e2237573e9fc7963919623083bde48a0343c`, after Phase 1.0 closed with `pnpm gate:1.0` passing on that exact source head.

This document is a candidate successor contract. It does not reopen or reinterpret the frozen Phase 1.0 contract. Phase 1.0 ProgramState semantics, execution-base freshness, quiescence, verification, recovery, cancellation, Completion Oracle authority, and hard ceilings remain unchanged.

---

## 1. Objective

Make the Phase 1.0 ProgramState control model the **default durable execution path for supported local ALCODE coding executions**, rather than a set of separately wired services proven primarily through targeted integration tests.

The signature product path is:

```text
Application input
      │
      ▼
Host-owned session + planning episode
      │
      ├── read-only planning observations are tracked by the Host
      │
      ▼
Agent proposes bounded Program definition
      │
      ▼
Host seals exact ProgramCreationDraft
      │
      ▼
Application accepts exact draft
      │
      ▼
Host creates ProgramState + dispatches eligible ProgramAttempt
      │
      ▼
replaceable Agent receives bounded AttemptProjection
      │
      ▼
all capability execution remains Host-admitted
      │
      ▼
Host verification / mismatch / recovery / rebase / cancellation
      │
      ▼
Host Completion Oracle terminalizes the Program exactly once
      │
      ▼
Application observes authoritative terminal Program state
```

Phase 1.1 is complete when this path is the normal supported local execution route and the legacy non-Program execution machinery is no longer able to silently bypass Phase 1.0 authority for a Program-backed execution.

---

## 2. Repository motivation

Phase 1.0 deliberately established the semantic and operational substrate first. The current repository therefore contains the required pieces, but they are not yet one default product path:

- `packages/coding-agent/src/cli.ts` still invokes `runAgentLoop` directly and does not use HostRuntime or ProgramState.
- `packages/coding-agent/src/durable-agent.ts` directly appends operation/session/transcript events around `runAgentLoop`; that path predates Phase 1.0 Host-owned Program operation authority.
- `HostRuntime` constructs `ProgramAgentServiceV1`, but Phase 1.0 dispatch/recovery/application authorities are supplied through separately wired services and setters.
- `HostApplicationService` already supports an optional `ProgramApplicationPortV1`, but the ordinary web `ApplicationClient` exposes legacy input/execution/permission/plugin methods and does not expose the existing Program commands.
- `HostRuntime` still routes `agent.idle` through the pre-Program cognition/session completion path; Program-backed execution must instead end only through the Phase 1.0 Completion Oracle.

These are integration gaps, not Phase 1.0 semantic defects.

---

## 3. Governing invariants

1. **No second Program authority.** `@alcode/program-state` remains the pure semantic kernel and the Host remains the only operational authority.
2. **No semantic fork.** Phase 1.1 may compose and transport existing Phase 1.0 semantics but may not redefine Program revision, Attempt identity, `(G,O)` freshness, verification generations, writer barriers, rebase, recovery, cancellation, or completion.
3. **Default means routed, not inferred.** A Program-backed execution must enter through the composed Host path. It may not silently fall back to direct `runAgentLoop`, direct event append, or the legacy session CompletionCoordinator.
4. **Legacy compatibility is explicit.** Low-level libraries and historical tests may retain non-Program execution APIs, but supported product entrypoints must choose Program-backed or legacy compatibility mode explicitly. Program-backed mode is the default for new coding execution.
5. **Application acceptance remains real authority.** Program creation still requires acceptance of the exact sealed `ProgramCreationDraft`; no model, Agent, UI component, or implicit idle transition may self-approve creation.
6. **The Agent remains replaceable.** Agent protocol additions may propose planning/program progress, but they do not own canonical ProgramState, verification, rebase, waiver, cancellation, or completion.
7. **All environmental effects remain Host-mediated.** Program-backed tool execution must flow through `CapabilityBroker` and Phase 1.0 Program root-operation authority. The coding Agent may not append canonical operation truth directly.
8. **Recovery precedes execution.** On reopen, the Phase 1.0 recovery barrier must clear before Program dispatch or ordinary Host `may_write` admission.
9. **Program completion replaces session heuristic completion for Program-backed work.** Agent idle is advisory only; it may trigger Host evaluation but cannot stop the session as completed unless the Program Completion Oracle succeeds.
10. **Application state remains disposable.** Web/CLI state is a projection of Host truth; reconnect/rebuild must recover the same current Program control state.

---

## 4. Supported Phase 1.1 execution mode

Introduce one production composition for **Program-backed local execution**. The implementation may choose the concrete factory/class names, but it must instantiate and connect one coherent authority graph containing:

- `HostRuntime` and its canonical admission queue;
- tracked planning-read registry/barrier;
- `ProgramCreationServiceV1`;
- protected Workspace execution observation source;
- `ProgramDispatchServiceV1`;
- Program root-operation authority wired into `CapabilityBroker`;
- `Phase1RecoveryControllerV1` wired into Host startup and ordinary mutation admission;
- `ProgramVerificationServiceV1`;
- `ProgramTerminalServiceV1`;
- `HostProgramApplicationControlV1` exposed through `HostApplicationService`;
- `ProgramAgentServiceV1` and `program_state_v1` negotiation for the replaceable coding Agent.

Callers of the supported product entrypoint must not be required to reproduce test-specific wiring with ad hoc setters.

---

## 5. Planning-to-Program bridge

Phase 1.1 adds the missing production transport between an Agent planning episode and the existing `ProgramCreationServiceV1`.

### 5.1 Planning episode

For a new Program-backed objective, the Host creates one bounded planning episode tied to the active source Session and caller-authored objective event.

Read-only workspace observations used to construct the Program proposal must be executed through Host-owned tracked planning reads. Exact canonical arguments and results remain governed by the frozen Phase 1.0 tracked-read contract.

Planning reads are not ordinary execution evidence and do not create a ProgramAttempt.

### 5.2 Agent proposal

The Agent Protocol gains a bounded, versioned Agent→Host Program proposal message that carries:

- the source Session;
- the planning-episode identity issued by the Host;
- the candidate `ProgramCreationProposalV1` fields only: objective, work items, verification obligations, output slots, and production steps.

The Host validates Agent generation/session ownership, planning-episode identity, proposal bounds, and exact objective provenance before calling `ProgramCreationServiceV1.sealDraft`.

The Agent cannot provide or choose:

- `ProgramStateId`;
- canonical draft digest;
- planning observation identity;
- execution observation profile;
- Host policy generation/digest;
- creation acceptance.

Those remain Host/Application-owned.

### 5.3 Pending creation

A successfully sealed draft becomes visible through the existing authoritative Application Program projection as `pendingProgramCreations`. The execution episode pauses until the Application accepts or the draft is invalidated/stale.

---

## 6. Creation acceptance and first dispatch

The existing `program.creation.accept` Application command remains the only creation acceptance route.

After exact acceptance:

1. the Host creates the canonical ProgramState atomically through the existing Phase 1.0 creation service;
2. the source Session is attached according to existing Program creation semantics;
3. first-dispatch planning recheck executes before Attempt issuance;
4. protected current Workspace observation establishes the first accepted execution base;
5. the scheduler issues exactly one fresh ProgramAttempt if all frozen dispatch conditions pass;
6. the current `program_state_v1` Agent receives the bounded AttemptProjection on its next Host context refresh.

If any freshness, recovery, writer-barrier, planning-recheck, attachment, or Workspace observation condition fails, dispatch remains fail-closed using the existing Phase 1.0 result semantics.

---

## 7. Program-backed Agent execution

### 7.1 Capability routing

When a Session owns the current ProgramAttempt, every Agent capability request is admitted under the exact current Program root-operation context before environmental execution.

Direct operation persistence from `coding-agent` is prohibited in Program-backed mode. Existing low-level durable-agent helpers may remain for compatibility tests but are not the supported Program execution route.

### 7.2 Program progress proposals

The Agent Protocol gains one bounded, versioned progress-proposal message for the current Attempt. It may propose only these Host-admitted semantic intents:

- add work-bound decisive evidence;
- add a blocker for the current work item or Program;
- resolve a blocker previously proposed by the Agent when still current;
- move the current work item from `in_progress` to `awaiting_verification` after the Agent believes execution work is finished.

Every proposal must carry the exact current Program authority tuple from the AttemptProjection. The Host rejects stale revision/Attempt/work/session/Agent-generation tuples.

The Agent may not directly propose:

- `work.completed`;
- verification satisfaction or waiver;
- execution-base advance, mismatch, or rebase;
- artifact integrity truth;
- Program cancellation;
- Program completion.

Those remain Host/Application-owned.

### 7.3 Verification and work completion

When a work item reaches `awaiting_verification`, the Host evaluates or executes its existing Phase 1.0 verification obligations through `ProgramVerificationServiceV1`.

A work item becomes `completed` only after its required current-generation verification conditions are satisfied or explicitly waived by existing Host/Application authority. Successor dispatch then uses the existing deterministic scheduler.

---

## 8. Program terminal behavior

For a Program-backed Session:

- `agent.idle` may request a terminal evaluation but may not directly stop the Session as completed;
- the Host must use `ProgramTerminalServiceV1` and its protected terminal Workspace observation;
- a successful Completion Oracle transition terminalizes the Program exactly once and then permits the associated execution/session surface to report completed;
- failed completion evaluation returns the current blocking reasons/state and leaves the Program active;
- Application cancellation continues through `program.cancel` with exact Program revision and retains the frozen no-rollback semantics.

Legacy cognition/session completion remains available only for explicitly non-Program compatibility executions.

---

## 9. Application and UI integration

Extend the ordinary Application client surface to expose the Program commands already present in `@alcode/application-protocol`:

- accept pending creation;
- accept rebase;
- cancel Program;
- attach Session;
- detach Session.

The supported web shell must render, at minimum, bounded authoritative Program control state sufficient to operate the default path:

- objective and lifecycle;
- current revision;
- current work item and work lifecycle summary;
- pending creation requiring acceptance;
- active Attempt presence;
- verification current/stale/waived summary;
- blocker summary;
- rebase-required / execution-base-unavailable state;
- cancellation control;
- terminal state.

This is an operational integration surface, not a visual redesign. The Host projection remains authoritative and existing Phase 1.0 projection limits remain unchanged.

---

## 10. CLI integration

The ordinary `alcode -p` coding execution entrypoint must stop invoking `runAgentLoop` directly.

In Phase 1.1 it must use the Program-backed local Host composition, durable workspace store, replaceable coding Agent protocol, and Application control path.

Because exact Program creation acceptance is a real Application authority, non-interactive CLI execution must make that authority explicit. The implementation must provide a deterministic CLI acceptance behavior rather than silently self-approving as the Agent. Acceptable implementations are:

- an explicit command-line option that authorizes the CLI Application actor to accept the exact pending draft; or
- an interactive confirmation when no such option is supplied.

The default must never make Agent proposal equivalent to Application acceptance.

The offline `TestModelProvider` may remain available for deterministic tests; Phase 1.1 does not require adding or changing production model providers.

---

## 11. Recovery and replacement

The default product path must preserve Phase 1.0 behavior across Host/Agent replacement:

- Host reopen runs ordinary interrupted-operation recovery and the Phase 1.0 recovery barrier before new Program execution;
- an orphan active Attempt is interrupted during recovery according to the frozen contract;
- the same ProgramStateId remains durable across Sessions and Host lifetimes;
- a replacement Agent receives a fresh Agent generation and never inherits the prior AttemptId;
- after the Application reattaches an eligible Session, later dispatch issues a fresh Attempt from current Program truth;
- current Program/Application projections rebuild from canonical events without UI-local repair state.

---

## 12. Explicit exclusions

Phase 1.1 does **not** add:

- multi-Program orchestration or a Program portfolio scheduler;
- same-Workspace parallel ProgramAttempts;
- subagents or delegated Agent teams;
- topology mutation after Program creation;
- remote Workspace backends, SSH/WSL/Docker execution, or distributed workers;
- a new verification DSL or model-judged verification;
- automatic verification waiver;
- background/timer-driven Program execution;
- autonomous rebase acceptance;
- marketplace/plugin scope beyond Phase 0.9;
- new Phase 1.0 canonical identities or altered hard ceilings;
- a broad UI redesign;
- removal of low-level `runAgentLoop` or historical compatibility APIs from the library surface.

---

## 13. Frozen-candidate acceptance criteria

### AC-11-01 — Production Program composition

A supported production composition wires the existing Phase 1.0 creation, dispatch, root-operation, recovery, verification, terminal, Agent, and Application authorities into one Host execution graph. Product callers do not need test-only/manual service wiring. A negative test proves a Program-backed capability call cannot execute through a direct operation-append bypass.

### AC-11-02 — Planning proposal to pending creation

A real replaceable coding Agent can perform Host-tracked planning reads and submit one bounded Program proposal. The Host alone seals the exact `ProgramCreationDraft`, and the authoritative Application snapshot exposes it as pending. Negative cases cover stale planning episode, changed tracked read, wrong Session/Agent generation, malformed/over-bound proposal, and stopped source Session.

### AC-11-03 — Exact Application acceptance and first dispatch

The ordinary Application port/client can accept the exact pending draft. Acceptance creates one ProgramState and first dispatch performs the frozen planning recheck, protected Workspace observation, and fresh Attempt issuance. Duplicate/idempotent acceptance and stale/wrong-digest acceptance preserve Phase 1.0 results.

### AC-11-04 — Default Attempt-driven execution

After dispatch, the current coding Agent receives the bounded AttemptProjection and its capability requests execute only under the current Program root-operation authority. Stale Program revision, AttemptId, work item, Session, Agent generation, execution-base mismatch, recovery barrier, and writer barrier all prevent environmental execution as required by Phase 1.0.

### AC-11-05 — Progress, verification, and successor dispatch

The current Agent can propose only the bounded progress intents defined in §7.2. The Host admits current evidence/blocker/work-awaiting-verification transitions, runs Phase 1.0 verification, marks work complete only after current verification, and dispatches the next eligible work item deterministically. Negative cases prove the Agent cannot directly complete work, satisfy/waive verification, rebase, cancel, or complete the Program.

### AC-11-06 — Program terminal path replaces legacy completion

For Program-backed execution, Agent idle cannot terminalize the Session through the legacy completion path. Completion occurs only when `ProgramTerminalServiceV1` succeeds at the protected terminal cut. Cancellation/Completion races still produce one terminal Program truth. Explicit non-Program compatibility mode continues to use its historical completion behavior.

### AC-11-07 — Product projection, reconnect, and replacement

The ordinary Application client and supported web shell expose the minimum Program controls/state in §9. Host restart, Application reconnect, Session reattachment, and Agent replacement recover the same ProgramStateId and current authoritative control state; a replacement Agent receives a fresh generation/Attempt identity.

### AC-11-08 — Default local entrypoint and composed gate

`alcode -p` no longer invokes `runAgentLoop` directly for the normal coding path. It enters through the Program-backed Host/Application composition and preserves exact Application acceptance authority. `pnpm gate:1.1` composes the exact closed `gate:1.0`, runs AC-11-01 through AC-11-08 proof surfaces and the scenarios below, and emits the existing GateReceipt at the exact implementation source head.

---

## 14. Required scenarios

### Scenario A — New objective to completion

Caller input → tracked planning → Agent proposal → pending draft → exact Application acceptance → Program creation → first Attempt → Host capability execution → verification → required work complete → Completion Oracle → terminal Program projection.

### Scenario B — Host crash during Program execution

Active ProgramAttempt + interrupted operation → Host crash → reopen → ordinary operation recovery + Phase 1 recovery barrier → orphan Attempt interruption/current-base catch-up → later Session reattachment → fresh Attempt → continuation.

### Scenario C — Agent replacement

Agent A owns current Attempt → Agent A exits → replacement Agent B attaches with fresh generation → stale A authority rejected → old Attempt not inherited → fresh dispatch/projection when eligible.

### Scenario D — External divergence and rebase

Current Program execution base → external Workspace change → next freshness cut records mismatch/verification impact → Attempt interrupted → Application sees rebase-required → exact rebase acceptance → fresh dispatch.

### Scenario E — Verification failure/retry path

Agent finishes execution work → awaiting verification → current verifier fails or required state absent → Program remains active/not complete → subsequent valid execution and fresh current verification → work completes.

### Scenario F — Cancellation/terminal race

Application exact-revision cancellation races Agent idle/Completion Oracle → serialized Host authority admits exactly one terminal outcome and the public projection converges after reconnect/rebuild.

---

## 15. Candidate implementation order

This order is dependency guidance only; it is not implementation authorization while the document remains DRAFT.

1. production Program composition/root wiring;
2. Agent planning-episode/proposal transport and Host bridge;
3. Application client Program commands + pending-creation control;
4. default creation/first-dispatch vertical;
5. Agent progress proposal bridge;
6. Program-backed idle/verification/terminal routing;
7. CLI migration to Program-backed Host/Application path;
8. minimal web Program controls/state;
9. restart/replacement/divergence scenario coverage;
10. `gate:1.1` + as-built mapping.

Each implementation slice must preserve `gate:1.0` and existing platform CI.

---

## 16. Approval rule

This document is not self-approving.

Before implementation begins, Phase 1.1 requires a separate explicit client approval/freeze decision identifying the exact approved repository head/blob containing this candidate contract. At that point AC-11-01 through AC-11-08 and Scenarios A through F become the frozen acceptance boundary.

A successful Phase 1.1 gate will close only this objective and will not authorize subagents, multi-Program orchestration, or any successor phase.
