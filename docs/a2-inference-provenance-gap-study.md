# A2 / S-04 — Reconstructable Inference Provenance Gap Study

**Status:** COMPLETE — current durable receipts/events are insufficient for exact inference reconstruction  
**Prepared:** 2026-09-12  
**Baseline:** `main@bc321ac350ddf90d28b69abfc254eaa9af8969be`  
**Pattern input:** Architecture Pattern Register S-04 — Reconstructable Inference Epoch  
**Authority:** Study only. This document establishes the forcing function for the separate frozen A2/S-04 plan; it does not itself authorize production implementation.

---

## 1. Question and decision rule

S-04 was intentionally deferred until the repository could prove that existing receipts and durable events could not already reconstruct one model inference precisely enough.

The required question is therefore narrow:

> From a durable assistant/tool/Operation fact after restart, can ALCODE mechanically reconstruct the exact inference that caused it, including the context authorization cut, current ProgramAttempt authority, exact capability/binding snapshot, effective provider/model semantics, and tool-call lineage, without relying on volatile Agent state or naming conventions?

If yes, A2 should add no new durable provenance object. If no, A2 should add only the minimum durable facts needed to make the reconstruction mechanical while preserving existing Program, Operation, verification, and Completion authority.

The live implementation proves **no**. Most ingredients already exist, but several load-bearing joins are absent.

---

## 2. Existing durable ingredients that must be reused

A2 is not a greenfield telemetry subsystem. The current runtime already owns important provenance facts.

### 2.1 Canonical context receipt

`HostContextService.refresh()` persists `context.projection_compiled` before returning the context update. The receipt records the source event sequence, request-environment digests, context mode, selection/fallback details, delivery digests, and the exact model-facing tool-definition digest used by the context decision. The receipt ID is the persisted event ID.

The Host→Agent `context.update` already carries that `receiptId`, the source sequence, rendered system/messages, the exact inference tool catalog when supported, and the current ProgramAttempt projection.

**Reuse conclusion:** the context receipt remains the canonical context-authorization evidence. A2 must reference it; it must not duplicate rendered context or invent a second context truth.

### 2.2 Exact inference-time capability catalog

Phase 0.9 already gives each inference an immutable `InferenceToolCatalog` with a digest and exact authorized descriptors. Dynamic tools carry opaque binding revisions; S-02 adds the `agent_local_code_mode_v1` binding without turning it into a Host Operation.

**Reuse conclusion:** A2 needs durable identity for the exact descriptor/binding snapshot seen by the inference, not another capability registry.

### 2.3 ProgramAttempt authority

The inference refresh already receives the current ProgramAttempt projection, and ordinary capability proxies echo the captured ProgramAttempt authority on every relevant Agent→Host request. A1/S-02 tests already prove stale Attempt authority fails closed while already-admitted Operations retain independent Host truth.

**Reuse conclusion:** A2 records which current authority the inference observed. It does not create, extend, renew, or validate ProgramAttempt authority by itself.

### 2.4 Provider/model tool-call identity

`toolCallId` is preserved through the Agent loop, tool execution context, Agent protocol capability request, assistant transcript content, and tool-result transcript structure.

**Reuse conclusion:** provider/model tool-call identity is the correct semantic join key for model-visible calls. A2 should preserve it rather than inventing a replacement call identity.

### 2.5 Host Operation identity and effect truth

Every admitted environmental capability execution receives a Host-minted `OperationId` and remains governed by existing execution/effect/quiescence/reconciliation semantics.

**Reuse conclusion:** A2 may correlate an inference/tool call to an Operation, but never replaces the Operation journal or infers effect truth from model/transcript provenance.

---

## 3. Demonstrated reconstruction gaps

### Gap A — no durable inference identity

`@alcode/agent-core` has an ephemeral `beforeInference` / `afterInference` lifecycle, but `ModelRequest`, `ModelProvider`, `ModelStream`, and `ModelEvent` contain no inference identity.

The Host does mint a durable context receipt immediately before an inference, but the current Agent helper `requestInferenceContext()` deliberately projects only system prompt, messages, tool catalog, and ProgramAttempt. It drops `receiptId`, `effectiveMode`, and `sourceEventSequence` before the provider invocation seam.

Therefore the durable context receipt cannot currently be joined mechanically to the provider invocation or its resulting assistant message.

### Gap B — effective provider/model semantics are not durably bound

The production Agent selects `ALCODE_PROVIDER` and `ALCODE_MODEL` locally and returns only a `ModelProvider`. The `ModelProvider` contract exposes only `stream(request)`; it has no stable provider/model/adapter descriptor.

`@alcode/ai` internally owns `ProviderConfig`, including provider, model, base URL, max tokens, and temperature, but those effective semantics are not durably associated with an inference. Credentials must never be persisted.

The Anthropic stream parser also normalizes provider SSE into generic model events and currently ignores provider response/message identity present in provider-native metadata.

Therefore replay can show what the model said but not prove which effective provider/model semantics produced that response.

### Gap C — assistant transcript events are generation-bound, not inference-bound

Durable `assistant.message.appended` admission uses an Agent-generation-scoped idempotency key and records the assistant content/stop reason. It does not record a context receipt ID, inference identity, provider/model descriptor, or provider response identity.

The protocol `requestId` used for transcript admission is generated when the Agent records the message. It identifies that admission exchange, not the model inference that produced the message.

Therefore Agent generation + transcript ordering is not an exact inference provenance contract.

### Gap D — Host Operations do not durably retain `toolCallId`

`CapabilityBrokerRequest` receives `toolCallId`, and the protocol correctly transports it. However the durable `operation.requested` payload currently records the Operation, capability, arguments, workspace/effect classification, verification provenance, and Program routing facts without persisting `toolCallId`.

Consequently a reconstructed assistant tool call cannot be joined mechanically to its Host Operation from durable data alone.

This is a direct forcing function for A2; a naming convention or volatile protocol correlation is insufficient.

### Gap E — S-02 nested calls have no explicit durable parent edge

S-02 creates subcall IDs as `${rootToolCallId}:local:${subcallIndex}` and routes each subcall through the ordinary captured capability proxy. This is correct for live isolation and authority, but the root/subcall relationship is a local naming convention.

Because the CapabilityBroker does not persist the incoming `toolCallId`, the parent relation disappears at the durable Operation boundary. After restart, the system cannot prove from canonical events that Operation O7 was the second environmental sub-dispatch of outer `run_code` call C1.

Parsing a tool-call string is not an acceptable durable causal contract.

### Gap F — exact dynamic binding snapshot is not reconstructable from the context receipt alone

The context receipt records the model-facing `toolDefinitionsDigest`. Dynamic capability binding revisions are intentionally Agent/Host execution preconditions and are not part of ordinary model-facing definitions. The `InferenceToolCatalog` delivered over the protocol carries those bindings, but the exact binding-bearing catalog is not itself durably attached to one inference.

Therefore the current receipt can prove the model-visible schema set but not the exact dynamic binding snapshot against which later calls were formed.

---

## 4. Result

The S-04 adoption trigger has fired.

Current durable history is strong enough that A2 does **not** need a second execution ledger, a provider transcript database, or a durable copy of every rendered prompt. It is not strong enough to reconstruct the causal path:

```text
exact inference authorization cut
        ↓
provider/model invocation
        ↓
assistant tool call
        ↓
optional run_code local orchestration
        ↓
ordinary Host Operation(s)
```

The missing semantics are correlation and provenance, not new execution authority.

---

## 5. Minimum architecture implied by the evidence

The smallest coherent correction is a Host-minted, non-authorizing `InferenceEpochId` plus bounded durable correlation facts.

A rebuildable Inference Epoch should bind:

```text
InferenceEpochId
  ├─ Session + exact Agent generation
  ├─ canonical context receipt ID
  ├─ exact inference capability catalog digest
  ├─ exact binding-bearing capability snapshot digest
  ├─ current ProgramAttempt authority snapshot, if any
  ├─ accepted execution-base identity carried by that authority, if any
  ├─ secret-free effective provider/model semantic descriptor
  ├─ assistant/provider outcome metadata
  └─ tool-call lineage → Host Operation identities
```

For S-02, nested lineage must be explicit:

```text
InferenceEpoch I7
  ↓
outer provider tool call C0 = run_code
  ↓
local subcall C1 (parent=C0, index=0) → Operation O1
local subcall C2 (parent=C0, index=1) → Operation O2
local subcall C3 (parent=C0, index=2) → Operation O3
```

The existing assistant transcript still owns model-visible conversation history. The existing context receipt still owns context-selection evidence. The existing Operation journal still owns environmental truth. The existing Program state machines still own execution authority and completion.

---

## 6. Non-solutions rejected by this study

The following would not satisfy the requirement:

- treating event ordering alone as inference identity;
- using transcript admission `requestId` as a model-request identity;
- inferring provider/model from current environment variables after restart;
- parsing `:local:<index>` from a tool-call ID as the only durable S-02 parent relation;
- treating the context receipt itself as proof that a provider invocation actually occurred;
- storing API keys, authorization headers, or raw secrets as provider provenance;
- making inference provenance a prerequisite that can revive stale ProgramAttempt authority;
- using inference completion as evidence that any environmental mutation completed or did not happen.

---

## 7. Recommendation

Proceed with the separate A2/S-04 frozen plan using a **rebuildable provenance projection over minimal new durable facts**, not a second canonical task/execution state machine.

The implementation should preferentially extend existing seams:

- context refresh / Host context receipt;
- Agent inference lifecycle;
- provider adapter metadata;
- assistant transcript admission;
- capability request / `operation.requested` correlation;
- S-02 sub-dispatch metadata.

No evidence from this study justifies subagents, worktrees, remote execution, procedure learning, scheduler expansion, or arbitrary provider-specific telemetry.
