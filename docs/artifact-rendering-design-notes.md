# ALCODE — Artifact Rendering and Inspection Design Notes

**Status:** DRAFT / non-normative architecture notes  
**Approval:** not approved; not frozen; implementation not authorized  
**Scope:** project-level coding-agent capability; not a Mermaid documentation-style decision and not yet assigned to a release phase.

## Discovery

Mermaid exposed a broader missing capability in ALCODE.

ALCODE can already author files and invoke arbitrary commands through Host-mediated filesystem and terminal capabilities. That means an Agent can, in principle, write Mermaid source and call an installed renderer through Bash. But this is only an accidental composition of generic primitives.

A complete coding agent must also be able to work with development artifacts whose correctness depends on a deterministic transformation and subsequent inspection of the transformed result.

The general workflow is:

```text
source authoring
→ validation
→ rendering / compilation
→ Host-managed artifact
→ inspection
→ correction
→ re-render
→ verification
→ optional workspace export
```

Mermaid is the first concrete case that made this omission obvious, but the capability class also covers Graphviz, PlantUML, SVG generation, HTML/CSS previews, screenshots, charts, PDFs, generated documentation, notebooks, and other non-text development artifacts.

## Current ALCODE boundary

The current coding-agent tool surface includes read, write, edit, grep, list, find, and Bash. The Workspace capability boundary provides filesystem and terminal authority.

The current Agent contract also already has `ImageContent` for model/user messages, but `AgentToolResult.content` is text-only. Consequently a tool cannot naturally return a rendered visual result to the Agent as first-class inspectable content.

That creates two distinct gaps:

1. no narrow Host-owned render/compute capability for structured transformations;
2. no general multimodal artifact-inspection path from Host/tool result back into Agent inference.

This is therefore not merely a missing Mermaid adapter. It reaches into capability architecture, tool-result representation, durable transcript/protocol semantics, artifact provenance, and verification.

## Design principle

Known structured toolchains should not require arbitrary shell authority as their primary execution path.

Bash remains the escape hatch for unknown or repository-specific tooling. But when ALCODE understands the operation, it should expose the narrowest useful capability and preserve deterministic inputs, outputs, provenance, resource bounds, and effect semantics.

The desired split is:

```text
FilesystemCapability  → repository reads/writes
TerminalCapability    → arbitrary process execution escape hatch
Artifact/Render seam  → bounded deterministic transformation + inspection
```

The final public names remain open. `ArtifactCapability`, `RenderCapability`, and `ComputeCapability` are candidate terms.

## Proposed artifact pipeline

A first-class artifact workflow should separate validation, rendering, inspection, and export.

```text
             Artifact Tooling
                   │
      ┌────────────┼────────────┐
      ▼            ▼            ▼
   Validate       Render       Inspect
      │            │            │
      ▼            ▼            ▼
 structured    Host artifact   multimodal
 diagnostics   + provenance    Agent input
      │            │            │
      └────────────┴─────┬──────┘
                         ▼
                       Export
                         │
                         ▼
                  Workspace mutation
```

### Validate

Validation is a deterministic, preferably read-only operation. For Mermaid this means parsing/checking diagram source without requiring the Agent to invoke a shell command.

Conceptual request:

```ts
interface ArtifactValidateRequest {
  renderer: string;
  source: string | ArtifactSourceReference;
  format?: string;
}
```

Conceptual result:

```ts
interface ArtifactValidateResult {
  valid: boolean;
  diagnostics: ArtifactDiagnostic[];
  detectedType?: string;
}
```

Validation success is not visual correctness. It only establishes that the renderer accepts the source under the admitted configuration.

### Render

Rendering turns admitted source into a Host-managed artifact rather than implicitly mutating the repository.

Conceptual request:

```ts
interface ArtifactRenderRequest {
  renderer: string;
  source: string | ArtifactSourceReference;
  outputFormat: string;
  options?: Record<string, unknown>;
}
```

Conceptual result:

```ts
interface ArtifactRenderResult {
  artifact: ArtifactReference;
  sourceDigest: string;
  renderedDigest: string;
  renderer: string;
  rendererVersion: string;
  mediaType: string;
  diagnostics: ArtifactDiagnostic[];
}
```

The artifact store, not the repository working tree, should be the default destination for previews and intermediate renders.

### Inspect

Inspection is the critical missing loop.

A syntactically valid diagram or generated visual can still be unusable because of overlap, clipping, unreadable labels, poor graph direction, pathological dimensions, missing elements, or semantic mismatch with the intended architecture.

The Agent therefore needs a Host-mediated way to receive the rendered artifact as model-consumable content.

The existing tool-result contract should be evaluated for a generalization such as:

```ts
type ToolResultContent =
  | TextContent
  | ImageContent
  | ArtifactReferenceContent;
```

The exact shape remains open. The important invariant is that a durable tool result can reference or materialize an inspectable artifact without bypassing Host ownership.

For SVG/PDF/HTML, inspection may require an additional safe rasterization or browser-render step before a vision-capable model can consume the result.

### Export

Export is a separate workspace mutation.

Rendering a preview must not imply that the generated file belongs in the repository. Repositories differ on whether generated SVG/PNG/PDF assets are committed, ignored, produced by CI, or treated as transient output.

Export therefore requires an explicit policy/admission decision:

```text
Host artifact
→ repository policy / Attempt authority
→ explicit export
→ filesystem mutation
```

Source and generated output must be allowed to have different authority.

## Mermaid as the first adapter

Mermaid is a suitable first adapter because it exercises the full capability:

```text
.mmd / fenced Mermaid source
→ parse / validate
→ bounded renderer
→ SVG or PNG artifact
→ inspect rendered result
→ revise source
→ verify final render
→ optionally export generated asset
```

The architectural solution should not be a dedicated `MermaidTool` that owns arbitrary process execution. Mermaid should sit behind the general artifact/render seam.

A possible model-facing surface is:

```text
diagram.validate
diagram.render
artifact.inspect
diagram.export
```

Those names are illustrative only. The Host capability contract is more important than the final Agent-tool naming.

## Security and isolation

Renderers must be treated as processing potentially untrusted repository input.

A bounded renderer should default to:

- no ambient shell authority;
- no inherited secrets except explicitly admitted inputs;
- no network access unless a renderer contract explicitly requires and policy permits it;
- bounded CPU, memory, wall-clock time, source size, and output size;
- isolated temporary working directory;
- explicit renderer and renderer-version identity;
- explicit output media types;
- Host-owned artifact admission;
- sanitized or sandboxed renderer configuration where the underlying tool supports it;
- deterministic failure reporting rather than silent fallback to Bash.

The Agent may still choose Bash when the task genuinely requires a repository-specific command, but a known renderer should not need Bash simply because no narrower capability exists.

## Provenance

Every derived artifact should be attributable to its source and transformation.

Minimum useful provenance candidates include:

```text
source identity / source digest
renderer identity
renderer version
render options/config digest
output media type
rendered artifact digest
Host operation/event reference
time/resource outcome
```

When a render contributes to verification, the verification record should reference the artifact and the source generation/revision it was derived from.

This allows ALCODE to answer:

> Which source state and renderer produced the artifact the Agent actually inspected?

That is especially important after later source mutation, where previously inspected output may become stale.

## Effect and uncertainty semantics

Validation and rendering can usually be modeled as externally bounded computation whose primary output is a Host artifact. They should not automatically count as repository mutation.

Export is a workspace mutation and must compose with existing operation uncertainty/recovery rules.

If a renderer launches an external process and the Host loses certainty about whether the process completed or what it wrote outside the managed temporary boundary, the normal uncertainty doctrine still applies. The renderer design should minimize that ambiguity by confining side effects to Host-owned temporary locations.

## Attempt authority integration

The Phase 1.0 ProgramState study opened a complementary concept: a Host-issued Attempt Contract / Execution Lease that narrows one ProgramAttempt's authority.

Artifact operations fit naturally within that model without making this capability Phase-1.0-specific.

Example:

```text
ProgramAttempt objective:
  update architecture diagram

allowed reads:
  docs/architecture.mmd
  relevant source paths

allowed writes:
  docs/architecture.mmd

allowed structured compute:
  mermaid.validate
  mermaid.render

required verification:
  source parses
  final render succeeds
  final rendered artifact inspected

export policy:
  generated SVG is transient / do not commit
```

A capability request should be checked against the current Attempt authority in addition to the existing Host capability and permission policies.

An Agent cannot widen its own render/export authority merely by requesting a broader tool operation.

## Host-observed evidence versus Agent report

The Agent's statement that it rendered or inspected an artifact is not itself canonical evidence.

Where relevant, the Host should be able to correlate:

```text
admitted render request
→ canonical operation/result
→ artifact digest/reference
→ inspection delivery to Agent
→ later Agent proposal/report
```

A completion or verification decision may then rely on Host-observed facts rather than free-form self-report.

This extends the same principle already used elsewhere in ALCODE: Agent output proposes; Host-observed canonical state decides.

## Durable transcript and Agent replacement implications

Multimodal tool-result content cannot be introduced only at the in-memory `AgentToolResult` level.

ALCODE already requires durable transcript reconstruction and replaceable-Agent continuity. Therefore any new visual/artifact result representation must answer:

- how the canonical transcript records the tool result;
- whether it stores inline image bytes, a stable artifact reference, or both;
- how content digests are verified on replay;
- how a replacement Agent receives equivalent inspectable context;
- how bounded context compilation handles large visual artifacts;
- what happens when the backing artifact is missing or corrupted;
- how providers without image input support degrade or fail closed.

The artifact store should remain an owned substrate; transcript events should reference stable admitted artifacts rather than depend on ephemeral local files.

## Provider capability negotiation

Visual inspection depends on model-provider capability.

ALCODE should not assume every provider can consume images or every image-capable provider supports the same media types and limits.

The Agent/Host/provider path eventually needs explicit capability knowledge such as:

```text
supports image input
supported media types
maximum image bytes/dimensions
SVG direct support versus required rasterization
PDF direct support versus page rasterization
```

Provider limitations should produce an explicit inability or conversion path rather than silently skipping visual inspection when inspection is required by the task.

## Structural bounds

The feature needs explicit limits before it becomes a safe general-purpose capability.

Candidate bounds include:

- maximum source bytes per validation/render;
- maximum render duration;
- maximum renderer stdout/stderr capture;
- maximum artifact bytes;
- maximum image dimensions/pixel count;
- maximum PDF pages inspected per operation;
- maximum number of generated artifacts per attempt;
- maximum retained previews per ProgramAttempt/session;
- maximum inline-versus-reference threshold for transcript content.

Exact values remain open and should be empirically derived rather than guessed into a normative contract.

## Extension model

The current static extension host can register Agent tools, so renderer adapters can use the existing extension seam.

However, extension registration alone is not sufficient. A renderer still needs Host-owned capability mediation, artifact storage, durable result semantics, and multimodal delivery.

The expected layering is therefore:

```text
AgentTool adapter / extension
        ↓
Host capability policy
        ↓
Artifact/Render capability
        ↓
renderer adapter
        ↓
managed artifact store
```

Renderer adapters should not become independent authorities.

## Behavioral evaluation

Artifact tooling needs both deterministic and semantic evaluation.

Deterministic proof can cover:

- parse/validation result correctness;
- renderer invocation bounds;
- artifact digest/provenance stability;
- no unexpected workspace writes;
- export authority enforcement;
- recovery after renderer crash/timeout;
- transcript/artifact replay;
- provider-capability fail-closed behavior.

Behavioral evaluation is needed for questions such as:

- did the Agent inspect the render when inspection was required?
- did it notice clipping or unreadable layout?
- did it repair the source instead of declaring success after syntax validation?
- did it avoid exporting generated assets when repository policy said not to?
- did it choose structured rendering instead of unnecessarily requesting shell authority?

Protocol correctness alone does not prove useful visual-artifact work.

## Non-goals of this note

This note does not:

- authorize implementation;
- select a final package name or public API;
- require Mermaid as a built-in dependency;
- make Mermaid documentation syntax normative for the ALCODE repository;
- replace Bash for unknown build/render tools;
- introduce a browser automation product;
- introduce arbitrary remote compute;
- authorize network-enabled renderers;
- assign this capability to Phase 1.0;
- change the provisional Phase 1.0 acceptance criteria.

## Relationship to Phase 1.0

The capability intersects Phase 1.0 because Attempt Contracts could provide the correct authority envelope for render/inspect/export operations, and verification freshness can bind accepted evidence to rendered artifact provenance.

But the capability is project-level, not intrinsically ProgramState-specific.

Three placement options remain open:

```text
A. pre-1.0 enabling seam
   minimal multimodal artifact result + Host artifact inspection before ProgramState

B. Phase 1.0 bounded inclusion
   only the minimum artifact seam needed to prove Attempt authority / verification

C. post-1.0 successor capability
   ProgramState stays text/tool-result only; full rendering/inspection follows after durable work state
```

No option is selected by this note.

## Open design questions

1. Should `AgentToolResult.content` directly admit `ImageContent`, or should visual results always arrive through an `ArtifactReferenceContent` resolved by the Host?
2. Is the general Host abstraction best named `ArtifactCapability`, `RenderCapability`, or a broader bounded `ComputeCapability`?
3. Should validation and rendering be separate capability methods or one operation family with effect metadata?
4. Which artifact types must be durable across Host restart versus treated as reproducible cache?
5. Does transcript replay require byte-identical visual input, or is a verified artifact reference plus deterministic materialization sufficient?
6. How should context compilation budget image/artifact content independently from serialized text-character bounds?
7. What is the minimum provider-capability negotiation needed before visual inspection can be a required verification step?
8. Should renderer adapters be statically registered built-ins, plugin-provided, or both?
9. What renderer sandbox boundary is portable across LocalWorkspace, Windows, macOS, Linux, and future remote workspaces?
10. Which subset, if any, must be resolved before the Phase 1.0 contract can be approved?

## Current recommendation

Treat artifact rendering and inspection as a first-class coding-agent capability family rather than a Mermaid special case.

Preserve this architectural direction:

```text
structured source
→ narrow Host-owned validator/renderer
→ Host artifact + provenance
→ multimodal inspection by Agent
→ correction loop
→ verification evidence
→ explicit export only when authorized
```

The immediate planning task is to determine the smallest durable multimodal/artifact seam and decide its phase placement before implementation work is authorized.
