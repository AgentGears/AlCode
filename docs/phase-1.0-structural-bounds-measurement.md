# ALCODE Phase 1.0 — Structural-Bounds Measurement

**Status:** DRAFT / non-normative planning evidence  
**Approval:** not approved; not frozen; implementation not authorized  
**Studied repository base:** `main` at `8fb22952d1938f6cdda1a47f112a49827aeec637`  
**Purpose:** close the empirical numeric part of Phase 1.0 Decision 4 without amending the governing plan yet.

## 1. Decision question

The governing Phase 1.0 draft already requires finite structural bounds, and the open-decisions study already selected the shape of the policy:

```text
local semantic ceilings
+ aggregate canonical ceilings
+ a smaller independent Agent/public projection budget
```

The remaining question is numeric:

> What hard Phase 1.0 limits are large enough for realistic long-horizon ALCODE coding Programs, but small enough to give deterministic graph, projection, and admission worst-case bounds?

This measurement does **not** reopen the previously studied authority, freshness, completion, cancellation, scheduler, or verification-predicate decisions. It measures the support envelope needed to consolidate them.

## 2. What is empirical and what is modeled

Phase 1.0 is not implemented, so the repository contains no historical `ProgramState` rows to sample directly. Pretending otherwise would make the result less reliable.

The measurement therefore has two layers:

1. **Direct repository observations.** Real merged coding objectives provide changed-file count, package spread, commit count, additions/deletions, and concrete delivery seams.
2. **Source-backed ProgramState models.** Each real objective is mapped into the coarsest independently verifiable Phase 1 work decomposition that could have represented the actual delivered work. The mapping is deliberately task-level rather than file-level or commit-level.

The modeled counts are measurements of a reproducible **representation of real repository tasks**, not claims that those historical PRs literally executed through ProgramState.

### 2.1 Modeling rules

For every corpus task:

- one work item represents one independently verifiable delivery seam, not one file or one commit;
- dependency edges represent actual prerequisite relationships between those seams;
- verification obligations represent task-specific deterministic acceptance checks plus composed closure checks;
- affected/freshness paths use normalized package/directory roots where that safely describes the dependency rather than copying every changed filename;
- evidence counts represent decisive Host references, not every diagnostic/log event;
- output slots/production steps are included only when a terminally relevant retained output is plausible;
- a compact canonical-JSON surrogate is used only to measure byte scale; it is not a proposed storage/wire encoding;
- Agent/public projection measurements are selective: all work/verification summaries may be represented, while full detail is concentrated on the current attempt/current work.

This intentionally matches the already-selected architecture: canonical state may be larger than the Agent/public projection, and replay validity does not depend on a later deployment choosing the same stricter operational policy.

## 3. Real repository corpus

The corpus spans a focused defect, medium cross-package features, Host/runtime integration, UI/protocol work, and the largest completed integration phase in the repository.

| Corpus objective | PR | Files | `packages/*` roots | Commits | Additions | Deletions |
|---|---:|---:|---:|---:|---:|---:|
| Windows workspace lock + secret detection | #25 | 11 | 4 | 17 | 217 | 18 |
| Durable verbatim transcript/context | #12 | 45 | 6 | 60 | 2,622 | 213 |
| Governed selective context | #17 | 50 | 7 | 32 | 3,919 | 331 |
| Host-owned Application Protocol + React | #19 | 33 | 3 | 74 | 3,837 | 13 |
| Host runtime + durable cognition integration | #7 | 55 | 6 | 91 | 5,238 | 127 |
| Extension + observation adapters | #26 | 89 | 12 | 44 | 5,870 | 961 |

The corpus is intentionally not normalized by commit count: commits are implementation history, not Program work topology. The changed-file/package spread is used only as a reality check against under-decomposition.

## 4. Modeled ProgramState shapes

| Corpus objective | Work items | Edges | Max direct fan-in | Blockers | Verification obligations | Path-bearing entries | Decisive evidence refs | Output slots / production steps | Canonical surrogate | Selective projection |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| PR #25 | 6 | 6 | 3 | 1 | 8 | 14 | 12 | 0 / 0 | 4.8 KiB | 1.5 KiB |
| PR #12 | 12 | 16 | 2 | 1 | 16 | 32 | 26 | 1 / 1 | 9.2 KiB | 2.4 KiB |
| PR #17 | 13 | 21 | 5 | 1 | 18 | 37 | 30 | 1 / 1 | 9.9 KiB | 2.4 KiB |
| PR #19 | 12 | 18 | 4 | 1 | 17 | 28 | 28 | 1 / 1 | 9.3 KiB | 2.3 KiB |
| PR #7 | 14 | 18 | 3 | 2 | 20 | 43 | 34 | 1 / 1 | 10.9 KiB | 2.5 KiB |
| PR #26 | 24 | 41 | 6 | 3 | 34 | 82 | 58 | 4 / 4 | 19.1 KiB | 4.4 KiB |

Observed modeled maxima are therefore:

```text
work items                    24
edges                         41
max direct fan-in              6
blockers                       3
verification obligations      34
path-bearing entries          82
decisive evidence refs        58
output slots                    4
production steps                4
canonical surrogate        ~19.1 KiB
selective projection        ~4.4 KiB
```

These numbers argue strongly against using the current local maxima multiplicatively. They also show that a useful Phase 1 envelope can retain substantial safety margin without permitting an 8,192-edge / 32,768-path worst case.

## 5. Near-bound stress envelope

A second measurement constructed a deliberately dense current-state shape using the candidate limits below rather than a realistic task average:

```text
128 work items
1,024 total dependency edges
256 verification obligations
64 blockers
2,048 decisive evidence refs
4,096 total path-bearing entries
~1 MiB aggregate path-string bytes
~512 KiB aggregate objective/work/blocker text
256 retained artifact references
128 historical session attachments
64 output slots
64 production steps
```

Using compact canonical JSON and approximately 512 KiB of ordinary contract/text payload, this shape serialized to about **1.80 MiB** before reserving the separate canonical predicate/production-step argument budget. Adding a full additional **512 KiB** argument budget keeps the modeled current state around **2.3 MiB**.

A selective projection containing all 128 work summaries, all 256 verification summaries, bounded blocker/artifact summaries, and full detail for one current work item measured about **70.9 KiB**.

Consequences:

- a **4 MiB** canonical current-state ceiling leaves useful byte headroom while remaining finite;
- a **128 KiB AttemptProjection** is sufficient for the measured near-bound selective shape without requiring whole-state serialization;
- a **256 KiB Application/public ProgramState projection** remains a safe outer ceiling and is materially smaller than canonical state;
- projection builders must remain selective; raising the public projection budget is not a substitute for selection.

The byte exercise is not a wire-format commitment. Its purpose is to test whether the proposed count limits and aggregate byte ceilings compose without immediate contradiction.

## 6. Recommended Phase 1.0 hard ceilings

### 6.1 Graph and work topology

| Dimension | Current draft | Recommended hard ceiling | Evidence / reason |
|---|---:|---:|---|
| Work items per ProgramState | 256 | **128** | 5.3× the corpus maximum of 24; keeps `V` explicitly small enough for deterministic full-DAG checks. |
| Direct dependencies per work item | 32 | **32** | Corpus fan-in max is 6, but integration/gate nodes can legitimately have broad fan-in. Local value is safe when paired with aggregate `E`. |
| Total dependency edges | none | **1,024** | Caps multiplicative graph growth; permits average fan-in 8 at 128 nodes, far denser than the corpus. |
| Blocker records per ProgramState | 128 | **64** | More than 20× the corpus concurrent/represented maximum; avoids making resolved/advisory issue lists a task tracker. |

### 6.2 Verification, evidence, artifacts, and production outputs

| Dimension | Current draft | Recommended hard ceiling | Evidence / reason |
|---|---:|---:|---|
| Verification obligations | 256 | **256** | 7.5× corpus max 34; verification-heavy work has more plausible growth than topology itself. |
| Evidence refs per work item/obligation | 32 | **32** | Retain current local cap; decisive evidence should stay curated. |
| Total decisive evidence refs | none | **2,048** | Prevents 256×32 or work+verification multiplication while leaving >35× corpus max. |
| Retained Program artifact refs | none | **256** | Artifacts are references, not bulk payloads; enough for output-heavy Programs without unbounded current projection. |
| Required `ProgramOutputSlotId` values | none | **64** | 16× the modeled artifact-heavy corpus maximum. Terminal deliverables should not scale with every incidental artifact. |
| `ProgramArtifactProductionStepId` values | none | **64** | Matches output-slot support envelope; one step may expose more than one Host-defined output channel. |

Evidence/event history itself is not copied into these arrays merely to preserve history. The canonical event log remains the durable history; ProgramState stores the bounded decisive references required for current semantics.

### 6.3 Paths and freshness scopes

| Dimension | Current draft | Recommended hard ceiling | Evidence / reason |
|---|---:|---:|---|
| Affected paths per work item | 128 | **128** | Preserve current local ceiling for repository-wide/refactor items. |
| Freshness path entries per obligation | none | **64** | A verification requirement should normally name a compact exact/subtree scope; broader cases should use workspace scope rather than enormous explicit lists. |
| Total path-bearing entries per ProgramState | none | **4,096** | Aggregate ceiling across affected paths, verification path scopes, and other Program contract path sets; prevents multiplicative blowup. |
| One normalized path | none | **1 KiB UTF-8** | Finite protocol/state bound independent of host filesystem maximums. |
| Total normalized path bytes | none | **1 MiB UTF-8** | Prevents 4,096 individually legal long paths from consuming the canonical byte envelope. |

Path limits do not weaken the verification rule. Unknown/incomplete affected scope still fails closed; a limit-exceeded path set is not silently truncated into a supposedly complete one.

### 6.4 Text and immutable contract payload

| Dimension | Current draft | Recommended hard ceiling | Evidence / reason |
|---|---:|---:|---|
| Objective | 16 KiB | **16 KiB UTF-8** | Keep current value; large enough for structured user intent without making objective text a hidden document store. |
| Work-item description | 8 KiB | **8 KiB UTF-8** | Keep current local value; aggregate text cap removes the 128×8 KiB multiplication. |
| Blocker reason/description | none | **4 KiB UTF-8** | Blocker state should identify the issue, not retain arbitrary logs. |
| One verification predicate canonical argument payload | none | **16 KiB** | Host-versioned deterministic predicates need bounded concrete inputs. |
| One production-step canonical argument payload | none | **16 KiB** | Required artifact invocation identity must be exact but finite. |
| Total objective/work/blocker human text | none | **512 KiB UTF-8** | Prevents local text maxima multiplying into multi-megabyte state. |
| Total predicate + production-step canonical argument bytes | none | **512 KiB** | Independent bound for machine contract payload; digests/references are preferred for larger retained material. |

### 6.5 Identity/history lists and projections

| Dimension | Current draft | Recommended hard ceiling | Evidence / reason |
|---|---:|---:|---|
| Unique session attachments retained by one ProgramState | none | **128** | Long-horizon continuity remains practical while the current-state relation is finite. Canonical session/event history remains separately queryable. |
| Serialized canonical current ProgramState | none | **4 MiB** | Near-bound stress model remains ~2.3 MiB including the full argument reserve. |
| Agent `AttemptProjection` | implicit | **128 KiB** | Near-bound selective projection measured ~70.9 KiB; Agent should receive current-attempt working state, not whole canonical state. |
| Application/public ProgramState projection | 256 KiB | **256 KiB** | Preserve current draft outer ceiling; enough for broader human read model while remaining smaller than canonical state. |

`AttemptProjection` is a Host-owned selective projection, not a new authority or canonical source. If the exact information required to authorize/continue one attempt cannot fit its bound, dispatch fails explicitly rather than silently dropping required authority/freshness facts.

## 7. Hard ceiling versus deployment policy

The recommended numbers are **canonical Phase 1 support ceilings**, not mandatory operational defaults.

A deployment may configure stricter admission limits, for example:

```text
canonical max work items = 128
local deployment policy  = 64
```

but it may not admit a Program beyond the canonical ceiling. A later stricter deployment configuration also cannot make already-canonical historical state invalid during replay. The hard limits are validity/admission ceilings; mutable policy is only a tightening layer for new admission.

## 8. Admission and failure behavior

Bounds are meaningful only if exceeding them has deterministic semantics.

### Creation-time immutable structure

The Host rejects Program creation before canonical admission if any of these exceed hard ceilings:

- work items;
- dependency fan-in or total edges;
- mandatory verification obligations;
- initial path scopes;
- output slots / production steps;
- objective/descriptions/contract argument payloads;
- aggregate canonical structure/byte budget.

The Host never creates a partially truncated Program contract.

### Runtime bounded collections

Later Host-owned admissions that would exceed a current-state bound fail explicitly and append no partial semantic transition. This includes, where applicable, new blocker records, decisive evidence references, retained artifact refs, or new session attachments.

A limit error is a resource/admission result, not permission for the Agent to drop required evidence or narrow a supposedly complete path set.

### Projection budget

Projection limits are not canonical-state limits. The projection compiler selects the bounded information required by the consumer:

```text
canonical ProgramState (<= 4 MiB)
       ↓
Host-owned selection
       ├─ AttemptProjection <= 128 KiB
       └─ Application/public projection <= 256 KiB
```

A projection may summarize or reference omitted non-current detail only where the projection contract says that omission is semantically safe. It must not silently omit a current attempt precondition, blocker, required verification, uncertainty fact, or authority boundary and then claim equivalent completeness.

## 9. Why the provisional `256 work × 32 deps × 128 paths` envelope should change

The original provisional local bounds were intentionally conservative placeholders. Kept alone, they permit:

```text
8,192 dependency references
32,768 affected-path entries
~2 MiB of work descriptions before objective/blocker/verification data
```

The real corpus does not justify that multiplicative envelope. The proposed replacement preserves generous per-item flexibility but adds aggregate ceilings and reduces work-item count to 128.

The important correction is not merely `256 → 128`; it is that **every multiplicative collection now has an aggregate ceiling**.

## 10. Coverage gaps and confidence

### High confidence

The corpus is strong enough to set the order of magnitude for:

- work-item count;
- DAG edge count;
- verification-obligation count;
- path/evidence aggregate counts;
- public/Agent projection budgets.

It includes the repository's largest completed integration phase (#26), a Host/runtime phase (#7), protocol/UI work (#19), context/recovery work (#12/#17), and a focused defect (#25).

### Moderate confidence

Artifact/output-slot counts are less well represented because historical phases primarily deliver source code and gates rather than large collections of terminal retained artifacts. The 64-slot/64-step ceiling therefore uses much larger relative headroom than the corpus itself requires.

### Not measurable before implementation

This study cannot empirically measure Phase 1 reducer/rebuild latency because no Phase 1 reducer exists yet. It therefore does **not** invent a millisecond SLA. The recommended `V=128`, `E=1,024`, finite collection counts, and byte ceilings make the worst-case input finite; implementation proof can exercise max-shape reducer/rebuild/eligibility behavior without changing these semantic limits unless a demonstrated defect requires change control.

## 11. Consolidation consequences

If promoted during the next consolidation step, the governing Phase 1.0 plan should:

1. replace the provisional structural-bound paragraph with the local + aggregate tables above;
2. change maximum work items from 256 to 128;
3. add total edge, evidence, path-entry/path-byte, text, contract-argument, artifact, output-slot, production-step, session-attachment, and canonical-byte ceilings;
4. split the current combined projection concept into a 128 KiB current-attempt projection and 256 KiB Application/public outer projection where the final Agent integration contract uses `AttemptProjection`;
5. state deterministic limit-exceeded admission behavior and forbid silent truncation of complete scopes/evidence;
6. ensure AC-10-02/05/09/10 prove local and aggregate bounds and bounded projection behavior without making current deployment policy part of replay validity.

This document does not itself perform that promotion.

## 12. Recommendation

**Promote the numeric ceilings in Section 6 during Phase 1.0 consolidation.**

They provide substantial headroom over the repository-backed corpus while eliminating the pathological multiplicative envelope of the provisional defaults. No additional structural-bounds study is warranted before consolidation unless new concrete repository evidence exceeds this corpus by a material amount.
