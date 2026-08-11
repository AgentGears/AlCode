# Phase 0.7 — Graph-distilled context compiler and experiment framework

Status: **DRAFT — NOT FROZEN — NOT AUTHORIZED**.

Baseline: closed Phase 0.6 foundation on `main` at `98c764c`.

This document is a proposed Phase 0.7 implementation and acceptance boundary. It is intentionally a draft for architectural review. It does not authorize implementation and does not change the closed contracts of Phases 0.0–0.6.

The phase separation remains:

```text
0.6 = reconstruct what the model previously saw
0.7 = decide what the model should see
0.8 = decide when newly admitted input is dispatched
```

Phase 0.7 must preserve `verbatim-v1` as the safety/reference strategy. Graph-distilled context remains an experiment and does not become the default merely because the phase closes.

---

## 1. Objective

Phase 0.7 introduces a Host-owned context strategy that can select and render a bounded model context from the same durable state already owned by ALCODE:

- exact canonical transcript history from 0.6;
- reasoning state from 0.4/0.5;
- memory state from 0.3/0.5;
- Host operation/recovery state from 0.2/0.5;
- a bounded Host-observed workspace/repository snapshot.

The proposed objective is:

> **Given one stable source cut and the newly admitted user request, the Host can deterministically compile a graph-distilled context with explicit provenance, bounded estimated cost, and an inspectable durable receipt; if required state is unsafe, invalid, unsupported, or cannot fit without dropping mandatory information, the Host uses the closed `verbatim-v1` strategy instead.**

The authority rule is unchanged:

```text
canonical state
      ↓
Host context strategy
      ↓
Agent Protocol
      ↓
disposable Agent request state
      ↓
ModelProvider.stream()
```

The Agent does not search memory, traverse the reasoning graph, choose the projection mode, decide fallback, or write context receipts.

---

## 2. Existing seams this phase must reuse

Phase 0.7 starts from concrete closed behavior rather than a new context stack.

### 2.1 Verbatim baseline

`compileVerbatimContext()` already turns a stable transcript snapshot into `verbatim-v1`, and `assertContextContinuable()` blocks incomplete tool-call history. This remains the fallback/reference implementation.

### 2.2 Durable transcript

Phase 0.6 canonically stores text user messages, assistant text/tool calls, and textual tool results. Rich non-user messages cross the Host-acknowledged transcript barrier before later inference.

### 2.3 Cognition snapshot

The Host cognition gateway can reconstruct reasoning graph, memory records/stats, operations, and incomplete durable work. The coordinator already exposes active objective, active hypotheses, assumptions, alternatives, pending verification contracts, evidence, diagnostics, and pending operations.

### 2.4 Memory ranking

`@alcode/memory` already owns deterministic lexical ranking and the Ola-derived `0.65 relevance + 0.20 structural + 0.15 strength` scoring rule. Phase 0.7 should reuse that semantic function rather than invent a second memory relevance model.

### 2.5 Receipt storage scaffold

Schema v7 already contains `projection_receipts`. The proposed 0.7 implementation should use a canonical `context.projection_compiled` event as the full receipt and materialize a summary into the existing table. A schema v8 is not proposed unless implementation proves the existing table cannot carry the required summary.

---

## 3. Proposed package boundary: `@alcode/context`

Add a pure semantic/compiler package:

```text
packages/context/
  src/
    types.ts
    source.ts
    candidates.ts
    selection.ts
    render.ts
    cost.ts
    receipt.ts
    evaluation.ts
    index.ts
```

`@alcode/context` owns:

- context source/candidate contracts;
- deterministic required/optional selection rules;
- deterministic cost estimation;
- graph-context rendering;
- receipt construction and output digests;
- pure A/B compilation/evaluation helpers.

It does **not** own:

- SQLite or workspace locks;
- canonical event admission;
- Agent process lifecycle;
- capability execution;
- memory reinforcement;
- reasoning mutation;
- permission policy;
- provider-specific HTTP transforms;
- application/UI dispatch policy.

Host runtime owns source acquisition, strategy choice, fallback, receipt admission, and delivery to the Agent.

---

## 4. One stable context source cut

Phase 0.7 should not independently read transcript, reasoning, memory, and operations at different heads.

Proposed bounded read model:

```ts
interface ContextSourceSnapshot {
  sourceEventSequence: number;
  sessionId: string;
  transcript: TranscriptReduction;
  cognition: ContextCognitionSnapshot;
}

getContextSourceSnapshot(sessionId: string): Promise<ContextSourceSnapshot>;
```

Construction:

```text
capture canonical head N once
→ read verified events <= N
→ reduce transcript from that event set
→ reduce reasoning from that event set
→ reduce memory/stats from that event set
→ reduce operation/work state from that event set
→ return one sourceEventSequence=N
```

The context compiler receives the resulting immutable value. It does not receive a live SQLite handle or independently query mutable projections.

This is stronger than combining several individually valid read models because it prevents cross-domain TOCTOU context such as transcript at N, reasoning at N+2, and memory at N+1.

---

## 5. Compilation boundary: one projection per admitted user input

To keep 0.7 bounded, the proposed compiler runs at the Host input-admission boundary rather than adding a new Host round trip before every provider stream inside a tool loop.

Proposed sequence:

```text
prior transcript must be continuable
        ↓
Host canonically admits current user U
        ↓
capture ContextSourceSnapshot at stable head N including U
        ↓
compile selected prior prefix + durable appendix using U as the query anchor
        ↓
canonically admit context.projection_compiled receipt
        ↓
critical receipt summary catches up
        ↓
Host sends context update
        ↓
Host sends input.admitted(U)
        ↓
Agent replaces disposable prefix and appends U exactly once
        ↓
ModelProvider.stream()
```

The compiler output excludes the current user message from `historyMessages`; the existing Agent loop appends that canonical input using the Host-supplied timestamp. The current user event is still part of the source cut and selection query.

Within that user turn, new assistant/tool-result messages continue to append verbatim under the 0.6 durable ACK barrier. Phase 0.7 does not repeatedly re-distill after every tool call. If later evidence shows per-model-request recompilation is required, that is a separate authorized expansion rather than an implicit part of this draft.

This design does **not** add pending-input redispatch after a Host crash; that remains Phase 0.8 policy.

---

## 6. Strategy contract and default

Proposed Host strategy contract:

```ts
type ContextMode = "verbatim" | "graph";

type EffectiveContextMode = "verbatim-v1" | "graph-v1";

interface ContextStrategyRequest {
  requestedMode: ContextMode;
  source: ContextSourceSnapshot;
  currentUserEventId: string;
  baseSystemPromptDigest: string;
  reservedRequestCost: number;
  budget: ContextBudget;
  workspace: WorkspaceContextSnapshot;
}

interface CompiledContext {
  effectiveMode: EffectiveContextMode;
  sourceEventSequence: number;
  historyMessages: Message[];
  systemAppendix: string;
  estimatedTokens: number;
  receipt: ContextProjectionReceipt;
}
```

Host configuration may request `graph`, but **the product/default mode remains `verbatim`**.

No model output, Agent request, evaluation result, or receipt automatically changes the default.

---

## 7. Output shape: transcript prefix + system appendix

Graph-derived cognition/memory/workspace facts should not masquerade as historical user messages.

Proposed model boundary:

```text
ModelRequest.systemPrompt
  = base system prompt
  + deterministic graph-v1 durable-context appendix

ModelRequest.messages
  = selected canonical transcript prefix
  + current canonical user message
  + new in-turn transcript messages
```

This keeps three categories distinct:

- actual canonical conversation remains `Message[]`;
- durable graph/memory/workspace state is rendered as a Host-owned system appendix;
- the base system prompt remains configuration, not newly claimed durable transcript state.

The receipt records the base system-prompt digest and its estimated reserved cost, but not the raw system prompt. Tool definitions are handled the same way: their estimated request cost is reserved but Phase 0.7 does not claim durable tool-definition restoration.

---

## 8. Deterministic `graph-v1` appendix

Use a versioned canonical renderer rather than unconstrained prose generation.

Proposed logical sections:

```text
ALCODE durable context / graph-v1

workspace
objective
active hypotheses
pending verification obligations
contradictions / blocking diagnostics
pending or uncertain operations
selected decisive evidence
selected assumptions / alternatives
selected relevant memories
```

The underlying structure is rendered from canonical JSON-compatible values with stable ordering. No LLM performs summarization or compression.

Rendering rules must define:

- stable field order;
- stable node/memory ordering;
- deterministic numeric formatting;
- deterministic truncation rules only for optional fields;
- explicit source identifiers for every rendered cognitive/memory item;
- escaping that prevents source content from altering section structure.

`graph-v1` is therefore a deterministic projection, not a generated summary.

---

## 9. Mandatory candidates

The following state is proposed as **required when present**. Required candidates are never silently dropped merely to satisfy the graph budget.

### Always outside selection

- base system/safety prompt remains present in `ModelRequest.systemPrompt`;
- current canonical user request is appended exactly once by the Agent loop.

### Required graph/workspace state when present

- active objective;
- all active hypotheses;
- all active verification contracts not yet consumed;
- contradictions and blocking diagnostic findings;
- pending, indeterminate, or reconciliation-pending operations;
- current bounded workspace/repository snapshot;
- decisive evidence directly supporting or contradicting an active hypothesis;
- the immediately preceding complete conversational turn, preserving exact transcript semantics and tool-call/result pairing.

If the required set cannot fit within the configured graph budget after reserved request cost, the graph strategy does not truncate it. It falls back to `verbatim-v1` and records `required_budget_overflow`.

An empty category is not itself an error. For example, a session may legitimately have no active verification contract or no relevant memory.

---

## 10. Optional candidates

Optional candidates compete for the remaining graph budget after required state is reserved.

Proposed optional families:

- earlier transcript turns, newest first;
- active assumptions;
- deferred alternatives;
- non-decisive evidence, newest first;
- relevant active memories.

Selection must be deterministic and explainable. No learned policy, embedding model, or hidden LLM judge is proposed in 0.7.

---

## 11. Transcript selection and tool-pairing safety

Transcript selection operates on semantic units, not arbitrary individual messages.

Proposed units:

- ordinary user/assistant text message;
- assistant tool call plus its corresponding `toolResult` as one atomic unit;
- assistant text + tool call + corresponding results as one atomic unit where emitted together.

Rules:

- preserve canonical order in the final output;
- never include a tool result without its selected assistant call;
- never include a selected tool call without its durable result in a transcript marked complete;
- the immediately preceding complete user turn is required;
- older complete turns are selected newest-first until the optional budget is exhausted.

The compiler does not synthesize results or repair orphaned calls. An incomplete 0.6 transcript is not continuable and is rejected before 0.7 selection.

---

## 12. Reasoning selection

Reuse the closed reasoning graph; do not add new epistemic semantics merely for context ranking.

Proposed deterministic policy:

- active objective: required;
- active hypotheses: required;
- pending verification contracts: required;
- evidence connected to an active hypothesis by `SUPPORTS` or `CONTRADICTS`: required decisive evidence;
- blocking/contradiction diagnostics: required;
- assumptions and alternatives: optional;
- other observations/action results: optional, ordered by source sequence descending.

The context package consumes graph semantics but does not mutate the graph or invent support/contradiction edges.

If graph validation/reduction fails at the captured source cut, requested graph mode falls back to verbatim with an explicit reason.

---

## 13. Memory selection is read-only

Relevant memories are optional candidates selected using the closed Phase 0.3 ranking semantics.

Proposed query anchor:

```text
current user text
+
active objective label (if present)
+
active hypothesis labels (if present)
```

Use the canonical current user timestamp as the ranking `now` value so decay/strength scoring is reproducible.

Hard rule:

```text
context selection
≠ memory seen
≠ memory used
```

The compiler calls the pure ranking function directly. It must not route through the cognition recall path that records `seen`, and it must not record `used` merely because a memory was inserted into context.

The receipt records selected memory IDs and their existing score breakdowns. It does not create a reinforcement event.

Dense/vector retrieval remains deferred.

---

## 14. Workspace/repository context port

The Phase 0 specification requires current worktree/repository state, but the context compiler must not gain arbitrary filesystem or terminal authority.

Proposed Host-side port:

```ts
interface WorkspaceContextProvider {
  snapshot(): Promise<WorkspaceContextSnapshot>;
}

interface WorkspaceContextSnapshot {
  workspaceId: string;
  repositoryId: string;
  kind: "git" | "non_git";
  headCommit?: string;
  branch?: string;
  dirty: boolean;
  changedPaths: string[];
  changedPathCount: number;
  statusDigest: string;
}
```

Requirements:

- read-only Host authority;
- deterministic path sorting;
- no diff body or arbitrary file contents automatically injected;
- no absolute host path required in the model context;
- no Agent-owned `git status` side channel;
- snapshot failure causes graph fallback rather than guessed state.

If a bounded changed-path list is truncated, the snapshot must say so and retain `changedPathCount` plus `statusDigest`; the compiler must not imply the list is complete.

The full bounded workspace snapshot used for compilation is recorded in the projection receipt because it is environmental state rather than canonical event history.

---

## 15. Cost estimator and budget semantics

Phase 0.7 needs deterministic bounded selection, but it does not need provider-exact tokenization or compaction.

Proposed contract:

```ts
interface ContextBudget {
  maxEstimatedTokens: number;
  estimatorVersion: "chars4-v1";
}
```

`chars4-v1` is a deterministic conservative planning estimator based on rendered character count. Its purpose is selection reproducibility and A/B cost comparison, not enforcement of a provider's exact context-window limit.

The compiler reserves estimated cost for:

- base system prompt;
- tool definitions;
- current user message.

Then it accounts for required graph/transcript candidates and optional candidates.

No production-wide numeric budget is proposed by this draft. The Host/experiment configuration supplies the budget explicitly and the receipt records it.

Provider-specific tokenizers, adaptive context-window management, compaction, and summarization remain outside 0.7.

---

## 16. Selection order

Proposed deterministic order:

```text
1. reserve base request cost
2. include required workspace/cognition state
3. include required previous complete transcript turn
4. if required cost > budget → fallback verbatim
5. rank/select relevant memories using closed 0.3 score
6. add optional assumptions/alternatives/evidence in stable priority order
7. add earlier transcript turns newest-first as atomic units
8. stop before the next optional candidate would exceed budget
9. canonical render
10. compute output digests
11. build durable receipt
```

Within one optional priority class, ties are broken by stable source identity/sequence rather than incidental map iteration order.

The exact ordering is a draft decision and should be reviewed before freezing because it materially defines graph-v1 behavior.

---

## 17. Durable projection receipt

Add the planned canonical event:

```text
context.projection_compiled
```

Proposed payload:

```ts
interface ContextProjectionCompiledPayload {
  receiptId: string;
  requestedMode: "verbatim" | "graph";
  effectiveMode: "verbatim-v1" | "graph-v1";
  compilerVersion: string;
  sourceEventSequence: number;
  currentUserEventId: string;
  inputDigest: string;

  budget: {
    maxEstimatedTokens: number;
    estimatorVersion: string;
    reservedRequestCost: number;
  };
  estimatedTokens: number;

  selected: ContextReceiptEntry[];
  excluded: ContextReceiptEntry[];

  workspaceSnapshot: WorkspaceContextSnapshot;
  baseSystemPromptDigest: string;
  outputDigest: string;
  messagePrefixDigest: string;
  systemAppendixDigest: string;

  fallback: {
    used: boolean;
    reason?: ContextFallbackReason;
  };
}
```

The receipt must be inspectable but should not duplicate raw transcript/memory/reasoning text into the event merely for convenience. `selected`/`excluded` entries carry source IDs, source sequence when applicable, candidate type, estimated cost, score metadata when applicable, and selection/exclusion reason.

The actual context can be deterministically regenerated from the same canonical cut, compiler version/config, and the recorded bounded workspace snapshot.

Use the event's `eventId` as `receiptId` unless implementation demonstrates a concrete need for a separate identity.

`producer` should be Host/runtime context compilation, not Agent or model authority.

---

## 18. Receipt projection and schema

Proposed `context_receipts` projection:

- consumes only `context.projection_compiled`;
- materializes summary rows into the existing `projection_receipts` table;
- is classified **critical** for graph delivery: context is not reported/delivered as graph-compiled until the receipt summary has caught up;
- remains rebuildable from canonical events.

The canonical event is the full receipt authority. `projection_receipts` is an inspectable summary projection.

No schema v8 is proposed. The existing table already has:

```text
receipt_id
projection_mode
compiler_version
source_event_sequence
token_budget
estimated_tokens
fallback_used
created_at
```

If implementation discovers a real inability to satisfy the frozen receipt contract without altering that table, the schema decision must be surfaced before changing it.

---

## 19. Fallback doctrine

Requested graph mode may produce effective verbatim mode.

Proposed fallback reasons:

```text
legacy_transcript_fidelity
invalid_context_source
workspace_snapshot_failed
unsupported_context_value
required_budget_overflow
graph_render_failed
agent_missing_graph_capability
```

Hard distinctions:

- **Incomplete transcript:** not a graph fallback. 0.6 continuation remains blocked; no new model request.
- **Graph prerequisite failure:** compile/deliver `verbatim-v1` and record fallback.
- **Receipt admission failure:** fail closed; do not send an unreceipted graph projection and do not pretend fallback was recorded.

Fallback uses verbatim reconstruction from the same stable source cut where possible.

The graph compiler may never fabricate memory/reasoning/workspace facts in order to avoid fallback.

---

## 20. Agent Protocol extension

Keep the semantic protocol additive unless implementation demonstrates an incompatible change requiring a version bump.

Proposed capability:

```text
graph_context_v1
```

A 0.7-capable worker advertises both:

```text
durable_transcript_v1
graph_context_v1
```

Proposed Host message:

```ts
interface ContextUpdate {
  type: "context.update";
  requestId: string;
  sessionId: string;
  sourceEventSequence: number;
  effectiveMode: "verbatim-v1" | "graph-v1";
  receiptId?: string;
  historyMessages: Message[];
  systemAppendix: string;
}
```

The Agent replaces, rather than merges with, its disposable prior history on `context.update`.

For requested graph mode, lack of `graph_context_v1` causes Host fallback to verbatim and a receipt reason; it does not silently send graph semantics to an incapable worker.

The initial attach-time `context.provide.verbatim` path remains valid for replacement/bootstrap compatibility.

---

## 21. Agent-core boundary

No Agent-side graph traversal or memory search is proposed.

The only new Agent behavior should be a small request-state seam:

```text
context.update
→ replace disposable history prefix
→ set current system appendix

input.admitted
→ run existing Agent loop with
     base system prompt + appendix
     initialMessages = Host-selected prefix
     promptTimestamp = canonical timestamp
```

The Agent remains free to retain the resulting in-process messages during the current turn, but they are disposable and never become context authority.

No Agent-local receipt database or projection cache is introduced.

---

## 22. Crash/recovery semantics

Proposed cuts:

### User admitted, before context receipt

```text
canonical U exists
→ Host dies before context receipt
→ no graph context delivered
→ no automatic U redispatch in 0.7
```

Phase 0.8 still owns pending-input dispatch policy.

### Receipt event appended, before critical projection catch-up

```text
canonical receipt exists
→ Host dies
→ reopen
→ projection catches up from event
```

### Receipt durable, before `context.update`

```text
no Agent inference has started
→ replacement Host may regenerate from receipt/source or compile again under explicit input handling
```

### `context.update` delivered, before `input.admitted`

```text
Agent has disposable context only
→ no provider request yet
```

### Agent dies after context update

```text
receipt + canonical sources remain Host-owned
→ replacement Agent can be hydrated again
```

Phase 0.7 must not weaken the 0.6 transcript ACK barrier during these cuts.

---

## 23. Pre-registered evaluation protocol

The experiment framework measures graph and verbatim strategies without automatically promoting graph.

For every evaluation case, record:

- case/task identifier;
- immutable source fixture/workspace seed digest;
- current input digest;
- requested/effective context mode;
- compiler version;
- model/provider configuration when a model is exercised;
- estimated context tokens;
- selected candidate counts by type;
- fallback occurrence/reason;
- task outcome (`passed` / `failed` / `indeterminate`);
- tool operation outcome counts;
- completion outcome;
- compile duration as diagnostic data only.

Primary comparison dimensions are proposed as:

1. **task correctness/outcome** — graph must not hide correctness regressions behind lower context cost;
2. **estimated context cost** — graph should use less context when it can do so safely;
3. **required-inclusion integrity** — mandatory facts are present or graph falls back;
4. **fallback rate/reasons** — safety behavior is visible rather than silent;
5. **operational behavior** — tool/recovery/completion outcomes remain comparable.

No threshold for making graph the product default is proposed in Phase 0.7. Default promotion remains a separate explicit decision after measured evidence exists. The backlog continues to own that promotion trigger.

The gate may use deterministic fixtures and the offline provider. Live-provider evaluation is optional evidence, not a closure dependency.

---

## 24. A/B harness isolation

A/B compilation should not mutate a live user session twice merely to compare strategies.

Proposed pure harness:

```text
immutable ContextSourceSnapshot + current input + workspace snapshot
        ├─ compile verbatim reference
        └─ compile graph candidate
                ↓
        compare receipts/cost/inclusion
```

For end-to-end task outcomes, run the same seeded task in isolated workspace/session copies with identical initial canonical state and provider configuration.

Context selection itself must not reinforce memories or modify reasoning state; otherwise A/B order would contaminate the experiment.

---

## 25. Required integration tests

The eventual frozen plan should cover at least these families.

### Stable source cut

```text
concurrent later event after captured head N
→ compilation uses only <= N
→ transcript/reasoning/memory/operation source sequence agrees
```

### Required inclusion

Prove present objective, hypotheses, pending verification, contradictions, pending operations, decisive evidence, workspace state, and previous turn are included.

### Budget safety

```text
required set fits
→ graph-v1

required set exceeds budget
→ verbatim fallback
→ no required fact silently dropped
```

### Transcript atomicity

No selected call/result pair is split or reordered.

### Memory non-mutation

Graph compilation may rank/select memories but emits no `memory.reinforced` event and does not alter seen/used counts.

### Determinism

Same source cut + user event + workspace snapshot + budget + compiler version produces byte-identical appendix/messages digests and equivalent receipt decisions.

### Receipt durability

Receipt append, critical projection catch-up, close/reopen, projection delete/rebuild, and receipt inspection are proven.

### Fallback matrix

Every declared fallback reason produces effective `verbatim-v1` and a receipt with the correct reason, except incomplete transcript which remains continuation-blocking.

### Agent replacement

Replacement Agent receives Host-selected graph context from durability/receipt inputs without prior Agent process memory.

### Closed-phase composition

`gate:0.7` composes `gate:0.6` unchanged.

---

## 26. Proposed `gate:0.7` receipt IDs

These IDs are a draft and become acceptance criteria only if the plan is reviewed and frozen.

```text
phase0.gate_composition

context.typecheck
context.tests
host_runtime.typecheck
agent_protocol.typecheck
coding_agent.typecheck
storage.typecheck

context.stable_source_cut
context.deterministic_compile
context.required_inclusions
context.transcript_atomicity
context.memory_read_only
context.budget_required_overflow_fallback
context.legacy_fidelity_fallback
context.workspace_failure_fallback
context.graph_validation_fallback
context.incomplete_transcript_blocked

context.receipt_canonical
context.receipt_projection
context.receipt_rebuild
context.receipt_output_digest

context.protocol_capability
context.agent_replacement
context.verbatim_default
context.no_auto_promotion

experiment.preregistered_metrics
experiment.ab_isolation
experiment.metrics_captured

boundary.host_owns_strategy
boundary.agent_has_no_graph_access
boundary.no_memory_reinforcement
boundary.no_llm_summarization
boundary.no_compaction
boundary.no_dispatch_policy
boundary.no_provider_specific_tokenizer
```

No test-count criterion is proposed.

Dedicated Phase 0.7 CI may remain Ubuntu while composed closed gates retain their existing platform requirements.

---

## 27. Proposed implementation order

```text
1. review/freeze docs/phase-0.7-plan.md

2. @alcode/context
   - contracts
   - candidate model
   - cost estimator
   - deterministic selection
   - renderer
   - receipt/evaluation types

3. storage bounded context source snapshot
   - one canonical source cut
   - no raw DB handle

4. Host workspace-context provider port
   - bounded read-only repo/worktree snapshot

5. Host context strategy service
   - verbatim adapter
   - graph-v1 adapter
   - fallback policy

6. context.projection_compiled event
   - canonical receipt
   - critical summary projection using existing projection_receipts table

7. Agent Protocol
   - graph_context_v1 capability
   - context.update

8. Agent worker/core seam
   - replace disposable prefix
   - system appendix
   - current input exactly once

9. deterministic compiler/fallback/rebuild/replacement tests

10. A/B harness + preregistered metric capture

11. gate:0.7 + permanent CI job
```

No Phase 0.8 UI work is implied by this order.

---

## 28. Explicit exclusions

Phase 0.7 does **not** propose:

- making graph context the default;
- automatic graph-mode promotion;
- LLM-generated summarization;
- semantic compression/compaction;
- branch/compaction summaries;
- provider-specific context transforms;
- provider-exact token counting/window enforcement;
- durable system-prompt restoration;
- durable tool-definition restoration;
- provider/model selection restoration;
- vector/dense memory retrieval;
- memory extraction from transcript;
- memory reinforcement merely from context inclusion;
- new reasoning graph semantics or learned ranking policy;
- arbitrary file/diff injection into context;
- pending-input redispatch;
- `START_NOW`, `GUIDE`, or `QUEUE`;
- React/UI projection controls;
- remote Agent transport;
- browser subsystem;
- task/workflow identity;
- subagents or multi-agent orchestration;
- general scheduler/automation.

---

## 29. Proposed closure criterion

This wording is **draft only**:

> **Phase 0.7 closes when a Host-owned `graph-v1` context strategy can compile a deterministic, bounded context from one stable canonical source cut plus a bounded workspace snapshot; required current-task, reasoning, operation, workspace, and recent transcript facts are included without breaking tool-call/result semantics; relevant memories are selected using the closed read-only memory ranking semantics without reinforcement; every graph compilation is represented by an inspectable canonical `context.projection_compiled` receipt and rebuildable critical receipt projection; unsafe/invalid/unsupported graph prerequisites or required-budget overflow use the closed `verbatim-v1` strategy rather than silently dropping required state; a replacement Agent receives only Host-selected disposable context; a preregistered A/B harness captures correctness, cost, inclusion, fallback, and operational metrics without automatically promoting graph mode; verbatim remains the product default; and `pnpm gate:0.7` emits `passed` while composing the closed Phase 0.6 gate.**

Proposed negative proof:

```text
invalid graph source
≠ guessed graph context
→ verbatim fallback

required state > graph budget
≠ silent omission
→ verbatim fallback

context-selected memory
≠ seen
≠ used

Agent replacement
≠ Agent-owned context strategy
```

Proposed positive proof:

```text
stable source cut + current input + workspace snapshot
→ deterministic graph-v1 compile
→ durable receipt
→ replacement/disposable Agent context
→ ModelRequest with selected canonical prefix + durable appendix + current user
```

---

## 30. Draft / authorization boundary

This document is **not frozen acceptance criteria** yet.

Required next step after this documentation draft is architectural review. Any changes from review should be incorporated before the plan is frozen.

Implementation must not begin until the reviewed Phase 0.7 plan is explicitly authorized. Phase 0.8 and graph-default promotion remain unauthorized regardless of Phase 0.7 planning status.
