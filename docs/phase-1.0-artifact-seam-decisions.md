# ALCODE Phase 1.0 — Artifact Seam Planning Decisions

**Status:** DRAFT / non-normative planning decision record  
**Approval:** not approved; not frozen; implementation not authorized  
**Relationship to Phase 1.0:** resolves the artifact-seam planning questions opened in `docs/phase-1.0-design-notes.md` without changing the current Phase 1.0 acceptance criteria or assigning renderer implementation to Phase 1.0.

## Purpose

The prior artifact-rendering study and Phase 1.0 design notes established a necessary boundary:

```text
content-addressed Host artifact
→ durable ArtifactRef
→ Agent-facing inspection representation
→ verification evidence
```

The remaining planning questions were about the exact durable content shape, provenance placement, Agent Protocol capability negotiation, fail-closed behavior, and whether successful inspection delivery needs its own canonical fact.

This note resolves those questions for the working design.

The decisions are intentionally narrower than a renderer design. Mermaid, Graphviz, PlantUML, browser rendering, PDF rasterization, and similar adapters remain outside the Phase 1.0 implementation obligation unless separately approved.

## Decision 1 — durable tool results use ArtifactRef content, not embedded provider image payloads

The canonical durable tool-result representation should support text and a bounded Host artifact reference.

Provisional shape:

```ts
interface ArtifactReferenceContent {
  type: "artifact";
  artifact: {
    handle: string;
    digest: string;
    size: number;
    mediaType?: string;
  };
  relation: "output" | "inspection_representation";
}

type DurableToolResultContent =
  | TextContent
  | ArtifactReferenceContent;
```

Names remain provisional. The semantic decision is not.

### Why the full reference is carried

The durable content block should carry the bounded content-addressed reference rather than only an ephemeral path or opaque renderer-local identifier.

The reference fields allow replay to validate that:

- the handle resolves through the Host artifact authority;
- the retained bytes match the expected digest;
- the retained size is consistent with the admitted reference;
- the declared media type, when present, is available for safe materialization/negotiation.

The artifact store remains the byte authority. Copying the reference fields into canonical content does not create a second content authority.

### Why `relation` is closed

A tool result may contain more than one artifact. The canonical record needs a bounded way to distinguish the produced result from a representation created specifically for Agent inspection.

The first relation taxonomy should therefore be closed:

```text
output
inspection_representation
```

`evidence` is deliberately not a content relation.

A tool or Agent must not be able to declare its own output canonical evidence merely by labeling an artifact. Evidence status remains a Host admission decision expressed through canonical evidence/verification correlation.

If later use cases require more relations, they should extend the closed taxonomy explicitly rather than accepting arbitrary role strings.

## Decision 2 — canonical artifact identity and inspection representation are separate layers

ALCODE should distinguish:

```text
artifact identity
≠ transformation provenance
≠ Agent delivery representation
≠ verification acceptance
```

A source/result artifact and an Agent-inspection representation may be different retained artifacts.

Example:

```text
Mermaid source generation G
→ renderer operation O1
→ SVG ArtifactRef R
→ rasterization operation O2
→ PNG ArtifactRef I
→ Agent inference request Q receives I
→ verification admission references R, I, Q, and G
```

`R` is the produced artifact. `I` is the representation actually delivered for inspection.

The content address of `I` does not imply that `I` is equivalent to `R` for every purpose. The derivation relationship is explicit provenance.

## Decision 3 — provenance is split by ownership instead of duplicated into ProgramState

Artifact-related provenance belongs in four different places according to authority.

### 3.1 HostArtifactStore — byte identity only

The artifact store owns retained content identity and bounded materialization.

Its authoritative concerns remain:

```text
handle
digest
size
media type where known
retained bytes
integrity validation
```

Transformation provenance should not become intrinsic artifact-store identity.

The same bytes may be produced by multiple operations, attempts, source generations, or transformations. Since a content-addressed store intentionally deduplicates identical bytes, attaching one mutable provenance story directly to the stored blob would be incorrect.

### 3.2 Operation/evidence events — execution and derivation provenance

Canonical operation/evidence correlation owns the facts about how an artifact was produced.

For an artifact-bearing operation, the canonical provenance chain should be mechanically able to resolve, where applicable:

```text
operationId
ProgramStateId
ProgramAttemptId
session / Agent generation correlation
capability/tool identity
input/source ArtifactRef or source digest/subject identity
output ArtifactRef(s)
output relation
transformation/renderer identity
transformation/renderer version
bounded profile/config digest
effect/outcome status
source event / result event identities
```

Not every operation needs every field. The rule is that decisive provenance must be canonical and mechanically resolvable, not reconstructed from free text.

### 3.3 ProgramState verification — freshness and accepted references

ProgramState should not duplicate full renderer/operation provenance.

A verification satisfaction should retain only the ProgramState-owned fields necessary to establish current validity and point to canonical evidence, for example:

```text
verification obligation id
verification subject generation / epoch
accepted canonical evidence ref(s)
ProgramAttemptId when attempt-scoped
exact ProgramState revision at admission
```

The referenced evidence chain can resolve the produced and inspection ArtifactRefs plus operation provenance.

This preserves one authority for each fact:

```text
artifact store      → bytes and content identity
operation/evidence  → production/derivation facts
ProgramState        → current obligation/freshness/acceptance state
```

### 3.4 Artifact lineage projection — derived query aid only

A future artifact metadata/lineage projection may index relationships such as:

```text
artifact R produced by operation O1
artifact I derived from R by operation O2
artifact I delivered in inference Q
artifact R accepted for verification V
```

Such a projection is rebuildable convenience state, never another canonical authority.

## Decision 4 — Agent Protocol uses two capabilities, not one overloaded visual token

The working design should separate durable artifact-reference support from actual model inspection support.

Provisional capability tokens:

```text
artifact_ref_v1
artifact_inspection_v1
```

Final token spelling can change before approval, but the split should remain.

### `artifact_ref_v1`

This capability means the Agent runtime can receive and preserve durable ArtifactRef-bearing content in Host-provided context/protocol messages.

It does not imply that the underlying model can visually inspect the referenced content.

### `artifact_inspection_v1`

This capability means the Agent runtime has a Host-approved path for materializing an inspectable representation and actually supplying that representation to model inference.

It does not expose provider-specific wire encoding as Host protocol authority.

Conceptually:

```text
Agent Protocol
  ArtifactRef + inspection identity
          ↓
Agent/provider adapter
  provider-specific image/media encoding
          ↓
model inference
```

The Host remains concerned with stable artifact identity, admitted transformations, bounds, and delivery correlation. Base64 layout, provider message syntax, and provider-specific image objects remain adapter details.

### Why the capabilities are separate

An Agent runtime may be able to preserve ArtifactRefs across replay while its current model/provider cannot consume images.

Conversely, visual model support should not require canonical transcript events to embed provider-specific image payloads.

A single capability token would collapse two independent properties:

```text
durable reference compatibility
visual inspection capability
```

The split permits fail-closed behavior without sacrificing durable replay.

### Capability-gated compatibility

A Host must not send artifact-bearing protocol/context content to an Agent generation that did not negotiate `artifact_ref_v1`.

A Host must not treat a representation as visually inspected by an Agent generation that did not negotiate `artifact_inspection_v1`.

Whether the eventual schema evolution can remain within the current Agent Protocol version or requires a protocol-version increment is an implementation compatibility decision. Capability tokens do not excuse sending an unknown content union to an older parser.

## Decision 5 — detailed provider media limits are not Phase 1.0 ProgramState semantics

The current Agent hello exposes a string capability set. Phase 1.0 does not need to freeze provider-specific media matrices, pixel limits, or byte limits into ProgramState.

Those limits belong to the future artifact-inspection implementation/provider adapter.

For the Phase 1.0 boundary, the required semantic rule is only:

> If a current verification obligation requires Agent inspection, the Host must have a compatible admitted inspection path. Otherwise the obligation remains unsatisfied.

A future protocol extension may advertise structured details such as supported media types or maximum image dimensions. Those details should not become part of ProgramState identity.

## Decision 6 — successful inspection delivery must be a canonical fact

A produced artifact is not proof that the Agent received it.

Likewise, an operation result plus an Agent request ID is insufficient by itself to prove that a particular representation reached the model input for a particular inference generation.

Therefore the working design requires a canonical **inspection-delivery fact** whenever Agent inspection is used as verification evidence.

This is a semantic requirement, not yet a mandatory new event name.

It may be represented by either:

```text
A. a dedicated generic Host event such as artifact.inspection.delivered

or

B. an extension of an existing canonical inference/context-delivery receipt
   that preserves the same required facts
```

The Phase 1.0 design should not require a `program.*` inspection-delivery event. Inspection delivery is a general Agent/Host runtime fact that may also be useful outside ProgramState.

### Minimum successful-delivery identity

A canonical inspection-delivery fact should mechanically bind:

```text
inspection delivery id / canonical event id
source/produced ArtifactRef
inspection ArtifactRef when different
sessionId
Agent generation id
inference/request id
ProgramStateId when program-scoped
ProgramAttemptId when attempt-scoped
verification subject generation when relevant
media type / representation identity
transformation operation/ref when derived
successful delivery status
```

The exact field placement can vary if equivalent correlation is lossless.

### Delivery does not mean semantic understanding

The canonical fact proves that the admitted representation was supplied to the intended Agent/model inference path.

It does not prove that the model correctly understood the artifact.

Future semantic verification may require additional Agent output, deterministic checks, or judge/human evidence. The inspection-delivery fact is necessary provenance, not sufficient semantic truth.

## Decision 7 — failed/unsupported inspection is fail-closed

The Host must never silently downgrade a required visual/artifact inspection into text-only verification.

If a verification obligation requires inspection and the current execution cannot perform it, the obligation remains unsatisfied.

Required behavior:

```text
ArtifactRef resolves + current Agent supports inspection
→ materialize admitted representation
→ deliver
→ record canonical delivery fact
→ allow later verification admission

ArtifactRef resolves + current Agent lacks inspection capability
→ no synthetic equivalence
→ no silent waiver
→ no satisfaction admission
→ work/program remains unable to pass that obligation
```

The ProgramState may continue executing unrelated eligible work. The affected work item remains `awaiting_verification` or otherwise blocked according to the final ProgramState transition design.

### Missing/corrupt artifacts

If an ArtifactRef cannot be resolved, exceeds materialization bounds, or fails digest validation, it cannot satisfy an inspection-dependent obligation.

The Host must surface an explicit failure/diagnostic path and preserve the obligation as unsatisfied.

### Missing transformation path

If the retained artifact requires a transformation before inspection and no admitted transformation path is available, the result is likewise unsatisfied rather than silently converted through Bash or summarized as text.

A later compatible session/Agent/provider may resume the verification step.

## Decision 8 — replacement-Agent capability does not invalidate already-fresh evidence by itself

Agent replacement needs one important distinction.

If an inspection-backed verification satisfaction is already canonical and remains fresh for the current verification subject generation, attaching a replacement Agent that lacks `artifact_inspection_v1` does not by itself invalidate that existing satisfaction.

Freshness is determined by the ProgramState verification subject/invalidation rules, not by the capabilities of whichever Agent happens to attach later.

However:

- an unsatisfied inspection obligation cannot be newly satisfied by an incapable replacement Agent;
- a later relevant mutation that invalidates the existing satisfaction requires fresh verification;
- if fresh verification again requires Agent inspection, a compatible inspection-capable execution is required;
- a delivery fact tied to a superseded Agent generation cannot be repurposed as proof that a different Agent generation inspected the artifact.

This avoids accidental capability-dependent invalidation while preserving exact provenance.

## Decision 9 — artifact inspection freshness reuses ProgramState verification generations

No artifact-specific freshness subsystem is introduced.

Inspection-related evidence is indexed by the same verification subject generation/epoch used for all Phase 1.0 verification.

Example:

```text
subject generation G
→ render R
→ inspection representation I
→ delivery D to Agent generation A
→ verification V satisfied for G

later relevant mutation
→ subject generation G+1
→ V for G becomes stale
→ R/I/D remain historically valid artifacts/facts
→ they are not current verification evidence for G+1
```

Content-addressed identity preserves history. ProgramState freshness determines current relevance.

## Decision 10 — ProgramAttempt authority applies to artifact-producing and inspection-transform operations

When an artifact operation is initiated under a ProgramAttempt, it must remain inside the same authority narrowing model as filesystem or terminal operations.

The Host must be able to resolve:

```text
ProgramStateId
ProgramAttemptId
exact ProgramState revision/claim context
capability operation
produced ArtifactRef(s)
inspection transformation when any
inspection delivery when any
verification evidence admission
```

A stale/superseded attempt cannot make a late artifact result current merely because the ArtifactRef still resolves.

The artifact may be reused later only through explicit Host admission under current ProgramState and verification state.

## Decision 11 — ArtifactRef content does not itself mutate the repository

Retaining an artifact in `HostArtifactStore` and returning an ArtifactRef is not a workspace mutation.

Repository export remains a separate mutating capability/action with ordinary policy, ProgramAttempt authority, operation uncertainty, and reconciliation semantics.

This preserves the source/derived-output distinction:

```text
render/derive
→ Host artifact
→ inspect/verify

optional later export
→ explicit workspace mutation
```

The existence of an ArtifactRef must never imply that the generated file belongs in Git.

## Decision 12 — human transcript projections may summarize, canonical replay must preserve references

The existing human-readable transcript projection may render an artifact-bearing result as bounded text such as:

```text
[artifact output: image/svg+xml, sha256:...]
```

That projection is not the exact replay source.

Canonical transcript/context reconstruction must retain the ArtifactReferenceContent block so a replacement compatible Agent can receive the same durable artifact identity.

If the replacement Agent lacks the required negotiated capability, replay must fail closed for inspection-dependent work rather than pretending the human-readable transcript summary is equivalent input.

## Resolved answers to the prior planning questions

The questions opened in `docs/phase-1.0-design-notes.md` are answered as follows.

### Q8 — reference only, or semantic role?

Carry the full bounded Host ArtifactRef plus a closed `relation` field.

Initial relations:

```text
output
inspection_representation
```

Do not permit `evidence` as a self-declared tool-result relation.

### Q9 — where does provenance live?

```text
HostArtifactStore
→ byte/content identity

canonical operation/evidence events
→ production + transformation provenance

canonical inspection-delivery fact
→ exact Agent/model delivery provenance

ProgramState verification
→ obligation generation + accepted evidence references

artifact lineage projection
→ rebuildable query/index convenience
```

### Q10 — Agent Protocol capability token?

Use two capability concepts:

```text
artifact_ref_v1
artifact_inspection_v1
```

The first is durable-reference compatibility. The second is actual inspection-path capability.

### Q11 — replay resolves ArtifactRef but current Agent cannot inspect?

Fail closed for any unsatisfied obligation requiring inspection. Do not synthesize textual equivalence, waive, or admit satisfaction. Already-fresh canonical evidence remains valid unless normal ProgramState freshness rules invalidate it.

### Q12 — explicit inspection-delivery fact?

Yes, semantically.

A successful inspection delivery must be canonical and bind the exact representation, Agent generation, inference/request identity, and ProgramState/Attempt context when applicable.

A dedicated event is optional if an existing canonical context/inference receipt can carry the same lossless fact.

## Phase 1.0 accommodation after these decisions

The Phase 1.0 ProgramState design should be able to express and preserve the following without implementing a renderer:

```text
ProgramAttempt
→ artifact-producing Host capability operation
→ content-addressed ArtifactRef
→ canonical production provenance
→ optional inspection representation ArtifactRef
→ canonical inspection-delivery provenance when required
→ ProgramState verification evidence reference
→ freshness / invalidation by verification subject generation
→ Host-only completion admission
```

The ProgramState model therefore must not assume that decisive evidence is text, a terminal command result, or a repository path.

## Still outside Phase 1.0 implementation obligation

These decisions do not add the following to Phase 1.0 implementation scope:

- Mermaid parsing or rendering;
- `diagram.validate`, `diagram.render`, `artifact.inspect`, or `diagram.export` tools;
- Graphviz, PlantUML, browser, SVG, PDF, screenshot, notebook, or chart adapters;
- a renderer catalog/plugin system;
- rasterization implementation;
- provider-specific image encoding;
- network-enabled renderers;
- arbitrary remote compute;
- new Phase 1.0 acceptance criteria.

The purpose is to prevent ProgramState, verification, and Agent Protocol planning from freezing around a text-only assumption.

## Candidate promotion into the working Phase 1.0 plan

Before Phase 1.0 is approved, the working plan should be evaluated for promotion of these semantic invariants:

1. **Artifact-backed evidence is first-class.** A current verification satisfaction may reference Host-retained content-addressed artifacts through canonical evidence provenance; artifact identity does not itself establish freshness or acceptance.
2. **Inspection delivery is explicit when relied upon.** If verification relies on Agent inspection, the Host must have a canonical fact binding the delivered representation to the relevant Agent generation/inference and ProgramState verification subject.
3. **Capability mismatch fails closed.** Required inspection cannot be silently replaced by text or waived because the attached Agent/provider lacks support.
4. **Artifact freshness reuses verification freshness.** Artifact-backed evidence is invalidated by the same subject-generation rules as other verification evidence.

Promotion of these invariants into `docs/phase-1.0-plan.md` is a separate planning amendment. This note does not perform that promotion and does not freeze the plan.

## Remaining artifact-seam questions

The prior Q8–Q12 questions are resolved. The remaining questions are implementation-placement questions rather than ProgramState semantic blockers:

1. What package should own the shared ArtifactRef content schema used by transcript, Agent Protocol, and Host runtime?
2. Does the first wire-compatible implementation require `AGENT_PROTOCOL_VERSION = 2`, or can capability-gated schema evolution remain safely backward compatible?
3. Should the canonical inspection-delivery fact be a dedicated runtime event family or an extension of the existing context/inference receipt substrate?
4. Which concrete bounds apply to artifact-bearing canonical content and materialization?
5. Which later phase owns the first renderer/inspection adapter and provider media-capability details?

These should be resolved before implementing the artifact seam, but they do not require expanding the current Phase 1.0 ProgramState acceptance surface.
