# A5 — Execution-Provider Candidate Design Review Resolution

**Status:** REVIEWED CANDIDATE RESOLUTION — NOT FROZEN / NO IMPLEMENTATION AUTHORITY  
**Review date:** 2026-09-15  
**Review input head:** `e180bea4393b1a65ddf5179c424c40db56ad21b8`  
**Baseline:** `main@79e8950e5d09273e1446429b793ba526f2453822`  
**Reviewed documents:** [`a5-execution-provider-gap-study.md`](./a5-execution-provider-gap-study.md), [`a5-execution-provider-plan.md`](./a5-execution-provider-plan.md)  
**Authority:** This document resolves the candidate plan's remaining design-review questions. It does **not** freeze A5 and does **not** authorize runtime implementation.

---

## 1. Review conclusion

The A5 forcing condition remains valid and the corrected candidate architecture is directionally sound.

The current product already separates durable ProgramAttempt authority, Host Operation/effect truth, verification/recovery authority, S-02 local orchestration, and A2 inference provenance. The unresolved physical-execution gap is narrower: the production composition does not yet make one exact physical execution-world generation mechanically common to filesystem execution, process execution, execution-base observation, and world-state verification.

No review finding requires moving authority into an execution provider. The correct A5 direction remains:

```text
ProgramAttempt authority
        ↓
Host current-generation fence
        ↓
Host CapabilityBroker / Operation admission
        ↓
immutable generation-bound execution binding
        ↓
execution provider / exact physical generation
        ↓
provider evidence
        ↓
Host effect / quiescence / reconciliation
        ↓
world-bound verification / Completion
```

The first review's three load-bearing corrections remain accepted:

1. use `workspaceId + executionWorldGenerationId`; do not add a second stable `worldId` in A5;
2. activation and teardown are uncertainty-bearing environmental lifecycle actions requiring positive evidence;
3. an admitted Operation captures an immutable generation-specific execution binding and may never transparently migrate to a successor generation.

This review resolves the remaining questions in the candidate plan as described below.

---

## 2. Source-derived constraints used by this review

The following repository facts constrain A5; these are not new product requirements.

### 2.1 Existing Workspace abstraction already separates identity from transport/location

`packages/coding-agent/src/capabilities/types.ts` states `workspace identity ≠ transport ≠ location` and bundles `WorkspaceIdentity`, `FilesystemCapability`, and `TerminalCapability` behind one Workspace abstraction. The contracts were intentionally shaped so alternative local/SSH/WSL/Docker/remote implementations could exist without changing the model-facing tool surface.

A5 should therefore strengthen execution-world identity/coherence rather than replace the existing Workspace identity model.

### 2.2 Production coherence is currently caller composition

`packages/coding-agent/src/cli.ts` separately constructs:

- `createLocalWorkspace(...)`;
- Host capabilities;
- `ProgramExecutionObservationSourceV1` from the local root;
- verifier path observations from the local root;
- CodeIntelligence from the local root.

That is coherent for today's single local world, but the type/runtime system does not mechanically prove those separately supplied components target the same physical world if a second provider is introduced.

### 2.3 Verification currently has a Host-local path dependency

`packages/coding-agent/src/verification-profile.ts` performs direct Host-local `lstat` for workspace-path verification. That path is valid only because today's execution world is the Host-local workspace. It cannot be allowed to verify an isolated generation by accidentally inspecting a different Host-local copy.

### 2.4 CapabilityBroker is already the correct authority layer above A5

`packages/host-runtime/src/capability-broker.ts` already owns capability admission, dynamic capability generation fences, Program routing, Host Operation identity, durable operation events, writer barriers, quiescence/reconciliation integration, effect-generation advancement, and A2 tool/inference provenance.

A5 must remain beneath this boundary. The provider executes a Host-admitted Operation; it does not admit the Operation or settle canonical effect truth.

### 2.5 Process lifecycle contracts are subsystem-specific today

Local shell execution lives in `packages/coding-agent/src/capabilities/local-workspace.ts`; long-lived external semantic/provider processes use `ExternalProcessSupervisor` in `packages/host-runtime/src/external-process.ts`; Agent generations use their own supervisor.

This supports APR-034's execution-subsystem separation: A5 should share identity/currentness primitives where needed, but should not force Agent processes, semantic providers, and command execution into one universal process manager.

---

## 3. Resolution R4 — execution-relevant effective policy digest

The candidate's `effectivePolicyDigest` is part of execution-world currentness only for policy that can materially alter the physical execution semantics of the world.

A fresh execution-world generation is required when a change can alter any of the following:

- reachable filesystem or mount topology;
- read/write mount permissions or path confinement;
- network/egress reachability;
- ambient environment inherited by executed code;
- secret projection availability or secret-delivery semantics;
- effective user, privilege, namespace, or equivalent isolation boundary;
- CPU, memory, process-count, wall-time, or output constraints where the provider enforces them as part of the execution contract;
- process-tree/containment or teardown semantics relevant to quiescence/recovery;
- execution-base or verification observation semantics that determine what state the Host claims to be observing.

The canonical digest should include only bounded semantic configuration, not raw secrets or provider-native incidental metadata.

Changes that are provably non-semantic for the physical world — for example UI labels, telemetry destinations, log verbosity, or retry/backoff timing that cannot change the admitted world or action — do not require a fresh generation and should not be included in the execution-relevant policy digest.

The safe rule is:

> If a configuration change can change what code can observe, mutate, contact, inherit, consume, or leave running, it is generation-relevant unless a narrower frozen rule proves otherwise.

---

## 4. Resolution R5 — minimum positive activation evidence

`execution.world.activation.prepared` authorizes an activation attempt but is not evidence that a physical world exists.

A provider may produce positive activation evidence only after the exact generation is reachable under the effective policy that the Host intends to use.

The minimum provider-neutral evidence contract is:

```text
Host-minted executionWorldGenerationId
provider descriptor digest
 effective policy digest
provider-observed unique physical instance provenance (safe/bounded)
generation-bound readiness round-trip
```

The readiness round-trip must prove that the provider adapter is talking to the physical execution instance it will subsequently use. A practical provider may implement this with a Host nonce/generation marker injected into provider-owned metadata and read back from inside or through the active world after mounts/policy are established.

This is **provider/adapter observation**, not remote cryptographic attestation. A5 must not claim stronger trust than the provider can establish.

For the local trusted provider, positive activation evidence may be synchronous Host-local evidence that:

- the locked Workspace identity is current;
- the canonical root/binding is the expected one;
- the local provider generation object has been instantiated under the expected local-trusted policy;
- the generation-specific binding is available for execution and observation.

The local provider must not describe this as hostile-code isolation.

Only after positive activation evidence is durably admitted may the generation become `active/current` for new protected work.

---

## 5. Resolution R6 — prepared-activation restart discovery/reconciliation

If the Host restarts after durable activation preparation but before durable positive activation evidence, historical preparation does not prove either occurrence or absence.

On restart, the Host/provider adapter must perform generation-scoped discovery using the Host activation/generation identity. The result is classified as follows:

```text
exactly one matching live physical world
+ matching generation marker
+ matching provider/policy digests
+ positive generation-bound readiness evidence
    → same surviving generation may be adopted/observed active

complete positive absence under provider's discovery contract
    → prepared activation can be resolved as non-active/abandoned;
      a fresh successor generation may be prepared

multiple matches, incomplete discovery, identity mismatch,
or inability to prove absence/presence
    → lost_or_unknown; fail closed for conflicting new work
      until cleanup/reconciliation makes progress safe
```

A provider whose discovery surface cannot establish completeness must not turn "not found" into positive absence.

The Host must not blindly create a conflicting successor while a prepared activation may already have created a live execution world whose lifecycle matters for resource/secret/containment policy.

---

## 6. Resolution R7 — positive closure evidence

A durable teardown/retirement request is not proof of closure.

A generation may transition to `closed` only on generation-specific positive evidence that the exact provider-owned execution binding is no longer executable under the provider's closure contract.

For an isolated provider, acceptable evidence normally requires both:

- provider acknowledgement tied to the exact generation/provider-native instance provenance; and
- provider discovery/inspection showing that the exact generation-owned instance is absent or terminated, where the provider claims that discovery is complete.

If the provider cannot prove absence after a failed/lost teardown request, the generation remains `lost_or_unknown` and fenced from new work.

For the local trusted provider, closure means retirement/release of the generation-specific local execution binding. It does **not** mean deleting the Workspace files or destroying the host environment.

Closure evidence never proves:

- that a previously admitted mutation did not occur;
- that external effects were rolled back;
- that leaked credentials became safe;
- that Operation quiescence is satisfied unless the existing quiescence contract independently accepts the relevant containment evidence.

---

## 7. Resolution R8 — reconnect continuity rule

A5 v1 uses **fresh generation by default**.

A reconnect may retain the same generation only when the provider proves that the exact same physical world survived continuously and was not recreated. The minimum continuity proof is:

- the exact Host-minted `executionWorldGenerationId` is rediscovered from provider-owned generation metadata;
- the same unique provider-native physical instance provenance is observed;
- provider descriptor and effective-policy digests match;
- a new positive generation-bound readiness round-trip succeeds;
- canonical Host history contains no retirement, closure, or loss fact that semantically ended the generation;
- provider discovery is strong enough to rule out a replacement instance masquerading under the same human-readable name/path.

If any element cannot be established, the Host fences the old generation and mints a fresh successor.

Matching repository bytes, provider-native names, mount paths, or connection endpoints are never continuity proof by themselves.

---

## 8. Resolution R9 — planning reads under isolated execution

Planning evidence remains observation, never execution authority.

For A5:

- raw filesystem planning reads (`list`, `read`, search/grep-like reads) that claim current execution-world state must use the current generation-bound filesystem seam;
- any planning dependency emitted from such a read must retain enough provenance to be rechecked against the exact execution-world/base currentness cut;
- semantic CodeIntelligence may remain a separate subsystem/provider only if it can establish freshness/provenance against the same exact current execution generation/base;
- when an isolated backend cannot provide such a freshness bridge, semantic CodeIntelligence is unavailable or explicitly incomplete/stale for that provider; it must not silently inspect a Host-local copy and call that current isolated-world evidence.

The first A5 isolated provider is therefore not required to make every existing semantic planning feature available. Correct unavailability is preferable to cross-world semantic drift.

---

## 9. Resolution R10 — process surface

A5 does **not** require a new Agent/model-facing process protocol.

The model-facing `bash`/terminal semantics may remain compatible with today's `TerminalCapability` contract for A5 v1.

The provider implementation may use a richer Host-internal command/process adapter to support:

- generation-specific process dispatch;
- process-tree ownership;
- cancellation;
- CPU/memory/PID/wall-time enforcement;
- stdout/stderr bounds;
- containment-instance evidence;
- teardown and recovery observation.

Those mechanisms remain provider/Host implementation detail unless a later objective demonstrates a need for durable interactive process handles or a richer Agent-facing terminal contract.

This prevents A5 from accidentally becoming a terminal/session product redesign.

---

## 10. Resolution R11 — local process supervision ownership

A5 should not turn `AgentSupervisor`, `ExternalProcessSupervisor`, or the current `LocalTerminal` implementation into one universal execution authority.

The local A5 execution provider should own the command-execution path currently represented by `LocalTerminal`, including generation-specific process-tree containment required for Host Operations.

Implementation may factor reusable OS process-tree kill/wait primitives into a shared Host-owned utility when semantics are identical, but lifecycle ownership remains subsystem-specific:

```text
Agent process generation       → AgentSupervisor
long-lived semantic providers  → ExternalProcessSupervisor or successor
world-scoped command execution → A5 execution provider binding
```

This preserves APR-034 and avoids coupling disposable Agent lifecycle or LSP lifecycle to environmental Operation semantics.

---

## 11. Resolution R12 — vendor-neutral `isolated-v1` closure profile

A5 should freeze an implementation-independent isolated profile rather than a particular sandbox vendor.

The candidate closure profile `isolated-v1` requires all of the following to be enforceable and testable on the declared supported platform:

- explicit Workspace/repository mount set;
- no host filesystem access outside declared mounts;
- unprivileged execution or a documented equivalent bounded privilege contract;
- bounded CPU;
- bounded memory;
- bounded process/PID count;
- bounded wall time;
- bounded stdout/stderr/result size;
- default-deny network/egress for the closure fixture, or an equivalent explicit egress block that the fixture can prove;
- scrubbed ambient environment;
- no implicit host credential/secret inheritance;
- explicit ephemeral secret projection only when Host policy permits it;
- generation-bound positive activation evidence;
- deterministic teardown attempt plus generation-specific closure/discovery evidence;
- process-tree containment sufficient to preserve the existing quiescence/recovery contract.

Exact numeric production defaults remain product/implementation policy. The blocking conformance fixture must nevertheless use deterministic finite thresholds so enforcement can be proved.

A physically isolated backend used for closure must be reproducible on at least one explicitly supported CI platform. Unsupported platforms fail explicitly; they do not silently downgrade to the local trusted provider while claiming isolation.

---

## 12. Resolution R13 — ProgramAttempt response to generation replacement

A5 does not add a second subsystem that directly retires ProgramAttempts merely because the execution generation changes.

The required invariant is:

> Once the Host has durably fenced/lost/retired G0 or made G1 the current generation, no new protected Operation under an Attempt bound to G0 may be admitted.

Existing ProgramAttempt currentness must compare the exact generation and fail closed. Existing canonical Program recovery/retry transition machinery then retires/replaces the stale Attempt and issues fresh authority when work remains.

An immediate explicit Attempt-retirement event may be added later if it materially improves observability or recovery latency, but it is not required for A5 correctness so long as:

- protected admission cannot pass with stale generation authority;
- recovery deterministically converges through existing Program authority;
- no provider/world lifecycle component mutates ProgramState outside the existing Program authority path.

---

## 13. Resolution R14 — Experience Plane exposure

A5 requires no new client control authority.

A read-only Experience Plane status may expose bounded, non-secret execution-environment information such as:

- provider kind;
- current execution-world generation identifier or a display-safe shortened representation;
- containment profile name;
- lifecycle state (`prepared`, `active`, `retiring`, `closed`, `lost_or_unknown`);
- explicit `local_trusted` versus `isolated` classification;
- provider adapter identity/version;
- bounded availability/health state.

It must not expose or accept back as authority:

- provider-native control handles/tokens;
- raw credentials or environment snapshots;
- secret-bearing provider configuration;
- sensitive provider endpoints merely for convenience;
- a historical generation ID as a client-selected execution target;
- direct provider lifecycle controls unless a separately authorized Application/Experience objective defines them.

Read-only world metadata remains provenance/status, not capability authority.

---

## 14. Supersession note for the forcing study

The forcing study intentionally predates design convergence and contains illustrative alternatives. Any illustrative `worldId + worldGenerationId` shape in the forcing study is superseded for the current A5 candidate by the reviewed single-generation decision:

```text
workspaceId
+ executionWorldGenerationId
```

The gap study remains valid as evidence of why A5 is forced. Its pre-review illustrative identity shapes are not implementation authority.

Likewise, the questions listed at the end of `a5-execution-provider-plan.md` are the pre-resolution review checklist. Sections 3–13 of this document record the reviewed candidate answers to those questions.

---

## 15. Acceptance-criteria impact

This review does not broaden the candidate acceptance objective. It makes several existing criteria more testable:

- **AC-A5-01/02:** material execution-policy changes and unproven reconnects require fresh generation; same-bytes ABA remains stale.
- **AC-A5-03:** generation-bound filesystem/process/observation composition is mechanically coherent.
- **AC-A5-05:** Operation admission captures immutable execution binding, not a late lookup of current generation.
- **AC-A5-06/07/15:** activation/teardown/restart semantics now have explicit positive-evidence and discovery rules.
- **AC-A5-09:** quiescence remains independently proven; provider/world closure does not synthesize it.
- **AC-A5-10/11:** the effective policy digest and durable descriptors remain semantic and secret-free.
- **AC-A5-12:** world-bound verification cannot inspect a different Host-local copy.
- **AC-A5-14:** `isolated-v1` supplies a vendor-neutral physical-isolation closure profile.
- **AC-A5-16:** unsupported providers/platforms remain explicit failures, never silent downgrade.

No acceptance criterion makes provider lifecycle evidence equivalent to Operation effect truth.

---

## 16. Remaining implementation-owned choices

The following choices remain intentionally reversible and are **not** blockers to the candidate design:

- package/interface names (`@alcode/execution-provider` versus existing package placement);
- exact canonical event names;
- concrete first isolated backend technology;
- provider-native metadata used to implement generation tagging/discovery;
- exact finite numeric resource limits for production defaults;
- exact projection/index structure for world lifecycle reconstruction;
- whether `TerminalCapability` is internally wrapped or replaced beneath the unchanged model-facing `bash` surface;
- exact UI representation of read-only execution-environment status;
- implementation PR slicing.

A future implementation must not resolve those choices by weakening the reviewed semantic constraints.

---

## 17. Review decision

**Proceed as written** for the A5 candidate design after this bounded review resolution is included in the PR.

This means:

- the A5 forcing/gap study is sufficient;
- the candidate architecture has no demonstrated unresolved authority defect;
- the design may be merged as a reviewed **candidate** record;
- A5 remains **NOT FROZEN / NO IMPLEMENTATION AUTHORITY**;
- runtime implementation requires a separate explicit freeze/authorization decision.
