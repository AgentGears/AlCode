# Phase 0.6 — Durable verbatim context reconstruction

Status: **FROZEN DESIGN — NOT STARTED**. Implementation requires explicit authorization.

Baseline: documentation-synchronized `main` after Phase 0.5 closure (`96643e6`).

This plan defines the Phase 0.6 implementation and acceptance boundary. It incorporates the architectural review of the initial plan. The central correction is that durable transcript reconstruction is not sufficient by itself: **before any subsequent model request, every prior non-user conversational message must have crossed a Host-acknowledged canonical transcript-admission barrier.**

Phase separation is frozen as:

```text
0.6 = reconstruct what the model previously saw
0.7 = decide what the model should see
0.8 = decide when newly admitted input is dispatched
```

No Phase 0.7 or 0.8 policy is pulled into this phase.

---

## 1. Objective

Phase 0.6 establishes the safe verbatim context baseline:

> At every `ModelProvider.stream()` boundary, the Host can reconstruct the request's prior provider-visible conversational prefix entirely from canonical durable state, independent of the old Host/Agent process.

The load-bearing invariant is stronger:

> **Immediately before every `ModelProvider.stream()` invocation, every message in the request's prior conversational prefix has either (a) originated from a Host-canonical user event or (b) crossed a serialized, Host-validated, Host-acknowledged canonical transcript-admission barrier.**

Therefore:

```text
next ModelRequest
⇒ every prior conversational message is reconstructable
```

The equivalence target is specifically:

```text
ModelRequest.messages
```

Phase 0.6 does **not** claim durable equivalence of the complete model-request environment. System prompt, tool definitions, provider/model selection, and provider-specific HTTP transformations remain outside this phase.

---

## 2. Current gaps being closed

The current durable transcript retains only text user/assistant events. Structured assistant tool calls are lost by the Agent forwarding path, and tool-result messages exist only in the Agent's ephemeral conversational state.

The existing replacement bootstrap sends session identity, system prompt, orientation requirement, and tool names, but no durable message history. The owned Agent loop also starts each run from a fresh user-only message array.

Phase 0.6 closes exactly these gaps without changing Host ownership established in 0.5.

---

## 3. Guaranteed durable vocabulary

The Phase 0.6 guarantee is deliberately narrower than every message type present in the TypeScript contracts.

Guaranteed durable/provider-visible vocabulary:

```text
User
  text

Assistant
  text
  toolCall

ToolResult
  text
```

Images/attachments are not part of the 0.6 durable-context guarantee even though `ImageContent` exists in the owned Agent types.

The canonical transcript-domain event vocabulary remains small:

```text
user.message.appended
assistant.message.appended
tool.result.appended
```

The existing user/assistant event names are retained. No generic `transcript.message` event is introduced.

---

## 4. `@alcode/transcript`

Add a semantic package:

```text
packages/transcript/
  src/
    messages.ts
    events.ts
    reducer.ts
    validation.ts
    index.ts
```

`@alcode/transcript` owns:

- durable transcript payload schemas;
- transcript message schemas;
- deterministic transcript reduction;
- transition validation;
- completeness analysis;
- reconstruction fidelity classification.

It does **not** own:

- SQLite;
- canonical event admission;
- Host lifecycle;
- Agent processes;
- provider adapters;
- graph/context selection;
- memory or reasoning semantics.

Storage and Host remain canonical authority.

---

## 5. Canonical transcript payloads

### 5.1 User message

Existing text semantics remain compatible. New 0.6 admissions include the exact conversational timestamp explicitly.

```ts
interface UserMessageAppendedPayload {
  text: string;
  timestamp?: number; // required for newly admitted 0.6-rich history
}
```

Pre-0.6 events without `timestamp` remain readable as legacy history.

### 5.2 Assistant message

Preserve the existing `text` compatibility field and add the structured representation currently lost by durability:

```ts
interface AssistantMessageAppendedPayload {
  text: string;

  content?: Array<
    | { type: "text"; text: string }
    | {
        type: "toolCall";
        id: string;
        name: string;
        arguments: JsonValue;
      }
  >;

  stopReason?: "stop" | "length" | "tool_use" | "error" | "aborted";
  errorMessage?: string;
  timestamp?: number;
}
```

For every newly admitted rich 0.6 assistant event:

```text
text == concat(content[type=text].text)
```

A mismatch is rejected **before canonical append**.

Legacy `text`-only assistant events remain valid and reconstruct as legacy text history.

### 5.3 Tool result

Add the missing transcript-domain fact:

```ts
interface ToolResultAppendedPayload {
  toolCallId: string;
  toolName: string;
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  timestamp: number;
}
```

`AgentToolResult.details` are not part of provider-visible transcript durability and are not persisted merely because they exist in the execution result object.

`operation.completed` remains execution/recovery truth. `tool.result.appended` is conversational/model-context truth.

---

## 6. Serialized transcript admission barrier

This is the primary architectural amendment from review.

An Agent-side `transport.send()` only proves handoff to the IPC subsystem. It does not prove Host receipt, semantic validation, canonical append, or critical projection catch-up.

Therefore assistant and tool-result transcript writes become request/acknowledgement operations.

```text
Agent
  │
  │ assistant.message / tool.result
  ▼
Host
  │
  ├─ enter CanonicalAdmissionQueue critical section
  ├─ capture stable canonical head/state
  ├─ reduce transcript through that head
  ├─ validate proposed transition
  ├─ append canonical event with durable idempotency
  ├─ catch up the critical transcript projection
  └─ return transcript.admitted
  │
  ▼
Agent may continue
```

Protocol acknowledgement:

```ts
interface TranscriptAdmitted {
  type: "transcript.admitted";
  requestId: string;
  sessionId: string;
  eventId: string;
  sequence: number;
}
```

**Validation and append are one serialized Host admission operation.** A separate read-validate-append sequence is forbidden because it permits TOCTOU interleaving.

The hard rule is:

```text
no transcript ACK
⇒ no next model request
```

For an assistant message containing a tool call, ACK also occurs before the Agent begins that tool execution.

For a tool-result message, ACK occurs before the loop may begin the next provider request.

---

## 7. Crash semantics of transcript admission

The following cuts are frozen:

### Before Host append

```text
Agent sends transcript request
→ Host dies before append
→ no ACK
→ Agent must not advance to subsequent inference
```

### After append, before ACK

```text
Host appends canonical transcript event
→ Host dies before ACK
→ replacement Host reconstructs the message from canonical state
```

### Duplicate delivery

A logical retry uses the same `requestId`.

```text
generationId + requestId
→ stable transcript idempotency key
→ one canonical event
→ same durable acknowledgement semantics
```

### After ACK

ACK proves that the message is durably reconstructable. Subsequent inference may proceed.

These cuts apply independently to assistant-message admission and tool-result admission.

---

## 8. Pre-append transcript semantic validation

Any invariant capable of invalidating a canonical transcript transition is checked before the event enters the append-only log.

Validation occurs inside the serialized transcript-admission critical section against transcript state reduced through the captured stable head.

Frozen invariants:

- canonical source sequence is strictly ordered;
- rich assistant `text` matches concatenated text blocks;
- assistant tool-call IDs are unique within the session;
- a tool result references a previously admitted unresolved assistant tool call;
- the tool-result tool name matches the corresponding call;
- one provider-visible result resolves a call at most once;
- malformed/unknown rich transcript payloads fail closed;
- duplicate protocol delivery is handled by idempotency, not by appending a second logical message.

Defense-in-depth reducer validation remains active during replay, but canonical admission must reject invalid transitions first.

```text
invalid transcript transition
⇒ no canonical event
```

---

## 9. End-to-end tool-call identity

Phase 0.6 removes the current split between the model's tool-call ID and a separately minted Host-proxy tool-call ID.

Freeze:

```text
assistant.toolCall.id
        =
ToolExecutionContext.toolCallId
        =
capability.request.toolCallId
        =
capability.result.toolCallId
        =
tool.result.toolCallId
```

`operationId` remains a distinct Host-owned durable execution identity:

```text
T1  conversational/action identity
 │
 └── O17  environmental operation identity
```

Required additive Agent-core seam:

```ts
interface ToolExecutionContext {
  signal?: AbortSignal;
  workingDirectory?: string;
  toolCallId?: string;
}
```

`runAgentLoop()` supplies the model's actual `tc.id`. The protocol proxy forwards that ID instead of minting a replacement.

The Host may add `toolCallId` as an additive field to operation/action payloads so the durable execution chain can be audited without conflating `toolCallId` and `operationId`.

When the Host can prove the association, a `tool.result.appended` event may carry the corresponding `operationId` in the canonical event envelope. `operationId` never enters provider-visible `ToolResultMessage` content.

---

## 10. Stable transcript snapshot

Extend the bounded Host/storage read model with a stable-head snapshot:

```ts
interface TranscriptSnapshot {
  sourceEventSequence: number;
  messages: TranscriptMessage[];
  status: "complete" | "incomplete";
  pendingToolCallIds: string[];
  fidelity: "exact" | "legacy_text_only";
}

getTranscriptSnapshot(
  sessionId: string
): Promise<TranscriptSnapshot>;
```

Construction:

```text
read canonical head N once
→ read verified events <= N
→ filter session transcript events
→ deterministically reduce
→ analyze pending tool calls
→ classify fidelity
→ return messages + sourceEventSequence=N
```

No independent head/transcript reads that can observe different histories.

The existing stable-head event batching pattern remains the basis; no new raw database snapshot abstraction is required.

---

## 11. Reconstructable versus continuable

An incomplete transcript is valid historical state and must be reconstructable.

Example:

```text
U1
Assistant(T1)
<crash before ToolResult(T1) admission>
```

Reconstruction returns:

```text
messages = [U1, Assistant(T1)]
status = incomplete
pendingToolCallIds = [T1]
```

But incomplete history is **not continuable** in Phase 0.6:

```text
status = incomplete
⇒ no ModelProvider.stream()
```

Phase 0.6 must not:

- automatically retry T1;
- fabricate a tool result;
- synthesize `No result provided`;
- silently discard the outstanding call;
- queue/redispatch a later user input.

The Host fails closed before new transcript/model continuation. Future Phase 0.8 owns operational policy for unresolved/pending input and dispatch semantics.

This preserves:

```text
0.6: Can exact history be reconstructed, and is it safe to continue?
0.8: If it is not safe to continue, what operational policy applies?
```

---

## 12. No schema v8

Phase 0.6 does not change the workspace schema version.

Exact verbatim context is reduced from canonical events. The existing `transcript_messages` table remains an intentionally simpler human-readable/critical projection.

It may materialize textual bodies such as:

```text
user       → text
assistant  → concatenated assistant text
toolResult → textual result body
```

It is **not** exact-context authority.

This avoids dual truth between rich event JSON and a second rich SQLite transcript representation, and avoids a migration whose sole purpose would be canonical-data duplication.

---

## 13. Agent Protocol extension

Keep `AGENT_PROTOCOL_VERSION = 1` because the message changes are structurally additive, but exact 0.6 behavior requires explicit capability negotiation.

A new worker advertises:

```text
durable_transcript_v1
```

That capability means the worker supports:

- rich assistant transcript messages;
- tool-result transcript messages;
- `transcript.admitted` acknowledgement semantics;
- verbatim context hydration;
- the no-next-request-before-ACK invariant.

A Phase 0.6 Host must not claim exact durable transcript continuity with an Agent that does not advertise `durable_transcript_v1`.

### Rich assistant protocol message

Extend `assistant.message` additively:

```ts
{
  type: "assistant.message";
  requestId: string;
  sessionId: string;
  text: string;
  content: AssistantMessage["content"];
  stopReason: AssistantMessage["stopReason"];
  errorMessage?: string;
  timestamp: number;
}
```

It is sent for every completed assistant message, including tool-call-only responses.

### Tool-result protocol message

```ts
{
  type: "tool.result";
  requestId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  timestamp: number;
}
```

### Canonical user timestamp

Extend `input.admitted` additively with:

```ts
timestamp: number
```

The Host derives it from the canonical user-message admission and the Agent uses that exact timestamp in its local user message.

### Context hydration

Extend `context.provide`:

```ts
interface VerbatimContext {
  compilerVersion: "verbatim-v1";
  sourceEventSequence: number;
  messages: Message[];
  status: "complete" | "incomplete";
  pendingToolCallIds: string[];
  fidelity: "exact" | "legacy_text_only";
}

interface ContextProvide {
  // existing 0.5 fields
  systemPrompt: string;
  orientationRequired: boolean;
  toolNames: string[];

  verbatim: VerbatimContext;
}
```

No persisted context receipt or projection toggle is introduced in 0.6.

---

## 14. Agent-core history seam

Extend the existing loop additively:

```ts
interface AgentLoopOptions {
  // existing fields
  initialMessages?: readonly Message[];
  promptTimestamp?: number;
}
```

The loop uses a defensive copy:

```text
copy(initialMessages)
+
new user message with promptTimestamp
```

When omitted, the closed Phase 0.1A behavior remains unchanged.

Tool-result messages gain normal message lifecycle emission so the Agent-side transcript adapter receives the exact conversational object instead of reconstructing it from execution details.

The event sink is awaited such that **before the next `provider.stream()`, every prior local message has crossed the durable admission barrier**.

---

## 15. Disposable Agent history

The replaceable Agent worker becomes:

```text
context.provide
      ↓
history = durable verbatim messages

input.admitted
      ↓
runAgentLoop(
  newInput,
  initialMessages = history,
  promptTimestamp = canonical timestamp
)
      ↓
history = returned full messages
```

The in-process history cache is disposable optimization only.

Hard boundary:

```text
no Agent-local transcript/checkpoint file
no Agent-owned resume database
no Agent canonical conversation state
```

A replacement Agent starts empty and must be hydrated from Host-provided durable context.

---

## 16. Host continuation guard

The Host owns the verbatim context compiler and checks transcript completeness before allowing continuation.

For a complete transcript:

```text
canonical transcript snapshot
→ context.provide(verbatim-v1)
→ input.admitted
→ Agent constructs canonical-timestamp user message
→ ModelProvider.stream()
```

For an incomplete transcript:

```text
canonical transcript snapshot
→ status=incomplete
→ surface context_incomplete / pending toolCallIds
→ no new model request
```

Phase 0.6 does not invent input queue semantics to preserve the later 0.8 boundary.

---

## 17. Pi parity oracle

The existing pinned reference remains:

```text
earendil-works/pi
v0.81.1
20be4b18d4c57487f8993d2762bace129f0cf7c6
```

The Phase 0.6 semantic parity oracle is pi coding-agent `convertToLlm()` for the message vocabulary shared with ALCODE.

The comparison boundary is:

```text
ALCODE ModelRequest.messages
at ModelProvider.stream()
```

It is **not** provider-specific HTTP JSON.

Do not port or test pi-ai `transformMessages()` as part of Phase 0.6. Image downgrade, provider/model-specific thinking handling, provider tool-call ID normalization, and provider synthetic-result repair remain outside the phase.

Frozen parity families:

```text
1. user text
2. assistant text
3. assistant tool-call only
4. assistant text + tool call
5. successful tool result
6. failed tool result
7. multiple sequential tool calls/results
8. multi-turn conversation
```

Parity equality is structural/deep equality over the shared representation, including where applicable:

- role;
- content block order;
- tool-call ID;
- tool name;
- arguments;
- `isError`;
- stop reason;
- error message;
- timestamp.

Do not add pi-only custom/bash/branch/compaction roles merely to broaden fixture coverage.

---

## 18. Legacy history doctrine

Information never persisted before 0.6 cannot be reconstructed.

Legacy user/assistant text remains readable deterministically. Missing historical tool calls/results are never fabricated.

Compiler/snapshot fidelity is explicit:

```text
exact
legacy_text_only
```

The exact Phase 0.6 guarantee begins with history admitted under the rich transcript contract.

Legacy support is compatibility, not a claim of recovered information that never existed canonically.

---

## 19. Signature Phase 0.6 proof

Use the real Host, locked SQLite workspace, child-process Agent, protocol, canonical admission, and deterministic scripted provider.

```text
1. Host H1 opens session S.
2. Agent A receives canonical user U1.
3. Provider sees [U1].
4. Agent A produces Assistant(T1).
5. Agent sends rich assistant transcript request.
6. Host validates + canonically appends Assistant(T1).
7. Host returns transcript ACK.
8. Agent executes T1 using toolCallId=T1.
9. Host executes operation O1 and returns CapabilityResult(T1,O1).
10. Agent constructs ToolResult(T1,R1).
11. Host validates + canonically appends ToolResult(T1,R1).
12. Host returns transcript ACK.
13. Provider follow-up sees:
      U1
      Assistant(T1)
      ToolResult(T1,R1)

14. Terminate Agent A.
15. Terminate Host H1 without stopping session S.
16. Host H2 reopens workspace/session S and runs normal recovery.
17. Host reconstructs verbatim-v1 from canonical state only.
18. Agent B starts with empty process memory.
19. context.provide hydrates:
      U1
      Assistant(T1)
      ToolResult(T1,R1)
20. Admit U2.
21. Agent B's next ModelRequest is:
      U1
      Assistant(T1)
      ToolResult(T1,R1)
      U2
22. Agent B continues successfully.
```

Assertions:

```text
same session ID
same durable message prefix
same toolCallId end to end
same tool-result pairing
same prior roles/content/order/timestamps
same reconstructed output after close/reopen
Agent generation changed
Host instance changed
no Agent-local transcript file
no duplicate transcript events
```

---

## 20. Required crash/recovery matrix

### Assistant transcript admission

Inject failure at:

```text
provider produced assistant
├─ before Agent→Host send
├─ after send / before canonical append
├─ after append / before ACK
└─ after ACK
```

Required result:

```text
before ACK  → no subsequent provider request
after append → replacement reconstructs assistant
```

### Tool-result transcript admission

Run the same four cuts for `tool.result`.

### Projection lag

```text
canonical transcript event appended
→ critical projection not yet caught up
→ Host dies
→ reopen
→ projection catches up
→ verbatim compiler still reconstructs from canonical events
```

### Agent death

```text
ACK received
→ Agent dies before next provider request
→ replacement Agent receives exact durable message
```

### Orphaned tool call

```text
Assistant(T1) durably ACKed
→ Agent/Host interruption before ToolResult(T1)
→ reopen
→ exact incomplete history reconstructed
→ pendingToolCallIds=[T1]
→ continuation blocked
→ no synthetic result
→ no automatic replay
```

---

## 21. Other required integration tests

### Canonical roundtrip

```text
canonical events
→ snapshot A
→ close/reopen
→ snapshot B
→ A == B
```

### Projection rebuild

Delete derived transcript rows/cursor, replay, and prove the human-readable projection is equivalent while the verbatim compiler remains canonical-event based.

### Duplicate protocol delivery

```text
same generation + requestId delivered twice
→ one canonical transcript event
→ stable acknowledgement semantics
```

### Tool pairing

Prove:

```text
one call / one result
multiple sequential calls
failed result
unknown result ID rejected before append
mismatched tool name rejected before append
duplicate logical result idempotent/rejected without second event
```

### Rich text consistency

Reject assistant events where compatibility `text` differs from concatenated rich text blocks.

### Legacy text

Pre-0.6 text-only user/assistant history reconstructs deterministically and reports `legacy_text_only` fidelity.

---

## 22. Implementation order

Frozen order:

```text
1. docs/phase-0.6-plan.md
   - amended invariant
   - exact vocabulary
   - ACK semantics
   - incomplete-history doctrine
   - protocol capability
   - legacy fidelity doctrine

2. @alcode/transcript
   - schemas
   - canonical event payloads
   - reducer
   - transition validator
   - completeness/fidelity analysis

3. agent-core
   - initialMessages
   - promptTimestamp
   - ToolExecutionContext.toolCallId
   - tool-result message lifecycle events

4. agent-protocol
   - rich assistant.message
   - tool.result
   - transcript.admitted
   - canonical input timestamp
   - verbatim context snapshot
   - durable_transcript_v1 capability

5. cognition extension
   - full assistant forwarding
   - exact tool-result forwarding
   - await transcript ACK
   - preserve model toolCallId

6. Host transcript admission
   - serialized validation + append
   - deterministic idempotency
   - critical catch-up
   - ACK only after durability

7. storage/read models
   - stable-head transcript snapshot
   - rich canonical reduction
   - completeness + fidelity metadata
   - human-readable projection remains derived

8. Host verbatim compiler
   - compilerVersion=verbatim-v1
   - deterministic validation
   - complete/incomplete continuation guard
   - context.provide integration

9. Agent worker hydration
   - durable context → initialMessages
   - disposable local history cache
   - no provider request from incomplete history

10. pinned pi convertToLlm oracle + deep parity fixtures

11. transcript-admission crash-cut integration proofs

12. full Host A→B / Agent A→B replacement/reopen proof

13. gate:0.6 + Ubuntu CI
```

No parallel workstream or successor-phase work is implied by this ordering.

---

## 23. `gate:0.6`

`gate:0.6` composes the closed `gate:0.5` unchanged.

Frozen receipt proof set:

```text
phase0.gate_composition                  PASS

transcript.typecheck                     PASS
transcript.tests                         PASS
agent_protocol.typecheck                 PASS
agent_core.typecheck                     PASS
host_runtime.typecheck                   PASS
coding_agent.typecheck                   PASS

pi.verbatim_oracle                       PASS
verbatim.user                            MATCH
verbatim.assistant                       MATCH
verbatim.tool_call                       MATCH
verbatim.tool_result                     MATCH
verbatim.multi_turn                      MATCH

transcript.preappend_validation          PASS
transcript.rich_text_consistency         PASS
transcript.admission_ack                  PASS
transcript.canonical_roundtrip           PASS
transcript.tool_pairing                  PASS
transcript.duplicate_delivery            PASS
transcript.close_reopen                  PASS
transcript.projection_rebuild            PASS

identity.tool_call_end_to_end             PASS
protocol.rich_transcript_capability       PASS

context.stable_source_sequence            PASS
context.durable_admission_barrier         PASS
context.no_request_before_ack             PASS
context.agent_replacement                 PASS
context.host_reopen                       PASS
context.no_ephemeral_history              PASS
context.continuation                      PASS
context.orphan_reconstruction             PASS
context.orphan_continuation_blocked       PASS
context.no_synthetic_tool_result          PASS

legacy.text_only_reconstruction           PASS
legacy.fidelity_reported                  PASS

boundary.host_owns_context                PASS
boundary.agent_has_no_transcript_store    PASS
boundary.no_graph_selection               PASS
boundary.no_compaction                    PASS
boundary.no_provider_specific_transform   PASS
```

No test-count criterion is frozen.

Dedicated 0.6 CI may remain Ubuntu; existing composed CI continues preserving all closed tri-platform gates.

---

## 24. Explicit exclusions

Phase 0.6 does **not** include:

- graph/context relevance selection;
- reasoning or memory injection into model context;
- graph projection receipts;
- token budgeting or token estimation;
- compaction or summarization;
- branch summaries;
- pi custom message roles;
- provider/model-specific `transformMessages` behavior;
- durable system-prompt restoration;
- durable tool-definition restoration;
- provider/model selection restoration;
- image/attachment durability expansion;
- thinking/reasoning block expansion beyond the owned 0.6 vocabulary;
- steering/follow-up queues;
- pending-input redispatch;
- `START_NOW` / `GUIDE` / `QUEUE`;
- task/workflow identity;
- application/UI protocol;
- context A/B evaluation;
- making graph context default;
- remote Agent transport;
- multi-agent/subagent orchestration.

Most importantly:

```text
0.6 = reconstruct what the model previously saw
0.7 = decide what the model should see
0.8 = decide when newly admitted input is dispatched
```

---

## 25. Frozen closure criterion

> **Phase 0.6 closes when ALCODE canonically represents the Phase 0.6 conversational vocabulary—text user messages, assistant text/tool calls, and textual tool results—and every non-user message must cross a serialized, Host-validated, Host-acknowledged durable transcript-admission boundary before any subsequent `ModelProvider.stream()` invocation. A Host-owned `verbatim-v1` compiler must reconstruct the prior `ModelRequest.messages` prefix deterministically from a stable canonical event sequence; provider tool-call identity must remain continuous through Host capability execution and the corresponding tool result; incomplete histories must be reconstructable but fail closed for further inference without replay or fabrication; replacement of both Host and Agent must preserve the same complete durable prefix without Agent-local transcript state; shared-message behavior must match the pinned pi `convertToLlm` oracle; legacy text history must remain readable with explicit reduced-fidelity status; and `pnpm gate:0.6` must emit `passed` while composing the closed Phase 0.5 gate.**

Executable negative proof:

```text
no transcript ACK
⇒ no next model request

invalid transcript transition
⇒ no canonical event

outstanding tool call
⇒ exact/incomplete history reconstructed
⇒ continuation blocked
⇒ no replay or fabricated result

replacement Agent
⇒ no reliance on prior process memory
```

Executable positive proof:

```text
canonical transcript
→ close Host + Agent
→ reopen Host
→ reconstruct verbatim-v1
→ hydrate empty replacement Agent
→ next ModelRequest contains same complete durable prefix
→ continue
```

---

## 26. Authorization boundary

This document freezes the Phase 0.6 design and acceptance criteria only.

Implementation has **not** started and must not begin until explicitly authorized. No Phase 0.7 or 0.8 work is authorized by this plan.
