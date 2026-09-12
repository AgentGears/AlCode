# A2 / S-04 — Reconstructable Inference Provenance Plan

**Status:** FROZEN DESIGN CONTRACT — implementation not started by this documentation objective  
**Freeze date:** 2026-09-12  
**Baseline:** `main@bc321ac350ddf90d28b69abfc254eaa9af8969be`  
**Forcing evidence:** [`a2-inference-provenance-gap-study.md`](./a2-inference-provenance-gap-study.md)  
**Predecessors:** A1 adaptive Program, P-02 semantic planning/typed verification, S-02 Code Mode  
**Authority:** This document freezes the bounded A2/S-04 contract. Production implementation requires a separate explicit execution step after this freeze lands.

---

## 1. Objective

Make one provider inference mechanically reconstructable from durable Host history without creating a second source of Program, Operation, verification, or completion truth.

After restart, ALCODE must be able to answer:

```text
Which inference produced this assistant/tool call?
What exact Host-authorized context did it receive?
Which exact capability/binding snapshot could it use?
Which ProgramAttempt authority did it observe?
Which effective provider/model semantics were used?
Which Host Operations were caused by its tool calls?
For run_code, which outer call caused each local sub-dispatch?
How did the inference terminate or become interrupted?
```

The answer must come from durable, bounded, mechanically validated facts rather than event adjacency, process memory, current environment variables, or parsed identifier conventions.

The central invariant is:

> **Inference provenance explains causality; it never grants, renews, transfers, or proves execution authority.**

---

## 2. Authority boundary

A2 adds no new authority over environmental effects or Program progress.

```text
ProgramState / ProgramRevision
        │
        ▼
ProgramAttempt authority ───────────────┐
        │                               │
        ▼                               │
InferenceEpoch provenance               │  provenance only
        │                               │
        ├─ context receipt              │
        ├─ provider/model descriptor    │
        ├─ capability snapshot          │
        └─ tool-call lineage            │
                │                       │
                ▼                       │
          CapabilityBroker ◄────────────┘
                │
                ▼
             Operation
                │
                ▼
      effect / recovery / verification
                │
                ▼
         Completion Oracle
```

The following remain authoritative exactly as before:

- ProgramState / ProgramRevision for canonical engineering intent;
- ProgramAttempt authority/currentness for executable Program work;
- CapabilityBroker + Host policy for capability admission;
- Operation identity/effect/quiescence/reconciliation for environmental truth;
- Host verification state for satisfaction evidence;
- Completion Oracle for terminal certification.

An `InferenceEpochId` is never accepted in place of any existing authority field.

---

## 3. Frozen semantic decisions

### D1 — Introduce one Host-minted `InferenceEpochId`

Each provider inference receives a fresh, non-reusable Host-minted `InferenceEpochId`.

The identity is scoped to causal provenance. It is not a capability token, lease, ProgramAttempt, retry identity, or execution claim.

A new provider inference always receives a new epoch, including after:

- tool-loop continuation;
- Agent replacement;
- provider/model replacement;
- context refresh;
- ProgramAttempt retry/successor;
- semantic Program revision that causes a fresh inference.

Historical epoch identity is immutable.

### D2 — Preserve the existing context receipt as context truth

A2 does not copy rendered prompt/history into a new durable record.

Every epoch references the existing durable `context.projection_compiled` receipt. The receipt remains authoritative for the context source/selection/delivery evidence it already owns.

The epoch additionally binds the receipt to the exact inference lifecycle.

### D3 — One exact inference-authorization cut

Before provider invocation, the Host must durably bind one epoch to the exact inference authorization cut containing at least:

- Session;
- current Agent generation;
- context receipt ID and source event sequence;
- exact inference tool-catalog digest;
- exact binding-bearing capability snapshot digest;
- exact current ProgramAttempt authority snapshot, when Program-backed;
- accepted execution-base identity/digest already carried or referenced by that authority, when applicable;
- secret-free effective provider/model semantic descriptor.

Context receipt creation and epoch authorization must represent one coherent Host decision. Implementation may refactor the current context-refresh service, but it must not create a mixed cut where context comes from one state and capability/Attempt provenance from another.

### D4 — Provider invocation start is a durable acknowledged boundary

Receipt/epoch authorization alone does not prove that a network/local provider invocation occurred.

Before calling `ModelProvider.stream()`, an A2-capable Agent must report the authorized epoch back to the Host. The Host validates Session + exact current Agent generation + authorized epoch identity, durably records provider invocation start, and acknowledges it. Only then may that Agent invoke the provider for the epoch.

This start handshake is provenance sequencing, not model-execution permission beyond the already-established Agent lifecycle. A missing start record means ALCODE must not claim the provider was invoked.

### D5 — Provider/model provenance is secret-free and provider-neutral

The Agent/provider adapter must expose a bounded semantic descriptor containing at least:

```text
provider identifier
model identifier
adapter identifier/version
secret-free effective semantic configuration
canonical semantic-configuration digest
```

The semantic configuration includes request-shaping settings that can materially alter model behavior when configured, such as output-token limits, temperature, and provider endpoint identity where relevant.

Credentials, authorization headers, API keys, raw secret values, and unrestricted environment snapshots are forbidden.

Sensitive endpoint/configuration values that should not be persisted verbatim are represented by a stable bounded digest or an existing safe reference.

The descriptor contract is provider-neutral. A2 does **not** require a second live production provider; deterministic fixture providers must prove that the contract is not Anthropic-specific.

### D6 — Provider-native request/response identifiers are optional provenance

When a provider exposes stable request/message/response identifiers, the adapter should preserve them as bounded provider-native provenance.

They are optional because providers differ. Absence must be represented honestly; ALCODE must never fabricate a provider-native ID.

The ALCODE `InferenceEpochId` remains the stable cross-provider causal identity.

### D7 — Assistant transcript output is explicitly inference-bound

Durable assistant admission for an A2-capable inference carries the `InferenceEpochId` that produced it.

The Host validates that the epoch belongs to the same Session and Agent generation and has a recorded provider-start boundary. The transcript remains the conversation/history projection; the epoch is only its causal parent.

Transcript admission request IDs remain protocol/idempotency identities and are not redefined as model-request identities.

### D8 — Every model-caused Host Operation records explicit inference/tool-call correlation

For an ordinary model tool call that reaches the CapabilityBroker, durable `operation.requested` provenance must include:

```text
InferenceEpochId
toolCallId
```

plus existing ProgramAttempt/verification/effect fields as applicable.

The Host validates provenance claims against the live Agent connection/session and authorized epoch before persisting them. Existing capability and Program authority validation still decides whether execution is admitted.

Host-generated operations that are not directly caused by a model call — for example Host-scheduled verifier execution — must not be falsely attributed to an inference. Their existing Program verification provenance remains authoritative.

### D9 — S-02 local sub-dispatch parentage is explicit durable data

A local Code Mode sub-dispatch records, in addition to `InferenceEpochId` and its own `toolCallId`:

```text
parentToolCallId = outer run_code call
localSubcallIndex = deterministic invocation index
```

The outer `run_code` call remains Agent-local and does not become a Host Operation.

The current `${root}:local:${index}` tool-call spelling may remain for diagnostics/compatibility, but durable reconstruction must not depend on parsing that string.

### D10 — Epoch terminal state describes cognition lifecycle only

After the provider response and all tool calls formed by that inference have settled or the inference scope ends, the Agent reports a terminal epoch outcome. At minimum distinguish:

```text
completed
provider_error
aborted
interrupted / terminal record absent because generation was lost
```

Exact wire spelling is implementation-owned, but the durable projection must not convert missing terminal evidence into success.

Epoch completion says nothing about environmental effect certainty beyond the independent Operation journal. In particular:

- an aborted inference does not prove an admitted mutation did not happen;
- an interrupted Agent does not cancel Host Operation truth;
- an epoch can be terminal while an already-admitted Operation is still settling/reconciling under Host rules.

### D11 — Reconstruct the epoch as a projection, not a second canonical state machine

A2 should add the minimum durable inference lifecycle/correlation events and derive a rebuildable `InferenceEpoch` projection from them.

Do not create an independently mutable inference database whose state can diverge from canonical workspace events.

The projection may materialize/index for performance, but deleting/rebuilding that projection from verified events must reproduce the same epoch lineage.

### D12 — Historical provenance never resurrects authority

Replaying or inspecting an old epoch may recover:

- what context was delivered;
- what provider/model semantics were recorded;
- what tool calls were produced;
- which Operations were admitted;
- what lifecycle outcome was recorded.

It may **not**:

- execute a capability;
- renew a dynamic capability binding;
- make a stale ProgramAttempt current;
- revive an old Agent generation;
- satisfy verification merely because an old inference claimed success;
- settle an indeterminate Operation;
- complete a Program.

A fresh execution always requires existing fresh Host authority.

### D13 — Provider/Agent replacement creates a causal cut, not continuity of authority

If the Agent or provider/model changes, old epochs remain immutable provenance. The next inference receives a fresh epoch under the current Agent generation and current provider descriptor.

No old provider response, context receipt, or epoch may be relabeled as belonging to the replacement generation.

### D14 — A2 does not broaden provider execution or Code Mode authority

A2 is provenance/provider-abstraction work. It does not authorize:

- arbitrary generated code outside S-02's current isolated local runtime;
- new filesystem/network authority;
- direct provider access to Host/storage;
- direct model-authored event admission;
- a provider-specific bypass around Agent Protocol/CapabilityBroker.

---

## 4. Target lifecycle

The frozen causal sequence is:

```text
Agent reaches beforeInference
        ↓
Agent supplies secret-free effective provider/model descriptor
        ↓
Host captures one exact inference authorization cut
        ├─ context receipt
        ├─ capability/binding snapshot
        ├─ ProgramAttempt projection/currentness
        └─ Agent generation
        ↓
Host durably authorizes fresh InferenceEpoch I
        ↓
context.update(..., receiptId, inferenceEpochId=I, exact catalog/Attempt)
        ↓
Agent reports inference start(I)
        ↓
Host durably records + acknowledges start(I)
        ↓
ModelProvider.stream(exact authorized request)
        ↓
assistant response bound to I
        ↓
0..N model tool calls
        │
        ├─ ordinary call C → CapabilityBroker → Operation O
        │                    durable (I, C, O)
        │
        └─ run_code C0
              ↓ local bounded orchestration
              C1(parent=C0,index=0) → Operation O1
              C2(parent=C0,index=1) → Operation O2
              ...
        ↓
all tool work formed by I settles at Agent inference-scope boundary
        ↓
Agent reports terminal inference outcome(I)
        ↓
Host durable epoch projection is reconstructable
```

Already-admitted Host Operations may outlive the Agent-side epoch lifecycle exactly as in S-02.

---

## 5. Minimal protocol/domain changes

Exact TypeScript names are reversible; the semantic fields are frozen.

### 5.1 Agent→Host context refresh

Extend the inference refresh request with a bounded provider descriptor.

The Host does not accept secrets in this descriptor. Validation rejects oversized, malformed, or secret-bearing fields rather than silently persisting them.

### 5.2 Host→Agent context update

Return the Host-minted `InferenceEpochId` alongside the existing receipt, exact tool catalog, and ProgramAttempt projection.

The Agent must retain the receipt/epoch metadata through the provider invocation seam rather than projecting it away as today.

### 5.3 Inference lifecycle messages

Add bounded Agent→Host lifecycle records for:

- provider invocation started;
- epoch terminal outcome.

Both are correlated to the exact epoch and current Agent generation by the Host connection; the Agent does not choose arbitrary generation identity.

### 5.4 Assistant admission

Bind durable assistant output to its exact epoch. Optional provider-native response identity may be included if exposed by the adapter.

### 5.5 Capability requests

For A2-capable inference-originated requests, carry:

- `inferenceEpochId`;
- `toolCallId` (already present);
- optional explicit `parentToolCallId` + `localSubcallIndex` for S-02 nested calls.

The CapabilityBroker persists those causal fields on `operation.requested` without changing effect semantics.

---

## 6. Rebuildable `InferenceEpoch` projection

The projection should expose bounded records sufficient for diagnostics, research, replay inspection, and future provider comparison.

A conceptual record is:

```text
InferenceEpoch
  id
  sessionId
  agentGeneration
  contextReceiptId
  sourceEventSequence
  providerDescriptor
  capabilityCatalogDigest
  capabilityBindingSnapshotDigest
  programAttemptAuthority?   // provenance snapshot, not live authority
  providerStartedAt?
  providerNativeRequestId?
  providerNativeResponseId?
  assistantEventId?
  stopReason?
  terminalOutcome?
  terminalAt?
  calls[]
    toolCallId
    toolName
    parentToolCallId?
    localSubcallIndex?
    operationId?
```

The projection must preserve `unknown`/missing facts rather than infer them from adjacency.

Large rendered prompts, raw provider payloads, secrets, and arbitrary tool results are not duplicated into the epoch; existing receipts/transcript/Operation references are used instead.

---

## 7. Acceptance criteria

### AC-A2-01 — Fresh Host-minted epoch per provider inference

Executable tests prove every provider inference receives a fresh non-reusable `InferenceEpochId` from the Host. Tool-loop continuation, retry/successor Attempt, Agent replacement, and provider/model replacement produce new epoch identities. An Agent cannot choose or reuse an arbitrary historical epoch.

### AC-A2-02 — One exact durable inference authorization cut

A deterministic fixture proves the epoch references the exact durable context receipt, exact capability catalog/binding snapshot, exact Agent generation, and exact ProgramAttempt projection from one coherent Host decision. A race that changes ProgramAttempt or dynamic capability generation during refresh must either produce one internally coherent cut or reject/retry; mixed provenance is forbidden.

### AC-A2-03 — Secret-free provider/model semantic provenance

Provider adapter tests prove the durable descriptor records provider/model/adapter identity and canonical effective semantic-config digest while excluding API keys, authorization headers, raw secret environment values, and other forbidden secret material. Equivalent effective semantics produce the same canonical digest; materially different safe semantic settings produce a different digest.

### AC-A2-04 — Provider invocation start and terminal honesty

Tests prove provider execution does not begin until the Host has durably acknowledged the exact epoch start. Successful response, provider error, and cancellation record truthful terminal provenance. Loss of the Agent after start but before terminal record remains reconstructably nonterminal/interrupted; restart does not fabricate success.

### AC-A2-05 — Assistant output reconstructs to exactly one epoch

Durable assistant transcript events created by the A2 production path carry one valid `InferenceEpochId`. Replay joins the assistant output to its context receipt/provider descriptor/Agent generation without relying on event adjacency or current environment configuration.

### AC-A2-06 — Direct tool call → Operation correlation

A model emits an ordinary Host tool call. Replay proves an exact chain:

```text
InferenceEpoch I
  → toolCallId C
  → Host Operation O
```

`operation.requested` durably records I + C while preserving existing ProgramAttempt/effect semantics. Stale Program authority still fails before Operation admission regardless of valid epoch provenance.

### AC-A2-07 — S-02 outer call → nested subcalls → Operations

One inference emits one `run_code` call containing at least three ordinary sub-dispatches. Replay proves each resulting Operation has:

- the same `InferenceEpochId`;
- its own distinct `toolCallId`;
- explicit `parentToolCallId` equal to the outer `run_code` call;
- deterministic `localSubcallIndex`;
- distinct Host `OperationId`.

The proof must not parse the tool-call ID string to derive parentage.

### AC-A2-08 — Non-model Host work is not falsely attributed

Host-driven verifier/recovery operations that have no direct model tool-call parent remain valid without an inference parent and retain their existing verification/recovery provenance. A2 must not attach “most recent inference” by temporal proximity.

### AC-A2-09 — Restart/rebuild equality

After deleting/rebuilding any inference projection cache and reopening the workspace, verified events reconstruct the same epoch identities, context/provider/capability/Attempt bindings, tool-call parentage, Operation correlations, and known/unknown terminal outcomes.

### AC-A2-10 — Replacement and historical replay cannot mint authority

Adversarial tests prove an old epoch/context receipt/provider response cannot be used after Agent replacement, ProgramAttempt invalidation, or dynamic capability replacement to execute new work. Existing currentness and capability-generation checks remain decisive.

### AC-A2-11 — Provider-neutral contract

At least the production Anthropic adapter plus deterministic non-Anthropic fixture provider(s) satisfy the same provider descriptor/outcome interface without branching Host authority semantics by provider. Adding another live provider is explicitly not required for A2 closure.

### AC-A2-12 — Exact-head product gate

Add one permanent deterministic A2 gate, expected command:

```text
pnpm gate:a2-inference-provenance
```

The gate composes A2 focused proofs with the existing S-02 Code Mode and product-agent predecessor gates needed to prove no authority/effect regression. Exact command composition may be minimized during implementation, but closure requires the A2 gate and its declared predecessor compatibility checks on the same exact candidate head.

Live provider calls remain optional smoke tests and are never a blocking CI dependency.

---

## 8. Frozen adversarial scenarios

### Scenario A — receipt exists, provider never starts

```text
Host authorizes I + persists context receipt
        ↓
Agent is cancelled/replaced before start acknowledgement
```

Expected: durable history may show authorized context, but must not claim provider invocation or response.

### Scenario B — provider starts, Agent disappears

```text
start(I) durably acknowledged
        ↓
provider call begins
        ↓
Agent process lost before terminal report
```

Expected: I remains started/nonterminal or derives interrupted from generation closure without fabricated provider success. No Operation outcome is inferred.

### Scenario C — stale ProgramAttempt with valid epoch

```text
I was authorized under Attempt A0
        ↓
A0 invalidated
        ↓
Agent submits tool request carrying valid I
```

Expected: existing ProgramAttempt authority rejects execution before `operation.requested`. Valid provenance does not revive A0.

### Scenario D — dynamic capability ABA

```text
I sees capability C@G0
        ↓
G0 retired, identical C@G1 registered
        ↓
old I emits C@G0
```

Expected: existing binding check rejects as stale; I remains immutable historical evidence of the G0 snapshot.

### Scenario E — forged epoch correlation

Agent request from generation G2 claims an epoch owned by G1 or another Session.

Expected: Host rejects the provenance claim before admitting an Operation; it does not silently attach the request to the current epoch.

### Scenario F — S-02 cancellation with admitted mutation

```text
I → run_code C0 → nested mutation C1 → Operation O1 admitted
        ↓
run_code/Agent wait aborts
```

Expected: I/C0/C1/O1 lineage remains reconstructable. O1 continues under existing independent effect/quiescence/reconciliation truth. Epoch abort does not imply `effect=absent`.

### Scenario G — Host verifier after model work

Model inference causes edit O1; Host later runs typed verifier O2 from Program verification control.

Expected: O1 has inference/tool provenance. O2 has existing Host verification provenance and no fabricated direct inference parent.

### Scenario H — provider semantic configuration changes

Same provider/model name is invoked with a materially different effective semantic configuration.

Expected: fresh epoch and different semantic-config digest; historical epoch remains unchanged.

### Scenario I — secret injection attempt

Provider descriptor includes an API key/header/raw credential-like forbidden field.

Expected: provenance admission rejects or redacts according to the existing secret-admission contract before persistence; raw secret bytes are never intentionally stored.

---

## 9. Implementation ownership

Expected ownership boundaries:

- `@alcode/events`: branded inference identity only if consistent with foundational identity policy; no provider execution logic.
- `@alcode/agent-core`: provider-neutral inference lifecycle/metadata seam.
- `@alcode/ai`: provider-specific safe semantic descriptor and provider-native response metadata extraction.
- `@alcode/agent-protocol`: negotiated inference-provenance messages/fields.
- `@alcode/coding-agent`: retain epoch metadata through `beforeInference`, provider invocation, tool execution, S-02 local orchestration, and transcript emission.
- `@alcode/host-runtime`: Host-minted epoch lifecycle admission, exact-cut validation, durable event correlation, and Operation provenance persistence.
- storage/projections: rebuildable inference projection only; no independent authority store.

The exact package split may be adjusted if current ownership boundaries make a smaller dependency graph possible, but Host/Agent authority may not move.

---

## 10. Suggested implementation slices

A shortest reversible sequence is:

```text
A2-1  identity + provider descriptor + protocol negotiation
A2-2  exact Host epoch authorization/start lifecycle + context binding
A2-3  assistant + ordinary tool-call/Operation durable correlation
A2-4  S-02 explicit nested parentage + restart projection
A2-5  adversarial/product gate + as-built closure
```

Slices may be combined when a smaller coherent PR is safer. Intermediate PRs are partial A2 work and must not claim objective closure.

---

## 11. Explicit exclusions

A2/S-04 does **not** authorize or require:

- durable subagents or multi-Agent delegation;
- worktrees or parallel workspace execution;
- remote workers or remote workspace backends;
- procedure/skill learning or promotion;
- arbitrary generated-code execution beyond closed S-02 semantics;
- browser execution;
- general scheduler/automation;
- a second live production model provider;
- provider benchmarking as a closure gate;
- storage of raw provider request/response payloads merely for telemetry;
- storage of credentials/secrets;
- new ProgramState fields solely for inference provenance;
- inference-based effect truth;
- inference-based verification satisfaction;
- model/provider-based Completion authority;
- reopening A1, P-02, or S-02 semantics absent new falsifying evidence.

---

## 12. Failure / rollback rule

Reversible implementation details include exact event names, protocol version spelling, TypeScript interface names, provider metadata field names, projection indexing strategy, and PR slicing.

A demonstrated blocker may adjust those mechanisms while preserving the frozen semantics above.

Do **not** resolve implementation difficulty by:

- moving canonical Program/Operation authority into the Agent/provider;
- making inference provenance an authority token;
- weakening ProgramAttempt/dynamic-binding validation;
- equating Agent/provider cancellation with effect absence;
- duplicating rendered context/history into an independent durable truth store;
- persisting secrets for reproducibility.

If a provider does not expose a native request/response identifier, retain `undefined`/absent provenance; do not fabricate one.

---

## 13. Completion definition

A2/S-04 implementation is complete only when:

1. AC-A2-01 through AC-A2-12 pass on one exact candidate head;
2. the product path proves one ordinary inference and one S-02 `run_code` inference can both be reconstructed after restart to exact context/provider/Attempt/capability/tool/Operation lineage;
3. stale Attempt, dynamic capability ABA, Agent replacement, and S-02 cancellation adversarial cases remain fail-closed under predecessor authority rules;
4. no test relies on parsing local tool-call naming to prove durable parentage;
5. the permanent A2 gate passes together with declared predecessor compatibility checks; and
6. an as-built closure record documents the exact implementation mapping and any bounded corrections.

Successful closure will establish reconstructable model causality. It will **not** authorize A5 sandboxing, procedure learning, parallel workspaces, subagents, remote execution, or autonomous scheduling.

---

## 14. Freeze review result

The gap study demonstrates the S-04 adoption trigger: existing receipts/events cannot mechanically reconstruct exact inference causality because the provider invocation has no durable epoch identity/provider binding, transcript output is not receipt-bound, Host Operations drop `toolCallId`, and S-02 nested parentage is not durable.

This plan corrects exactly those gaps while reusing existing context, ProgramAttempt, capability, Operation/effect, verification, and completion authority.

**Review decision:** Proceed as written for a future explicitly authorized implementation step.
