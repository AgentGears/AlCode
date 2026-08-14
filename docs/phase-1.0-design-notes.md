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
