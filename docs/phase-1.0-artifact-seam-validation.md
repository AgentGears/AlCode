# ALCODE Phase 1.0 — Artifact Seam Contract Validation

**Status:** DRAFT / non-normative planning validation  
**Approval:** not approved; not frozen; implementation not authorized  
**Repository base studied:** `main` at `126d6fb28c66707083a9a93af3e0e4241e505617`  
**Relationship to Phase 1.0:** evaluates which artifact-seam invariants are required for Phase 1.0 correctness. It does not itself amend `docs/phase-1.0-plan.md`, change any AC-10 criterion, or authorize artifact/rendering implementation.

## 1. Question under study

`docs/phase-1.0-artifact-seam-decisions.md` identified four candidate semantic invariants for possible promotion into the governing Phase 1.0 plan:

1. artifact-backed evidence is first-class;
2. inspection delivery is explicit when relied upon;
3. capability mismatch fails closed for required inspection;
4. artifact freshness reuses ProgramState verification freshness.

This document tests those candidates as a **contract proof exercise**.

The promotion criterion is deliberately strict:

> Promote an invariant into the Phase 1.0 governing plan only when omitting it creates a correctness hole in a guarantee Phase 1.0 already claims to provide.

If Phase 1.0 remains correct without implementing or normatively requiring the behavior, the invariant should remain an accommodated successor requirement rather than expanding the Phase 1.0 contract.

## 2. Result

The study outcome is:

| Candidate invariant | Decision | Reason |
|---|---|---|
| Artifact-backed evidence is first-class | **PROMOTE** | Phase 1.0 already models decisive artifact references, canonical evidence, attempt correlation, verification satisfaction, and Host-only completion. Without an explicit artifact/evidence distinction, artifact existence can be confused with admissible current evidence. |
| Inspection delivery is explicit when relied upon | **ACCOMMODATE / DEFER** | The semantic rule is correct, but current Phase 1.0 does not require artifact inspection, multimodal delivery, a renderer, or an inspection-dependent verification predicate. No current AC-10 proof requires a delivery fact. |
| Capability mismatch fails closed for required inspection | **ACCOMMODATE / DEFER** | This is mandatory once inspection-dependent verification exists, but current Phase 1.0 can remain correct without implementing `artifact_inspection_v1` or any equivalent visual path. |
| Artifact freshness reuses verification freshness | **PROMOTE** | Allowing artifact evidence to escape the existing verification subject-generation rule would directly violate AC-10-07 and could let the Completion Oracle rely on stale evidence. |

No candidate is rejected. Two belong in the Phase 1.0 semantic contract; two remain mandatory successor constraints if/when inspection becomes an executable verification mechanism.

A derived clarification should accompany any plan amendment:

> Phase 1.0 `artifact_present` means only that the required Host artifact is present according to its deterministic criterion. It does not imply that an Agent inspected the artifact or that the artifact is semantically correct.

This prevents the closed `CompletionCriterion` taxonomy from becoming an accidental visual-verification bypass.

## 3. Repository facts used in the proof

The study uses the current repository behavior and the current draft plan rather than assuming the future artifact seam is already implemented.

### 3.1 Current Phase 1.0 draft already admits artifact/evidence semantics

`docs/phase-1.0-plan.md` already proposes that ProgramState contains decisive evidence/artifact references, that work items may carry produced Host artifact handles, and that `CompletionCriterion` may include both `artifact_present` and `canonical_evidence_accepted` as distinct predicates.

The same plan requires:

- exact ProgramAttempt/revision validity;
- mechanically lossless ProgramState/ProgramAttempt correlation for attempt-originated operations;
- verification satisfaction indexed by the current verification subject generation;
- stale verification invalidation after relevant mutation;
- Host-only serialized completion from canonical state/evidence.

Therefore artifact references are not a wholly separate future concept. They already intersect the proposed Phase 1.0 correctness model.

### 3.2 HostArtifactStore is content-addressed byte authority

`packages/host-runtime/src/artifact-store.ts` retains bounded content by SHA-256 and returns:

```ts
interface HostArtifactReference {
  handle: string;
  digest: string;
  size: number;
  mediaType?: string;
}
```

with `artifact:sha256:` handles.

This proves content identity. It does not encode ProgramAttempt ownership, verification freshness, semantic acceptance, or Agent inspection.

### 3.3 Current canonical operation evidence is Host-admitted

`packages/host-runtime/src/capability-broker.ts` currently records Host-owned operation lifecycle and `evidence.recorded` facts around capability execution. The present payload captures operation/tool/outcome and stdout/stderr-oriented evidence, but no artifact output provenance yet.

The relevant architectural property already exists:

```text
capability request
→ Host operation.requested / operation.started
→ capability executes
→ Host operation.completed + evidence.recorded
→ optional verification correlation
```

A future artifact-bearing operation can extend this canonical evidence path rather than inventing another authority.

### 3.4 Current durable transcript is text-only for tool results

`@alcode/transcript` currently permits only text blocks in `TranscriptToolResultMessage.content`. `@alcode/agent-core` likewise has `ImageContent` for user/model input but keeps tool-result content text-only.

Agent Protocol v1 inherits the transcript tool-result type. Therefore current Phase 1.0 cannot accidentally be treated as already providing durable visual inspection.

### 3.5 Agent Protocol already negotiates capabilities

`packages/agent-protocol/src/messages.ts` exposes `agent.hello` with `capabilities: string[]` and currently defines negotiated capabilities including `durable_transcript_v1`, `graph_context_v1`, and `dynamic_capability_binding_v1`.

This gives a future artifact inspection feature a natural negotiated boundary, but capability negotiation alone is not evidence that a representation was actually consumed by model inference.

### 3.6 The existing context receipt is not an inspection-delivery proof

This is a decisive current-code observation.

`HostContextService.refresh()` appends canonical `context.projection_compiled` before returning the `context.update` message. The receipt therefore proves what the Host compiled for delivery.

`HostRuntime.handleAgentMessage()` then calls `transport.send(update)` inside a `try` block. If transport send fails, the exception is swallowed with the explicit comment:

```text
The receipt is canonical; a replacement Agent asks for a fresh decision.
```

Therefore:

```text
context.projection_compiled
≠ transport delivery succeeded
≠ Agent runtime accepted representation
≠ representation entered provider/model inference
```

The existing context receipt cannot be reused as proof of Agent inspection without changing its semantics.

### 3.7 Canonical transcript tool results are Agent-originated reports

`TranscriptAdmissionService.admitToolResult()` admits a durable `tool.result.appended` from a specific Agent generation and protects it with canonical transition validation/idempotency.

That is valuable transcript truth, but it is still the Agent runtime reporting a tool result. It is not a substitute for Host-owned capability operation/evidence provenance when ProgramState verification depends on what actually happened environmentally.

### 3.8 Current event envelope has no ProgramState identity yet

The current `EventDraft` envelope carries WorkspaceId, SessionId, optional OperationId, causation, and correlation. ProgramStateId is still a Phase 1.0 proposal.

This means artifact evidence must compose with the planned ProgramState/ProgramAttempt correlation work rather than being bolted onto current events independently.

## 4. Canonical ownership matrix

The artifact seam is correct only if each important fact has one canonical owner and other domains refer to it.

| Fact | Canonical owner | What it proves | What it does not prove |
|---|---|---|---|
| Artifact bytes and SHA-256 identity | HostArtifactStore | exact retained content identity | who produced it, whether it is current evidence, whether Agent inspected it |
| Capability operation produced/derived an artifact | canonical operation/evidence events | production/derivation under a Host operation | verification acceptance/currentness |
| Operation belongs to ProgramAttempt | ProgramState/Attempt correlation on canonical operation/evidence path | execution authority and attempt provenance | artifact semantic correctness |
| Verification evidence was accepted | ProgramState verification transition | Host accepted referenced canonical evidence for a subject generation | permanent freshness |
| Verification is current | ProgramState verification reducer | satisfaction matches current subject generation | whether bytes still need materialization for a new inspection |
| Representation was supplied to a model inference | future generic inspection-delivery fact | exact delivery provenance | semantic understanding/correct interpretation |
| Human transcript rendering of artifact result | derived transcript projection | readable summary | exact artifact identity/replay or inspection |
| Program completed | ProgramState / Completion Oracle | all current canonical predicates were true at serialized completion cut | arbitrary model claim of completion |

The intended authority chain is:

```text
HostArtifactStore
  bytes/content identity
        │
        ▼
canonical operation/evidence
  production + derivation + attempt correlation
        │
        ▼
ProgramState verification
  current acceptance + subject generation
        │
        ▼
Completion Oracle
  serialized terminal decision
```

Future inspection adds a runtime delivery fact between artifact provenance and verification acceptance; it does not become a second ProgramState authority.

## 5. Candidate 1 — artifact-backed evidence is first-class

### 5.1 Required Phase 1.0 guarantee

Phase 1.0 claims that ProgramState can hold decisive evidence/artifact references, that attempt-originated operations are correlated, that verification is Host-accepted and state-indexed, and that Completion Oracle decisions are made from canonical evidence.

Those guarantees must remain true when the decisive evidence is a Host artifact rather than text/stdout.

### 5.2 Counterexample if omitted

Consider:

```text
Program P, work W, current Attempt A
→ Host capability produces artifact R
→ R is retained in HostArtifactStore
→ Attempt A is interrupted
→ Attempt B becomes current
→ R still resolves by content address
→ Agent B submits R as proof that W is verified
```

If Phase 1.0 treats "artifact exists" as sufficient evidence, a stale Attempt A result can bypass the current-attempt/evidence provenance rule.

That contradicts AC-10-06, which explicitly requires that a late result from a superseded attempt cannot become current evidence without explicit Host reconciliation/admission.

The content-addressed store cannot solve this because it intentionally answers only:

```text
Do these bytes exist under this digest?
```

not:

```text
Are these bytes admissible evidence for this current ProgramState verification obligation?
```

### 5.3 Competing designs

#### A. Artifact existence is evidence

Reject.

It collapses byte identity into semantic acceptance and permits stale-attempt reuse.

#### B. ProgramState copies artifact provenance directly

Reject.

It duplicates operation/evidence authority into ProgramState and becomes incorrect when identical content is produced by multiple operations or attempts.

#### C. ArtifactRef is referenced through canonical evidence provenance

Accept.

```text
ArtifactRef
+ canonical production/attempt provenance
+ Host verification admission
+ current subject generation
→ current evidence
```

This preserves one authority for each fact.

### 5.4 Crash/replay proof

If the Host retains R and crashes before any canonical operation/evidence fact refers to R:

```text
ArtifactStore: R exists
canonical log: no accepted evidence for R
reopen: R is an orphan retained blob
ProgramState: unchanged / verification unsatisfied
Completion Oracle: cannot rely on R
```

If the canonical evidence fact exists but `program.verification.satisfied` was not admitted before crash:

```text
ArtifactStore: R exists
canonical evidence: production fact exists
ProgramState: verification still unsatisfied
reopen: Host may reevaluate current evidence under current state
Completion Oracle: still rejects until satisfaction is canonically admitted
```

If satisfaction was canonically admitted before crash:

```text
canonical log contains satisfaction for current generation G
→ rebuild reproduces satisfied state for G
```

This is the desired canonical distinction.

### 5.5 Promotion decision

**PROMOTE.**

The plan should state, in substance:

> Canonical evidence may reference Host-retained content-addressed artifacts. Artifact identity or existence alone does not establish evidence acceptance, ProgramAttempt validity, verification satisfaction, or freshness. Artifact-backed evidence must resolve through the same canonical provenance/admission rules as other decisive evidence.

This is a Phase 1.0 semantic requirement, not renderer implementation scope.

### 5.6 Existing AC coverage

No new acceptance-criterion family is necessary.

The strongest proof belongs under AC-10-06 and AC-10-07:

```text
Attempt A produces ArtifactRef R
→ A becomes superseded by Attempt B
→ R still resolves
→ late/reused R cannot become current verification evidence merely by existence
→ explicit Host admission under current state is required
```

## 6. Candidate 2 — inspection delivery is explicit when relied upon

### 6.1 Required guarantee if inspection exists

If a verification predicate says an Agent inspected representation I, then production of I is insufficient. Canonical state must distinguish:

```text
I exists
```

from:

```text
I was actually supplied to the intended Agent/model inference Q
```

Otherwise the Host can admit verification after a crash or transport failure that occurred before inspection.

### 6.2 Current-code counterexample

The current context path already demonstrates the danger:

```text
Host compiles context update U
→ appends context.projection_compiled receipt C
→ transport.send(U) throws
→ Host intentionally keeps C canonical
```

Therefore inferring delivery from C would produce a false fact.

A second boundary remains even when `transport.send()` returns:

```text
Host IPC send succeeds
→ Agent process receives or queues message
→ Agent dies before provider/model inference
```

A Host-side send success still cannot prove that the representation entered model inference.

### 6.3 Competing designs

#### A. No delivery fact; infer from artifact production

Reject for any future inspection-backed verification.

#### B. Reuse `context.projection_compiled`

Reject.

Its current semantics are explicitly pre-delivery.

#### C. Treat successful Host transport send as inspection

Reject.

Transport success is weaker than inference delivery.

#### D. Future post-materialization/post-inference-delivery receipt

Accept as the future semantic requirement.

The exact mechanism may be:

- a dedicated generic runtime event; or
- an extended inference receipt with equivalent lossless fields.

It should not be a `program.*` authority because inspection delivery is a general Host/Agent runtime fact.

### 6.4 Does Phase 1.0 already claim this guarantee?

No.

The current draft explicitly excludes browser execution and does not require:

- `artifact.inspect`;
- multimodal durable tool results;
- an artifact inspection protocol capability;
- image/provider media delivery;
- an inspection-dependent `CompletionCriterion`;
- a renderer/rasterizer.

Phase 1.0 can satisfy every current AC-10 proof without claiming that an Agent visually inspected an artifact.

### 6.5 Promotion decision

**ACCOMMODATE / DEFER.**

Do not add a Phase 1.0 implementation or acceptance requirement for canonical inspection delivery.

Retain the successor rule:

> If a future verification predicate relies on Agent inspection, no verification satisfaction may be admitted without canonical delivery provenance for the exact representation and inference generation.

If Phase 1.0 planning later adds any inspection-dependent verification requirement, this decision must be revisited and becomes a promotion blocker before approval.

### 6.6 Important negative conclusion

The current `context.projection_compiled` receipt must not be reinterpreted later as proof that a visual artifact was delivered to model inference.

Its current contract is useful precisely because it records a Host compilation decision even when delivery fails.

## 7. Candidate 3 — capability mismatch fails closed for required inspection

### 7.1 Required guarantee if inspection exists

If verification requires actual inspection and the attached Agent/provider cannot inspect the representation, the Host must not silently substitute:

```text
artifact filename
artifact path
text summary
OCR-like text
"render succeeded"
```

and call the inspection obligation satisfied.

The only safe result is that the inspection-dependent obligation remains unsatisfied unless an explicitly equivalent deterministic verification predicate exists in the contract.

### 7.2 Counterexample if future inspection silently degrades

```text
verification obligation V requires rendered-layout inspection
→ ArtifactRef I resolves
→ replacement Agent supports ArtifactRef replay but has no visual input path
→ Host sends "[artifact: I]" as text
→ Agent says "looks good"
→ Host treats V as satisfied
```

This would convert provider inability into fabricated evidence.

### 7.3 Existing Phase 1.0 rules already prevent a weaker version

The draft already says:

- verification is satisfied only by Host-accepted canonical evidence or Host-authorized waiver;
- Agent assertion cannot satisfy or waive an obligation;
- Completion Oracle requires all mandatory verification to be current.

Therefore an incapable Agent cannot legitimately create satisfaction merely by saying it inspected something.

What Phase 1.0 does **not** currently need is a normative visual-capability negotiation contract because no inspection obligation is in scope.

### 7.4 Replacement-Agent distinction

A future inspection capability must preserve this distinction:

```text
V already canonically satisfied for current subject generation G
→ replacement Agent lacks inspection support
→ V remains satisfied unless ordinary freshness rules invalidate G
```

versus:

```text
V unsatisfied or invalidated at G+1
→ current Agent lacks inspection support
→ no new satisfaction
```

Agent capability is not itself a verification-generation invalidator.

### 7.5 Promotion decision

**ACCOMMODATE / DEFER.**

The fail-closed rule is mandatory for the future inspection seam, but the current Phase 1.0 contract does not need to implement or gate on `artifact_inspection_v1` or equivalent provider media capability.

The current general rule remains sufficient for Phase 1.0:

> An unsatisfied verification obligation remains unsatisfied until the Host admits evidence satisfying its closed predicate under current state.

When inspection becomes one such predicate, capability mismatch must fail closed by construction.

## 8. Candidate 4 — artifact freshness reuses verification freshness

### 8.1 Required Phase 1.0 guarantee

AC-10-07 already requires verification evidence to be current for its verification subject generation and to become stale after relevant later mutation.

Artifact-backed evidence cannot be allowed to escape that rule simply because its content address remains stable.

### 8.2 Counterexample if omitted

```text
subject generation G1
→ capability produces ArtifactRef R
→ Host accepts R-backed evidence
→ verification V satisfied at G1
→ relevant source mutation advances subject to G2
→ R still resolves with the same digest
→ Completion Oracle treats R as current because the artifact still exists
```

This directly violates AC-10-07.

The error is confusing two different forms of identity:

```text
artifact identity: R is still exactly R
verification relevance: R was accepted for G1, not G2
```

Content addressing intentionally preserves the first. ProgramState must govern the second.

### 8.3 Competing designs

#### A. Artifact evidence never invalidates while bytes exist

Reject.

This defeats state-indexed verification.

#### B. Add a separate artifact freshness epoch

Reject.

It creates a second freshness authority and requires reconciliation between artifact and ProgramState epochs.

#### C. Reuse verification subject generation

Accept.

```text
ArtifactRef R
→ accepted evidence for obligation V at generation G
→ later relevant mutation advances V subject to G+1
→ R remains historical content/evidence
→ prior satisfaction is non-current
```

### 8.4 Same bytes can support a later generation only through new admission

A useful edge case is content-address deduplication:

```text
G1 → operation O1 produces bytes B → ArtifactRef R
→ V satisfied for G1
→ relevant mutation → G2, V stale
→ operation O2 independently produces the same bytes B → same ArtifactRef R
```

The identical ArtifactRef does not automatically restore V.

What can restore V is a **new canonical evidence/provenance/admission chain** showing that the current G2 verification predicate was actually checked and accepted.

This is exactly why provenance cannot be attached uniquely to the content-addressed blob.

### 8.5 Crash/replay proof

After `program.verification.invalidated` (or equivalent current-generation transition) is canonical:

```text
Host crash
→ ArtifactRef R still resolves
→ ProgramState rebuild sees current generation G2 and old satisfaction G1
→ V is not current
→ Completion Oracle rejects
```

No artifact-store query can override that ProgramState fact.

### 8.6 Promotion decision

**PROMOTE.**

The plan should state, in substance:

> Artifact-backed verification evidence uses the same verification subject generation and invalidation policy as all other evidence. Content-addressed identity or continued artifact availability never carries satisfaction across a relevant subject-generation change.

This is already implied by AC-10-07, but making it explicit closes the artifact-specific bypass.

### 8.7 Existing AC coverage

AC-10-07 should carry the negative proof:

```text
V satisfied using ArtifactRef R at G1
→ relevant mutation advances to G2
→ R remains byte-identical and resolvable
→ V is still stale
→ Completion Oracle rejects
→ only fresh Host-admitted evidence for G2 restores satisfaction
```

No artifact-specific freshness gate is needed.

## 9. Canonical event-history probes

The following histories are the minimum scenario corpus for validating the conclusions. Event names marked as future/provisional are illustrative; the semantic ordering is the proof target.

### H1 — orphan retained artifact is not evidence

```text
Attempt A active
→ capability computes bytes B
→ HostArtifactStore retains R
→ Host crashes before terminal operation/evidence append
→ reopen
```

Expected:

```text
R may physically exist
operation/evidence chain does not prove current accepted result
ProgramState verification remains unsatisfied
Completion Oracle cannot rely on R
```

### H2 — current artifact evidence accepted through Host admission

```text
Attempt A current at revision R10
→ operation O executes under A
→ output ArtifactRef X retained
→ canonical evidence E binds O/A/X
→ Host evaluates verification V at subject generation G4
→ program.verification.satisfied(V, G4, E)
```

Expected: V current for G4.

### H3 — stale-attempt artifact remains resolvable

```text
Attempt A produces X
→ A interrupted
→ Attempt B current
→ X still resolves
→ late A result or Agent proposal references X
```

Expected: no automatic current evidence; stale attempt provenance wins over artifact existence.

### H4 — same bytes, different attempts

```text
Attempt A produces bytes B → ArtifactRef X
→ A superseded
→ Attempt B independently produces same bytes B → ArtifactRef X
```

Expected: same content identity, distinct operation/attempt provenance. Only current Host-admitted evidence chain may support ProgramState transitions.

### H5 — artifact existence without verification admission

```text
canonical operation/evidence says X was produced
→ no program.verification.satisfied event/fact admitted
→ Agent says verification passed
```

Expected: verification remains unsatisfied.

### H6 — artifact-backed verification invalidated by mutation

```text
V satisfied with X at G1
→ relevant mutation M admitted
→ subject generation becomes G2 / V invalidated
→ X still resolves unchanged
```

Expected: V stale; Completion Oracle rejects.

### H7 — identical re-render at new generation

```text
V stale at G2
→ fresh verification operation runs at G2
→ output bytes happen to equal old X
→ content address is still X
→ new evidence E2 admitted for current operation/G2
```

Expected: V may become satisfied only because E2 is fresh/current, not because X already existed.

### H8 — crash after evidence, before verification satisfaction

```text
operation/evidence E for X canonical
→ Host crashes before program.verification.satisfied
→ reopen/rebuild
```

Expected: evidence exists, verification unsatisfied until Host performs a valid current admission step.

### H9 — crash after verification satisfaction

```text
E canonical
→ program.verification.satisfied(V,G,E) canonical
→ Host crashes
→ reopen/rebuild
```

Expected: satisfaction reconstructs as current if no later invalidating event exists.

### H10 — current context receipt, failed transport

Current implementation shape:

```text
context.projection_compiled C canonical
→ transport.send(context.update) throws
```

Expected: C proves compilation, not Agent/model delivery. It cannot satisfy any future inspection predicate.

### H11 — transport success, Agent dies before inference

Future inspection thought experiment:

```text
Host sends inspection representation I
→ IPC send succeeds
→ Agent process dies before provider request containing I
```

Expected: no inspection-delivery fact; inspection-dependent verification remains unsatisfied.

### H12 — successful future inspection delivery

Future contract:

```text
I materialized under bounds
→ compatible Agent/provider path accepts I into inference Q
→ canonical delivery fact D binds I + Agent generation + Q + Program/Attempt context
→ later Agent result/evidence proposal
→ Host verification admission
```

Expected: D is necessary provenance if the verification predicate relies on Agent inspection, but D alone does not prove correct understanding.

### H13 — incapable replacement Agent

```text
V already satisfied at current G using prior inspection evidence
→ Agent replaced by generation B without inspection support
```

Expected: V remains current merely because G is unchanged.

Then:

```text
relevant mutation → G+1
```

Expected: V becomes stale; Agent B cannot create new inspection-backed satisfaction.

### H14 — human-readable transcript summary is not replay equivalence

```text
canonical tool result contains ArtifactRef X
→ human transcript projection renders "[artifact ... sha256]"
→ replacement Agent replay uses only summary text
```

Expected: summary text is not equivalent to durable ArtifactRef/inspection content and cannot satisfy an inspection-dependent contract.

### H15 — completion/invalidation race

```text
V currently satisfied using X at G1
→ Completion Oracle preliminary evaluation passes
→ relevant mutation/invalidation is admitted first
→ completion enters canonical admission cut
```

Expected: completion revalidates, sees V stale at G2, and rejects. Continued availability of X does not affect the result.

### H16 — `artifact_present` is presence only

```text
CompletionCriterion = artifact_present(X)
→ X resolves
```

Expected: that criterion is true **only as an artifact-presence predicate**.

It must not imply:

```text
Agent inspected X
X has correct layout
X semantically matches objective
verification obligation V is satisfied
```

If any of those facts are required, the ProgramState contract must include the corresponding verification obligation/criterion explicitly.

## 10. Crash/replay state table

| Crash point / replay state | Artifact bytes | Canonical production evidence | Program verification satisfaction | Inspection delivery | Correct ProgramState result |
|---|---:|---:|---:|---:|---|
| After retain, before operation/evidence append | yes | no | no | n/a | unsatisfied |
| After operation/evidence append, before verification satisfaction | yes | yes | no | n/a | unsatisfied |
| After verification satisfaction for current G | yes | yes | yes | if predicate does not require inspection: n/a | satisfied for G |
| After later invalidation to G+1 | yes | yes/history | old satisfaction only | historical | stale/unsatisfied for G+1 |
| Context receipt persisted, send failed | maybe | maybe | no inspection satisfaction | **no** | inspection not proven |
| Host send succeeded, Agent died before inference | yes | yes | no inspection satisfaction | **no** | inspection not proven |
| Future canonical inspection delivery D exists | yes | yes | not necessarily | yes | delivery provenance exists; semantic verification still separately admitted |

The key rebuild invariant remains:

```text
same canonical event history
→ same ProgramState verification state
→ same eligibility
→ same Completion Oracle result
```

ArtifactStore availability can be checked where a predicate requires materialization/presence, but it cannot rewrite historical ProgramState acceptance or freshness by itself.

## 11. Alternative-design scorecard

### 11.1 Artifact evidence

| Design | Rebuildable | stale-attempt safe | single authority | content-address dedup safe | Decision |
|---|---:|---:|---:|---:|---|
| artifact existence == evidence | yes-ish | no | no | no | reject |
| copy provenance onto artifact blob | awkward | partial | no | no | reject |
| ArtifactRef + canonical operation/evidence + ProgramState acceptance | yes | yes | yes | yes | select |

### 11.2 Inspection delivery

| Design | Distinguishes send failure | distinguishes Agent-before-inference crash | exact Agent/inference correlation | Decision |
|---|---:|---:|---:|---|
| infer from render success | no | no | no | reject |
| reuse context.projection_compiled | no | no | partial | reject |
| infer from transport.send success | yes | no | partial | reject |
| future post-inference-delivery receipt/fact | yes | yes | yes | successor requirement |

### 11.3 Capability mismatch

| Design | fails closed | provider-independent | preserves verification truth | Decision |
|---|---:|---:|---:|---|
| silently substitute text summary | no | yes | no | reject |
| Agent self-declares equivalence | no | no | no | reject |
| obligation remains unsatisfied unless compatible path exists | yes | yes | yes | successor requirement |

### 11.4 Freshness

| Design | one freshness authority | current-state indexed | content-address safe | Decision |
|---|---:|---:|---:|---|
| artifact stays fresh while bytes exist | no | no | no | reject |
| separate artifact epoch | no | maybe | yes | reject |
| ProgramState verification subject generation | yes | yes | yes | select |

## 12. Exact promotion recommendation

This validation recommends a later **separate planning amendment** to `docs/phase-1.0-plan.md` containing only the minimum semantic changes below.

### 12.1 Promote artifact-backed evidence

Candidate governing wording:

> **Artifact-backed evidence follows canonical evidence authority.** Host-retained content-addressed artifacts may be referenced by canonical evidence and verification records. Artifact identity, digest equality, or continued availability does not by itself establish ProgramAttempt validity, evidence acceptance, verification satisfaction, or completion. Attempt-scoped artifact evidence must remain mechanically correlated to the producing canonical operation/evidence chain.

Natural placement: governing invariants plus §3.12 Operation and evidence correlation.

### 12.2 Promote shared freshness

Candidate governing wording:

> **Artifact-backed verification uses the same freshness model.** Artifact-backed evidence is indexed by the same verification subject generation/invalidation policy as other verification evidence. A relevant mutation makes prior satisfaction non-current even when the referenced ArtifactRef remains byte-identical and resolvable.

Natural placement: governing invariant 13 and §3.13 Verification obligations and freshness.

### 12.3 Clarify `artifact_present`

Candidate clarification:

> `artifact_present` is a deterministic artifact-presence criterion only. It does not establish Agent inspection, semantic correctness, or satisfaction of a separate verification obligation.

Natural placement: §3.6 Closed CompletionCriterion contract.

### 12.4 Extend existing negative proofs, not the acceptance surface

AC-10-06 candidate additional negative proof:

```text
superseded Attempt A produced ArtifactRef R
→ R remains resolvable
→ R cannot become current evidence merely by being referenced from Attempt B
→ current Host admission/provenance is required
```

AC-10-07 candidate additional proof:

```text
verification V satisfied with ArtifactRef R at G1
→ relevant mutation advances subject to G2
→ R remains byte-identical/resolvable
→ V remains stale
→ Completion Oracle rejects until fresh G2 evidence is admitted
```

These are artifact forms of existing AC-10-06/07 guarantees, not a new renderer/inspection AC family.

## 13. What should not be promoted into Phase 1.0 now

The following should remain in `docs/phase-1.0-artifact-seam-decisions.md` / project-level artifact architecture until an implementation phase actually introduces inspection:

```text
artifact_ref_v1 wire/schema implementation
artifact_inspection_v1 wire/schema implementation
multimodal Agent tool-result content
canonical inspection-delivery event/receipt implementation
provider image/media matrices
rasterization
renderers
diagram.validate / diagram.render / artifact.inspect
Mermaid compatibility profile
browser rendering
```

Likewise, Phase 1.0 should not add a verification obligation whose truth depends on Agent visual inspection unless the corresponding delivery/capability contract is promoted and accepted at the same time.

This is the main scope boundary proved by the study:

```text
Phase 1.0 may be artifact-aware
without being artifact-inspection-capable.
```

## 14. Remaining implementation-placement questions

The prior artifact decision record correctly classifies the following as implementation-placement questions rather than current ProgramState semantic blockers:

1. shared package ownership for ArtifactReferenceContent;
2. Agent Protocol v1 capability-gated extension versus a protocol version increment;
3. exact future inspection-delivery event/receipt family;
4. artifact-bearing canonical-content and materialization bounds;
5. first renderer/inspection implementation phase.

This validation adds one concrete constraint to question 3:

> `context.projection_compiled` cannot be used unchanged as proof of inspection delivery because it is canonically persisted before `transport.send()` and remains canonical when send fails.

Any future delivery proof must therefore be a later fact with stronger semantics.

## 15. Final decision

The contract proof supports a narrow Phase 1.0 promotion:

```text
PROMOTE
  artifact-backed evidence is first-class canonical evidence
  artifact-backed evidence uses ordinary ProgramState verification freshness

ACCOMMODATE / DEFER
  explicit inspection-delivery provenance
  fail-closed inspection capability mismatch
```

This result preserves the current Phase 1.0 objective:

```text
ProgramState
→ exact ProgramAttempt authority
→ Host-observed operation/evidence correlation
→ current verification satisfaction
→ serialized Completion Oracle
```

while ensuring that artifact references cannot become a loophole around attempt validity or verification freshness.

It also avoids expanding Phase 1.0 into the still-separate rendering/inspection implementation problem.

No governing Phase 1.0 text is changed by this validation document. Promotion remains a distinct planning amendment and Phase 1.0 remains unapproved, unfrozen, and implementation unauthorized.