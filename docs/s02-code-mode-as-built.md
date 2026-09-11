# S-02 Code Mode — As-Built Closure Record

**Contract:** `docs/s02-programattempt-local-orchestration-plan.md` (frozen 2026-09-08)  
**Implementation sequence:** S02-1 protocol/catalog → S02-2 isolated runtime → S02-3 inference projection → S02-4 authority/effect proof → S02-5 product integration/closure.  
**Closure gate:** `pnpm gate:s02-code-mode`  
**Exact-head evidence:** the gate receipt records `GITHUB_SHA` / `ALCODE_GATE_SHA`; closure requires the S-02 gate and `pnpm gate:product-agent` on the same candidate head.

## As-built authority shape

S-02 remains an Agent-local execution transport. The Host owns whether `run_code` is provider-visible. The worker receives only an SDK projected from the exact ordinary inference capability snapshot, with `run_code` excluded. Every environmental call is executed through the captured ordinary proxy `AgentTool.execute(...)`, so ProgramAttemptAuthorityV2, dynamic binding revision, CapabilityBroker admission, canonical Operation identity, effect uncertainty, and quiescence remain Host-owned.

The local runtime is a fresh QuickJS runtime inside a fresh Node Worker for each `run_code`. It has no ambient Node/module/process/environment/filesystem/network/Host/protocol API and is bounded by the frozen S-02 source, heap, stack, active-compute, wall, call-count, concurrency, input/result/final-result, diagnostics, and no-nesting limits. Issued calls drain normally while live; cancellation/wall expiry aborts the Agent-side protocol wait so `run_code` and inference-scope disposal remain bounded, while any already-admitted Host Operation retains independent terminal/effect/quiescence truth and unresolved mutation uncertainty remains behind the existing writer/recovery barriers.

No durable Code Mode state object, subagent, remote-workspace authority, code-only provider presentation, raw Host bridge, or direct ProgramState/verification/Completion transition was added.

## Frozen acceptance criteria → implementation/proof

| Criterion | As-built implementation/proof |
| --- | --- |
| AC-S02-01 Host-authorized provider visibility | `packages/agent-protocol/src/local-orchestration-v1.ts`; `packages/host-runtime/src/local-orchestration-catalog-v1.ts`; `packages/host-runtime/src/local-orchestration-catalog-v1.test.ts`; `packages/host-runtime/src/program-execution-runtime-v2.test.ts`. |
| AC-S02-02 No ambient environmental authority | `packages/code-mode/src/worker.mjs`; `packages/code-mode/src/code-mode.test.ts` — ambient Node/process/network/module access test; S02 gate check `s02.ac02-03-08-10.runtime`. |
| AC-S02-03 Exact snapshot SDK | `packages/coding-agent/src/inference-runtime.ts`; `packages/coding-agent/src/inference-runtime-s02-3.test.ts` — exact peer SDK, unknown-name local rejection, `run_code` exclusion; runtime null-prototype SDK regression in `packages/code-mode/src/code-mode.test.ts`. |
| AC-S02-04 Per-subdispatch ProgramAttempt fencing | `packages/coding-agent/src/inference-runtime.ts` routes worker calls through captured peer proxies; `packages/coding-agent/src/inference-runtime-s02-3.test.ts` proves captured ProgramAttemptAuthorityV2 and dynamic capability revisions are preserved on every sub-dispatch. |
| AC-S02-05 Stale Attempt fails future work closed | `packages/coding-agent/src/inference-runtime-s02-3.test.ts` marks orchestration authority lost after `program_execution_stale`; `packages/coding-agent/src/inference-runtime-s02-4.test.ts` proves later work is not sent after invalidation. |
| AC-S02-06 Already-admitted Operation truth survives | `packages/coding-agent/src/inference-runtime-s02-4.test.ts`; `packages/host-runtime/src/program-agent-s02-4.test.ts`; `packages/host-runtime/src/program-adaptive-operation-s02-4.test.ts` prove admitted work settles independently after Attempt/Agent invalidation. |
| AC-S02-07 Distinct mutation/effect identity | `packages/host-runtime/src/program-adaptive-operation-s02-4-production.test.ts` drives two mutations through production CapabilityBroker/adaptive operation authority and proves distinct Host-minted Operation IDs plus independent effect-generation advancement. |
| AC-S02-08 Resource limits deterministic | `packages/code-mode/src/runtime.ts`, `worker.mjs`, and `code-mode.test.ts` cover source, heap, stack, active compute, wall, 16-call total, four-call concurrency, input/result/final-result bounds, diagnostics/error behavior, and no nesting. |
| AC-S02-09 Cancellation and drain | `packages/code-mode/src/code-mode.test.ts`; `packages/coding-agent/src/inference-runtime-s02-4.test.ts`; `packages/coding-agent/src/agent-protocol-bridge.test.ts`; `packages/coding-agent/src/inference-runtime.ts`; `extensions/cognition/src/proxy-tools.ts`. Local cancellation/wall expiry propagates through the exact peer proxy to abort the Agent-side protocol correlation, boundedly releasing inference-scope admissions; already-admitted Host Operation/effect truth remains independent. |
| AC-S02-10 Disposable lifecycle | `packages/code-mode/src/code-mode.test.ts` proves no cross-invocation state; `packages/coding-agent/src/inference-runtime-s02-4-replacement.test.ts` proves live Agent replacement terminates old local compute, drains admitted Host work, and exposes no old VM state to the replacement generation. |
| AC-S02-11 Backward compatibility | `packages/host-runtime/src/local-orchestration-catalog-v1.test.ts` proves unsupported/non-executable cases omit `run_code`; existing direct-tool behavior is retained and `pnpm gate:product-agent` is composed by the S-02 gate. |
| AC-S02-12 No fabricated authority from return values | `packages/coding-agent/src/inference-runtime-s02-4-canonical-return.test.ts` seeds canonical Program state and verification, processes forged completion/evidence-shaped local data through the normal Agent/Host progress path, and proves no fabricated evidence/completion authority. |
| AC-S02-13 Product round-trip proof | `packages/coding-agent/src/cli-s02-code-mode.integration.test.ts` runs the production CLI Program path. One provider inference emits one `run_code`; its local program performs `read → edit → read` as three mediated Host Operations before the outer `run_code` result/next provider inference, then existing typed Host verification succeeds and the Program completes. |
| AC-S02-14 Exact-head closure gate | `scripts/gate/gate-s02-code-mode.ts`, root `gate:s02-code-mode`, and `.github/workflows/s02-code-mode.yml`. The gate composes protocol/catalog, runtime, projection, adversarial, AC-S02-13 product, and `gate:product-agent` proof and emits the standard machine-readable receipt. |

## Frozen adversarial scenarios → exact proof

| Scenario | Proof |
| --- | --- |
| A — no current ProgramAttempt | `local-orchestration-catalog-v1.test.ts`: no executable V2 Attempt ⇒ no `run_code`. |
| B — unsupported Agent generation | `local-orchestration-catalog-v1.test.ts`: no `local_orchestration_v1` negotiation ⇒ no `run_code`; predecessor direct mode remains green. |
| C — tool outside exact snapshot | `inference-runtime-s02-3.test.ts` and `code-mode.test.ts`: unknown SDK name rejects locally with no Host request. |
| D — dynamic binding replaced mid-program | `inference-runtime-s02-3.test.ts`: captured dynamic revision receives `capability_stale`; later ordinary work may continue but no auto-rebind occurs. |
| E — Attempt replaced between subcalls | `inference-runtime-s02-3.test.ts`: first stale ProgramAttempt result marks authority lost; later sub-dispatch is blocked locally. |
| F — invalidation during admitted mutation | `inference-runtime-s02-4.test.ts` plus Host S02-4 operation tests: admitted mutation settles; later local work is not admitted. |
| G — multiple mutations under one local program | `program-adaptive-operation-s02-4-production.test.ts`: two production-path mutations produce distinct Host Operation identities/effect truth. |
| H — concurrency pressure | `code-mode.test.ts`: eight requested calls produce observed max concurrency four; excess calls queue. |
| I — call-count exhaustion | `code-mode.test.ts`: seventeenth call fails locally; only first sixteen reach dispatch. |
| J — infinite/compute-heavy loop | `code-mode.test.ts`: QuickJS active-compute interrupt terminates the cell within the bound. |
| K — oversized source/input/result | `code-mode.test.ts`: source, tool input, tool result projection, final result, heap and stack bounds fail at their frozen layers. |
| L — ambient API escape attempts | `code-mode.test.ts`: `process`, `require`, `fetch`, `Buffer`, `module`, and dynamic `node:fs` import are unavailable/fail without dispatch. |
| M — cancellation with in-flight calls | `code-mode.test.ts`, `inference-runtime-s02-4.test.ts`, and `agent-protocol-bridge.test.ts`: local compute cancels, an unresolved Agent-side Host wait is aborted within the cancellation/wall bound, projection disposal completes, and late/already-admitted Host truth cannot be promoted or erased by the local result. |
| N — Agent replacement mid-cell | `inference-runtime-s02-4-replacement.test.ts` plus `program-agent-s02-4.test.ts`: old worker state/control flow does not survive, admitted Host work settles independently, stale old-generation work cannot gain replacement authority. |
| O — recursive Code Mode attempt | `code-mode.test.ts` and `inference-runtime-s02-3.test.ts`: `run_code` is excluded from worker SDK; no nested worker/Host request is created. |
| P — fabricated verifier/completion return | `inference-runtime-s02-4-canonical-return.test.ts`: forged operation/evidence/verification/completion-shaped result remains transcript/advisory data; canonical verification and Completion remain unsatisfied. |
| Q — direct-mode compatibility | `pnpm gate:product-agent`, composed inside `gate:s02-code-mode`, preserves the predecessor deterministic direct-tool product path. |

## AC-S02-13 structural product trace

`packages/coding-agent/src/cli-s02-code-mode.integration.test.ts` asserts the durable ordering rather than a latency/token target:

1. a durable assistant message contains the outer `run_code` tool call;
2. before the matching outer `tool.result.appended`, exactly three ordinary `operation.requested` events appear with capability sequence `read`, `edit`, `read`;
3. each sub-dispatch owns a distinct Host Operation ID;
4. no `assistant.message.appended` occurs inside that local-orchestration window, so no provider inference intervenes between the three Host calls;
5. `run_code` itself never appears as a Host capability Operation;
6. the edit advances WorkspaceEffectGeneration through the ordinary Host path;
7. the next model message occurs only after the outer local result;
8. the existing `package_typecheck` Host verifier runs after Code Mode and the Program reaches `program.completed` with no verification failure.

This is the frozen structural round-trip proof: deterministic local orchestration removes model↔tool turns without creating a second environmental authority.

## Permanent closure gate

`pnpm gate:s02-code-mode` contains only the frozen S-02 proof surface:

- protocol/capability/binding/catalog compatibility;
- isolated local-runtime containment/resource proofs;
- exact inference-snapshot SDK and per-subdispatch authority proofs;
- stale Attempt / admitted Operation / distinct effect identity adversarial proofs;
- cancellation/drain, Agent replacement, and fabricated-return proofs;
- AC-S02-13 production CLI vertical;
- `pnpm gate:product-agent` predecessor compatibility.

The gate intentionally does not add performance thresholds, provider/model matrices, sandbox certification, subagent/remote-workspace tests, semantic-graph work, or code-only presentation requirements.

## Closure hygiene

The temporary S02-4 authority-proof workflow used during adversarial development is removed in S02-5. The permanent CI entry point is `.github/workflows/s02-code-mode.yml`. No temporary runtime diagnostics, alternate authority path, or staging-only production hook is retained.

## Bounded-drain P1 closure evidence

Review identified that the original drain wording could leave `run_code` and inference-scope disposal waiting indefinitely on an issued Agent→Host capability correlation. Correction commit `bf5fb10fa902cf536b4e1127d01a72cdd11e0619` propagates the bounded local cancellation/wall signal through the exact peer proxy into the existing Agent protocol request-correlation abort path. Aborting that Agent-side wait is explicitly not environmental evidence: any already-admitted Host Operation retains independent terminal/effect/quiescence truth, and unresolved mutation uncertainty remains protected by the existing writer/recovery barriers.

Corrective workflow run `34567601822` passed the focused code-mode/coding-agent proof and the complete frozen `pnpm gate:s02-code-mode` before publishing the clean correction and removing its temporary workflow. This evidence-only follow-up commit exists to trigger ordinary PR CI on the permanent corrected head; exact-head closure still requires those ordinary checks to be green.