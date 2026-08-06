# ALCODE Architecture Constitution

The frozen principles governing ALCODE. These are non-negotiable for Phase 0;
amendments require a documented constitutional change, never a silent code decision.

ALCODE is a memory-native, verifier-driven coding agent whose lifecycle, cognition,
UI, and integrations are all under one owner. It replaces the prior host-dependent
plugin topology (Ola + Ouroboros as ZCode MCP sidecars) with an owned, integrated
product in which memory, reasoning, tools, model access, persistence, and UI are
governed by one codebase.

## The ten principles

1. **The append-only event log is historical truth.**
   What happened is recorded as an ordered sequence of immutable domain events.
   No projection mutates the log; projections are derived from it.

2. **Reasoning, memory, transcript, UI, and LLM context are projections.**
   The reasoning graph (Ouroboros-derived), the memory store (Ola-derived),
   the visible transcript, the UI stream, and the LLM context window are all
   projections of the event log. Any projection can be deleted and rebuilt.

3. **One supervised runtime owns each writable state root.**
   No accidental distribution. One writer per workspace; multi-instance conflict
   fails clearly rather than corrupting state.

4. **Background work is bounded, observable, and supervised.**
   No detached, unowned production workers. Every child process is recorded,
   bounded, cancellable, observed to exit, and absent after cleanup.

5. **Ports are validated by differential evidence, not translated tests alone.**
   Ola (JS→TS) and Ouroboros (Py→TS) are validated against golden fixtures
   generated from the working originals. Translated tests can drift with the
   implementation; differential fixtures cannot.

6. **Verbatim context remains the safe baseline.**
   Projection A (verbatim transcript → context) is the regression oracle and
   the default. It is always available.

7. **Graph context is an experiment with receipts and fail-safe fallback.**
   Projection B (graph-distilled) ships behind a toggle, emits an inspectable
   receipt, and falls back to verbatim on any failure. It does not become
   default until it measurably wins on objective evaluation.

8. **Mutable state never lives inside source repositories.**
   All mutable runtime state lives under `~/.alcode/`. Repositories are observed,
   not written into, for runtime state. Paths are attributes, not identities.

9. **Imported pi source becomes independently owned ALCODE infrastructure.**
   pi (MIT) is acquired as licensed source with recorded provenance, converted
   into owned infrastructure, and diverges permanently. Upstream changes enter
   as deliberately evaluated patches, not automatic merges. "Full ownership"
   means ownership of maintenance and direction, not removal of third-party
   copyright or license notices.

10. **Architecture work is gate-driven and timeboxed.**
    Phases begin when their dependencies' exit gates pass and end when their
    own exit gate passes. No phase is compressed by calendar pressure. Phase 0.0
    is hard-timeboxed to 1–2 working days.

## Relationship to the prior work

This pivot does not invalidate the Ouroboros qualification work or Ola's contracts.
It changes the *deployment substrate* (owned runtime, not host plugins) and the
*implementation language* (TypeScript end-to-end), while preserving the semantic
guarantees both systems earned.

Retained (in native form): deterministic reasoning artifacts, explicit verification
contracts, conservative evidence linking, falsifiers, durable events, operation
identity, immutable interruption records, exactly-once mutation semantics,
reconstruction and resume, critic and diagnostics, projection validation,
semantic memory model, retrieval and strength contracts, lifecycle and tombstones,
redaction and admission.

Retired or transformed: per-session MCP ownership, static activation environment,
plugin reload deployment, global process-count gates, repository-local mutable
state, transport receipts for in-process calls, challenge activation for ordinary
internal operations, detached production workers, ZCode-specific hooks as core
architecture, host transcript-store coupling, legacy migration machinery.
