# ALCODE A1 — Remaining Freeze Blocker Resolution

**Status:** DRAFT freeze-resolution evidence; not a freeze; implementation not authorized by this file.  
**Prepared:** 2026-08-24 against `main@5c6ab80af906d7baea11e0487580d9b7b2364276`.  
**Primary candidate:** `docs/a1-adaptive-program-plan.md`.

This file resolves the two evidence-dependent blockers intentionally left open by the A1 freeze-resolution candidate. It does not alter any other semantic decision in that plan.

## 1. Numeric limits resolved

Based on `docs/a1-limits-study.md`, the A1 first slice freezes these candidate values for final review:

```text
current WorkItems                         128      unchanged
total dependency edges                  1024      unchanged
canonical current ProgramState           4 MiB    unchanged
Agent Attempt projection                128 KiB   unchanged
Application Program projection          256 KiB   unchanged

maximum decomposition depth                8
maximum direct children/decomposition      8
semantic ProgramRevisions/Program         32      includes initial/baseline
semantic revision proposal                 3 MiB
canonical RevisionImpact                 256 KiB
sealed pending semantic draft              4 MiB
WorkAuthorityEnvelope                      8 KiB
semantic rationale/diagnostic text         4 KiB
```

No existing Phase-1 capacity ceiling is raised.

## 2. Protocol strategy resolved

Based on `docs/a1-protocol-compatibility-study.md`:

```text
AGENT_PROTOCOL_VERSION remains 1
```

A1 uses additive negotiated capabilities:

```text
program_state_v2
program_execution_v2
program_revision_v1
```

Existing `program_state_v1` / `program_execution_v1` semantics remain frozen and supported for fixed-topology compatibility.

Changed Program execution payloads use explicit V2 discriminators/per-message versions; revision-planning messages have their own version 1 and are sent only after capability negotiation.

A legacy peer never receives an unsupported A1 message. An adaptive Program cannot dispatch to a peer that did not advertise V2 Program capability.

## 3. Final-freeze interpretation

For final review, read the contract as:

```text
docs/a1-adaptive-program-plan.md
        +
docs/a1-limits-study.md
        +
docs/a1-protocol-compatibility-study.md
        +
this blocker-resolution record
```

The two statements in the candidate plan saying that numeric limits and protocol strategy remain blockers are superseded by this evidence package for purposes of final freeze review. No other candidate-plan clause is superseded.

The final freeze must still be a separate explicit artifact/commit identifying exact blob SHAs and authorizing implementation. Until that artifact exists, A1 implementation remains unauthorized.
