# ALCODE Phase 1.0 — Design Notes

**Status:** DRAFT / non-normative planning notes  
**Approval:** not approved; not frozen; implementation not authorized  
**Relationship to plan:** these notes inform `docs/phase-1.0-plan.md` but do not change its provisional acceptance criteria unless explicitly promoted into that document and later approved.

## Truthmark study — durable execution implications

### Source reviewed

- Repository: `https://github.com/merlinhu1/truthmark`
- Reviewed `main` at `5050eb0fb7829c974d4cfc8daecb888f44ef8747`
- Published package observed: `truthmark` 2.3.0

Truthmark is not a durable agent runtime. Its product boundary deliberately keeps repository files and Git as the authority and rejects a daemon, database-backed runtime, hidden memory layer, MCP server, or workflow orchestrator as the product center. That makes it architecturally different from ALCODE, where Host-owned canonical events and durable runtime state are intentional foundations.

The useful transfer is therefore not Truthmark's whole architecture. The useful transfer is its authority-narrowing model: explicit ownership, bounded workflow projections, write leases, actual-diff validation, and evidence provenance.

### Key architectural pattern: authority narrowing

Truthmark repeatedly narrows possible authority before an agent writes:

```text
broad repository scope
→ explicit route ownership
→ workflow selection
→ bounded WorkflowState/action context
→ allowed/forbidden write scope
→ optional worker write lease
→ actual checkout diff validation
→ human/Git review
```

Ambiguity generally narrows or blocks authority rather than widening it. Missing ownership can produce routing/manual review instead of granting a broad fallback scope.

This is a strong candidate principle for Phase 1.0:

> Every transition from planning to execution should monotonically narrow authority until one specific current ProgramAttempt is issued.

ALCODE can make that stronger than Truthmark because the narrowed authority can be bound to durable identity, canonical revision, recovery state, and stale-result rejection.

## Proposed Phase 1.0 concept: Attempt Contract / Execution Lease

The current ProgramAttempt proposal should be evaluated as more than an attempt identifier. It can become the durable Host-issued execution contract for one work item.

Provisional shape:

```ts
interface ProgramAttemptContract {
  programStateId: ProgramStateId;
  workItemId: ProgramWorkItemId;
  attemptId: ProgramAttemptId;
  expectedProgramRevision: number;

  objective: string;

  requiredReads: ProgramReadBoundary[];
  allowedReads?: ProgramReadBoundary[];
  allowedWrites: ProgramWriteBoundary[];
  forbiddenWrites: ProgramWriteBoundary[];

  requiredEvidence: ProgramEvidenceRequirement[];
  requiredVerification: VerificationObligationId[];

  operationPolicy: ProgramOperationPolicy;
  expectedReportShape: ProgramAttemptReportContract;
}
```

Names and exact types remain open. The design point is that the Host should be able to answer mechanically:

> Exactly what authority did the current Agent generation receive for this attempt?

The contract should be generated from canonical ProgramState plus current Host policy/observations, then durably tied to the `ProgramAttemptId` admitted by the Host.

### Difference from a Truthmark write lease

Truthmark's lease is primarily a bounded work/write contract that the parent validates against the resulting checkout diff. It is not a durable execution claim.

ALCODE should preserve the useful shape while adding runtime authority:

```text
Truthmark lease
= bounded scope authority

ALCODE ProgramAttempt contract
= bounded scope authority
+ durable ProgramAttemptId
+ ProgramStateId
+ exact expected ProgramState revision
+ Agent generation/request ownership
+ canonical admission
+ stale-result rejection
+ interruption/recovery semantics
+ operation/reconciliation correlation
```

This remains a single-Host claim-validity protocol in Phase 1.0. It does not imply distributed leases, timers, remote workers, or parallel subagents.

## Proposed Agent-facing AttemptProjection

Truthmark's `WorkflowState` is useful as a model for compiling broad state into the smallest workflow-specific context needed for action. ALCODE should consider an equivalent Host-owned `AttemptProjection`.

Conceptually:

```text
canonical ProgramState
+ current workspace observations
+ capability/permission policy
+ operation and reconciliation state
+ current attached execution episode
→ bounded AttemptProjection
→ replaceable Agent
```

The Agent should not need the entire canonical state machine. A projection for the current attempt can include:

- ProgramStateId and exact revision;
- ProgramAttemptId and current work item;
- bounded objective/current-step description;
- dependency facts necessary for the current work;
- unresolved blockers relevant to the attempt;
- required reads/evidence inputs;
- allowed and forbidden mutation surfaces;
- capability/operation constraints relevant to the attempt;
- required verification obligations;
- decisive artifact/evidence references;
- current uncertainty/reconciliation facts that affect whether work may proceed;
- stop conditions.

Prompt text may render this state, but the structured projection remains Host-owned. A replacement Agent receives the same current projection only if the attempt remains valid; otherwise recovery interrupts the old attempt and issues a fresh contract/attempt.

## Attempt authority and write boundaries

Truthmark separates read-only, truth-doc-write, route-write, code-write, and presentation-write modes and validates worker output against allowed/forbidden write paths.

For ALCODE, a similar concept should be evaluated at the Host capability boundary rather than only after the filesystem diff exists.

Possible rules:

1. An attempt contract carries explicit allowed and forbidden mutation boundaries when those boundaries can be determined safely.
2. Capability requests are checked against the current attempt contract in addition to existing capability/policy checks.
3. Off-contract mutation requests fail closed or require a Host-owned contract/amendment transition rather than allowing the Agent to widen its own scope.
4. The actual resulting workspace mutation set can be compared with admitted operation/effect records before accepting an attempt-completion proposal.
5. A report saying `filesChanged = X` is never authority; Host-observed operation/workspace evidence decides what changed.

The existing Phase 1.0 rule that the Agent proposes rather than owns canonical transitions remains intact.

## Evidence provenance and freshness

Truthmark evidence references can bind a claim to repository paths, line ranges, and `sha256:` content hashes. This provides a useful lower-level provenance pattern even though Truthmark deliberately does not provide language-semantic symbol truth.

ALCODE can compose stronger evidence metadata from its existing substrates.

A verification/evidence record should be able to carry both logical freshness and physical provenance, for example:

```text
logical freshness
- verification obligation id
- verification/subject generation
- ProgramState revision admitted against

physical provenance
- Git commit/head when relevant
- workspace revision/snapshot identity
- CodeIntelligence provider revision when relevant
- canonical operation/result event references
- artifact content digest/handle
- affected path set
- optional bounded source span/digest
```

The purpose is not to make every verification language-semantic. The purpose is to make it possible for the Host to determine whether evidence accepted for an earlier subject generation is stale after a later relevant mutation.

This reinforces the current Phase 1.0 proposal for explicit `program.verification.invalidated` semantics or an equivalent generation-based invalidation model.

## Parent/Host acceptance rather than worker self-report

Truthmark's write-worker validation contains a strong general lesson: a worker report is compared with the actual checkout diff, and mismatches can reject acceptance.

ALCODE should apply the same principle at a stronger runtime layer:

```text
Agent proposal/report
≠ canonical fact

Host-observed operations/effects/artifacts/workspace state
+ current ProgramAttempt contract
+ exact ProgramState revision
→ admission decision
```

Potential attempt-completion checks include:

- proposal belongs to the current ProgramStateId;
- attempt id is exactly the current ProgramAttemptId;
- expected revision equals current ProgramState revision;
- Agent generation/request still owns the attempt;
- no off-contract mutation is unresolved;
- reported artifact/evidence references resolve to Host-observed canonical records;
- mandatory verification remains pending until separately satisfied;
- indeterminate operations still block safe acceptance/retry/completion;
- later stale results cannot mutate work after a replacement attempt is current.

## Route ownership versus ALCODE CodeIntelligence

Truthmark route ownership is intentionally explicit and language-neutral. It maps path/glob surfaces to documentation owners and uses route relationships as bounded traceability metadata. It does not maintain import graphs, symbol indexes, or semantic dependency graphs.

ALCODE should not replace Phase 0.9 CodeIntelligence with a Truthmark-style route map. The two answer different questions:

```text
explicit route/ownership metadata
→ who/what owns this area and what human contract is associated with it?

CodeIntelligence observations
→ what code-symbol/provider state is current at this workspace revision?
```

A future design may allow explicit repository ownership metadata to help construct ProgramAttempt boundaries or verification obligations, but CodeIntelligence remains the observation substrate for code semantics where needed.

## Product truth / engineering truth lesson

Truthmark's product/engineering lane separation is useful beyond documentation. It distinguishes external capability promises from implementation realization so internal changes do not accidentally rewrite the product contract.

For ProgramState planning, the analogous lesson is to avoid collapsing all objective text, implementation decomposition, and verification evidence into one mutable blob.

The Phase 1.0 design should continue separating at least:

- immutable objective/completion contract for the ProgramState;
- mutable work decomposition;
- implementation evidence/artifacts;
- verification obligations and satisfaction evidence;
- Host completion decision.

An Agent may propose decomposition changes while planning permits them, but implementation evidence must not silently redefine the objective or completion contract.

## Behavioral evaluation lesson

Truthmark separates deterministic verification from semantic workflow evaluation. Its contributor-only framework uses realistic scenarios, deterministic gates, model/judge evaluation, human review, and token telemetry; deterministic-only results are not treated as proof of workflow quality.

ALCODE should retain two proof classes:

```text
deterministic gates
- identity/state machine correctness
- revision and attempt freshness
- recovery and replay
- operation uncertainty
- write/capability boundaries
- completion exact-once

behavioral evaluations
- Agent chooses the right evidence
- Agent obeys the AttemptProjection without unnecessary scope expansion
- Agent decomposes work usefully
- Agent recognizes blockers/verification needs
- Agent resumes correctly after replacement with bounded context
```

Phase 1.0 acceptance may remain primarily deterministic, but the planning notes should preserve behavioral evaluation as a successor quality layer rather than pretending protocol correctness alone proves agent effectiveness.

## Do not import from Truthmark

The following Truthmark choices are deliberate for its product but should not become Phase 1.0 ALCODE architecture:

- Git checkout as the sole durable execution-state authority;
- absence of a Host-owned canonical runtime state machine;
- post-hoc write-lease checking as a substitute for durable attempt validity;
- path/glob routing as a replacement for language-aware observations;
- workflow-specific subagent declarations as ProgramState semantics;
- semantic correctness delegated entirely to prompt/report text;
- repository-file fallback rules that would bypass ALCODE Host authority.

Subagents remain outside the current Phase 1.0 boundary. If introduced later, they should be one possible executor of a Host-issued ProgramAttempt rather than owners of ProgramState or workflow topology.

## Planning questions opened by this study

1. Should the Phase 1.0 `ProgramAttempt` event carry the complete Attempt Contract, or should it reference a canonical Host artifact containing the bounded contract?
2. Which read/write boundaries are deterministic enough to make normative in Phase 1.0 without introducing a full ProgramModel/code graph?
3. Should off-contract mutation requests always block, or may the Host admit an explicit contract-expansion transition while keeping the same work item but minting a new ProgramAttemptId?
4. What Host-observed evidence is sufficient to compare the declared attempt result with actual workspace effects without creating a second workspace state authority?
5. Should `AttemptProjection` be part of `program_state_v1`, a separate negotiated Agent Protocol capability, or an implementation detail of that projection?
6. Which provenance fields are mandatory for verification freshness in Phase 1.0 and which remain optional adapters to Phase 0.9 CodeIntelligence/Git observations?
7. Can the current provisional structural bounds safely include maximum read/write boundary entries and evidence requirements per attempt?

## Current recommendation

Preserve the existing ProgramState architecture, but evaluate promoting these concepts into the working Phase 1.0 plan before approval:

```text
ProgramState
→ Host-derived bounded Attempt Contract
→ canonical ProgramAttemptId + exact ProgramState revision
→ bounded AttemptProjection to the Agent
→ Host-mediated capabilities under attempt authority
→ Host-observed effect/evidence correlation
→ verification freshness
→ Host-only canonical transition/completion admission
```

This is compatible with the current Phase 1.0 direction and does not require subagents, remote workers, distributed leases, timers, browser execution, or another workflow engine.

## ArtifactRef and inspection seam — Phase 1.0 accommodation

The project-level artifact-rendering study in `docs/artifact-rendering-design-notes.md` exposes a contract issue that Phase 1.0 should accommodate before approval without making rendering itself a Phase 1.0 implementation obligation.

The current ALCODE contracts have an asymmetric content model:

- `@alcode/agent-core` already defines `ImageContent` and permits it in `UserMessage`, but `ToolResultMessage.content` and `AgentToolResult.content` are `TextContent[]`;
- `@alcode/transcript` likewise restricts `TranscriptToolResultMessage.content` and `tool.result.appended` content to transcript text blocks;
- Agent Protocol `tool.result` inherits that transcript restriction, while Host `capability.result.result` remains untyped `unknown`;
- `HostArtifactStore` already provides bounded content-addressed `HostArtifactReference` values with `artifact:sha256:` handles, digest, size, and optional media type;
- context reconstruction consumes durable `Message[]`, so any richer result that must survive Agent replacement has to be representable through canonical transcript replay rather than only through one in-memory Agent generation.

These are implementation facts, not a request to change those packages during planning.

### Minimal durable invariant

Phase 1.0 should avoid freezing a ProgramAttempt or verification contract that assumes decisive capability evidence is necessarily textual.

The minimum planning invariant is:

> A ProgramAttempt and its verification evidence may refer to a Host-retained content-addressed artifact. An inspectable representation delivered to an Agent is a representation of that artifact, not a second artifact authority and not an ephemeral-path identity.

Conceptually:

```text
ProgramAttempt
→ Host-admitted capability invocation
→ HostArtifactStore retention
→ ArtifactRef + provenance
→ negotiated Agent inspection representation
→ Host-observed inspection-delivery fact
→ verification evidence admission
→ ProgramState revision
```

`ArtifactRef` here means the ALCODE-owned content-addressed reference concept already embodied by `HostArtifactReference`; the final public type name and package placement remain open.

### Canonical reference versus Agent representation

The durable result should prefer a stable artifact reference over embedding large visual bytes into canonical ProgramState or transcript events.

A provisional content model to evaluate is:

```ts
type DurableToolResultContent =
  | TextContent
  | ArtifactReferenceContent;
```

An `ArtifactReferenceContent` would identify the admitted Host artifact and enough bounded metadata to validate/materialize it. Exact fields remain open.

Image delivery is a separate Agent Protocol concern:

```text
ArtifactRef
→ Host validates digest/media type/bounds
→ optional Host transformation to an inspectable representation
→ negotiated Agent Protocol delivery
→ Agent inference
```

A vision-capable Agent may receive image content derived from the artifact. An Agent that cannot consume the required representation must not silently satisfy an inspection obligation. The Host should record either successful inspection delivery or an explicit inability/failure path.

This keeps canonical artifact identity independent of any one model/provider encoding while preserving replaceable-Agent semantics.

### Produced artifact versus inspection representation

Phase 1.0 verification should be able to distinguish the artifact produced by a capability from the representation actually inspected by the Agent.

For example:

```text
source subject generation G
→ SVG ArtifactRef R
→ bounded rasterization
→ PNG ArtifactRef I
→ Agent generation A receives I
→ inspection evidence refers to R, I, A, and G
```

`R` and `I` are separate content-addressed artifacts with explicit derivation/provenance. Inspection of `I` does not silently mean the Agent received the original bytes of `R`.

### Minimum provenance needed for verification freshness

The exact provenance schema remains open, but Phase 1.0 should leave room for verification evidence that binds at least:

```text
ProgramStateId
ProgramAttemptId
exact ProgramState revision / verification subject generation
capability or operation identity
produced ArtifactRef
source ArtifactRef/digest or source subject identity when applicable
inspection ArtifactRef when different from produced artifact
Agent generation / delivery identity when inspection is required
transformation identity/version/profile when a derived representation is used
```

These fields do not all need to live directly on the artifact-store record. The important requirement is that canonical evidence can resolve the chain from the current verification obligation to the exact retained content and execution episode that produced or inspected it.

### Freshness must reuse ProgramState invalidation

Artifact rendering and inspection must not introduce an independent freshness doctrine.

If verification satisfaction depends on artifact `R` derived from subject generation `G`, and a later admitted mutation advances the relevant subject generation to `G+1`, evidence tied to `R/G` is stale under the same Phase 1.0 verification-generation/invalidation rules used for other evidence.

Likewise, re-rendering without re-inspection cannot satisfy an obligation whose predicate requires visual inspection, and inspection of an old representation cannot satisfy a newer source generation merely because the old bytes still resolve in `HostArtifactStore`.

The content address proves artifact identity. It does not prove current verification relevance.

### Existing contracts affected by a future implementation

If this seam is later implemented, the change crosses several owned boundaries and must be treated as one durable compatibility change rather than a local tool enhancement:

```text
@alcode/agent-core
  tool-result/message content contract

@alcode/transcript
  tool-result schemas + canonical events

@alcode/agent-protocol
  capability negotiation + delivery encoding

Host capability broker
  typed artifact-bearing results + operation/evidence correlation

HostArtifactStore
  retained content identity and bounded materialization

storage transcript projection/rebuild
  human-readable projection without losing canonical artifact references

context compiler/reconstruction
  replay and budgeting of artifact-bearing results across Agent replacement
```

The existing human-readable transcript projection may continue to summarize artifact-bearing tool results as text, but exact context reconstruction must continue to come from canonical events rather than that projection.

### Phase placement decision for the working design

For planning purposes, the recommended boundary is now:

```text
Phase 1.0 must accommodate:
- ArtifactRef-capable verification/evidence semantics
- ProgramAttempt correlation for artifact-producing operations
- freshness/invalidation of artifact-backed evidence
- an Agent Protocol evolution path that does not assume tool results are permanently text-only

Phase 1.0 does not yet require implementing:
- diagram.validate / diagram.render / artifact.inspect
- a Mermaid compatibility profile
- an ALCODE diagram parser, layout engine, renderer, or rasterizer
- a general renderer catalog
- browser-based rendering
- arbitrary multimodal artifact classes
```

This keeps the ProgramState contract from hardening around a text-only assumption while preventing artifact rendering from expanding the already broad Phase 1.0 implementation scope.

No Phase 1.0 acceptance criterion is changed by this note. Promotion into the working plan remains a separate planning decision, and implementation remains unauthorized until the Phase 1.0 plan is explicitly approved.

### Additional planning questions

8. Should the first durable artifact-bearing tool-result shape carry only a `HostArtifactReference`, or also a bounded semantic role such as `output`, `preview`, or `evidence`?
9. Which provenance fields belong in ProgramState verification evidence versus operation/evidence events versus an artifact metadata projection?
10. What Agent Protocol capability token should advertise inspectable artifact/image delivery without coupling the Host to a specific model-provider encoding?
11. What is the required fail-closed behavior when canonical replay resolves an ArtifactRef but the current Agent cannot consume the representation required by an unsatisfied verification obligation?
12. Does Phase 1.0 need a normative inspection-delivery event/fact, or is correlation through an existing canonical operation/result plus Agent request/generation identity sufficient?

### Updated recommendation

Preserve the current authority pipeline and make artifact-backed evidence an allowed future payload, not a separate authority path:

```text
ProgramState
→ Host-derived bounded Attempt Contract
→ canonical ProgramAttemptId + exact ProgramState revision
→ bounded AttemptProjection to the Agent
→ Host-mediated capabilities under attempt authority
→ HostArtifactStore retention where capability output is non-text/derived
→ ArtifactRef + Host-observed provenance
→ negotiated Agent inspection representation when required
→ verification freshness / invalidation
→ Host-only canonical transition/completion admission
```

The first rendering consumer can be designed later as an ALCODE-owned capability. External implementations may inform parser/IR/layout/render patterns, but they do not become runtime authority, compatibility authority, or required dependencies.
