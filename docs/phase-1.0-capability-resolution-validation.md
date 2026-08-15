# ALCODE Phase 1.0 — ProgramAttempt Capability Resolution Validation

**Status:** DRAFT / non-normative planning study  
**Approval:** not approved; not frozen; implementation not authorized  
**Planning base:** `main` at `d383dd81e254f5acd685b5fceb7fc8e9d0142270`  
**Purpose:** determine whether Phase 1.0 correctness requires a `ProgramAttempt` to commit to an exact Host capability/provider resolution, or whether that stronger lifecycle belongs to successor Host-runtime composition work.

> External design reference: *A Programming Paradigm for Spatiotemporal Composability* (Shi, Zhang, Cui). Its committed dependency view, resolution-coherence, and dependency-ordered withdrawal results are used here as architecture patterns only. ALCODE does not depend on Cordis and this study does not propose adopting its runtime or calculus.

## 1. Question and decision rule

The question is deliberately narrower than general dynamic component composition:

> When a `ProgramAttempt` uses Host capabilities whose providers may be replaced or restarted, must the attempt bind to one exact provider resolution for its whole lifetime?

The same promotion rule used by the artifact-seam validation applies:

- **PROMOTE** a semantic invariant only if omitting it creates a correctness hole in a guarantee Phase 1.0 already claims;
- **ACCOMMODATE / DEFER** stronger machinery when Phase 1.0 can remain correct without it;
- **REJECT** a proposed coupling when it would conflate authorities or create unnecessary invalidation.

The candidate whole-attempt invariant is:

```text
one ProgramAttempt
→ one immutable capability/provider-resolution view
→ any provider-generation change interrupts or supersedes the attempt
```

The competing invocation-scoped invariant is:

```text
ProgramAttempt authorizes bounded capability use
→ each operation resolves an exact Host capability binding
→ that exact binding is durably correlated before execution
→ result/evidence/reconciliation remain bound to that execution binding forever
→ a later invocation may resolve a newer binding if the ProgramAttempt is still otherwise current
```

## 2. Result

**Decision: SPLIT.**

### 2.1 PROMOTE — exact execution binding is required at the operation boundary

Phase 1.0 correctness requires every attempt-originated operation whose provider identity can change to be durably attributable to the **exact Host execution binding actually admitted for that operation**.

The semantic requirement is:

```text
ProgramAttempt A authorizes capability C
→ Host resolves C to binding B
→ Host canonically admits operation O with A + B
→ O executes only while B is still the admitted binding for O
→ O result/evidence/reconciliation remain correlated to A + B
```

A provider replacement from `B` to `B'` must never cause an already-admitted or late operation result to be reinterpreted as having run under `B'`.

This is required by existing Phase 1.0 claims about:

- durable `ProgramStateId` / `ProgramAttemptId` operation correlation;
- stale-attempt rejection;
- uncertainty and reconciliation;
- rebuildability from canonical facts;
- Host-only evidence admission.

An exact binding is execution provenance. It is not ProgramState authority and does not itself satisfy work or verification.

### 2.2 ACCOMMODATE / DEFER — whole-ProgramAttempt provider snapshot

Phase 1.0 does **not** need to require one immutable provider-resolution snapshot for the entire `ProgramAttempt`.

A `ProgramAttempt` is bounded work authority. A capability invocation is an execution event under that authority. If the Host's current capability binding changes between two invocations, the later invocation may use the newer binding **without minting a new ProgramAttempt**, provided:

- the ProgramAttempt remains current;
- `expectedProgramRevision` still matches exactly where required;
- Host policy still authorizes the capability;
- the new invocation is admitted against its own exact current execution binding;
- no long-lived provider-backed resource contract says otherwise.

Therefore Phase 1.0 should not automatically interrupt work because an unrelated provider, tool catalog, or provider generation changed.

### 2.3 DEFER — general dependency-ordered provider withdrawal

The following remain successor Host-runtime composition concerns:

- a ProgramAttempt-wide committed dependency view;
- dependency graphs between live Host components;
- two-phase provider withdrawal that drains all dependent components;
- general HMR / live component replacement;
- reversible-effect tracking for arbitrary Host components;
- confluence of dynamic component assembly.

Those become relevant if ALCODE later treats long-lived Host services or provider-backed handles as runtime dependencies that must remain stable through a component/attempt episode.

## 3. Why Cordis does not map one-to-one onto an ALCODE ProgramAttempt

Cordis's committed view binds a running component episode to the specific providers of the values/services that component declared as dependencies. That binding remains usable through dependent teardown, and provider withdrawal is ordered after dependent withdrawal.

ALCODE's current dynamic tool seam is different in an important way:

```text
Cordis dependency
  long-lived resolved value/service used throughout an episode

ALCODE dynamic capability
  Host-authorized invocation resolved at a tool-call boundary
```

Treating every ALCODE capability provider as if it were a long-lived coeffect would over-bind `ProgramAttempt` authority to runtime implementation topology.

The useful Cordis transfer is therefore narrower:

> A computation must not silently cross from one dependency identity to another *inside the unit whose correctness assumes that identity*.

For current ALCODE capabilities, that unit is normally the durable operation, not the entire ProgramAttempt.

If a future capability returns a provider-backed lease, transaction, stream, process handle, browser page, remote workspace, or other long-lived resource, the unit may become larger. That future contract may require a committed binding spanning the resource lifetime.

## 4. Current ALCODE source model

This study inspected the exact planning base above rather than reasoning from a hypothetical provider system.

### 4.1 Agent Protocol already models per-inference binding freshness

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

The protocol calls the tool set an `InferenceToolCatalog` and documents it as the Host-authorized tool catalog for **exactly one provider inference**.

That is already a smaller committed-view boundary:

```text
Host prepares inference
→ tool descriptor carries dynamic revision G0
→ Agent emits tool request expected G0
→ Host rejects if the current binding is no longer G0
```

This is intentionally not a ProgramAttempt-wide catalog snapshot.

### 4.2 CapabilityBroker has explicit dynamic provider generations

`CapabilityBroker` stores a dynamic registration as:

```text
providerId + revision + capability names
```

`registerDynamicProvider(providerId, revision, capabilities)`:

- requires a non-empty provider identity and revision;
- forbids reusing a retired `providerId@revision` binding;
- atomically stages a replacement generation;
- retires the previous generation;
- rejects conflicts without partially replacing the catalog.

For a dynamic tool invocation, `execute()` requires:

```text
request.expectedCapabilityRevision === registration.binding.revision
```

before policy/capability execution proceeds. The existing test suite proves stale-ABA rejection and non-reuse of a retired generation.

This establishes an important current distinction:

```text
ProgramState revision
  durable semantic state generation

Agent generation
  replaceable Agent-process generation

Dynamic capability revision
  provider/tool binding generation
```

None substitutes for another.

### 4.3 MCP already creates provider-scoped runtime generations

`HostMcpManager` gives one server a stable provider identity:

```text
mcp:<plugin-registration-id>:<server-name>
```

and mints a fresh random revision whenever its exported tool catalog is replaced.

A capability closure also captures the MCP runtime instance and checks that the runtime is still current before executing. Unexpected stdio process exit withdraws the capabilities before bounded restart. Restart revalidates exact plugin-generation trust before starting a process.

The plugin layer separately uses a content digest as the trusted plugin generation and withdraws an active digest before clearing its trusted binding.

Thus ALCODE already has at least three relevant identities:

```text
plugin generation digest
MCP providerId
MCP dynamic capability revision
```

A Phase 1 design should not collapse these into `ProgramAttemptId` or `ProgramState.revision`.

### 4.4 Durable operation state currently loses the dynamic binding

This is the important correctness gap exposed by the study.

The broker validates the dynamic revision in memory, but the canonical `operation.requested` payload currently records only:

```ts
{
  operationId,
  toolName,
  args,
  isReadOnly
}
```

The durable `OperationRecord` likewise contains tool name, args, lifecycle/outcome/effect/reconciliation state, but no dynamic provider identity or provider revision.

Therefore, after the invocation leaves the in-memory broker path, the canonical record cannot answer:

```text
Which provider incarnation was operation O admitted against?
```

That matters when Phase 1.0 wants a durable chain:

```text
ProgramState P
→ ProgramAttempt A
→ operation O
→ exact execution binding B
→ result / evidence / reconciliation
```

Without `B`, replay can preserve `O` and `A` yet still lose part of the execution provenance needed to distinguish a replaced provider from the one that actually ran.

### 4.5 Binding validation and operation admission are not one serialized cut today

The current broker reads the capability registration and checks `expectedCapabilityRevision` before policy hooks, approval, cognition matching, and canonical `operation.requested` admission.

Those steps can be asynchronous. The binding is not revalidated inside the canonical admission operation immediately before `operation.requested` is appended.

This creates a general TOCTOU shape:

```text
read current binding B
→ validate expected B
→ asynchronous policy / approval / cognition work
→ provider changes B → B'
→ operation O is admitted using the earlier captured capability
```

MCP narrows some consequences by having the captured capability closure reject when its captured runtime instance is no longer current. That is useful but not a complete canonical proof:

- the durable operation still does not record `B`;
- a catalog revision can change without necessarily changing the runtime object;
- the Host cannot reconstruct from canonical events whether operation admission and binding validity linearized on one state cut.

The Phase 1 requirement should therefore be expressed as an **admission invariant**, not merely as an Agent-supplied revision check.

## 5. Canonical ownership model

The minimal ownership split is:

```text
ProgramState
  owns durable work/verification/completion truth

ProgramAttempt
  owns bounded current work authority

CapabilityBroker / Host capability layer
  owns current binding resolution

Operation
  owns the exact execution binding chosen for that invocation

Provider runtime
  executes under that binding
```

Other domains may reference these identities but should not duplicate their authority.

A conceptual operation-correlation shape is:

```text
OperationExecutionBinding {
  capabilityName
  bindingKind
  providerId?       // Host-only provider identity where dynamic
  providerRevision? // exact dynamic generation
}
```

Names and schema placement are deliberately unresolved. The requirement is semantic: exact, mechanically lossless execution provenance must be canonical before a provider-dependent external effect is trusted.

For static capabilities, a stable static binding marker may be sufficient. For dynamic capabilities, revision alone may be sufficient for Agent-side ABA rejection, but Host recovery/provenance may additionally require the Host-internal provider identity.

## 6. Why `expectedProgramRevision` is insufficient

A provider can restart or publish a new capability generation without any ProgramState mutation.

Example:

```text
ProgramState revision = R17
Attempt A current at R17
MCP provider generation = G0
→ provider restarts
MCP provider generation = G1
ProgramState revision still = R17
```

Both of the following can be true:

```text
expectedProgramRevision == currentProgramRevision
expectedCapabilityRevision != currentCapabilityRevision
```

ProgramState validity and capability-binding validity are orthogonal dimensions.

Likewise, replacing the Agent changes `AgentGenerationId` without necessarily changing either ProgramState or the capability provider.

Phase 1 should retain all three checks at their proper boundaries rather than encoding one generation into another.

## 7. Event-history probes

The following histories test the candidate designs.

### H1 — provider changes before the first capability invocation

```text
Attempt A admitted at ProgramState R17
→ no capability has yet been invoked
→ provider P changes G0 → G1
→ A requests capability C under the current Host catalog
```

Whole-attempt snapshot result:

```text
A must interrupt solely because P changed
```

Invocation-scoped result:

```text
if A remains current and policy authorizes C
→ Host may resolve C to G1
→ operation O records G1
```

**Finding:** no existing Phase 1 guarantee is violated by the invocation-scoped result. Whole-attempt interruption is unnecessary here.

### H2 — unrelated provider changes

```text
Attempt A uses provider P
→ unrelated provider Q changes Q0 → Q1
```

**Required result:** A does not become stale merely because unrelated runtime topology changed.

A global provider/catalog snapshot attached to the ProgramAttempt would create unnecessary invalidation.

### H3 — stale Agent inference requests old dynamic generation

```text
Host supplies capability C@G0 for inference I
→ provider changes G0 → G1
→ Agent emits tool request expected G0
```

**Required result:** reject before execution as stale.

Current dynamic capability semantics already intend this result.

### H4 — provider changes after revision check but before canonical operation admission

```text
Host reads C@G0
→ request expected G0 passes
→ policy/approval/cognition await
→ provider changes G0 → G1
→ Host reaches operation admission
```

**Required result:** O cannot be admitted as though binding freshness were still proven at the operation boundary.

The Host must either revalidate G0 at the linearization point or admit an exact G0 execution binding under a mechanism that proves G0 remains executable for O.

This is the strongest current counterexample.

### H5 — operation admitted against G0, provider changes before result

```text
Attempt A current
→ O canonically admitted against G0
→ O starts
→ provider catalog becomes G1
→ O returns
```

**Required result:** O's result remains a result of G0. It is not converted to G1 provenance.

Whether O is allowed to finish is provider-specific; the durable identity is not.

### H6 — late result from superseded ProgramAttempt

```text
A → O@G0 starts
→ A interrupted
→ B becomes current
→ provider becomes G1
→ O@G0 returns late
```

**Required result:** canonical history may record O's terminal state under A/G0, but it cannot become current ProgramState evidence merely because B or G1 is now current.

This composes stale-attempt admission with exact operation binding.

### H7 — Host crashes with O@G0 requested/started

```text
A → O@G0 requested/started
→ Host crashes
→ provider process disappears
→ Host reopens and provider is now G1
```

**Required result:** recovery preserves O as interrupted/indeterminate according to operation semantics and retains that O targeted G0. Reconciliation must not silently reinterpret O as a G1 operation.

This is where canonical provider binding materially supports Phase 1 uncertainty correctness.

### H8 — identical provider behavior, different generation

```text
G0 and G1 expose byte-identical schemas and produce equivalent results
```

**Required result:** they remain distinct execution bindings for authority/provenance purposes.

Observational equivalence can justify behavior-level reasoning; it must not erase exact Host execution identity.

### H9 — same ProgramAttempt invokes old then new generation in separate operations

```text
A current at R17
→ O1 admitted/executed under G0
→ G0 replaced by G1
→ A remains semantically current at R17
→ new inference/catalog exposes G1
→ O2 admitted/executed under G1
```

**Finding:** this can be correct when A's authority is capability-level rather than provider-instance-level. Canonical history remains unambiguous because O1 binds G0 and O2 binds G1.

Therefore `G0 → G1` does not inherently require a new ProgramAttempt.

### H10 — long-lived provider-backed resource

```text
A invokes capability under G0
→ receives handle H whose validity depends on G0
→ provider changes to G1
→ A uses H again
```

**Required future result:** invocation-scoped rebinding alone is insufficient. H requires an explicit resource/binding lifetime whose provider cannot be silently changed.

**Finding:** this justifies accommodating a future committed-dependency mechanism without imposing one on all Phase 1 capability calls.

### H11 — replacement Agent with same current ProgramAttempt

```text
Attempt A current
→ Agent generation X dies before invoking capability
→ Agent generation Y resumes current Host state
→ provider changed meanwhile G0 → G1
```

**Required result:** Y cannot reuse X's stale inference/tool binding. It receives current Host-authorized structured context/catalog and any new invocation is admitted against its exact current binding.

Whether A itself remains current depends on Phase 1 Agent-generation ownership rules; provider identity does not substitute for that check.

### H12 — verification pending across provider replacement

```text
verification operation O@G0 is admitted
→ G0 replaced by G1
→ O@G0 evidence arrives
```

**Required result:** evidence provenance remains O@G0. Verification freshness remains governed by ProgramState's verification subject generation, not by an automatic rule that every provider replacement invalidates every verification.

A verification predicate may explicitly require a provider/profile identity in the future; absent such a predicate, provider replacement alone is not a ProgramState subject mutation.

### H13 — unexpected MCP process exit and restart

```text
MCP G0 process exits
→ current capabilities withdrawn
→ bounded restart
→ new runtime/catalog generation G1
```

**Required result:** calls expecting G0 reject as stale; new calls may use G1 after Host admission. Any operation already durably associated with G0 stays G0-associated through recovery/evidence handling.

### H14 — same canonical log, same rebuild

```text
canonical events contain:
Attempt A
O1@G0 requested/started/completed
O2@G1 requested/started/completed
```

**Required result:** deleting/rebuilding projections reproduces the distinction between O1/G0 and O2/G1 without consulting current live provider state.

That is not possible if provider binding exists only in the in-memory broker.

## 8. Competing designs

### Design A — ProgramAttempt-wide immutable provider snapshot

```text
program.attempt.started
→ snapshot every usable capability/provider binding
→ any relevant or unrelated catalog change invalidates snapshot
```

Advantages:

- close to Cordis committed-view semantics;
- strong resolution coherence;
- simple statement: one attempt, one execution world.

Costs/problems:

- over-binds ProgramAttempt authority to implementation topology;
- unrelated provider changes can interrupt useful work;
- does not match the existing per-inference/per-tool Agent Protocol boundary;
- turns dynamic capability refresh into ProgramState attempt churn;
- creates a much larger durable snapshot and invalidation problem;
- moves toward general runtime-component composition, which Phase 1 does not otherwise require.

**Decision:** defer.

### Design B — current per-request revision check only

```text
Agent request carries expected dynamic revision
→ in-memory broker compares before execution
```

Advantages:

- already implemented;
- lightweight ABA rejection;
- supports dynamic provider refresh.

Problems:

- exact binding is lost from durable operation provenance;
- binding check can precede asynchronous work and canonical operation admission;
- replay cannot reconstruct exact provider incarnation from canonical state;
- uncertainty/reconciliation cannot mechanically distinguish old/new provider generations from the operation record alone.

**Decision:** insufficient for Phase 1 ProgramAttempt-linked durable operations.

### Design C — invocation-scoped canonical execution binding

```text
A current
→ Host resolves C to B
→ binding validity and operation admission linearize together
→ operation O durably records B + A correlation
→ execution/result/reconciliation remain tied to O/B
→ later call may resolve B' if A remains current
```

Advantages:

- closes the durable provenance and replay hole;
- composes with current Agent Protocol dynamic binding;
- preserves dynamic provider refresh;
- avoids unrelated ProgramAttempt invalidation;
- aligns exact identity with the operation that actually executes;
- naturally composes with existing uncertainty/reconciliation semantics.

**Decision:** promote as the minimum semantic requirement.

## 9. Resolution coherence in ALCODE-native terms

The Cordis-inspired property should be stated at the right ALCODE boundary:

> An admitted capability operation must not straddle two execution bindings.

Not:

> A ProgramAttempt may never observe two provider generations.

For one operation:

```text
operation O admitted under B
→ B is immutable provenance of O
→ no Host path rebinds O to B'
```

For one ProgramAttempt:

```text
Attempt A
  ├─ O1 under B0
  └─ O2 under B1
```

may be valid when both operations were independently admitted while A remained current.

The durable chain is then exact without forcing an artificial single-provider world:

```text
ProgramState P / revision R
→ ProgramAttempt A
→ operation O1 / binding B0
→ canonical evidence E1

ProgramState P / revision R
→ ProgramAttempt A
→ operation O2 / binding B1
→ canonical evidence E2
```

## 10. Provider withdrawal

Current plugin/MCP code already contains useful narrow lifecycle discipline:

```text
plugin generation withdrawn
→ dynamic capabilities disposed
→ runtime closed
```

and unexpected MCP exit:

```text
process exits
→ capabilities disposed
→ runtime cleared
→ bounded restart
→ process-start trust revalidated
→ new dynamic capability revision minted
```

This is sufficient as a provider-local implementation pattern for the current study.

Phase 1 does not need to generalize it into a Cordis-style dependency graph across all Host components.

One future exception is active provider-backed resources. If ALCODE later exposes handles whose teardown/use requires the old provider, provider withdrawal must gain a quiescence protocol resembling:

```text
withdraw new admission
→ retain old binding for admitted dependents
→ dependent teardown/quiescence
→ dispose provider generation
```

That is explicitly outside this Phase 1 validation decision.

## 11. Interaction with Phase 1.0 acceptance areas

This study changes no acceptance criteria by itself. If the governing plan is later amended, the minimum semantic change belongs primarily under the existing **AC-10-06 — Effect uncertainty and durable attempt correlation**, not in a new capability-resolution AC family.

The required negative proofs would be variations of:

```text
Attempt A → O@G0
→ provider becomes G1
→ A superseded or Host crashes
→ late/recovered O remains correlated to A/G0
→ no reassignment to current Attempt/Provider
```

and:

```text
G0 validated
→ asynchronous admission work
→ provider becomes G1 before operation admission
→ O cannot cross the binding change without revalidation / exact preserved binding authority
```

AC-10-04 continues to own ProgramAttempt/ProgramState/Agent-generation freshness. AC-10-07 continues to own verification subject freshness. The capability execution binding is a third identity dimension feeding those domains as provenance.

## 12. What should not be promoted from this study

Do not add the following to Phase 1 solely because of this analysis:

- `capabilityBindings[]` snapshot on every `ProgramAttempt`;
- automatic ProgramAttempt interruption on every provider/catalog change;
- global Host component dependency DAG;
- generic component fibers or Cordis contexts;
- arbitrary reversible-effect accumulation;
- HMR transaction machinery;
- provider quiescence across arbitrary Host services;
- observational equivalence as ProgramState identity;
- a second ProgramState freshness mechanism based on provider generations.

## 13. Provisional terminology

To avoid conflating existing generations, use distinct terms in subsequent planning:

- **ProgramState revision** — exact current durable ProgramState generation;
- **ProgramAttemptId** — current dispatch/claim generation for one work item;
- **AgentGenerationId** — replaceable Agent process identity;
- **capability binding revision** — exact dynamic capability/provider generation presented for invocation;
- **plugin generation digest** — content-addressed trusted plugin package generation;
- **operation execution binding** — canonical provenance naming the exact capability binding admitted for one operation.

The final type names and schema remain open.

## 14. Promotion decision

The validation result is:

```text
PROMOTE
  exact invocation-scoped execution binding for ProgramAttempt-linked operations
  + immutable operation→binding provenance
  + binding validity at the operation admission/linearization boundary

ACCOMMODATE
  future longer-lived committed binding for provider-backed resources

DEFER
  whole-ProgramAttempt provider snapshot
  + dependency-ordered general provider withdrawal
  + dynamic Host-component composition/HMR
```

The reason is structural:

> Phase 1.0 already promises durable attempt correlation and correct uncertainty/reconciliation. Those promises are incomplete if a provider-dependent operation cannot be replayed as targeting the exact provider generation that the Host admitted. They do not, however, require every capability invocation in one ProgramAttempt to use the same provider generation.

## 15. Consequence for later planning

A later explicit planning amendment should consider only the promoted minimum:

1. require exact execution-binding provenance for provider-dependent ProgramAttempt operations;
2. make binding validity and operation admission one revalidated/serialized semantic cut;
3. preserve binding identity through result, evidence, crash recovery, and reconciliation;
4. add stale/replacement negative proofs to AC-10-06;
5. leave ProgramAttempt-wide committed provider views and general runtime composition outside the Phase 1 implementation slice.

This document does **not** make that governing-plan amendment, does not approve Phase 1.0, and does not authorize implementation.
