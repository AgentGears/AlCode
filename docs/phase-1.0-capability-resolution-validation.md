# ALCODE Phase 1.0 — ProgramAttempt Capability Resolution Validation

**Status:** DRAFT / non-normative planning study  
**Approval:** not approved; not frozen; implementation not authorized  
**Planning base:** `main` at `d383dd81e254f5acd685b5fceb7fc8e9d0142270`  
**Purpose:** determine whether Phase 1.0 correctness requires a `ProgramAttempt` to commit to an exact Host capability/provider resolution, or whether that stronger lifecycle belongs to Host capability/runtime evolution outside the Phase 1.0 contract.

> External design reference: *A Programming Paradigm for Spatiotemporal Composability* (Shi, Zhang, Cui). Its committed dependency view, resolution-coherence, and dependency-ordered withdrawal results are used as architecture patterns only. ALCODE does not depend on Cordis and this study does not propose adopting its runtime or calculus.

## 1. Question and promotion rule

The question is narrower than general dynamic component composition:

> When a `ProgramAttempt` uses Host capabilities whose providers may be replaced or restarted, must the attempt bind to one exact provider resolution for its whole lifetime?

The same contract-proof rule used by the artifact-seam study applies:

- **PROMOTE** only if omission breaks a guarantee or acceptance predicate Phase 1.0 already claims;
- **ACCOMMODATE / DEFER** when the property is useful or likely necessary later but current Phase 1.0 remains correct without it;
- **REJECT** a coupling that conflates authorities or creates unnecessary invalidation.

Two candidate invariants were tested.

Whole-attempt commitment:

```text
one ProgramAttempt
→ one immutable capability/provider-resolution view
→ provider-generation change interrupts or supersedes the attempt
```

Invocation-scoped exact binding:

```text
ProgramAttempt authorizes bounded capability use
→ an operation resolves one Host capability binding
→ result/evidence/reconciliation remain associated with that operation
→ a later invocation may resolve a newer binding if the ProgramAttempt is still current
```

## 2. Result

**Decision: do not promote a provider-resolution invariant into Phase 1.0 from the current evidence.**

### 2.1 DEFER — whole-ProgramAttempt provider snapshot

Phase 1.0 does **not** require one immutable provider-resolution snapshot for an entire `ProgramAttempt`.

A `ProgramAttempt` is bounded work authority. Current ALCODE dynamic capabilities are invocation-scoped Host services. If a provider changes between two invocations, a later invocation can use the current binding without violating the existing ProgramState/Attempt contract, provided the ProgramAttempt is otherwise still current and the Host authorizes the invocation.

Therefore Phase 1.0 should not automatically interrupt work because an unrelated provider, tool catalog, or provider generation changed.

### 2.2 ACCOMMODATE / DEFER — canonical provider-generation provenance per operation

Persisting the exact provider generation used by an operation is a strong Host-capability provenance improvement, but the current Phase 1.0 plan does not yet contain an acceptance predicate that consumes provider-generation identity.

Current Phase 1.0 correctness already has stable `operationId` correlation. A late or recovered operation remains that same operation even if the live provider has since changed. The existing plan does not reinterpret an old operation as belonging to the replacement provider merely because the provider identity is absent from the operation record.

Accordingly, this study does **not** claim that AC-10-06, replay, or uncertainty semantics are presently incomplete without provider-generation attribution.

Instead, exact operation execution-binding provenance is classified as:

```text
Host capability substrate hardening / successor design constraint
```

It should become a Phase 1.0 requirement only if planning adds a predicate or recovery rule whose correctness depends on provider incarnation—for example provider-specific reconciliation, provider-profile verification, or a long-lived provider-backed resource.

### 2.3 CURRENT-SUBSTRATE HARDENING IDEA — tighten dynamic-binding linearization

The source inspection did uncover a narrower implementation-level concern in the existing dynamic capability substrate: the broker checks the expected dynamic revision before asynchronous policy/approval/cognition work and does not visibly revalidate that revision at canonical operation admission.

That is a potential stale-binding TOCTOU surface. It is important, but this planning study does not reopen an earlier frozen phase or silently make it Phase 1 scope.

Classify it separately:

```text
current Host capability hardening idea
not a ProgramState design requirement by itself
```

If it is pursued, it needs its own explicit objective and tests against the existing dynamic-capability contract.

### 2.4 DEFER — general dependency-ordered provider withdrawal

The following remain successor Host-runtime composition concerns:

- a ProgramAttempt-wide committed dependency view;
- dependency graphs between live Host components;
- two-phase provider withdrawal that drains arbitrary dependents;
- general HMR / live component replacement;
- reversible-effect tracking for arbitrary Host components;
- confluence of dynamic component assembly.

Those become relevant if ALCODE later treats long-lived Host services or provider-backed handles as dependencies that must remain stable through an episode.

## 3. Why Cordis does not map one-to-one onto ProgramAttempt

Cordis's committed view binds a running component episode to the specific providers of values/services that the component declared as dependencies. The binding remains usable through dependent teardown, and provider withdrawal is ordered after dependent withdrawal.

ALCODE's current dynamic capability seam has a different grain:

```text
Cordis dependency
  long-lived resolved value/service used throughout a component episode

ALCODE dynamic capability
  Host-authorized invocation resolved at a tool-call/inference boundary
```

Treating every ALCODE capability provider as a long-lived coeffect would over-bind `ProgramAttempt` authority to runtime implementation topology.

The transferable rule is narrower:

> A computation should not silently switch dependency identity inside a unit whose correctness actually assumes stable dependency identity.

For current Phase 1.0 ProgramState semantics, no acceptance criterion establishes that the whole ProgramAttempt is such a unit for capability providers.

A future provider-backed lease, transaction, stream, process handle, browser page, remote workspace, or similar resource may create exactly that requirement. The binding lifetime should then follow the resource/episode that depends on it, rather than being imposed globally on every ProgramAttempt.

## 4. Current ALCODE source model

This study inspected the exact planning base above.

### 4.1 Agent Protocol already scopes dynamic binding to provider inference/tool use

`@alcode/agent-protocol` defines:

```ts
type CapabilityBinding =
  | { kind: "static" }
  | { kind: "dynamic"; revision: string };

interface AuthorizedToolDescriptor {
  definition: ModelToolDefinition;
  binding: CapabilityBinding;
  isReadOnly?: boolean;
}

interface CapabilityRequest {
  ...
  expectedCapabilityRevision?: string;
}
```

The protocol calls the tool set an `InferenceToolCatalog` and documents it as Host-authorized for **exactly one provider inference**.

The intended boundary is therefore already smaller than a ProgramAttempt:

```text
Host prepares inference
→ tool C is described with dynamic revision G0
→ Agent emits request expected G0
→ Host rejects if C is no longer bound to G0
```

### 4.2 CapabilityBroker has explicit dynamic provider generations

`CapabilityBroker` stores dynamic registrations with:

```text
providerId + revision + capability names
```

`registerDynamicProvider(providerId, revision, capabilities)`:

- requires provider identity and revision;
- forbids reuse of a retired `providerId@revision` pair;
- stages a replacement before publishing it;
- retires the previous generation;
- rejects conflicting registrations without partial replacement.

For dynamic invocation, `execute()` requires:

```text
request.expectedCapabilityRevision === registration.binding.revision
```

The existing dynamic-capabilities tests cover stale ABA rejection, missing revisions for dynamic tools, conflict rejection, and retired-generation non-reuse.

This gives distinct identity dimensions:

```text
ProgramState revision
  durable semantic state generation

ProgramAttemptId
  one current dispatch/claim

AgentGenerationId
  replaceable Agent-process identity

Dynamic capability revision
  one provider/tool binding generation
```

One should not be encoded as another.

### 4.3 MCP and plugin layers already carry narrower generation identities

`HostMcpManager` gives each MCP server a stable provider identity:

```text
mcp:<plugin-registration-id>:<server-name>
```

and mints a new random capability revision when it replaces that server's exported tool catalog.

A generated MCP capability closure captures the runtime instance and refuses execution when that runtime is no longer current. Unexpected stdio exit withdraws the current capabilities before bounded restart.

The plugin layer separately uses a content digest as the trusted plugin generation. Plugin replacement/disable/refresh withdrawal removes the active generation before the service clears its trusted binding.

The restart path **can** revalidate exact plugin-generation process-start trust through `authorizeProcessStart`, and the Host/plugin service exposes that revalidation operation. However `HostMcpManagerOptions.authorizeProcessStart` is optional; when it is absent, the manager falls back to the cached activation. This study therefore does not treat exact restart revalidation as an unconditional property of every possible `HostMcpManager` construction.

Relevant identities remain separate:

```text
plugin generation digest
MCP providerId
MCP dynamic capability revision
```

### 4.4 Durable operations do not currently persist dynamic provider generation

The broker's canonical `operation.requested` payload records:

```ts
{
  operationId,
  toolName,
  args,
  isReadOnly
}
```

The durable `OperationRecord` likewise stores the operation identity, tool, arguments, lifecycle/outcome/effect/reconciliation state, but no provider ID or dynamic capability revision.

Therefore canonical replay cannot answer this audit/provenance question from the operation record alone:

```text
Which dynamic provider generation was selected when O was invoked?
```

That is a real provenance limitation. It is **not**, under the current Phase 1 plan, proof of a ProgramState correctness defect: `operationId` still preserves the identity of O, and current AC-10 predicates do not require provider incarnation to evaluate O's effect, attempt ownership, or verification freshness.

This distinction is the reason the study classifies provider-generation persistence as accommodate/defer rather than promote.

### 4.5 Dynamic revision check precedes asynchronous admission work

The broker reads the registration and checks `expectedCapabilityRevision` before policy authorization, hooks/approval, cognition matching, and canonical `operation.requested` append.

Those steps can be asynchronous. The same revision is not visibly re-read inside the canonical admission callback immediately before operation creation.

Potential history:

```text
read C@G0
→ expected G0 passes
→ await policy / approval / cognition
→ provider changes to G1
→ continue toward operation admission with captured registration
```

MCP narrows some consequences because a captured capability checks the captured runtime against the current runtime before calling it. But this does not establish a general canonical linearization theorem for dynamic binding, and a catalog revision may change while the same runtime object remains.

This is a useful hardening finding for the Host capability substrate. It should not be smuggled into Phase 1 implementation scope by a planning study.

## 5. Canonical ownership model

The current safe ownership split is:

```text
ProgramState
  owns durable work / verification / completion truth

ProgramAttempt
  owns bounded current work authority

CapabilityBroker / Host capability layer
  owns current capability binding resolution

Operation
  owns durable identity of one admitted execution attempt

Provider runtime
  performs the provider-specific execution
```

Provider-generation provenance, if later made canonical, belongs with operation/execution provenance—not inside ProgramState revision identity.

A future shape could resemble:

```text
OperationExecutionBinding {
  capabilityName
  bindingKind
  providerId?
  providerRevision?
}
```

but this is illustrative only. No schema is approved by this study.

## 6. Why expectedProgramRevision is not a provider-generation check

A provider can restart or publish a new capability generation without any ProgramState mutation:

```text
ProgramState revision R17
Attempt A current
provider G0
→ provider changes to G1
ProgramState still R17
```

Thus:

```text
expectedProgramRevision == currentProgramRevision
```

says nothing about whether an old dynamic capability descriptor is current.

The reverse is also true: capability revision equality says nothing about whether the ProgramAttempt remains current.

Agent generation is a third orthogonal identity.

This supports keeping the checks separate, but it does not prove they all need to be copied into ProgramState.

## 7. Event-history probes

### H1 — provider changes before the first invocation

```text
Attempt A admitted at ProgramState R17
→ no capability invoked yet
→ provider P changes G0 → G1
→ A receives current tool binding and requests C@G1
```

**Result:** current Phase 1 semantics can remain correct with the same ProgramAttempt. Whole-attempt interruption is unnecessary.

### H2 — unrelated provider changes

```text
Attempt A may use P
→ unrelated Q changes Q0 → Q1
```

**Result:** no current Phase 1 predicate requires A to become stale. A global capability snapshot would introduce unrelated invalidation.

### H3 — stale inference requests old generation

```text
Host supplies C@G0 for inference I
→ provider changes G0 → G1
→ Agent emits request expected G0
```

**Result:** existing dynamic capability semantics intend rejection as stale before capability execution.

### H4 — binding changes after initial check

```text
Host reads C@G0
→ expected G0 passes
→ asynchronous policy/approval/cognition work
→ provider changes G0 → G1
→ broker reaches operation admission
```

**Result:** this is a Host capability TOCTOU hardening case. It does not require ProgramAttempt-wide provider commitment. A capability-layer fix, if authorized separately, should define the desired linearization behavior.

### H5 — operation starts before provider changes

```text
Attempt A
→ O starts through G0
→ live provider becomes G1
→ O completes
```

**Result:** durable `operationId` keeps the result attached to O. The current Phase 1 contract does not require provider revision to decide that O remains O.

Persisting G0 would improve auditability and could support future provider-specific reconciliation, but no current acceptance predicate consumes it.

### H6 — late result from superseded ProgramAttempt

```text
A → O starts
→ A interrupted
→ B current
→ provider changes
→ O returns late
```

**Result:** Phase 1 rejects reassignment through ProgramAttempt ownership/correlation. Provider-generation identity is not needed to establish that A is stale.

### H7 — Host crash with a nonterminal operation

```text
A → O requested/started
→ Host crashes
→ provider process disappears/restarts
→ Host reopens
```

**Result:** existing operation recovery marks the surviving nonterminal operation indeterminate/pending and does not auto-retry it. The immutable `operationId` is enough for this current rule.

If reconciliation later needs to address a particular provider incarnation, provider-generation provenance becomes necessary for that *new* reconciliation contract.

### H8 — identical provider behavior, different generation

```text
G0 and G1 expose equivalent schemas/results
```

**Result:** dynamic binding still treats them as distinct generations for stale-request control. Observational equivalence should not collapse runtime authority identity, but Phase 1 does not need to elevate that identity into ProgramState.

### H9 — same ProgramAttempt uses old then new generations

```text
A current at R17
→ O1 executes through G0
→ provider becomes G1
→ A remains current at R17
→ later inference exposes G1
→ O2 executes through G1
```

**Result:** no current Phase 1 invariant is broken merely because O1 and O2 used different provider generations. This is the decisive counterexample to whole-attempt commitment.

### H10 — provider-backed long-lived resource

```text
A invokes under G0
→ receives handle H whose validity/teardown depends on G0
→ provider becomes G1
→ A uses or releases H
```

**Result:** invocation-scoped freshness is no longer enough. H needs an explicit binding lifetime and possibly provider-quiescence semantics.

This is the case for accommodating Cordis-like committed dependency resolution later.

### H11 — replacement Agent

```text
Attempt A current
→ Agent X dies
→ Agent Y resumes Host-owned state
→ provider changed G0 → G1 meanwhile
```

**Result:** Y must not reuse X's stale inference binding. Agent-generation/Attempt validity and current capability binding are separate checks. Provider change alone does not decide whether A remains a valid ProgramAttempt.

### H12 — verification pending across provider replacement

```text
verification-related O starts
→ provider changes
→ O evidence arrives
```

**Result:** current verification freshness is indexed by the ProgramState verification subject generation. Provider replacement does not automatically create a second freshness system.

If a future verification criterion explicitly requires a named provider/profile generation, that future criterion must carry and evaluate it explicitly.

### H13 — unexpected MCP exit and restart

```text
MCP process exits
→ current capabilities withdrawn
→ bounded restart
→ new capability revision
```

**Result:** old inference bindings become stale for new calls. Existing operations keep their own operation identity. Exact restart trust revalidation is conditional on the configured `authorizeProcessStart` path and should not be assumed universally.

### H14 — rebuild

```text
canonical log contains Attempt A + O1 + O2
live provider has moved through G0 → G1
```

**Result:** current Phase 1 rebuild can reproduce ProgramAttempt/operation/evidence state without reconstructing provider generations because no current ProgramState reducer predicate consumes them.

A future provider-aware audit/reconciliation projection would require additional canonical provenance.

## 8. Competing designs

### Design A — ProgramAttempt-wide immutable provider snapshot

```text
program.attempt.started
→ snapshot provider bindings
→ provider change invalidates attempt
```

Benefits:

- close to Cordis committed-view semantics;
- simple resolution-coherence statement.

Costs:

- over-binds ProgramAttempt authority to runtime topology;
- unrelated provider changes can interrupt work;
- conflicts with the current per-inference/per-tool dynamic binding grain;
- creates broad durable snapshot/invalidation machinery;
- moves toward a general runtime component system.

**Decision:** defer.

### Design B — current per-request dynamic revision check

```text
Agent request carries expected revision
→ broker checks current registration
```

Benefits:

- implemented now;
- rejects stale dynamic generations at request entry;
- supports provider refresh without ProgramAttempt churn.

Limitations:

- provider generation is not retained as durable operation provenance;
- revision validation is not visibly linearized with later canonical operation admission;
- cannot support provider-incarnation-specific replay/reconciliation without further metadata.

**Decision:** sufficient for the current Phase 1 ProgramState contract as currently written; record the limitations as capability-substrate hardening/successor concerns rather than silently expanding Phase 1.

### Design C — canonical invocation-scoped execution binding

```text
A current
→ Host resolves C to B
→ operation O durably records B
→ O/result/reconciliation keep B
→ later O2 may record B' while A remains current
```

Benefits:

- stronger audit and execution provenance;
- enables provider-specific reconciliation;
- composes naturally with dynamic refresh;
- avoids whole-attempt invalidation.

Cost:

- adds a new canonical fact not consumed by current Phase 1 acceptance predicates.

**Decision:** accommodate/defer. Promote only when an approved contract actually relies on provider incarnation.

## 9. Resolution coherence in ALCODE-native terms

The Cordis-inspired property should be attached to the smallest authority boundary whose correctness needs it.

Today the strongest justified statements are:

```text
Agent inference/tool descriptor
→ old dynamic revision must not authorize a new call after replacement

ProgramAttempt
→ stale Attempt must not admit current ProgramState mutations/evidence

Operation
→ immutable operationId keeps terminal/recovery facts attached to the operation that was admitted
```

The study does **not** establish:

```text
ProgramAttempt
→ every operation must use one immutable provider generation
```

A future long-lived provider-backed resource can introduce a larger committed-resolution boundary when there is an actual semantic dependency to protect.

## 10. Provider withdrawal

Current plugin/MCP code already contains narrower lifecycle mechanisms:

```text
plugin withdrawal
→ dispose current dynamic capabilities
→ close runtime
```

and unexpected stdio exit:

```text
process exits
→ capabilities disposed
→ runtime cleared
→ bounded restart
→ new dynamic capability generation
```

These are provider-local mechanisms, not a general Host dependency calculus.

A future resource/Host-component design may need Cordis-like two-phase withdrawal:

```text
withdraw new admission
→ retain old generation for already-bound dependents
→ dependent quiescence/teardown
→ dispose old generation
```

Nothing in the current Phase 1 contract requires that generalization.

## 11. Relationship to Phase 1.0 acceptance areas

**No existing AC-10 criterion should be amended solely from this study.**

- AC-10-04 continues to own ProgramState revision, ProgramAttempt, work-item, and Agent-generation freshness.
- AC-10-06 continues to own durable ProgramState/ProgramAttempt correlation and external-effect uncertainty through immutable operation identity.
- AC-10-07 continues to own verification subject freshness.

Provider-generation provenance remains separate unless a later approved predicate explicitly needs it.

If that happens, the likely place is operation/evidence provenance adjacent to AC-10-06, but that is a future planning decision rather than a conclusion of this study.

## 12. Source-observed hardening candidates outside this decision

The source inspection produced two bounded follow-up ideas that should not be confused with Phase 1 requirements:

1. **Dynamic-binding TOCTOU proof.** Define/test whether a dynamic provider can change after the initial revision check but before operation admission/execution, and whether the broker must revalidate or retain the old binding under explicit authority.
2. **Restart trust construction proof.** Determine whether every production `HostMcpManager` construction supplies `authorizeProcessStart`. The option is currently optional, so exact digest revalidation must be treated as conditional until the composition root proves otherwise.

These are current-substrate questions. They require distinct authorization before code or earlier-phase contract changes.

## 13. Terminology to preserve

Keep these identities distinct in later planning:

- **ProgramState revision** — current durable ProgramState generation;
- **ProgramAttemptId** — current dispatch/claim identity;
- **AgentGenerationId** — replaceable Agent-process identity;
- **capability binding revision** — exact dynamic capability generation used for stale-call control;
- **plugin generation digest** — content-addressed trusted plugin package generation;
- **operationId** — durable identity for one capability operation;
- **operation execution binding** — possible future provenance identifying the exact provider binding used by one operation.

## 14. Final classification

```text
DO NOT PROMOTE TO PHASE 1.0
  ProgramAttempt-wide provider snapshot
  provider-generation change ⇒ ProgramAttempt interruption
  general dependency-ordered provider withdrawal

ACCOMMODATE / DEFER
  canonical operation execution-binding provenance
  provider-incarnation-specific reconciliation
  committed binding for long-lived provider-backed resources

CURRENT-SUBSTRATE HARDENING IDEA
  prove/close dynamic-binding check-to-admission TOCTOU
  prove mandatory restart trust revalidation at the production composition root
```

The governing reason is the contract-proof rule:

> The current Phase 1.0 acceptance model can reconstruct and evaluate ProgramState/Attempt/operation uncertainty using immutable operation identity without consuming provider-generation identity. Therefore provider-generation attribution is not yet a Phase 1 correctness prerequisite.

Cordis remains useful as a design constraint for a future runtime in which dependencies are long-lived and provider identity is semantically observable. That future need should not be projected backward onto every Phase 1 capability invocation.

## 15. Consequence

This study produces **no Phase 1.0 governing-plan amendment**.

The next action, if explicitly authorized, should be one of two separate objectives rather than a ProgramState change:

1. a focused Host-capability hardening study/test of dynamic-binding linearization; or
2. later runtime-composition design for long-lived provider-backed resources and dependency-ordered withdrawal.

This document does not approve Phase 1.0, does not freeze it, and does not authorize implementation.
