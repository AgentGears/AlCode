# ALCODE S-02 — ProgramAttempt-Aware Local Orchestration Plan

**Status:** **FROZEN — S-02 implementation authorized within this exact contract after the P-02 predecessor lands.**  
**Freeze date:** 2026-09-08.  
**Reviewed predecessor head:** `feat/p02-semantic-planning-v1@154d385fed136d921e64ad623a27c921ef14836b`.  
**Predecessor integration:** PR #310 is open/unmerged at freeze time; S-02 production implementation must start from `main` containing the accepted P-02 stack, or from a mechanically equivalent restack whose diff is reviewed against that landed baseline.  
**Objective:** reduce model↔tool round trips by allowing bounded model-authored local orchestration over the exact Host-authorized inference capability snapshot without changing ProgramState, ProgramAttempt, Operation/effect, verification, recovery, or Completion authority.

This document is the frozen implementation contract for the first S-02 slice. It adopts the architectural pattern described by APR-016 and APR-017 only in the bounded form defined here. It does not authorize subagents, remote workspaces, model-authored Host code, arbitrary local process access, code-only provider presentation, or a second execution authority.

The first slice is deliberately narrow: **Code Mode is an Agent-local execution transport over existing Host-mediated capability proxies.** The local program owns control flow only. Environmental authority remains exactly where it is today.

---

## 0. Frozen decisions

The following decisions are normative for S-02 v1.

1. **Local orchestration is transport, not authority.** A model-written program may branch, loop, aggregate, and issue sub-dispatches, but every environmental sub-dispatch must traverse the exact inference-scoped proxy tool that would have been used by a direct model tool call.
2. **S-02 v1 is ProgramAttemptAuthorityV2-only.** `run_code` is offered only while the Host has projected an executable V2 ProgramAttempt and the connected Agent generation negotiated S-02 support. Fixed-topology/V1 and non-Program inference behavior remain unchanged.
3. **The Host authorizes provider visibility.** `run_code` must be present in the Host-owned inference tool catalog and therefore in the exact provider-visible definition digest. The Agent may not add an undisclosed local tool after the Host context cut.
4. **`run_code` is not a capability grant.** It is not added to `WorkAuthorityEnvelope.capabilityCeiling`, does not mint permission, and does not bypass policy. Only the underlying Host capability descriptors determine executable authority.
5. **The exact inference snapshot is the SDK.** The local worker can invoke only the ordinary tools authorized for the same inference cut. It cannot discover, refresh, register, or resolve additional tools by itself.
6. **`run_code` is not exposed inside its own SDK.** Nested Code Mode is forbidden in v1.
7. **Every sub-dispatch carries the same captured ProgramAttemptAuthorityV2 and the same captured dynamic binding revision, where applicable, as the direct proxy tool for that inference.** Authority is rechecked by the Host on every sub-dispatch.
8. **Stale authority stops future dispatch, not historical truth.** Once an Attempt becomes stale, every not-yet-admitted sub-dispatch fails closed. Already-admitted Operations remain independent Host-owned environmental truth and may settle normally.
9. **Mutating sub-dispatches remain distinct Operations.** A single `run_code` call may never collapse several mutating effects into one aggregate Operation/effect record.
10. **Fresh isolated local runtime per `run_code`.** No globals, heap objects, SDK objects, pending promises, or local variables survive into a later local program, Agent run, Agent generation, or ProgramAttempt.
11. **No ambient environmental API.** The embedded local runtime exposes no Node.js module loader, filesystem, child-process, socket/network, environment-variable, workspace, storage, Host-runtime, raw protocol, or direct repository API. Environmental access exists only through the mediated tool bridge.
12. **Containment is not terminal authority.** Worker isolation and resource limits protect liveness and reduce accidental ambient access; they do not replace Host policy, ProgramAttempt currentness, Operation truth, reconciliation, or verification.
13. **Issued Host calls drain before the local tool settles.** Cancellation, timeout, worker failure, or authority loss stops new sub-dispatch admission and terminates local computation, but already-issued Host capability requests are allowed to reach their bounded terminal responses before `run_code` itself finishes.
14. **Direct tool mode remains available.** S-02 v1 is hybrid presentation: the model sees the ordinary Host-authorized tools plus `run_code`. Hiding direct tools or requiring code-only presentation is explicitly deferred.
15. **The result of local code is advisory transcript data only.** Returning `{success:true}`, an `operationId`, a verifier-shaped object, or a completion-shaped object cannot create evidence, satisfy verification, mutate ProgramState, or complete the Program.
16. **No new durable Code Mode state object.** S-02 v1 adds no canonical `CodeProgram`, VM checkpoint, local-program resume log, or cross-session local code state. Durable truth remains the existing transcript plus underlying Host Operation/Program events.
17. **No performance SLO is a correctness gate.** The structural product proof must demonstrate fewer provider round trips for a multi-tool sequence; no latency/token percentage target is frozen.

---

## 1. Current architecture seam

The current product already contains the exact seam S-02 should use rather than bypass.

For every provider inference, `agent-worker.ts` refreshes Host context, validates the requested ProgramAttempt, creates an `InferenceCapabilityProjection`, and passes only that projection's `AgentTool[]` into the model loop. `createInferenceCapabilityProjection(...)` builds protocol proxy tools from the exact Host-supplied `InferenceToolCatalog`, captures the current ProgramAttempt authority, captures each dynamic capability revision, and owns every capability request under an inference scope.

The S-02 insertion point is therefore:

```text
Host current context cut
        ↓
Host-authorized InferenceToolCatalog
        ↓
InferenceCapabilityProjection
        ├── ordinary protocol proxy tools
        └── Host-authorized local `run_code` transport
                    ↓
              fresh local VM
                    ↓
          exact captured proxy tools
                    ↓
              capability.request
                    ↓
      ProgramAttemptAuthorityV2 recheck
                    ↓
            CapabilityBroker
                    ↓
       ordinary Operation/effect truth
```

S-02 must not introduce a second path from the local worker to `AgentProtocolClient.requestCapability`, Host services, filesystem APIs, or the workspace. The worker calls only an Agent-owned bridge that dispatches through the same proxy tool objects created for the exact inference.

---

## 2. Provider-visible contract

### 2.1 Negotiated Agent capability

Add one Agent protocol capability:

```text
local_orchestration_v1
```

A Host must not advertise `run_code` unless the current Agent generation advertised this capability.

The base Agent protocol version remains unchanged. This is capability-gated additive behavior.

### 2.2 Agent-local binding kind

Extend the inference descriptor binding taxonomy with one closed built-in form:

```ts
{ kind: "agent_local_code_mode_v1" }
```

This is not an extensible plugin registry. No arbitrary handler name is accepted. Only the built-in `run_code` definition may use this binding in S-02 v1.

The Host remains the producer of the complete `InferenceToolCatalog`. The catalog digest continues to cover the canonical provider-visible definition array, so the provider-visible `run_code` definition is part of the same Host-owned inference receipt as every direct tool definition.

### 2.3 Tool definition

The frozen provider-facing tool name is:

```text
run_code
```

Input:

```ts
interface RunCodeInputV1 {
  code: string;
}
```

No model-selectable timeout, memory, concurrency, capability list, environment, module list, or working-directory field exists in v1.

The tool description tells the model that the program executes in a fresh bounded JavaScript runtime and may call the same direct tools visible in the current inference through a generated `tools` object. The ordinary direct tool definitions remain visible and define the argument schemas.

The worker SDK shape is conceptually:

```ts
await tools.read_workspace_text({ ... })
await tools.edit({ ... })
await tools.bash({ ... })

// tool names that are not valid JavaScript identifiers remain available by key:
await tools["provider.tool-name"]({ ... })
```

The implementation may generate wrappers dynamically, but it may not generate new authority. A wrapper exists only for an exact descriptor already present in the Host-authorized inference snapshot. `run_code` itself is excluded.

### 2.4 Final local result

A local program returns one JSON-safe value. The Agent tool renders a bounded deterministic representation for the ordinary tool-result transcript. The result does not become Program evidence unless a separate existing Host mechanism admits evidence from an underlying Operation.

---

## 3. Local runtime and containment

Create a dedicated Agent-side package, conceptually `@alcode/code-mode`, with no dependency on `@alcode/host-runtime`, storage, workspace mutation services, Program reducers, or the raw Agent protocol transport.

The package owns only:

- fresh local VM lifecycle;
- source validation/transformation required by the selected embedded JavaScript runtime;
- bounded worker↔Agent messages;
- the mediated tool-call bridge;
- resource accounting;
- cancellation/termination;
- deterministic result/error projection.

The preferred implementation is an embedded JavaScript runtime with no Node/OS host bindings, hosted inside a fresh Agent-owned Worker for each `run_code`. A different implementation is acceptable only if it proves the same frozen ambient-access contract: local code cannot reach filesystem/process/network/environment/module-loading APIs except through the explicit mediated tool bridge.

The worker may expose standard language computation facilities, JSON, collections, promises, and timers required for orchestration. It must not expose raw `process`, `require`, Node `import`, filesystem, sockets, subprocesses, `fetch`, storage handles, workspace handles, Host objects, or the Agent protocol transport.

No claim that the worker is a general hostile-code security sandbox is required. The correctness boundary is narrower and testable: **the worker has no environmental authority path other than the mediated tool bridge.**

---

## 4. Frozen S-02 v1 limits

These are ALCODE-selected first-slice limits. They are product design choices, not values inherited from an external implementation.

```text
source bytes                                  32 KiB
local VM heap                                 64 MiB
local VM stack                                 1 MiB
active local compute                           5 s
orchestration wall time                      120 s
maximum tool calls per local program            16
maximum concurrently admitted/awaited calls      4
per-tool input projection                     64 KiB
per-tool result projection                   256 KiB
final local result                           256 KiB
bounded local diagnostic/error text           32 KiB
nested run_code calls                              0
```

Definitions:

- **active local compute** counts local VM execution time and excludes time spent awaiting Host capability responses;
- **orchestration wall time** bounds the period in which the local program may schedule new work;
- when wall/compute/call limits expire, no new tool sub-dispatch may be admitted;
- already-issued Host capability requests drain under their own existing bounded Operation/capability contracts even if that drain extends beyond the local orchestration wall budget;
- concurrency above four is locally queued, not silently executed beyond the bound; total calls above sixteen fail deterministically;
- oversized source/input/final-result values fail before the relevant action; oversized tool-result projection fails that local subcall rather than fabricating a partial successful value;
- no retry loop may reset these counters inside one `run_code` invocation.

A future numeric change is a contract change and requires explicit review; implementation convenience is not sufficient reason to enlarge the bounds.

---

## 5. Authority and dispatch semantics

### 5.1 Exact inference snapshot

At one inference cut the Agent receives an exact `InferenceToolCatalog` and current ProgramAttempt projection. The projection creates the ordinary proxy tools exactly as today.

For the `run_code` descriptor, the projection creates an Agent-local tool that captures:

- the exact peer proxy-tool array for that inference;
- the exact ProgramAttemptAuthorityV2 already embedded by those proxy tools;
- each dynamic capability binding revision already embedded by those proxy tools;
- the inference scope's AbortSignal/lifecycle;
- the root provider `toolCallId` for local correlation.

The worker receives none of those authority objects directly. It receives only tool names/schema-facing metadata and a bounded call bridge.

### 5.2 Sub-dispatch identity

Every worker tool call receives a monotonically allocated local `subcallIndex` and a unique provider/tool-call correlation ID derived or generated under the outer `run_code` call. The exact string format is implementation detail, but uniqueness within the Agent generation/inference is mandatory.

Each environmental sub-dispatch executes the captured peer `AgentTool.execute(...)` and therefore emits an ordinary `capability.request`. The Host remains responsible for minting the canonical Operation ID.

The outer `run_code` tool call is not a substitute environmental Operation. It is local orchestration transcript activity. Environmental truth is the set of underlying Host Operations.

### 5.3 Stale ProgramAttempt

If the Host retires/replaces the ProgramAttempt while local code is running:

```text
subcall already Host-admitted
        → keeps its Operation/effect/quiescence truth

subcall not yet Host-admitted
        → fails closed on currentness check

queued future subcall
        → is never sent after authority loss is known
```

After the first `stale` ProgramAttempt result, the local bridge marks the orchestration authority-lost and rejects every later/queued subcall without attempting a new capability request.

The local worker cannot request a fresh ProgramAttempt, refresh the tool catalog, or continue under replacement authority. A fresh ProgramAttempt requires a fresh Host execution directive/inference path.

### 5.4 Dynamic capability retirement

If a dynamic capability revision changes after the inference cut, the existing expected-capability-revision check remains authoritative. A stale dynamic binding fails that subcall. Code Mode may not refresh it inside the same local program.

### 5.5 Permission and policy

Each sub-dispatch goes through ordinary Host capability admission and permission handling. `run_code` grants no aggregate permission and cannot pre-authorize its child calls.

---

## 6. Cancellation, failure, and drain

On Agent-run cancellation, local compute timeout, orchestration wall timeout, source/runtime error, worker crash, or authority loss:

1. stop accepting/scheduling new local subcalls;
2. signal/terminate the local VM computation;
3. retain references to every Host capability request already issued;
4. await those issued requests to their bounded response/terminal outcome;
5. settle the outer `run_code` Agent tool result with a bounded deterministic error/result summary;
6. dispose the inference scope normally.

If the entire Agent process is terminated, the local worker dies with it. Already-admitted Host Operations remain Host-owned and are recovered/reconciled by the existing runtime. No local VM state is reconstructed in the replacement Agent.

S-02 must not reinterpret Agent loss as proof that an admitted Operation had no effect.

---

## 7. Transcript and epistemic rules

The durable transcript may record:

- the model's `run_code` tool call;
- the bounded `run_code` result/error;
- ordinary underlying capability tool-result messages/events according to the existing protocol path where those are already durable.

The local program's return value is not a source of canonical ProgramState, verifier success, mutation absence, Operation completion, execution-base identity, or Completion Oracle truth.

A local program may aggregate ordinary observations for the model, but freshness/completeness semantics remain those of the underlying Host results. Aggregation cannot convert incomplete observation into authoritative absence.

---

## 8. Explicit exclusions

S-02 v1 does **not** authorize or require:

- code-only provider presentation or hiding direct tools;
- Python, shell, native-code, WASM guest programs, or arbitrary package imports;
- Node.js `fs`, `child_process`, network, environment, workspace, storage, Git, or Host API access from local code;
- persistent/reusable local VM state;
- checkpoint/resume of a local program after Agent replacement;
- local-program-generated capability registration;
- plugin-defined Agent-local code handlers;
- capability discovery/refresh from inside local code;
- model-written Host/runtime extensions;
- dynamic Host plugin loading;
- subagents, child Sessions, or multi-Agent execution;
- parallel same-Workspace ProgramAttempts;
- remote workspaces/SSH/VM execution;
- durable Inference Epoch;
- model-as-judge verification or completion;
- a new verification DSL;
- a new ProgramState transition emitted directly from code;
- automatic semantic Program revision from code;
- browser automation;
- performance benchmark thresholds as closure gates.

---

## 9. Frozen acceptance criteria

### AC-S02-01 — Host-authorized provider visibility

When `local_orchestration_v1` is negotiated and an executable ProgramAttemptAuthorityV2 is current, the Host-owned inference catalog includes exactly one `run_code` descriptor whose provider-visible definition participates in the catalog digest. Without negotiated support or without executable V2 ProgramAttempt authority, `run_code` is absent.

### AC-S02-02 — No ambient environmental authority

A local program cannot directly access Node/module loading, process/environment, filesystem, child processes, sockets/network, workspace/storage, raw Agent protocol, or Host-runtime objects. Attempts fail locally and create no Host Operation.

### AC-S02-03 — Exact snapshot SDK

The worker SDK contains only the ordinary Host-authorized peer tools from the exact inference catalog, excluding `run_code`. A requested name outside that snapshot fails locally and emits no capability request.

### AC-S02-04 — Per-subdispatch ProgramAttempt fencing

Every environmental sub-dispatch executes through the exact inference proxy tool carrying the captured ProgramAttemptAuthorityV2 and any expected dynamic capability revision. No local bridge path may construct a weaker or authority-free capability request.

### AC-S02-05 — Stale Attempt fails future work closed

If the active ProgramAttempt is invalidated/replaced after local execution begins, every not-yet-admitted later/queued sub-dispatch fails closed and no new Host Operation is admitted under the stale Attempt.

### AC-S02-06 — Already-admitted Operation truth survives

If ProgramAttempt invalidation races an already-admitted mutating sub-dispatch, that Operation remains independently terminal/reconcilable under existing Host semantics. The local program cannot cancel, erase, reinterpret, or duplicate it merely because its Attempt became stale.

### AC-S02-07 — Distinct mutation/effect identity

Two mutating sub-dispatches issued from one `run_code` invocation produce two distinct Host Operation identities and preserve their independent effect/quiescence/evidence truth. No aggregate Code Mode operation substitutes for them.

### AC-S02-08 — Resource limits are deterministic

Source, heap, stack, compute, wall, tool-call count, concurrency, per-call input/result, final-result, diagnostics, and no-nesting limits are enforced exactly as frozen in Section 4. Bound failure stops new work without inventing environmental absence.

### AC-S02-09 — Cancellation and drain

Cancellation/timeout/runtime failure stops new local sub-dispatch, terminates local computation, drains already-issued Host capability requests, and leaves no live local worker after `run_code` settlement or Agent-run disposal.

### AC-S02-10 — Disposable lifecycle

Two sequential `run_code` calls cannot observe one another's VM globals/state. Agent replacement and fresh ProgramAttempt execution cannot inherit local VM state or pending local control flow from the dead generation.

### AC-S02-11 — Backward compatibility

An Agent without `local_orchestration_v1`, a fixed-topology/V1 Program path, and non-Program execution retain the current direct-tool behavior and protocol semantics. Existing direct proxy tools and Host capability admission remain unchanged.

### AC-S02-12 — No fabricated authority from return values

A local program that returns forged success/evidence/operation/completion-shaped data cannot satisfy a verifier, create Program evidence, advance ProgramState, alter execution-base identity, or satisfy Completion Oracle conditions without the existing Host-owned events that independently prove those facts.

### AC-S02-13 — Product round-trip proof

A deterministic Program-backed product scenario completes a useful coding sequence in which one provider inference emits one `run_code` call and the local program performs at least three mediated Host capability sub-dispatches, including at least one read and one mutation, without another provider inference between those sub-dispatches. The Program then proceeds through the existing Host-owned verification/completion path.

The proof is structural: it demonstrates local deterministic orchestration replaces multiple model↔tool turns. No latency/token percentage is required.

### AC-S02-14 — Exact-head closure gate

The exact candidate head passes the S-02 gate, the existing product-agent predecessor gate, the focused Agent protocol/runtime tests, and the S-02 adversarial scenarios below. The gate emits the repository's normal machine-readable receipt where applicable.

---

## 10. Required adversarial scenarios

The following scenarios are frozen gate scenarios.

### Scenario A — no current ProgramAttempt

Request ordinary/non-Program inference or an adaptive session with no executable V2 Attempt. `run_code` is not provider-visible.

### Scenario B — unsupported Agent generation

Attach an Agent generation without `local_orchestration_v1`. The Host does not advertise `run_code`; direct tools remain unchanged.

### Scenario C — tool outside exact snapshot

Local code calls an unadvertised tool name. The bridge rejects locally and the Host sees no `capability.request` for that name.

### Scenario D — dynamic binding replaced mid-program

A dynamic capability is retired/replaced after the inference cut. A later local subcall using the captured revision receives stale binding semantics and is not rebound automatically.

### Scenario E — Attempt replaced between subcalls

Subcall 1 settles, the Host retires/replaces the Attempt, then local code tries subcall 2. Subcall 2 fails stale; no successor authority is inherited.

### Scenario F — Attempt invalidated during admitted mutation

A mutating subcall is already admitted when the Attempt is invalidated. Its Operation settles independently; a later queued subcall is not admitted.

### Scenario G — multiple mutations under one local program

One `run_code` performs two distinct mutations. Durable trace proves two Operation IDs and distinct effect/quiescence truth.

### Scenario H — concurrency pressure

Local code requests more than four concurrent tools. At most four are in-flight; excess calls queue under the same total-call budget. No fifth concurrent Host request is observed.

### Scenario I — call-count exhaustion

Local code attempts a seventeenth tool call. The seventeenth fails deterministically without a Host request; the first sixteen retain their independent outcomes.

### Scenario J — infinite/compute-heavy loop

Local code never yields or exceeds active-compute budget. The VM is interrupted/terminated within the frozen bound, no new subcalls are admitted afterward, and no worker remains live.

### Scenario K — oversized source/input/result

Exercise source >32 KiB, one subcall input >64 KiB, one projected subcall result >256 KiB, and final result >256 KiB. Each boundary fails at the correct layer without silently treating partial data as successful complete data.

### Scenario L — ambient API escape attempts

Attempt `process`, environment access, filesystem/module import, child process, network/fetch, and raw protocol access. All fail without creating environmental effects or Host Operations.

### Scenario M — cancellation with in-flight calls

Cancel the Agent run while one or more Host calls are issued. New calls stop, local compute terminates, issued requests drain to bounded responses, and inference-scope disposal completes without leaked worker state.

### Scenario N — Agent replacement mid-cell

Kill/replace the Agent generation during Code Mode. The local worker does not survive/reappear. Already-admitted Host Operations preserve normal recovery truth. A fresh Agent/Attempt receives no local VM state from the dead generation.

### Scenario O — recursive Code Mode attempt

Local code tries to call `run_code`. The name is absent from the worker SDK and no nested worker is created.

### Scenario P — fabricated verifier/completion return

Local code returns objects shaped like successful evidence, Operation completion, verification success, and Program completion without underlying Host facts. Program verification/completion remain unchanged.

### Scenario Q — direct-mode compatibility

Run the predecessor deterministic product path without selecting `run_code`. Behavior remains valid and existing direct-tool product assertions pass.

---

## 11. Implementation dependency order and PR slicing

The following semantic dependency order is frozen. PR numbers may vary, but later slices may not bypass earlier authority contracts.

### PR S02-1 — protocol/catalog contract only

Scope:

- add `local_orchestration_v1` negotiated Agent capability;
- add the closed `agent_local_code_mode_v1` binding kind;
- define the canonical `run_code` tool definition and S-02 constants/types;
- Host catalog rules for when `run_code` may be advertised;
- validators/compatibility tests proving old Agents and non-V2 paths are unchanged.

No local code execution is enabled in this PR.

### PR S02-2 — isolated local runtime package

Scope:

- add `@alcode/code-mode` Agent-side package;
- fresh embedded-JS runtime + fresh worker lifecycle per invocation;
- no ambient Node/OS/Host APIs;
- bounded bridge message schema;
- frozen resource limits;
- deterministic cancellation/timeout/worker-crash behavior;
- unit tests for limits, no state bleed, no nesting, and ambient-access failures using a fake dispatch callback.

This package owns no ProgramAttempt or Host semantics.

### PR S02-3 — inference projection integration

Scope:

- make `InferenceCapabilityProjection` interpret the Host-authorized `run_code` descriptor locally;
- capture exact peer proxy tools for that inference;
- exclude `run_code` from the worker SDK;
- route every worker call through the captured peer `AgentTool.execute(...)`;
- preserve captured ProgramAttemptAuthorityV2 and dynamic binding revisions automatically through those proxies;
- enforce unique subcall identities and concurrency/call-count bounds;
- drain issued requests before local-tool settlement.

No new direct AgentProtocolClient capability-construction path is allowed.

### PR S02-4 — authority/effect adversarial proof

Scope:

- stale Attempt between subcalls;
- invalidation during admitted mutation;
- dynamic binding retirement;
- multiple mutating Operations/effect truth;
- cancellation/drain;
- Agent replacement mid-cell;
- forged-return non-authority tests.

If these tests reveal a defect in existing Host Operation/Program semantics, only the smallest correction required by the frozen AC may be added. No adjacent roadmap feature is authorized.

### PR S02-5 — product integration and closure

Scope:

- deterministic multi-subdispatch product vertical satisfying AC-S02-13;
- exact `gate:s02-code-mode` composition;
- include `gate:product-agent` predecessor proof;
- as-built documentation mapping AC-S02-01..14 and Scenarios A..Q to exact tests/files;
- remove temporary implementation diagnostics before closure.

Implementation should stop when the frozen S-02 criteria pass.

---

## 12. Gate composition

Add one bounded gate entry point:

```text
pnpm gate:s02-code-mode
```

It must compose the minimum proof necessary for the frozen contract:

1. protocol capability/binding compatibility;
2. local runtime containment/resource tests;
3. exact inference-snapshot SDK tests;
4. ProgramAttempt stale/currentness tests;
5. distinct Operation/effect truth tests;
6. cancellation/drain and Agent-replacement tests;
7. required Scenarios A..Q;
8. AC-S02-13 product vertical;
9. existing `pnpm gate:product-agent` predecessor gate.

The S-02 gate must not become a generic full-repository benchmark/audit harness. Existing unrelated phase gates remain independent repository CI unless a concrete failure proves direct relevance to a frozen S-02 criterion.

---

## 13. Closure definition

S-02 is complete when all of the following are true on one exact candidate head:

1. AC-S02-01 through AC-S02-14 pass;
2. Scenarios A through Q pass;
3. `pnpm gate:s02-code-mode` passes;
4. `pnpm gate:product-agent` passes on the same candidate head;
5. the deterministic product trace proves one provider inference can execute the required multi-tool sequence through local orchestration while every environmental call still owns ordinary Host capability/Operation truth;
6. the stale-Attempt trace proves later not-yet-admitted subcalls fail closed while an already-admitted Operation remains independently settleable;
7. the as-built closure record maps each frozen AC/scenario to implementation and exact proof evidence;
8. temporary diagnostics/staging artifacts are removed.

No additional benchmark, provider/model matrix, sandbox certification, subagent scenario, remote-workspace test, semantic-graph work, or code-only presentation test may be added later as a closure requirement unless new concrete evidence proves the accepted S-02 result would otherwise be invalid, unsafe, corrupted, or unusable.

---

## 14. Change control after freeze

Implementation may choose ordinary file names, internal helper names, embedded JavaScript engine package, worker message encoding, and test fixture structure when those choices preserve this contract.

Explicit re-review is required before merge if an implementation change would:

- expose environmental APIs directly to local code;
- let the worker call raw protocol/Host services instead of exact inference proxy tools;
- offer Code Mode without current ProgramAttemptAuthorityV2;
- make `run_code` Agent-added rather than Host-authorized provider-visible state;
- weaken per-subdispatch Attempt/dynamic-binding currentness;
- aggregate distinct mutating sub-dispatches into one Operation/effect identity;
- allow stale authority to issue a later subcall;
- drop the drain-before-settlement rule for already-issued Host requests;
- persist/reuse local VM state across invocations or Agent generations;
- enable nested `run_code`;
- enlarge a frozen numeric resource bound;
- hide direct tools/code-only mode;
- add subagents, remote execution, or another excluded roadmap capability;
- weaken any frozen AC or required adversarial scenario.

Routine implementation choices that preserve the contract do not require reauthorization.

---

## 15. Decision

```text
P-02 semantic planning + typed verification retry   CLOSED / integration pending at freeze time
APR-016 bounded local orchestration                 ADOPTED for S-02 v1 only
APR-017 fresh isolated worker                       ADOPTED for S-02 v1 only
S-02 architecture                                   FROZEN
S-02 limits                                         FROZEN
AC-S02-01..AC-S02-14                                FROZEN
Scenarios A..Q                                      FROZEN
S-02 implementation                                 AUTHORIZED after P-02 lands
S-02 implementation started                         NO
S-02 closure                                        NOT YET
S-03 durable subagents                              NOT AUTHORIZED
remote workspaces                                   NOT AUTHORIZED
```

The next valid production action after P-02 lands is **PR S02-1: protocol/catalog contract only**. No S-02 production implementation should begin before the predecessor integration condition at the top of this document is satisfied.
